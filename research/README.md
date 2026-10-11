# Experiments

This directory implements the retrieval and answer-evaluation experiments. The original runner covers seven methods; the [Decisions](decisions/README.md) and [Clef](clef/README.md) adapters implement the two subsequent extensions. Distributed numerical outputs are in [results/](../results/README.md).

## Experimental design

| Setting | Value |
| --- | --- |
| Passage size / overlap | Approximately 500 / 75 tokens |
| Returned passages | 5 |
| Hybrid candidate depth | 50 |
| Reciprocal rank fusion constant | 60 |
| Decision-model window budget | 12,000 tokens |
| Candidates retained per window | 10 |
| Bootstrap | 10,000 document-level resamples, seed 42 |
| Answer generator | `gpt-4.1-mini-2025-04-14` |
| Answer context / output budget | 2,500 content tokens / 512 output tokens |
| Answer evaluator | RAGAS 0.4.3, `gpt-6.1-sol`, medium reasoning |

Exact settings are recorded in [protocol.json](config/protocol.json) and the [study amendment](config/study-amendment-20261004.json). Hosted model aliases and measurement dates are recorded separately from pinned local model revisions.

| Dataset | Development | Test |
| --- | --- | --- |
| QASPER | 60 training questions | 320 answerable and 76 unanimously unanswerable questions |
| OpenStax | 20 questions on two books | 80 questions on eight other books |

The fixed answer sample contains 100 answerable QASPER questions, 40 unanswerable QASPER questions, and 60 textbook questions. Two controls use reference evidence or no evidence. Textbook test references comprise 78 model-authored and two human-authored questions; they are not independently human-validated.

## Installation and offline execution

```sh
npm ci
npm run research -- --help
npm run research -- plan
npm run research -- mock-demo \
  --id mock-demo \
  --out data/research/mock-demo \
  --budget-file data/research/mock-budget.sqlite
npm run test:research
npm run test:research:python
```

Mock outputs are marked explicitly and do not enter the reported measurements. Reusing an identical experiment ID and directory exercises checkpoint recovery; different configurations require new directories.

## Dataset preparation

```sh
npm run research -- import-qasper --split development \
  --out data/research/qasper-development.bundle.json
npm run research -- import-qasper --split test \
  --out data/research/qasper-test.bundle.json
```

`--archive` accepts a local official QASPER archive. Import verifies the configured version and source hashes, preserves alternative evidence sets, and reports exclusions. Development and test documents are kept separate.

OpenStax acquisition and canonicalization are documented in [OPENSTAX-ACQUISITION.md](OPENSTAX-ACQUISITION.md). The [annotation protocol](ANNOTATION-PROTOCOL.md) specifies question types, evidence offsets, reference authorship, and dataset versioning. Full books and question banks are excluded from this distribution.

For an independently acquired PDF, DOCX, or TXT document:

```sh
npm run research -- import-text --input /path/book.pdf \
  --title 'Book title and edition' --project-id PROJECT_ID \
  --source-url https://example.org/book \
  --license 'Edition license' --license-url https://example.org/license \
  --split development --out data/research/acquisition/book
```

The command exports canonical document blocks and an acquisition record. It performs no model calls. Evidence annotations must refer to that immutable text. Human and model-authored book imports use distinct provenance rules through `import-books` and `import-model-books`.

## Local model environment

```sh
python3 -m venv research/.venv
research/.venv/bin/python -m pip install -r research/python/requirements.txt
```

Configure `local.python`, `local.device`, `local.batchSize`, `local.precision`, and `local.modelCacheDir` in a copy of `config/protocol.json`. Download and verify the pinned BGE model revisions with `research/python/download_models.py` before running inference. The worker uses an explicit, verified offline cache.

The original GPU runner records hardware and checks competing compute processes. The Clef extension records shared-GPU execution separately; those timings are not interchangeable with the original exclusive-GPU block. Installation details for Clef are in its [adapter documentation](clef/README.md).

## Measured runs

Set provider credentials in a local environment file or process environment. The runner uses dotenv. `DOTENV_CONFIG_PATH` can select an environment file kept under ignored `data/`.

```sh
npm run research -- pilot \
  --datasets data/research/qasper-development.bundle.json,data/research/books-development.bundle.json \
  --config data/research/pilot-config.json \
  --id development-pilot --out data/research/development-pilot \
  --budget-file data/research/study-budget.sqlite --allow-paid

npm run research -- forecast \
  --pilot-dir data/research/development-pilot \
  --datasets data/research/qasper-test.bundle.json,data/research/books-test.bundle.json \
  --config data/research/test-config.json --out data/research/forecast.json

npm run research -- run \
  --datasets data/research/qasper-test.bundle.json,data/research/books-test.bundle.json \
  --config data/research/test-config.json \
  --id main-study --out data/research/main-study \
  --budget-file data/research/study-budget.sqlite --allow-paid
```

These commands call paid providers when `--allow-paid` is supplied. A shared SQLite ledger enforces the configured budget and records each request, usage report, price snapshot, and unresolved reservation. Existing manifests, datasets, and implementation snapshots are immutable. Completed or terminal failed attempts are retained rather than silently repeated.

A measured directory contains `manifest.json`, `datasets.json`, source snapshots, checkpoints, and a generated report. Changed source code or inputs require a new experiment identity; the historical extension scripts additionally check the recorded source hashes.

## Analysis

```sh
npm run research -- evaluate --out data/research/main-study
```

[metrics.ts](metrics.ts) implements source-interval evidence coverage, complete evidence recovery, and the five-passage oracle. Overlapping passage text is counted once. Results are averaged within documents before calculating corpus means and document-cluster bootstrap intervals. Negative questions do not receive evidence coverage scores.

Generation uses complete, deduplicated passage contributions in rank order. Contributions exceeding the context budget are omitted rather than truncated, and this packing loss is recorded. [RAGAS documentation](ragas/README.md) describes answer applicability, strict scoring, and failed-evaluation accounting. [Metric references](METRICS-LITERATURE.md) explain the evaluation choices.

## Verification

```sh
npm run check:research
npm run test:research
npm run test:research:python
node --import tsx --test research/decisions/*.test.ts
node --import tsx --test research/clef/*.test.ts
python3 -m unittest discover -s research/clef -p 'test_*.py'
python3 results/verify.py
```

Python RAGAS tests require its separate environment. Some historical extension tests use frozen private artifacts and are not part of the general offline test suite. Unit-test fixtures are synthetic and are not experimental observations.
