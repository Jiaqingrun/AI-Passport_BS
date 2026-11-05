#!/usr/bin/env python3
"""只读检查 .emsave：打印元数据与校验结果，不写设备。"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import sys
import zlib
from pathlib import Path

NVS_SIZE = 24576
NVS_OFFSET = 0x9000
FORMAT = "ember-nvs-backup"


def crc32_hex(data: bytes) -> str:
    return f"{(zlib.crc32(data) & 0xffffffff):08x}"


def main() -> int:
    p = argparse.ArgumentParser(description="检查余烬 .emsave 备份（只读）")
    p.add_argument("file", type=Path)
    args = p.parse_args()
    raw = args.file.read_text(encoding="utf-8")
    data = json.loads(raw)
    if data.get("format") != FORMAT or data.get("format_version") != 1:
        print("不是 ember-nvs-backup v1", file=sys.stderr)
        return 2
    payload = base64.b64decode(data["payload_base64"])
    ok_len = len(payload) == NVS_SIZE
    ok_crc = crc32_hex(payload) == data.get("crc32")
    ok_sha = hashlib.sha256(payload).hexdigest() == data.get("sha256")
    ok_off = data.get("nvs_offset") == NVS_OFFSET and data.get("nvs_size") == NVS_SIZE
    print(f"file:         {args.file}")
    print(f"game:         {data.get('game_title') or data.get('game')}")
    print(f"created_at:   {data.get('created_at')}")
    print(f"device_id:    {data.get('device_id')}")
    print(f"save_version: {data.get('save_version')}")
    print(f"firmware:     {str(data.get('firmware'))[:16]}…")
    print(f"payload:      {len(payload)} bytes")
    print(f"checks:       len={ok_len} crc={ok_crc} sha256={ok_sha} layout={ok_off}")
    return 0 if all((ok_len, ok_crc, ok_sha, ok_off)) else 1


if __name__ == "__main__":
    raise SystemExit(main())
