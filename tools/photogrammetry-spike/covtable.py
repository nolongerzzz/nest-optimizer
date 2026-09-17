#!/usr/bin/env python3
"""Merge the sweep results with the exact subset geometry into one table."""
import json
rows=[]
for l in open('/home/user/pgspike/out/sweep_run.log'):
    l=l.strip()
    if l.startswith('{'):
        try: rows.append(json.loads(l))
        except: pass
geo=json.load(open('/home/user/pgspike/out/subset_geometry.json'))
seen=set()
print("| subset | photos | azimuth span | largest camera gap | median step | registered | sub-models | sparse points | mean track len |")
print("|---|---|---|---|---|---|---|---|---|")
for r in rows:
    n=r['name']
    if not n.startswith(('arc','gap')) or n in seen: continue
    seen.add(n)
    g=geo.get(n,{})
    print(f"| `{n}` | {r['n_input']} | {g.get('span','—')}° | **{g.get('max_gap','—')}°** | "
          f"{g.get('median_step','—')}° | {r.get('registered',0)} / {r['n_input']} | "
          f"{r.get('n_submodels',0)} | {r.get('points',0):,} | {r.get('mean_track_len',0):.2f} |")
