/** Offline Decisions judge audit. Reuses the original cost/provenance auditor. */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Decimal } from 'decimal.js';
import { auditRagas, auditFileSha256 } from '../ragas/audit.js';
import { hashObject, readJson, writeJson } from '../util.js';
import type { PaidAttempt } from '../ledger.js';

type Json = Record<string, any>;
const RUN = 'decisions-ragas-20261007-v1';
const EXTENSION = 'decisions-extension-20261007-v1:';
const need = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
const lines = (path: string): Json[] => readFileSync(path, 'utf8').split('\n').filter(s => s.trim()).map(s => JSON.parse(s));

/** Recompute scores from the actual provider text, never a precomputed score. */
export function verifyCompletedScore(row: Json): number | null {
  if (row.status !== 'completed') { need(row.score === null, 'Non-completed metric has a score'); return null; }
  need(['faithfulness', 'answer_accuracy'].includes(row.metric), 'Unexpected extension metric');
  const calls: Json[] = row.calls;
  need(Array.isArray(calls) && calls.length === 2, 'Completed metric requires both official calls');
  const responses = calls.map(call => {
    need(call.status === 'completed' && call.model === 'gpt-6.1-sol' && typeof call.attemptId === 'string', 'Unconfirmed completed judge call');
    const raw = JSON.parse(call.rawText);
    need(hashObject(raw) === hashObject(call.response), 'Parsed response differs from actual provider text');
    return raw;
  });
  let score: number;
  if (row.metric === 'answer_accuracy') {
    need(calls.every(call => call.schemaName === 'AnswerAccuracyOutput'), 'Answer Accuracy schema differs');
    need(responses.every(value => [0, 2, 4].includes(value.rating)), 'Invalid official judge rating');
    score = (responses[0].rating + responses[1].rating) / 8;
  } else {
    need(calls[0].schemaName === 'StatementGeneratorOutput' && calls[1].schemaName === 'NLIStatementOutput', 'Faithfulness schema differs');
    const statements = responses[0].statements, verdicts = responses[1].statements;
    need(Array.isArray(statements) && statements.length > 0 && statements.every(s => typeof s === 'string'), 'Completed Faithfulness requires statements');
    need(Array.isArray(verdicts) && verdicts.length === statements.length
      && verdicts.every((v, i) => v.statement === statements[i] && [0, 1].includes(v.verdict)), 'Faithfulness statements/verdicts differ');
    score = verdicts.reduce((total: number, value: Json) => total + value.verdict, 0) / verdicts.length;
  }
  need(typeof row.score === 'number' && Number.isFinite(row.score) && Math.abs(row.score - score) < 1e-12, 'Official score recomputation differs');
  return score;
}

export function auditExtensionJudge(options: { directory: string; ledger: string; retrievalBackup: string }) {
  const directory = resolve(options.directory), ledger = resolve(options.ledger), retrieval = resolve(options.retrievalBackup);
  need(ledger !== retrieval && !ledger.endsWith('/study-budget.sqlite'), 'Supply a separate final consistent backup');
  const freeze = readJson<Json>(join(directory, 'extension-judge-freeze.json'));
  need(freeze.runId === RUN && freeze.budgetUsd === '20' && freeze.cumulativeJudgeCapUsd === '80'
    && freeze.extensionCombinedCapUsd === '100' && freeze.globalCapUsd === '200', 'Frozen judge policy differs');
  need(auditFileSha256(retrieval) === freeze.retrievalBackupSha256, 'Retrieval backup changed');
  for (const [name, sha] of Object.entries(freeze.files)) {
    need(auditFileSha256(resolve(name)) === sha, 'Frozen judge source changed: ' + name);
    need(auditFileSha256(join(directory, 'source-snapshot', name.replace(/^research\//, ''))) === sha, 'Archived judge source changed: ' + name);
  }
  const completed = readJson<Json>(join(directory, 'completion.json'));
  need(completed.allMetricsTerminal === true && completed.expected === completed.terminal, 'Judge not terminal');
  need(!existsSync(join(directory, 'study.results.jsonl.lock')) && !existsSync(join(directory, 'bridge/bridge.lock')), 'Judge process lock remains');
  const base = auditRagas({ ledgerPath: ledger, phaseDirectories: [directory] });
  need(base.ok && base.issues.every(issue => issue.code === 'usage_unknown'), 'Original provenance auditor found unresolved issues: ' + JSON.stringify(base.issues));
  need(base.phases.length === 1 && base.phases[0].runId === RUN && base.phases[0].expectedMetrics === completed.expected
    && base.phases[0].terminalMetrics === completed.terminal, 'Completion differs from audited metric counts');
  const config = readJson<Json>(join(directory, 'bridge/bridge-config.json'));
  need(config.model === 'gpt-6.1-sol' && config.reasoning.effort === 'medium' && config.maxOutputTokens === 8192
    && config.concurrency === 2 && config.retries === 0 && config.maxEvalUsd === '20'
    && config.extensionTotalCapUsd === '100' && config.cumulativeJudgeCapUsd === '80'
    && config.maximumConsecutiveProviderFailures === 3 && config.stopOnSettledUnknownUsage === false, 'Executed judge settings differ');
  const db = new DatabaseSync(ledger, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    db.prepare('ATTACH DATABASE ? AS prior').run(retrieval);
    const historicalRows: Json = {};
    for (const [table, key] of [['attempts', 'id'], ['runs', 'id'], ['immutable', 'key'], ['responses', 'key']]) {
      const columns = (db.prepare(`PRAGMA main.table_info(${table})`).all() as Json[]).map(row => row.name);
      const oldColumns = (db.prepare(`PRAGMA prior.table_info(${table})`).all() as Json[]).map(row => row.name);
      need(hashObject(columns) === hashObject(oldColumns), 'Historical table schema changed');
      const predicate = columns.map(column => `n.${column} IS NOT o.${column}`).join(' OR ');
      const changed = db.prepare(`SELECT count(*) AS n FROM prior.${table} o LEFT JOIN main.${table} n ON n.${key}=o.${key} WHERE n.${key} IS NULL OR ${predicate}`).get() as Json;
      need(changed.n === 0, 'Historical retrieval/generation/pilot/original rows changed: ' + table);
      historicalRows[table] = { unchanged: (db.prepare(`SELECT count(*) AS n FROM prior.${table}`).get() as Json).n, changedOrMissing: 0 };
    }
    db.exec('DETACH DATABASE prior');
    const attempts = (db.prepare('SELECT value FROM attempts').all() as Array<{ value: string }>).map(row => JSON.parse(row.value) as PaidAttempt);
    need(!attempts.some(a => a.status === 'pending'), 'Unresolved provider calls remain');
    const byId = new Map(attempts.map(a => [a.id, a]));
    const rows = lines(join(directory, 'study.results.jsonl'));
    for (const row of rows) {
      verifyCompletedScore(row);
      for (const call of row.calls ?? []) if (call.status === 'completed') {
        const attempt = byId.get(call.attemptId);
        need(attempt?.status === 'completed' && attempt.costUsd !== null, 'Completed judge call lacks confirmed consumption');
      }
    }
    const sums = (selected: PaidAttempt[]) => {
      const known = selected.reduce((sum, a) => sum.add(a.costUsd ?? 0), new Decimal(0));
      const reserved = selected.reduce((sum, a) => sum.add(a.costUsd === null ? a.reservedUsd : 0), new Decimal(0));
      return { knownUsd: known.toFixed(), reservedUsd: reserved.toFixed(), committedUsd: known.add(reserved).toFixed(),
        attempts: selected.length, unknownAttempts: selected.filter(a => a.costUsd === null).length };
    };
    const costs = {
      global: sums(attempts), cumulativeJudge: sums(attempts.filter(a => a.method === 'ragas-judge')),
      extension: sums(attempts.filter(a => a.runId.startsWith(EXTENSION) || a.runId.startsWith(RUN + ':'))),
      newJudge: sums(attempts.filter(a => a.runId.startsWith(RUN + ':'))),
    };
    for (const [key, cap] of [['global', 200], ['cumulativeJudge', 80], ['extension', 100], ['newJudge', 20]] as const)
      need(new Decimal(costs[key].committedUsd).lte(cap), 'Budget exceeded including reservations: ' + key);
    return { schemaVersion: 1, kind: 'decisions-extension-final-judge-audit', ok: true, allMetricsTerminal: true,
      judgeCostsComplete: base.complete, extensionCostsComplete: costs.extension.unknownAttempts === 0,
      globalCostsComplete: costs.global.unknownAttempts === 0, costs, historicalRows, originalAuditor: base,
      scoreRecomputation: { metrics: rows.length, completed: rows.filter(row => row.status === 'completed').length,
        policy: 'Official FA verdict mean; AA average of two 0/2/4 ratings divided by four. Recomputed from archived provider text.' },
      integrity: { ledgerSha256: base.ledgerSha256, retrievalBackupSha256: freeze.retrievalBackupSha256,
        freezeSha256: auditFileSha256(join(directory, 'extension-judge-freeze.json')), sourceSha256: auditFileSha256(resolve('research/decisions/audit-judge.ts')) },
      interpretation: 'Completed cohort may retain errors and unknown consumption. Reservations are commitments, not confirmed charges. Original study and both pilots remain unchanged.' };
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { directory: { type: 'string' }, ledger: { type: 'string' }, 'retrieval-backup': { type: 'string' }, out: { type: 'string' } } });
  if (!values.directory || !values.ledger || !values['retrieval-backup'] || !values.out) throw new Error('Required --directory JUDGE --ledger FINAL_BACKUP --retrieval-backup RETRIEVAL_BACKUP --out NEW_AUDIT');
  if (existsSync(values.out)) throw new Error('Output exists; never overwrite a preserved artifact');
  const report = auditExtensionJudge({ directory: values.directory, ledger: values.ledger, retrievalBackup: values['retrieval-backup'] });
  writeJson(values.out, report, true);
  console.log(JSON.stringify({ out: values.out, ok: report.ok, costs: report.costs, scores: report.scoreRecomputation }));
}
