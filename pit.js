"use strict";
const ffi = require('ffi-napi');

/**
 * @constructor
 *
 * Programmable Interval Timer
 */
function PIT(cpu, bus)
{
    /** @const @type {CPU} */
    this.cpu = cpu;

    this.bus = bus;
	this.dll = ffi.Library('pit/pit', {
		'pit_writeb': ['void', ['Uint32', 'Uint32', ffi.Function('void', [])]],
		'pit_readb': ['Uint32', ['Uint32']],
		'pit_next': ['int', ['Uint64', 'Uint8', ffi.Function('void', []), ffi.Function('void', [])]],
		'pit_speaker_readb': ['Uint32', []]
	});
	this.raise = function() {
		this.cpu.device_raise_irq(0);
	}.bind(this);
	this.lower = function() {
		this.cpu.device_lower_irq(0);
	}.bind(this);

    cpu.io.register_read(0x61, this, this.dll.pit_speaker_readb.bind(this));
    cpu.io.register_write(0x61, this, function(data)
    {
        if(data & 1)
        {
            this.bus.send("pcspeaker-enable");
        }
        else
        {
            this.bus.send("pcspeaker-disable");
        }
    });

    cpu.io.register_read(0x40, this, function() { return this.dll.pit_readb(0x40); });
    cpu.io.register_read(0x41, this, function() { return this.dll.pit_readb(0x41); });
    cpu.io.register_read(0x42, this, function() { return this.dll.pit_readb(0x42); });

    cpu.io.register_write(0x40, this, function(data) { this.dll.pit_writeb(0x40, data, this.raise); });
    cpu.io.register_write(0x41, this, function(data) { this.dll.pit_writeb(0x41, data, this.raise); });
    cpu.io.register_write(0x42, this, function(data) { this.dll.pit_writeb(0x42, data, this.raise); });
    cpu.io.register_write(0x43, this, function(data) { this.dll.pit_writeb(0x43, data, this.raise); });
	
	this.timer = function(now, no_irq) {
		return this.dll.pit_next(now, no_irq, this.raise, this.lower);
	}.bind(this);
}

exports.PIT = PIT;
