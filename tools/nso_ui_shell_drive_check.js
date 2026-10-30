#!/usr/bin/env node
/* The UI shell: no sidebar, a row of slabs along the top and a column down the
   left sharing Import at the corner, every control in a drop-down, every panel
   at one spot, one open at a time, the bed grid on at load, and the status
   line keeping its HUD panel across messages.
     node tools/nso_ui_shell_drive_check.js     exit 0 = every gate held */

const path = require('path');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

/* The user's drawing (shell v3). The row, left to right; Clear plate and
   Optimize sit under Remove and Export, off the row's line, and the Plate &
   pieces panel is pinned in the top-right corner. The column's slabs top to
   bottom, in their groups (tools/nso_shell_v3_test.js gates the groups'
   pitch and gaps); the view row (X, the eye, the target) is pinned under
   them. */
const ROW = ['menu-import', 'menu-measure', 'menu-move', 'menu-rotate', 'menu-tip', 'menu-align',
             'menu-gen', 'btn-lock-pos', 'btn-plate-lock', 'btn-undo', 'btn-delete-placed', 'menu-export'];
const COL = ['menu-scale', 'menu-cut', 'menu-crop', 'menu-joins', 'menu-seat', 'menu-supports',
             'menu-add', 'menu-bit', 'menu-shape', 'menu-text', 'menu-paint', 'menu-surface', 'menu-sculpt', 'menu-slice',
             'btn-microscope', 'menu-repair'];
const MENUS = ROW.filter(id => id.startsWith('menu-')).concat(COL.filter(id => id.startsWith('menu-')));

/* Every control that lived in the sidebar, and where it is now (Join and
   A-B-C as one card under Join; Plate and Pieces in the pinned Plate & pieces panel;
   Pack's Optimize a slab of its own, under Export). */
const HOME = {
  'menu-joins': ['join-slot-a', 'join-slot-b', 'join-slot-c',
                'join-name-a', 'join-name-b', 'join-name-c', 'btn-join', 'btn-join-clear',
                'joins-card', 'join-horizontal', 'join-gap-ab-on', 'join-gap-ab', 'join-gap-ab-value',
                'join-gap-bc-on', 'join-gap-bc', 'join-gap-bc-value', 'join-readout'],
  'menu-align': ['btn-join-align', 'btn-join-cx', 'btn-join-cz', 'btn-center-lock',
                 'btn-center-lock-pick', 'center-lock-ref'],
  'menu-seat': ['btn-seat-support', 'seat-gap', 'seat-gap-value', 'btn-seat-here',
                'chk-oversize-washer', 'oversize-gap', 'btn-seat-flush', 'btn-flip-port',
                'btn-seat-grid'],
  'menu-bit': ['btn-subtract', 'btn-extract-bit', 'btn-carve', 'btn-hollow', 'btn-hollow-safe', 'btn-lift'],
  'plate-panel': ['plate-select', 'custom-size', 'custom-w', 'custom-d', 'custom-h',
                 'plate-dims', 'plate-area', 'plate-grid-show', 'chk-plate-grid-snap',
                 'build-volume-warning', 'model-list', 'clone-count', 'btn-clone'],
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
        // The pinned panel is not a drop-down: it has no body to be in.
        if (menu === 'plate-panel') {
          if (!e.closest('#plate-panel') || e.closest('details')) wrong.push(id + ' not in the pinned panel');
          return;
        }
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
      const p = document.getElementById('plate-panel').getBoundingClientRect();
      return { row: row.map(box), col: col.map(box), panel: { x: p.left, r: p.right, y: p.top },
               breaks: document.querySelectorAll('.vp-bar-break, .vp-bar-spacer').length };
    }, [ROW, COL]);
    const rowTop = r.row[0].y;
    check('the top row is one line', r.row.every(b => Math.abs(b.y - rowTop) < 0.5),
      r.row.filter(b => Math.abs(b.y - rowTop) >= 0.5).map(b => b.id).join(', ') || 'all at y ' + rowTop);
    check('the row starts 8 px from the top edge of the window: there is no header above it', Math.abs(rowTop - 8) < 0.5,
      'row top ' + rowTop);
    check('the row runs left to right in the drawing\'s order',
      r.row.every((b, i) => i === 0 || b.x > r.row[i - 1].r - 0.5),
      r.row.map(b => b.id.replace(/^(menu|btn)-/, '') + '@' + Math.round(b.x)).join(' '));
    check('no row break or spacer is left in the bar', r.breaks === 0, r.breaks + ' found');
    const imp = r.row[0];
    check('the column starts under Import, at its x', Math.abs(r.col[0].x - imp.x) < 0.5 && r.col[0].y > imp.b,
      'import x ' + imp.x + ', ' + r.col[0].id + ' x ' + r.col[0].x);
    check('the column runs top to bottom in the drawing\'s order',
      r.col.every((b, i) => Math.abs(b.x - imp.x) < 0.5 && (i === 0 || b.y > r.col[i - 1].b - 0.5)),
      r.col.map(b => b.id.replace('menu-', '') + '@' + Math.round(b.y)).join(' '));
    const widths = r.col.map(b => b.w).concat([imp.w]);
    check('the column slabs and Import share one width, about 118 px',
      widths.every(w => Math.abs(w - widths[0]) < 0.5 && Math.abs(w - 118) <= 4), widths.join(', '));
    const rowSized = r.row.slice(1).map(b => b.w);
    check('the row\'s other slabs size to their labels', new Set(rowSized.map(Math.round)).size > 3,
      rowSized.map(Math.round).join(', '));
    const at = id => r.row[ROW.indexOf(id)];
    const lockPlate = at('btn-plate-lock'), undo = at('btn-undo'), exp = at('menu-export');
    check('Undo, Remove and Export sit at the right end of the row, against the pinned panel in the corner',
      Math.abs(r.panel.r - (1500 - 8)) < 1 && Math.abs(r.panel.y - rowTop) < 0.5 &&
      exp.r < r.panel.x && r.panel.x - exp.r < 10 && undo.x > lockPlate.r + 100,
      'lock plate ends ' + Math.round(lockPlate.r) + ', undo at ' + Math.round(undo.x) +
      ', export ends ' + Math.round(exp.r) + ', panel ' + Math.round(r.panel.x) + '..' + Math.round(r.panel.r));
  }

  /* The row fits the window whatever the font. Label widths are the
     machine's font metrics - at 1144 px one machine's row touched the slab
     beyond it and another's overlapped it by 5 px - so this is checked with
     the page's own font AND with every row label made markedly wider (extra
     letter-spacing, standing in for a wider font): no slab may overlap the
     next and Export must end inside the window - left of the pinned Plate &
     pieces panel where the two share the top (1280 px and over), under it
     the panel drops below the stacks. When room runs short the middle group
     (Measure .. Lock plate, Gen+ aside) gives way, cutting its labels with
     an ellipsis; Import, Gen+ and the right group (Undo, Remove, Export)
     keep their width. */
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
    const FIXED = ['menu-import', 'menu-gen', 'btn-undo', 'btn-delete-placed', 'menu-export'];
    const atRest = await measure();
    const widthOf = id => atRest.find(b => b.id === id).w;
    check('at 1500 px wide, with this font, no row label is cut',
      atRest.every(b => !b.cut), atRest.filter(b => b.cut).map(b => b.id).join(', ') || 'none cut');
    const WIDER = '.vp-shell-row > .vp-bar-btn, .vp-shell-row > .vp-shell-menu > summary,' +
                  '.vp-shell-stack > .vp-shell-menu > summary, .vp-shell-stack > .vp-bar-btn { letter-spacing: 0.3em !important; }';
    for (const wide of [false, true]) {
      if (wide) await page.addStyleTag({ content: WIDER }).then(h => h.evaluate(n => { n.id = 'wider-labels'; }));
      for (const w of [1144, 1280, 1500]) {
        await page.setViewportSize({ width: w, height: 820 });
        await page.waitForTimeout(120);
        const r = await measure();
        const last = r[r.length - 1];
        const edge = await page.evaluate(() => {
          const p = document.getElementById('plate-panel').getBoundingClientRect();
          const o = document.getElementById('btn-optimize').getBoundingClientRect();
          return p.top < o.top ? p.left - 6 : innerWidth - 8;    // beside the panel, or under it
        });
        const overlaps = r.filter((b, i) => i > 0 && b.x < r[i - 1].r - 0.5).map(b => b.id);
        const spill = r.filter(b => b.cut && !b.clipped).map(b => b.id);
        const kept = wide || FIXED.every(id => Math.abs(r.find(b => b.id === id).w - widthOf(id)) < 0.5);
        check('at ' + w + ' px' + (wide ? ', labels made wider,' : '') +
              ' Export ends inside the window, no slab overlaps the next, no label spills',
          last.r <= edge + 0.5 && overlaps.length === 0 && spill.length === 0 && kept,
          'export ends ' + last.r.toFixed(1) + ' of ' + edge +
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
     is not cut off at a squashed viewport's edge, and its last slab - the
     target in the view row - Optimize under Export and the Plate & pieces
     panel can be clicked. */
  for (const h of [820, 720]) {
    await page.setViewportSize({ width: 900, height: h });
    await page.waitForTimeout(150);
    const r = await page.evaluate(() => {
      const v = document.querySelector('.viewport-section').getBoundingClientRect();
      const hits = sel => {
        const s = document.querySelector(sel).getBoundingClientRect();
        const hit = document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2);
        return !!(hit && hit.closest(sel)) && s.bottom <= innerHeight;
      };
      return { vTop: v.top, vBottom: v.bottom, H: innerHeight, vW: v.width, W: innerWidth,
               lastHit: hits('#btn-frame-view'), optHit: hits('#btn-optimize'), plateHit: hits('#plate-select') };
    });
    check('at 900x' + h + ' the viewport fills the window; the column\'s last slab, Optimize and the Plate & pieces panel are clickable',
      Math.abs(r.vTop) < 0.5 && Math.abs(r.vBottom - r.H) < 0.5 && Math.abs(r.vW - r.W) < 0.5 && r.lastHit && r.optHit && r.plateHit, JSON.stringify(r));
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
      return { id, col: !!s.closest('.vp-shell-col'), tight: !!s.closest('.vp-shell-row') && id !== 'menu-import',
               h: s.getBoundingClientRect().height, rad: cs.borderTopLeftRadius,
               tt: cs.textTransform, fw: cs.fontWeight, fs: cs.fontSize,
               ls: parseFloat(cs.letterSpacing) / parseFloat(cs.fontSize),
               blur: (cs.backdropFilter || cs.webkitBackdropFilter || ''), after,
               font: cs.fontFamily };
    }), MENUS);
    const off = r.filter(x => Math.abs(x.h - (x.col ? 32 : 36)) > 0.5 || x.rad !== '9px' || x.tt !== 'uppercase' ||
                              x.fw !== '500' || x.fs !== '11.5px' || Math.abs(x.ls - (x.tight ? 0.07 : 0.16)) > 0.01 ||
                              !/blur/.test(x.blur));
    check('every drop-down button: 36 px in the row, 32 px in the column (a 36 px pitch), radius 9, caps, 500, 11.5 px, 0.16em (0.07em in the row past Import, shell v3), blurred glass',
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
        // A member open inside its drop-down (Join's first card, shown with its column) is part of that panel.
        return { n: [...document.querySelectorAll('.vp-menu[open]')].filter(d => !d.parentElement.closest('.vp-menu[open]')).length, open: document.getElementById(id).open,
                 x: body.left, y: body.top, rad: cs.borderTopLeftRadius, fs: cs.fontSize, tt: cs.textTransform };
      }, id);
      if (st.n !== 1 || !st.open) counts.push(id + ' n=' + st.n);
      spots.push(Object.assign({ id }, st));
    }
    check('opening each button in turn leaves exactly one .vp-menu[open] (not counting a member inside it)', counts.length === 0,
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
        /* At its tallest: each menu held inside it open too, one at a time
           (Gen+'s four, Join's two), so each in turn. */
        const groups = [...d.querySelectorAll('details')];
        const variants = groups.length ? groups.map(g => [g]) : [groups];
        variants.forEach(v => {
          groups.forEach(g => { g.open = false; });
          v.forEach(g => { g.open = true; });
          const body = d.querySelector(':scope > .vp-menu-body');
          const b = body.getBoundingClientRect();
          out.push({ id: id + (v.length === 1 ? ':' + (v[0].id || v[0].className.split(' ').pop()) : ''),
                     l: b.left, t: b.top, r: b.right, b: b.bottom,
                     scroll: body.scrollHeight > body.clientHeight + 1,
                     ok: b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight });
        });
        groups.forEach(g => { g.open = false; });
        d.open = false;
      });
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
    await page.click('#model-list .model-item .name');
    await page.waitForTimeout(150);
    const r = await page.evaluate(() => {
      const p = document.getElementById('plate-panel');
      return { open: !p.hidden && p.getBoundingClientRect().height > 0 && p.contains(document.getElementById('model-list')),
               n: document.querySelectorAll('.vp-menu[open]').length, picked: state.editId };
    });
    check('the pinned Plate & pieces panel stays open after a row is clicked, and opens no drop-down', r.open && r.n === 0 && r.picked != null,
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
  console.log('\n=== 9. the column fits the viewport, the view row under it ===');
  {
    /* Until shell v2 the column ran into the bottom-left tool strip below
       about 795 px of window height. The strip is gone - its buttons are the
       column's G-scope and the view row pinned under it - so the column must
       now clear the view row and end inside the viewport at every height down
       to 720 (the narrow fallback's short window). Since shell v3 the last
       slab over the view row is Check & repair, pinned there on its own, and
       Sculpt must clear it in turn. */
    for (const h of [720, 768, 800, 900]) {
      await page.setViewportSize({ width: 1280, height: h });
      await page.waitForTimeout(80);
      const r = await page.evaluate(() => {
        const last = document.querySelector('#menu-repair > summary').getBoundingClientRect();
        const sculpt = document.querySelector('#menu-sculpt > summary').getBoundingClientRect();
        const view = document.querySelector('.vp-shell-view').getBoundingClientRect();
        const vp = document.getElementById('viewport').getBoundingClientRect();
        // The view row's buttons, not its box: the box's top padding is the group gap.
        const xray = document.getElementById('btn-xray').getBoundingClientRect();
        return { sculptBottom: sculpt.bottom, lastTop: last.top, lastBottom: last.bottom, viewTop: xray.top,
                 viewBottom: view.bottom, vpBottom: vp.bottom };
      });
      check('at 1280x' + h + ' the column clears the view row and the view row ends inside the viewport',
        r.sculptBottom <= r.lastTop - 4 && r.lastBottom <= r.viewTop - 4 && r.viewBottom <= r.vpBottom, JSON.stringify(r));
    }
    await page.setViewportSize({ width: 1500, height: 820 });
  }

  /* ----------------------------------------------------------------- 10 */
  console.log('\n=== 10. the status line keeps its panel across messages ===');
  {
    /* setStatus used to write className = 'status success', dropping
       status-hud: after the first message the HUD lost its dark panel. */
    const read = () => page.evaluate(() => {
      const el = document.getElementById('status');
      const cs = getComputedStyle(el);
      return { cls: [...el.classList].sort().join(' '), bg: cs.backgroundColor, color: cs.color };
    });
    const base = await read();
    check('at load #status is the HUD panel', /\bstatus-hud\b/.test(base.cls) && base.bg !== 'rgba(0, 0, 0, 0)',
      JSON.stringify(base));
    const steps = [['first message', false], ['an error', true], ['back to normal', false]];
    let prevColor = null;
    for (const [msg, isErr] of steps) {
      await page.evaluate(([m, e]) => setStatus(m, e), [msg, isErr]);
      const r = await read();
      const want = ['status', 'status-hud', isErr ? 'error' : 'success'].sort().join(' ');
      check('after setStatus("' + msg + '"' + (isErr ? ', error' : '') + ') the classes are ' + want +
        ' and the panel is the same', r.cls === want && r.bg === base.bg, JSON.stringify(r));
      if (prevColor) check('...and its text colour changed with the variant', r.color !== prevColor, r.color);
      prevColor = r.color;
    }
  }

  const errs = logs.filter(l => /^\[(error|pageerror)\]/.test(l));
  check('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));

  if (fails) { console.log('\n' + fails + ' FAILED'); process.exit(1); }
  console.log('\nall gates held');
});
