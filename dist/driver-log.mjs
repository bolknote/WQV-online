// The visible journal is concise; the original event objects go to the report.
export function driverLogMessage(entry) {
  switch (entry.kind) {
    case 'device-selected': return { key: 'Adapter selected: {0}', values: [entry.name || entry.usbId] };
    case 'check-started': return { key: entry.transport === 'helper' ? 'Checking through USB Helper.' : 'Checking without helper.', values: [] };
    case 'module-loaded': return { key: 'Driver loaded.', values: [] };
    case 'usb-opening': return { key: 'Opening USB…', values: [] };
    case 'driver-opened': return { key: 'Driver initialized.', values: [] };
    case 'check-passed': return { key: 'USB initialization passed', values: [] };
    case 'check-failed': return { key: entry.code === 'helper-needed' ? 'Blocked by WebUSB' : entry.code === 'helper-unavailable' ? 'USB Helper unavailable' : 'USB check failed', values: [] };
    case 'usb-released': return { key: 'USB released.', values: [] };
    case 'check-cleanup-failed': return { key: 'Could not release USB: {0}', values: [entry.message] };
    case 'driver-built': return { key: 'Driver installed: {0}', values: [entry.filename] };
    case 'build-cancelled': return { key: 'Build cancelled. The source is still saved.', values: [] };
    case 'build-error': return { key: 'Build failed: {0}', values: [entry.message] };
    case 'error': return { key: 'Operation failed: {0}', values: [entry.message] };
    default: return null;
  }
}
