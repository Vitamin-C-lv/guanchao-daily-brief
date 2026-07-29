"""Narrow P1-E public-source functions; no cookies, browser automation, or provider framework."""
from __future__ import annotations
import hashlib, xml.etree.ElementTree as ET
from datetime import date
from typing import Any
import requests

TREASURY='https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data={kind}&field_tdr_date_value={year}'
def _tag(e:ET.Element)->str:return e.tag.rsplit('}',1)[-1]
def _entries(body:bytes)->list[dict[str,str]]:
 root=ET.fromstring(body);out=[]
 for entry in root.iter():
  if _tag(entry)=='entry':
   row={_tag(x):str(x.text or '').strip() for x in entry.iter() if x is not entry and x.text}
   if row:out.append(row)
 return out
def treasury(as_of:str)->dict[str,Any]:
 rows={};meta=[]
 for kind,key in [('daily_treasury_yield_curve','nominal'),('daily_treasury_real_yield_curve','real')]:
  url=TREASURY.format(kind=kind,year=as_of[:4]);r=requests.get(url,headers={'Accept':'application/atom+xml,application/xml'},timeout=(8,30));raw=r.content
  meta.append((key,url,r.status_code,hashlib.sha256(raw).hexdigest()))
  if r.status_code!=200 or not raw.lstrip().startswith(b'<'):continue
  for row in _entries(raw):
   d=row.get('NEW_DATE') or row.get('NEW_DATE ') or row.get('NEW_DATE\r')
   if d: rows.setdefault(key,[]).append((d[:10],row))
 n=sorted((x for x in rows.get('nominal',[]) if x[0]<=as_of),reverse=True); real=sorted((x for x in rows.get('real',[]) if x[0]<=as_of),reverse=True)
 if not n:return {'status':'unavailable','sourceId':'us-treasury-nominal-xml','sourceUrl':meta[0][1],'warnings':['nominal Treasury XML unavailable']}
 d,row=n[0];rrow=next((x[1] for x in real if x[0]==d),None)
 def f(v):
  try:return float(v)
  except:return None
 out={'asOf':d,'releasedAt':d,'nominal2y':f(row.get('BC_2YEAR')),'nominal10y':f(row.get('BC_10YEAR')),'nominal30y':f(row.get('BC_30YEAR')),'real10y':f(rrow.get('TC_10YEAR')) if rrow else None,'sourceId':'us-treasury-nominal-xml','sourceUrl':meta[0][1],'rawSha256':meta[0][3],'changesBp':{},'warnings':[]}
 out['spread2s10sBp']=None if None in (out['nominal2y'],out['nominal10y']) else round((out['nominal10y']-out['nominal2y'])*100,2)
 out['status']='ready' if all(out[k] is not None for k in ('nominal2y','nominal10y','nominal30y','real10y')) else 'partial'
 out['curveRegime']='mixed' if out['status']=='ready' else ('partial' if out['status']=='partial' else 'unavailable');out['causeAssessment']='insufficient_data';out['outputMode']='evidence_observation';out['notProbability']=True;out['includedInProductionModel']=False;out['includedInPublicationGate']=False
 return out
