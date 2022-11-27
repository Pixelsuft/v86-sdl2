#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <sys/time.h>

#define PIT_LOG(fmt, ...) printf(fmt, ##__VA_ARGS__)

#define PIT_CLOCK_SPEED 1193182
#define CHAN0 pit.chan[0]
#define CHAN1 pit.chan[1]
#define CHAN2 pit.chan[2]
#define CHAN(n) pit.chan[n]

#define RW_STATE_LSB 1
#define RW_STATE_MSB 2
#define RW_STATE_WORD 3
#define RW_STATE_WORD_2 4
#define MODE_INTERRUPT_ON_TERMINAL_COUNT 0
#define MODE_HARDWARE_RETRIGGERABLE_ONE_SHOT 1
#define MODE_RATE_GENERATOR 2
#define MODE_SQUARE_WAVE 3
#define MODE_SOFTWARE_TRIGGERED_STROBE 4
#define MODE_HARDWARE_TRIGGERED_STROBE 5
#define CONTROL_ADDRESS 3

#define STATUS_LATCHED 1
#define COUNTER_LATCHED 2

uint64_t base;
uint64_t get_now(void)
{
    struct timeval tv;
    gettimeofday(&tv, NULL);
    uint64_t hi = (uint64_t)tv.tv_sec * (uint64_t)1000000 + (uint64_t)tv.tv_usec;
    if (!base)
        base = hi;
    return hi - base;
}

struct pit_channel {
    // <<< BEGIN STRUCT "struct" >>>
    uint32_t count, interim_count; // former is actual count, interim_count is temporary value used while loading
    int flipflop;
    int mode, bcd, gate, rw_mode, rmode, wmode;

    uint8_t status_latch;
    uint8_t whats_latched; // A bitmap of what's latched: bit 0-1: status; bit 2-3: counter
    uint16_t counter_latch;

    uint64_t last_load_time, last_irq_time;
    uint32_t period;

    uint32_t pit_last_count;

    int timer_flipflop;

    int timer_running;
    // <<< END STRUCT "struct" >>>
};
struct pit {
    int speaker;
    uint64_t last;
    struct pit_channel chan[3];
};

static struct pit pit;

static inline uint64_t pit_counter_to_itick(uint32_t c)
{
    double time_scale = (double)1000000 / (double)PIT_CLOCK_SPEED;
    return (uint64_t)((double)c * time_scale);
    //return scale_ticks(c, PIT_CLOCK_SPEED, 1000000);
}
static inline uint64_t pit_uint64_to_counter(uint64_t i)
{
    double time_scale = (double)PIT_CLOCK_SPEED / (double)1000000;
    return (uint64_t)((double)i * time_scale);
    //return scale_ticks(i, PIT_CLOCK_SPEED, 1000000);
}
/*
static inline uint64_t pit_get_time(void)
{
    //return (get_now() * PIT_CLOCK_SPEED) / 1000000; // XXXX: Can overflow
    return pit_uint64_to_counter(get_now());
}*/

// Notes on PIT modes:
/*
Mode 0:
One-shot mode. OUT line is set high after count goes from one to zero, and is not set back to low again. 

Mode 1: 
One-shot mode. OUT line is set high after you set count until count goes from one to zero, and is not set back to high again. Mode 0 & 1 are opposites of one another.

Mode 2:
Repeatable. OUT will be high unless count == 1

Mode 3: 
Repeatable. If count is odd, out will be high for (n + 1) / 2 counts. Otherwise, OUT will be high for (n - 1) / 2 counts. Afterwards, it will be low until timer is refilled

Mode 4: 
One shot mode. Same thing as Mode 2 except it goes low at count == 0

Mode 5: 
Same thing as #4, really.
*/
static int pit_get_out(struct pit_channel* pit)
{
    // Get cycles elapsed since we reloaded the count register
    uint32_t elapsed = pit_uint64_to_counter(get_now() - pit->last_load_time);
    if(pit->count == 0) return 0;
    uint32_t current_counter = elapsed % pit->count; // The current value of the counter
    switch (pit->mode) {
    case 0:
    case 1: // XXX : one shot mode?
        return (pit->count >= current_counter) ^ pit->mode; // They are the opposites of each other
    case 2:
        return current_counter != 1;
    case 3: // XXX: Is this right?
        if (pit->count & 1) // odd
            return current_counter >= ((pit->count + 1) >> 1);
        else // even
            return current_counter < ((pit->count - 1) >> 1);
    case 4:
    case 5:
        return current_counter != 0;
    }
    abort();
}

static int pit_get_count(struct pit_channel* pit)
{
    uint64_t elapsed = get_now() - pit->last_load_time;
    uint32_t diff_in_ticks = (uint32_t)((double)elapsed * (double)PIT_CLOCK_SPEED / (double)1000000);
    uint32_t current = pit->count - diff_in_ticks;
    if (pit->count == 0)
        return 0; // Avoid divide by zero errors for uninitialized timers.
    //if (current & 0x80000000) {
    current = (current % pit->count); // + pit->count;
    //}
    return current;
}

static void pit_set_count(struct pit_channel* this, int v)
{
    this->last_irq_time = this->last_load_time = get_now(); //pit_get_time();
    this->count = (!v) << 16 | v; // 0x10000 if v is 0
    this->period = pit_counter_to_itick(this->count);
    this->timer_running = 1;
    this->pit_last_count = pit_get_count(this); // should this be 0?
}
static void pit_channel_latch_counter(struct pit_channel* this)
{
    if (!(this->whats_latched & COUNTER_LATCHED)) {
        uint16_t ct = pit_get_count(this);
        int mode = this->rw_mode;
        this->whats_latched = (mode << 2) | COUNTER_LATCHED;
        switch (mode) {
        case 1: // lobyte or hibyte only
        case 2:
            this->counter_latch = ct >> ((mode - 1) << 3) & 0xFF;
            break;
        case 3: // flipflop
            this->counter_latch = ct;
            break;
        }
    }
}

void pit_writeb(uint32_t port, uint32_t value, void (*raise)(void))
{
    int channel = port & 3;
    switch (channel) {
    case 3: { // Not a controller, but a command register
        channel = value >> 6;

        uint8_t opmode = value >> 1 & 7,
                bcd = value & 1,
                access = value >> 4 & 3;
        switch (channel) {
        case 3:
            // Read-Back command
            for (int i = 0; i < 3; i++) {
                if ((opmode >> i) & 1) { // The fields mean different things
                    struct pit_channel* chan = &pit.chan[i];
                    if (!(access & 2)) // Latch count flag
                        pit_channel_latch_counter(chan);
                    if (!(access & 1)) { // Latch status flag
                        if (!(chan->whats_latched & STATUS_LATCHED)) {
                            chan->status_latch = (pit_get_out(chan) << 7) | (chan->rw_mode << 4) | //
                                (chan->mode << 1) | //
                                chan->bcd;
                            chan->whats_latched |= STATUS_LATCHED;
                        }
                    }
                }
            }
            break;
        case 0 ... 2: {
            struct pit_channel* chan = &pit.chan[channel];
            if (!access) {
                //PIT_LOG("I/O Latched counter %d [ticks: %08x]\n", channel, pit_get_count(chan));
                pit_channel_latch_counter(chan);
            } else {
                chan->rw_mode = access;

                chan->wmode = chan->rmode = access - 1; // Internal registers

                chan->mode = opmode;
                switch (chan->mode) {
                case 2:
                    if (channel == 0) {
						//printf("raise wr\n");
						raise();
                        // pic_raise_irq(0);
					}
                    break;
                }
                chan->bcd = bcd;
                if (bcd) {
                    PIT_LOG("BCD mode not supported\n");
                }
            }
            break;
        }
        }
        break;
    }
    case 0 ... 2: {
        struct pit_channel* chan = &pit.chan[channel];
        switch (chan->wmode) {
        case 0:
            pit_set_count(chan, value);
            break;
        case 1:
            pit_set_count(chan, value << 8);
            break;
        case 2:
            chan->interim_count = value;
            chan->wmode ^= 1;
            break;
        case 3:
            pit_set_count(chan, value << 8 | chan->interim_count);
            chan->wmode ^= 1; // ???
            break;
        }
        break;
    }
    }
}
uint32_t pit_readb(uint32_t a)
{
    struct pit_channel* chan = &pit.chan[a & 3];
    uint8_t retv = -1;
    if (chan->whats_latched & STATUS_LATCHED) {
        chan->whats_latched &= ~STATUS_LATCHED;
        retv = chan->status_latch;
    } else if (chan->whats_latched & COUNTER_LATCHED) {
        int whats_latched_temp = chan->whats_latched >> 2;
        switch (whats_latched_temp) {
        case 1: // lobyte
        case 2: // hibyte
            whats_latched_temp = 0;
            retv = chan->counter_latch; // We already did the shifting before we reached this point
            break;
        case 3:
            whats_latched_temp = (2 << 2) | COUNTER_LATCHED; // turn it into "hibyte", although "lobyte" could work just as well
            retv = chan->counter_latch;
            chan->counter_latch >>= 8; // get hibyte
            break;
        }
        //chan->whats_latched |= whats_latched_temp << 1;
        chan->whats_latched = whats_latched_temp;
    } else {
        uint32_t count = pit_get_count(chan);
        switch (chan->rmode) {
        case 0:
            retv = count; // automatic truncation
            break;
        case 1:
            retv = count >> 8;
            break;
        case 2:
        case 3:
            retv = count >> ((chan->rmode & 1) << 3); // Select between lobyte and hibyte depending on the lsb
            chan->rmode ^= 1;
            break;
        }
    }
    //PIT_LOG("readb: port=0x%02x, result=0x%02x\n", a, retv);
    return retv;
}

static void pit_channel_reset(struct pit_channel* this)
{
    this->count = 0;
    this->flipflop = this->mode = this->bcd = this->gate = 0;
    this->last_load_time = -1;
}

static void pit_reset(void)
{
    for (int i = 0; i < 3; i++) {
        pit_channel_reset(pit.chan + i);
        pit.chan[i].gate = i != 2;
    }
    pit.speaker = 0;
}

// Get the number of ticks, in the future, that the PIT needs to wait.
int pit_next(uint64_t now, uint8_t no_irq, void (*raise)(void), void (*lower)(void))
{
    uint32_t count = pit_get_count(&pit.chan[0]), raise_irq = 0;
    if (count > pit.chan[0].pit_last_count) {
        // Count has gone from 0 --> 0xFFFF
        raise_irq = 1;
    }
    if (pit.chan[0].timer_running) {

        int refill_count = pit.chan[0].count;
        if (raise_irq) {
			//printf("raise !%i %i\n", (int)no_irq, (int)raise_irq);
			lower();
			raise();
			//pic_lower_irq(0);
			//pic_raise_irq(0);
            if (pit.chan[0].mode != 2 && pit.chan[0].mode != 3) {
                pit.chan[0].timer_running = 0;
                return -1;
            }
        }
        pit.chan[0].pit_last_count = count;
        return pit_counter_to_itick(refill_count - count);
    }
    return -1;
}

uint32_t pit_speaker_readb()
{
    // XXX: Use channel 2 for timing, not channel 0
    pit.chan[2].timer_flipflop ^= 1;
    return pit.chan[2].timer_flipflop << 4 | (pit_get_out(&pit.chan[2]) << 5);
}
/*static void pit_speaker_writeb(uint32_t port, uint32_t data)
{
    PIT_LOG("%sabled the pc speaker\n", data & 1 ? "En" : "Dis");
}*/

/*void pit_init(void)
{
    //state_register(pit_save);
    io_register_reset(pit_reset);

    io_register_read(0x40, 3, pit_readb, NULL, NULL);
    io_register_write(0x40, 4, pit_writeb, NULL, NULL);

    // Technically the PC speaker is not part of the PIT, but it's controlled by the PIT...
    io_register_read(0x61, 1, pit_speaker_readb, NULL, NULL);
    io_register_write(0x61, 1, pit_speaker_writeb, NULL, NULL);
    state_register(pit_state);
}*/