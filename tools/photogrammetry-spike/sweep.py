#!/usr/bin/env python3
"""Run colmap mapper over a set of image subsets against one shared
feature/match database, and tabulate what each subset reconstructed."""
import os, re, sys, json, time, shutil, subprocess

W='/home/user/pgspike'
DB=f'{W}/work/monstree.db'
IMG=f'{W}/data/monstree/full'
OUT=f'{W}/work/sweep'

def analyze(model_dir):
    r=subprocess.run(['colmap','model_analyzer','--path',model_dir],
                     capture_output=True,text=True)
    txt=r.stdout+r.stderr
    def g(pat,cast=float):
        m=re.search(pat,txt)
        return cast(m.group(1)) if m else None
    return {
      'cameras':g(r'Cameras:\s*(\d+)',int),
      'images':g(r'Images:\s*(\d+)',int),
      'registered':g(r'Registered images:\s*(\d+)',int),
      'points':g(r'Points:\s*(\d+)',int),
      'observations':g(r'Observations:\s*(\d+)',int),
      'mean_track_len':g(r'Mean track length:\s*([\d.]+)'),
      'mean_obs_per_img':g(r'Mean observations per image:\s*([\d.]+)'),
      'mean_reproj_px':g(r'Mean reprojection error:\s*([\d.]+)'),
    }

def run(name, images, repeats=1, seed=0):
    recs=[]
    for rep in range(repeats):
        d=f'{OUT}/{name}' if repeats==1 else f'{OUT}/{name}__r{rep}'
        shutil.rmtree(d,ignore_errors=True); os.makedirs(d,exist_ok=True)
        lp=f'{d}/images.txt'
        open(lp,'w').write('\n'.join(images)+'\n')
        t0=time.time()
        p=subprocess.run(['colmap','mapper','--database_path',DB,'--image_path',IMG,
            '--output_path',d,'--image_list_path',lp,
            '--random_seed',str(seed+rep),'--Mapper.num_threads','4'],
            capture_output=True,text=True)
        dt=time.time()-t0
        subs=sorted([x for x in os.listdir(d) if x.isdigit()])
        rec={'name':name,'rep':rep,'n_input':len(images),'seconds':round(dt,1),
             'n_submodels':len(subs),'rc':p.returncode}
        if subs:
            # biggest sub-model wins
            best=None
            for s in subs:
                a=analyze(f'{d}/{s}')
                if best is None or (a['registered'] or 0)>(best['registered'] or 0): best=a
            rec.update(best)
            rec['frac_registered']=round((best['registered'] or 0)/len(images),3)
        else:
            rec.update({'registered':0,'frac_registered':0.0,'points':0})
        recs.append(rec)
        print(json.dumps(rec),flush=True)
    return recs

if __name__=='__main__':
    spec=json.load(open(sys.argv[1]))
    reps=int(sys.argv[2]) if len(sys.argv)>2 else 1
    os.makedirs(OUT,exist_ok=True)
    all_recs=[]
    for name,imgs in spec.items():
        all_recs+=run(name,imgs,repeats=reps)
    json.dump(all_recs,open(f'{W}/out/sweep_results.json','w'),indent=1)
    print('WROTE',f'{W}/out/sweep_results.json')
