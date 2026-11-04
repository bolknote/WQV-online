/* Exports around the unmodified Linux driver. The actual TX loop stays in C. */
static struct usb_device lab_device;
static struct usb_interface lab_interface;
static struct stir_cb *lab_context;
int lab_parameters(unsigned sensitivity) {
    if(lab_context)return -EBUSY;
    if(sensitivity>6)return -EINVAL;
    rx_sensitivity=sensitivity;return 0;
}
int lab_open(void) {
    int result;
    if(lab_context)return -EBUSY;
    memset(&lab_device,0,sizeof(lab_device));memset(&lab_interface,0,sizeof(lab_interface));
    lab_device.devnum=2;lab_device.descriptor.idVendor=0x066f;lab_device.descriptor.idProduct=0x4200;
    lab_interface.usbdev=&lab_device;
    result=irda_driver.probe(&lab_interface,&dongles[0]);if(result<0)return result;
    lab_context=usb_get_intfdata(&lab_interface);
    lab_context->netdev->running=1;
    result=lab_context->netdev->netdev_ops->ndo_open(lab_context->netdev);
    if(result<0){lab_context->netdev->running=0;irda_driver.disconnect(&lab_interface);lab_context=NULL;}
    return result;
}
int lab_thread(void) {
    struct task_struct *t=lab_context?lab_context->thread:NULL;
    if(!t)return -ENODEV;
    return t->function(t->argument);
}
void lab_close(void) { if(lab_context){irda_driver.disconnect(&lab_interface);lab_context=NULL;} }
unsigned lab_alloc(unsigned n) { return (unsigned)malloc(n); }
void lab_free(unsigned p) { free((void*)p); }
int lab_send(unsigned pointer,unsigned length) {
    struct sk_buff *s;
    if(!lab_context)return -ENODEV;
    if(!lab_context->netdev->queue)return -EBUSY;
    if(!length||length>STIR_FIFO_SIZE-4)return -EINVAL;
    s=dev_alloc_skb(length);if(!s)return -ENOMEM;
    memcpy(s->data,(void*)pointer,length);s->len=length;s->mtt=10000;
    return lab_context->netdev->netdev_ops->ndo_start_xmit(s,lab_context->netdev);
}
int lab_speed(unsigned speed) {
    struct sk_buff *s;
    if(!lab_context)return -ENODEV;
    if(speed!=9600&&speed!=19200&&speed!=38400&&speed!=57600&&speed!=115200)return -EINVAL;
    if(!lab_context->netdev->queue)return -EBUSY;
    s=dev_alloc_skb(1);if(!s)return -ENOMEM;
    s->len=0;s->next_speed=speed;
    return lab_context->netdev->netdev_ops->ndo_start_xmit(s,lab_context->netdev);
}
unsigned lab_urb_info(unsigned pointer,unsigned field) {
    struct urb *u=(struct urb*)pointer;
    switch(field){
    case 0:return (unsigned)u->setup_packet;
    case 1:return (unsigned)u->transfer_buffer;
    case 2:return u->transfer_buffer_length;
    case 3:return u->active;
    case 4:return u->generation;
    case 5:return u->pipe;
    }return 0;
}
int lab_complete(unsigned pointer,unsigned generation,int status,unsigned length) {
    struct urb *u=(struct urb*)pointer;
    if(!u->active||u->generation!=generation)return 0;
    if(length>u->transfer_buffer_length)return -EINVAL;
    u->active=0;u->status=status;u->actual_length=length;u->complete(u);usb_free_urb(u);return 1;
}
unsigned lab_state(unsigned field) {
    if(!lab_context)return 0;
    switch(field){
    case 0:return 1;
    case 1:return lab_context->netdev->queue;
    case 2:return lab_context->tx_pending!=NULL;
    case 3:return lab_context->receiving;
    case 4:return lab_context->netdev->stats.tx_packets;
    case 5:return lab_context->netdev->stats.tx_errors;
    case 6:return lab_context->speed;
    }return 0;
}
