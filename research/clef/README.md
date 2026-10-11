# Local Clef retrieval

The Clef adapter implements `hybrid-clef` and `clef-scan` using the open Cloudflare 27B decision model. The recorded deployment uses revision `ed3eed331870db2eff4b0db01237128ede8a00ce`, complete BF16 weights, CUDA, and a shared NVIDIA GB10 GPU on a DGX Spark.

## Runtime

The recorded environment uses PyTorch 2.11.0+cu130, Transformers 5.10.2, Torchvision 0.26.0+cu130, and Flash Linear Attention/fla-core 0.4.2. Causal convolution uses the PyTorch CUDA fallback. Runtime manifests record the actual package versions and model-file hashes.

`download_model.py` downloads the pinned revision and verifies its files. `runtime.py` checks the model manifest before loading the backbone and decision head. CPU fallback and quantization are disabled in the reported deployment. Model weights are not distributed in this repository.

## Retrieval protocol

- Same documents, questions, 500/75 passage boundaries, and five-result limit as the original experiment.
- `hybrid-clef` reranks the original frozen `shared50` candidates.
- `clef-scan` visits the complete document and retains ten candidates per window before hierarchical reduction.
- The adapter preserves the Jev-compatible Choice/Noul schema and does not add the Decisions-specific none option.
- A preventive 12,000-token limit is checked with both the native Clef tokenizer and the common study tokenizer. Complete text is validated before subdivision; truncation is rejected.
- Ranking uses the official SystemOne four-decimal probabilities, with document-order tie breaking. Unrounded probabilities are diagnostic records only.
- One inference request runs at a time; CUDA synchronization and request-recording overhead are included in elapsed time.

**Hybrid latency covers reranking only**, excluding candidate generation. Full scanning and reranking have distinct timing scopes. Comparisons with hosted Jev and Decisions must also account for different machines, dates, precision, and concurrency.

## Recorded measurements

All 952 primary searches completed. The additional timing schedule was stopped after the primary outcomes: 18 repetitions completed and 382 did not, including one interrupted repetition. Primary latency summaries use the first execution and are descriptive; they do not represent a completed three-round protocol.

The fixed 200-question answer sample produced 400 outputs. RAGAS scored 690 of 694 applicable pairs and retained four terminal errors. Local retrieval has zero API charges, while GPU, CPU, memory, storage, and electricity are unpriced. [Numerical results](../../results/clef/README.md) retain the timing amendment and answer-evaluation denominators.

## Implementation

| File | Purpose |
| --- | --- |
| `export_inputs.ts` | Hash-bound document, question, and candidate export |
| `runtime.py`, `search.py`, `run.py` | Local model execution, hierarchical search, and experiment scheduling |
| `audit.py`, `audit_amended.py` | Input, trace, outcome, and amended-timing validation |
| `analyze.ts`, `timing.ts` | Canonical retrieval metrics and timing selection |
| `secondary.ts` | Downstream generation from preserved retrieval results |
| `bridge.ts`, `audit_judge.ts` | RAGAS provider bridge and raw-score audit |
| `analyze_judge.py` | Paired comparisons against original and Decisions outputs |

Historical execution helpers retain the frozen experiment's source checks. They require its original private artifacts. The core adapter can be inspected and tested independently of the raw study data.

## Offline analysis and tests

```sh
node --import tsx research/clef/analyze.ts \
  --inputs /path/frozen-clef-inputs \
  --directory /path/clef-run \
  --audit /path/retrieval-audit.json \
  --out output/clef-analysis.json

python3 -m unittest discover -s research/clef -p 'test_*.py'
node --import tsx --test research/clef/*.test.ts
python3 results/verify.py
```

The retrieval analyzer accepts both the original and amended timing audit. It verifies input and run hashes before calculating evidence coverage. Negative questions are excluded from that metric, and failed assigned retrievals contribute zero recovered evidence. Synthetic adapter tests do not enter measured results.
