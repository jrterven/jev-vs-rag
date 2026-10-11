"""Synthetic audit fixtures, never scientific results."""
import hashlib,json,tempfile,unittest
from pathlib import Path
from audit import audit
from runtime import digest,identity,request_body,REVISION

def write(p,v):p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(v))
def fixture(root):
    inputs=root/'input';out=root/'output'
    chunks=[{'id':f'c{i}','ordinal':i,'path':[],'text':f'Synthetic passage {i}'} for i in range(2)]
    row={'id':'synthetic','method':'clef-scan','questionId':'q1','documentId':'d1','round':0}
    files={'documents/d1.json':{'id':'d1','chunks':chunks},'questions.json':[{'id':'q1','question':'What?'}],'schedule.json':[row],'candidates.json':{}}
    for name,value in files.items():write(inputs/name,value)
    source={'files':{name:digest(inputs/name) for name in files},'scheduled':1,'phase':'pilot','documents':[{'id':'d1','path':'documents/d1.json'}]}
    write(inputs/'manifest.json',source)
    sources={'fixture.py':'# synthetic'};codehash=identity(sources)
    environment={'revision':REVISION,'cpuFallback':False,'quantized':False}
    write(out/'environment.json',environment)
    write(out/'source-snapshot.json',{'files':sources,'hash':codehash})
    write(out/'manifest.json',{'inputManifestSha256':digest(inputs/'manifest.json'),'implementationHash':codehash,'environment':environment})
    write(out/'completion.json',{'allRetrievalTerminal':True,'terminal':1,'planned':1,'statuses':{'completed':1}})
    write(out/'exit.json',{'status':'completed'});write(out/'smoke-completion.json',{'passed':True})
    key=hashlib.sha256(row['id'].encode()).hexdigest();body=request_body('What?',chunks)
    events=[{'event':'start','runId':'synthetic','call':'one','level':0,'payload':body},
            {'event':'complete','runId':'synthetic','call':'one','result':{'payloadHash':identity(body),'usage':{'input_tokens':50},'commonTokens':45,'apiCostUsd':'0'}}]
    callpath=out/'calls'/(key+'.jsonl');callpath.parent.mkdir();callpath.write_text('\n'.join(map(json.dumps,events)))
    write(out/'runs'/(key+'.json'),{**row,'status':'completed','calls':1,'ranking':[{'chunkId':'c0'},{'chunkId':'c1'}],
          'initialPassagesCovered':2,'initialPassages':2,'latencyScope':'full-scan','traces':[{'retainedIds':['c0','c1']}]})
    return inputs,out,callpath

class AuditTest(unittest.TestCase):
    def test_closed_complete_fixture_passes(self):
        with tempfile.TemporaryDirectory() as d:
            i,o,_=fixture(Path(d));r=audit(i,o)
            self.assertTrue(r['passed']);self.assertEqual(r['calls'],1)
    def test_changed_document_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            i,o,_=fixture(Path(d));(i/'documents/d1.json').write_text('{}')
            with self.assertRaises(AssertionError):audit(i,o)
    def test_missing_terminal_call_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            i,o,c=fixture(Path(d));c.write_text(c.read_text().splitlines()[0])
            with self.assertRaises(AssertionError):audit(i,o)
    def test_payload_containing_answer_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            i,o,c=fixture(Path(d));events=[json.loads(l) for l in c.read_text().splitlines()]
            events[0]['payload']['reference_answer']='Hidden reference'
            events[1]['result']['payloadHash']=identity(events[0]['payload'])
            c.write_text('\n'.join(map(json.dumps,events)))
            with self.assertRaises(AssertionError):audit(i,o)
    def test_open_cohort_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            i,o,_=fixture(Path(d));write(o/'exit.json',{'status':'failed'})
            with self.assertRaises(AssertionError):audit(i,o)
if __name__=='__main__':unittest.main()
