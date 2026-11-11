export function preparePack(pack, record) {
  pack.source = record.source;
  for (const [path, text] of Object.entries(record.files)) {
    const includes = [...record.source.matchAll(/#\s*include\s*["<]([^">]+)[">]/g)].map(match => match[1]);
    const target = includes.find(include => include === path || include.endsWith('/' + path)) || path;
    pack.localFiles[target] = text;
    pack.localFiles['include/' + target] = text;
  }
  pack.entry = 'extern unsigned host_descriptor(unsigned field);\n' + pack.entry;
  pack.entry = pack.entry.replace(/lab_device\.descriptor\.idVendor=[^;]+;/g, 'lab_device.descriptor.idVendor=host_descriptor(0);')
    .replace(/lab_device\.descriptor\.idProduct=[^;]+;/g, 'lab_device.descriptor.idProduct=host_descriptor(1);');
  if (pack.name === 'sigmatel' || pack.name === 'ks959') {
    pack.entry = pack.entry.replace('&dongles[0]', '&dongles[host_descriptor(13)]');
  } else if (!['ark3116', 'ir-usb', 'pl2303', 'ma620'].includes(pack.name)) {
    pack.entry = pack.entry.replace('&lab_usb_driver->id_table[0]', '&lab_usb_driver->id_table[host_descriptor(13)]')
      .replace('lab_endpoints[0].desc.bEndpointAddress=0x81;lab_endpoints[1].desc.bEndpointAddress=2;',
        'lab_endpoints[0].desc.bEndpointAddress=host_descriptor(4);lab_endpoints[1].desc.bEndpointAddress=host_descriptor(5);')
      .replace('lab_endpoints[0].desc.wMaxPacketSize=LAB_PACKET_SIZE;lab_endpoints[1].desc.wMaxPacketSize=LAB_PACKET_SIZE;',
        'lab_endpoints[0].desc.wMaxPacketSize=host_descriptor(7);lab_endpoints[1].desc.wMaxPacketSize=host_descriptor(8);');
  } else {
    pack.entry = pack.entry.replace('lab_port.bulk_out_endpointAddress=2;', 'lab_port.bulk_out_endpointAddress=host_descriptor(5);')
      .replace('usb_rcvbulkpipe(&lab_device,1)', 'usb_rcvbulkpipe(&lab_device,host_descriptor(4))')
      .replace('usb_sndbulkpipe(&lab_device,2)', 'usb_sndbulkpipe(&lab_device,host_descriptor(5))')
      .replace('usb_rcvintpipe(&lab_device,3)', 'usb_rcvintpipe(&lab_device,host_descriptor(6))');
    pack.entry = pack.entry.replace('lab_endpoints[0].desc.bEndpointAddress=0x81;', 'lab_endpoints[0].desc.bEndpointAddress=host_descriptor(4);')
      .replace('lab_endpoints[1].desc.bEndpointAddress=2;', 'lab_endpoints[1].desc.bEndpointAddress=host_descriptor(5);')
      .replace('lab_endpoints[2].desc.bEndpointAddress=0x83;', 'lab_endpoints[2].desc.bEndpointAddress=host_descriptor(6);');
  }
  if (pack.entry.includes('lab_alternate')) pack.entry = pack.entry.replace('lab_interface.usbdev=&lab_device;',
    'lab_alternate.desc.bInterfaceNumber=host_descriptor(2);lab_alternate.desc.bAlternateSetting=host_descriptor(3);lab_interface.usbdev=&lab_device;');
  const table = ['sigmatel', 'ks959'].includes(pack.name) ? 'dongles' : ['ark3116','pl2303'].includes(pack.name) ? 'id_table' : pack.name === 'ma620' ? 'lab_ir_ids' : pack.name === 'ir-usb' ? 'ir_id_table' : 'lab_usb_driver->id_table';
  pack.entry += '\nunsigned wqv_id_count(void){const struct usb_device_id *ids=' + table + ';unsigned i=0;while(i<64&&(ids[i].idVendor||ids[i].idProduct||ids[i].bInterfaceClass))i++;return i;}\n' +
    'unsigned wqv_id_field(unsigned index,unsigned field){const struct usb_device_id *ids=' + table + ';if(index>=wqv_id_count())return 0;switch(field){case 0:return ids[index].idVendor;case 1:return ids[index].idProduct;case 2:return ids[index].bInterfaceClass;case 3:return ids[index].bInterfaceSubClass;case 4:return ids[index].bInterfaceProtocol;case 5:return ids[index].match_flags;}return 0;}\n';
  pack.exports += ',wqv_id_count,wqv_id_field';
  return pack;
}
