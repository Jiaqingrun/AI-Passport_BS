#!/usr/bin/env python3
"""余烬存档管家：仅提供静态页与离线 ZIP。串口与文件都在用户浏览器本地完成。"""
from __future__ import annotations

import argparse
import io
import zipfile
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
WEB_FILES = ("index.html", "style.css", "app.mjs", "backup.mjs")
BUNDLE_FILES = ("server.py", *(f"web/{name}" for name in WEB_FILES))

START_HERE = """余烬 · 本地存档管家

需要：Python 3.8+、桌面版 Chrome / Edge。无需 pip 安装依赖。

1. 解压本 ZIP，在本文件夹打开终端。
2. macOS / Linux: python3 server.py
   Windows:        py -3 server.py
3. 浏览器打开 http://localhost:8901/
4. 选择私人备份目录 → 连接设备 →「立即备份」或「选择并导入」。
5. 导入时只在设备上确认覆盖；保持终端运行，Ctrl+C 停止。

端口占用时：python3 server.py --port 8902
存档只写在你电脑上，不会上传。
导入仅限同一台 AI Passport；固件需支持 !EMBACKUP（含 PULL）协议。
"""


def local_bundle() -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        files = {name: (ROOT / name).read_bytes() for name in BUNDLE_FILES}
        files["START-HERE.txt"] = START_HERE.encode("utf-8")
        for name, data in files.items():
            info = zipfile.ZipInfo(f"EmberSaveManager/{name}", (2026, 11, 5, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            if name == "server.py":
                info.external_attr = 0o100755 << 16
            archive.writestr(info, data)
    return output.getvalue()


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript",
    }

    def bundle_response(self, body: bool) -> None:
        data = local_bundle()
        self.send_response(200)
        self.send_header("Content-Type", "application/zip")
        self.send_header(
            "Content-Disposition",
            'attachment; filename="EmberSaveManager.zip"',
        )
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if body:
            self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        if urlsplit(self.path).path == "/download/EmberSaveManager.zip":
            self.bundle_response(True)
        else:
            super().do_GET()

    def do_HEAD(self) -> None:  # noqa: N802
        if urlsplit(self.path).path == "/download/EmberSaveManager.zip":
            self.bundle_response(False)
        else:
            super().do_HEAD()

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; connect-src 'none'; object-src 'none'; "
            "frame-ancestors 'none'; base-uri 'none'",
        )
        super().end_headers()


def main() -> None:
    parser = argparse.ArgumentParser(description="余烬存档管家本地服务")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8901)
    args = parser.parse_args()
    handler = partial(Handler, directory=str(ROOT / "web"))
    print(f"余烬存档管家: http://{args.host}:{args.port}", flush=True)
    print("选择备份目录 → 连接设备 → 立即备份 / 选择并导入", flush=True)
    ThreadingHTTPServer((args.host, args.port), handler).serve_forever()


if __name__ == "__main__":
    main()
