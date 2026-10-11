"""Regression fixtures only; these never enter any measured result package."""
import json,tempfile,unittest
from pathlib import Path
from test_audit import fixture,write
from runtime import digest
from audit_amended import audit

def amended(root):
    inputs,out,calls=fixture(root)
    write(out/'process.json',{'pid':999999998})
    write(out/'exit.json',{'status':'failed','terminal':1})
    write(out/'halt.json',{'error':'KeyboardInterrupt: '})
    (out/'completion.json').unlink()
    write(out.parent/'continuation-exit.json',{'status':'failed'})
    write(out.parent/'continuation-halt.json',{'error':'Test exited -2; preserve terminal cases'})
    hashes={p.name:digest(p) for p in (out/'runs').glob('*.json')}
    stop=out.parent/'stop.json'
    write(stop,{'kind':'explicit-user-authorized-protocol-amendment','authorization':'Juan: detener las repeticiones y avanzar al cierre',
                'inputManifestSha256':digest(inputs/'manifest.json'),'mainPid':999999998,'supervisorPid':999999997,'primaryAssignments':1,
                'terminalRunHashesAtStopRequest':hashes,'primaryRunHashes':hashes})
    return inputs,out,stop,calls

class AmendedAuditTest(unittest.TestCase):
    def test_explicit_amendment_preserves_failed_exit_and_complete_primary(self):
        with tempfile.TemporaryDirectory() as d:
            i,o,a,_=amended(Path(d));result=audit(i,o,a)
            self.assertTrue(result['primaryComplete']);self.assertEqual(read(o/'exit.json')['status'],'failed')
    def test_cannot_silently_accept_incomplete_primary(self):
        with tempfile.TemporaryDirectory() as d:
            i,o,a,_=amended(Path(d));next((o/'runs').glob('*.json')).unlink()
            with self.assertRaises(AssertionError):audit(i,o,a)
    def test_changed_terminal_record_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            i,o,a,_=amended(Path(d));p=next((o/'runs').glob('*.json'));value=read(p);value['extra']='changed';write(p,value)
            with self.assertRaises(AssertionError):audit(i,o,a)
    def test_reference_leak_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            i,o,a,c=amended(Path(d));events=[json.loads(s) for s in c.read_text().splitlines()]
            events[0]['payload']['answer']='leaked';c.write_text('\n'.join(map(json.dumps,events)))
            with self.assertRaises(AssertionError):audit(i,o,a)
    def test_wrong_stop_reason_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            i,o,a,_=amended(Path(d));write(o/'halt.json',{'error':'GPU failure'})
            with self.assertRaises(AssertionError):audit(i,o,a)

def read(p):return json.loads(p.read_text())
if __name__=='__main__':unittest.main()
