import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('irda_usb_helper', Path(__file__).parents[1] / 'dist/irda_usb_helper.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class HelperTests(unittest.TestCase):
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
