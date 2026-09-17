#!/usr/bin/env python3
"""Build the subset spec for the sweep from the reference reconstruction's
camera azimuths: even angular spacing for the count sweep, and deliberately
damaged coverage for the gap sweep."""
import json, sys

poses=json.load(open(sys.argv[1]))
rows=sorted(poses['rows'], key=lambda r:r['az'])   # ascending azimuth
names=[r['name'] for r in rows]
az=[r['az'] for r in rows]
N=len(rows)

def even(k):
    """k cameras spread as evenly as possible around the azimuth circle."""
    idx=sorted({round(i*N/k) % N for i in range(k)})
    return [names[i] for i in idx]

def arc(deg):
    """every camera inside an azimuth wedge of `deg` starting at az[0]."""
    a0=az[0]
    return [n for n,a in zip(names,az) if ((a-a0) % 360) <= deg]

def gap(deg):
    """all cameras except a wedge of `deg` - one side of the object missed."""
    a0=az[0]
    return [n for n,a in zip(names,az) if ((a-a0) % 360) > deg]

spec={}
for k in [4,5,6,7,8,10,12,14,16,20,24,28,32,36,41]:
    if k<=N: spec[f'count_{k:02d}']=even(k)
for d in [90,120,180,240,300]:
    s=arc(d)
    if len(s)>=3: spec[f'arc_{d}deg_n{len(s)}']=s
for d in [60,90,120,150]:
    s=gap(d)
    if len(s)>=3: spec[f'gap_{d}deg_n{len(s)}']=s
json.dump(spec,open(sys.argv[2],'w'),indent=1)
print(f'{len(spec)} subsets from {N} cameras')
for k,v in spec.items(): print(f'  {k:<22} n={len(v)}')
