process.env.sdl2_global_export = 'true';
const fs = require('fs');
const path = require('path');
const sdl2 = require('minsdl2js');
const ws = require('ws');
const filebuf = require('./filebuf');

global.ImageData = function(buffer, width, height) {
  buffer.data = buffer;
  buffer.virtual_width = width;
  buffer.virtual_height = height;
  return buffer;
}

global.WebSocket = function(url) {
  return new ws.WebSocket(url, {
    perMessageDeflate: false
  });
}

exports.get_renderer_by_name = function(renderer_name) {
  var renderers = [];
  for (var i = 0; i < SDL_GetNumRenderDrivers(); i++) {
    const renderer_info = new SDL_RendererInfo;
    SDL_GetRenderDriverInfo(i, renderer_info.ref());
    renderers.push(renderer_info.name);
  }
  const renderer_index = renderers.indexOf(renderer_name);
  if (renderer_index >= 0)
    return renderer_index;
  console.log('Could not find renderer: ' + renderer_name);
  console.log('Available: ' + renderers.join(', '));
  return -1;
}

exports.init_window = function(config) {
  var prefix = process.platform == 'win32' ? '' : 'lib';
  var postfix = '';
  if (process.argv.includes('--cygwin')) {
    prefix = 'cyg';
    postfix = '-2-0-0';
  }
  sdl2.load_sdl2_library(prefix + 'SDL2' + postfix);
  if (!config.disable_text_mode)
    sdl2.load_sdl2_ttf_library(prefix + 'SDL2_ttf' + postfix);
  sdl2.export_sdl2_library(global);
  if (!config.disable_text_mode)
    sdl2.export_sdl2_ttf_library(global);
  const started_at = Date.now();
  SDL_Init(SDL_INIT_VIDEO | SDL_INIT_EVENTS | SDL_INIT_TIMER);
  if (!config.disable_text_mode)
    TTF_Init();
  const window = SDL_CreateWindow(
    'v86-sdl2',
    SDL_WINDOWPOS_CENTERED,
    SDL_WINDOWPOS_CENTERED,
    640,
    480,
    SDL_WINDOW_ALLOW_HIGHDPI |
    (config.resizable ? SDL_WINDOW_RESIZABLE : 0) |
    (config.fullscreen ? SDL_WINDOW_FULLSCREEN : 0)
  );
  const renderer = SDL_CreateRenderer(
    window,
    exports.get_renderer_by_name(config.renderer),
    (config.renderer_accererated ? SDL_RENDERER_ACCELERATED : 0) |
    (config.vsync ? SDL_RENDERER_PRESENTVSYNC : 0)
  );
  const font_path = path.join(__dirname, 'fonts', config.font + '.ttf');
  if (!config.disable_text_mode && !fs.existsSync(font_path)) {
    console.log('Could not load font: ' + font_path);
    process.exit(1);
  }
  if (config.hook_time) {
    Date.now = function() {
      return started_at + SDL_GetTicks64();
    }
  }
  return [window, renderer, config.disable_text_mode ? null : TTF_OpenFont(font_path, config.font_size)];
}

exports.load_charmap_high = function(config) {
  const charmap_path = path.join(__dirname, 'high_charmaps', config.charmap_high + '.json');
  if (!fs.existsSync(charmap_path)) {
    console.log('Could not high charmap: ' + charmap_path);
    return undefined;
  }
  return JSON.parse(fs.readFileSync(charmap_path, 'utf8'));
}

exports.create_rect = function(x, y, w, h) {
  return new SDL_Rect({
    x: x,
    y: y,
    w: w,
    h: h
  });
}

exports.get_config = function() {
  if (process.argv.length <= 2) {
    console.log(`Usage: "${process.argv[0]}" "${process.argv[1]}" "path_to_config.json"`);
    process.exit(0);
  }
  if (!fs.existsSync(process.argv[2])) {
    console.log('Could not read config: ' + process.argv[2]);
    process.exit(1);
  }
  var result = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  if (typeof result.memory_size == 'string') {
    result.memory_size = eval(result.memory_size);
  }
  if (typeof result.vga_memory_size == 'string') {
    result.vga_memory_size = eval(result.vga_memory_size);
  }
  if (typeof result.boot_order == 'string') {
    result.boot_order = eval(result.boot_order);
  }
  if (typeof result.mouse_sens == 'string') {
    result.mouse_sens = eval(result.mouse_sens);
  }
  ['fda', 'fdb', 'hda', 'hdb', 'cdrom'].forEach(function(drive) {
    if (typeof result[drive] == 'undefined' || !result[drive].nodejs_buffer)
      return;
    result[drive] = new filebuf.AsyncNodeJSBuffer(
      result[drive].url || result[drive].path || result[drive].name || result[drive].fn,
      drive !== 'cdrom'
    );
  });
  return result;
}
