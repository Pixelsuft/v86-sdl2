const ffi = require('ffi-napi');
const path = require('path');


exports.NetworkAdapter = function(config, bus) {
  this.dll = ffi.Library(path.join(__dirname, 'net'), {
    'net_init': ['int', ['string']],
    'net_send': ['void', ['void*', 'int']],
    'net_poll': ['void', [ffi.Function('void', ['Uint8*', 'int'])]]
  });
  if (this.dll.net_init(config.pcap) !== 0) {
    console.log('failed to init custom net');
    return;
  }
  console.log('custom net inited');
  this.bus = bus;
  this.bus.register("net0-send", function(data) {
    this.dll.net_send(data, data.length);
  }, this);
  this.net_recv = function(data, length) {
    this.bus.send("net0-receive", new Uint8Array(data));
  }.bind(this)
  setInterval(function() {
    this.dll.net_poll(this.net_recv);
  }.bind(this), 500);
}
