static struct sir_dev lab_sir;
static unsigned lab_dongle_opened;
/* MA600 is not a USB driver. Its USB match is the MA620 entry from
 * pl2303.h; other PL2303 serial devices must never get dongle commands. */
static const struct usb_device_id lab_ir_ids[]={
    {USB_DEVICE(MA620_VENDOR_ID,MA620_PRODUCT_ID)},{}
};
static int sirdev_set_dtr_rts(struct sir_dev *dev,int dtr,int rts) {
    unsigned set=(dtr?TIOCM_DTR:0)|(rts?TIOCM_RTS:0);
    return lab_serial.type->tiocmset(&lab_tty,set,(TIOCM_DTR|TIOCM_RTS)&~set);
}
static int sirdev_raw_write(struct sir_dev *dev,const unsigned char *bytes,unsigned length) {
    int written=0,result;
    if(lab_serial_usb_error)return lab_serial_usb_error;
    result=usb_bulk_msg(&lab_device,lab_port.write_urb->pipe,(void*)bytes,length,&written,1000);
    if(result<0)lab_serial_usb_error=result;else if(written!=(int)length)lab_serial_usb_error=-EIO;
    return result<0?result:written;
}
static int sirdev_raw_read(struct sir_dev *dev,unsigned char *bytes,unsigned length) {
    unsigned i;
    /* RX URBs continue during the original driver's 15ms echo wait. */
    for(i=0;i<100&&lab_dongle_rx_length<length&&!lab_serial_usb_error;i++)msleep(2);
    if(lab_serial_usb_error||lab_dongle_rx_overflow||lab_dongle_rx_length!=length){memset(bytes,255,length);return -EIO;}
    for(i=0;i<length;i++)bytes[i]=lab_dongle_rx[i];lab_dongle_rx_length=0;return length;
}
static int lab_uart_speed(unsigned speed) {
    struct ktermios old=lab_tty.termios;
    tty_encode_baud_rate(&lab_tty,speed,speed);
    lab_serial.type->set_termios(&lab_tty,&lab_port,&old);
    return lab_serial_usb_error?lab_serial_usb_error:tty_get_baud_rate(&lab_tty)==speed?0:-EIO;
}
static int lab_ma620_open(void) {
    int result;
    if(lab_device.descriptor.idVendor!=MA620_VENDOR_ID||lab_device.descriptor.idProduct!=MA620_PRODUCT_ID)return -ENODEV;
    ma600_sir_init();memset(&lab_sir,0,sizeof(lab_sir));irda_init_max_qos_capabilies(&lab_sir.qos);
    /* MA600 documents clearing both lines before power-on. */
    result=sirdev_set_dtr_rts(&lab_sir,FALSE,FALSE);if(result<0)return result;msleep(1000);
    result=lab_dongle->open(&lab_sir);if(result<0)return result;lab_dongle_opened=1;msleep(1000);
    return lab_ma620_speed(9600);
}
static int lab_ma620_speed(unsigned speed) {
    int result;
    if(speed!=2400&&speed!=9600&&speed!=19200&&speed!=38400&&speed!=57600&&speed!=115200)return -EINVAL;
    if(lab_sir.speed==speed)return 0;
    lab_serial_usb_error=0;
    lab_dongle_command_mode=1;lab_dongle_rx_length=0;lab_dongle_rx_overflow=0;
    result=lab_uart_speed(9600);
    if(!result)result=lab_dongle->reset(&lab_sir);
    if(!result)result=lab_dongle->set_speed(&lab_sir,speed);
    if(!result)result=lab_uart_speed(speed);
    if(lab_serial_usb_error)result=lab_serial_usb_error;
    if(result)lab_sir.speed=0;
    lab_dongle_command_mode=0;lab_dongle_rx_length=0;
    return result;
}
static void lab_ma620_close(void) {
    if(lab_dongle_opened){lab_dongle->close(&lab_sir);lab_dongle_opened=0;}
    ma600_sir_cleanup();lab_dongle_command_mode=0;lab_sir.speed=0;
}
