"""P1-E immutable market-data runs and fixed writer packets."""
from __future__ import annotations
import gzip, hashlib, io, json, os, tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT=Path(__file__).resolve().parents[1]; RUNS=ROOT/'data'/'market-evidence'/'runs'; PACKETS=ROOT/'content'/'writer-packets'; CATALOG=ROOT/'config'/'market-evidence-sources.json'
def canonical(x:Any)->bytes:return json.dumps(x,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()
def digest(x:Any)->str:return hashlib.sha256(canonical(x)).hexdigest()
def gz(x:Any)->bytes:
 b=io.BytesIO()
 with gzip.GzipFile(filename='',mode='wb',fileobj=b,mtime=0) as f:f.write(canonical(x))
 return b.getvalue()
def write_immutable(path:Path,payload:dict)->bool:
 path.parent.mkdir(parents=True,exist_ok=True); data=gz(payload)
 if path.exists():
  if path.read_bytes()==data:return False
  raise FileExistsError(f'immutable conflict: {path.name}')
 fd,tmp=tempfile.mkstemp(dir=path.parent,suffix='.tmp');os.close(fd);Path(tmp).write_bytes(data);os.replace(tmp,path);return True
def packet(edition:str,as_of:str,treasury:dict|None,breadth:dict|None)->dict:
 facts=[]
 if treasury:
  for k,label in [('nominal2y','US Treasury 2Y'),('nominal10y','US Treasury 10Y'),('nominal30y','US Treasury 30Y'),('real10y','US Treasury real 10Y')]:
   facts.append({'factId':f'treasury-{k}-{treasury.get("asOf")}', 'topic':'treasury','market':'US','label':label,'value':treasury.get(k),'unit':'percent','change':treasury.get('changesBp',{}).get(k,{}).get('1d'),'changeUnit':'bp','asOf':treasury.get('asOf'),'releasedAt':treasury.get('releasedAt'),'status':treasury.get('status'),'sourceId':treasury.get('sourceId'),'sourceUrl':treasury.get('sourceUrl')})
 out={'schemaVersion':1,'writerPacketId':'','edition':edition,'generatedAt':as_of+'T15:05:00+08:00','marketDates':{'aShare':as_of,'us':treasury.get('asOf') if treasury else None},'facts':facts,'treasuryFactor':treasury or {'status':'unavailable'},'marketBreadth':breadth or {'status':'unavailable'},'sectorRotation':{'status':'unchanged'},'marketSummary':{'status':'partial'},'providerHealth':{'status':'partial'},'missingData':['marketBreadth'] if not breadth else [],'warnings':[],'sourceIndex':sorted({f['sourceId'] for f in facts if f['sourceId']}),'integrity':{}}
 out['writerPacketId']=digest({k:v for k,v in out.items() if k not in {'writerPacketId','integrity'}});out['integrity']={'sha256':digest({k:v for k,v in out.items() if k!='integrity'})};return out
def persist(edition:str,as_of:str,treasury:dict|None,breadth:dict|None,dry_run:bool)->dict:
 p=packet(edition,as_of,treasury,breadth);run={'schemaVersion':1,'runId':'','edition':edition,'requestedAt':as_of+'T15:05:00+08:00','completedAt':as_of+'T15:05:00+08:00','marketDates':p['marketDates'],'sources':[],'facts':p['facts'],'factors':{'treasury':treasury},'dataHealth':p['providerHealth'],'warnings':p['warnings'],'writerPacketSha256':p['integrity']['sha256'],'integrity':{}}
 run['runId']=digest({k:v for k,v in run.items() if k not in {'runId','integrity'}});run['integrity']={'sha256':digest({k:v for k,v in run.items() if k!='integrity'})}
 if not dry_run:
  write_immutable(RUNS/as_of[:4]/as_of[5:7]/(run['runId']+'.json.gz'),run);PACKETS.mkdir(parents=True,exist_ok=True); (PACKETS/(edition+'-latest.json')).write_bytes(canonical(p)+b'\n')
 return {'runId':run['runId'],'writerPacketId':p['writerPacketId'],'edition':edition,'status':'partial' if not breadth else 'ready','treasuryStatus':treasury.get('status') if treasury else 'unavailable','breadthStatus':breadth.get('status') if breadth else 'unavailable','dryRun':dry_run}
