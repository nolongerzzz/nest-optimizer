/* PNG read. Node only - not shipped.
 *
 * nso_raster_lines.js decodes nothing on purpose: in the browser a canvas
 * hands back an ImageData for every format the browser can open. That is the
 * shipped path and app-raster.js uses it. But the CHECKS have to be able to
 * open a real PNG - one this repo did not draw itself, in the format a person
 * actually uploads - and Node has no image decoder. tools/nso_pnm.js covers
 * netpbm, which no one exports from a drawing program.
 *
 * So this is the Node-side PNG decoder: zlib (stdlib) for the IDAT stream and
 * the five PNG filters by hand. It returns exactly the shape toMask takes -
 * { width, height, data, channels } - so a decoded PNG and a browser
 * ImageData are the same object to everything downstream.
 *
 * Handles every non-interlaced colour type and bit depth the spec allows:
 * grey 1/2/4/8/16, RGB 8/16, palette 1/2/4/8 (+tRNS), grey+alpha and RGBA
 * 8/16. 16-bit samples are taken high byte only - toMask thresholds to ink or
 * not-ink, so the low byte cannot change an answer. Adam7 interlacing is
 * refused by name rather than decoded wrong: nothing exports it by default and
 * a silent half-image would be worse than a stop.
 *
 * JPEG is deliberately NOT here. A baseline JPEG decoder is a thousand lines
 * of Huffman and IDCT to re-implement what every browser already has, and the
 * shipped path IS the browser. tools/nso_raster_real_drive_check.mjs opens the
 * JPEG fixtures in real Chromium through the real file input instead, which
 * tests the decoder that actually runs in production rather than a second one
 * written to agree with it.
 */
'use strict';

const fs = require('fs');
const zlib = require('zlib');

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/* samples per pixel, by PNG colour type */
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
}

/* readPNG(file) -> { width, height, data, channels } - toMask's shape.
   Throws with the file named on anything it cannot honestly decode. */
function readPNG(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 8) throw new Error(file + ': too short to be a PNG');
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== SIG[i]) throw new Error(file + ': not a PNG (bad signature)');
  }

  let at = 8, ihdr = null, plte = null, trns = null;
  const idat = [];
  while (at + 8 <= buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    const body = at + 8;
    if (body + len + 4 > buf.length) throw new Error(file + ': chunk ' + type + ' runs past the end');
    if (type === 'IHDR') {
      ihdr = {
        width: buf.readUInt32BE(body), height: buf.readUInt32BE(body + 4),
        depth: buf[body + 8], colour: buf[body + 9],
        compression: buf[body + 10], filter: buf[body + 11], interlace: buf[body + 12]
      };
    } else if (type === 'PLTE') plte = buf.subarray(body, body + len);
    else if (type === 'tRNS') trns = buf.subarray(body, body + len);
    else if (type === 'IDAT') idat.push(buf.subarray(body, body + len));
    else if (type === 'IEND') break;
    at = body + len + 4;              /* + CRC, which zlib's own check covers */
  }

  if (!ihdr) throw new Error(file + ': no IHDR');
  const { width: w, height: h, depth, colour, interlace } = ihdr;
  if (!(w > 0 && h > 0)) throw new Error(file + ': ' + w + ' x ' + h + ' is not an image');
  if (ihdr.compression !== 0) throw new Error(file + ': compression method ' + ihdr.compression + ' is not deflate');
  if (ihdr.filter !== 0) throw new Error(file + ': filter method ' + ihdr.filter + ' is not the standard one');
  if (interlace !== 0) throw new Error(file + ': Adam7 interlacing is not decoded here - re-export without interlace');
  if (CHANNELS[colour] === undefined) throw new Error(file + ': colour type ' + colour + ' is not 0, 2, 3, 4 or 6');
  if (!idat.length) throw new Error(file + ': no IDAT');
  if (colour === 3 && !plte) throw new Error(file + ': palette image with no PLTE');

  const allowed = colour === 3 ? [1, 2, 4, 8] : (colour === 0 ? [1, 2, 4, 8, 16] : [8, 16]);
  if (allowed.indexOf(depth) < 0) {
    throw new Error(file + ': bit depth ' + depth + ' is not allowed for colour type ' + colour);
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = CHANNELS[colour];
  const bpp = Math.max(1, (ch * depth) >> 3);       /* filter stride, >= 1 byte */
  const rowBytes = Math.ceil(w * ch * depth / 8);
  if (raw.length < h * (rowBytes + 1)) {
    throw new Error(file + ': inflated to ' + raw.length + ' bytes, short of ' + h * (rowBytes + 1));
  }

  /* undo the per-scanline filter, in place, into one contiguous block */
  const lines = Buffer.alloc(h * rowBytes);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (rowBytes + 1)];
    const src = y * (rowBytes + 1) + 1;
    const dst = y * rowBytes, up = dst - rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const a = x >= bpp ? lines[dst + x - bpp] : 0;
      const b = y > 0 ? lines[up + x] : 0;
      const c = (x >= bpp && y > 0) ? lines[up + x - bpp] : 0;
      const v = raw[src + x];
      let out;
      if (ft === 0) out = v;
      else if (ft === 1) out = v + a;
      else if (ft === 2) out = v + b;
      else if (ft === 3) out = v + ((a + b) >> 1);
      else if (ft === 4) out = v + paeth(a, b, c);
      else throw new Error(file + ': row ' + y + ' has filter type ' + ft + ', which is not 0..4');
      lines[dst + x] = out & 0xff;
    }
  }

  /* samples -> 8-bit, and a palette index -> its RGB(A) entry */
  const outCh = colour === 3 ? (trns ? 4 : 3) : ch;
  const data = new Uint8Array(w * h * outCh);
  const maxIn = (1 << depth) - 1;
  const sampleAt = (row, i) => {
    if (depth === 16) return lines[row + i * 2];              /* high byte */
    if (depth === 8) return lines[row + i];
    const per = 8 / depth;                                    /* 1, 2 or 4 samples per byte */
    const byte = lines[row + ((i / per) | 0)];
    const shift = 8 - depth * ((i % per) + 1);
    return (byte >> shift) & maxIn;
  };

  for (let y = 0; y < h; y++) {
    const row = y * rowBytes;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * outCh;
      if (colour === 3) {
        const ix = sampleAt(row, x);
        if ((ix + 1) * 3 > plte.length) throw new Error(file + ': palette index ' + ix + ' is past the PLTE');
        data[o] = plte[ix * 3]; data[o + 1] = plte[ix * 3 + 1]; data[o + 2] = plte[ix * 3 + 2];
        if (trns) data[o + 3] = ix < trns.length ? trns[ix] : 255;
      } else {
        for (let k = 0; k < ch; k++) {
          const s = sampleAt(row, x * ch + k);
          /* a sub-8-bit grey is 0..maxIn and has to be stretched to 0..255,
             or a 1-bit black-and-white PNG reads as 0 and 1 - both ink */
          data[o + k] = depth < 8 ? Math.round(s * 255 / maxIn) : s;
        }
      }
    }
  }

  return { width: w, height: h, data: data, channels: outCh };
}

module.exports = { readPNG: readPNG };
