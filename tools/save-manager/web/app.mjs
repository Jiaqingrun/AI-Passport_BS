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
  const hasPort = !!port;
  const ready = connected;
  setStep('step-folder', hasDir ? 'done' : 'current');
  setStep(
    'step-connect',
    !hasDir ? 'locked' : hasPort || ready ? 'done' : 'current',
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
  $('connect').disabled = !directory || !!port;
  $('disconnect').disabled = !port;
  $('folder').disabled = !!port;
  $('import').disabled =
    !connected ||
    !selectedImport ||
    !!transfer ||
    !!expectedRestore ||
    !!receiver?.pending;
  $('import-file').disabled = !!transfer || !!expectedRestore || !!receiver?.pending;
  markSteps();
}

async function save(q) {
  try {
    if (
      (await directory.queryPermission({ mode: 'readwrite' })) !== 'granted'
    ) {
      throw Error('目录写入授权已失效。请点「选择备份目录」重新授权。');
    }
    if (transfer && transfer.file.metadata.device_id !== q.device) {
      throw Error('当前设备与待导入文件不匹配，已中止。');
    }
    setStatus(
      transfer
        ? '正在把覆盖前的当前存档写入电脑…'
        : '校验通过，正在写入备份文件…',
    );
    const data = await envelope(q);
    const stamp = data.created_at.replace(/[:.]/g, '-');
    const name = `Ember-${transfer ? 'before-import-' : ''}${stamp}-${crypto.randomUUID()}.emsave`;
    const file = await directory.getFileHandle(name, { create: true });
    let stream;
    try {
      stream = await file.createWritable();
      await stream.write(`${JSON.stringify(data, null, 2)}\n`);
      await stream.close();
    } catch (e) {
      if (stream) await stream.abort().catch(() => {});
      throw e;
    }
    const readBack = await (await file.getFile()).text();
    if (readBack !== `${JSON.stringify(data, null, 2)}\n`) {
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
        ? '覆盖前备份已保存。接下来会把导入文件发给设备…'
        : '备份已保存到电脑。请看设备是否显示「备份完成」。不要删除这个 .emsave。',
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
    setStatus('传送完成。设备正在校验并暂存，请保持供电，不要拔线。');
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
        ? '已重新连接，正在等待导入结果回执…'
        : '连接成功。现在可以：在设备上备份，或打开「导入存档」后发送文件。',
      { tip: true },
    );
  }
  if (result?.hint) {
    setStatus(`设备提示：${result.hint}`, { tip: true });
  }
  if (result?.offered) {
    setStatus(
      '设备已收到导入请求。请在设备上选择「确认覆盖」并按确认键；默认是取消，误触不会覆盖。',
      { tip: true },
    );
  }
  if (result?.cancelled) {
    transfer = null;
    setStatus('已取消导入，当前存档未覆盖。', { tip: true });
  }
  if (result?.progress !== undefined) {
    $('progress').value = result.progress;
    setStatus(
      `${transfer ? '备份当前存档' : '正在接收备份'} ${Math.round(result.progress * 100)}%`,
    );
  }
  if (result?.complete) await save(result.complete);
  if (result?.upload) await nextChunk(result.upload, 0);
  if (result?.next) await nextChunk(result.next.id, result.next.offset);
  if (result?.staged) {
    if (!transfer || result.staged !== transfer.file.metadata.crc32) {
      throw Error('设备暂存确认不匹配');
    }
    rememberRestore({ crc: result.staged, device: transfer.file.metadata.device_id });
    transfer = null;
    connected = false;
    setStatus(
      '文件已暂存。设备即将重启；若 USB 断开，请重新连接本页核对结果。在核对完成前不要删除原备份。',
      { tip: true },
    );
  }
  if (result?.restored) {
    if (!expectedRestore) return;
    if (
      transfer ||
      expectedRestore.device !== device ||
      expectedRestore.crc !== result.restored.crc
    ) {
      throw Error(
        '重启后的导入结果不匹配，尚未确认恢复成功。请保留原备份，在设备上核对进度。',
      );
    }
    const messages = {
      1: '设备已确认：存档导入完成。请在设备核对天数、仓库与线索进度。',
      2: '导入写入失败，设备已恢复覆盖前的存档。请保留原备份。',
      3: '存档已写入，但游戏读档失败，不能确认导入成功。请保留原备份，勿开始新游戏。',
    };
    setStatus(messages[result.restored.result], {
      error: result.restored.result !== 1,
      tip: result.restored.result === 1,
    });
    rememberRestore(null);
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
          ? 'USB 已断开。请重新连接核对导入结果；当前尚未确认恢复成功。'
          : 'USB 连接已断开。未确认的操作不算完成。',
        { error: !expectedRestore },
      );
    }
  } catch (e) {
    if (!closing) {
      setStatus(
        `${e.message}${
          expectedRestore
            ? '；导入结果尚未确认，请重新连接并保留原备份。'
            : ''
        }`,
        { error: true },
      );
    }
  } finally {
    reader.releaseLock();
    reader = null;
    transfer = null;
    await cleanup();
  }
}

async function cleanup() {
  clearInterval(heartbeat);
  heartbeat = null;
  connected = false;
  device = null;
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
  $('connection').textContent = '已断开';
  controls();
}

$('folder').onclick = async () => {
  try {
    directory = await showDirectoryPicker({
      id: 'ember-saves',
      mode: 'readwrite',
    });
    $('directory').textContent = `已选：${directory.name}`;
    setStatus('备份目录已就绪。下一步：连接设备。', { tip: true });
    controls();
  } catch (e) {
    if (e.name !== 'AbortError') setStatus(e.message, { error: true });
  }
};

$('connect').onclick = async () => {
  try {
    closing = false;
    writeQueue = Promise.resolve();
    port = await navigator.serial.requestPort({
      filters: [{ usbVendorId: 0x303a, usbProductId: 0x1001 }],
    });
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
    setStatus('已打开串口，等待设备响应… 若长时间无响应，请确认设备已开机且固件支持存档协议。');
    heartbeat = setInterval(() => {
      send(`${PROTOCOL} ${connected ? 'PING' : 'HELLO'} ${session}`).catch(
        (e) => {
          setStatus(e.message, { error: true });
          void reader?.cancel();
        },
      );
    }, 4000);
  } catch (e) {
    setStatus(
      e.name === 'NotFoundError'
        ? '未选择设备。请再点「连接设备」，并选择名称含 USB JTAG/serial 的接口。'
        : e.message,
      { error: true },
    );
    if (reader) await reader.cancel();
    else await cleanup();
  }
};

$('disconnect').onclick = async () => {
  closing = true;
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
      ? '设备已接收导入文件；重新连接核对结果。'
      : '已断开。已保存到目录的备份仍然保留。',
    { tip: true },
  );
};

$('import-file').onchange = async () => {
  selectedImport = null;
  controls();
  try {
    const file = $('import-file').files[0];
    if (!file) return;
    if (file.size > 120000) throw Error('备份文件过大');
    selectedImport = await decodeBackup(await file.text());
    const m = selectedImport.metadata;
    $('import-info').textContent = `${file.name} · 校验通过 · 存档 V${m.save_version} · 设备 ${m.device_id}`;
    setStatus('文件校验通过。请先在设备打开「设置 → 导入存档」，再点「发送导入请求」。', {
      tip: true,
    });
  } catch (e) {
    $('import-info').textContent = e.message;
    setStatus(e.message, { error: true });
  }
  controls();
};

$('import').onclick = async () => {
  if (!connected || !selectedImport || transfer || expectedRestore) return;
  try {
    const d = selectedImport.metadata;
    if (d.device_id !== device) {
      throw Error(
        `备份属于设备 ${d.device_id}，当前连接的是 ${device}。导入仅限同一台 AI Passport。`,
      );
    }
    if (
      (await directory.queryPermission({ mode: 'readwrite' })) !== 'granted'
    ) {
      throw Error('请重新选择有写入权限的备份目录');
    }
    transfer = { file: selectedImport };
    controls();
    await send(
      `${PROTOCOL} OFFER ${session} ${d.device_id} ${d.firmware} ${d.save_version} ${selectedImport.bytes.length} ${d.crc32}`,
    );
    setStatus('已发送导入请求，等待设备确认…');
  } catch (e) {
    transfer = null;
    setStatus(e.message, { error: true });
    controls();
  }
};

$('forget-result').onclick = () => {
  rememberRestore(null);
  setStatus(
    '已结束核对；这不表示导入成功。请保留原备份，在设备核实进度后再操作。',
    { error: true },
  );
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
  setStatus(
    '检测到未核对完的导入。请重新连接同一台设备以确认结果；在此之前不要删除原备份。',
    { tip: true },
  );
}
