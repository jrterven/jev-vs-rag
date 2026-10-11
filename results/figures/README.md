# Result figures

These charts summarize the recorded **Scan or Index?** experiments. They introduce no new retrieval runs, generated answers, judge evaluations, or uncertainty estimates.

| Figure | Numerical source and scope |
| --- | --- |
| [Retrieval strategies](retrieval-strategies.png) | Shared 500/75 passage boundaries, a common hybrid pool of up to 50 candidates, up to five returned passages, and the fixed answer generator |
| [Evidence retention](scan-retention.png) | Original `readout.retentionSummary`, Decisions `retention`, and Clef `retention`: document-macro coverage on 76, 72, and 80 completed textbook scans, respectively |
| [Cumulative retrieval API cost](retrieval-api-reuse.png) | Original `readout.costAudit.methods` and Decisions `projections`: measured preparation plus repeated-query cost; unknown consumption remains a lower bound |
| [Evidence versus answer quality](evidence-answer-quality.png) | Retrieval means in original `report.methods`, Decisions `methods`, and Clef `quality`; automatic Answer Accuracy means in original `ragas.groups`, Decisions `groups`, and Clef `answerGroups` |

Source artifacts: [original measurements](../original/measurements.json), [Decisions retrieval](../decisions/retrieval.json), [Decisions answers](../decisions/answers.json), and [Clef measurements](../clef/measurements.json).

## Interpretation

Retention curves use method-specific completed subsets rather than a common successful cohort. Main EC@5 means instead use all answerable assignments, including failed retrievals with zero recovered evidence.

The cost chart uses logarithmic axes and retrieval API charges only. Clef's zero API charges are noted separately because zero cannot be placed on a logarithmic cost axis. Local resources, generation, and judging are excluded. The known-charge dense/Hybrid + Jev crossover is approximately 5.21 queries; unresolved charges can shift it earlier.

The scatter uses 80 textbook retrieval assignments for EC@5 and 53–60 scored answers from 60 generation assignments for Answer Accuracy. Both quantities are document-macro means. Different eligible subsets prevent treating the points as paired question-level observations; no regression, causal effect, or new significance test is implied. Existing paired bootstrap comparisons remain in the numerical artifacts.

Image checksums are included in [the distribution manifest](../manifest.json). Run `python3 results/verify.py` from the repository root to verify the assets and their numerical sources.
