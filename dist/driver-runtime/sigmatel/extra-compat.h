#ifndef LAB_STIR_COMPAT_H
#define LAB_STIR_COMPAT_H
/* Linux services used by stir4200.c. No SigmaTel register policy lives here. */
typedef int64_t ktime_t;
#define module_param(...)
#define MODULE_PARM_DESC(...)
#define pr_debug(...)
#define dev_warn(...)
#define unlikely(x) (x)
#define WARN_ON(x) do { if(x)host_panic(10); } while(0)
#define ARRAY_SIZE(x) (sizeof(x)/sizeof((x)[0]))
#define EINTR 4
#define ESHUTDOWN 108
#define IR_115200 32
#define IR_4000000 256
#define USB_TYPE_VENDOR 0x40
#define USB_RECIP_DEVICE 0
#define IRDA_TRANS 0x20
#define IRDA_RX_COPY_THRESHOLD 256
#define BEGIN_FRAME 1
#define INSIDE_FRAME 2
#define LINK_ESCAPE 3
#define ETH_P_IRDA 0x0017
#define HZ 1000
#define TASK_INTERRUPTIBLE 1
#define current ((void*)0)
#define IS_ERR(p) ((unsigned)(p)>=(unsigned)-4095)
#define PTR_ERR(p) ((int)(p))

extern int host_control(unsigned type,unsigned request,unsigned value,unsigned index,
    unsigned pointer,unsigned length,unsigned timeout);
extern int host_bulk(unsigned pipe,unsigned pointer,unsigned length,unsigned actual,unsigned timeout);
extern int host_clear_halt(unsigned pipe);
extern int host_reset_configuration(void);
extern void host_sleep(unsigned milliseconds);
extern void host_schedule(void);
extern void host_thread_start(void);
extern void host_thread_stop(void);
extern int host_thread_should_stop(void);
extern void host_wake(void);

static unsigned usb_sndbulkpipe(struct usb_device *d,unsigned ep) { return 0x100|ep; }
static unsigned usb_rcvbulkpipe(struct usb_device *d,unsigned ep) { return 0x180|ep; }
static int usb_control_msg(struct usb_device *d,unsigned pipe,unsigned request,unsigned type,
        unsigned value,unsigned index,void *data,unsigned length,unsigned timeout) {
    return host_control(type,request,value,index,(unsigned)data,length,timeout);
}
static int usb_bulk_msg(struct usb_device *d,unsigned pipe,void *data,unsigned length,
        int *actual,unsigned timeout) {
    return host_bulk(pipe,(unsigned)data,length,(unsigned)actual,timeout);
}
static int usb_clear_halt(struct usb_device *d,unsigned pipe) { return host_clear_halt(pipe); }
static int usb_reset_configuration(struct usb_device *d) { return host_reset_configuration(); }
static void usb_fill_bulk_urb(struct urb *u,struct usb_device *d,unsigned pipe,
        void *data,unsigned length,void (*callback)(struct urb*),void *context) {
    u->dev=d;u->pipe=pipe;u->context=context;u->transfer_buffer=data;
    u->transfer_buffer_length=length;u->complete=callback;u->setup_packet=NULL;
}
static uint32_t crc32_le(uint32_t crc,const unsigned char *p,unsigned length) {
    unsigned i,j;for(i=0;i<length;i++){crc^=p[i];for(j=0;j<8;j++)crc=(crc>>1)^((crc&1)?0xedb88320:0);}return crc;
}
static uint32_t get_unaligned_le32(const unsigned char *p) { return p[0]|(p[1]<<8)|(p[2]<<16)|((uint32_t)p[3]<<24); }
static void skb_copy_to_linear_data(struct sk_buff *s,const void *p,unsigned n) { memcpy(s->data,p,n); }
static void *skb_put(struct sk_buff *s,unsigned n) { void *p=s->data+s->len;s->len+=n;return p; }
static void skb_reset_mac_header(struct sk_buff *s) { (void)s; }
static unsigned htons(unsigned n) { return ((n&255)<<8)|((n>>8)&255); }
static void netif_rx(struct sk_buff *s) { host_panic(11);dev_kfree_skb(s); } /* FIR excluded from test */
static struct sk_buff *lab_xchg(struct sk_buff **p,struct sk_buff *next) { struct sk_buff *old=*p;*p=next;return old; }
#define xchg(p,v) lab_xchg((p),(v))
static int signal_pending(void *p) { return 0; }
static void msleep(unsigned ms) { host_sleep(ms); }
static ktime_t ktime_get(void) { return (int64_t)host_milliseconds()*1000000; }
static long ktime_us_delta(ktime_t a,ktime_t b) { return (long)((a-b)/1000); }
static void schedule_timeout_interruptible(unsigned ticks) { host_sleep(ticks*1000/HZ); }
static void udelay(unsigned us) { host_sleep((us+999)/1000); }
static unsigned irda_get_mtt(struct sk_buff *s) { return s->mtt; }
static void netif_trans_update(struct net_device *d) { (void)d; }
static int irda_device_txqueue_empty(struct net_device *d) { return d->queue; }
static int net_ratelimit(void) { return 1; }
static void set_current_state(int state) { (void)state; }
static void schedule(void) { host_schedule(); }
struct task_struct { int (*function)(void*); void *argument; };
static struct task_struct *kthread_run(int (*f)(void*),void *arg,const char *format,...) {
    struct task_struct *t=malloc(sizeof(*t));if(!t)return (void*)-ENOMEM;
    t->function=f;t->argument=arg;host_thread_start();return t;
}
static int kthread_should_stop(void) { return host_thread_should_stop(); }
static int wake_up_process(struct task_struct *t) { host_wake();return 1; }
static int kthread_stop(struct task_struct *t) { host_thread_stop();free(t);return 0; }
#endif
