const path = require('path'), fs = require('fs'), os = require('os');
const { withApp, loadSTL } = require('./nso_app_harness');
function bar(Lx, Wy, Hz) { const o = []; const q = (a, b, c, d) => o.push(...a, ...b, ...c, ...a, ...c, ...d);
  q([0,0,0],[0,Wy,0],[Lx,Wy,0],[Lx,0,0]); q([0,0,Hz],[Lx,0,Hz],[Lx,Wy,Hz],[0,Wy,Hz]); q([0,0,0],[Lx,0,0],[Lx,0,Hz],[0,0,Hz]);
  q([0,Wy,0],[0,Wy,Hz],[Lx,Wy,Hz],[Lx,Wy,0]); q([0,0,0],[0,0,Hz],[0,Wy,Hz],[0,Wy,0]); q([Lx,0,0],[Lx,Wy,0],[Lx,Wy,Hz],[Lx,0,Hz]); return o; }
const f = path.join(os.tmpdir(), 'dbgbar.stl'); const s = bar(60, 12, 8), n = s.length / 9, b = Buffer.alloc(84 + n * 50);
b.writeUInt32LE(n, 80); for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(s[t * 9 + k], 84 + t * 50 + 12 + k * 4); fs.writeFileSync(f, b);
withApp(async (page) => {
  const id = await loadSTL(page, f);
  await page.evaluate(() => { const e = document.getElementById('cutter-tools'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; openCutter('cut'); });
  await page.evaluate(id => selectPlaced(state.placed.findIndex(p => p && p.sourceId === id)), id);
  const r = await page.evaluate(id => {
    rotateActiveModelY(15);
    const m = state.models.find(x => x.id === id), mesh = cutMeshOf(m), p = state.placed.find(q => q.sourceId === id);
    const fr = cutFrame(m), pf = pieceFrame(mesh);
    return { meshIsPlaced: mesh === (p && p.mesh), meshIsPreview: mesh === state.previewMesh, sameGeo: mesh.geometry === m.geometry,
             base: fr.base, axis: fr.axis, normal: fr.normal.toArray(), long: pf.long.toArray(), meshQ: mesh.quaternion.toArray(),
             placedGeoSame: p && p.mesh.geometry === m.geometry,
             split: (() => { const info = getCutPlaneForSplit(m), r = cutSplitAt(m, info);
               const ext = g => { const a = g.attributes.position.array, nn = fr.normal; let lo = 1e9, hi = -1e9;
                 for (let i = 0; i < a.length; i += 3) { const d = a[i]*nn.x + a[i+1]*nn.y + a[i+2]*nn.z; lo = Math.min(lo, d); hi = Math.max(hi, d); } return [lo, hi]; };
               const pa = m.geometry.attributes.position.array;
               return { plane: info.plane, mm: info.mm, axis: info.axis, origin: info.origin, engine: r.engine, A: ext(r.left), B: ext(r.right), whole: ext(m.geometry),
                        turnEls: info.turn && info.turn.elements.slice(0, 11).map(v => +v.toFixed(4)), off: m.centerOffset }; })() };
  }, id);
  console.log(JSON.stringify(r));
});
