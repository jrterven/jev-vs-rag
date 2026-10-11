# RAGAS answer evaluation

This integration evaluates generated answers using official RAGAS **0.4.3** metrics and a local Node provider bridge. The held-out study uses **Faithfulness** and **Answer Accuracy** with `gpt-6.1-sol`, medium reasoning, Standard processing, and an 8,192-token output limit including reasoning. The answer generator is `gpt-4.1-mini-2025-04-14`.

## Scoring rules

| Outcome | Treatment |
| --- | --- |
| Supported non-abstaining answer with supplied context | Faithfulness is applicable |
| Empty answer, explicit abstention, or no-evidence control | Faithfulness is not applicable |
| Answerable question with a positive reference | Answer Accuracy is applicable, including abstentions |
| Unanswerable question | Answer Accuracy is not applicable; abstention is reported separately |
| Provider error or invalid metric response | Terminal error with no imputed score |
| Non-finite RAGAS score | Unscorable, separate from an error |

Faithfulness requires an NLI verdict for every extracted statement, in the original order. Answer Accuracy requires both official rubric judgments and averages their normalized scores; the single-judgment fallback is rejected. There are no automatic provider or JSON-repair retries. Completed, failed, missing, unscorable, and not-applicable records remain distinct.

## Environment

```sh
python3 -m venv research/.venv-ragas
research/.venv-ragas/bin/python -m pip install -r research/ragas/requirements.txt
research/.venv-ragas/bin/python -m pip check
research/.venv-ragas/bin/python -m unittest discover -s research/ragas -p 'test_*.py'
```

The evaluator environment is separate from local retrieval inference. [RUNTIME.md](RUNTIME.md) describes the bridge, input schema, and checkpoint rules. [CALIBRATION.md](CALIBRATION.md) documents synthetic controls and optional blinded human comparison.

## Export from measured runs

A consistent ledger snapshot and the frozen experiment directory are required:

```sh
node --import tsx research/ragas/study-export.ts \
  --ledger /path/consistent-ledger.sqlite \
  --out data/research/judge-inputs --scope test \
  --experiment original=/path/original-experiment
```

Exports verify questions, generated answers, selected contexts, attempt identities, and source hashes. Provider prompts retain the official RAGAS metric definitions. Method identities are audit metadata and are not sent in the judge prompts.

The Node bridge keeps provider credentials in its process and accounts for every paid attempt in the shared ledger. Python receives only a private loopback bridge token. The recorded original and extension bridges have separate run identities and explicit cumulative budget checks.

## Offline analysis

```sh
python3 research/ragas/study-analysis.py \
  --samples /path/samples.jsonl \
  --results /path/study.results.jsonl \
  --export-manifest /path/export-manifest.json \
  --runtime-manifest /path/study.results.jsonl.manifest.json \
  --runtime-source research/ragas/runtime.py \
  --scope test --out output/answer-analysis.json
```

Analysis uses document-level means and paired comparisons on jointly eligible, successfully scored questions. Bootstrap intervals use documents as clusters. Different eligible populations and measurement dates remain explicit. The [distributed results](../../results/README.md) include the aggregate answer outcomes and cost summaries, not raw answers or judge prompts.
