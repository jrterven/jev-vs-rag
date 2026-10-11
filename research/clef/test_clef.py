import json,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from runtime import Encoder,TokenLimit,request_body
from search import search
from run import write

def chunks(n):return [{'id':f'c{i:04}','ordinal':i,'path':[],'text':f'Párrafo {i} con evidencia 🧪.'} for i in range(n)]
class Pack:
    def pack(self,q,c):return [c[i:i+8] for i in range(0,len(c),8)]
class Mock:
    encoder=Pack()
    def __init__(self,ties=False,fail=False):self.calls=0;self.ties=ties;self.fail=fail
    def evaluate(self,body):
        self.calls+=1
        if self.fail:raise RuntimeError('transport simulation')
        cs=body['state'];scores={c['id']:0.1 if self.ties else int(c['id'][1:])+1 for c in cs};total=sum(scores.values())
        return {'answers':{'where':{'probabilities':{k:v/total for k,v in scores.items()}},'exists':{'noul':0.9}},'rawProbabilities':{'ignored':'never used as a tiebreak'},'usage':{'input_tokens':123},'payloadHash':'fixture'}
class Calls:
    def __init__(self):self.rows=[]
    def __call__(self,event,value):self.rows.append((event,value));return str(len(self.rows))
class ClefTest(unittest.TestCase):
    def test_native_limit_rejects_full_input_instead_of_accepting_truncation(self):
        observed=[]
        def encode(*args,**kwargs):observed.append(kwargs['max_length']);return SimpleNamespace(input_ids=range(min(13000,kwargs['max_length'])))
        e=Encoder.__new__(Encoder);e.official=SimpleNamespace(encode_record=encode);e.processor=SimpleNamespace(tokenizer=None)
        e.common=SimpleNamespace(encode=lambda *args,**kwargs:[1])
        with self.assertRaises(TokenLimit):e.encode({'state':'long','questions':{}})
        self.assertEqual(observed,[2**31-1])
    def test_all_passages_participate_and_multilevel_reduction_terminates(self):
        m=Mock();r=search(m,'query',chunks(131),Calls())
        self.assertEqual(r['initialPassagesCovered'],131)
        ids=[x for t in r['traces'] if t['stage']=='window' for x in t['candidateIds']]
        self.assertEqual(ids,[c['id'] for c in chunks(131)])
        self.assertIn('c0130',[h['chunkId'] for h in r['ranking']])
        self.assertGreater(max(t['level'] for t in r['traces']),1)
        self.assertEqual(len({h['chunkId'] for h in r['ranking']}),5)
    def test_api_rounded_ties_use_document_order(self):
        r=search(Mock(ties=True),'query',list(reversed(chunks(8))),Calls())
        self.assertEqual([h['chunkId'] for h in r['ranking']],[c['id'] for c in chunks(5)])
    def test_failed_forward_preserved_without_retry(self):
        m=Mock(fail=True);save=Calls()
        with self.assertRaises(RuntimeError):search(m,'query',chunks(8),save)
        self.assertEqual(m.calls,1);self.assertEqual([x[0] for x in save.rows],['start','error'])
    def test_duplicate_passages_rejected(self):
        m=Mock()
        with self.assertRaises(ValueError):search(m,'query',chunks(1)*2,Calls())
        self.assertEqual(m.calls,0)
    def test_reference_answer_is_not_in_model_request(self):
        body=request_body('What?',chunks(1))
        self.assertEqual(set(body),{'model','state','questions'})
        self.assertEqual(body['state'][0]['text'],chunks(1)[0]['text'])
        self.assertIsNone(body['questions']['where']['criteria']['c0000'])
    def test_terminal_records_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'result.json';write(p,{'status':'failed'},True)
            with self.assertRaises(FileExistsError):write(p,{'status':'completed'},True)
            self.assertEqual(json.loads(p.read_text()),{'status':'failed'})
if __name__=='__main__':unittest.main()
