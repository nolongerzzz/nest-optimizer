/* nso_exif.js - the smallest EXIF reader that answers the capture contract.

   Loads as a classic script (window.NSO_Exif) and as a Node module
   (require('../nso_exif.js')). No DOM, no dependencies. Input is an
   ArrayBuffer/Uint8Array of a whole file; output is a plain object.

   ---------------------------------------------------------------------------
   SCOPE, stated first because it is the whole design
   ---------------------------------------------------------------------------
   This module exists to answer section 4 of docs/PHOTOGRAMMETRY-CAPTURE.md -
   "Camera settings, fixed for the whole capture" - and nothing else. The tags
   it reads are exactly the ones a contract check asks about:

       focal length, lens identity   the first table row: no zoom, no lens switch
       aperture, ISO, shutter        the exposure rows
       flash                         section 3's "no on-camera flash"
       CustomRendered, SceneCaptureType  the HDR / night / portrait row
       DateTimeOriginal              section 5.3's "not re-lit between halves"
       pixel dimensions, orientation the format row
       Make / Model / Software       whether the file is straight off a camera

   It is NOT a general EXIF library. It does not write, does not decode
   MakerNotes, does not do GPS, does not do XMP or IPTC, and does not handle
   TIFF, HEIC or PNG containers. Those are all real things and none of them is
   needed to decide whether a photo set is in contract. A file this module
   cannot read is not an error: it returns null, the caller reports "no EXIF",
   and the optics checks stand down for that frame instead of guessing. That
   distinction - absent evidence versus evidence of a violation - is the whole
   reason this is a module and not four regexes.

   ---------------------------------------------------------------------------
   WHY IT NEVER THROWS
   ---------------------------------------------------------------------------
   The input is a file a photographer picked. It may be truncated, it may be a
   PNG named .jpg, it may be a 4 GB video, it may be adversarially malformed.
   Every read below is bounds-checked and every failure path returns null or
   omits the field. A parser that throws on a bad frame would take down the
   report for the other 92, which is precisely backwards: a frame that cannot
   be read is itself a finding worth showing.

   ---------------------------------------------------------------------------
   API
   ---------------------------------------------------------------------------
   read(buf)               -> tags object | null      (null = no EXIF found)
   jpegSize(buf)           -> {width, height} | null  (from SOF, no EXIF needed)
   isJPEG(buf)             -> boolean
   describeRendering(tags) -> string                  human summary of the mode tags
 */
(function (root) {
  'use strict';

  /* ---- TIFF/EXIF tag numbers, only the ones section 4 asks about ---- */
  var IFD0 = {
    0x010f: 'Make',
    0x0110: 'Model',
    0x0112: 'Orientation',
    0x0131: 'Software',
    0x0132: 'DateTime',
    0x011a: 'XResolution',
    0x011b: 'YResolution'
  };
  var EXIF_TAGS = {
    0x829a: 'ExposureTime',
    0x829d: 'FNumber',
    0x8822: 'ExposureProgram',
    0x8827: 'ISO',
    0x9003: 'DateTimeOriginal',
    0x9004: 'DateTimeDigitized',
    0x9201: 'ShutterSpeedValue',
    0x9202: 'ApertureValue',
    0x9209: 'Flash',
    0x920a: 'FocalLength',
    0xa002: 'PixelXDimension',
    0xa003: 'PixelYDimension',
    0xa401: 'CustomRendered',
    0xa402: 'ExposureMode',
    0xa403: 'WhiteBalance',
    0xa405: 'FocalLengthIn35mmFilm',
    0xa406: 'SceneCaptureType',
    0xa40a: 'Sharpness',
    0xa434: 'LensModel',
    0xa433: 'LensMake'
  };
  var EXIF_IFD_POINTER = 0x8769;

  /* TIFF value types -> byte width. 0 marks a type we do not decode. */
  var TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

  function bytesOf(buf) {
    if (!buf) return null;
    if (buf instanceof Uint8Array) return buf;
    if (typeof ArrayBuffer !== 'undefined' && buf instanceof ArrayBuffer) return new Uint8Array(buf);
    /* Node Buffer is already a Uint8Array; anything array-like we can wrap. */
    if (typeof buf.length === 'number') { try { return Uint8Array.from(buf); } catch (e) { return null; } }
    return null;
  }

  function isJPEG(buf) {
    var b = bytesOf(buf);
    return !!(b && b.length > 3 && b[0] === 0xff && b[1] === 0xd8);
  }

  /* ---- a bounds-checked little/big-endian reader over one Uint8Array ---- */
  function View(b, little) {
    this.b = b;
    this.little = little;
  }
  View.prototype.u8 = function (at) {
    return (at < 0 || at >= this.b.length) ? null : this.b[at];
  };
  View.prototype.u16 = function (at) {
    if (at < 0 || at + 1 >= this.b.length) return null;
    return this.little ? (this.b[at] | (this.b[at + 1] << 8))
                       : ((this.b[at] << 8) | this.b[at + 1]);
  };
  View.prototype.u32 = function (at) {
    if (at < 0 || at + 3 >= this.b.length) return null;
    var v = this.little
      ? (this.b[at] | (this.b[at + 1] << 8) | (this.b[at + 2] << 16) | (this.b[at + 3] << 24))
      : ((this.b[at] << 24) | (this.b[at + 1] << 16) | (this.b[at + 2] << 8) | this.b[at + 3]);
    return v >>> 0;                       /* unsigned - offsets are never negative */
  };
  View.prototype.i32 = function (at) {
    var v = this.u32(at);
    return v === null ? null : (v | 0);
  };
  View.prototype.ascii = function (at, n) {
    if (at < 0 || n <= 0 || at + n > this.b.length) return null;
    var s = '';
    for (var i = 0; i < n; i++) {
      var c = this.b[at + i];
      if (c === 0) break;                 /* EXIF ASCII is NUL-terminated */
      if (c < 0x20 || c > 0x7e) c = 0x20; /* keep the result printable */
      s += String.fromCharCode(c);
    }
    return s.replace(/\s+$/, '');
  };

  /* A RATIONAL is a pair of LONGs. Denominator 0 appears in the wild (it is how
     some phones write "unknown"); it becomes null rather than Infinity. */
  function rational(view, at, signed) {
    var n = signed ? view.i32(at) : view.u32(at);
    var d = signed ? view.i32(at + 4) : view.u32(at + 4);
    if (n === null || d === null || d === 0) return null;
    return n / d;
  }

  /* Decode one 12-byte IFD entry's value. `tiff` is the offset of the TIFF
     header, which every value offset in the IFD is relative to. */
  function readValue(view, entryAt, tiff) {
    var type = view.u16(entryAt + 2);
    var count = view.u32(entryAt + 4);
    if (type === null || count === null) return null;
    var size = TYPE_SIZE[type];
    if (!size) return null;
    var total = size * count;
    if (total > 0x7fffffff) return null;                 /* absurd count: malformed */
    /* Up to 4 bytes live inline in the entry; more lives at an offset. */
    var at = entryAt + 8;
    if (total > 4) {
      var off = view.u32(entryAt + 8);
      if (off === null) return null;
      at = tiff + off;
      if (at < 0 || at + total > view.b.length) return null;
    }

    if (type === 2) return view.ascii(at, count);        /* ASCII */
    if (type === 5) return rational(view, at, false);    /* RATIONAL */
    if (type === 10) return rational(view, at, true);    /* SRATIONAL */
    if (type === 3) return view.u16(at);                 /* SHORT */
    if (type === 4) return view.u32(at);                 /* LONG */
    if (type === 9) return view.i32(at);                 /* SLONG */
    if (type === 1 || type === 6 || type === 7) return view.u8(at);
    return null;
  }

  /* Walk one IFD, writing the tags named in `names` into `out`. Returns the
     ExifIFD pointer if this IFD carried one. */
  function walkIFD(view, ifdAt, tiff, names, out) {
    var count = view.u16(ifdAt);
    if (count === null || count > 512) return null;      /* 512 entries is already absurd */
    var sub = null;
    for (var i = 0; i < count; i++) {
      var entryAt = ifdAt + 2 + i * 12;
      if (entryAt + 12 > view.b.length) break;
      var tag = view.u16(entryAt);
      if (tag === null) break;
      if (tag === EXIF_IFD_POINTER) {
        var off = readValue(view, entryAt, tiff);
        if (typeof off === 'number') sub = tiff + off;
        continue;
      }
      var name = names[tag];
      if (!name) continue;
      var v = readValue(view, entryAt, tiff);
      if (v !== null && v !== '') out[name] = v;
    }
    return sub;
  }

  /* Parse a TIFF block (the payload of APP1 after "Exif\0\0"). */
  function readTIFF(b, tiff) {
    if (tiff + 8 > b.length) return null;
    var order = (b[tiff] << 8) | b[tiff + 1];
    var little;
    if (order === 0x4949) little = true;          /* "II" */
    else if (order === 0x4d4d) little = false;    /* "MM" */
    else return null;
    var view = new View(b, little);
    if (view.u16(tiff + 2) !== 0x002a) return null;   /* the 42 that says "TIFF" */
    var ifd0 = view.u32(tiff + 4);
    if (ifd0 === null || tiff + ifd0 + 2 > b.length) return null;

    var out = {};
    var exifAt = walkIFD(view, tiff + ifd0, tiff, IFD0, out);
    if (exifAt !== null && exifAt >= 0 && exifAt + 2 <= b.length) {
      walkIFD(view, exifAt, tiff, EXIF_TAGS, out);
    }
    return out;
  }

  /* Scan the JPEG segment chain for APP1/Exif. Segments are
     FF <marker> <len hi> <len lo> <len-2 bytes of payload>. */
  function read(buf) {
    var b = bytesOf(buf);
    if (!b || !isJPEG(b)) return null;
    var at = 2;
    var guard = 0;
    while (at + 4 <= b.length && guard++ < 4096) {
      if (b[at] !== 0xff) { at++; continue; }          /* resync over fill bytes */
      var marker = b[at + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
      if (marker === 0xda || marker === 0xd9) break;   /* SOS / EOI: no more headers */
      var len = (b[at + 2] << 8) | b[at + 3];
      if (len < 2 || at + 2 + len > b.length) break;
      if (marker === 0xe1) {
        var p = at + 4;
        if (p + 6 <= b.length &&
            b[p] === 0x45 && b[p + 1] === 0x78 && b[p + 2] === 0x69 &&
            b[p + 3] === 0x66 && b[p + 4] === 0x00) {
          var tags = readTIFF(b, p + 6);
          if (tags && Object.keys(tags).length) return tags;
        }
      }
      at += 2 + len;
    }
    return null;
  }

  /* Frame size straight off the SOF marker. Works with no EXIF at all, which
     matters: a re-exported frame usually keeps its pixels and loses its tags,
     and a size mismatch across the set is a finding either way. */
  function jpegSize(buf) {
    var b = bytesOf(buf);
    if (!b || !isJPEG(b)) return null;
    var at = 2, guard = 0;
    while (at + 4 <= b.length && guard++ < 4096) {
      if (b[at] !== 0xff) { at++; continue; }
      var m = b[at + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { at += 2; continue; }
      if (m === 0xda || m === 0xd9) break;
      var len = (b[at + 2] << 8) | b[at + 3];
      if (len < 2 || at + 2 + len > b.length) break;
      /* SOF0-3, 5-7, 9-11, 13-15 all carry the frame header. C4/C8/CC do not. */
      var isSOF = (m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
      if (isSOF && at + 9 <= b.length) {
        var h = (b[at + 5] << 8) | b[at + 6];
        var w = (b[at + 7] << 8) | b[at + 8];
        if (w > 0 && h > 0) return { width: w, height: h };
      }
      at += 2 + len;
    }
    return null;
  }

  /* The mode tags in words. CustomRendered is the one that catches an iPhone
     shooting HDR or portrait; SceneCaptureType 3 is night mode. Both are
     section 4's "processing" row, and both are advisory-strength evidence:
     the tag being clean does not prove the mode was off, it only means the
     camera did not admit to it. */
  var CUSTOM_RENDERED = {
    0: 'normal', 1: 'custom', 2: 'HDR', 3: 'HDR', 4: 'original for HDR',
    6: 'panorama', 7: 'portrait HDR', 8: 'portrait'
  };
  var SCENE_CAPTURE = { 0: 'standard', 1: 'landscape', 2: 'portrait', 3: 'night' };

  function describeRendering(tags) {
    if (!tags) return '';
    var bits = [];
    if (typeof tags.CustomRendered === 'number' && tags.CustomRendered !== 0) {
      bits.push(CUSTOM_RENDERED[tags.CustomRendered] || ('custom rendering ' + tags.CustomRendered));
    }
    if (tags.SceneCaptureType === 3) bits.push('night mode');
    if (typeof tags.Flash === 'number' && (tags.Flash & 1)) bits.push('flash fired');
    return bits.join(', ');
  }

  var API = {
    read: read,
    jpegSize: jpegSize,
    isJPEG: isJPEG,
    describeRendering: describeRendering,
    CUSTOM_RENDERED: CUSTOM_RENDERED,
    SCENE_CAPTURE: SCENE_CAPTURE
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.NSO_Exif = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
