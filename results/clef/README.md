# Local Clef results

Two methods use the same original inputs and question selection: reranking over frozen hybrid candidates and full-document scanning. All 952 primary searches completed. The timing amendment retains 18 completed extra repetitions and 382 uncompleted repetitions, including one interrupted execution. Primary latency uses the first execution only.

The recorded runtime used the complete 27B model in BF16 on a shared GB10 GPU, with one local request at a time. In textbooks, median reranking latency is 54.7 seconds and median full-scan latency is 23.3 minutes. Hybrid timing excludes candidate generation.

Generation produced all 400 assigned answers. RAGAS scored 690 of 694 applicable pairs, retaining three HTTP 503 errors with unknown usage and one invalid NLI statement-list response with confirmed usage. The 106 non-applicable answer/metric combinations remain separate.

## Files

- [measurements.json](measurements.json): evidence coverage, retention, timing scopes, conditional answer scores, paired comparisons, candidate-pool diagnostics, and API accounting.
- [audit-summary.json](audit-summary.json): raw-score recomputation, source integrity, unchanged historical rows, and cost totals.

The two Clef variants return identical QASPER rankings on all 396 cases; 395 candidate pools already contain the entire article. Textbooks distinguish candidate preselection from complete scanning. Better textbook evidence coverage than dense retrieval does not establish better answer scores: the corresponding paired Answer Accuracy intervals include zero.

[Verification and interpretation](../README.md) · [Clef implementation](../../research/clef/README.md)
