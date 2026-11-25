#!/usr/bin/env python3
"""Regenerate nso-bambu-presets.js from Bambu Studio's own profiles (docs/PRINT-CARD.md "Nozzle and quality").
   python3 tools/nso_bambu_presets_make.py [tag]   (default v02.09.01.70; needs raw.githubusercontent.com)"""
import json, os, sys, subprocess, urllib.parse, tempfile
TAG = sys.argv[1] if len(sys.argv) > 1 else 'v02.09.01.70'
B = 'https://raw.githubusercontent.com/bambulab/BambuStudio/%s/resources/profiles/BBL/' % TAG
W = tempfile.mkdtemp()
def get(rel):
    f = os.path.join(W, rel.replace('/', '_'))
    if not os.path.exists(f): subprocess.run(['curl', '-sf', '-o', f, B + urllib.parse.quote(rel)], check=True)
    return json.load(open(f))
idx = get('../BBL.json') if False else json.loads(subprocess.run(['curl', '-sf', B[:-1] + '.json'], capture_output=True, check=True).stdout)
proc = {p['name']: p['sub_path'] for p in idx['process_list']}
mach = {p['name']: p['sub_path'] for p in idx['machine_list']}
def flat(name, table):
    d = get(table[name]); out = {}
    if d.get('inherits') and d['inherits'] in table: out.update(flat(d['inherits'], table))
    out.update(d); return out
SKIP = {'name','inherits','setting_id','from','instantiation','type','compatible_printers','description','include','upward_compatible_machine','compatible_printers_condition','print_settings_id','inherits_group'}
out = {}
for key, tag, printer, nozzles in [('a1mini', 'A1M', 'Bambu Lab A1 mini', ['0.2','0.4','0.6','0.8']), ('p1s', 'X1C', 'Bambu Lab P1S', ['0.2','0.4','0.6'])]:
    base = flat('0.20mm Standard @BBL %s' % tag, proc); procs = []
    for n in proc:
        if '@BBL %s' % tag not in n: continue
        d = get(proc[n])
        if d.get('instantiation') != 'true': continue
        noz = next((z for z in ['0.2','0.6','0.8'] if n.endswith(z + ' nozzle')), '0.4')
        if noz not in nozzles: continue
        P = flat(n, proc)
        procs.append({'name': n, 'nozzle': noz, 'layer': float(P['layer_height']), 'keys': {k: P[k] for k in P if k not in SKIP and base.get(k) != P[k]}})
    procs.sort(key=lambda p: (float(p['nozzle']), p['layer'], p['name']))
    mb = flat('%s 0.4 nozzle' % printer, mach); md = {}; std = {}
    for z in nozzles:
        m = flat('%s %s nozzle' % (printer, z), mach); std[z] = m.get('default_print_profile')
        if z == '0.4': continue
        md[z] = {k: m[k] for k in m if k not in SKIP | {'machine_start_gcode','machine_end_gcode','default_filament_profile','printer_variant','default_print_profile'} and mb.get(k) != m[k]}
        md[z]['printer_settings_id'] = '%s %s nozzle' % (printer, z)
    out[key] = {'nozzles': nozzles, 'standard': std, 'machine': md, 'process': procs}
out['flow02'] = {'PLA': 1.6, 'PETG': 1, 'TPU': 1, '_source': 'Generic PLA / PETG @BBL A1M 0.2 nozzle and @0.2 nozzle: filament_max_volumetric_speed 1.6 / 1; TPU has no 0.2 preset'}
src = open('nso-bambu-presets.js').read()
a = src.index('var DATA = ') + len('var DATA = '); b = src.index(';\n  var api')
open('nso-bambu-presets.js', 'w').write(src[:a] + json.dumps(out, separators=(',', ':')) + src[b:])
print('written', sum(len(out[k]['process']) for k in ('a1mini', 'p1s')), 'presets')
