/** One-shot Decisions access/schema probe. Never retries a settled attempt. */
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as dotenv } from 'dotenv';
import { Ledger, paidJson } from '../ledger.js';
import { hashObject } from '../util.js';

dotenv({ path: 'data/research/api.env', quiet: true });
const root = resolve('data/research/decisions-extension-20261007-v1');
mkdirSync(root, { recursive: true, mode: 0o700 });
const resultPath = resolve(root, 'access-probe.json');
if (existsSync(resultPath)) throw new Error('Access probe already recorded; no automatic retry.');
const ledger = new Ledger(resolve('data/research/study-budget.sqlite'));
const runId = 'decisions-extension-20261007-v1:access-probe';
if (ledger.attempts().some(a => a.runId === runId)) throw new Error('Probe attempt already exists; inspect before any new request.');
if (ledger.attempts().some(a => a.status === 'pending')) throw new Error('Unresolved pending provider attempt.');
ledger.freeze('decisions-extension-20261007-v1:authorization', {
  date: '2026-10-07', requestedBy: 'Juan Terven',
  request: '¿puedes repetir los experimentos con decisions API y reportar los resultados?',
  originalResultsRemainFrozen: true, globalCapUsd: '200',
  source: 'https://developers.openai.com/api/docs/guides/decisions',
});
const body = { model: 'gpt-6-luna', input: 'Fragment A: Water freezes at zero degrees Celsius at standard pressure. Fragment B: Mars has two moons.', questions: [
  { type: 'choice', name: 'where', instructions: 'Which fragment answers the question: At what temperature does water freeze?', choices: [{ value: 'A', description: 'Fragment A' }, { value: 'B', description: 'Fragment B' }] },
  { type: 'predicate', name: 'exists', instructions: 'Does a supplied fragment answer the question: At what temperature does water freeze?' },
] };
try {
  const reply = await paidJson({ ledger, logicalKey: `${runId}:${hashObject(body)}`, runId,
    documentId: 'synthetic-access-check', method: 'decisions', operation: 'access-probe', model: 'gpt-6-luna',
    price: { input: '0.10', output: '0', cachedInput: '0', cacheWrite: '0', inputTokenLimit: 12000, date: '2026-10-07', source: 'https://developers.openai.com/api/docs/guides/decisions#pricing-and-availability' },
    reservedUsd: '0.0012', url: 'https://api.openai.com/v1/decisions', apiKey: process.env.OPENAI_API_KEY ?? '',
    body, provider: 'openai-generation', timeoutMs: 60000, allowPaid: process.argv.includes('--allow-paid'),
    budgetScope: { runPrefix: 'decisions-extension-20261007-v1:', maxBudgetUsd: '100' },
  });
  const a = ledger.attempts().find(a => a.id === reply.attemptId)!;
  const record = { recordedAt: new Date().toISOString(), endpoint: '/v1/decisions', status: reply.status, payloadHash: hashObject(body),
    answerTypes: Array.isArray(reply.data.answers) ? reply.data.answers.map((x: any) => ({ name: x.name, type: x.type, choice: x.choice, probability: x.probability, probabilities: x.probabilities })) : null,
    error: reply.data.error ?? null, reportedModel: a.reportedModel, usage: a.usage, knownUsd: a.costUsd,
    reservedUsd: a.costUsd === null ? a.reservedUsd : '0', attemptId: a.id, globalBudget: ledger.totals() };
  writeFileSync(resultPath, JSON.stringify(record, null, 2)+'\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(record));
} finally { ledger.close(); }
