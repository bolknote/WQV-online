import importlib.util
from pathlib import Path
import unittest
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location('irda_usb_helper', Path(__file__).parents[1] / 'dist/irda_usb_helper.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class HelperTests(unittest.TestCase):
    def test_pl2303_device_descriptor_is_read_only_and_narrowly_scoped(self):
        adapter = helper.USB.__new__(helper.USB)
        adapter.control = MagicMock(return_value=bytes(18))
        request = {'type': 0x80, 'request': 6, 'value': 0x100, 'index': 0, 'length': 18}
        self.assertEqual(adapter.transfer(request, None), {'hex': '00' * 18})
        adapter.control.assert_called_once_with(0x80, 6, 0x100, 0, 18)
        for change in ({'type': 0}, {'request': 9}, {'value': 0x200}, {'index': 1}, {'length': 64}):
            with self.assertRaises(ValueError):
                changed = {**request, **change}
                adapter.transfer(changed, None if changed['type'] & 128 else '00' * changed['length'])
        self.assertEqual(adapter.control.call_count, 1)
        self.assertIn((0x0df7, 0x0620), helper.ALLOWED_DEVICES)

    def test_active_configuration_zero_reaches_native_claim(self):
        raw = bytes.fromhex('0902270001000080fa0904000003ff000000070581030400010705020240000007058202400000')
        library = MagicMock()
        library.libusb_init.return_value = 0
        library.libusb_claim_interface.return_value = 0
        library.libusb_release_interface.return_value = 0
        def configuration(handle, pointer):
            pointer._obj.value = 0
            return 0
        library.libusb_get_configuration.side_effect = configuration
        with patch.object(helper.ctypes.util, 'find_library', return_value='usb-1.0'), \
                patch.object(helper.C, 'CDLL', return_value=library), \
                patch.object(helper.USB, 'open_unique_device', return_value=helper.C.c_void_p(1)), \
                patch.object(helper.USB, 'control', side_effect=[raw[:9], raw]):
            adapter = helper.USB(0x18ec, 0x3118)
            self.assertEqual(adapter.configuration, 0)
            self.assertEqual(len(adapter.alternate['endpoints']), 3)
            library.libusb_claim_interface.assert_called_once_with(adapter.handle, 0)
            library.libusb_set_configuration.assert_not_called()
            adapter.close()

    def test_descriptor_is_read_and_truncated_descriptors_rejected(self):
        raw = bytes.fromhex('0902200001010080320904000002ff0000000705810240000007050202400000')
        config, alternates = helper.parse_configuration(raw)
        self.assertEqual(config, 1)
        self.assertEqual(alternates[0]['interfaceNumber'], 0)
        self.assertEqual(alternates[0]['endpoints'][0], {'endpointNumber': 1, 'direction': 'in', 'type': 'bulk', 'packetSize': 64})
        with self.assertRaises(helper.USBError):
            helper.parse_configuration(raw[:-2])

    def test_session_and_device_scope_are_enforced_without_opening_usb(self):
        opened = []
        class Device:
            configuration = 1
            alternate = {'interfaceClass': 255, 'endpoints': []}
            def __init__(self, vendor, product, interface):
                opened.append((vendor, product, interface))
            def close(self):
                opened.append('closed')
        bridge = helper.Bridge(factory=Device)
        with self.assertRaises(helper.USBError):
            bridge.dispatch({'method': 'open', 'args': [0x1234, 0x5678, 0]})
        self.assertEqual(opened, [])
        result = bridge.dispatch({'method': 'open', 'args': [0x07d0, 0x4959, 0]})
        with self.assertRaises(helper.USBError):
            bridge.dispatch({'method': 'close', 'session': 'wrong'})
        bridge.dispatch({'method': 'close', 'session': result['session']})
        self.assertEqual(opened[-1], 'closed')


if __name__ == '__main__':
    unittest.main()
