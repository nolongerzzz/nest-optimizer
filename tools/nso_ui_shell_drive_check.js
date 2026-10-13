#!/usr/bin/env node
/* The UI shell: no sidebar, a row of slabs along the top and a column down the
   left sharing Import at the corner, every control in a drop-down, every panel
   at one spot, one open at a time, and the bed grid on at load.
     node tools/nso_ui_shell_drive_check.js     exit 0 = every gate held */

const path = require('path');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

/* The user's drawing. */
const ROW = ['menu-import', 'menu-export', 'menu-rotate', 'menu-tip', 'menu-move',
             'btn-delete-placed', 'btn-lock-pos', 'btn-plate-lock',
             'menu-photo', 'menu-gen', 'menu-finish'];
const COL = ['menu-scale', 'menu-cut', 'menu-join', 'menu-align', 'menu-seat',
             'menu-abc', 'menu-bit', 'menu-plate', 'menu-pieces', 'menu-pack'];
const MENUS = ROW.filter(id => id.startsWith('menu-')).concat(COL);

/* Every control that lived in the sidebar, and the drop-down it moved to. */
const HOME = {
  'menu-join': ['btn-join-start', 'join-slot-a', 'join-slot-b', 'join-slot-c',
                'join-name-a', 'join-name-b', 'join-name-c', 'btn-join', 'btn-join-clear'],
  'menu-align': ['btn-join-align', 'btn-join-cx', 'btn-join-cz', 'btn-center-lock',
                 'btn-center-lock-pick', 'center-lock-ref'],
  'menu-seat': ['btn-seat-support', 'seat-gap', 'seat-gap-value', 'btn-seat-here',
                'chk-oversize-washer', 'oversize-gap', 'btn-seat-flush', 'btn-flip-port',
                'btn-seat-grid'],
  'menu-abc': ['triple-join', 'triple-mode', 'triple-gap-ab', 'triple-gap-ab-value',
               'triple-gap-bc', 'triple-gap-bc-value', 'btn-join-triple'],
  'menu-bit': ['btn-subtract', 'btn-extract-bit'],
  'menu-plate': ['plate-select', 'custom-size', 'custom-w', 'custom-d', 'custom-h',
                 'plate-dims', 'plate-area', 'plate-grid-show', 'chk-plate-grid-snap',
                 'build-volume-warning'],
  'menu-pieces': ['model-list', 'clone-count', 'btn-clone'],
  'menu-pack': ['btn-optimize'],
  'menu-import': ['file-input', 'btn-load-stl', 'btn-library', 'library-list']
};

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1500, height: 820 });
  await page.waitForTimeout(500);

  /* ------------------------------------------------------------------ 1 */
  console.log('\n=== 1. no sidebar; the plate gets the whole width ===');
  {
    const r = await page.evaluate(() => {
      const v = document.getElementById('viewport').getBoundingClientRect();
      const c = state.renderer.domElement.getBoundingClientRect();
      return {
        aside: document.querySelectorAll('aside, .left-panel, #join-card').length,
        cols: getComputedStyle(document.querySelector('main')).gridTemplateColumns,
        vx: v.left, vw: v.width, cw: c.width, W: innerWidth
      };
    });
    check('no left panel, no sidebar cards', r.aside === 0, r.aside + ' found');
    check('main is one column', r.cols.trim().split(/\s+/).length === 1, r.cols);
    check('the viewport is the full window width', r.vx === 0 && Math.abs(r.vw - r.W) < 0.5,
      'x ' + r.vx + ', ' + r.vw + ' of ' + r.W);
    check('...and so is the canvas', Math.abs(r.cw - r.W) < 0.5, r.cw + ' of ' + r.W);
  }

  /* ------------------------------------------------------------------ 2 */
  console.log('\n=== 2. every moved control is in its drop-down ===');
  {
    const r = await page.evaluate((home) => {
      const missing = [], wrong = [];
      Object.keys(home).forEach(menu => home[menu].forEach(id => {
        const e = document.getElementById(id);
        if (!e) { missing.push(id); return; }
        const top = e.closest('.vp-shell-menu');
        if (!top || top.id !== menu || top.contains(e) === false ||
            !top.querySelector(':scope > .vp-menu-body').contains(e)) {
          wrong.push(id + ' in ' + (top ? top.id : 'none'));
        }
      }));
      return { missing, wrong, n: Object.values(home).reduce((a, l) => a + l.length, 0) };
    }, HOME);
    check('every moved id still exists', r.missing.length === 0, r.missing.join(', ') || r.n + ' ids');
    check('each sits inside its expected drop-down\'s panel', r.wrong.length === 0,
      r.wrong.join('; ') || r.n + '/' + r.n);
  }

  /* ------------------------------------------------------------------ 3 */
  console.log('\n=== 3. the row and the column, in the drawing\'s order ===');
  {
    const r = await page.evaluate(([row, col]) => {
      const box = id => {
        const e = document.getElementById(id);
        const t = e.tagName === 'DETAILS' ? e.querySelector(':scope > summary') : e;
        const b = t.getBoundingClientRect();
        return { id, x: b.left, y: b.top, w: b.width, h: b.height, r: b.right, b: b.bottom };
      };
      return { row: row.map(box), col: col.map(box),
               breaks: document.querySelectorAll('.vp-bar-break, .vp-bar-spacer').length };
    }, [ROW, COL]);
    const rowTop = r.row[0].y;
    check('the top row is one line', r.row.every(b => Math.abs(b.y - rowTop) < 0.5),
      r.row.filter(b => Math.abs(b.y - rowTop) >= 0.5).map(b => b.id).join(', ') || 'all at y ' + rowTop);
    check('the row runs left to right in the drawing\'s order',
      r.row.every((b, i) => i === 0 || b.x > r.row[i - 1].r - 0.5),
      r.row.map(b => b.id.replace(/^(menu|btn)-/, '') + '@' + Math.round(b.x)).join(' '));
    check('no row break or spacer is left in the bar', r.breaks === 0, r.breaks + ' found');
    const imp = r.row[0];
    check('the column starts under Import, at its x', Math.abs(r.col[0].x - imp.x) < 0.5 && r.col[0].y > imp.b,
      'import x ' + imp.x + ', scale x ' + r.col[0].x);
    check('the column runs top to bottom in the drawing\'s order',
      r.col.every((b, i) => Math.abs(b.x - imp.x) < 0.5 && (i === 0 || b.y > r.col[i - 1].b - 0.5)),
      r.col.map(b => b.id.replace('menu-', '') + '@' + Math.round(b.y)).join(' '));
    const widths = r.col.map(b => b.w).concat([imp.w]);
    check('the column slabs and Import share one width, about 118 px',
      widths.every(w => Math.abs(w - widths[0]) < 0.5 && Math.abs(w - 118) <= 4), widths.join(', '));
    const rowSized = r.row.slice(1).map(b => b.w);
    check('the row\'s other slabs size to their labels', new Set(rowSized.map(Math.round)).size > 3,
      rowSized.map(Math.round).join(', '));
    check('Photo, Gen+ and Finish sit at the right end of the row',
      r.row[10].r > 1500 - 20 && r.row[8].x > r.row[7].r + 100,
      'lock plate ends ' + Math.round(r.row[7].r) + ', photo at ' + Math.round(r.row[8].x) +
      ', finish ends ' + Math.round(r.row[10].r));
  }

  /* The row never reaches Finish, whatever the font. Label widths are the
     machine's font metrics - at 1144 px one machine's row touched Finish
     and another's overlapped it by 5 px - so this is checked with the
     page's own font AND with every row label made markedly wider (extra
     letter-spacing, standing in for a wider font): Gen+ must stay a few px
     clear of Finish, and no slab may overlap the next. When room runs short
     the middle group (Export .. Lock plate) gives way, cutting its labels
     with an ellipsis; Import and the right group keep their width. */
  {
    const measure = () => page.evaluate((row) => {
      const out = row.map(id => {
        const e = document.getElementById(id);
        const t = e.tagName === 'DETAILS' ? e.querySelector(':scope > summary') : e;
        const b = t.getBoundingClientRect();
        return { id, x: b.left, r: b.right, w: b.width,
                 cut: t.scrollWidth > t.clientWidth + 1,
                 clipped: getComputedStyle(t).overflowX === 'hidden' };
      });
      return out;
    }, ROW);
    const FIXED = ['menu-import', 'menu-photo', 'menu-gen', 'menu-finish'];
    const atRest = await measure();
    const widthOf = id => atRest.find(b => b.id === id).w;
    check('at 1500 px wide, with this font, no row label is cut',
      atRest.every(b => !b.cut), atRest.filter(b => b.cut).map(b => b.id).join(', ') || 'none cut');
    const WIDER = '.vp-shell-row > .vp-bar-btn, .vp-shell-row > .vp-shell-menu > summary,' +
                  '.vp-shell-menu.vp-finish-menu > summary { letter-spacing: 0.3em !important; }';
    for (const wide of [false, true]) {
      if (wide) await page.addStyleTag({ content: WIDER }).then(h => h.evaluate(n => { n.id = 'wider-labels'; }));
      for (const w of [1144, 1280, 1500]) {
        await page.setViewportSize({ width: w, height: 820 });
        await page.waitForTimeout(120);
        const r = await measure();
        const gen = r.find(b => b.id === 'menu-gen'), fin = r.find(b => b.id === 'menu-finish');
        const overlaps = r.filter((b, i) => i > 0 && b.x < r[i - 1].r - 0.5).map(b => b.id);
        const spill = r.filter(b => b.cut && !b.clipped).map(b => b.id);
        const kept = wide || FIXED.every(id => Math.abs(r.find(b => b.id === id).w - widthOf(id)) < 0.5);
        check('at ' + w + ' px' + (wide ? ', labels made wider,' : '') +
              ' Gen+ is clear of Finish by 4 px or more, no slab overlaps the next, no label spills',
          fin.x - gen.r >= 4 && overlaps.length === 0 && spill.length === 0 && kept,
          'gen ends ' + gen.r.toFixed(1) + ', finish starts ' + fin.x.toFixed(1) +
          (overlaps.length ? ', overlapping: ' + overlaps.join(' ') : '') +
          (spill.length ? ', spilling: ' + spill.join(' ') : '') +
          (r.some(b => b.cut) ? ', cut: ' + r.filter(b => b.cut).map(b => b.id.replace(/^(menu|btn)-/, '')).join(' ') : ''));
      }
    }
    await page.evaluate(() => { const n = document.getElementById('wider-labels'); if (n) n.remove(); });
    await page.setViewportSize({ width: 1500, height: 820 });
    await page.waitForTimeout(150);
  }

  /* A narrow window (900 px and under) keeps the whole viewport: the column
     is not cut off at a squashed viewport's edge, and Pack - the last slab -
     can be clicked. */
  for (const h of [820, 720]) {
    await page.setViewportSize({ width: 900, height: h });
    await page.waitForTimeout(150);
    const r = await page.evaluate(() => {
      const v = document.querySelector('.viewport-section').getBoundingClientRect();
      const s = document.querySelector('#menu-pack > summary').getBoundingClientRect();
      const hit = document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2);
      return { vBottom: v.bottom, H: innerHeight, vW: v.width, W: innerWidth,
               packBottom: s.bottom, packHit: !!(hit && hit.closest('#menu-pack')) };
    });
    check('at 900x' + h + ' the viewport fills the window and Pack is clickable',
      Math.abs(r.vBottom - r.H) < 0.5 && Math.abs(r.vW - r.W) < 0.5 && r.packHit, JSON.stringify(r));
  }
  await page.setViewportSize({ width: 1500, height: 820 });
  await page.waitForTimeout(150);

  /* ------------------------------------------------------------------ 4 */
  console.log('\n=== 4. the slab ===');
  {
    const r = await page.evaluate((ids) => ids.map(id => {
      const s = document.querySelector('#' + id + ' > summary');
      const cs = getComputedStyle(s);
      const after = getComputedStyle(s, '::after').content;
      return { id, h: s.getBoundingClientRect().height, rad: cs.borderTopLeftRadius,
               tt: cs.textTransform, fw: cs.fontWeight, fs: cs.fontSize,
               ls: parseFloat(cs.letterSpacing) / parseFloat(cs.fontSize),
               blur: (cs.backdropFilter || cs.webkitBackdropFilter || ''), after,
               font: cs.fontFamily };
    }), MENUS);
    const off = r.filter(x => Math.abs(x.h - 36) > 0.5 || x.rad !== '9px' || x.tt !== 'uppercase' ||
                              x.fw !== '500' || x.fs !== '11.5px' || Math.abs(x.ls - 0.16) > 0.01 ||
                              !/blur/.test(x.blur));
    check('every drop-down button: 36 px, radius 9, caps, 500, 11.5 px, 0.16em, blurred glass',
      off.length === 0, off.length ? JSON.stringify(off[0]) : r.length + ' buttons');
    const arrows = r.filter(x => x.after !== 'none' && x.after !== 'normal');
    check('no drop-down arrow on any of them', arrows.length === 0,
      arrows.map(x => x.id + ' ' + x.after).join(', ') || 'none');
    check('the system font stack', /^-apple-system, "SF Pro Text", system-ui/.test(r[0].font), r[0].font);

    /* Read after the 0.12 s transition, not in the same turn as the open. */
    const look = () => page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector('#menu-seat > summary'));
      return { b: cs.borderTopColor, s: cs.boxShadow };
    });
    const lit = { shut: await look() };
    await page.evaluate(() => { document.getElementById('menu-seat').open = true; });
    await page.waitForTimeout(300);
    lit.open = await look();
    await page.evaluate(() => { document.getElementById('menu-seat').open = false; });
    check('open shows by a lit border and a glow', lit.open.b !== lit.shut.b && lit.open.s !== lit.shut.s,
      JSON.stringify(lit));
    const dis = await page.evaluate(() => {
      const b = document.getElementById('btn-delete-placed');
      return { disabled: b.disabled, op: +getComputedStyle(b).opacity };
    });
    check('a disabled button is dimmer', dis.disabled && dis.op < 0.6, JSON.stringify(dis));
  }

  /* ------------------------------------------------------------------ 5 */
  console.log('\n=== 5. one drop-down open at a time, every panel at one spot ===');
  {
    await loadSTL(page, path.join(ROOT, 'fixtures', 'box-20mm.stl'));
    await page.waitForTimeout(300);
    const counts = [], spots = [];
    for (const id of MENUS) {
      await page.click('#' + id + ' > summary');
      const st = await page.evaluate((id) => {
        const body = document.querySelector('#' + id + ' > .vp-menu-body').getBoundingClientRect();
        const cs = getComputedStyle(document.querySelector('#' + id + ' > .vp-menu-body'));
        return { n: document.querySelectorAll('.vp-menu[open]').length, open: document.getElementById(id).open,
                 x: body.left, y: body.top, rad: cs.borderTopLeftRadius, fs: cs.fontSize, tt: cs.textTransform };
      }, id);
      if (st.n !== 1 || !st.open) counts.push(id + ' n=' + st.n);
      spots.push(Object.assign({ id }, st));
    }
    check('opening each button in turn leaves exactly one .vp-menu[open]', counts.length === 0,
      counts.join('; ') || MENUS.length + '/' + MENUS.length);
    const colRight = await page.evaluate(() => document.querySelector('#menu-scale > summary').getBoundingClientRect().right);
    const rowBottom = await page.evaluate(() => document.querySelector('#menu-import > summary').getBoundingClientRect().bottom);
    const x0 = spots[0].x, y0 = spots[0].y;
    check('every panel opens at the same spot', spots.every(s => Math.abs(s.x - x0) < 0.5 && Math.abs(s.y - y0) < 0.5),
      spots.filter(s => Math.abs(s.x - x0) >= 0.5 || Math.abs(s.y - y0) >= 0.5).map(s => s.id + '@' + s.x + ',' + s.y).join('; ') ||
      'all at ' + x0 + ', ' + y0);
    check('...just right of the column and just under the row',
      x0 > colRight && x0 - colRight <= 16 && y0 > rowBottom && y0 - rowBottom <= 16,
      'column ends ' + colRight + ', row ends ' + rowBottom);
    check('panels: radius 12, sentence case, 12.5 px',
      spots.every(s => s.rad === '12px' && s.tt === 'none' && s.fs === '12.5px'),
      JSON.stringify(spots.find(s => s.rad !== '12px' || s.tt !== 'none' || s.fs !== '12.5px') || 'all'));
  }

  /* ------------------------------------------------------------------ 6 */
  console.log('\n=== 6. every panel fits the window ===');
  for (const [w, h] of [[1500, 820], [1280, 720]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(250);
    const r = await page.evaluate((ids) => {
      const out = [];
      ids.forEach(id => {
        document.querySelectorAll('.vp-menu').forEach(d => { d.open = false; });
        const d = document.getElementById(id);
        d.open = true;
        /* At its tallest: every group inside it open too (Finish's six,
           Gen+'s three - one at a time there, so each in turn). */
        const groups = [...d.querySelectorAll('details')];
        const variants = d.id === 'menu-gen' ? groups.map(g => [g]) : [groups];
        variants.forEach(v => {
          groups.forEach(g => { g.open = false; });
          v.forEach(g => { g.open = true; });
          const body = d.querySelector(':scope > .vp-menu-body');
          const b = body.getBoundingClientRect();
          out.push({ id: id + (v.length === 1 && d.id === 'menu-gen' ? ':' + v[0].className.split(' ').pop() : ''),
                     l: b.left, t: b.top, r: b.right, b: b.bottom,
                     scroll: body.scrollHeight > body.clientHeight + 1,
                     ok: b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight });
        });
        groups.forEach(g => { g.open = false; });
        d.open = false;
      });
      document.querySelectorAll('.vp-finish-menu .vp-sec[data-sec="shape"]').forEach(g => { g.open = true; });
      return out;
    }, MENUS);
    const bad = r.filter(x => !x.ok);
    check('at ' + w + 'x' + h + ' every panel is inside the window (scrolling allowed)', bad.length === 0,
      bad.length ? bad.map(x => x.id + ' ' + Math.round(x.l) + ',' + Math.round(x.t) + '..' +
                               Math.round(x.r) + ',' + Math.round(x.b)).join('; ')
                 : r.length + ' panels' + (r.some(x => x.scroll) ? ', scrolling inside: ' +
                     r.filter(x => x.scroll).map(x => x.id).join(', ') : ''));
  }
  await page.setViewportSize({ width: 1500, height: 820 });
  await page.waitForTimeout(250);

  /* ------------------------------------------------------------------ 7 */
  console.log('\n=== 7. Pieces: picking a row keeps the panel open ===');
  {
    await page.evaluate(() => document.querySelectorAll('.vp-menu').forEach(d => { d.open = false; }));
    await page.click('#menu-pieces > summary');
    await page.click('#model-list .model-item .name');
    await page.waitForTimeout(150);
    const r = await page.evaluate(() => ({
      open: document.getElementById('menu-pieces').open,
      n: document.querySelectorAll('.vp-menu[open]').length,
      picked: state.editId
    }));
    check('the Pieces panel stays open after a row is clicked', r.open && r.n === 1 && r.picked != null,
      JSON.stringify(r));
  }

  /* ------------------------------------------------------------------ 8 */
  console.log('\n=== 8. the bed grid is on at load ===');
  {
    /* Read from a fresh load: this page has been driven above. */
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => typeof state !== 'undefined' && state.ready === true, null, { timeout: 30000 });
    const r = await page.evaluate(() => ({
      mode: state.plateGridMode,
      select: document.getElementById('plate-grid-show').value,
      visible: !!(state.plateGrid && state.plateGrid.visible),
      choices: [...document.querySelectorAll('#plate-grid-show option')].map(o => o.value)
    }));
    check('state.plateGridMode is on, the Plate panel\'s select shows it, the grid is drawn',
      r.mode === 'on' && r.select === 'on' && r.visible, JSON.stringify(r));
    check('Auto and Off are still choices', r.choices.includes('auto') && r.choices.includes('off'),
      r.choices.join(', '));
  }

  /* ------------------------------------------------------------------ 9 */
  console.log('\n=== 9. KNOWN, NOT FIXED: the column meets the bottom-left tools ===');
  {
    /* Flagged with the shell, deliberately left as it is: on a short window
       the left column runs down into the tool column at the bottom-left
       (Undo, Frame, X-ray, G-scope, Watch) and, being on top, takes their
       clicks. Pinned here so it cannot get worse unseen, and so whoever
       fixes it sees this gate go stale. */
    const collides = async (h) => {
      await page.setViewportSize({ width: 1280, height: h });
      await page.waitForTimeout(60);
      return page.evaluate(() => {
        const col = [...document.querySelectorAll('.vp-shell-col > .vp-shell-menu > summary')]
          .map(e => e.getBoundingClientRect());
        return ['btn-undo', 'btn-frame-view', 'btn-xray', 'btn-microscope', 'btn-watch']
          .map(id => document.getElementById(id)).filter(Boolean)
          .some(t => { const r = t.getBoundingClientRect();
            return col.some(c => Math.min(c.right, r.right) > Math.max(c.left, r.left) &&
                                 Math.min(c.bottom, r.bottom) > Math.max(c.top, r.top)); });
      });
    };
    let lo = 600, hi = 1000;                     // lo collides, hi does not
    const okEnds = (await collides(lo)) && !(await collides(hi));
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (await collides(m)) lo = m; else hi = m; }
    check('the collision starts below about 790 px of window height, no higher',
      okEnds && hi >= 770 && hi <= 800, okEnds ? 'clear from ' + hi + ' px tall' : 'not bracketed by 600..1000');
    await page.setViewportSize({ width: 1500, height: 820 });
  }

  const errs = logs.filter(l => /^\[(error|pageerror)\]/.test(l));
  check('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));

  if (fails) { console.log('\n' + fails + ' FAILED'); process.exit(1); }
  console.log('\nall gates held');
});
