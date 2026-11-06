import assert from 'node:assert/strict';
import {
  Receiver,
  crc32,
  envelope,
  decodeBackup,
  NVS_SIZE,
  NVS_OFFSET,
  PROTOCOL,
} from './web/backup.mjs';

const bytes = new Uint8Array(NVS_SIZE);
for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17 + 3) & 0xff;
const crc = crc32(bytes);
const device = 'aabbccddeeff';
const firmware = 'a'.repeat(64);
const session = 'b'.repeat(32);

const fakeCrypto = {
  subtle: {
    async digest(_algo, data) {
      // deterministic stub for node without webcrypto subtle in older envs
      const { createHash } = await import('node:crypto');
      const h = createHash('sha256').update(Buffer.from(data)).digest();
      return h.buffer.slice(h.byteOffset, h.byteOffset + h.byteLength);
    },
  },
};

const q = {
  id: '1',
  device,
  firmware,
  version: 7,
  crc,
  bytes,
};
const env = await envelope(q, fakeCrypto);
assert.equal(env.format, 'ember-nvs-backup');
assert.equal(env.nvs_offset, NVS_OFFSET);
assert.equal(env.game_title, '余烬');

const decoded = await decodeBackup(`${JSON.stringify(env)}\n`, fakeCrypto);
assert.equal(decoded.metadata.save_version, 7);
assert.equal(decoded.bytes.length, NVS_SIZE);

const r = new Receiver(session);
assert.deepEqual(r.accept(`${PROTOCOL} READY ${session} ${device}`), {
  ready: device,
});

const begin = `${PROTOCOL} BEGIN ${session} 1 ${device} ${firmware} 7 ${NVS_OFFSET} ${NVS_SIZE} ${crc}`;
assert.equal(r.accept(begin).progress, 0);
for (let off = 0; off < NVS_SIZE; off += 128) {
  const hex = Array.from(bytes.slice(off, off + 128), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  const res = r.accept(`${PROTOCOL} DATA 1 ${off} ${hex}`);
  assert.ok(res.progress >= 0);
}
const done = r.accept(`${PROTOCOL} END 1 ${crc}`);
assert.equal(done.complete.crc, crc);

assert.deepEqual(
  r.accept(`${PROTOCOL} RESTORED ${session} 1 deadbeef`),
  { restored: { result: 1, crc: 'deadbeef' } },
);
assert.deepEqual(
  r.accept(`${PROTOCOL} RESTORED ${session} 3 cafebabe`),
  { restored: { result: 3, crc: 'cafebabe' } },
);
assert.equal(r.accept(`${PROTOCOL} RESTORED ${session} 9 deadbeef`), null);

console.log('selftest: ok');
