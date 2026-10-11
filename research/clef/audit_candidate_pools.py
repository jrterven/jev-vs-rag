#!/usr/bin/env python3
"""Describe audited candidate-pool scope; no tuning, inference or paid calls."""
from pathlib import Path
import argparse,datetime,hashlib,json,statistics

def read(p):return json.loads(p.read_text())
def digest(p):
    with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def analyze(inputs,directory,audit_path):
    source=read(inputs/'manifest.json');audit=read(audit_path)
    assert digest(inputs/'manifest.json')=='e4e66b0f42360d4586362fcb47bd3074c2239ef87006539d29b55b27eb2ee3df'
    assert audit['passed'] and audit['primaryComplete'] and audit['primaryTerminal']==952
    assert audit['inputManifestSha256']==digest(inputs/'manifest.json') and audit['manifestSha256']==digest(directory/'manifest.json')
    for name,sha in source['files'].items():assert digest(inputs/name)==sha
    docs={d['id']:read(inputs/d['path']) for d in source['documents']}
    questions={q['id']:q for q in read(inputs/'questions.json')};candidates=read(inputs/'candidates.json')
    schedule=[r for r in read(inputs/'schedule.json') if r['round']==0]
    rows={};hashes={}
    for p in sorted((directory/'runs').glob('*.json')):
        row=read(p)
        if row['round']!=0:continue
        assert digest(p)==audit['runHashes'][p.name] and row['status']=='completed'
        key=(row['questionId'],row['method']);assert key not in rows;rows[key]=row;hashes[p.name]=digest(p)
    assert len(rows)==len(schedule)==952
    groups=[]
    for corpus in ('qasper-test','openstax-books'):
        planned=[r for r in schedule if r['method']=='hybrid-clef' and r['corpus']==corpus]
        ids=[];whole=[];equal=[]
        for row in planned:
            q=questions[row['questionId']];doc=docs[row['documentId']];assert q['documentId']==doc['id']
            all_ids={c['id'] for c in doc['chunks']};pool=candidates[row['id']]
            assert len(pool)==min(50,len(all_ids)) and len(pool)==len(set(pool)) and set(pool)<=all_ids
            if set(pool)==all_ids:whole.append(q['id'])
            left,right=rows[(q['id'],'hybrid-clef')],rows[(q['id'],'clef-scan')]
            assert left['documentId']==right['documentId']==doc['id'] and left['corpus']==right['corpus']==corpus
            if [v['chunkId'] for v in left['ranking']]==[v['chunkId'] for v in right['ranking']]:equal.append(q['id'])
            ids.append(q['id'])
        docids={questions[q]['documentId'] for q in ids};counts=[len(docs[d]['chunks']) for d in docids]
        positives={q for q in ids if not questions[q]['unanswerable']}
        groups.append({'corpus':corpus,'questions':len(ids),'answerableQuestions':len(positives),'documents':len(docids),
                       'questionsWhose50CandidatePoolIsEntireDocument':len(whole),'answerableWhosePoolIsEntireDocument':len(set(whole)&positives),
                       'identicalOrderedFinalFive':len(equal),'answerableIdenticalOrderedFinalFive':len(set(equal)&positives),
                       'documentChunks':{'min':min(counts),'median':statistics.median(counts),'max':max(counts)},
                       'wholeDocumentPoolQuestionIds':whole,'identicalRankingQuestionIds':equal})
    return {'schemaVersion':1,'kind':'audited-clef-candidate-scope-diagnostic','at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'inputManifestSha256':digest(inputs/'manifest.json'),'primaryAuditSha256':digest(audit_path),'primaryRunHashes':hashes,
            'sourceSha256':digest(Path(__file__)),'groups':groups,'paidCalls':0,
            'interpretation':'Identical rankings are observed outcomes, not a new tuning rule. QASPER mostly fits inside the50-candidate pool, so it does not isolate the benefit of whole-book scanning. Books provide the long-document comparison. References, schedules, parameters and generated outputs remain frozen.'}
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--inputs',type=Path,required=True);p.add_argument('--directory',type=Path,required=True);p.add_argument('--audit',type=Path,required=True);p.add_argument('--out',type=Path,required=True);a=p.parse_args()
    result=analyze(a.inputs,a.directory,a.audit);a.out.parent.mkdir(parents=True,exist_ok=True)
    with a.out.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps({'out':str(a.out),'groups':[{k:v for k,v in r.items() if not k.endswith('Ids')} for r in result['groups']],'paidCalls':0}))
