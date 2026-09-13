/* Classic script. No modules, no imports at this level. */
(function () {
  'use strict';

  function log(s) { document.getElementById('log').textContent += '\n' + s; }

  // --- binary/ASCII STL -> world soup (Float32Array, 9 floats per triangle) --
  function stlToSoup(buf) {
    var bytes = new Uint8Array(buf);
    var head = String.fromCharCode.apply(null, bytes.subarray(0, 300)).toLowerCase();
    if (head.indexOf('solid') === 0 && head.indexOf('facet') > 0) {
      var txt = new TextDecoder().decode(bytes);
      var nums = [];
      var re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g, m;
      while ((m = re.exec(txt))) { nums.push(+m[1], +m[2], +m[3]); }
      return new Float32Array(nums);
    }
    var dv = new DataView(buf);
    var n = dv.getUint32(80, true);
    var out = new Float32Array(n * 9);
    var off = 84, w = 0;
    for (var t = 0; t < n; t++) {
      for (var k = 3; k < 12; k++) out[w++] = dv.getFloat32(off + k * 4, true);
      off += 50;
    }
    return out;
  }

  function fetchSoup(url) {
    return fetch(url).then(function (r) { return r.arrayBuffer(); }).then(stlToSoup);
  }

  function translateSoup(soup, dx, dy, dz) {
    var out = new Float32Array(soup.length);
    for (var i = 0; i < soup.length; i += 3) {
      out[i] = soup[i] + dx; out[i + 1] = soup[i + 1] + dy; out[i + 2] = soup[i + 2] + dz;
    }
    return out;
  }

  // Grid-snap weld, same shape as the app's weldSoupVerts: snap each coord to
  // a tol grid and reuse the first vertex seen in a cell. Included so the bench
  // can measure what the adapter's own pre-weld does to an input, not just what
  // the kernel does after it.
  function weldSoup(soup, tol) {
    if (!tol) return soup;
    var inv = 1 / tol, map = new Map(), out = new Float32Array(soup.length);
    for (var i = 0; i < soup.length; i += 3) {
      var k = Math.round(soup[i] * inv) + '_' + Math.round(soup[i+1] * inv) + '_' + Math.round(soup[i+2] * inv);
      var v = map.get(k);
      if (!v) { v = [soup[i], soup[i+1], soup[i+2]]; map.set(k, v); }
      out[i] = v[0]; out[i+1] = v[1]; out[i+2] = v[2];
    }
    return out;
  }

  // performance.now() is clamped to ~100us in a non-cross-origin-isolated
  // page, so a single sub-ms boolean times as 0. Repeat until the total is
  // well clear of the clamp and divide.
  function timed(fn, reps) {
    var t = performance.now();
    var last = null;
    for (var i = 0; i < reps; i++) {
      if (last && last.delete) last.delete();
      last = fn();
    }
    return { ms: (performance.now() - t) / reps, reps: reps, value: last };
  }

  function soupStats(soup) {
    var n = (soup.length / 9) | 0, vol = 0;
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var t = 0; t < n; t++) {
      var o = t * 9;
      var ax = soup[o], ay = soup[o + 1], az = soup[o + 2];
      var bx = soup[o + 3], by = soup[o + 4], bz = soup[o + 5];
      var cx = soup[o + 6], cy = soup[o + 7], cz = soup[o + 8];
      vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
      for (var v = 0; v < 3; v++) {
        for (var k = 0; k < 3; k++) {
          var p = soup[o + v * 3 + k];
          if (p < lo[k]) lo[k] = p;
          if (p > hi[k]) hi[k] = p;
        }
      }
    }
    return { tris: n, volume: vol / 6, bbox: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] };
  }

  // --- the actual run -------------------------------------------------------
  window.NSO_BENCH = async function (plan) {
    var report = { load: {}, cases: [] };

    var t0 = performance.now();
    var wasm = await NSO_CSG.load();
    report.load.msFirstLoad = performance.now() - t0;

    var t1 = performance.now();
    await NSO_CSG.load();                      // cached promise, should be ~0
    report.load.msCachedLoad = performance.now() - t1;

    report.load.resources = performance.getEntriesByType('resource')
      .filter(function (e) { return /manifold/.test(e.name); })
      .map(function (e) {
        return {
          name: e.name.replace(/^.*\//, ''),
          ms: +e.duration.toFixed(2),
          transferSize: e.transferSize,
          encodedBodySize: e.encodedBodySize,
          decodedBodySize: e.decodedBodySize
        };
      });

    for (var i = 0; i < plan.length; i++) {
      var c = plan[i];
      var rec = { name: c.name, op: c.op, a: c.a, b: c.b };
      try {
        var A = await fetchSoup(c.a);
        var B = await fetchSoup(c.b);
        if (c.offsetB) B = translateSoup(B, c.offsetB[0], c.offsetB[1], c.offsetB[2]);
        if (c.offsetA) A = translateSoup(A, c.offsetA[0], c.offsetA[1], c.offsetA[2]);

        if (c.weldA) { A = weldSoup(A, c.weldA); rec.weldA = c.weldA; }
        if (c.weldB) { B = weldSoup(B, c.weldB); rec.weldB = c.weldB; }

        rec.inA = soupStats(A);
        rec.inB = soupStats(B);

        var reps = c.reps || 20;
        var tc = performance.now();
        for (var k = 0; k < reps; k++) {
          var tmp = NSO_CSG.soupToManifold(wasm, A); tmp.delete();
        }
        rec.msToManifold = (performance.now() - tc) / reps;
        var mA = NSO_CSG.soupToManifold(wasm, A);
        var mB = NSO_CSG.soupToManifold(wasm, B);
        rec.statusA = mA.status();
        rec.statusB = mB.status();
        rec.kernelA = { tris: mA.numTri(), vol: mA.volume(), area: mA.surfaceArea(), genus: mA.genus() };
        rec.kernelB = { tris: mB.numTri(), vol: mB.volume(), area: mB.surfaceArea(), genus: mB.genus() };

        if (rec.statusA !== 'NoError' || rec.statusB !== 'NoError') {
          rec.error = 'input rejected: A=' + rec.statusA + ' B=' + rec.statusB;
          mA.delete(); mB.delete();
          report.cases.push(rec);
          continue;
        }

        // Manifold is lazily evaluated: add()/subtract() return a handle and
        // the CSG is only actually computed when a property is queried. Timing
        // the call alone measures nothing, so force evaluation inside the loop.
        var r = timed(function () {
          var o = (c.op === 'union') ? mA.add(mB) : mA.subtract(mB);
          o.numTri();
          return o;
        }, reps);
        rec.msBoolean = r.ms;
        rec.reps = reps;
        var out = r.value;
        rec.statusOut = out.status();
        rec.empty = out.isEmpty();
        if (!rec.empty) {
          rec.kernelOut = { tris: out.numTri(), vol: out.volume(), area: out.surfaceArea(), genus: out.genus() };
          var tx = performance.now();
          for (var q = 0; q < reps; q++) NSO_CSG.manifoldToSoup(out);
          rec.msToSoup = (performance.now() - tx) / reps;
          var soup = NSO_CSG.manifoldToSoup(out);
          rec.outSoup = soupStats(soup);
          rec.soup = Array.from(soup);       // handed back to node to write an STL
        }
        mA.delete(); mB.delete(); out.delete();
      } catch (err) {
        rec.error = (err && err.message) ? err.message : String(err);
        rec.stack = err && err.stack ? String(err.stack).slice(0, 500) : null;
      }
      report.cases.push(rec);
    }
    return report;
  };

  log('classic scripts parsed; NSO_CSG typeof = ' + typeof NSO_CSG);
})();
