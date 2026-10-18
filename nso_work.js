/* ============================================================
   nso_work.js - run one of the app's own engine functions in a Web Worker.

   Loads as a classic script (window.NSO_Work). No Node form: a page thing.

   WHY. A big piece (the 947,000-triangle butterfly vase) made the page freeze
   for tens of seconds on a click, because the engines that read a piece - how
   many parts is it, what hangs in air, what can Lift take - are synchronous
   JS and run on the thread the page is painted by. They are pure: a soup in,
   plain data out, no DOM and no THREE. So they can run anywhere, and this puts
   them somewhere else.

   The pattern is the support planner's (app-supports-card.js, "THE PLANNER'S
   THREAD"), made general: a worker is started from a Blob whose source
   importScripts the engine files the page already loaded - the very same URLs,
   found from the page's own <script> tags, so there is no second copy of any
   engine and a ?v= bump is picked up - and then calls one function by path.

     NSO_Work.run('split', ['nso_thickness.js', 'nso_hollow.js', 'nso_split_parts.js'],
                  'NSO_SplitParts.analyse', [soup])      -> { promise, cancel() }

   One worker per CHANNEL ('split', 'lift', ...), jobs on a channel run one at a
   time in the order given, and cancel() ends the job: the one running is
   stopped by ending the worker (a synchronous engine cannot be asked to stop;
   the next job starts a fresh one), a queued one is just dropped. The promise
   of a cancelled job never settles - whoever cancelled has moved on.

   The arguments are copied in (the page keeps its arrays). A function may
   return a promise; it is waited for. The result comes
   back by structured clone, unless the function returns
   NSO_Work.transfer(value, [buffers]) - available inside the worker as the
   same name - in which case the buffers are moved, not copied.

   isAvailable() says whether a worker can be started at all; a caller keeps
   its in-thread path for the page (and the headless check) that cannot.
   ============================================================ */
(function (root) {
  'use strict';

  var canWorker = typeof Worker === 'function' && typeof Blob === 'function' &&
    typeof URL === 'function' && !!URL.createObjectURL;
  var channels = Object.create(null);
  var seq = 0;

  /* What runs in the worker. `transfer` is the one name an engine wrapper can use. */
  var WORKER_SRC = [
    'var loaded = {};',
    'self.NSO_Work = { transfer: function (value, list) { return { __nsoTransfer: true, value: value, list: list || [] }; } };',
    'self.onmessage = function (e) {',
    '  var d = e.data, out;',
    '  try {',
    '    d.urls.forEach(function (u) { if (!loaded[u]) { importScripts(u); loaded[u] = 1; } });',
    '    var fn = self, owner = null;',
    '    d.path.split(".").forEach(function (k) { owner = fn; fn = fn[k]; });',
    '    var r = fn.apply(owner, d.args);',
    '    var send = function (r) {',
    '      if (r && r.__nsoTransfer) self.postMessage({ id: d.id, result: r.value }, r.list);',
    '      else self.postMessage({ id: d.id, result: r });',
    '    };',
    '    if (r && typeof r.then === "function") {',
    '      r.then(send, function (err) { self.postMessage({ id: d.id, error: (err && err.message) || String(err) }); });',
    '    } else send(r);',
    '  } catch (err) {',
    '    self.postMessage({ id: d.id, error: (err && err.message) || String(err) });',
    '  }',
    '};'
  ].join('\n');

  /* The URLs of the engine files, from the page's own script tags. null if one is not there. */
  function urlsOf(names) {
    if (typeof document === 'undefined') return null;
    var out = [];
    for (var i = 0; i < names.length; i++) {
      var el = document.querySelector('script[src^="' + names[i] + '"]');
      if (!el || !el.src) return null;
      out.push(el.src);
    }
    return out;
  }

  function spawn() {
    var url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
    var w;
    try { w = new Worker(url); } catch (err) { URL.revokeObjectURL(url); return null; }
    URL.revokeObjectURL(url);
    return w;
  }

  function channelOf(name) {
    return channels[name] || (channels[name] = { worker: null, queue: [], running: null });
  }

  function pump(ch) {
    if (ch.running || !ch.queue.length) return;
    var job = ch.queue.shift();
    if (job.dead) return pump(ch);
    if (!ch.worker) ch.worker = spawn();
    if (!ch.worker) { job.reject(new Error('no worker')); return pump(ch); }
    ch.running = job;
    var w = ch.worker;
    w.onmessage = function (e) {
      if (!ch.running || e.data.id !== ch.running.id) return;
      var j = ch.running; ch.running = null;
      if (e.data.error) j.reject(new Error(e.data.error)); else j.resolve(e.data.result);
      pump(ch);
    };
    w.onerror = function (ev) {
      var j = ch.running; ch.running = null;
      try { w.terminate(); } catch (x) { /* already gone */ }
      ch.worker = null;
      if (j) j.reject(new Error((ev && ev.message) || 'the worker failed'));
      pump(ch);
    };
    try {
      w.postMessage({ id: job.id, urls: job.urls, path: job.path, args: job.args }, job.transfer || []);
    } catch (err) {
      ch.running = null;
      job.reject(err);
      pump(ch);
    }
  }

  function run(channel, names, path, args, opts) {
    var urls = canWorker ? urlsOf(names) : null;
    var job = { id: ++seq, urls: urls, path: path, args: args, transfer: opts && opts.transfer, dead: false };
    var promise = new Promise(function (resolve, reject) { job.resolve = resolve; job.reject = reject; });
    var ch = channelOf(channel);
    if (!urls) {
      job.reject(new Error(canWorker ? 'an engine file is not on the page' : 'no worker'));
      promise.catch(function () { /* the caller's own catch decides */ });
      return { promise: promise, cancel: function () {} };
    }
    ch.queue.push(job);
    pump(ch);
    return {
      promise: promise,
      cancel: function () {
        job.dead = true;
        var qi = ch.queue.indexOf(job);
        if (qi >= 0) ch.queue.splice(qi, 1);
        if (ch.running === job) {
          ch.running = null;
          try { ch.worker.terminate(); } catch (x) { /* already gone */ }
          ch.worker = null;
          pump(ch);
        }
      }
    };
  }

  var api = {
    run: run,
    isAvailable: function () { return canWorker; },
    /* Whether run() with these engine files would start a worker: a worker can be had and every file is
       a <script> on the page. A caller that asks first keeps its in-thread path for a page that cannot,
       instead of finding out from a rejection. */
    canRun: function (names) { return canWorker && urlsOf(names) !== null; },
    _channels: function () { return channels; }
  };
  if (root) root.NSO_Work = api;
})(typeof window !== 'undefined' ? window : null);
