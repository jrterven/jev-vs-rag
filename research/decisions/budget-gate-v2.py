"""Read-only pilot forecast, written once before held-out execution; no API calls."""
from pathlib import Path
import hashlib
import json
import sqlite3
from decimal import Decimal as D

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'data/research/decisions-extension-20261007-v1/v2'
base = ROOT / 'data/research/gb10-main-study-20261004-v1'
pilot = json.loads((OUT / 'pilot/manifest.json').read_text())
main = json.loads((OUT / 'main/manifest.json').read_text())
completed = json.loads((OUT / 'pilot/completion.json').read_text())
if completed['exitError'] or not completed['allRetrievalTerminal'] or completed['retrievalFailed'] or completed['generationComplete'] != completed['generationPlanned']:
    raise SystemExit('Pilot not completely successful; inspect before any held-out launch.')
if main['implementationHash'] != pilot['implementationHash']:
    raise SystemExit('Source changed after pilot.')
db = sqlite3.connect(f'file:{ROOT / "data/research/study-budget.sqlite"}?mode=ro', uri=True)

def immutable(key):
    row = db.execute('SELECT value FROM immutable WHERE key=?', (key,)).fetchone()
    if not row:
        raise ValueError('Missing preparation checkpoint: ' + key)
    return json.loads(row[0])

attempts = [json.loads(v) for v, in db.execute('SELECT value FROM attempts')]
if any(a['status'] == 'pending' for a in attempts):
    raise SystemExit('Pending API calls remain.')
pilot_calls = [a for a in attempts if a['runId'].startswith(pilot['id'] + ':')]
if any(a['costUsd'] is None or a['status'] != 'completed' for a in pilot_calls):
    raise SystemExit('Pilot has failed or unknown-consumption attempts; inspect.')
ratios, hybrid_costs, generation_costs = [], [], []
for r in pilot['schedule']:
    calls = [a for a in pilot_calls if a['runId'] == r['id']]
    retrieval = sum((D(a['costUsd']) for a in calls if a['operation'] != 'generation'), D(0))
    gen = sum((D(a['costUsd']) for a in calls if a['operation'] == 'generation'), D(0))
    generation_costs.append(gen)
    if r['method'] == 'decisions-scan':
        tokens = immutable(pilot['id'] + ':preparation:' + r['documentId'])['tokens']
        ratios.append(retrieval / D(tokens))
    else:
        hybrid_costs.append(retrieval)
# Use the maximum pilot rate (including all reductions and overlaps), not its mean.
# Then add a 2x margin for document/candidate-window variation.
scan = sum((D(immutable('gb10-main-study-20261004-v1:preparation:' + r['documentId'])['tokens']) * max(ratios) * 2 for r in main['schedule'] if r['method'] == 'decisions-scan'), D(0))
hybrid = D(sum(r['method'] == 'hybrid-decisions' for r in main['schedule'])) * max(hybrid_costs) * 2
generation = D(sum(r['generate'] for r in main['schedule'])) * max(generation_costs) * 2
judge_allowance, failure_allowance = D(20), D(3)
forecast = scan + hybrid + generation + judge_allowance + failure_allowance
known = sum((D(a['costUsd']) for a in attempts if a['costUsd'] is not None), D(0))
reserve = sum((D(a['reservedUsd']) for a in attempts if a['costUsd'] is None), D(0))
extension = sum((D(a['costUsd'] if a['costUsd'] is not None else a['reservedUsd']) for a in attempts if a['runId'].startswith('decisions-extension-20261007-v1:')), D(0))
receipt = dict(schemaVersion=1, accepted=forecast + extension <= 100 and forecast + known + reserve <= 200,
    implementationHash=main['implementationHash'], pilotManifestSha256=hashlib.sha256((OUT/'pilot/manifest.json').read_bytes()).hexdigest(), mainManifestSha256=hashlib.sha256((OUT/'main/manifest.json').read_bytes()).hexdigest(),
    policy='max observed pilot rate, 2x margin; 20 USD judge allowance and 3 USD failure allowance; no test outcomes inspected',
    projectedScanUsd=str(scan), projectedHybridUsd=str(hybrid), projectedGenerationUsd=str(generation), judgeAllowanceUsd=str(judge_allowance), failureAllowanceUsd=str(failure_allowance),
    projectedAdditionalUsd=str(forecast), globalKnownUsd=str(known), globalUnknownReservedUsd=str(reserve), priorExtensionCommittedUsd=str(extension), globalCapUsd='200', extensionCapUsd='100',
    pilotQuestions=10, pilotSearches=len(pilot['schedule']), mainSearches=len(main['schedule']), mainGeneration=sum(r['generate'] for r in main['schedule']))
path = OUT / 'pilot-budget-gate.json'
if path.exists():
    if json.loads(path.read_text()) != receipt: raise SystemExit('Forecast is immutable; inspect existing gate.')
else:
    with path.open('x') as f: json.dump(receipt, f, indent=2)
print(json.dumps(receipt))
