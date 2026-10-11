# Scan or Index? — Experimental results

Numerical outputs and charts for **Scan or Index? Evidence Coverage, Answer Quality, and Cost in Long-Document RAG**. The original seven-method experiment and the Decisions and Clef extensions retain separate measurement dates, reference provenance, and deployment conditions.

| Directory | Contents |
| --- | --- |
| [original/](original/README.md) | Retrieval, generation, answer metrics, sensitivity analysis, and API accounting |
| [decisions/](decisions/README.md) | Decisions retrieval and paired answer comparisons |
| [clef/](clef/README.md) | Local Clef retrieval, retention, timing, and answer comparisons |
| [retrieval.csv](retrieval.csv) | EC@5 means and 95% document-bootstrap intervals for all 11 methods and both corpora |
| [figures/](figures/README.md) | Retrieval design, evidence retention, cumulative API cost, and evidence versus answer quality |
| [provenance.json](provenance.json) | Source and distribution checksums for the numerical export |
| [manifest.json](manifest.json) | File checksums for this distribution |

## Verify

```sh
python3 results/verify.py
# Equivalent npm command:
npm run results:verify
```

Verification checks every distributed file, confirms source-artifact hashes, recomputes the CSV selection, and checks answer-outcome and cost accounting. It uses Python's standard library and makes no API calls. It does not rerun retrieval or judge evaluation.

## Reading the measurements

**EC@5** is the fraction of annotated source evidence covered by the five returned passages, averaged within each document and then across documents. Evidence overlap is counted once. Quality uses 320 answerable QASPER questions and 80 textbook questions. The additional 76 unanswerable QASPER questions do not receive evidence coverage scores. Failed assigned retrievals contribute zero recovered evidence.

Paired intervals use jointly eligible observations and a document-cluster bootstrap with 10,000 resamples and seed 42. Answer Accuracy and Faithfulness are conditional model-judge scores with explicit denominators. Missing generation, metric errors, non-applicability, and unscorable outputs are not assigned zero. Exploratory paired comparisons are unadjusted for multiple testing.

The answer sample contains 100 answerable QASPER questions, 40 unanswerable QASPER questions, and 60 textbook questions. The generator is `gpt-4.1-mini-2025-04-14`; RAGAS 0.4.3 uses `gpt-6.1-sol` with medium reasoning. Textbook test references comprise 78 model-authored and two human-authored questions, without independent human validation.

## Timing and API accounting

Original, Decisions, and Clef measurements use different dates and execution conditions. Clef hybrid timing is reranking over frozen candidates, excluding candidate generation. Clef primary latency is a descriptive first-execution summary after its timing amendment; the 18 completed extra repetitions are not pooled into that summary.

The final API accounting includes US$98.815484948 in known usage estimates and US$7.2200192 in unresolved reservations, totaling US$106.035504148 committed. Judge evaluation is included in that total. Cost scopes overlap and must not be added. Reservations are not confirmed charges or proven upper bounds. Local hardware and electricity are unpriced; zero local-inference API charges do not imply zero total cost.

## Data availability

These artifacts contain numerical measurements and aggregate audit summaries. Full books, question banks, generated answers, provider prompts and responses, access tokens, and SQLite ledgers are not distributed. Recomputing metrics from raw inputs requires their corresponding frozen source artifacts. Source hashes and run metadata preserve the provenance of the distributed measurements.
