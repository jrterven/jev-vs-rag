# RAGAS runtime

The Python runtime calls `ragas.metrics.collections` from official RAGAS 0.4.3. The study uses Faithfulness and Answer Accuracy; Factual Correctness is retained as a development diagnostic. Metric prompts and scoring formulas are provided by RAGAS rather than reimplemented by the adapter.

## Provider bridge

`InstructorBaseRagasLLM.agenerate` sends the generated prompt and structured-output schema to a local Node bridge. Python has no provider API key and does not call OpenAI directly. The bridge selects the configured judge, records usage and prices, and enforces the shared budget.

After configuring and starting the bridge:

```sh
research/.venv-ragas/bin/python research/ragas/runtime.py \
  --input data/research/judge-inputs/samples.jsonl \
  --output data/research/judge-results/results.jsonl \
  --bridge-info data/research/judge-bridge/bridge-info.json \
  --run-id JUDGE_RUN_ID --concurrency 2
```

`bridge-info.json` contains a loopback-only URL, a private token-file path, the model identifier, and the run ID. The token is read from a permission-restricted file rather than passed on the command line.

## Input and output

Each input line includes a unique `id`, `question`, `response`, a `contexts` array, an optional `reference`, requested `metrics`, and optional audit `metadata`.

Each output row represents one terminal `(sampleId, metric)` pair. It records the status, score, attempt IDs, structured judge responses, timing, and metadata. `completed` requires a finite score in [0, 1]. `error` and `unscorable` do not receive a replacement numerical score.

Supporting files record the input hash, runtime source hash, package versions, request/response events, and a single-writer lock. Raw prompts and provider records are private study artifacts.

## Strict metric validation

Structured Outputs schemas require explicit required fields and `additionalProperties: false`. Faithfulness NLI verdicts must be binary and preserve the entire statement list without omission, duplication, reordering, or rewriting.

Answer Accuracy performs two rubric judgments using the question and unchanged reference. Both ratings must be integer 0, 2, or 4. The runtime rejects RAGAS's single-valid-judgment fallback and disables metric-level retries.

An identical resumed execution keeps every terminal record, including errors, without reevaluation. Subcalls use deterministic identities so persisted successful responses can be reused. Changed inputs, code, dependencies, or settings invalidate resume. Locks are removed only after the previous writer has stopped; malformed partial output requires explicit repair.

## Metric definitions

- [Faithfulness](https://docs.ragas.io/en/v0.4.3/concepts/metrics/available_metrics/faithfulness/)
- [Answer Accuracy](https://docs.ragas.io/en/v0.4.3/concepts/metrics/available_metrics/nvidia_metrics/)
- [Factual Correctness](https://docs.ragas.io/en/v0.4.3/concepts/metrics/available_metrics/factual_correctness/)

Question-conditioned reference agreement, context support, citation validity, and human correctness judgments remain separate measurements. Synthetic controls test the implementation and judge behavior; they do not establish human agreement.
