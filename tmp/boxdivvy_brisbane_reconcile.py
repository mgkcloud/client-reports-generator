#!/usr/bin/env python3
from __future__ import annotations
import json, subprocess, urllib.parse, urllib.request, urllib.error, datetime as dt
from pathlib import Path

OUT=Path('/home/mgk/clawd/reports/boxdivvy-brisbane-reconciliation-20260614')
OUT.mkdir(parents=True, exist_ok=True)
ACCOUNT='act_747429766205314'
SINCE='2026-06-08'
UNTIL='2026-06-14'
API='https://graph.facebook.com/v22.0'

def secret(alias):
    p=subprocess.run(['bash',str(Path.home()/'clawd/scripts/secrets.sh'),'get',alias],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,timeout=10)
    return p.stdout.strip()

token=''
token_alias=''
for alias in ['meta-ads','meta-access-token','META_ACCESS_TOKEN','meta']:
    token=secret(alias)
    if token:
        token_alias=alias; break
if not token: raise SystemExit('missing token')

def graph(path, params):
    params=dict(params); params['access_token']=token
    url=API+path+'?'+urllib.parse.urlencode(params)
    req=urllib.request.Request(url,headers={'User-Agent':'Hermes-BoxDivvy-Reconcile/1.0'})
    with urllib.request.urlopen(req,timeout=90) as r:
        return json.loads(r.read().decode('utf-8','replace'))

def paged(path, params):
    first=graph(path, params)
    if 'error' in first: return first
    data=list(first.get('data',[])); paging=first.get('paging',{})
    url=paging.get('next')
    while url:
        req=urllib.request.Request(url,headers={'User-Agent':'Hermes-BoxDivvy-Reconcile/1.0'})
        with urllib.request.urlopen(req,timeout=90) as r:
            j=json.loads(r.read().decode('utf-8','replace'))
        data.extend(j.get('data',[])); url=(j.get('paging') or {}).get('next')
    first['data']=data; first.pop('paging',None); return first

fields='campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,clicks,inline_link_clicks,ctr,actions,action_values,cost_per_action_type'
time_range=json.dumps({'since':SINCE,'until':UNTIL})
levels={}
for level,fields2 in {
    'campaign':'campaign_id,campaign_name,spend,impressions,clicks,inline_link_clicks,ctr,actions,action_values,cost_per_action_type',
    'adset':'campaign_id,campaign_name,adset_id,adset_name,spend,impressions,clicks,inline_link_clicks,ctr,actions,action_values,cost_per_action_type',
    'ad':'campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,clicks,inline_link_clicks,ctr,actions,action_values,cost_per_action_type'
}.items():
    levels[level]=paged('/'+ACCOUNT+'/insights',{'level':level,'fields':fields2,'time_range':time_range,'limit':500})

# Also account totals for sanity.
levels['account']=paged('/'+ACCOUNT+'/insights',{'level':'account','fields':'spend,impressions,clicks,inline_link_clicks,ctr,actions,action_values,cost_per_action_type','time_range':time_range,'limit':500})

def actions(row):
    return {a.get('action_type'): float(a.get('value',0)) for a in row.get('actions') or []}

def row_metrics(row):
    a=actions(row)
    lead=a.get('lead',0)
    complete=a.get('complete_registration',0) or a.get('offsite_conversion.fb_pixel_complete_registration',0) or a.get('omni_complete_registration',0)
    # aliases for diagnostic only
    lead_aliases={k:v for k,v in a.items() if 'lead' in k.lower()}
    complete_aliases={k:v for k,v in a.items() if 'complete_registration' in k.lower()}
    return {
        'spend':float(row.get('spend') or 0),
        'impressions':int(float(row.get('impressions') or 0)),
        'clicks':int(float(row.get('clicks') or 0)),
        'inline_link_clicks':int(float(row.get('inline_link_clicks') or 0)),
        'ctr':float(row.get('ctr') or 0),
        'lead':lead,
        'complete_registration':complete,
        'lead_aliases':lead_aliases,
        'complete_aliases':complete_aliases,
    }

def classify(row):
    txt=' '.join(str(row.get(k,'')).lower() for k in ['campaign_name','adset_name','ad_name'])
    if 'brisbane' in txt or 'bne' in txt or 'qld' in txt:
        return 'brisbane'
    if 'melbourne' in txt or 'melb' in txt or 'vic' in txt:
        return 'melbourne'
    if 'bendigo' in txt:
        return 'bendigo'
    return 'other'

summary={'created_at':dt.datetime.now(dt.timezone.utc).isoformat(),'account':ACCOUNT,'since':SINCE,'until':UNTIL,'token_alias':token_alias,'levels':levels}
# Aggregate by level/classification
for level in ['campaign','adset','ad']:
    classes={}
    rows=levels[level].get('data',[]) if isinstance(levels[level],dict) else []
    for row in rows:
        cls=classify(row)
        classes.setdefault(cls,{'spend':0,'lead':0,'complete_registration':0,'impressions':0,'clicks':0,'inline_link_clicks':0,'rows':0,'top_rows':[]})
        m=row_metrics(row); c=classes[cls]
        for k in ['spend','lead','complete_registration','impressions','clicks','inline_link_clicks']:
            c[k]+=m[k]
        c['rows']+=1
        c['top_rows'].append({
            'campaign_name':row.get('campaign_name'), 'adset_name':row.get('adset_name'), 'ad_name':row.get('ad_name'),
            'campaign_id':row.get('campaign_id'), 'adset_id':row.get('adset_id'), 'ad_id':row.get('ad_id'), **m
        })
    for c in classes.values():
        c['top_rows']=sorted(c['top_rows'], key=lambda r:r['spend'], reverse=True)[:20]
    summary[f'{level}_classification']=classes

# Report-generator-style Brisbane = campaign name contains Brisbane only
camp_rows=levels['campaign'].get('data',[])
rg_bris=[r for r in camp_rows if 'brisbane' in (r.get('campaign_name','').lower())]
summary['report_generator_brisbane_campaign_name_filter']=[{'campaign_name':r.get('campaign_name'), **row_metrics(r)} for r in rg_bris]
summary['all_campaigns']=[{'campaign_name':r.get('campaign_name'), 'campaign_id':r.get('campaign_id'), **row_metrics(r)} for r in camp_rows]

(OUT/'meta_reconcile_raw.json').write_text(json.dumps(summary,indent=2))
# Compact print
compact={k:summary[k] for k in ['created_at','account','since','until']}
compact['account_total']=[row_metrics(r) for r in levels['account'].get('data',[])]
compact['campaigns']=summary['all_campaigns']
compact['campaign_classification']=summary['campaign_classification']
compact['adset_classification']={k:{kk:vv for kk,vv in v.items() if kk!='top_rows'} for k,v in summary['adset_classification'].items()}
compact['ad_classification']={k:{kk:vv for kk,vv in v.items() if kk!='top_rows'} for k,v in summary['ad_classification'].items()}
print(json.dumps(compact,indent=2))
