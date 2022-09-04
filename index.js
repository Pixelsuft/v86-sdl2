const utils = require('./utils');
const screen_tools = require('./screen_tools');
const speaker = require('./speaker');
const keyboard = require('./keyboard');
const v86 = require('./build/libv86.js');


const config = utils.get_config();
const mouse_sens = config.mouse_sens;
const machine_name = config.name;
const char_size = config.char_size;
const use_serial = config.use_serial;
const disable_text = config.disable_text_mode;
const charmap = screen_tools.create_charmap(utils.load_charmap_high(config));
const [window, renderer, font] = utils.init_window(config);

var mouse_locked = false;
var mouse_buttons = [false, false, false];
var is_graphical = false;
var vga_mode_size = [640, 480];
var vga_mode_scale = [1, 1];
var text_mode_size = [char_size[0] * 80, char_size[1] * 25];
var text_mode_count = [80, 25];
var changed_rows = new Int8Array(25);
var text_mode_data = new Int32Array(80 * 25 * 3);
var is_loading = false;

let graphical_texture;
let text_texture;

const e = new v86.V86Starter(config);

e.bus.register('emulator-ready', function() {
  if (config.speaker)
    new speaker.SpeakerAdapter(e.bus);
  if (!config.autostart)
    e.bus.send('cpu-run');
  setImmediate(tick);
});
e.bus.register('screen-clear', function() {
  SDL_SetRenderTarget(renderer, null);
  SDL_SetRenderDrawColor(renderer, 0, 255, 0, 255);
  SDL_RenderClear(renderer);
});
e.bus.register('screen-set-mode', function(data) {
  if (data == is_graphical)
    return;
  is_graphical = data;
  resize_window();
  update_title();
});
e.bus.register('screen-set-size-text', function(data) {
  if (disable_text || (text_mode_count[0] == data[0] && text_mode_count[1] == data[1]))
    return;
  text_mode_count[0] = data[0];
  text_mode_count[1] = data[1];
  text_mode_size[0] = data[0] * char_size[0];
  text_mode_size[1] = data[1] * char_size[1];
  changed_rows = new Int8Array(data[1]);
  text_mode_data = new Int32Array(data[0] * data[1] * 3);
  if (text_texture)
    SDL_DestroyTexture(text_texture);
  text_texture = SDL_CreateTexture(
    renderer,
    SDL_PIXELFORMAT_RGBA8888,
    SDL_TEXTUREACCESS_TARGET,
    text_mode_size[0],
    text_mode_size[1]
  );
  if (!is_graphical) {
    resize_window();
  }
  update_title();
});
e.bus.register('screen-set-size-graphical', function(data) {
  var scale_x = 1;
  var scale_y = 1;
  if (data[4] == 8 && data[0] < 640 && data[1] < 480) {
    if (data[0] >= data[1]) {
      scale_y = 2;
    }
    scale_x = 2;
  }
  if (vga_mode_size[0] == data[0] && vga_mode_size[1] == data[1] && vga_mode_scale[0] == scale_x && vga_mode_scale[1] == scale_y)
    return;
  vga_mode_scale[0] = scale_x;
  vga_mode_scale[1] = scale_y;
  vga_mode_size[0] = data[0];
  vga_mode_size[1] = data[1];
  if (graphical_texture)
    SDL_DestroyTexture(graphical_texture);
  graphical_texture = SDL_CreateTexture(
    renderer,
    SDL_PIXELFORMAT_RGBA8888,
    SDL_TEXTUREACCESS_TARGET,
    vga_mode_size[0],
    vga_mode_size[1]
  );
  if (is_graphical) {
    resize_window();
  }
  update_title();
});
e.bus.register('screen-fill-buffer-end', function(data) {
  SDL_SetRenderTarget(renderer, graphical_texture);
  data.forEach(layer => {
    const texture = SDL_CreateTexture(
      renderer,
      SDL_PIXELFORMAT_ABGR8888,
      SDL_TEXTUREACCESS_STREAMING,
      layer.buffer_width,
      layer.buffer_height + layer.buffer_y
    );
    SDL_UpdateTexture(texture, null, layer.image_data.data, layer.buffer_width * 4);
    SDL_RenderCopy(
      renderer,
      texture,
      utils.create_rect(layer.buffer_x, layer.buffer_y, layer.buffer_width, layer.buffer_height).ref(),
      utils.create_rect(layer.screen_x, layer.screen_y, layer.buffer_width, layer.buffer_height).ref()
    );
    SDL_DestroyTexture(texture);
  });
  /*data.forEach(layer => {
    SDL_SetRenderDrawColor(renderer, 0, 255, 0, 255);
    SDL_RenderDrawRect(renderer, utils.create_rect(
      layer.screen_x,
      layer.screen_y,
      layer.buffer_width,
      layer.buffer_height
    ).ref());
  });*/
  SDL_SetRenderTarget(renderer, null);
  SDL_RenderCopy(renderer, graphical_texture, null, null);
  flip_screen();
});
e.bus.register('screen-put-char', function(data) {
  if (!disable_text && data[0] < text_mode_count[1] && data[1] < text_mode_count[0]) {
    const p = 3 * (data[0] * text_mode_count[0] + data[1]);

    text_mode_data[p] = data[2];
    text_mode_data[p + 1] = data[3];
    text_mode_data[p + 2] = data[4];

    changed_rows[data[0]] = 1;
  }
});
e.add_listener('ide-read-start', function() {
  is_loading = true;
  update_title();
});
e.add_listener('ide-read-end', function() {
  is_loading = false;
  update_title();
});
if (use_serial) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  e.bus.register('serial0-output-char', function(chr) {
    process.stdout.write(chr);
  });
  process.stdin.on('data', function(c) {
    e.bus.send('serial0-input', c);
  });
}

function update_title() {
  SDL_SetWindowTitle(
    window,
    'v86-sdl2 (' + machine_name + ') -' +
    ' [' + (is_graphical ? vga_mode_size[0] * vga_mode_scale[0] : text_mode_size[0]) +
    'x' + (is_graphical ? vga_mode_size[1] * vga_mode_scale[1] : text_mode_size[1]) + ']' +
    ' [' + (is_loading ? 'Loading...' : 'Idle') + ']'
  );
}

function text_update_row(row) {
  var offset = 3 * row * text_mode_count[0];

  var bg_color,
    fg_color,
    text;

  for (var i = 0; i < text_mode_count[0];) {
    bg_color = text_mode_data[offset + 1];
    fg_color = text_mode_data[offset + 2];

    text = '';

    while (i < text_mode_count[0] &&
      text_mode_data[offset + 1] == bg_color &&
      text_mode_data[offset + 2] == fg_color) {
      var ascii = text_mode_data[offset];

      text += charmap[ascii];

      i++;
      offset += 3;
    }
    const str_surface = TTF_RenderUTF8_Shaded(
      font,
      text,
      screen_tools.number_as_color(fg_color),
      screen_tools.number_as_color(bg_color)
    );
    const str_texture = SDL_CreateTextureFromSurface(renderer, str_surface);
    SDL_RenderCopy(renderer, str_texture, null, utils.create_rect(
      (i - text.length) * char_size[0],
      row * char_size[1],
      text.length * char_size[0],
      char_size[1]
    ).ref());
    SDL_DestroyTexture(str_texture);
    SDL_FreeSurface(str_surface);
  }
}

function flip_screen() {
  SDL_RenderPresent(renderer);
}

function update() {
  if (is_graphical) {
    e.bus.send('screen-fill-buffer');
  } else if (text_texture) {
    SDL_SetRenderTarget(renderer, text_texture);
    for (var i = 0; i < text_mode_count[1]; i++) {
      if (changed_rows[i]) {
        text_update_row(i);
        changed_rows[i] = 0;
      }
    }
    SDL_SetRenderTarget(renderer, null);
    SDL_RenderCopy(renderer, text_texture, null, null);
    flip_screen();
  }
  tick();
}

function resize_window(w, h) {
  if (!w) {
    w = is_graphical ? vga_mode_size[0] * vga_mode_scale[0] : text_mode_size[0];
  }
  if (!h) {
    h = is_graphical ? vga_mode_size[1] * vga_mode_scale[1] : text_mode_size[1];
  }
  SDL_SetWindowSize(window, w, h);
  if (!config.center_window)
    return;
  const dm = new SDL_DisplayMode;
  if (SDL_GetCurrentDisplayMode(0, dm.ref()))
    return;
  SDL_SetWindowPosition(
    window,
    (dm.w - w) >> 1,
    (dm.h - h) >> 1
  );
}

function keyboard_send_scancodes(codes) {
  for (var i = 0; i < codes.length; i++) {
    e.bus.send('keyboard-code', codes[i]);
  }
}

function tick() {
  const event = new SDL_Event;
  while (SDL_PollEvent(event.ref())) {
    switch (event.type) {
      case SDL_MOUSEMOTION:
        if (mouse_locked)
          e.bus.send('mouse-delta', [event.motion.xrel * mouse_sens, -event.motion.yrel * mouse_sens]);
        break;
      case SDL_KEYDOWN:
        if (mouse_locked) {
          if (event.key.keysym.sym == SDLK_ESCAPE)
            break;
          e.bus.send('keyboard-code', keyboard.sdl_keysym_to_scancode(event.key.keysym.sym));
        } else if (event.key.keysym.sym == SDLK_ESCAPE) {
          e.bus.send('keyboard-code', 0x01);
        } else if (event.key.keysym.sym == SDLK_F1) {
          keyboard_send_scancodes([
            0x1D, // ctrl
            0x38, // alt
            0x53 // delete
          ]);
        }
        break;
      case SDL_KEYUP:
        if (mouse_locked) {
          if (event.key.keysym.sym == SDLK_ESCAPE) {
            mouse_locked = false;
            SDL_SetRelativeMouseMode(0);
            break;
          }
          e.bus.send('keyboard-code', keyboard.sdl_keysym_to_scancode(event.key.keysym.sym) | 0x80);
          break;
        } else if (event.key.keysym.sym == SDLK_ESCAPE) {
          e.bus.send('keyboard-code', 0x01 | 0x80);
        } else if (event.key.keysym.sym == SDLK_F1) {
          keyboard_send_scancodes([
            0x1D | 0x80,
            0x38 | 0x80,
            0x53 | 0x80
          ]);
        }
        break;
      case SDL_MOUSEBUTTONDOWN:
        if (mouse_locked && SDL_BUTTON_RIGHT >= event.button.button >= SDL_BUTTON_LEFT) {
          mouse_buttons[event.button.button - 1] = true;
          e.bus.send('mouse-click', mouse_buttons);
        }
        break;
      case SDL_MOUSEBUTTONUP:
        if (mouse_locked && SDL_BUTTON_RIGHT >= event.button.button >= SDL_BUTTON_LEFT) {
          mouse_buttons[event.button.button - 1] = false;
          e.bus.send('mouse-click', mouse_buttons);
        } else {
          mouse_locked = true;
          SDL_SetRelativeMouseMode(1);
        }
        break;
      case SDL_MOUSEWHEEL:
        if (mouse_locked)
          e.bus.send('mouse-wheel', [Math.min(Math.max(event.wheel.y, -1), 1), 0]);
        break;
      case SDL_QUIT:
        if (mouse_locked)
          break;
        if (use_serial)
          process.stdin.pause();
        e.destroy().then(function() {
          SDL_DestroyRenderer(renderer);
          SDL_DestroyWindow(window);
          if (!disable_text) {
            TTF_CloseFont(font);
            TTF_Quit();
          }
          SDL_Quit();
          process.exit(0);
        });
        return;
    }
  }
  setImmediate(update);
}
