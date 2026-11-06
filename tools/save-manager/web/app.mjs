import { Receiver, envelope, decodeBackup, PROTOCOL } from './backup.mjs';

const $ = (id) => document.getElementById(id);

let directory;
let port;
let reader;
let writer;
let heartbeat;
let session;
let receiver;
let connected = false;
let writeQueue = Promise.resolve();
let closing = false;
let selectedImport = null;
let transfer = null;
let expectedRestore = null;
let device = null;
let autoReconnectTimer = null;
let reconnecting = false;

const restoreKey = 'ember-pending-restore';
try {
  const pending = JSON.parse(sessionStorage.getItem(restoreKey));
  if (
    pending &&
    /^[a-f0-9]{12}$/.test(pending.device) &&
    /^[a-f0-9]{8}$/.test(pending.crc)
  ) {
    expectedRestore = pending;
  }
} catch {
  /* ignore */
}

function rememberRestore(value) {
  expectedRestore = value;
  try {
    if (value) sessionStorage.setItem(restoreKey, JSON.stringify(value));
    else sessionStorage.removeItem(restoreKey);
  } catch {
    /* ignore */
  }
}

function setStatus(text, { error = false, tip = false } = {}) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('error', error);
  el.classList.toggle('tip', tip && !error);
  $('live-hint').textContent = text;
}

function markSteps() {
  const hasDir = !!directory;
  const ready = connected;
  setStep('step-folder', hasDir ? 'done' : 'current');
  setStep(
    'step-connect',
    hasPortOrReady() ? 'done' : hasDir || expectedRestore ? 'current' : 'ready',
  );
  setStep(
    'step-backup',
    !ready ? 'locked' : transfer || expectedRestore ? 'locked' : 'current',
  );
  setStep(
    'step-import',
    !ready || !hasDir ? 'locked' : expectedRestore ? 'current' : 'ready',
  );
}

function hasPortOrReady() {
  return !!port || connected;
}

function setStep(id, state) {
  const el = $(id);
  if (!el) return;
  el.dataset.state = state;
  const badge = el.querySelector('.step-badge');
  if (!badge) return;
  badge.textContent =
    { locked: '未就绪', current: '进行中', done: '已完成', ready: '可操作' }[
      state
    ] || '';
}

function send(text) {
  const bytes = new TextEncoder().encode(`${text}\n`);
  writeQueue = writeQueue.then(() => writer.write(bytes));
  return writeQueue;
}

function controls() {
  $('forget-result').hidden = !expectedRestore;
  $('connect').disabled = !!port || reconnecting;
  $('disconnect').disabled = !port;
  $('folder').disabled = !!transfer || !!receiver?.pending;
  $('pull').disabled =
    !connected || !directory || !!transfer || !!expectedRestore || !!receiver?.pending;
  $('import').disabled =
    !connected ||
    !directory ||
    !!transfer ||
    !!expectedRestore ||
    !!receiver?.pending;
  markSteps();
}

async function ensureDirectory() {
  if (directory) {
    if ((await directory.queryPermission({ mode: 'readwrite' })) === 'granted') {
      return true;
    }
  }
  throw Error('请先选择可写入的备份目录');
}

async function save(q) {
  try {
    await ensureDirectory();
    if (transfer && transfer.file.metadata.device_id !== q.device) {
      throw Error('当前设备与待导入文件不匹配，已中止。');
    }
    setStatus(
      transfer
        ? '正在把覆盖前的当前存档写入电脑…'
        : '校验通过，正在写入备份文件…',
    );
    const data = await envelope(q);
    const body = `${JSON.stringify(data)}\n`;
    const stamp = data.created_at.replace(/[:.]/g, '-');
    const name = `Ember-${transfer ? 'before-import-' : ''}${stamp}-${crypto.randomUUID()}.emsave`;
    const file = await directory.getFileHandle(name, { create: true });
    let stream;
    try {
      stream = await file.createWritable();
      await stream.write(body);
      await stream.close();
    } catch (e) {
      if (stream) await stream.abort().catch(() => {});
      throw e;
    }
    const readBack = await (await file.getFile()).text();
    if (readBack !== body) {
      throw Error('保存后回读校验失败。请换一个目录重试，不要删除设备上的进度。');
    }
    const item = document.createElement('li');
    item.innerHTML = `<code>${name}</code> <span class="ok">校验通过 · 已落盘</span>`;
    $('files').prepend(item);
    if (transfer) {
      transfer.id = q.id;
      transfer.offset = 0;
      transfer.backedUp = true;
    }
    await send(`${PROTOCOL} ACK ${session} ${q.id}`);
    setStatus(
      transfer
        ? '覆盖前备份已保存，正在写入导入文件…'
        : '备份完成，已落盘。',
      { tip: true },
    );
  } catch (e) {
    await send(`${PROTOCOL} FAIL ${session} ${q.id}`).catch(() => {});
    throw e;
  }
}

async function nextChunk(id, offset) {
  const t = transfer;
  if (!t?.backedUp || id !== t.id || offset !== t.offset || offset > t.file.bytes.length) {
    throw Error('导入接收状态不匹配，已中止。请保留原备份并重试。');
  }
  if (offset === t.file.bytes.length) {
    await send(`${PROTOCOL} RFIN ${session} ${id}`);
    setStatus('传送完成。设备正在校验并写入，请保持供电。');
    return;
  }
  const hex = Array.from(t.file.bytes.slice(offset, offset + 128), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  t.offset += 128;
  await send(`${PROTOCOL} RDATA ${session} ${id} ${offset} ${hex}`);
  $('progress').value = t.offset / t.file.bytes.length;
  setStatus(`正在导入 ${Math.round((t.offset / t.file.bytes.length) * 100)}%`);
}

async function line(text) {
  const result = receiver.accept(text);
  if (result?.ready) {
    connected = true;
    device = result.ready;
    $('connection').textContent = `已连接 · 设备 ${device}`;
    setStatus(
      expectedRestore
        ? '已重新连接，正在核对导入结果…'
        : '已连接。可点「立即备份」，或「选择并导入」。',
      { tip: true },
    );
  }
  if (result?.error) {
    const meta = transfer?.file?.metadata;
    const midImport = !!meta;
    transfer = null;
    if (receiver) receiver.pending = null;
    $('progress').value = 0;
    setStatus(result.error, { error: true });
    /* Commit failure reboots the device; keep a restore watch for RESTORED. */
    if (midImport && /写入|STAGE|FLASH|暂存/.test(result.error)) {
      rememberRestore({ crc: meta.crc32, device: meta.device_id });
      scheduleAutoReconnect();
    }
  }
  if (result?.busy) {
    setStatus('设备正忙，请等待当前进度完成。', { tip: true });
  }
  if (result?.hint) {
    setStatus(`设备：${result.hint}`, { tip: true });
  }
  if (result?.offered) {
    setStatus('请在设备上确认覆盖（默认是取消）。', { tip: true });
  }
  if (result?.cancelled) {
    transfer = null;
    selectedImport = null;
    $('import-info').textContent = '已取消';
    setStatus('已取消导入，当前存档未覆盖。', { tip: true });
  }
  if (result?.progress !== undefined) {
    $('progress').value = result.progress;
    setStatus(
      `${transfer ? '备份当前档' : '正在备份'} ${Math.round(result.progress * 100)}%`,
    );
  }
  try {
    if (result?.complete) await save(result.complete);
    if (result?.upload) await nextChunk(result.upload, 0);
    if (result?.next) await nextChunk(result.next.id, result.next.offset);
    if (result?.staged) {
      if (!transfer || result.staged !== transfer.file.metadata.crc32) {
        throw Error('设备暂存确认不匹配');
      }
      rememberRestore({
        crc: result.staged,
        device: transfer.file.metadata.device_id,
      });
      transfer = null;
      connected = false;
      setStatus('写入完成，设备重启中；将自动重连核对结果。', { tip: true });
      scheduleAutoReconnect();
    }
    if (result?.restored) {
      const code = result.restored.result;
      const messages = {
        1: '导入完成。请在设备核对天数、仓库与线索。',
        2: '导入写入失败，设备无法本地回滚。请立即用目录里 Ember-before-import- 备份再导入。',
        3:
          '设备回报「写入后读档失败」。请先打开游戏看天数/仓库是否已是备份进度；若进度正确可忽略并升级《余烬》。若进度不对，再用 Ember-before-import- 文件导入，并保留原备份。',
      };
      const msg = messages[code] || '收到导入结果，请在设备核对。';
      if (expectedRestore) {
        if (
          transfer ||
          expectedRestore.device !== device ||
          expectedRestore.crc !== result.restored.crc
        ) {
          throw Error(
            '重启后的导入结果不匹配，尚未确认恢复成功。请保留原备份，在设备上核对进度。',
          );
        }
      }
      /* 2 = hard fail; 3 = verify failed (may still be playable — check device first). */
      setStatus(msg, {
        error: code === 2 || code === 3,
        tip: code === 1,
      });
      rememberRestore(null);
      clearAutoReconnect();
    }
  } catch (e) {
    transfer = null;
    if (receiver) receiver.pending = null;
    $('progress').value = 0;
    setStatus(e.message, { error: true });
  }
  controls();
}

async function readLoop() {
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const text = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        await line(text);
      }
      if (buffer.length > 4096) {
        throw Error('串口数据格式异常，请断开后重试');
      }
    }
    if (!closing) {
      setStatus(
        expectedRestore
          ? 'USB 已断开，正在尝试自动重连以核对导入结果…'
          : 'USB 已断开。',
        { error: !expectedRestore, tip: !!expectedRestore },
      );
      if (expectedRestore) scheduleAutoReconnect();
    }
  } catch (e) {
    if (!closing) {
      setStatus(
        `${e.message}${
          expectedRestore
            ? '；导入结果尚未确认，请保留原备份。'
            : ''
        }`,
        { error: true },
      );
      if (expectedRestore) scheduleAutoReconnect();
    }
  } finally {
    try {
      reader?.releaseLock();
    } catch {
      /* ignore */
    }
    reader = null;
    transfer = null;
    await cleanup({ keepAutoReconnect: !!expectedRestore });
  }
}

function clearAutoReconnect() {
  if (autoReconnectTimer) {
    clearTimeout(autoReconnectTimer);
    autoReconnectTimer = null;
  }
  reconnecting = false;
}

function scheduleAutoReconnect() {
  clearAutoReconnect();
  if (!expectedRestore) return;
  reconnecting = true;
  controls();
  let attempt = 0;
  const tick = async () => {
    if (!expectedRestore || port) {
      reconnecting = false;
      controls();
      return;
    }
    attempt += 1;
    setStatus(`自动重连中（第 ${attempt} 次）…`, { tip: true });
    try {
      await openGrantedPort();
      reconnecting = false;
      controls();
      return;
    } catch {
      /* retry */
    }
    if (attempt >= 20) {
      reconnecting = false;
      setStatus('自动重连超时。请点「连接设备」手动核对导入结果。', {
        error: true,
      });
      controls();
      return;
    }
    autoReconnectTimer = setTimeout(tick, attempt < 5 ? 800 : 1500);
  };
  autoReconnectTimer = setTimeout(tick, 1000);
}

async function cleanup({ keepAutoReconnect = false } = {}) {
  clearInterval(heartbeat);
  heartbeat = null;
  connected = false;
  device = null;
  if (!keepAutoReconnect) clearAutoReconnect();
  if (writer) {
    try {
      await writeQueue;
    } catch {
      /* ignore */
    }
    try {
      writer.releaseLock();
    } catch {
      /* ignore */
    }
    writer = null;
  }
  if (port) {
    try {
      await port.close();
    } catch {
      /* ignore */
    }
    port = null;
  }
  $('connection').textContent = expectedRestore ? '等待重连核对…' : '已断开';
  controls();
}

async function startSession(selectedPort) {
  closing = false;
  writeQueue = Promise.resolve();
  port = selectedPort;
  controls();
  await port.open({ baudRate: 115200, bufferSize: 65536 });
  writer = port.writable.getWriter();
  reader = port.readable.getReader();
  session = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  receiver = new Receiver(session);
  void readLoop();
  await send(`${PROTOCOL} HELLO ${session}`);
  setStatus(
    expectedRestore
      ? '已打开串口，等待导入结果回执…'
      : '已打开串口，等待设备响应…',
  );
  heartbeat = setInterval(() => {
    send(`${PROTOCOL} ${connected ? 'PING' : 'HELLO'} ${session}`).catch(
      (e) => {
        setStatus(e.message, { error: true });
        void reader?.cancel();
      },
    );
  }, 4000);
}

async function openGrantedPort() {
  const ports = await navigator.serial.getPorts();
  if (!ports.length) throw Error('no granted port');
  await startSession(ports[0]);
}

$('folder').onclick = async () => {
  try {
    directory = await showDirectoryPicker({
      id: 'ember-saves',
      mode: 'readwrite',
    });
    $('directory').textContent = `已选：${directory.name}`;
    setStatus('目录已就绪。下一步：连接设备。', { tip: true });
    controls();
  } catch (e) {
    if (e.name !== 'AbortError') setStatus(e.message, { error: true });
  }
};

$('connect').onclick = async () => {
  try {
    clearAutoReconnect();
    const selected = await navigator.serial.requestPort({
      filters: [{ usbVendorId: 0x303a, usbProductId: 0x1001 }],
    });
    await startSession(selected);
  } catch (e) {
    setStatus(
      e.name === 'NotFoundError'
        ? '未选择设备。请再点「连接设备」，并选择 USB JTAG/serial。'
        : e.message,
      { error: true },
    );
    if (reader) await reader.cancel();
    else await cleanup();
  }
};

$('disconnect').onclick = async () => {
  closing = true;
  clearAutoReconnect();
  clearInterval(heartbeat);
  try {
    await send(`${PROTOCOL} BYE ${session}`);
  } catch {
    /* ignore */
  }
  if (reader) await reader.cancel();
  else await cleanup();
  setStatus(
    expectedRestore
      ? '已断开。需要核对结果时再连接同一台设备。'
      : '已断开。已保存的备份仍在目录中。',
    { tip: true },
  );
};

$('pull').onclick = async () => {
  if (!connected || !directory || transfer || expectedRestore) return;
  try {
    await ensureDirectory();
    $('progress').value = 0;
    setStatus('已请求备份，等待设备发送…', { tip: true });
    await send(`${PROTOCOL} PULL ${session}`);
  } catch (e) {
    setStatus(e.message, { error: true });
  }
};

async function pickImportFile() {
  if (window.showOpenFilePicker) {
    const [handle] = await window.showOpenFilePicker({
      multiple: false,
      types: [
        {
          description: '余烬存档',
          accept: { 'application/json': ['.emsave'] },
        },
      ],
    });
    return handle.getFile();
  }
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.emsave,application/json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) resolve(file);
      else reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    };
    input.click();
  });
}

async function startImportWithFile(file) {
  if (file.size > 120000) throw Error('备份文件过大');
  selectedImport = await decodeBackup(await file.text());
  const d = selectedImport.metadata;
  $('import-info').textContent = `${file.name} · V${d.save_version} · ${d.device_id}`;
  if (d.device_id !== device) {
    throw Error(
      `备份属于设备 ${d.device_id}，当前是 ${device}。只能导入到同一台设备。`,
    );
  }
  transfer = { file: selectedImport };
  controls();
  await send(
    `${PROTOCOL} OFFER ${session} ${d.device_id} ${d.firmware} ${d.save_version} ${selectedImport.bytes.length} ${d.crc32}`,
  );
  setStatus('已发送。请在设备上确认覆盖（默认取消）。', { tip: true });
}

$('import').onclick = async () => {
  if (!connected || !directory || transfer || expectedRestore) return;
  try {
    await ensureDirectory();
    const file = await pickImportFile();
    await startImportWithFile(file);
  } catch (e) {
    transfer = null;
    if (e.name !== 'AbortError') setStatus(e.message, { error: true });
    controls();
  }
};

$('forget-result').onclick = () => {
  rememberRestore(null);
  clearAutoReconnect();
  setStatus('已结束核对。请在设备核实进度后再操作。', { tip: true });
  controls();
};

function preflight() {
  const issues = [];
  if (!window.isSecureContext) {
    issues.push('当前不是 HTTPS / localhost，浏览器会禁止 USB。请用本机工具启动。');
  }
  if (!navigator.serial) {
    issues.push('本浏览器不支持 Web Serial。请改用桌面版 Chrome 或 Edge。');
  }
  if (!window.showDirectoryPicker) {
    issues.push('本浏览器不支持目录选择。请改用桌面版 Chrome 或 Edge。');
  }
  const box = $('preflight');
  if (!issues.length) {
    box.hidden = true;
    return true;
  }
  box.hidden = false;
  box.innerHTML = `<strong>开始前请先解决：</strong><ul>${issues
    .map((i) => `<li>${i}</li>`)
    .join('')}</ul>`;
  $('folder').disabled = true;
  $('connect').disabled = true;
  setStatus(issues[0], { error: true });
  return false;
}

$('local-start').hidden = window.isSecureContext;
preflight();
controls();
if (expectedRestore) {
  setStatus('检测到未核对完的导入，正在尝试自动重连…', { tip: true });
  scheduleAutoReconnect();
}
