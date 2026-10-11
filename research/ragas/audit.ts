/** Offline reconciliation only: opens a consistent budget backup read-only. */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Decimal } from 'decimal.js';
import { hashObject, sha256 } from '../util.js';
import type { PaidAttempt } from '../ledger.js';
import { bindOperationalContinuation } from './operational-audit.js';

type Json = Record<string, any>; // Archived, versioned JSON is validated at its point of use.
export interface AuditIssue { code: string; severity: 'error' | 'incomplete' | 'warning'; phase?: string; reference?: string; }
export interface AuditTotals { attempts: number; knownUsd: string; reservedUsd: string; committedUsd: string; pendingAttempts: number; unknownAttempts: number; missingCostAttempts: number; }
const token = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const equal = (a: unknown, b: unknown) => a === undefined || b === undefined ? a === b : hashObject(a) === hashObject(b);

/** A post-judge ledger can exceed readFileSync's 2 GiB ceiling. Hash exact bytes
 * in bounded chunks; this changes neither source files nor audit semantics. */
export function auditFileSha256(path: string): string {
  const fd = openSync(path, 'r'), hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (let bytes; (bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, bytes));
    return hash.digest('hex');
  } finally { closeSync(fd); }
}

/** Uses the historical tariff and raw usage, never the current bridge constants. */
export function recomputeJudgeCost(a: PaidAttempt): string | null {
  const u = a.usage, p = a.price;
  if (!u || !p || a.reportedModel !== a.model) return null;
  const details = u.input_tokens_details as Json | undefined;
  const input = u.input_tokens, output = u.output_tokens;
  const read = details?.cached_tokens ?? (p.cacheWrite === undefined ? 0 : undefined);
  const write = details?.cache_write_tokens ?? (p.cacheWrite === undefined ? 0 : undefined);
  if (!token(input) || !token(output) || !token(read) || !token(write) || read + write > input || (write > 0 && p.cacheWrite === undefined) || (p.inputTokenLimit !== undefined && input > p.inputTokenLimit)) return null;
  try {
    if ([p.input, p.output, p.cachedInput ?? p.input, p.cacheWrite ?? '0'].some(rate => !new Decimal(rate).isFinite() || new Decimal(rate).lt(0))) return null;
    return new Decimal(input - read - write).mul(p.input).add(new Decimal(read).mul(p.cachedInput ?? p.input)).add(new Decimal(write).mul(p.cacheWrite ?? '0')).add(new Decimal(output).mul(p.output)).div(1e6).toFixed();
  } catch { return null; }
}

function totals(attempts: PaidAttempt[]): AuditTotals {
  let known = new Decimal(0), reserved = new Decimal(0);
  for (const a of attempts) { if (a.costUsd === null) reserved = reserved.add(a.reservedUsd); else known = known.add(a.costUsd); }
  return { attempts: attempts.length, knownUsd: known.toFixed(), reservedUsd: reserved.toFixed(), committedUsd: known.add(reserved).toFixed(), pendingAttempts: attempts.filter(a => a.status === 'pending').length, unknownAttempts: attempts.filter(a => a.status === 'unknown').length, missingCostAttempts: attempts.filter(a => a.costUsd === null).length };
}

export function auditRagas(options: { ledgerPath: string; phaseDirectories: string[]; operationalContinuationPath?: string }) {
  const issues: AuditIssue[] = [], phases: Json[] = [], selectedAttempts = new Map<string, PaidAttempt>(), seenRuns = new Set<string>(), usedAttempts = new Map<string, string>();
  const ledgerSha256 = auditFileSha256(resolve(options.ledgerPath));
  let operationalContinuation: ReturnType<typeof bindOperationalContinuation> | undefined;
  const issue = (code: string, severity: AuditIssue['severity'], phase?: string, reference?: string) => issues.push({ code, severity, ...(phase ? { phase } : {}), ...(reference ? { reference } : {}) });
  const json = (path: string, phase: string): Json | undefined => {
    if (!existsSync(path)) { issue('artifact_missing', 'incomplete', phase, path); return; }
    try { return JSON.parse(readFileSync(path, 'utf8')); } catch { issue('invalid_json', 'error', phase, path); return; }
  };
  const jsonl = (path: string, phase: string): Json[] => {
    if (!existsSync(path)) { issue('artifact_missing', 'incomplete', phase, path); return []; }
    try { return readFileSync(path, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line)); } catch { issue('invalid_jsonl', 'error', phase, path); return []; }
  };
  const check = (condition: boolean, code: string, phase: string, reference?: string) => { if (!condition) issue(code, 'error', phase, reference); };
  const checkFileHash = (path: string, expected: unknown, phase: string) => {
    if (expected === undefined) return;
    if (!existsSync(path)) issue('hash_source_missing', 'incomplete', phase, path);
    else check(typeof expected === 'string' && sha256(readFileSync(path)) === expected, 'file_hash_mismatch', phase, path);
  };
  const db = new DatabaseSync(resolve(options.ledgerPath), { readOnly: true });
  try {
    // These pragmas do not mutate the backup or create schema, WAL, or checkpoints.
    db.exec('PRAGMA query_only=ON');
    const integrity = db.prepare('PRAGMA integrity_check').get() as Json;
    if (integrity.integrity_check !== 'ok') issue('sqlite_integrity', 'error');
    const rows = db.prepare('SELECT id,logical_key,value FROM attempts ORDER BY rowid').all() as Array<{ id: string; logical_key: string; value: string }>;
    const attempts = rows.map(row => {
      const a = JSON.parse(row.value) as PaidAttempt;
      if (row.id !== a.id || row.logical_key !== a.logicalKey) issue('ledger_attempt_identity', 'error', undefined, row.id);
      if (a.costUsd === null ? !['pending', 'unknown'].includes(a.status) : !['completed', 'failed'].includes(a.status)) issue('ledger_cost_status', 'error', undefined, row.id);
      for (const value of [a.reservedUsd, ...(a.costUsd === null ? [] : [a.costUsd])]) if (!new Decimal(value).isFinite() || new Decimal(value).lt(0)) throw new Error('Invalid monetary amount in ledger.');
      return a;
    });
    const byId = new Map(attempts.map(a => [a.id, a]));
    if (byId.size !== attempts.length) issue('duplicate_ledger_attempt', 'error');
    const frozen = (key: string, phase: string, required = true): Json | undefined => {
      const row = db.prepare('SELECT hash,value FROM immutable WHERE key=?').get(key) as { hash: string; value: string } | undefined;
      if (!row) { if (required) issue('immutable_missing', 'incomplete', phase, key); return; }
      try { const value = JSON.parse(row.value); check(hashObject(value) === row.hash, 'immutable_hash_mismatch', phase, key); return value; }
      catch { issue('immutable_invalid', 'error', phase, key); return; }
    };
    for (const original of options.phaseDirectories) {
      const directory = resolve(original), config = json(join(directory, 'bridge/bridge-config.json'), directory);
      if (!config || typeof config.runId !== 'string') continue;
      const runId = config.runId, prefix = `${runId}:`, phaseIssues = issues.length;
      if (seenRuns.has(runId)) { issue('duplicate_phase', 'error', runId); continue; } seenRuns.add(runId);
      check(equal(config, frozen(`ragas:${runId}:config`, runId)), 'config_ledger_mismatch', runId);
      check(config.kind === 'ragas-judge' && config.retries === 0 && config.model === 'gpt-6.1-sol', 'unexpected_judge_config', runId);
      checkFileHash(join(directory, 'source-snapshot/ragas/bridge.ts'), config.bridgeSourceHash, runId);
      checkFileHash(join(directory, 'source-snapshot/ledger.ts'), config.ledgerSourceHash, runId);
      checkFileHash(join(directory, 'all-inputs.jsonl'), config.inputHash, runId);
      const scope = frozen(`budget-scope:${prefix}`, runId, false);
      if (scope) check(scope.runPrefix === prefix && scope.maxBudgetUsd === config.maxEvalUsd, 'budget_scope_mismatch', runId);
      const paid = attempts.filter(a => a.runId.startsWith(prefix));
      if (paid.length && !scope) issue('budget_scope_missing', 'incomplete', runId);
      const phaseTotals = totals(paid);
      for (const a of paid) {
        selectedAttempts.set(a.id, a);
        check(a.method === 'ragas-judge' && a.model === config.model && equal(a.price, config.price), 'attempt_config_mismatch', runId, a.id);
        check(recomputeJudgeCost(a) === a.costUsd, 'cost_mismatch', runId, a.id);
        if (a.status === 'pending' || a.status === 'unknown') issue(a.status === 'pending' ? 'attempt_pending' : 'usage_unknown', 'incomplete', runId, a.id);
        const details = a.usage?.input_tokens_details as Json | undefined;
        if (a.usage) for (const [field, raw] of [['inputTokens', a.usage.input_tokens], ['outputTokens', a.usage.output_tokens], ['cachedTokens', details?.cached_tokens], ['cacheWriteTokens', details?.cache_write_tokens]] as const) {
          if (token(raw)) check(a[field] === raw, 'usage_fields_mismatch', runId, a.id);
        }
      }
      const records = new Map<string, Json>(), requestDir = join(directory, 'bridge/requests'), attemptAudits: Json[] = [];
      if (!existsSync(requestDir)) issue('requests_missing', 'incomplete', runId);
      else for (const filename of readdirSync(requestDir).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
        const key = filename.slice(0, -5), record = json(join(requestDir, filename), runId), logicalKey = `${prefix}judge:${key}`;
        if (!record) continue;
        const req = record.request, body = record.providerBody;
        if (!req || !body || typeof req.requestId !== 'string') { issue('invalid_request_record', 'error', runId, key); continue; }
        records.set(req.requestId, record);
        check(sha256(req.requestId) === key, 'request_filename_mismatch', runId, key);
        check(record.requestHash === hashObject(req) && record.payloadHash === hashObject(body) && record.promptHash === hashObject(req.messages) && record.schemaHash === hashObject(req.schema), 'request_hash_mismatch', runId, key);
        check(equal(record, frozen(`${logicalKey}:input`, runId)), 'request_ledger_mismatch', runId, key);
        const expected = { model: config.model, store: config.store, service_tier: config.serviceTier, reasoning: config.reasoning, max_output_tokens: config.maxOutputTokens, prompt_cache_options: { mode: config.cachePolicy }, input: req.messages, text: { format: { type: 'json_schema', name: req.schemaName, strict: true, schema: req.schema } } };
        check(equal(body, expected), 'provider_config_mismatch', runId, key);
        const requestAttempts = paid.filter(a => a.logicalKey === logicalKey);
        check(requestAttempts.length <= 1, 'request_paid_more_than_once', runId, key);
        for (const a of requestAttempts) {
          check(a.payloadHash === hashObject(body), 'attempt_payload_hash_mismatch', runId, a.id);
          check(a.documentId === req.sampleId && a.operation === `ragas_${req.metric}` && a.runId === `${prefix}${key}`, 'request_attempt_identity', runId, a.id);
          attemptAudits.push({ attemptId: a.id, requestId: req.requestId, sampleId: req.sampleId, metric: req.metric, status: a.status, requestHash: record.requestHash, payloadHash: a.payloadHash, price: a.price, usage: a.usage ?? null, requestedModel: a.model, reportedModel: a.reportedModel ?? null, responseId: a.responseId ?? null, recordedCostUsd: a.costUsd, recomputedCostUsd: recomputeJudgeCost(a), reservedUsd: a.reservedUsd });
        }
        if (!requestAttempts.length) continue; // A refused, unpaid request can legitimately have a frozen input.
        const a = requestAttempts[0], response = json(join(requestDir, `${key}.response.json`), runId);
        if (!response) continue;
        check(response.attemptId === a.id && equal(response.attempt, a), 'response_attempt_mismatch', runId, key);
        const result = frozen(`${logicalKey}:result`, runId);
        const compact = response.ok ? { ok: true, text: response.text, attemptId: response.attemptId, model: response.model } : { ok: false, error: response.error, attemptId: response.attemptId };
        check(equal(result, compact), 'response_ledger_mismatch', runId, key);
        const data = response.providerResponse;
        if (data) {
          check(equal(data.usage ?? {}, a.usage) && data.model === a.reportedModel && data.id === a.responseId && data.status === a.responseStatus, 'provider_usage_mismatch', runId, a.id);
          if (response.ok) {
            const output = (data.output ?? []).flatMap((entry: Json) => entry.content ?? []).filter((entry: Json) => entry.type === 'output_text' && typeof entry.text === 'string').map((entry: Json) => entry.text).join('');
            check(response.text === output && response.model === data.model && data.status === 'completed', 'provider_output_mismatch', runId, a.id);
          }
          const recoveryRow = db.prepare('SELECT value FROM responses WHERE key=?').get(logicalKey) as { value: string } | undefined;
          if (recoveryRow) {
            const recovery = JSON.parse(recoveryRow.value);
            check(recovery.attemptId === a.id && recovery.payloadHash === record.payloadHash && equal(recovery.data, data), 'provider_recovery_mismatch', runId, a.id);
          } else if (response.ok) issue('provider_recovery_missing', 'incomplete', runId, a.id);
        } else if (a.costUsd !== null) issue('raw_provider_response_missing', 'incomplete', runId, a.id);
      }
      for (const a of paid) if (![...records.values()].some(r => `${prefix}judge:${sha256(r.request.requestId)}` === a.logicalKey)) issue('paid_request_missing', 'incomplete', runId, a.id);
      const allInputs = jsonl(join(directory, 'all-inputs.jsonl'), runId), allById = new Map(allInputs.map(s => [s.id, s]));
      check(allById.size === allInputs.length, 'duplicate_input_sample', runId);
      const exportPath = join(directory, 'export-manifest.json');
      if (existsSync(exportPath)) {
        const manifest = json(exportPath, runId), samples = jsonl(join(directory, 'samples.jsonl'), runId);
        if (manifest) check(manifest.samplesHash === hashObject(samples) && manifest.sampleCount === samples.length && manifest.requestedMetrics === samples.reduce((n, sample) => n + (sample.metrics?.length ?? 0), 0), 'export_input_mismatch', runId);
      }
      const inputManifestPath = join(directory, 'input-manifest.json');
      if (existsSync(inputManifestPath)) {
        const manifest = json(inputManifestPath, runId);
        if (manifest) {
          checkFileHash(join(directory, 'samples.jsonl'), manifest.researchSha256, runId);
          checkFileHash(join(directory, 'controls.jsonl'), manifest.controlsSha256, runId);
          checkFileHash(join(directory, 'source-snapshot/ragas/accuracy.py'), manifest.exporterSha256, runId);
          if (manifest.sourceSha256 && !options.phaseDirectories.some(other => {
            const path = join(resolve(other), 'samples.jsonl');
            return existsSync(path) && sha256(readFileSync(path)) === manifest.sourceSha256;
          })) issue('upstream_input_hash_unresolved', 'incomplete', runId);
        }
      }
      const statusCounts = { completed: 0, error: 0, unscorable: 0 }, terminal = new Set<string>(), expected = new Set<string>();
      for (const s of allInputs) for (const metric of s.metrics ?? []) expected.add(JSON.stringify([s.id, metric]));
      const resultFiles = readdirSync(directory).filter(name => /^(controls|study)\.results\.jsonl$/.test(name));
      if (!resultFiles.length) issue('terminal_results_missing', 'incomplete', runId);
      for (const file of resultFiles) {
        const path = join(directory, file), manifest = json(`${path}.manifest.json`, runId);
        if (manifest) {
          check(manifest.runId === runId && manifest.judgeModel === config.model && manifest.retries === 0, 'runtime_config_mismatch', runId, file);
          checkFileHash(join(directory, 'source-snapshot/ragas/runtime.py'), manifest.runtimeSha256, runId);
          checkFileHash(join(directory, file.startsWith('controls') ? 'controls.jsonl' : 'samples.jsonl'), manifest.inputSha256, runId);
        }
        const runtimeInputs = jsonl(join(directory, file.startsWith('controls') ? 'controls.jsonl' : 'samples.jsonl'), runId);
        const runtimeById = new Map(runtimeInputs.map(sample => [sample.id, sample]));
        check(runtimeById.size === runtimeInputs.length, 'duplicate_runtime_input', runId, file);
        for (const sample of runtimeInputs) check(equal(allById.get(sample.id), sample), 'runtime_all_input_mismatch', runId, sample.id);
        for (const row of jsonl(path, runId)) {
          const owner = JSON.stringify([runId, row.sampleId, row.metric]), metricKey = JSON.stringify([row.sampleId, row.metric]);
          check(!terminal.has(metricKey), 'duplicate_terminal_metric', runId, metricKey); terminal.add(metricKey);
          check(expected.has(metricKey), 'unexpected_terminal_metric', runId, metricKey);
          const sample = runtimeById.get(row.sampleId);
          check(sample?.metrics?.includes(row.metric) === true && equal(row.metadata, sample.metadata ?? {}), 'result_input_metadata_mismatch', runId, metricKey);
          if (['completed', 'error', 'unscorable'].includes(row.status)) statusCounts[row.status as keyof typeof statusCounts]++;
          else issue('invalid_metric_status', 'error', runId, metricKey);
          check(row.status === 'completed' ? typeof row.score === 'number' && Number.isFinite(row.score) && row.score >= 0 && row.score <= 1 : row.score === null, 'invalid_metric_score', runId, metricKey);
          const calls = Array.isArray(row.calls) ? row.calls : [];
          const ids = calls.filter((call: Json) => typeof call.attemptId === 'string').map((call: Json) => call.attemptId);
          check(equal([...new Set(ids)], row.attemptIds), 'metric_attempt_list_mismatch', runId, metricKey);
          calls.forEach((call: Json, index: number) => {
            const expectedRequestId = `ragas:${sha256(JSON.stringify([runId, row.sampleId, row.metric, index + 1]))}`;
            check(call.requestId === expectedRequestId, 'runtime_request_id_mismatch', runId, metricKey);
            const record = records.get(call.requestId);
            if (!record) { issue('call_request_missing', 'incomplete', runId, call.requestId); return; }
            check(record.request.sampleId === row.sampleId && record.request.metric === row.metric && record.request.schemaName === call.schemaName, 'metric_request_mismatch', runId, call.requestId);
            if (!call.attemptId) return; // Authentication/budget refusals are unpaid.
            const a = byId.get(call.attemptId);
            if (!a) { issue('call_attempt_missing', 'error', runId, call.attemptId); return; }
            if (usedAttempts.has(a.id)) issue('attempt_reused_by_terminal_calls', 'error', runId, a.id);
            usedAttempts.set(a.id, owner);
            check(a.runId.startsWith(prefix) && a.logicalKey === `${prefix}judge:${sha256(call.requestId)}` && a.documentId === row.sampleId && a.operation === `ragas_${row.metric}`, 'call_attempt_identity', runId, a.id);
            if (call.status === 'completed') {
              const settled = frozen(`${a.logicalKey}:result`, runId);
              check(settled?.ok === true && settled.text === call.rawText && settled.model === call.model, 'call_response_mismatch', runId, a.id);
            }
          });
        }
      }
      for (const key of expected) if (!terminal.has(key)) issue('metric_pending', 'incomplete', runId, key);
      for (const a of paid) if (!usedAttempts.has(a.id)) issue('paid_attempt_not_in_terminal_results', 'incomplete', runId, a.id);
      const continuationPresent = existsSync(join(directory, 'bridge/cohort.json')) || existsSync(join(directory, 'bridge/continuation.json')) || existsSync(join(directory, 'bridge/continuation2.json'));
      let currentBudgetVerified = false;
      if (continuationPresent || (options.operationalContinuationPath && runId === 'ragas-books-test-20261004-v1')) {
        if (!options.operationalContinuationPath) issue('operational_continuation_required', 'error', runId);
        else try {
          operationalContinuation = bindOperationalContinuation({ receiptPath: options.operationalContinuationPath,
            directory, config, db, ledgerSha256, phaseTotals, globalTotals: totals(attempts),
            expectedMetrics: expected.size, terminalMetrics: terminal.size, statusCounts });
          currentBudgetVerified = true;
        } catch { issue('operational_continuation_invalid', 'error', runId); }
      }
      // The old budget remains a preserved historical artifact. Only a fully
      // bound continuation receipt permits using the separately recorded current snapshot.
      const budgetPath = join(directory, 'bridge/budget.json');
      if (!currentBudgetVerified && existsSync(budgetPath)) {
        const budget = json(budgetPath, runId), t = phaseTotals;
        if (budget) check(budget.runId === runId && budget.maxEvalUsd === config.maxEvalUsd && equal(budget.evaluation, { knownUsd: t.knownUsd, reservedUsd: t.reservedUsd, committedUsd: t.committedUsd, unknownAttempts: t.missingCostAttempts }), 'evaluation_budget_snapshot_mismatch', runId);
        // budget.global is historical: later phases legitimately change the shared ledger.
      }
      phases.push({ runId, directory, configHash: hashObject(config), inputHash: config.inputHash ?? null, totals: phaseTotals, requestRecords: records.size, samples: allInputs.length, expectedMetrics: expected.size, terminalMetrics: terminal.size, statusCounts, accountedAttempts: paid.filter(a => usedAttempts.has(a.id)).length, attemptAudits, issueCount: issues.length - phaseIssues });
    }
    if (options.operationalContinuationPath && !operationalContinuation) issue('operational_continuation_not_bound', 'error');
    const judge = totals([...selectedAttempts.values()]), global = totals(attempts);
    return { schemaVersion: 1, kind: 'ragas-readonly-cost-provenance-audit', createdAt: new Date().toISOString(), ledgerSha256, ok: !issues.some(i => i.severity === 'error'), complete: !issues.some(i => i.severity !== 'warning'), global, judge, phases, issues, ...(operationalContinuation ? { operationalContinuation } : {}), interpretation: 'Judge totals include each selected phase attempt once. Global totals are the single shared ledger, not the sum of phase snapshots. Unknown/pending reservations are commitments, not confirmed charges. Error/unscorable metric outcomes remain legitimate terminal outcomes; audit validity is separate from scientific validity.' };
  } finally { db.close(); }
}

function main() {
  const { values } = parseArgs({ options: { ledger: { type: 'string' }, phase: { type: 'string', multiple: true }, out: { type: 'string' }, 'operational-continuation': { type: 'string' } } });
  if (!values.ledger || !values.phase?.length || !values.out) throw new Error('Required: --ledger BACKUP --phase DIR [--phase DIR] --out AUDIT.json');
  const phaseDirectories = values.phase.flatMap(value => value.split(',')).filter(Boolean);
  if (resolve(values.out) === resolve(values.ledger)) throw new Error('Audit output must not overwrite the ledger.');
  if (values['operational-continuation'] && resolve(values.out) === resolve(values['operational-continuation'])) throw new Error('Audit output must not overwrite the continuation receipt.');
  const report = auditRagas({ ledgerPath: values.ledger, phaseDirectories, ...(values['operational-continuation'] ? { operationalContinuationPath: values['operational-continuation'] } : {}) });
  mkdirSync(dirname(resolve(values.out)), { recursive: true, mode: 0o700 });
  writeFileSync(resolve(values.out), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify({ ok: report.ok, complete: report.complete, judge: report.judge, global: report.global, phases: report.phases.map(p => ({ runId: p.runId, metrics: p.terminalMetrics, statusCounts: p.statusCounts, knownUsd: p.totals.knownUsd })), issues: report.issues.length, output: resolve(values.out) }) + '\n');
  if (!report.ok || !report.complete) process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch { process.stderr.write('Audit could not read or validate the supplied backup/artifacts; no provider calls were made.\n'); process.exitCode = 1; }
}
