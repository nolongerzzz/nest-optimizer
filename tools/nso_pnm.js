/* Netpbm (PBM/PGM/PPM) read and write. Node only - not shipped.
 *
 * nso_raster_lines.js decodes nothing on purpose: in the browser the canvas
 * already hands back an ImageData, which is exactly the { width, height, data,
 * channels } shape toMask takes, for every format the browser can open (PNG,
 * JPEG, WebP, ...). Node has no such decoder, and the checks need a real file
 * on disk rather than an array built in memory, so the fixtures are netpbm:
 * uncompressed, stdlib-only, byte-for-byte reviewable in a diff, and the one
 * raster format a text editor can still read.
 *
 * Read handles P1/P2/P3 (ASCII) and P4/P5/P6 (binary), 8-bit maxval or less.
 * Write emits P4 (packed 1-bit) or P5 (8-bit grayscale). A binary line-art
 * raster is eight times smaller as P4 and loses nothing, so the committed
 * fixtures are P4 except the one that has to be grayscale to be worth having.
 */
'use strict';

const fs = require('fs');

function readPNM(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 2 || buf[0] !== 0x50) throw new Error(file + ': not a netpbm file');
  const type = buf[1] - 0x30;
  if (type < 1 || type > 6) throw new Error(file + ': P' + (buf[1] - 0x30) + ' is not P1..P6');
  /* the header is whitespace-separated tokens, # to end of line is a comment */
  let at = 2;
  const token = () => {
    let s = '';
    for (;;) {
      if (at >= buf.length) throw new Error(file + ': header ended early');
      const c = buf[at];
      if (c === 0x23) { while (at < buf.length && buf[at] !== 0x0a) at++; continue; }
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
        at++;
        if (s) return s;
        continue;
      }
      s += String.fromCharCode(c);
      at++;
    }
  };
  const w = parseInt(token(), 10), h = parseInt(token(), 10);
  const maxval = (type === 1 || type === 4) ? 1 : parseInt(token(), 10);
  if (!(w > 0) || !(h > 0)) throw new Error(file + ': bad dimensions ' + w + ' x ' + h);
  if (maxval > 255) throw new Error(file + ': maxval ' + maxval + ' - only 8 bit and under');
  const channels = (type === 3 || type === 6) ? 3 : 1;
  const data = new Uint8Array(w * h * channels);
  if (type <= 3) {                                    /* ASCII */
    for (let i = 0; i < data.length; i++) {
      const v = parseInt(token(), 10);
      data[i] = type === 1 ? (v ? 0 : 255) : Math.round(v * 255 / maxval);
    }
  } else if (type === 4) {                            /* packed bits, 1 = black */
    const row = (w + 7) >> 3;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const byte = buf[at + j * row + (i >> 3)];
      data[j * w + i] = (byte >> (7 - (i & 7))) & 1 ? 0 : 255;
    }
  } else {
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.round(buf[at + i] * 255 / maxval);
    }
  }
  return { width: w, height: h, data: data, channels: channels, format: 'P' + type };
}

/* P5, 8-bit grayscale. `data` is one byte per pixel, row major from the top. */
function writePGM(file, w, h, data, comment) {
  if (data.length !== w * h) throw new Error('writePGM: ' + data.length + ' samples for ' + w + ' x ' + h);
  const head = 'P5\n' + (comment ? '# ' + comment.replace(/\n/g, ' ') + '\n' : '') + w + ' ' + h + '\n255\n';
  const buf = Buffer.concat([Buffer.from(head, 'latin1'), Buffer.from(data.buffer, data.byteOffset, data.length)]);
  fs.writeFileSync(file, buf);
  return buf.length;
}

/* P4, packed one bit per pixel, 1 = black. `data` is one byte per pixel as for
 * writePGM: anything under 128 is ink. */
function writePBM(file, w, h, data, comment) {
  if (data.length !== w * h) throw new Error('writePBM: ' + data.length + ' samples for ' + w + ' x ' + h);
  const row = (w + 7) >> 3;
  const bits = Buffer.alloc(row * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (data[j * w + i] < 128) bits[j * row + (i >> 3)] |= 1 << (7 - (i & 7));
  }
  const head = 'P4\n' + (comment ? '# ' + comment.replace(/\n/g, ' ') + '\n' : '') + w + ' ' + h + '\n';
  const buf = Buffer.concat([Buffer.from(head, 'latin1'), bits]);
  fs.writeFileSync(file, buf);
  return buf.length;
}

module.exports = { readPNM, writePGM, writePBM };
