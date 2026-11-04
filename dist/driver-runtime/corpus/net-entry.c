static struct usb_device lab_device;
static struct usb_interface lab_interface;
static struct usb_host_interface lab_alternate;
static struct usb_host_endpoint lab_endpoints[2];
static unsigned lab_baud=9600;
int lab_open(void) {
    int result;
    if(lab_netdev)return -EBUSY;
    lab_baud=9600;
    memset(&lab_device,0,sizeof(lab_device));memset(&lab_interface,0,sizeof(lab_interface));
    memset(&lab_alternate,0,sizeof(lab_alternate));memset(lab_endpoints,0,sizeof(lab_endpoints));
    lab_device.devnum=1;lab_device.descriptor.idVendor=lab_usb_driver->id_table[0].idVendor;
    lab_device.descriptor.idProduct=lab_usb_driver->id_table[0].idProduct;
    lab_interface.usbdev=&lab_device;lab_interface.cur_altsetting=&lab_alternate;
    lab_interface.altsetting=&lab_alternate;lab_interface.num_altsetting=1;
    lab_alternate.desc.bNumEndpoints=2;lab_alternate.endpoint=lab_endpoints;
    lab_endpoints[0].desc.bEndpointAddress=0x81;lab_endpoints[1].desc.bEndpointAddress=2;
    lab_endpoints[0].desc.bmAttributes=LAB_ENDPOINT_TYPE;lab_endpoints[1].desc.bmAttributes=LAB_ENDPOINT_TYPE;
    lab_endpoints[0].desc.wMaxPacketSize=LAB_PACKET_SIZE;lab_endpoints[1].desc.wMaxPacketSize=LAB_PACKET_SIZE;
    result=lab_usb_driver->probe(&lab_interface,&lab_usb_driver->id_table[0]);
    if(result<0){lab_netdev=NULL;return result;}
    if(!lab_netdev)return -ENODEV;
    lab_netdev->running=1;
    result=lab_netdev->netdev_ops->ndo_open(lab_netdev);
    if(result<0){lab_netdev->running=0;lab_usb_driver->disconnect(&lab_interface);lab_netdev=NULL;}
    return result;
}
void lab_close(void) {if(lab_netdev){lab_usb_driver->disconnect(&lab_interface);lab_netdev=NULL;}}
int lab_speed(unsigned baud) {
    struct if_irda_req request;int result;
    if(!lab_netdev)return -ENODEV;
    request.ifr_baudrate=baud;
    result=lab_netdev->netdev_ops->ndo_do_ioctl(lab_netdev,(struct ifreq*)&request,SIOCSBANDWIDTH);
    if(result>=0)lab_baud=baud;return result;
}
unsigned lab_alloc(unsigned length) {return (unsigned)malloc(length);}
void lab_free(unsigned pointer) {free((void*)pointer);}
int lab_send_speed(unsigned pointer,unsigned length,unsigned next_speed) {
    struct sk_buff *s;
    if(!lab_netdev||!lab_netdev->queue)return -EBUSY;
    s=dev_alloc_skb(length);if(!s)return -ENOMEM;
    memcpy(s->data,(void*)pointer,length);s->len=length;s->next_speed=next_speed;
    lab_baud=next_speed;
    return lab_netdev->netdev_ops->ndo_start_xmit(s,lab_netdev);
}
int lab_send(unsigned pointer,unsigned length) {return lab_send_speed(pointer,length,lab_baud);}
unsigned lab_urb_info(unsigned pointer,unsigned field) {
    struct urb *u=(struct urb*)pointer;
    switch(field){case 0:return (unsigned)u->setup_packet;case 1:return (unsigned)u->transfer_buffer;
    case 2:return u->transfer_buffer_length;case 3:return u->active;case 4:return u->generation;
    case 5:return u->pipe;case 6:return u->transfer_flags;}return 0;
}
int lab_complete(unsigned pointer,unsigned generation,int status,unsigned length) {
    struct urb *u=(struct urb*)pointer;
    if(!u->active||u->generation!=generation)return 0;
    if(length>u->transfer_buffer_length)return -EINVAL;
    u->active=0;u->status=status;u->actual_length=length;u->complete(u);usb_free_urb(u);return 1;
}
unsigned lab_state(unsigned field) {
    if(!lab_netdev)return 0;
    switch(field){case 0:return 1;case 1:return lab_netdev->queue;case 2:return 0;
    case 4:return lab_netdev->stats.tx_packets;case 5:return lab_netdev->stats.tx_errors;case 6:return lab_baud;
    case 7:return lab_netdev->stats.rx_errors;case 8:return lab_netdev->stats.rx_crc_errors;}return 0;
}
void lab_dispatch_work(unsigned pointer) {struct work_struct *w=(struct work_struct*)pointer;w->pending=0;w->function(w);}
void lab_dispatch_timer(unsigned pointer) {struct timer_list *t=(struct timer_list*)pointer;t->function(t);}
