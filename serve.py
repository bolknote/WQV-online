#!/usr/bin/env python3
"""Serve only the static WebUSB prototype; never access USB from Python."""
import argparse
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import sys
import webbrowser
from urllib.parse import urlsplit


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Permissions-Policy', 'usb=(self)')
        path = urlsplit(self.path).path
        ancestors = "'self'" if path.startswith('/manuals/') and path.endswith('.html') else "'none'"
        self.send_header('Content-Security-Policy',
                         "default-src 'self'; script-src 'self'; style-src 'self'; "
                         "img-src 'self' data: blob:; connect-src http://127.0.0.1:8767; object-src 'none'; "
                         f"base-uri 'self'; frame-ancestors {ancestors}")
        super().end_headers()

    def list_directory(self, path):
        self.send_error(404)
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--open', action='store_true')
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('Port must be between 1024 and 65535')
    folder = Path(__file__).resolve().parent / 'dist'
    handler = functools.partial(Handler, directory=str(folder))
    try:
        server = ThreadingHTTPServer(('127.0.0.1', args.port), handler)
    except OSError as error:
        print(f'Не удалось запустить сервер: {error}', file=sys.stderr)
        print('Возможно, страница уже запущена. Открой http://127.0.0.1:8765/ или укажи --port 8766.', file=sys.stderr)
        return 1
    url = f'http://127.0.0.1:{args.port}/'
    print(f'WQV WebUSB: {url}', flush=True)
    print('Сервер раздаёт HTML/JS. Обмен с USB выполняет только браузер. Ctrl+C — завершить.', flush=True)
    if args.open:
        if sys.platform == 'darwin':
            opened = subprocess.run(['open', '-a', 'Google Chrome', url], check=False).returncode == 0
        else:
            opened = False
        if not opened:
            webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
