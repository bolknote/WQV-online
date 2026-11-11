#ifndef LAB_LINUX_COMPAT_H
#define LAB_LINUX_COMPAT_H
/* Research compatibility environment, not a Linux kernel implementation.
 * The original ks959-sir.c is included unmodified after this header.
 * This adapter exposes already-framed SIR bytes; framing stays in the host.
 */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

typedef uint8_t __u8;
typedef uint16_t __u16;
typedef uint32_t __u32;
typedef uint32_t u32;
typedef uint16_t __le16;
typedef uint32_t __le32;
typedef int spinlock_t;
typedef int netdev_tx_t;
typedef int pm_message_t;
typedef unsigned gfp_t;
#define __packed __attribute__((packed))
#define TRUE 1
#define FALSE 0
#define NULL ((void *)0)
#define ENOMEM 12
#define EOPNOTSUPP 95
#define ENODEV 19
#define EPIPE 32
#define EPERM 1
#define EBUSY 16
#define EINVAL 22
#define GFP_KERNEL 0
#define GFP_ATOMIC 0
#define CAP_NET_ADMIN 12
#define NETDEV_TX_OK 0
#define OUTSIDE_FRAME 0
#define IRDA_SKB_MAX_MTU 4096
#define IR_2400 1
#define IR_9600 2
#define IR_19200 4
#define IR_38400 8
#define IR_57600 16
#define SIOCSBANDWIDTH 1
#define SIOCSMEDIABUSY 2
#define SIOCGRECEIVING 3
#define USB_DIR_IN 0x80
#define USB_DIR_OUT 0
#define USB_TYPE_CLASS 0x20
#define USB_RECIP_INTERFACE 1
#define KERN_INFO ""
#define MODULE_DEVICE_TABLE(...)
#define MODULE_AUTHOR(...)
#define MODULE_DESCRIPTION(...)
#define MODULE_LICENSE(...)
#define module_usb_driver(...)
#define SET_NETDEV_DEV(...)
#define SKB_LINEAR_ASSERT(...)
#define dev_err(...)
#define dev_info(...)
#define printk(...)
#define cpu_to_le16(value) ((uint16_t)(value))
#define cpu_to_le32(value) ((uint32_t)(value))
#define le16_to_cpu(value) ((uint16_t)(value))
#define USB_DEVICE(vid,pid) .idVendor=(vid),.idProduct=(pid)

struct device { int unused; };
struct usb_device_id { uint16_t idVendor, idProduct; unsigned long driver_info;
    unsigned match_flags, bInterfaceClass, bInterfaceSubClass, bInterfaceProtocol; };
struct usb_endpoint_descriptor { unsigned char bEndpointAddress, bmAttributes, bInterval; uint16_t wMaxPacketSize; };
struct usb_host_endpoint { struct usb_endpoint_descriptor desc; };
struct usb_host_interface {
    struct { unsigned char bNumEndpoints,bInterfaceNumber,bAlternateSetting,bInterfaceClass,bInterfaceSubClass; } desc;
    struct usb_host_endpoint *endpoint; unsigned char *extra; unsigned extralen;
};
struct usb_interface;
struct usb_host_config { struct { unsigned char bConfigurationValue; } desc; struct usb_interface *interface[1]; };
struct usb_device {
    struct device dev;
    unsigned devnum;
    struct { uint16_t idVendor, idProduct, bcdDevice; unsigned char bNumConfigurations,bDeviceClass,bMaxPacketSize0; } descriptor;
    struct usb_host_config *actconfig;
};
struct usb_interface { struct device dev; struct usb_device *usbdev; void *data;
    struct usb_host_interface *cur_altsetting,*altsetting; unsigned num_altsetting; };
struct usb_ctrlrequest { uint8_t bRequestType, bRequest; uint16_t wValue, wIndex, wLength; } __packed;
struct urb {
    struct usb_device *dev;
    unsigned pipe;
    void *context, *transfer_buffer;
    unsigned transfer_buffer_length, actual_length;
    int status;
    unsigned char *setup_packet;
    void (*complete)(struct urb *);
    unsigned generation, active, transfer_flags, interval, references;
};
struct sk_buff { unsigned char *data, *allocation; unsigned len; int next_speed; unsigned mtt; void *dev; unsigned protocol; unsigned char cb[48]; };
struct net_device;
struct ifreq { int unused; };
struct if_irda_req { int ifr_baudrate, ifr_receiving; };
struct net_device_ops {
    netdev_tx_t (*ndo_start_xmit)(struct sk_buff *, struct net_device *);
    int (*ndo_open)(struct net_device *);
    int (*ndo_stop)(struct net_device *);
    int (*ndo_do_ioctl)(struct net_device *, struct ifreq *, int);
    void (*ndo_tx_timeout)(struct net_device *);
};
struct net_device {
    struct device dev;
    const struct net_device_ops *netdev_ops;
    struct { unsigned tx_errors, tx_packets, tx_bytes, rx_errors, rx_length_errors,
        rx_crc_errors, rx_dropped, rx_packets, rx_bytes, rx_over_errors,
        rx_frame_errors, collisions; } stats;
    void *private;
    char name[16];
    int running, present, queue; unsigned watchdog_timeo;
};
struct irlap_cb { int unused; };
struct qos_info { struct { unsigned bits,value; } baud_rate, min_turn_time, data_size,
    window_size, additional_bofs, link_disc_time; };
typedef struct { int in_frame, state, truesize; struct sk_buff *skb; unsigned char *head, *data; unsigned len; } iobuff_t;
struct timeval { long tv_sec, tv_usec; };
struct usb_driver {
    const char *name;
    int (*probe)(struct usb_interface *, const struct usb_device_id *);
    void (*disconnect)(struct usb_interface *);
    const struct usb_device_id *id_table;
    int (*suspend)(struct usb_interface *, pm_message_t);
    int (*resume)(struct usb_interface *);
};

/* Host imports. Submission must return before a completion callback runs. */
extern int host_submit(unsigned urb, unsigned generation);
extern void host_cancel(unsigned urb, unsigned generation);
extern void host_raw_byte(unsigned value);
extern unsigned host_milliseconds(void);
extern void host_panic(int code);

static void *kmalloc(unsigned n, gfp_t flags) { (void)flags; return malloc(n); }
static void kfree(void *p) { free(p); }
static struct usb_device *interface_to_usbdev(struct usb_interface *i) { return i->usbdev; }
static void usb_set_intfdata(struct usb_interface *i, void *p) { i->data=p; }
static void *usb_get_intfdata(struct usb_interface *i) { return i->data; }
static unsigned usb_sndctrlpipe(struct usb_device *d,unsigned ep) { (void)d;return ep; }
static unsigned usb_rcvctrlpipe(struct usb_device *d,unsigned ep) { (void)d;return 0x80|ep; }
static struct urb *usb_alloc_urb(int iso,gfp_t flags) {
    struct urb *u;(void)iso;(void)flags;u=calloc(1,sizeof(struct urb));if(u)u->references=1;return u;
}
static void usb_free_urb(struct urb *u) {
    if(!u)return;if(!u->references)host_panic(4);
    u->references--;if(!u->references){if(u->active)host_panic(1);free(u);}
}
static void usb_fill_control_urb(struct urb *u,struct usb_device *d,unsigned pipe,
        unsigned char *setup,void *data,int length,void (*callback)(struct urb *),void *context) {
    u->dev=d;u->pipe=pipe;u->setup_packet=setup;u->transfer_buffer=data;
    u->transfer_buffer_length=length;u->complete=callback;u->context=context;
}
static int usb_submit_urb(struct urb *u,gfp_t flags) {
    int result;(void)flags;
    if(u->active)return -EBUSY;
    u->active=1;u->generation++;u->references++;
    result=host_submit((unsigned)u,u->generation);
    if(result<0){u->active=0;usb_free_urb(u);}
    return result;
}
static void usb_kill_urb(struct urb *u) {
    if(!u||!u->active)return;
    host_cancel((unsigned)u,u->generation);
    u->active=0;
}
static struct sk_buff *dev_alloc_skb(unsigned n) {
    struct sk_buff *s=calloc(1,sizeof(*s));
    if(!s)return NULL;
    s->allocation=malloc(n);
    if(!s->allocation){free(s);return NULL;}
    s->data=s->allocation;s->next_speed=-1;return s;
}
static void skb_reserve(struct sk_buff *s,unsigned n) { s->data+=n; }
static void dev_kfree_skb(struct sk_buff *s) { if(s){free(s->allocation);free(s);} }
static void kfree_skb(struct sk_buff *s) { dev_kfree_skb(s); }
static struct net_device *alloc_irdadev(unsigned n) {
    struct net_device *d=calloc(1,sizeof(*d));if(!d)return NULL;
    d->private=calloc(1,n);if(!d->private){free(d);return NULL;}
    strcpy(d->name,"irda-lab");d->present=1;return d;
}
static void *netdev_priv(struct net_device *d) { return d->private; }
static int register_netdev(struct net_device *d) { return 0; }
static void unregister_netdev(struct net_device *d) { if(d->running){d->running=0;d->netdev_ops->ndo_stop(d);} }
static void free_netdev(struct net_device *d) { if(d){free(d->private);free(d);} }
static int netif_running(struct net_device *d) { return d->running; }
static int netif_device_present(struct net_device *d) { return d->present; }
static void netif_start_queue(struct net_device *d) { d->queue=1; }
static void netif_stop_queue(struct net_device *d) { d->queue=0; }
static void netif_wake_queue(struct net_device *d) { d->queue=1; }
static void netif_device_detach(struct net_device *d) { d->present=0; }
static void netif_device_attach(struct net_device *d) { d->present=1; }
static void spin_lock_init(spinlock_t *l) { *l=0; }
static void spin_lock(spinlock_t *l) { if(*l)host_panic(2);*l=1; }
static void spin_unlock(spinlock_t *l) { if(!*l)host_panic(3);*l=0; }
static int capable(int capability) { return 1; }
static void irda_device_set_media_busy(struct net_device *d,int busy) { (void)d;(void)busy; }
static int irda_get_next_speed(struct sk_buff *s) { return s->next_speed; }
static void irda_init_max_qos_capabilies(struct qos_info *q) { q->baud_rate.bits=~0u;q->min_turn_time.bits=~0u; }
static void irda_qos_bits_to_value(struct qos_info *q) { (void)q; }
static struct irlap_cb *irlap_open(struct net_device *d,struct qos_info *q,char *name) {
    (void)d;(void)q;(void)name;return calloc(1,sizeof(struct irlap_cb));
}
static void irlap_close(struct irlap_cb *p) { free(p); }
static void do_gettimeofday(struct timeval *t) { unsigned ms=host_milliseconds();t->tv_sec=ms/1000;t->tv_usec=(ms%1000)*1000; }

/* The browser owns SIR framing and CRC. These two shims define the raw-byte
 * boundary, rather than introducing a second Linux IrLAP/framing stack. */
static unsigned async_wrap_skb(struct sk_buff *s,unsigned char *out,unsigned capacity) {
    if(s->len>capacity)return 0;memcpy(out,s->data,s->len);return s->len;
}
static void async_unwrap_char(struct net_device *d,void *stats,iobuff_t *buff,unsigned char byte) {
    (void)d;(void)stats;(void)buff;host_raw_byte(byte);
}
#endif
