const fs=require('fs');const ROOT=require('path').resolve(__dirname,'../..');
const lib=require(ROOT+'/tools/nso_support_plate_lib.js');const PRINT=require(ROOT+'/app-print.js'),L=require(ROOT+'/tools/print-planner/lib.js');
require(ROOT+'/nso_paint.js');require(ROOT+'/nso_paint_segment.js');const SL=require(ROOT+'/nso_slicer.js');require(ROOT+'/nso-print-planner.js');
const trimesh=null;
function readStl(f){const b=fs.readFileSync(f);const n=b.readUInt32LE(80);const p=new Float32Array(n*9);for(let i=0;i<n;i++)for(let k=0;k<9;k++)p[i*9+k]=b.readFloatLE(84+i*50+12+k*4);return p;}
(async()=>{
 const gaps=process.argv.slice(2);
 const objs=gaps.map((g,i)=>{const p=readStl(__dirname+'/shelf_'+g+'.stl');for(let k=0;k<p.length;k+=3){p[k]-=12;p[k+1]+=(i-(gaps.length-1)/2)*30-10;}return {id:i+1,name:'shelf '+g,positions:p,triangleCount:p.length/9};});
 const app=lib.makeApp(); app.ctx.nsoSupportInterfaceRule=()=>'column'; app.ctx.NSO_Slicer=SL;
 const ids=app.load(objs); app.openCard(); app.setPlateBox(true); app.card.angle(45);
 app.click('btn-sup-all'); await app.until(()=>app.card.busy()); await app.until(()=>!app.card.busy());
 console.log('card:', app.head && app.head());
 const pieces=[];
 objs.forEach((o,i)=>{ pieces.push({name:o.name,file:'TPU shelves',soup:Float32Array.from(app.soupOf(ids[i])),sourceId:ids[i]});
   app.supportsOf(ids[i]).forEach((m,k)=>pieces.push({name:o.name+' support '+k,soup:Float32Array.from(app.ctx.nsoSupportSliceSoup?app.ctx.nsoSupportSliceSoup(m,app.soupOf(m.id)):app.soupOf(m.id)),sourceId:m.id,support:true,brim:!!m.nsoSupport.brim,hostSourceId:ids[i],interfaceLayers:m.nsoSupport.interfaceLayers,sheetLayerMm:m.nsoSupport.sheetLayerMm,supportGapMm:m.nsoSupport.brim?undefined:+gaps[i]})); });
 console.log(pieces.map(p=>p.name+(p.supportGapMm?' gap '+p.supportGapMm:'')+(p.brim?' (brim)':'')).join(' | '));
 const tpl=PRINT.nsoBaseline(await L.a1Template()), pr=L.printer('a1mini-0.4');
 let x0=1e9,x1=-1e9,y0=1e9,y1=-1e9;pieces.forEach(p=>{for(let i=0;i<p.soup.length;i+=3){x0=Math.min(x0,p.soup[i]);x1=Math.max(x1,p.soup[i]);y0=Math.min(y0,p.soup[i+1]);y1=Math.max(y1,p.soup[i+1]);}});
 pieces.forEach(p=>{for(let i=0;i<p.soup.length;i+=3){p.soup[i]-=(x0+x1)/2;p.soup[i+1]-=(y0+y1)/2;}});
 console.log('footprint',(x1-x0).toFixed(1),(y1-y0).toFixed(1));
 const objects=PRINT.pieceObjects(pieces,pr.bed);
 const st=Object.assign(PRINT.settingsFromConfig(tpl),{filament:'cr-tpu',angle:45,interfaceRule:'column'},JSON.parse(process.env.SET||'{}'));
 const r=await PRINT.build(objects,{config:tpl,printer:pr},{settings:st});
 if(!r.ok){console.log('REFUSED',r.reason);return;}
 const name='TPU support ladder '+gaps.join('-')+' - A1 mini.gcode.3mf';
 fs.writeFileSync(require('path').join(process.cwd(),name),Buffer.from(r.bytes));
 
 console.log(PRINT.describe(r));
})().catch(e=>{console.error(e);process.exit(1)});
