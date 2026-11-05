"""Exercise real helper selection with a fake libusb; never open physical USB."""
import ctypes as C
import importlib.util
from pathlib import Path
import unittest


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parents[1] / 'dist' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Library:
    def __init__(self, module, identities, descriptor_error=False):
        self.module, self.identities = module, identities
        self.devices = (C.c_void_p * (len(identities) + 1))(*range(1, len(identities) + 1), None)
        self.opened, self.freed, self.descriptor_error = [], False, descriptor_error

    def libusb_get_device_list(self, context, result):
        C.cast(result, C.POINTER(C.POINTER(C.c_void_p)))[0] = C.cast(self.devices, C.POINTER(C.c_void_p))
        return len(self.identities)

    def libusb_get_device_descriptor(self, device, result):
        if self.descriptor_error:
            return -1
        descriptor = C.cast(result, C.POINTER(self.module.DeviceDescriptor)).contents
        descriptor.vendor, descriptor.product = self.identities[device - 1]
        return 0

    def libusb_open(self, device, result):
        self.opened.append(device)
        C.cast(result, C.POINTER(C.c_void_p))[0] = device + 100
        return 0

    def libusb_free_device_list(self, devices, unref):
        self.freed = unref == 1

    def libusb_error_name(self, code):
        return b'fixture descriptor failure'


class SelectionTests(unittest.TestCase):
    def test_both_standalone_helpers_reject_duplicate_ids_before_opening_any_handle(self):
        target, other = (0x07d0, 0x4959), (0x066f, 0x4200)
        for name in ['irda_usb_helper', 'kingsun_bridge']:
            module = load(name)
            self.assertEqual(C.sizeof(module.DeviceDescriptor), 18)
            for identities in [[target, target], [other, target, target], []]:
                with self.subTest(helper=name, identities=identities):
                    usb = module.USB.__new__(module.USB)
                    usb.context, usb.lib = C.c_void_p(), Library(module, identities)
                    with self.assertRaises(RuntimeError):
                        usb.open_unique_device(*target)
                    self.assertEqual(usb.lib.opened, [])
                    self.assertTrue(usb.lib.freed)

    def test_open_uses_the_unique_enumerated_device_and_frees_its_list(self):
        for name in ['irda_usb_helper', 'kingsun_bridge']:
            module = load(name)
            usb = module.USB.__new__(module.USB)
            usb.context, usb.lib = C.c_void_p(), Library(module, [(0x066f, 0x4200), (0x07d0, 0x4959)])
            self.assertEqual(usb.open_unique_device(0x07d0, 0x4959).value, 102)
            self.assertEqual(usb.lib.opened, [2])
            self.assertTrue(usb.lib.freed)
            usb.lib = Library(module, [(0x07d0, 0x4959)], descriptor_error=True)
            with self.assertRaises(RuntimeError):
                usb.open_unique_device(0x07d0, 0x4959)
            self.assertEqual(usb.lib.opened, [])
            self.assertTrue(usb.lib.freed)
