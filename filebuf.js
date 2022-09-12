/**
 * Asynchronous buffer with writeback support
 *
 * @constructor
 * @param {string} filename Name of the file to download
 * @param {boolean} writeback Allow writeback
 * @param {number|undefined} size
 */
function AsyncNodeJSBuffer(filename, writeback, size) {
  this.fs = require("fs");
  this.filename = filename;
  this.writeback = writeback;
  this.byteLength = size || this.fs.statSync(filename).size;

  this.fd = 0;

  this.onload = undefined;
  this.onprogress = undefined;
}

AsyncNodeJSBuffer.prototype.load = function() {
  this.fs.open(this.filename, this.writeback ? "r+" : "r", (error, fd) => {
    if (error) {
      throw new Error("Cannot load: " + this.filename + ". " + error);
    } else {
      this.fd = fd;
      this.onload && this.onload(Object.create(null));
    }
  });
}

AsyncNodeJSBuffer.prototype.destroy = function() {
  this.fs.close(this.fd, error => {
    if (error) {
      throw new Error("Cannot close: " + this.filename + ". " + error);
    }
  });
}

/**
 * @param {number} offset
 * @param {number} len
 * @param {function(!Uint8Array)} fn
 */
AsyncNodeJSBuffer.prototype.get = function(offset, len, fn) {
  const buffer = new Uint8Array(len);
  this.fs.read(this.fd, buffer, 0, len, offset, (error, bytesRead, buffer) => {
    if (error) {
      throw new Error("Cannot read: " + this.filename + ". " + error);
    } else {
      fn(buffer);
    }
  });
}

/**
 * @param {number} start
 * @param {!Uint8Array} data
 * @param {function()} fn
 */
AsyncNodeJSBuffer.prototype.set = function(start, data, fn) {
  if (!this.writeback)
    return;
  console.assert(start + data.byteLength <= this.byteLength);
  this.fs.write(this.fd, data, 0, data.byteLength, start, (error, bytesWritten, data) => {
    if (error) {
      throw new Error("Cannot write: " + this.filename + ". " + error);
    } else {
      fn();
    }
  });
};

AsyncNodeJSBuffer.prototype.get_buffer = function(fn) {
  fn();
};

AsyncNodeJSBuffer.prototype.get_state = function() {
  // All changes should be written to disk
  return [];
};

AsyncNodeJSBuffer.prototype.set_state = function(state) {
  return;
};

exports.AsyncNodeJSBuffer = AsyncNodeJSBuffer;
