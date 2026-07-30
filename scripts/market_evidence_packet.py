"""Immutable P1-E run payloads and writer packets with stable business identities."""
from __future__ import annotations
import gzip, hashlib, io, json, os, tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT=Path(__file__).resolve().parents[1]; RUNS=ROOT/'data'/'market-evidence'/'runs'; PACKETS=ROOT/'content'/'writer-packets'
UTC=timezone.utc
def _json_value(value:Any)->Any:
 if isinstance(value,list):return [_json_value(item) for item in value]
 if isinstance(value,dict):return {key:_json_value(item) for key,item in value.items()}
 if isinstance(value,float) and value.is_integer():return int(value)
 return value
def _bp(value:Any)->Any:
 if value is None:return None
 normalized=round(float(value),2)
 return int(normalized) if normalized.is_integer() else normalized
def _normalize_treasury_bp(treasury:dict)->dict:
 normalized={**treasury,'spread2s10sBp':_bp(treasury.get('spread2s10sBp'))}
 normalized['changesBp']={key:{window:_bp(value) for window,value in changes.items()} for key,changes in treasury.get('changesBp',{}).items()}
 return normalized
def canonical(x:Any)->bytes:return json.dumps(_json_value(x),ensure_ascii=False,sort_keys=True,separators=(',',':')).encode('utf-8')
def digest(x:Any)->str:return hashlib.sha256(canonical(x)).hexdigest()
def now_utc()->str:return datetime.now(UTC).isoformat(timespec='seconds')
def stable(x:dict[str,Any], omit:set[str])->dict[str,Any]: return {k:v for k,v in x.items() if k not in omit}
def identity(value:Any)->Any:
 if isinstance(value,list): return [identity(item) for item in value]
 if isinstance(value,dict): return {key:identity(item) for key,item in value.items() if key not in {'requestedAt','completedAt','generatedAt','rawSha256','integrity','businessIntegrity','writerPacketId','runId'}}
 return value
def gz(x:Any)->bytes:
 b=io.BytesIO()
 with gzip.GzipFile(filename='',mode='wb',fileobj=b,mtime=0) as f:f.write(canonical(x))
 return b.getvalue()
def write_immutable(path:Path,payload:dict)->bool:
 path.parent.mkdir(parents=True,exist_ok=True)
 if path.exists():
  with gzip.open(path,'rb') as f: existing=json.loads(f.read())
  if existing.get('runId')==payload.get('runId') and existing.get('businessIntegrity')==payload.get('businessIntegrity'):return False
  raise FileExistsError(f'immutable conflict: {path.name}')
 fd,tmp=tempfile.mkstemp(dir=path.parent,suffix='.tmp');os.close(fd);Path(tmp).write_bytes(gz(payload));os.replace(tmp,path);return True
def _source_index(sources:list[dict])->dict[str,dict]:
 return {s['sourceId']:{k:s.get(k) for k in ('sourceId','datasetId','sourceClass','official','asOf','releasedAt','status','sourceUrl','rawSha256','parserVersion','normalizerVersion','warnings','errorClass')} for s in sources}
def _fact(key,label,treasury,source_id):
 source=treasury['realSource'] if source_id=='us-treasury-real-xml' else treasury['nominalSource']
 changes=treasury.get('changesBp',{}).get(key,{})
 return {'factId':f'treasury-{key}-{treasury.get("asOf")}', 'topic':'treasury','market':'US','label':label,'value':treasury.get(key),'unit':'percent' if key!='spread2s10sBp' else 'bp','change1d':changes.get('1d'),'change5d':changes.get('5d'),'change20d':changes.get('20d'),'changeUnit':'bp','asOf':treasury.get('asOf'),'releasedAt':treasury.get('releasedAt'),'status':treasury.get('status'),'sourceId':source_id,'sourceUrl':source.get('sourceUrl') if source else None}
def packet(edition:str,requested_as_of:str,treasury:dict,sources:list[dict],breadth:dict|None=None)->dict:
 treasury=_normalize_treasury_bp(treasury)
 facts=[_fact('nominal2y','US Treasury 2Y',treasury,'us-treasury-nominal-xml'),_fact('nominal10y','US Treasury 10Y',treasury,'us-treasury-nominal-xml'),_fact('nominal30y','US Treasury 30Y',treasury,'us-treasury-nominal-xml'),_fact('real10y','US Treasury real 10Y',treasury,'us-treasury-real-xml'),_fact('spread2s10sBp','US Treasury 2s10s spread',treasury,'us-treasury-nominal-xml')]
 required=[s for s in sources if s.get('required')]; required_ok=all(s.get('status')=='ready' for s in required)
 provider_status='ready' if all(s.get('status')=='ready' for s in sources) else 'partial'
 out={'schemaVersion':1,'writerPacketId':'','edition':edition,'generatedAt':now_utc(),'marketDates':{'aShare':requested_as_of,'us':treasury.get('asOf')},'facts':facts,'treasuryFactor':treasury,'marketBreadth':breadth or {'status':'unavailable'},'sectorRotation':{'status':'unchanged'},'marketSummary':{'status':'partial'},'providerHealth':{'status':provider_status,'readySources':sum(s.get('status')=='ready' for s in sources),'sourceCount':len(sources),'requiredSourceCount':len(required),'requiredSourcesReady':required_ok},'missingData':['marketBreadth'] if not breadth else [],'warnings':list(treasury.get('warnings',[]))+['marketBreadth unavailable: CSI WAF is not retried or backfilled'],'sourceIndex':_source_index(sources),'integrity':{}}
 business=identity(out)
 out['writerPacketId']=digest(business);out['integrity']={'sha256':digest(business),'businessSha256':digest(business)}
 return out
def persist(edition:str,requested_as_of:str,treasury:dict,sources:list[dict],breadth:dict|None,dry_run:bool,packet_output:str|None=None)->dict:
 requested_at=now_utc(); p=packet(edition,requested_as_of,treasury,sources,breadth); completed_at=now_utc()
 run={'schemaVersion':1,'runId':'','edition':edition,'requestedAsOf':requested_as_of,'requestedAt':requested_at,'completedAt':completed_at,'marketDates':p['marketDates'],'sources':sources,'facts':p['facts'],'factors':{'treasury':treasury},'dataHealth':p['providerHealth'],'warnings':p['warnings'],'writerPacketSha256':p['integrity']['businessSha256'],'businessIntegrity':'','integrity':{}}
 business=identity(run);run['runId']=digest(business);run['businessIntegrity']=digest(business);run['integrity']={'sha256':digest(business),'businessSha256':run['businessIntegrity']}
 wrote=False
 if not dry_run:
  wrote=write_immutable(RUNS/requested_as_of[:4]/requested_as_of[5:7]/(run['runId']+'.json.gz'),run);PACKETS.mkdir(parents=True,exist_ok=True);(PACKETS/(edition+'-latest.json')).write_bytes(canonical(p)+b'\n')
 elif packet_output:
  target=Path(packet_output);target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(canonical(p)+b'\n')
 return {'runId':run['runId'],'writerPacketId':p['writerPacketId'],'edition':edition,'status':p['providerHealth']['status'],'treasuryStatus':treasury.get('status'),'breadthStatus':(breadth or {}).get('status','unavailable'),'sourceCount':len(sources),'wroteRun':wrote,'dryRun':dry_run}
