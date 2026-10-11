# OpenAI Decisions retrieval

This adapter adds `hybrid-decisions` and `decisions-scan` to the original Jev/RAG experiment. The recorded Decisions beta uses `gpt-6-luna` for ranking; downstream answers use the same `gpt-4.1-mini-2025-04-14` generator as the other methods.

## Retrieval protocol

- Common 500-token passages with 75-token overlap and up to five results.
- Hybrid ranking receives the same ordered 50 candidates as the original hybrid methods.
- Full scanning visits the complete document in preventive 12,000-token requests.
- Each window retains ten candidates, followed by hierarchical reduction.
- Choice and Predicate include an explicit none fallback. Fallback probabilities are not merged or renormalized across requests.
- Terminal failures and unresolved usage remain recorded; measured requests have no automatic transient retries.

The 476-question test cohort contains 1,352 scheduled searches including timing repetitions and 400 generation assignments. Results include 13 failed searches, 392 generated answers, 674 scored RAGAS metrics, and two retained metric errors. [Numerical artifacts](../../results/decisions/README.md) retain these outcome categories.

The extension was measured on a different date from the original study. Shared-GPU continuation timings are separated from the original execution block, and the beta model is an alias rather than a separately verified immutable set of weights.

## Implementation

| File | Purpose |
| --- | --- |
| `adapter-v2.ts` | Native request construction, complete-text packing, and result interpretation |
| `run-v2.ts` | Retrieval and fixed-generator experiment runner |
| `generation.ts` | Original generator prompt and structured answer contract |
| `shared-gpu-policy.ts` | Explicit timing conditions for the continuation |
| `analyze.ts` | Canonical evidence metrics, latency, retention, and cost analysis |
| `analyze-judge.py` | Paired answer comparison with the original cohort |
| `audit-judge.ts` | Score, provenance, and usage verification |

The v1 adapter and tests retain the earlier development implementation. The reported test results use v2. The historical runners require the recorded datasets, source manifests, and shared cost ledger; the distributed aggregates do not contain those raw inputs.

## Offline analysis

```sh
node --import tsx research/decisions/analyze.ts \
  --directory /path/decisions-run \
  --ledger /path/consistent-ledger.sqlite \
  --baseline /path/original-report.json \
  --out output/decisions-analysis.json

python3 research/decisions/analyze-judge.py \
  --original /path/original-judge \
  --extension /path/decisions-judge \
  --out output/decisions-answer-analysis.json
```

These analyzers check the frozen experiment identities and hashes. New experiments require separately versioned inputs and configurations. They do not make paid calls.

```sh
npm run check:research
node --import tsx --test research/decisions/*.test.ts
```

Some adapter tests require the private original manifest. Synthetic tests validate request handling and accounting, not retrieval effectiveness.
