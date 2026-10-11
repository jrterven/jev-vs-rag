#!/usr/bin/env python3
"""Compare closed Clef judging with both closed earlier cohorts. No APIs.

Uses the unchanged official-metric analysis and existing paired comparator,
extending only fresh in-memory method allowlists. Inputs and old code stay fixed.
"""
from pathlib import Path
import argparse,hashlib,importlib.util,json

ROOT=Path(__file__).resolve().parents[2]
NEW_METHODS=('hybrid-clef','clef-scan')
DECISIONS_METHODS=('hybrid-decisions','decisions-scan')
SOURCE_PINS={
    'research/decisions/analyze-judge.py':'dc41bdba663755d58a27d368f9eeec5e5cacce572c50e5dbc095cd674070ed5f',
    'research/ragas/study-analysis.py':'f76410e2c9e6c1b1ce12a2b1cfd908996e84040bf8353d50f88ee4e73402af8b',
}
DECISIONS_FILES={
    'samples.jsonl':'7e4a43782713e51af349e9fe3243f5192a15ca6fb54be31d12affcd105bcdfdc',
    'study.results.jsonl':'265b6c9d314bac1978fce5ec9c04b4f6fc1214ea9f3edc710dd4cf14748a367b',
    'study.results.jsonl.manifest.json':'1aa0dbcb53ba2c1018b0c63642b4b9358ecd5af6a5d741dcf3aa0676a3384edc',
    'export-manifest.json':'96a6a92ce499eb545b5afea800232e97dcdb54441da6a363c6585e7078017ade',
}
def digest(path):
    with path.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def load():
    for name,sha in SOURCE_PINS.items():
        if digest(ROOT/name)!=sha:raise ValueError('Original analysis source changed: '+name)
    spec=importlib.util.spec_from_file_location('clef_pairing_reference',ROOT/'research/decisions/analyze-judge.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    module.BASE.METHODS=(*module.ORIGINAL_METHODS,*DECISIONS_METHODS,*NEW_METHODS)
    return module

REFERENCE=load()
BASE=REFERENCE.BASE
ORIGINAL_FILES=REFERENCE.ORIGINAL_FILES

def compare_records(old_samples,old_results,old_export,old_runtime,new_samples,new_results,new_export,new_runtime,*,baseline='original',iterations=10000,seed=42):
    if baseline not in ('original','decisions'):raise ValueError('Explicit valid baseline cohort required')
    module=load()  # Fresh globals; comparisons/tests cannot modify old modules.
    module.NEW_METHODS=NEW_METHODS
    if baseline=='decisions':
        module.ORIGINAL_METHODS=DECISIONS_METHODS;module.BASELINES=DECISIONS_METHODS
    report=module.compare_records(old_samples,old_results,old_export,old_runtime,new_samples,new_results,new_export,new_runtime,iterations=iterations,seed=seed)
    # Existing comparator also emits an intra-Decisions contrast. The Clef
    # comparison contains only contrasts whose left method is a Clef arm.
    report['paired']=[row for row in report['paired'] if row['method'] in NEW_METHODS]
    report['kind']='clef-extension-ragas-comparison';report['baselineCohort']=baseline
    report['limitations'].append('Clef retrieval timing is single-pass descriptive after an explicit runtime-driven amendment; this does not change frozen generation assignments or judging.')
    return report

def read_cohort(directory,node):
    return load().read_cohort(directory,node)

def main():
    p=argparse.ArgumentParser(description=__doc__)
    for name in ['original','decisions','extension','audit','out']:p.add_argument('--'+name,type=Path,required=True)
    p.add_argument('--node',default='node');args=p.parse_args()
    for directory,pins in [(args.original,ORIGINAL_FILES),(args.decisions,DECISIONS_FILES)]:
        for name,sha in pins.items():
            if digest(directory/name)!=sha:raise ValueError('Closed earlier cohort changed: '+str(directory/name))
    if digest(ROOT/'research/ragas/runtime.py')!=REFERENCE.RUNTIME_SHA:raise ValueError('Frozen official RAGAS runtime changed')
    freeze=json.loads((args.extension/'extension-judge-freeze.json').read_text())
    for name,sha in freeze['files'].items():
        if digest(ROOT/name)!=sha:raise ValueError('Executed Clef source changed: '+name)
    if digest(args.extension/'samples.jsonl')!=freeze['sampleSha256']:raise ValueError('Frozen Clef samples changed')
    audit=json.loads(args.audit.read_text());completion=json.loads((args.extension/'completion.json').read_text())
    if not audit.get('ok') or not audit.get('allMetricsTerminal') or audit['integrity']['freezeSha256']!=digest(args.extension/'extension-judge-freeze.json'):raise ValueError('Final ledger/raw-score audit missing or unbound')
    if completion.get('allMetricsTerminal') is not True or completion['terminal']!=completion['expected']:raise ValueError('Clef judge not closed')
    cohorts={name:read_cohort(directory,args.node) for name,directory in [('original',args.original),('decisions',args.decisions),('clef',args.extension)]}
    expected={'original':('gb10-main-study-20261004-v1',1800),'decisions':('decisions-extension-20261007-v1:v2:main',400),'clef':('clef-spark-20261007-v1:main',400)}
    for name,cohort in cohorts.items():
        provenance=cohort[2]['provenance']
        if len(provenance)!=1 or (provenance[0]['experimentId'],provenance[0]['scheduledGenerations'])!=expected[name]:raise ValueError('Frozen experiment/selection differs: '+name)
        if cohort[3]['runtimeSha256']!=REFERENCE.RUNTIME_SHA:raise ValueError('Scientific runtime differs: '+name)
    if cohorts['clef'][3]['runId']!=freeze['runId']:raise ValueError('Clef judge identity differs')
    old,new=cohorts['original'],cohorts['clef'];dec=cohorts['decisions']
    original_comparison=compare_records(*old[:4],*new[:4]);decisions_comparison=compare_records(*dec[:4],*new[:4],baseline='decisions')
    if len(original_comparison['sharedGenerationQuestions'])!=200 or original_comparison['sharedGenerationQuestions']!=decisions_comparison['sharedGenerationQuestions']:raise ValueError('The same original200 generation questions are required')
    result={'schemaVersion':1,'kind':'clef-extension-final-secondary-comparison','scope':'test','originalComparison':original_comparison,'decisionsComparison':decisions_comparison,
            'integrity':{'cohorts':{name:value[4] for name,value in cohorts.items()},'originalPins':ORIGINAL_FILES,'decisionsPins':DECISIONS_FILES,'sourcePins':SOURCE_PINS,
                         'comparisonSourceSha256':digest(Path(__file__)),'clefFreezeSha256':digest(args.extension/'extension-judge-freeze.json'),'finalAuditSha256':digest(args.audit)}}
    for directory in [args.original,args.decisions,args.extension]:
        if args.out.resolve()==directory.resolve() or directory.resolve() in args.out.resolve().parents:raise ValueError('Analysis output must be outside preserved cohorts')
    args.out.parent.mkdir(parents=True,exist_ok=True)
    with args.out.open('x') as f:json.dump(result,f,indent=2,ensure_ascii=False,allow_nan=False);f.write('\n')
    print(json.dumps({'out':str(args.out),'generationQuestions':200,'clef':original_comparison['extension']['accounting'],'pairedContrasts':len(original_comparison['paired'])+len(decisions_comparison['paired'])}))
if __name__=='__main__':main()
