const DAC_QUEUE_RESERVE = 0.2;

var AUDIOBUFFER_MINIMUM_SAMPLING_RATE = 8000;

const MIXER_CHANNEL_LEFT = 0;
const MIXER_CHANNEL_RIGHT = 1;
const MIXER_CHANNEL_BOTH = 2;
const MIXER_SRC_MASTER = 0;
const MIXER_SRC_PCSPEAKER = 1;
const MIXER_SRC_DAC = 2;
const OSCILLATOR_FREQ = 1193.1816666;

/**
 * @constructor
 * @param {!BusConnector} bus
 */
function SpeakerAdapter(bus) {
  const web_audio_engine = require('web-audio-engine');
  global.Speaker = require('speaker');

  var SpeakerDAC = SpeakerBufferSourceDAC;

  /** @const */
  this.bus = bus;

  /** @const */
  this.audio_context = new web_audio_engine.StreamAudioContext();

  this.audio_context.pipe(new Speaker());
  this.audio_context.resume();

  /** @const */
  this.mixer = new SpeakerMixer(bus, this.audio_context);

  /** @const */
  this.pcspeaker = new PCSpeaker(bus, this.audio_context, this.mixer);

  /** @const */
  this.dac = new SpeakerDAC(bus, this.audio_context, this.mixer);

  this.pcspeaker.start();

  bus.register('emulator-stopped', function() {
    this.audio_context.suspend();
  }, this);

  bus.register('emulator-started', function() {
    this.audio_context.resume();
  }, this);

  bus.register('speaker-confirm-initialized', function() {
    bus.send('speaker-has-initialized');
  }, this);
  bus.send('speaker-has-initialized');
}

/**
 * @constructor
 * @param {!BusConnector} bus
 * @param {!AudioContext} audio_context
 */
function SpeakerMixer(bus, audio_context) {
  /** @const */
  this.audio_context = audio_context;

  this.sources = new Map();

  // States

  this.volume_both = 1;
  this.volume_left = 1;
  this.volume_right = 1;
  this.gain_left = 1;
  this.gain_right = 1;

  // Nodes
  // TODO: Find / calibrate / verify the filter frequencies

  this.node_treble_left = this.audio_context.createBiquadFilter();
  this.node_treble_right = this.audio_context.createBiquadFilter();
  this.node_treble_left.type = 'highshelf';
  this.node_treble_right.type = 'highshelf';
  this.node_treble_left.frequency.setValueAtTime(2000, this.audio_context.currentTime);
  this.node_treble_right.frequency.setValueAtTime(2000, this.audio_context.currentTime);

  this.node_bass_left = this.audio_context.createBiquadFilter();
  this.node_bass_right = this.audio_context.createBiquadFilter();
  this.node_bass_left.type = 'lowshelf';
  this.node_bass_right.type = 'lowshelf';
  this.node_bass_left.frequency.setValueAtTime(200, this.audio_context.currentTime);
  this.node_bass_right.frequency.setValueAtTime(200, this.audio_context.currentTime);

  this.node_gain_left = this.audio_context.createGain();
  this.node_gain_right = this.audio_context.createGain();

  this.node_merger = this.audio_context.createChannelMerger(2);

  // Graph

  this.input_left = this.node_treble_left;
  this.input_right = this.node_treble_right;

  this.node_treble_left.connect(this.node_bass_left);
  this.node_bass_left.connect(this.node_gain_left);
  this.node_gain_left.connect(this.node_merger, 0, 0);

  this.node_treble_right.connect(this.node_bass_right);
  this.node_bass_right.connect(this.node_gain_right);
  this.node_gain_right.connect(this.node_merger, 0, 1);

  this.node_merger.connect(this.audio_context.destination);

  // Interface

  bus.register('mixer-connect', function(data) {
    var source_id = data[0];
    var channel = data[1];
    this.connect_source(source_id, channel);
  }, this);

  bus.register('mixer-disconnect', function(data) {
    var source_id = data[0];
    var channel = data[1];
    this.disconnect_source(source_id, channel);
  }, this);

  bus.register('mixer-volume', function(data) {
    var source_id = data[0];
    var channel = data[1];
    var decibels = data[2];

    var gain = Math.pow(10, decibels / 20);

    var source = source_id === MIXER_SRC_MASTER ? this : this.sources.get(source_id);

    if (source === undefined) {
      //console.log(false, 'Mixer set volume - cannot set volume for undefined source: ' + source_id);
      return;
    }

    source.set_volume(gain, channel);
  }, this);

  bus.register('mixer-gain-left', function( /** number */ decibels) {
    this.gain_left = Math.pow(10, decibels / 20);
    this.update();
  }, this);

  bus.register('mixer-gain-right', function( /** number */ decibels) {
    this.gain_right = Math.pow(10, decibels / 20);
    this.update();
  }, this);

  function create_gain_handler(audio_node) {
    return function(decibels) {
      audio_node.gain.setValueAtTime(decibels, this.audio_context.currentTime);
    };
  }
  bus.register('mixer-treble-left', create_gain_handler(this.node_treble_left), this);
  bus.register('mixer-treble-right', create_gain_handler(this.node_treble_right), this);
  bus.register('mixer-bass-left', create_gain_handler(this.node_bass_left), this);
  bus.register('mixer-bass-right', create_gain_handler(this.node_bass_right), this);
}

/**
 * @param {!AudioNode} source_node
 * @param {number} source_id
 * @return {SpeakerMixerSource}
 */
SpeakerMixer.prototype.add_source = function(source_node, source_id) {
  var source = new SpeakerMixerSource(
    this.audio_context,
    source_node,
    this.input_left,
    this.input_right
  );

  //console.log(!this.sources.has(source_id), 'Mixer add source - overwritting source: ' + source_id);

  this.sources.set(source_id, source);
  return source;
};

/**
 * @param {number} source_id
 * @param {number=} channel
 */
SpeakerMixer.prototype.connect_source = function(source_id, channel) {
  var source = this.sources.get(source_id);

  if (source === undefined) {
    //console.log(false, 'Mixer connect - cannot connect undefined source: ' + source_id);
    return;
  }

  source.connect(channel);
};

/**
 * @param {number} source_id
 * @param {number=} channel
 */
SpeakerMixer.prototype.disconnect_source = function(source_id, channel) {
  var source = this.sources.get(source_id);

  if (source === undefined) {
    //console.log(false, 'Mixer disconnect - cannot disconnect undefined source: ' + source_id);
    return;
  }

  source.disconnect(channel);
};

/**
 * @param {number} value
 * @param {number=} channel
 */
SpeakerMixer.prototype.set_volume = function(value, channel) {
  if (channel === undefined) {
    channel = MIXER_CHANNEL_BOTH;
  }

  switch (channel) {
    case MIXER_CHANNEL_LEFT:
      this.volume_left = value;
      break;
    case MIXER_CHANNEL_RIGHT:
      this.volume_right = value;
      break;
    case MIXER_CHANNEL_BOTH:
      this.volume_both = value;
      break;
    default:
      //console.log(false, 'Mixer set master volume - unknown channel: ' + channel);
      return;
  }

  this.update();
};

SpeakerMixer.prototype.update = function() {
  var net_gain_left = this.volume_both * this.volume_left * this.gain_left;
  var net_gain_right = this.volume_both * this.volume_right * this.gain_right;

  this.node_gain_left.gain.setValueAtTime(net_gain_left, this.audio_context.currentTime);
  this.node_gain_right.gain.setValueAtTime(net_gain_right, this.audio_context.currentTime);
};

/**
 * @constructor
 * @param {!AudioContext} audio_context
 * @param {!AudioNode} source_node
 * @param {!AudioNode} destination_left
 * @param {!AudioNode} destination_right
 */
function SpeakerMixerSource(audio_context, source_node, destination_left, destination_right) {
  /** @const */
  this.audio_context = audio_context;

  // States

  this.connected_left = true;
  this.connected_right = true;
  this.gain_hidden = 1;
  this.volume_both = 1;
  this.volume_left = 1;
  this.volume_right = 1;

  // Nodes

  this.node_splitter = audio_context.createChannelSplitter(2);
  this.node_gain_left = audio_context.createGain();
  this.node_gain_right = audio_context.createGain();

  // Graph

  source_node.connect(this.node_splitter);

  this.node_splitter.connect(this.node_gain_left, 0);
  this.node_gain_left.connect(destination_left);

  this.node_splitter.connect(this.node_gain_right, 1);
  this.node_gain_right.connect(destination_right);
}

SpeakerMixerSource.prototype.update = function() {
  var net_gain_left = this.connected_left * this.gain_hidden * this.volume_both * this.volume_left;
  var net_gain_right = this.connected_right * this.gain_hidden * this.volume_both * this.volume_right;

  this.node_gain_left.gain.setValueAtTime(net_gain_left, this.audio_context.currentTime);
  this.node_gain_right.gain.setValueAtTime(net_gain_right, this.audio_context.currentTime);
};

/** @param {number=} channel */
SpeakerMixerSource.prototype.connect = function(channel) {
  var both = !channel || channel === MIXER_CHANNEL_BOTH;
  if (both || channel === MIXER_CHANNEL_LEFT) {
    this.connected_left = true;
  }
  if (both || channel === MIXER_CHANNEL_RIGHT) {
    this.connected_right = true;
  }
  this.update();
};

/** @param {number=} channel */
SpeakerMixerSource.prototype.disconnect = function(channel) {
  var both = !channel || channel === MIXER_CHANNEL_BOTH;
  if (both || channel === MIXER_CHANNEL_LEFT) {
    this.connected_left = false;
  }
  if (both || channel === MIXER_CHANNEL_RIGHT) {
    this.connected_right = false;
  }
  this.update();
};

/**
 * @param {number} value
 * @param {number=} channel
 */
SpeakerMixerSource.prototype.set_volume = function(value, channel) {
  if (channel === undefined) {
    channel = MIXER_CHANNEL_BOTH;
  }

  switch (channel) {
    case MIXER_CHANNEL_LEFT:
      this.volume_left = value;
      break;
    case MIXER_CHANNEL_RIGHT:
      this.volume_right = value;
      break;
    case MIXER_CHANNEL_BOTH:
      this.volume_both = value;
      break;
    default:
      //console.log(false, 'Mixer set volume - unknown channel: ' + channel);
      return;
  }

  this.update();
};

SpeakerMixerSource.prototype.set_gain_hidden = function(value) {
  this.gain_hidden = value;
};

/**
 * @constructor
 * @param {!BusConnector} bus
 * @param {!AudioContext} audio_context
 * @param {!SpeakerMixer} mixer
 */
function PCSpeaker(bus, audio_context, mixer) {
  // Nodes

  this.node_oscillator = audio_context.createOscillator();
  this.node_oscillator.type = 'square';
  this.node_oscillator.frequency.setValueAtTime(440, audio_context.currentTime);

  // Interface

  this.mixer_connection = mixer.add_source(this.node_oscillator, MIXER_SRC_PCSPEAKER);
  this.mixer_connection.disconnect();

  bus.register('pcspeaker-enable', function() {
    mixer.connect_source(MIXER_SRC_PCSPEAKER);
  }, this);

  bus.register('pcspeaker-disable', function() {
    mixer.disconnect_source(MIXER_SRC_PCSPEAKER);
  }, this);

  bus.register('pcspeaker-update', function(data) {
    var counter_mode = data[0];
    var counter_reload = data[1];

    var frequency = 0;
    var beep_enabled = counter_mode === 3;

    if (beep_enabled) {
      frequency = OSCILLATOR_FREQ * 1000 / counter_reload;
      frequency = Math.min(frequency, this.node_oscillator.frequency.maxValue);
      frequency = Math.max(frequency, 0);
    }

    this.node_oscillator.frequency.setValueAtTime(frequency, audio_context.currentTime);
  }, this);
}

PCSpeaker.prototype.start = function() {
  this.node_oscillator.start();
};

/**
 * @constructor
 * @param {!BusConnector} bus
 * @param {!AudioContext} audio_context
 * @param {!SpeakerMixer} mixer
 */
function SpeakerBufferSourceDAC(bus, audio_context, mixer) {
  /** @const */
  this.bus = bus;

  /** @const */
  this.audio_context = audio_context;

  // States

  this.enabled = false;
  this.sampling_rate = 22050;
  this.buffered_time = 0;
  this.rate_ratio = 1;

  // Nodes

  this.node_lowpass = this.audio_context.createBiquadFilter();
  this.node_lowpass.type = 'lowpass';

  // Interface

  this.node_output = this.node_lowpass;

  this.mixer_connection = mixer.add_source(this.node_output, MIXER_SRC_DAC);
  this.mixer_connection.set_gain_hidden(3);

  bus.register('dac-send-data', function(data) {
    this.queue(data);
  }, this);

  bus.register('dac-enable', function(enabled) {
    this.enabled = true;
    this.pump();
  }, this);

  bus.register('dac-disable', function() {
    this.enabled = false;
  }, this);

  bus.register('dac-tell-sampling-rate', function( /** number */ rate) {
    //console.log(rate > 0, 'Sampling rate should be nonzero');
    this.audio_context.suspend();
    this.audio_context.pipe(new Speaker({
      sampleRate: rate * 2
    }));
    this.audio_context.resume();
    this.sampling_rate = rate;
    this.rate_ratio = Math.ceil(AUDIOBUFFER_MINIMUM_SAMPLING_RATE / rate);
    this.node_lowpass.frequency.setValueAtTime(rate / 2, this.audio_context.currentTime);
  }, this);
}

SpeakerBufferSourceDAC.prototype.queue = function(data) {
  var sample_count = data[0].length;
  var block_duration = sample_count / this.sampling_rate;

  var buffer;
  if (this.rate_ratio > 1) {
    var new_sample_count = sample_count * this.rate_ratio;
    var new_sampling_rate = this.sampling_rate * this.rate_ratio;
    buffer = this.audio_context.createBuffer(2, new_sample_count, new_sampling_rate);
    var buffer_data0 = buffer.getChannelData(0);
    var buffer_data1 = buffer.getChannelData(1);

    var buffer_index = 0;
    for (var i = 0; i < sample_count; i++) {
      for (var j = 0; j < this.rate_ratio; j++, buffer_index++) {
        buffer_data0[buffer_index] = data[0][i];
        buffer_data1[buffer_index] = data[1][i];
      }
    }
  } else {
    // Allocating new AudioBuffer every block
    // - Memory profiles show insignificant improvements if recycling old buffers.
    buffer = this.audio_context.createBuffer(2, sample_count, this.sampling_rate);
    if (buffer.copyToChannel) {
      buffer.copyToChannel(data[0], 0);
      buffer.copyToChannel(data[1], 1);
    } else {
      // Safari doesn't support copyToChannel yet. See #286
      buffer.getChannelData(0).set(data[0]);
      buffer.getChannelData(1).set(data[1]);
    }
  }

  var source = this.audio_context.createBufferSource();
  source.buffer = buffer;
  source.connect(this.node_lowpass);
  source.addEventListener('ended', this.pump.bind(this));

  var current_time = this.audio_context.currentTime;

  if (this.buffered_time < current_time) {
    //dbg_log('Speaker DAC - Creating/Recreating reserve - shouldn't occur frequently during playback');

    // Schedule pump() to queue evenly, starting from current time
    this.buffered_time = current_time;
    var target_silence_duration = DAC_QUEUE_RESERVE - block_duration;
    var current_silence_duration = 0;
    while (current_silence_duration <= target_silence_duration) {
      current_silence_duration += block_duration;
      this.buffered_time += block_duration;
      setTimeout(() => this.pump(), current_silence_duration * 1000);
    }
  }

  source.start(this.buffered_time);
  this.buffered_time += block_duration;

  // Chase the schedule - ensure reserve is full
  setTimeout(() => this.pump(), 0);
};

SpeakerBufferSourceDAC.prototype.pump = function() {
  if (!this.enabled) {
    return;
  }
  if (this.buffered_time - this.audio_context.currentTime > DAC_QUEUE_RESERVE) {
    return;
  }
  this.bus.send('dac-request-data');
};

exports.SpeakerAdapter = SpeakerAdapter;
