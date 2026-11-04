#ifndef LAB_SERIAL_COMPAT_H
#define LAB_SERIAL_COMPAT_H
#include <asm/termios.h>
#include <linux/serial_reg.h>
#include <linux/usb/irda.h>
#define THIS_MODULE ((void*)0)
#define __user
#define __init
#define __exit
#define KBUILD_MODNAME "c-driver-lab"
#define ENOIOCTLCMD 515
#define PORT_16654 11
#define TTY_NORMAL 0
#define TTY_BREAK 1
#define TTY_FRAME 3
#define TTY_PARITY 2
#define TTY_OVERRUN 4
#define __le16_to_cpu(x) ((uint16_t)(x))
#define I_IXOFF(tty) ((tty)->termios.c_iflag&IXOFF)
#define I_IXON(tty) ((tty)->termios.c_iflag&IXON)
struct mutex {int locked;};
static void mutex_init(struct mutex *m) {m->locked=0;}
static void mutex_lock(struct mutex *m) {if(m->locked)host_panic(20);m->locked=1;}
static void mutex_unlock(struct mutex *m) {if(!m->locked)host_panic(21);m->locked=0;}
static void mutex_destroy(struct mutex *m) {if(m->locked)host_panic(22);}
struct tty_struct {struct ktermios termios;void *driver_data;};
struct tty_port {unsigned delta_msr_wait;};
static struct ktermios tty_std_termios;
struct serial_struct {int type,line,port,baud_base;};
struct serial_icounter_struct {int cts,dsr,rng,dcd,rx,tx,frame,overrun,parity,brk,buf_overrun;};
struct lab_kfifo {const unsigned char *data;unsigned length,position;};
struct usb_serial;
struct usb_serial_port;
struct usb_serial_driver {
    struct {void *owner;const char *name;} driver;
    const char *description;const struct usb_device_id *id_table;
    unsigned num_ports,num_bulk_in,num_bulk_out,num_interrupt_in,bulk_in_size,bulk_out_size;
    int (*attach)(struct usb_serial*);
    int (*port_probe)(struct usb_serial_port*);
    int (*port_remove)(struct usb_serial_port*);
    int (*open)(struct tty_struct*,struct usb_serial_port*);
    void (*close)(struct usb_serial_port*);
    void (*init_termios)(struct tty_struct*);
    void (*set_termios)(struct tty_struct*,struct usb_serial_port*,struct ktermios*);
    int (*ioctl)(struct tty_struct*,unsigned,unsigned long);
    int (*tiocmget)(struct tty_struct*);
    int (*tiocmset)(struct tty_struct*,unsigned,unsigned);
    int (*tiocmiwait)(struct tty_struct*,unsigned long);
    int (*get_icount)(struct tty_struct*,struct serial_icounter_struct*);
    void (*break_ctl)(struct tty_struct*,int);
    void (*read_int_callback)(struct urb*);
    void (*process_read_urb)(struct urb*);
    int (*prepare_write_buffer)(struct usb_serial_port*,void*,size_t);
    int (*write)(struct tty_struct*,struct usb_serial_port*,const unsigned char*,int);
    int (*write_room)(struct tty_struct*);
    void (*write_bulk_callback)(struct urb*);
};
struct usb_serial {struct usb_device *dev;struct usb_interface *interface;struct usb_serial_driver *type;struct usb_serial_port *port[1];};
struct usb_serial_port {
    struct device dev;struct usb_serial *serial;void *private;
    struct tty_port port;struct serial_icounter_struct icount;
    unsigned minor,port_number,bulk_out_endpointAddress,opened,tx_ready,tx_count,bulk_out_size,tx_bytes;
    unsigned long write_urbs_free;
    struct urb *read_urb,*write_urbs[1],*interrupt_in_urb;
    struct lab_kfifo write_fifo;spinlock_t lock;
};
extern void host_tty_byte(unsigned value,unsigned flag);
#define min(a,b) ((a)<(b)?(a):(b))
static int test_bit(unsigned bit,const unsigned long *value) {return (*value>>bit)&1;}
static int __test_and_clear_bit(unsigned bit,unsigned long *value) {int old=test_bit(bit,value);*value&=~(1ul<<bit);return old;}
static void __set_bit(unsigned bit,unsigned long *value) {*value|=1ul<<bit;}
static void usb_serial_port_softint(struct usb_serial_port *port) {port->tx_ready=1;}
static unsigned tty_insert_flip_string_fixed_flag(struct tty_port *p,const unsigned char *s,unsigned flag,unsigned n) {
    unsigned i;for(i=0;i<n;i++)host_tty_byte(s[i],flag);return n;
}
static unsigned tty_insert_flip_string(struct tty_port *p,const unsigned char *s,unsigned n) {return tty_insert_flip_string_fixed_flag(p,s,0,n);}
static int tty_insert_flip_char(struct tty_port *p,unsigned value,unsigned flag) {host_tty_byte(value,flag);return 1;}
static void tty_flip_buffer_push(struct tty_port *p) {(void)p;}
static void wake_up_interruptible(unsigned *p) {(*p)++;}
static int copy_to_user(void *dest,const void *src,unsigned n) {memcpy(dest,src,n);return 0;}
static unsigned tty_get_baud_rate(struct tty_struct *t) {return t->termios.c_ospeed;}
static unsigned tty_termios_baud_rate(struct ktermios *t) {return t->c_ospeed;}
static void tty_termios_encode_baud_rate(struct ktermios *t,unsigned in,unsigned out) {t->c_ispeed=in;t->c_ospeed=out;}
static void tty_encode_baud_rate(struct tty_struct *t,unsigned in,unsigned out) {tty_termios_encode_baud_rate(&t->termios,in,out);}
static void tty_termios_copy_hw(struct ktermios *t,const struct ktermios *old) {if(old)*t=*old;}
static void usb_set_serial_port_data(struct usb_serial_port *p,void *data) {p->private=data;}
static void *usb_get_serial_port_data(struct usb_serial_port *p) {return p->private;}
static void usb_serial_debug_data(struct device *d,const char *name,unsigned n,const void *p) {}
static int usb_serial_generic_tiocmiwait(struct tty_struct *t,unsigned long mask) {return -EOPNOTSUPP;}
static int usb_serial_generic_get_icount(struct tty_struct *t,struct serial_icounter_struct *out) {
    struct usb_serial_port *p=t->driver_data;*out=p->icount;return 0;
}
static unsigned kfifo_out_locked(struct lab_kfifo *f,void *out,unsigned n,spinlock_t *lock) {
    unsigned left=f->length-f->position;if(n>left)n=left;memcpy(out,f->data+f->position,n);f->position+=n;return n;
}
static void lab_serial_read_callback(struct urb *u) {
    struct usb_serial_port *p=u->context;
    if(!p->opened||u->status)return;
    p->serial->type->process_read_urb(u);usb_submit_urb(u,GFP_KERNEL);
}
static void lab_serial_write_callback(struct urb *u) {struct usb_serial_port *p=u->context;p->tx_ready=1;}
static int usb_serial_generic_open(struct tty_struct *t,struct usb_serial_port *p) {p->opened=1;p->tx_ready=1;return usb_submit_urb(p->read_urb,GFP_KERNEL);}
static void usb_serial_generic_close(struct usb_serial_port *p) {
    p->opened=0;usb_kill_urb(p->read_urb);usb_kill_urb(p->write_urbs[0]);
}
static struct usb_serial_driver * const *lab_serial_drivers;
static int usb_serial_register_drivers(struct usb_serial_driver * const *drivers,const char *name,const struct usb_device_id *ids) {lab_serial_drivers=drivers;return 0;}
static void usb_serial_deregister_drivers(struct usb_serial_driver * const *drivers) {lab_serial_drivers=NULL;}
#define module_init(f) static int (*lab_module_init)(void)=(f)
#define module_exit(f) static void (*lab_module_exit)(void)=(f)
#undef module_usb_serial_driver
#define module_usb_serial_driver(drivers,ids) static void lab_serial_autoreg(void) {lab_serial_drivers=(drivers);}
#endif
