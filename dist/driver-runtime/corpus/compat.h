#ifndef LAB_CORPUS_COMPAT_H
#define LAB_CORPUS_COMPAT_H
extern void host_sleep(unsigned milliseconds);
#include <stddef.h>
typedef uint8_t u8;
typedef uint16_t u16;
typedef int16_t __s16;
typedef int32_t __s32;
typedef int32_t s32;
typedef int16_t s16;
#define URB_ZERO_PACKET 0x40
#define ENOENT 2
#define EINPROGRESS 115
#define ECONNRESET 104
#define EILSEQ 84
#define ETIME 62
#define ENOSPC 28
#define EFAULT 14
#define jiffies (host_milliseconds())
static unsigned char *skb_pull(struct sk_buff *s,unsigned n) {if(n>s->len)return NULL;s->data+=n;s->len-=n;return s->data;}
static void *kcalloc(unsigned n,unsigned size,gfp_t flags) {return calloc(n,size);}
struct firmware {unsigned size;const unsigned char *data;};
/* No firmware blob has been supplied in these simulation fixtures. */
static int request_firmware(const struct firmware **fw,const char *name,struct device *d) {return -ENOENT;}
static void release_firmware(const struct firmware *fw) {(void)fw;}
static unsigned long simple_strtoul(const char *s,char **end,unsigned base) {return strtoul(s,end,base);}
extern int host_set_interface(unsigned number,unsigned alternate);
static int usb_set_interface(struct usb_device *d,unsigned number,unsigned alternate) {return host_set_interface(number,alternate);}
struct irda_skb_cb {unsigned magic;int next_speed,next_xbofs;unsigned mtt,xbofs;void *context;};
static int irda_get_next_xbofs(struct sk_buff *s) {return -1;}
static void mdelay(unsigned ms) {host_sleep(ms);}
static void dev_kfree_skb_any(struct sk_buff *s) {dev_kfree_skb(s);}
static int usb_unlink_urb(struct urb *u) {usb_kill_urb(u);return 0;}
#define EIO 5
#define likely(v) (v)
#define USB_DEVICE_ID_MATCH_INT_CLASS 0x80
#define USB_DEVICE_ID_MATCH_INT_SUBCLASS 0x100
#define USB_CLASS_APP_SPEC 0xfe
#define USB_ENDPOINT_NUMBER_MASK 15
#define USB_ENDPOINT_DIR_MASK 128
#define USB_SUBCLASS_IRDA 2
#define USB_INTERFACE_INFO(cl,sub,pro) .match_flags=0x380,.bInterfaceClass=(cl),.bInterfaceSubClass=(sub),.bInterfaceProtocol=(pro)
#define IRDA_ASSERT(condition,action) do{if(!(condition)){action}}while(0)
#define ENOENT 2
#define net_warn_ratelimited(...)
#define net_err_ratelimited(...)
#define net_info_ratelimited(...)
#define spin_lock_irqsave(lock,flags) do{flags=0;spin_lock(lock);}while(0)
#define spin_unlock_irqrestore(lock,flags) spin_unlock(lock)
#define container_of(ptr,type,member) ((type*)((char*)(ptr)-offsetof(type,member)))
#define msecs_to_jiffies(ms) (ms)
#define GOOD_FCS 0xf0b8
static void *kzalloc(unsigned n,gfp_t flags) {return calloc(1,n);}
static void skb_copy_from_linear_data(const struct sk_buff *s,void *p,unsigned n) {memcpy(p,s->data,n);}
static unsigned irda_calc_crc16(unsigned crc,const unsigned char *p,unsigned n) {
    unsigned i,j;for(i=0;i<n;i++){crc^=p[i];for(j=0;j<8;j++)crc=(crc>>1)^((crc&1)?0x8408:0);}return crc&0xffff;
}
struct work_struct {void (*function)(struct work_struct*);unsigned pending;};
extern int host_work(unsigned pointer);
extern void host_cancel_work(unsigned pointer);
extern void host_packet(unsigned pointer,unsigned length);
static void INIT_WORK(struct work_struct *work,void (*f)(struct work_struct*)) {work->function=f;work->pending=0;}
static int schedule_work(struct work_struct *work) {if(work->pending)return 0;work->pending=1;return host_work((unsigned)work);}
static void cancel_work_sync(struct work_struct *work) {host_cancel_work((unsigned)work);work->pending=0;}
static void netif_rx(struct sk_buff *s) {host_packet((unsigned)s->data,s->len);dev_kfree_skb(s);}
struct timer_list {void (*function)(struct timer_list*);unsigned long expires;};
extern int host_timer(unsigned pointer,unsigned milliseconds);
extern int host_cancel_timer(unsigned pointer);
#define from_timer(variable,callback,member) container_of(callback,struct irda_usb_cb,member)
static void timer_setup(struct timer_list *t,void (*f)(struct timer_list*),unsigned flags) {t->function=f;t->expires=0;}
static int mod_timer(struct timer_list *t,unsigned expires) {t->expires=expires;return host_timer((unsigned)t,expires-host_milliseconds());}
static int del_timer(struct timer_list *t) {return host_cancel_timer((unsigned)t);}
/* Additional Linux USB services shared by the downloaded driver corpus. */
#undef module_usb_driver
#define module_usb_driver(d) static struct usb_driver *lab_usb_driver=&(d)
#define MODULE_VERSION(...)
#define dev_dbg(...)
#define dev_warn(...)
#define MODULE_PARM_DESC(...)
#define module_param(...)
#define USB_ENDPOINT_XFER_INT 3
#define USB_ENDPOINT_XFER_BULK 2
#define IR_115200 32
#define IR_576000 64
#define IR_1152000 128
#define IR_4000000 256
#define GFP_DMA 0
#define ARRAY_SIZE(a) (sizeof(a)/sizeof((a)[0]))
#define le32_to_cpu(v) ((uint32_t)(v))
static unsigned usb_sndintpipe(struct usb_device *d,unsigned ep) { return 0x200|(ep&15); }
static unsigned usb_rcvintpipe(struct usb_device *d,unsigned ep) { return 0x280|(ep&15); }
static int usb_pipeout(unsigned pipe) { return !(pipe&0x80); }
static int usb_endpoint_is_int_in(struct usb_endpoint_descriptor *e) { return (e->bmAttributes&3)==3&&(e->bEndpointAddress&128); }
static int usb_endpoint_is_int_out(struct usb_endpoint_descriptor *e) { return (e->bmAttributes&3)==3&&!(e->bEndpointAddress&128); }
static int usb_endpoint_is_bulk_in(struct usb_endpoint_descriptor *e) { return (e->bmAttributes&3)==2&&(e->bEndpointAddress&128); }
static int usb_endpoint_is_bulk_out(struct usb_endpoint_descriptor *e) { return (e->bmAttributes&3)==2&&!(e->bEndpointAddress&128); }
static unsigned usb_endpoint_maxp(struct usb_endpoint_descriptor *e) { return e->wMaxPacketSize; }
static unsigned usb_maxpacket(struct usb_device *d,unsigned pipe,int output) { return 8; }
static void usb_fill_int_urb(struct urb *u,struct usb_device *d,unsigned pipe,void *data,int length,
        void (*callback)(struct urb*),void *context,int interval) {
    u->dev=d;u->pipe=pipe;u->setup_packet=NULL;u->transfer_buffer=data;u->transfer_buffer_length=length;
    u->complete=callback;u->context=context;u->interval=interval;
}
/* Capture registration for generic network-driver entry points. */
static struct net_device *lab_netdev;
static int corpus_register_netdev(struct net_device *d) { lab_netdev=d;return 0; }
#define register_netdev corpus_register_netdev
#endif
