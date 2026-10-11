import { Decimal } from 'decimal.js';
import type { Attempt, Comparison, CostSummary, Engine, EngineCosts } from '../shared/types.js';
export function costForTokens(tokens: number, rate: string | null): string | null {
  if (rate === null || !Number.isFinite(tokens) || tokens < 0) return null;
  return new Decimal(tokens).mul(rate).div(1000000).toFixed();
}
export function summarizeCost(attempts: Attempt[]): CostSummary {
  let sum = new Decimal(0), unknownAttempts = 0, inputTokens = 0;
  for (const a of attempts) {
    inputTokens += a.inputTokens ?? 0;
    if (a.costUsd === null) unknownAttempts++; else sum = sum.add(a.costUsd);
  }
  return { knownUsd: sum.toFixed(), unknownAttempts, inputTokens, calls: attempts.length };
}
export function documentCosts(attempts: Attempt[], comparisons: Comparison[]): Record<Engine, EngineCosts> {
  const calculate = (engine: Engine): EngineCosts => {
    const own = attempts.filter(a => a.engine === engine);
    const preparation = summarizeCost(own.filter(a => !a.runId));
    const searches = summarizeCost(own.filter(a => a.runId));
    const samples = comparisons.flatMap(c => c.runs).filter(r => r.engine === engine && r.status === 'completed')
      .map(r => summarizeCost(own.filter(a => a.runId === r.id))).filter(c => c.calls > 0 && c.unknownAttempts === 0);
    const mean = samples.length ? samples.reduce((v, s) => v.add(s.knownUsd), new Decimal(0)).div(samples.length) : null;
    return { preparation, searches, total: summarizeCost(own), sampleSize: samples.length,
      projections: mean && preparation.unknownAttempts === 0 ? [100, 1000].map(queries => {
        const total = new Decimal(preparation.knownUsd).add(mean.mul(queries));
        return { queries, totalUsd: total.toFixed(), amortizedUsd: total.div(queries).toFixed() };
      }) : [] };
  };
  return { jev: calculate('jev'), rag: calculate('rag') };
}
