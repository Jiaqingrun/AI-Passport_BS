/** 余烬 · 存档协议编解码（浏览器侧，无网络请求） */
export const NVS_SIZE = 24576; // 0x6000
export const NVS_OFFSET = 0x9000;
export const MAX_PAYLOAD = NVS_SIZE;
export const FORMAT = 'ember-nvs-backup';
export const PROTOCOL = '!EMBACKUP';

export function validSaveVersion(version) {
  return Number.isInteger(version) && version >= 1 && version <= 0xffff;
}

export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
  }
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

export class Receiver {
  constructor(session) {
    this.session = session;
    this.pending = null;
  }

  accept(line) {
    if (!line.startsWith(`${PROTOCOL} `)) return null;
    const p = line.trim().split(/\s+/);

    if (p[1] === 'READY') {
      return p.length === 4 && p[2] === this.session ? { ready: p[3] } : null;
    }

    if (p[1] === 'ERROR') {
      /* Never throw from ERROR: throwing used to abort readLoop and drop USB. */
      if (p[2] === 'STAGE') {
        const reasons = {
          LAYOUT: '设备分区布局不支持导入',
          FLASH: '存档暂存区写入失败',
          NVS: '暂存存档无法挂载或关闭',
          MEMORY: '设备可用内存不足，请重启设备后重试',
          READ: '无法读取备份中的游戏存档',
          VERSION: '备份声明版本与实际存档版本不一致',
          CONTENT: '存档数据校验未通过，请保留原备份',
          CHECKPOINT: '设备当前进度保存失败',
          JOURNAL: '导入恢复日志写入或校验失败',
        };
        const detail = Object.hasOwn(reasons, p[3]) ? reasons[p[3]] : null;
        return {
          error: detail
            ? `${detail}（STAGE ${p[3]}），原存档未替换`
            : '存档写入失败。若已生成 before-import 文件，请用它重新导入',
        };
      }
      if (p[2] === 'BUSY') {
        return { busy: true };
      }
      const map = {
        TIMEOUT: '操作已中止或超时，当前存档未覆盖。可直接重试。',
        SNAPSHOT: '当前存档备份失败，未开始导入。',
        OPEN_IMPORT: '设备未就绪接收导入。请确认已连接且空闲后重试。',
        INCOMPATIBLE:
          '备份不属于此设备，或存档版本不被当前固件支持。请先更新《余烬》固件。',
        MEMORY: '设备内存不足，请重启设备后重试。',
        CHECKSUM: '导入校验失败，原存档未替换。请保留原备份。',
        SEQUENCE: '导入数据顺序错误，已中止。可直接重试。',
        NO_HOST: '设备未检测到电脑端。请确认本页已连接 USB。',
      };
      return { error: map[p[2]] || `设备拒绝操作（${p[2] || '未知'}）` };
    }

    if (p[1] === 'OFFERED' && p.length === 2) return { offered: true };
    if (p[1] === 'CANCELLED' && p.length === 2) return { cancelled: true };
    if (p[1] === 'UPLOAD' && p.length === 3 && /^[0-9]+$/.test(p[2])) {
      return { upload: p[2] };
    }
    if (
      p[1] === 'NEXT' &&
      p.length === 4 &&
      /^[0-9]+$/.test(p[2]) &&
      /^[0-9]+$/.test(p[3])
    ) {
      return { next: { id: p[2], offset: Number(p[3]) } };
    }
    if (p[1] === 'STAGED' && p.length === 3 && /^[a-f0-9]{8}$/.test(p[2])) {
      return { staged: p[2] };
    }
    if (
      p[1] === 'RESTORED' &&
      p.length === 5 &&
      p[2] === this.session &&
      /^[123]$/.test(p[3]) &&
      /^[a-f0-9]{8}$/.test(p[4])
    ) {
      return { restored: { result: Number(p[3]), crc: p[4] } };
    }
    if (p[1] === 'HINT' && p.length >= 3) {
      return { hint: p.slice(2).join(' ') };
    }

    if (p[1] === 'BEGIN') {
      if (p.length !== 10 || p[2] !== this.session || this.pending) {
        this.pending = null;
        return { error: '备份开始信息无效，请重试' };
      }
      const [, , , id, device, firmware, version, address, size, crc] = p;
      if (
        !/^[1-9][0-9]{0,9}$/.test(id) ||
        !/^[a-f0-9]{12}$/.test(device) ||
        !/^[a-f0-9]{64}$/.test(firmware) ||
        !/^[1-9][0-9]{0,4}$/.test(version) ||
        !validSaveVersion(Number(version)) ||
        address !== String(NVS_OFFSET) ||
        Number(size) !== NVS_SIZE ||
        !/^[a-f0-9]{8}$/.test(crc)
      ) {
        return {
          error:
            '设备或备份协议不支持。请确认固件支持 USB 存档，并强制刷新本页。',
        };
      }
      this.pending = {
        id,
        device,
        firmware,
        version: Number(version),
        crc,
        bytes: new Uint8Array(Number(size)),
        offset: 0,
      };
      return { progress: 0 };
    }

    const q = this.pending;
    if (!q) return null;

    if (p[1] === 'DATA') {
      if (
        p.length !== 5 ||
        p[2] !== q.id ||
        p[3] !== String(q.offset) ||
        !/^[a-f0-9]{256}$/.test(p[4]) ||
        q.offset + 128 > q.bytes.length
      ) {
        this.pending = null;
        return { error: '备份数据缺失或顺序错误，请重试备份' };
      }
      for (let i = 0; i < 128; i++) {
        q.bytes[q.offset + i] = parseInt(p[4].slice(i * 2, i * 2 + 2), 16);
      }
      q.offset += 128;
      return { progress: q.offset / q.bytes.length };
    }

    if (p[1] === 'END') {
      if (
        p.length !== 4 ||
        p[2] !== q.id ||
        p[3] !== q.crc ||
        q.offset !== q.bytes.length ||
        crc32(q.bytes) !== q.crc
      ) {
        this.pending = null;
        return {
          error: '备份完整性校验失败，文件未写入。设备上的存档仍然安全。',
        };
      }
      this.pending = null;
      return { complete: q };
    }

    this.pending = null;
    return { error: '收到未知备份消息，请升级本工具与设备固件后重试' };
  }
}

export async function envelope(q, cryptoAPI = globalThis.crypto) {
  const digest = await cryptoAPI.subtle.digest('SHA-256', q.bytes);
  return {
    format: FORMAT,
    format_version: 1,
    game: 'ember',
    game_title: '余烬',
    created_at: new Date().toISOString(),
    chip: 'esp32c3',
    device_id: q.device,
    firmware: q.firmware,
    save_version: q.version,
    nvs_offset: NVS_OFFSET,
    nvs_size: NVS_SIZE,
    crc32: q.crc,
    sha256: Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join(''),
    payload_base64: btoa(
      Array.from({ length: Math.ceil(q.bytes.length / 8192) }, (_, i) =>
        String.fromCharCode(...q.bytes.subarray(i * 8192, (i + 1) * 8192)),
      ).join(''),
    ),
  };
}

export async function decodeBackup(text, cryptoAPI = globalThis.crypto) {
  if (typeof text !== 'string' || text.length > 120000) {
    throw Error('备份文件过大或无效');
  }
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    throw Error('备份文件不是合法 JSON。请选择 .emsave 文件。');
  }
  if (d.format !== FORMAT || d.format_version !== 1 || d.chip !== 'esp32c3') {
    throw Error(
      '不是《余烬》备份（.emsave）。PokeWalk 的 .pksave 或其他游戏文件不能用于本工具。',
    );
  }
  if (
    !validSaveVersion(d.save_version) ||
    d.nvs_offset !== NVS_OFFSET ||
    d.nvs_size !== NVS_SIZE ||
    !/^[a-f0-9]{12}$/.test(d.device_id) ||
    !/^[a-f0-9]{64}$/.test(d.firmware) ||
    !/^[a-f0-9]{64}$/.test(d.sha256) ||
    !/^[a-f0-9]{8}$/.test(d.crc32) ||
    typeof d.payload_base64 !== 'string' ||
    !/^[A-Za-z0-9+/=]+$/.test(d.payload_base64)
  ) {
    throw Error('备份元数据损坏或不完整');
  }
  const bytes = Uint8Array.from(atob(d.payload_base64), (c) => c.charCodeAt(0));
  if (bytes.length !== NVS_SIZE || crc32(bytes) !== d.crc32) {
    throw Error('备份长度或 CRC 校验失败');
  }
  const digest = await cryptoAPI.subtle.digest('SHA-256', bytes);
  const sha = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  if (sha !== d.sha256) throw Error('备份 SHA-256 校验失败');
  return { metadata: d, bytes };
}
