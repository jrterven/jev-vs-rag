# OpenAI Decisions results

The extension evaluates two methods on the original documents and question selection: hybrid reranking and full-document scanning. It contains 1,352 scheduled searches, including repetitions; 13 searches failed. Generation produced 392 of 400 assigned answers. RAGAS scored 674 of 676 requested pairs and retained two Faithfulness errors.

## Files

- [retrieval.json](retrieval.json): retrieval metrics, retention, timing groups, cost components, and paired comparisons.
- [answers.json](answers.json): conditional answer scores, applicability, paired answer comparisons, and API accounting.
- [audit-summary.json](audit-summary.json): score recomputation, unchanged historical rows, and source hashes.

The recorded API was beta and used `gpt-6-luna` for retrieval decisions. Answer generation used the original fixed GPT-4.1 mini generator. Measurement dates differ from the original study; shared-GPU continuation timings remain separate from the original execution block. Terminal failures, unknown consumption, and missing generation are retained.

[Verification and interpretation](../README.md) · [Decisions implementation](../../research/decisions/README.md)
