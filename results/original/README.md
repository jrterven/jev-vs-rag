# Original Jev/RAG experiment

Seven retrieval methods are evaluated on 396 QASPER questions and 80 textbook questions. The generation sample additionally includes reference-evidence and no-evidence controls.

| Measurement | Observations |
| --- | ---: |
| Retrieval and control assignments | 5,132 |
| Completed / failed assignments | 5,106 / 26 |
| Valid repeated latency measurements | 2,075 of 2,100 |
| Usable generated answers | 1,794 of 1,800 |
| Scored / failed RAGAS metrics | 2,869 / 5 |

## Files

- [measurements.json](measurements.json): numerical retrieval observations, method summaries, and answer aggregates.
- [execution.json](execution.json): preparation, timing blocks, generation execution, and API components.
- [answer-metrics.json](answer-metrics.json): conditional answer scores, applicability, and paired comparisons.
- [retrieval-sensitivity.json](retrieval-sensitivity.json): per-book and sensitivity analysis.
- [generation-context.json](generation-context.json): context packing and evidence contribution accounting.
- [cost-audit.json](cost-audit.json): API usage estimates and unresolved reservations at the original experiment's measurement date.

The original API total is historical and excludes later extensions. Cross-system comparisons should preserve method scope, eligible populations, measurement dates, and the timing interruption documented in the execution records. Textbook references are predominantly model-authored; automated answer scores do not establish independent human correctness.

[Verification and metric definitions](../README.md) · [Experiment implementation](../../research/README.md)
