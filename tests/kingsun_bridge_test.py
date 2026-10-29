import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location('bridge', Path(__file__).resolve().parents[1] / 'dist/kingsun_bridge.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
SPEED = dict(requestType='class', recipient='interface', request=9, value=512, index=1)
RX = dict(requestType='class', recipient='interface', request=1, value=512, index=0)


class FakeUSB:
    def __init__(self):
        self.closed = False; self.calls = []
    def close(self):
        self.closed = True
    def control(self, direction, setup, payload):
        self.calls.append(module.validate_control(direction, setup, payload))
        return dict(status='ok', hex='0123') if direction == 'in' else dict(status='ok', bytesWritten=8)


class Tests(unittest.TestCase):
    def test_speed_and_rx_keep_original_interface_request_type(self):
        self.assertEqual(module.validate_control('out', SPEED, dict(hex='00c2010003000000')),
                         (0x21, 9, 512, 1, bytes.fromhex('00c2010003000000')))
        self.assertEqual(module.validate_control('in', RX, 2048), (0xa1, 1, 512, 0, 2048))

    def test_unknown_requests_and_uart_modes_are_rejected(self):
        for setup, payload in [(dict(SPEED, recipient='device'), dict(hex='8025000003000000')),
            (SPEED, dict(hex='8025000007000000')), (SPEED, dict(hex='80a9030003000000')),
            (dict(SPEED, request=3), dict(hex='8025000003000000')),
            (dict(SPEED, index=4), dict(hex='8025000003000000'))]:
            with self.assertRaises(ValueError):
                module.validate_control('out', setup, payload)
        with self.assertRaises(ValueError):
            module.validate_control('in', RX, 64)

    def test_tx_requires_valid_clear_length_padded_size_and_zero_padding(self):
        setup = dict(SPEED, value=3, index=0)
        self.assertEqual(module.validate_control('out', setup, dict(hex='123456' + '00' * 21))[0], 0x21)
        for payload in ['123456', '123456' + '00' * 20 + '01']:
            with self.assertRaises(ValueError):
                module.validate_control('out', setup, dict(hex=payload))
        with self.assertRaises(ValueError):
            module.validate_control('out', dict(setup, value=241), dict(hex='00' * 264))

    def test_session_ownership_close_and_reopen(self):
        bridge = module.Bridge(factory=FakeUSB)
        first = bridge.dispatch(dict(method='open')); device = bridge.adapter
        with self.assertRaises(RuntimeError):
            bridge.dispatch(dict(method='open'))
        for session in [None, '', 'another-session']:
            with self.assertRaises(RuntimeError):
                bridge.dispatch(dict(method='controlTransferIn', args=[RX, 2048], session=session))
        result = bridge.dispatch(dict(method='controlTransferIn', args=[RX, 2048], session=first['session']))
        self.assertEqual(result['hex'], '0123')
        bridge.dispatch(dict(method='close', session=first['session']))
        self.assertTrue(device.closed)
        second = bridge.dispatch(dict(method='open'))
        self.assertNotEqual(first['session'], second['session']); bridge.close()

    def test_helper_cannot_access_any_other_usb_operations(self):
        bridge = module.Bridge(factory=FakeUSB); session = bridge.dispatch(dict(method='open'))['session']
        for method in ['transferOut', 'reset', 'vendorRequest', 'run', 'controlTransferIn']:
            with self.assertRaises(ValueError):
                bridge.dispatch(dict(method=method, args=[], session=session))
        bridge.close()

    def test_http_origin_and_host_checks(self):
        handler = SimpleNamespace(server=SimpleNamespace(server_port=8767), headers={})
        for origin, host, allowed in [('https://bolknote.github.io', '127.0.0.1:8767', True),
            ('http://127.0.0.1:8765', '127.0.0.1:8767', True),
            ('https://example.org', '127.0.0.1:8767', False),
            ('null', '127.0.0.1:8767', False), ('https://bolknote.github.io', 'example.org:8767', False)]:
            handler.headers = {'Origin': origin, 'Host': host}
            self.assertEqual(module.Handler.permitted(handler), allowed)


if __name__ == '__main__':
    unittest.main()
