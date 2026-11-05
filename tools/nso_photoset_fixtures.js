/* nso_photoset_fixtures.js - JPEG/EXIF fixtures, built byte by byte.

   Node only, not shipped. Shared by tools/nso_photoset_test.js (which needs
   EXIF to parse, and no pixels) and tools/nso_photoset_drive_check.js (which
   needs real decodable pixels AND EXIF, so it renders the pixels in the
   browser and splices an APP1 segment onto the front here).

   Why build the EXIF rather than commit a photograph: the checks in
   nso_photoset.js turn on exact tag values - one focal length changing, one
   frame with the flash bit set, one night-mode frame among 93. Committing a
   binary for each of those cases would be a dozen opaque blobs nobody can
   review; a builder makes each case one readable line, and the parser is
   exercised on bytes it did not produce either way.

   API
     buildTIFF(ifd0Entries, exifEntries) -> Uint8Array   a TIFF block
     buildJPEG({tiff, width, height})    -> Uint8Array   SOI/APP1/SOF0/EOI
     spliceExif(jpegBytes, tiffBytes)    -> Uint8Array   APP1 onto a real JPEG
     exifFor(overrides)                  -> Uint8Array   the standard in-contract tags
     T                                   the TIFF type numbers
 */
'use strict';

const T = { BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5 };

function entryBytes(e) {
  const out = [];
  if (e.type === T.ASCII) {
    for (const ch of e.value) out.push(ch.charCodeAt(0) & 0x7f);
    out.push(0);
  } else if (e.type === T.SHORT) {
    for (const v of [].concat(e.value)) out.push(v & 0xff, (v >> 8) & 0xff);
  } else if (e.type === T.LONG) {
    for (const v of [].concat(e.value)) out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  } else if (e.type === T.RATIONAL) {
    const [n, d] = e.value;
    out.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
    out.push(d & 0xff, (d >> 8) & 0xff, (d >> 16) & 0xff, (d >>> 24) & 0xff);
  }
  return out;
}

function entryCount(e) {
  if (e.type === T.ASCII) return e.value.length + 1;
  if (e.type === T.RATIONAL) return 1;
  return [].concat(e.value).length;
}

/* Little-endian TIFF: header, IFD0 (plus an ExifIFD pointer), the Exif IFD,
   then a heap for every value too big to sit inline in its 12-byte entry. */
function buildTIFF(ifd0, exifIfd) {
  const ifd0Size = 2 + 12 * (ifd0.length + 1) + 4;
  const exifOff = 8 + ifd0Size;
  const exifSize = 2 + 12 * exifIfd.length + 4;
  const heap = exifOff + exifSize;

  const head = [0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00];
  const heapBytes = [];

  function writeIFD(entries) {
    const out = [entries.length & 0xff, (entries.length >> 8) & 0xff];
    for (const e of entries) {
      const data = entryBytes(e);
      const count = entryCount(e);
      out.push(e.tag & 0xff, (e.tag >> 8) & 0xff, e.type & 0xff, (e.type >> 8) & 0xff);
      out.push(count & 0xff, (count >> 8) & 0xff, (count >> 16) & 0xff, (count >>> 24) & 0xff);
      if (data.length <= 4) {
        for (let i = 0; i < 4; i++) out.push(data[i] === undefined ? 0 : data[i]);
      } else {
        const at = heap + heapBytes.length;
        out.push(at & 0xff, (at >> 8) & 0xff, (at >> 16) & 0xff, (at >>> 24) & 0xff);
        for (const b of data) heapBytes.push(b);
        if (heapBytes.length % 2) heapBytes.push(0);
      }
    }
    out.push(0, 0, 0, 0);
    return out;
  }

  const ifd0Bytes = writeIFD(ifd0.concat([{ tag: 0x8769, type: T.LONG, value: exifOff }]));
  const exifBytes = writeIFD(exifIfd);
  return Uint8Array.from(head.concat(ifd0Bytes, exifBytes, heapBytes));
}

/* A structurally real but pixel-free JPEG: enough for the segment walker and
   for the SOF frame size, not enough for a decoder. */
function buildJPEG(opts) {
  const o = opts || {};
  const bytes = [0xff, 0xd8];
  if (o.tiff) {
    const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00].concat(Array.from(o.tiff));
    const len = payload.length + 2;
    bytes.push(0xff, 0xe1, (len >> 8) & 0xff, len & 0xff, ...payload);
  }
  const w = o.width || 4032, h = o.height || 3024;
  bytes.push(0xff, 0xc0, 0x00, 0x11, 0x08, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01);
  bytes.push(0xff, 0xd9);
  return Uint8Array.from(bytes);
}

/* APP1 onto a JPEG that already has pixels. The segment goes immediately
   after SOI, which is where a camera puts it and where the reader looks. */
function spliceExif(jpeg, tiff) {
  const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00].concat(Array.from(tiff));
  const len = payload.length + 2;
  if (len > 0xffff) throw new Error('EXIF payload too big for one APP1 segment');
  const head = [0xff, 0xe1, (len >> 8) & 0xff, len & 0xff].concat(payload);
  const out = new Uint8Array(jpeg.length + head.length);
  out.set(jpeg.slice(0, 2), 0);                    /* SOI */
  out.set(Uint8Array.from(head), 2);
  out.set(jpeg.slice(2), 2 + head.length);
  return out;
}

/* The standard in-contract tag set, with any field overridable. The defaults
   are a capture that passes every automatic check: one focal length, one
   lens, fixed f/8, ISO 100, 1/125 s (well inside 1/(2 x 27mm equiv)), no
   flash, no computational mode. */
function exifFor(over) {
  const o = Object.assign({
    make: 'NSOCam', model: 'Bench 1', lens: 'NSO 24mm f/2',
    exposure: [1, 125], fnumber: [80, 10], iso: 100,
    focal: [24, 1], focal35: 27, flash: 16,
    customRendered: 0, sceneCapture: 0,
    when: '2026:03:01 10:00:00', pixelX: 640, pixelY: 480
  }, over || {});
  return buildTIFF(
    [
      { tag: 0x010f, type: T.ASCII, value: o.make },
      { tag: 0x0110, type: T.ASCII, value: o.model }
    ],
    [
      { tag: 0x829a, type: T.RATIONAL, value: o.exposure },
      { tag: 0x829d, type: T.RATIONAL, value: o.fnumber },
      { tag: 0x8827, type: T.SHORT, value: o.iso },
      { tag: 0x9003, type: T.ASCII, value: o.when },
      { tag: 0x9209, type: T.SHORT, value: o.flash },
      { tag: 0x920a, type: T.RATIONAL, value: o.focal },
      { tag: 0xa002, type: T.LONG, value: o.pixelX },
      { tag: 0xa003, type: T.LONG, value: o.pixelY },
      { tag: 0xa401, type: T.SHORT, value: o.customRendered },
      { tag: 0xa405, type: T.SHORT, value: o.focal35 },
      { tag: 0xa406, type: T.SHORT, value: o.sceneCapture },
      { tag: 0xa434, type: T.ASCII, value: o.lens }
    ]
  );
}

module.exports = { T, buildTIFF, buildJPEG, spliceExif, exifFor };
