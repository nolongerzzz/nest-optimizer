/* Time NSO_Repair.commit() against triangle count, on THIS machine, so the
 * repo's own 32,862-triangle fixture is the calibration point and the scan
 * mesh is read as a ratio against it rather than against another machine. */
'use strict';
const path=require('path');
const ROOT='/home/user/nest-optimizer';
const {readSTL,loadRepairModule}=require(path.join(ROOT,'tools','nso_stl_io.js'));
const R=loadRepairModule(path.join(ROOT,'NSO_Repair.js'));
for (const f of process.argv.slice(2)) {
  let raw;
  try { raw=readSTL(f); } catch(e){ console.log(f,'READ FAIL',e.message); continue; }
  const n=raw.length/9;
  const t0=Date.now();
  let res, err=null;
  try { res=R.commit(raw,{}); } catch(e){ err=e.message; }
  const dt=(Date.now()-t0)/1000;
  console.log(JSON.stringify({file:path.basename(f), tris:n, seconds:+dt.toFixed(2),
    ok:res?res.ok:false, applied:res?res.report.applied:null, err}));
}
