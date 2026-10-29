#!/usr/bin/env python3
"""Local USB transport for WQV Link and KingSun KS-959 (07d0:4959).

MIT License, Copyright (c) 2026 Evgeny Stepanischev.
Python 3 + libusb-1.0. No Python packages, watch protocol or kernel driver.
The browser cannot address KS-959's speed command (interface recipient 1).
This helper forwards only the adapter's three documented control requests.
"""
import argparse
import ctypes as C
import ctypes.util
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import secrets
import threading
import time
from urllib.parse import urlsplit

PORT = 8767
ALLOWED_ORIGINS = {'https://bolknote.github.io'} | {
    'http://' + host + ':' + str(port)
    for host in ('127.0.0.1', 'localhost') for port in (8765, 8766)
}


def validate_control(direction, setup, payload):
    if setup.get('requestType') != 'class' or setup.get('recipient') != 'interface':
        raise ValueError('Only KS-959 class/interface requests are allowed')
    request, value, index = (setup.get(key) for key in ('request', 'value', 'index'))
    if direction == 'in':
        if (request, value, index, payload) != (1, 0x200, 0, 2048):
            raise ValueError('Invalid KS-959 receive request')
        return 0xa1, 1, 0x200, 0, 2048
    data = bytes.fromhex(payload['hex'])
    if request != 9:
        raise ValueError('Invalid KS-959 output request')
    if index == 1:
        if value != 0x200 or len(data) != 8 or data[4:] != b'\x03\0\0\0' or int.from_bytes(data[:4], 'little') not in (9600, 19200, 38400, 57600, 115200):
            raise ValueError('Invalid KS-959 speed command')
    elif index == 0:
        if not isinstance(value, int) or not 1 <= value <= 240 or len(data) != ((value + 7) // 8) * 8 + 16 or any(data[value:]):
            raise ValueError('Invalid KS-959 transmit fragment')
    else:
        raise ValueError('Invalid KS-959 command index')
    return 0x21, 9, value, index, data


class USB:
    def __init__(self):
        library = ctypes.util.find_library('usb-1.0')
        if not library:
            library = next((str(p) for p in (Path('/opt/homebrew/lib/libusb-1.0.dylib'),
                Path('/usr/local/lib/libusb-1.0.dylib')) if p.exists()), None)
        if not library:
            raise RuntimeError('libusb-1.0 was not found. On macOS: brew install libusb')
        self.lib = C.CDLL(library)
        self.context, self.handle, self.claimed = C.c_void_p(), None, False
        signatures = {
            'init': ([C.POINTER(C.c_void_p)], C.c_int), 'exit': ([C.c_void_p], None),
            'open_device_with_vid_pid': ([C.c_void_p, C.c_uint16, C.c_uint16], C.c_void_p),
            'close': ([C.c_void_p], None), 'get_configuration': ([C.c_void_p, C.POINTER(C.c_int)], C.c_int),
            'set_configuration': ([C.c_void_p, C.c_int], C.c_int),
            'claim_interface': ([C.c_void_p, C.c_int], C.c_int), 'release_interface': ([C.c_void_p, C.c_int], C.c_int),
            'control_transfer': ([C.c_void_p, C.c_uint8, C.c_uint8, C.c_uint16, C.c_uint16,
                C.POINTER(C.c_ubyte), C.c_uint16, C.c_uint], C.c_int), 'error_name': ([C.c_int], C.c_char_p),
        }
        for name, (args, result) in signatures.items():
            fn = getattr(self.lib, 'libusb_' + name); fn.argtypes, fn.restype = args, result
        self.check(self.lib.libusb_init(C.byref(self.context)))
        try:
            self.handle = self.lib.libusb_open_device_with_vid_pid(self.context, 0x07d0, 0x4959)
            if not self.handle:
                raise RuntimeError('KS-959 (07d0:4959) was not found or is in use by another application')
            current = C.c_int()
            self.check(self.lib.libusb_get_configuration(self.handle, C.byref(current)), 'get configuration')
            if current.value != 1:
                self.check(self.lib.libusb_set_configuration(self.handle, 1), 'set configuration')
            self.check(self.lib.libusb_claim_interface(self.handle, 0), 'claim interface 0'); self.claimed = True
        except BaseException:
            self.close(); raise

    def check(self, value, operation='USB request'):
        if value < 0:
            raise RuntimeError(operation + ': ' + self.lib.libusb_error_name(value).decode() + ' (' + str(value) + ')')
        return value

    def control(self, direction, setup, payload):
        kind, request, value, index, content = validate_control(direction, setup, payload)
        size = content if direction == 'in' else len(content)
        buffer = (C.c_ubyte * size)()
        if direction == 'out':
            buffer[:] = content
        count = self.check(self.lib.libusb_control_transfer(self.handle, kind, request, value, index, buffer, size, 1000))
        return {'status': 'ok', 'hex': bytes(buffer[:count]).hex()} if direction == 'in' else {'status': 'ok', 'bytesWritten': count}

    def close(self):
        if self.handle:
            if self.claimed:
                self.lib.libusb_release_interface(self.handle, 0)
            self.lib.libusb_close(self.handle); self.handle = None; self.claimed = False
        if self.context:
            self.lib.libusb_exit(self.context); self.context = C.c_void_p()


class Bridge:
    def __init__(self, factory=USB):
        self.factory, self.adapter, self.token, self.last_request = factory, None, None, 0
        self.lock = threading.Lock()

    def close(self):
        if self.adapter:
            self.adapter.close()
        self.adapter = None; self.token = None

    def dispatch(self, body):
        with self.lock:
            now = time.monotonic()
            if self.adapter and now - self.last_request > 180:
                self.close()
            method, args = body.get('method'), body.get('args', [])
            if method == 'open':
                if self.adapter:
                    raise RuntimeError('KS-959 is already connected. Disconnect it in the other WQV Link tab first')
                self.adapter = self.factory(); self.token = secrets.token_urlsafe(32); self.last_request = now
                return {'session': self.token, 'vendorId': 0x07d0, 'productId': 0x4959, 'configuration': 1}
            if not self.adapter or not isinstance(body.get('session'), str) or not secrets.compare_digest(body['session'], self.token):
                raise RuntimeError('USB session is closed. Click Connect USB again')
            self.last_request = now
            if method == 'close':
                self.close(); return {}
            if method == 'controlTransferIn' and len(args) == 2:
                return self.adapter.control('in', *args)
            if method == 'controlTransferOut' and len(args) == 2:
                return self.adapter.control('out', *args)
            raise ValueError('Unsupported USB operation')


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def permitted(self):
        return self.headers.get('Host') == '127.0.0.1:' + str(self.server.server_port) and self.headers.get('Origin') in ALLOWED_ORIGINS

    def response(self, status, value):
        data = json.dumps(value, separators=(',', ':')).encode()
        self.send_response(status)
        if self.permitted():
            self.send_header('Access-Control-Allow-Origin', self.headers['Origin'])
            self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')
            self.send_header('Access-Control-Allow-Private-Network', 'true')
            self.send_header('Vary', 'Origin')
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers(); self.wfile.write(data)

    def do_OPTIONS(self):
        self.response(200 if self.permitted() else 403, {})

    def do_POST(self):
        if not self.permitted() or self.path != '/usb' or self.headers.get('Content-Type') != 'application/json':
            self.response(403, {'error': 'This helper accepts requests only from WQV Link'}); return
        try:
            size = int(self.headers.get('Content-Length', 0))
            if not 1 <= size <= 8192:
                raise ValueError('Invalid request size')
            body = json.loads(self.rfile.read(size))
            if not isinstance(body, dict):
                raise ValueError('Expected a JSON object')
            result = self.server.bridge.dispatch(body)
            self.response(200, {'result': result})
        except Exception as error:
            self.response(400, {'error': str(error)})

    def do_GET(self):
        self.response(200, {'helper': 'WQV Link / KingSun KS-959', 'usbId': '07d0:4959', 'version': 1})

    def log_message(self, *_):
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--probe', action='store_true', help='open the adapter, set 9600, read USB once and close; sends no infrared frame')
    args = parser.parse_args()
    if args.probe:
        adapter = USB()
        try:
            adapter.control('out', {'requestType': 'class', 'recipient': 'interface', 'request': 9, 'value': 512, 'index': 1}, {'hex': '8025000003000000'})
            data = adapter.control('in', {'requestType': 'class', 'recipient': 'interface', 'request': 1, 'value': 512, 'index': 0}, 2048)
            print('KS-959 USB OK. 9600 bit/s; raw USB bytes:', len(data['hex']) // 2, '; infrared frames sent: 0')
        finally:
            adapter.close()
        return
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler); server.daemon_threads = True
    server.bridge = Bridge()
    print('WQV Link / KingSun KS-959 helper: http://127.0.0.1:' + str(PORT), flush=True)
    print('Leave this terminal open. In WQV Link, click Connect USB and choose USB to IRDA (07d0:4959).', flush=True)
    print('Prepare the watch only after USB is ready. Ctrl+C stops the helper.', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        with server.bridge.lock:
            server.bridge.close()


if __name__ == '__main__':
    main()
