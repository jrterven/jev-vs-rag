# Evaluation metrics and references

The evaluation separates evidence retrieval, answer correctness, context support, abstention, latency, and cost. These quantities measure different properties; a higher retrieval score does not establish a better generated answer.

## Retrieval

The primary metric is source-text evidence coverage at five passages. Source intervals prevent duplicate credit for overlapping chunks. Complete evidence-set recovery, the five-passage oracle, and stagewise evidence retention describe whether all required evidence survives the retrieval pipeline.

Conventional ranking metrics such as nDCG or MRR require a separate relevance definition for passages. They are not interchangeable with coverage of a complete multi-section evidence set. The implementation is in [metrics.ts](metrics.ts).

## Answers

The held-out answer evaluation uses official RAGAS 0.4.3 Faithfulness and Answer Accuracy:

- **Faithfulness:** support for extracted answer claims in the supplied passages. It does not verify the selected citation labels or measure answer completeness.
- **Answer Accuracy:** question-conditioned agreement with an unchanged positive reference. Its normalized rubric score is not a percentage of factually correct answers.

Factual Correctness was examined during development but remains a diagnostic because it does not receive the question and can misinterpret short references. Abstention is analyzed separately for answerable and unanswerable questions. Failed, unscorable, missing, and not-applicable outcomes retain distinct denominators.

The judge is `gpt-6.1-sol` with medium reasoning. Method identities, prices, and retrieval timings are excluded from judge prompts. The [RAGAS integration](ragas/README.md) documents applicability, strict scoring, and provenance. No independent human agreement measurement was collected for the reported answer scores.

## Efficiency

Preparation, retrieval, generation, and evaluation are measured separately. Latency summaries report the sample population and execution conditions. Cost projections use preparation plus the mean per-query API cost, with unresolved usage and unpriced local resources kept explicit.

## Related evaluation work

| Reference | Relevant evaluation dimensions |
| --- | --- |
| [RAGAs, EACL Demo 2024](https://aclanthology.org/2024.eacl-demo.16/) | Faithfulness, answer relevance, context relevance, and comparison with human judgments |
| [RAGChecker, NeurIPS 2024](https://proceedings.neurips.cc/paper_files/paper/2024/hash/27245589131d17368cccdfa990cbf16e-Abstract-Datasets_and_Benchmarks_Track.html) | Claim correctness, retrieval precision/recall, evidence utilization, hallucination, and context support |
| [mtRAG, TACL 2025](https://aclanthology.org/2025.tacl-1.36/) | Passage Recall/nDCG, RAGAS Faithfulness, answerability, and human evaluation |
| [Grounded attributions and learning to refuse, ICLR 2025](https://proceedings.iclr.cc/paper_files/paper/2025/hash/4c88827decab6c046b881a2c3a99c76f-Abstract-Conference.html) | Answer correctness, grounded refusal, and grounded citation quality |
| [RAGVUE, EACL Demo 2026](https://aclanthology.org/2026.eacl-demo.35/) | Retrieval relevance/coverage, answer completeness, claim support, and judge agreement |

These references provide context for the metric choices rather than a shared benchmark or a claim that their scores are directly comparable. Official RAGAS definitions are linked in the [runtime documentation](ragas/RUNTIME.md).
