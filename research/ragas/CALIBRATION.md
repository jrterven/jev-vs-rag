# Technical controls and human comparison

`calibration.py` uses only the Python standard library. Its eight fictional controls are repeated three times with identical content and different IDs. Expected ranges and directions are specified in input metadata before scoring. Contrasts cover supported, unsupported, partial, paraphrased and unrelated facts, and separate context support from reference agreement. These are **synthetic technical controls, not human calibration**. The repeated score range of 0.25 is a descriptive stability diagnostic, not a statistical acceptance threshold.

```sh
python3 research/ragas/calibration.py fixtures --output /path/controls.jsonl
python3 research/ragas/analyze.py summarize --input /path/inputs.jsonl --results /path/results.jsonl --output /path/summary.json
python3 research/ragas/calibration.py packet --input /path/inputs.jsonl --out-dir /path/human-review --per-stratum 1
```

The reviewer folder contains `review.html`, blank `ratings.jsonl` and `rubric.json`. Open the HTML locally: it shows one answer at a time, saves progress in the browser, imports prior ratings and downloads JSONL. Browser storage is only a convenience; download the ratings for durable storage. Share only that reviewer folder. The sibling `human-review-private/mapping.json` links blind IDs to source records and must remain with the coordinator until ratings are frozen. Packet sampling is deterministic, independent of scores and takes at most one repeated answer per question/method/cohort/answerability stratum. Technical controls are excluded.

```sh
python3 research/ragas/analyze.py human --input /path/inputs.jsonl --results /path/results.jsonl --mapping /path/human-review-private/mapping.json --ratings /path/completed-ratings.jsonl --output /path/human-agreement.json
python3 -m unittest discover -s research/ragas -p 'test_calibration_analysis.py'
```

Concatenate independent reviewers' downloaded JSONL files for import. Actual numeric ratings require a reviewer ID; duplicate reviewer/item ratings, modified packet content and mismatched input mappings are rejected. Blank values are pending, never zero. `not_applicable` and ratings with an `issue` are excluded from agreement. With blank packets, the output explicitly reports zero completed ratings and no human agreement. Human scalar ratings are related judgments, not identical RAGAS claim decompositions.

Automated summaries use one terminal result per `(sampleId, metric)` and official `completed`, `error` or `unscorable` statuses. The three real cohorts remain separate: `pilot-positive`, `negative-diagnostic` and `context-repair`; groups also retain method and answerability. Requested, scored, failed, unscorable, missing and not-applicable denominators are visible. Repeated questions are averaged within each group before computing a descriptive mean. No scores are pooled across cohorts or methods; missing values are never assigned zero. Human comparisons likewise average repeated question pairs before summarizing. No confidence intervals or significance claims are produced.

## Additive question-aware correctness

Metric discovery follows the supplied records and expected-control keys. An AnswerAccuracy-only evaluation therefore does not acquire phantom Faithfulness/FactualCorrectness denominators, and the original evaluation does not acquire an unrequested metric. Original controls, thresholds and result snapshots remain unchanged.

`readout.py` accepts optional `--accuracy-samples`, `--accuracy-results`, `--accuracy-controls-summary` and `--accuracy-budget`. With those inputs, the main correctness column/figure uses Answer Accuracy, while Factual Correctness remains a reference-agreement diagnostic. Joins require a unique original `sourceSampleId` and unchanged question, response, contexts, reference and stratum metadata. Identical natural question/response/reference inputs are audited for variation separately; they are not scheduled stability repetitions or independent questions.

`analyze.py human` accepts the optional pair `--accuracy-samples` / `--accuracy-results`. The packet still has two human fields: faithfulness and answer correctness. The existing JSON field `factual_correctness` maps explicitly to automated `answer_accuracy` when that pair is supplied. Human reviewers interpret a short reference in the context of the question. Method summaries remain separate; an additional descriptive cohort summary averages absolute answer-level errors within each question, then gives each question equal weight across methods. Blank packets produce no agreement statistics.

Regenerating a packet preserves a compatible existing `ratings.jsonl` byte-for-byte, including completed ratings and notes. Different items/content require a new output directory.
