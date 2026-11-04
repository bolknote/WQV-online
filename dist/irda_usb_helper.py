#!/usr/bin/env python3
"""USB transport for C drivers in WQV Link. Python 3 + libusb-1.0.

MIT License. Copyright (c) 2026 Evgeny Stepanischev.
Listens only on loopback. No C compiler, watch protocol, shell or file API.
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

PORT = 8768
ALLOWED_ORIGINS = {'https://bolknote.github.io'} | {
    f'http://{host}:{port}' for host in ('127.0.0.1', 'localhost')
    for port in (8765, 8766, 8781)
}
ALLOWED_DEVICES = {(0x066f, 0x4200), (0x07d0, 0x4959), (0x07d0, 0x4100),
    (0x07c0, 0x4200), (0x9710, 0x7780), (0x18ec, 0x3118),
    (0x6547, 0x0232), (0x09c4, 0x0011), (0x4428, 0x0012),
    (0x050f, 0x0180), (0x08e9, 0x0100), (0x066f, 0x4210),
    (0x066f, 0x4220), (0x066f, 0x4116)}


class USBError(RuntimeError):
    def __init__(self, message, code='usb-error'):
        super().__init__(message)
        self.code = code


def integer(value, minimum=0, maximum=65535):
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError('Invalid USB integer')
    return value


def parse_configuration(raw):
    if len(raw) < 9 or raw[1] != 2 or raw[0] < 9:
        raise USBError('Invalid USB configuration descriptor')
    alternates, position, alternate = [], 0, None
    while position + 2 <= len(raw):
        length, kind = raw[position:position + 2]
        if length < 2 or position + length > len(raw):
            raise USBError('Truncated USB configuration descriptor')
        item = raw[position:position + length]
        if kind == 4 and length >= 9:
            alternate = {'interfaceNumber': item[2], 'alternateSetting': item[3],
                'interfaceClass': item[5], 'interfaceSubclass': item[6],
                'interfaceProtocol': item[7], 'endpoints': []}
            alternates.append(alternate)
        elif kind == 5 and length >= 7 and alternate is not None:
            alternate['endpoints'].append({'endpointNumber': item[2] & 15,
                'direction': 'in' if item[2] & 128 else 'out',
                'type': ('control', 'isochronous', 'bulk', 'interrupt')[item[3] & 3],
                'packetSize': int.from_bytes(item[4:6], 'little') & 2047})
        position += length
    return raw[5], alternates


class USB:
    def __init__(self, vendor, product, interface=0):
        self.vendor, self.product, self.interface = vendor, product, interface
        self.handle, self.claimed, self.context = None, False, C.c_void_p()
        library = ctypes.util.find_library('usb-1.0') or next((str(p) for p in
            (Path('/opt/homebrew/lib/libusb-1.0.dylib'), Path('/usr/local/lib/libusb-1.0.dylib')) if p.exists()), None)
        if not library:
            raise USBError('libusb-1.0 not found. On macOS: brew install libusb', 'helper-setup')
        self.lib = C.CDLL(library)
        pointer = C.POINTER(C.c_ubyte)
        signatures = {
            'init': ([C.POINTER(C.c_void_p)], C.c_int), 'exit': ([C.c_void_p], None),
            'open_device_with_vid_pid': ([C.c_void_p, C.c_uint16, C.c_uint16], C.c_void_p),
            'close': ([C.c_void_p], None), 'get_configuration': ([C.c_void_p, C.POINTER(C.c_int)], C.c_int),
            'set_configuration': ([C.c_void_p, C.c_int], C.c_int),
            'claim_interface': ([C.c_void_p, C.c_int], C.c_int), 'release_interface': ([C.c_void_p, C.c_int], C.c_int),
            'set_interface_alt_setting': ([C.c_void_p, C.c_int, C.c_int], C.c_int),
            'clear_halt': ([C.c_void_p, C.c_ubyte], C.c_int),
            'control_transfer': ([C.c_void_p, C.c_uint8, C.c_uint8, C.c_uint16, C.c_uint16, pointer, C.c_uint16, C.c_uint], C.c_int),
            'bulk_transfer': ([C.c_void_p, C.c_ubyte, pointer, C.c_int, C.POINTER(C.c_int), C.c_uint], C.c_int),
            'interrupt_transfer': ([C.c_void_p, C.c_ubyte, pointer, C.c_int, C.POINTER(C.c_int), C.c_uint], C.c_int),
            'error_name': ([C.c_int], C.c_char_p),
        }
        for name, (args, restype) in signatures.items():
            function = getattr(self.lib, 'libusb_' + name)
            function.argtypes, function.restype = args, restype
        self.check(self.lib.libusb_init(C.byref(self.context)))
        try:
            self.handle = self.lib.libusb_open_device_with_vid_pid(self.context, vendor, product)
            if not self.handle:
                raise USBError('USB adapter not found or inaccessible', 'unavailable')
            head = self.control(0x80, 6, 0x0200, 0, 9)
            total = int.from_bytes(head[2:4], 'little')
            if not 9 <= total <= 4096:
                raise USBError('Invalid USB descriptor size')
            configuration, alternates = parse_configuration(self.control(0x80, 6, 0x0200, 0, total))
            self.alternates = [item for item in alternates if item['interfaceNumber'] == interface]
            if not configuration or not self.alternates:
                raise USBError('No usable USB interfaces. The OS configuration is unavailable.', 'no-interfaces')
            self.alternate = self.alternates[0]
            current = C.c_int()
            self.check(self.lib.libusb_get_configuration(self.handle, C.byref(current)))
            if current.value != configuration:
                self.check(self.lib.libusb_set_configuration(self.handle, configuration))
            self.check(self.lib.libusb_claim_interface(self.handle, interface)); self.claimed = True
            self.configuration = configuration
        except BaseException:
            self.close()
            raise

    def check(self, status):
        if status < 0:
            raise USBError(self.lib.libusb_error_name(status).decode(), 'busy' if status == -6 else 'usb-error')
        return status

    def control(self, kind, request, value, index, content):
        input_request = bool(kind & 128)
        size = content if input_request else len(content)
        buffer = (C.c_ubyte * size)()
        if not input_request:
            buffer[:] = content
        count = self.lib.libusb_control_transfer(self.handle, kind, request, value, index, buffer, size, 100 if input_request else 1000)
        if count == -7 and input_request:
            return b''
        self.check(count)
        return bytes(buffer[:count]) if input_request else count

    def transfer(self, request, payload):
        kind = integer(request.get('type'), 0, 255)
        length = integer(request.get('length'), 0, 4096)
        input_request = bool(kind & 128)
        if payload is not None and (not isinstance(payload, str) or len(payload) > 8192):
            raise ValueError('Invalid USB payload')
        data = bytes.fromhex(payload) if payload is not None else None
        if not input_request and (data is None or len(data) != length):
            raise ValueError('USB output length mismatch')
        if request.get('bulk') or request.get('transfer'):
            endpoint = integer(request.get('index'), 1, 15)
            transfer_type = request.get('transfer', 'bulk')
            if transfer_type not in ('bulk', 'interrupt'):
                raise ValueError('Unsupported endpoint type')
            direction = 'in' if input_request else 'out'
            if not any(e['endpointNumber'] == endpoint and e['direction'] == direction and e['type'] == transfer_type for e in self.alternate['endpoints']):
                raise ValueError('Endpoint is absent from the selected interface')
            buffer, actual = (C.c_ubyte * length)(), C.c_int()
            if data is not None:
                buffer[:] = data
            function = self.lib.libusb_interrupt_transfer if transfer_type == 'interrupt' else self.lib.libusb_bulk_transfer
            status = function(self.handle, endpoint | (128 if input_request else 0), buffer, length, C.byref(actual), 100 if input_request else 1000)
            if not (status == -7 and input_request):
                self.check(status)
            result = bytes(buffer[:actual.value]) if input_request else actual.value
            endpoint_info = next(e for e in self.alternate['endpoints'] if e['endpointNumber'] == endpoint and e['direction'] == direction)
            if not input_request and request.get('flags', 0) & 0x40 and length and endpoint_info['packetSize'] and length % endpoint_info['packetSize'] == 0:
                empty, empty_actual = (C.c_ubyte * 0)(), C.c_int()
                self.check(function(self.handle, endpoint, empty, 0, C.byref(empty_actual), 1000))
        else:
            # Class/vendor requests only. Standard configuration and reset
            # operations are provided as separate, bounded services below.
            if (kind & 0x60) not in (0x20, 0x40) or (kind & 31) > 3:
                raise ValueError('Only class/vendor controls are allowed')
            result = self.control(kind, integer(request.get('request'), 0, 255),
                integer(request.get('value')), integer(request.get('index')), length if input_request else data)
        return {'hex': result.hex()} if input_request else {'written': result}

    def close(self):
        if self.handle:
            if self.claimed:
                self.lib.libusb_release_interface(self.handle, self.interface)
            self.lib.libusb_close(self.handle)
            self.handle, self.claimed = None, False
        if self.context:
            self.lib.libusb_exit(self.context)
            self.context = C.c_void_p()


class Bridge:
    def __init__(self, factory=USB, allowed=None):
        self.factory, self.allowed = factory, ALLOWED_DEVICES if allowed is None else allowed
        self.adapter = self.token = None
        self.last_request, self.lock = 0, threading.Lock()

    def close(self):
        if self.adapter:
            self.adapter.close()
        self.adapter = self.token = None

    def dispatch(self, body):
        with self.lock:
            method, args = body.get('method'), body.get('args', [])
            if not isinstance(args, list):
                raise ValueError('Invalid arguments')
            now = time.monotonic()
            if self.adapter and now - self.last_request > 180:
                self.close()
            if method == 'open':
                if len(args) != 3:
                    raise ValueError('Expected USB VID, PID and interface')
                vendor, product, interface = integer(args[0]), integer(args[1]), integer(args[2], 0, 255)
                if (vendor, product) not in self.allowed:
                    raise USBError('This USB ID is not enabled. Start the helper with --device VID:PID to allow it.', 'helper-setup')
                if self.adapter:
                    raise USBError('USB is already open in another WQV Link tab', 'busy')
                adapter = self.factory(vendor, product, interface)
                self.adapter, self.token = adapter, secrets.token_urlsafe(32)
                self.last_request = now
                return {'session': self.token, 'vendorId': vendor, 'productId': product,
                    'configuration': {'configurationValue': adapter.configuration},
                    'interfaceNumber': interface, 'alternate': adapter.alternate}
            if not self.adapter or not isinstance(body.get('session'), str) or not secrets.compare_digest(body['session'], self.token):
                raise USBError('USB session is closed', 'closed')
            self.last_request = now
            if method == 'close':
                self.close()
                return {}
            if method == 'transfer' and len(args) == 2 and isinstance(args[0], dict):
                return self.adapter.transfer(*args)
            if method == 'clearHalt' and len(args) == 1:
                endpoint = integer(args[0], 1, 255)
                if not any((e['endpointNumber'] | (128 if e['direction'] == 'in' else 0)) == endpoint for e in self.adapter.alternate['endpoints']):
                    raise ValueError('Invalid endpoint')
                self.adapter.check(self.adapter.lib.libusb_clear_halt(self.adapter.handle, endpoint))
                return {}
            if method == 'resetConfiguration' and not args:
                self.adapter.check(self.adapter.lib.libusb_release_interface(self.adapter.handle, self.adapter.interface))
                self.adapter.claimed = False
                self.adapter.check(self.adapter.lib.libusb_set_configuration(self.adapter.handle, self.adapter.configuration))
                self.adapter.check(self.adapter.lib.libusb_claim_interface(self.adapter.handle, self.adapter.interface))
                self.adapter.claimed = True
                return {}
            if method == 'setInterface' and len(args) == 2:
                interface, alternate = integer(args[0], 0, 255), integer(args[1], 0, 255)
                descriptor = next((a for a in self.adapter.alternates if a['alternateSetting'] == alternate), None)
                if interface != self.adapter.interface or descriptor is None:
                    raise ValueError('Invalid alternate setting')
                self.adapter.check(self.adapter.lib.libusb_set_interface_alt_setting(self.adapter.handle, interface, alternate))
                self.adapter.alternate = descriptor
                return {}
            raise ValueError('Unsupported USB operation')


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def permitted(self):
        return self.headers.get('Host') == f'127.0.0.1:{self.server.server_port}' and self.headers.get('Origin') in ALLOWED_ORIGINS

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
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.response(200 if self.permitted() else 403, {})

    def do_POST(self):
        if not self.permitted() or self.path != '/usb' or self.headers.get('Content-Type') != 'application/json':
            self.response(403, {'error': 'This helper accepts only WQV Link requests'})
            return
        try:
            size = integer(int(self.headers.get('Content-Length', 0)), 1, 32768)
            body = json.loads(self.rfile.read(size))
            if not isinstance(body, dict):
                raise ValueError('Expected a JSON object')
            self.response(200, {'result': self.server.bridge.dispatch(body)})
        except Exception as error:
            self.response(400, {'error': str(error), 'code': getattr(error, 'code', 'invalid-request')})

    def do_GET(self):
        self.response(200 if self.permitted() else 403, {'helper': 'WQV Link USB Helper', 'version': 1})

    def log_message(self, *_):
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--device', action='append', default=[], help='also permit one USB VID:PID in hexadecimal')
    args = parser.parse_args()
    allowed = set(ALLOWED_DEVICES)
    for item in args.device:
        try:
            vendor, product = item.split(':')
            allowed.add((integer(int(vendor, 16)), integer(int(product, 16))))
        except (ValueError, TypeError):
            parser.error('Use --device 1234:5678')
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    server.daemon_threads = True
    server.bridge = Bridge(allowed=allowed)
    print(f'WQV Link USB Helper: http://127.0.0.1:{PORT}', flush=True)
    print('Keep this terminal open. WQV Link selects the C driver. Ctrl+C stops the helper.', flush=True)
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
