#ifndef LAB_MA620_COMPAT_H
#define LAB_MA620_COMPAT_H
/* The Linux MA600 dongle is connected to MA-620's PL2303 serial port.
 * Only the SIR device/TTY boundary is supplied here; the original C file
 * owns reset, command bytes, echo verification and the switching delays. */
#define IRDA_MA600_DONGLE 11
#define MODULE_ALIAS(...)
struct sir_dev {struct qos_info qos;unsigned speed;};
struct dongle_driver {
    void *owner;const char *driver_name;unsigned type;
    int (*open)(struct sir_dev*),(*close)(struct sir_dev*),(*reset)(struct sir_dev*);
    int (*set_speed)(struct sir_dev*,unsigned);
};
static struct dongle_driver *lab_dongle;
static int irda_register_dongle(struct dongle_driver *driver) {lab_dongle=driver;return 0;}
static void irda_unregister_dongle(struct dongle_driver *driver) {lab_dongle=NULL;}
static int sirdev_set_dtr_rts(struct sir_dev *dev,int dtr,int rts);
static int sirdev_raw_write(struct sir_dev *dev,const unsigned char *bytes,unsigned length);
static int sirdev_raw_read(struct sir_dev *dev,unsigned char *bytes,unsigned length);
static int lab_ma620_open(void);
static int lab_ma620_speed(unsigned speed);
static void lab_ma620_close(void);
#endif
