"""One-shot supervisor; never retries terminal runs or automatically launches test."""
import json
import os
from pathlib import Path
import subprocess
import sys
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'data/research/decisions-extension-20261007-v1'
NODE = ROOT / '.runtime/node-v24.21.0-linux-arm64/bin/node'

def stamp():
    return datetime.now(timezone.utc).isoformat()

phase = sys.argv[-1]
if phase not in ('pilot', 'main'):
    raise SystemExit('phase must be pilot or main')
OUT.mkdir(parents=True, exist_ok=True)
if sys.argv[1] == 'supervise':
    with (OUT / f'{phase}.log').open('ab', buffering=0) as log:
        proc = subprocess.Popen([str(NODE), '--import', 'tsx', 'research/decisions/run.ts', 'run', phase, '--allow-paid'], cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
        (OUT / f'{phase}-process.json').write_text(json.dumps({'phase': phase, 'pid': proc.pid, 'supervisorPid': os.getpid(), 'startedAt': stamp()}))
        code = proc.wait()
        with (OUT / f'{phase}-exit.json').open('x') as f:
            json.dump({'phase': phase, 'pid': proc.pid, 'finishedAt': stamp(), 'exitCode': code}, f)
else:
    if (OUT / 'running.lock').exists() or (OUT / f'{phase}-process.json').exists() or (OUT / f'{phase}-exit.json').exists():
        raise SystemExit('Launch already exists or locked; inspect instead of duplicating.')
    with (OUT / f'{phase}-supervisor.log').open('ab') as log:
        proc = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), 'supervise', phase], cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    print(json.dumps({'supervisorPid': proc.pid, 'phase': phase, 'launchedAt': stamp()}))
