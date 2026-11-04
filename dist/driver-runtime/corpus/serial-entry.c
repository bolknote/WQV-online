static struct usb_device lab_device;
static struct usb_interface lab_interface;
static struct usb_host_interface lab_alternate;
static struct usb_serial lab_serial;
static struct usb_serial_port lab_port;
static struct tty_struct lab_tty;
static unsigned lab_active,lab_attached,lab_probed;
int lab_open(void) {
    struct usb_serial_driver *driver;int result;
    if(lab_active)return -EBUSY;
#if LAB_SERIAL_MODULE_INIT
    lab_module_init();
#else
    lab_serial_autoreg();
#endif
    driver=lab_serial_drivers[0];
    memset(&lab_serial,0,sizeof(lab_serial));memset(&lab_port,0,sizeof(lab_port));
    memset(&lab_device,0,sizeof(lab_device));memset(&lab_interface,0,sizeof(lab_interface));memset(&lab_tty,0,sizeof(lab_tty));
    lab_device.descriptor.idVendor=driver->id_table[LAB_SERIAL_ID_INDEX].idVendor;
    lab_device.descriptor.idProduct=driver->id_table[LAB_SERIAL_ID_INDEX].idProduct;
    lab_interface.usbdev=&lab_device;lab_interface.cur_altsetting=&lab_alternate;lab_interface.altsetting=&lab_alternate;
    lab_serial.dev=&lab_device;lab_serial.interface=&lab_interface;lab_serial.type=driver;lab_serial.port[0]=&lab_port;
    lab_port.serial=&lab_serial;lab_port.bulk_out_endpointAddress=2;lab_port.bulk_out_size=4096;lab_port.write_urbs_free=1;lab_tty.driver_data=&lab_port;
    lab_tty.termios.c_cflag=B9600|CS8|CREAD|CLOCAL;tty_encode_baud_rate(&lab_tty,9600,9600);
    if(driver->init_termios)driver->init_termios(&lab_tty);
    lab_port.read_urb=usb_alloc_urb(0,GFP_KERNEL);lab_port.write_urbs[0]=usb_alloc_urb(0,GFP_KERNEL);
    usb_fill_bulk_urb(lab_port.read_urb,&lab_device,usb_rcvbulkpipe(&lab_device,1),malloc(4096),4096,lab_serial_read_callback,&lab_port);
    usb_fill_bulk_urb(lab_port.write_urbs[0],&lab_device,usb_sndbulkpipe(&lab_device,2),malloc(4096),4096,
        driver->write_bulk_callback?driver->write_bulk_callback:lab_serial_write_callback,&lab_port);
    if(driver->read_int_callback){lab_port.interrupt_in_urb=usb_alloc_urb(0,GFP_KERNEL);
        usb_fill_int_urb(lab_port.interrupt_in_urb,&lab_device,usb_rcvintpipe(&lab_device,3),malloc(8),8,driver->read_int_callback,&lab_port,1);}
    lab_active=1;lab_attached=0;lab_probed=0;
    if(driver->attach){result=driver->attach(&lab_serial);if(result<0)return result;lab_attached=1;}
    if(driver->port_probe){result=driver->port_probe(&lab_port);if(result<0)return result;lab_probed=1;}
    return driver->open?driver->open(&lab_tty,&lab_port):usb_serial_generic_open(&lab_tty,&lab_port);
}
void lab_close(void) {
    struct usb_serial_driver *driver;
    if(!lab_active)return;
    driver=lab_serial.type;
    if(lab_port.opened){if(driver->close)driver->close(&lab_port);else usb_serial_generic_close(&lab_port);}
    if(lab_probed&&driver->port_remove)driver->port_remove(&lab_port);
    if(lab_port.interrupt_in_urb){usb_kill_urb(lab_port.interrupt_in_urb);free(lab_port.interrupt_in_urb->transfer_buffer);usb_free_urb(lab_port.interrupt_in_urb);}
    free(lab_port.read_urb->transfer_buffer);usb_free_urb(lab_port.read_urb);
    free(lab_port.write_urbs[0]->transfer_buffer);usb_free_urb(lab_port.write_urbs[0]);
    lab_active=0;
#if LAB_SERIAL_MODULE_INIT
    lab_module_exit();
#endif
}
int lab_speed(unsigned speed) {
    struct ktermios old;
    if(!lab_port.opened)return -ENODEV;
    old=lab_tty.termios;tty_encode_baud_rate(&lab_tty,speed,speed);
    lab_serial.type->set_termios(&lab_tty,&lab_port,&old);return 0;
}
int lab_send(unsigned pointer,unsigned length) {
    struct urb *u;unsigned size;int result;
    if(!lab_port.opened)return -ENODEV;
    if(!lab_port.tx_ready)return -EBUSY;
    if(!length||length>2048)return -EINVAL;
    if(lab_serial.type->write){
        lab_port.tx_ready=0;
        result=lab_serial.type->write(&lab_tty,&lab_port,(void*)pointer,length);
        if(result!=(int)length){lab_port.tx_ready=1;return result<0?result:-EIO;}
        lab_port.tx_count++;return 0;
    }
    u=lab_port.write_urbs[0];
    lab_port.write_fifo.data=(void*)pointer;lab_port.write_fifo.length=length;lab_port.write_fifo.position=0;
    if(lab_serial.type->prepare_write_buffer)size=lab_serial.type->prepare_write_buffer(&lab_port,u->transfer_buffer,4096);
    else{memcpy(u->transfer_buffer,(void*)pointer,length);size=length;}
    u->transfer_buffer_length=size;lab_port.tx_ready=0;
    result=usb_submit_urb(u,GFP_KERNEL);if(result<0)lab_port.tx_ready=1;else lab_port.tx_count++;
    return result;
}
unsigned lab_alloc(unsigned length) {return (unsigned)malloc(length);}
void lab_free(unsigned pointer) {free((void*)pointer);}
unsigned lab_urb_info(unsigned pointer,unsigned field) {
    struct urb *u=(struct urb*)pointer;
    switch(field){case 0:return (unsigned)u->setup_packet;case 1:return (unsigned)u->transfer_buffer;
    case 2:return u->transfer_buffer_length;case 3:return u->active;case 4:return u->generation;case 5:return u->pipe;case 6:return u->transfer_flags;}return 0;
}
int lab_complete(unsigned pointer,unsigned generation,int status,unsigned length) {
    struct urb *u=(struct urb*)pointer;
    if(!u->active||u->generation!=generation)return 0;
    if(length>u->transfer_buffer_length)return -EINVAL;
    u->active=0;u->status=status;u->actual_length=length;u->complete(u);usb_free_urb(u);return 1;
}
unsigned lab_state(unsigned field) {
    switch(field){case 0:return lab_active;case 1:return lab_port.tx_ready;
    case 4:return lab_port.tx_count;case 6:return tty_get_baud_rate(&lab_tty);
    case 7:return lab_port.opened;case 8:return lab_port.icount.parity;case 9:return lab_port.icount.frame;
    case 10:return lab_port.icount.cts;case 11:return lab_port.port.delta_msr_wait;}return 0;
}
