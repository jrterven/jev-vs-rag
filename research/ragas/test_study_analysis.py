"""Offline regressions for the scope-bound RAGAS study summary."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("study_analysis", Path(__file__).with_name("study-analysis.py"))
analysis = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analysis)


def sample(question="q1", document="d1", method="jev-scan", *, scope="test", corpus=None, kind="human_qasper", negative=False, abstained=False, experiment="experiment-1", metrics=None):
    corpus = corpus or ("qasper-test" if scope == "test" else "qasper-development")
    if metrics is None:
        metrics = [metric for metric in analysis.METRICS if not (metric == "faithfulness" and (abstained or method == "closed-book")) and not (metric == "answer_accuracy" and negative)]
    na = {}
    if "faithfulness" not in metrics:
        na["faithfulness"] = "explicit_abstention" if abstained else "closed_book_no_supplied_evidence"
    if "answer_accuracy" not in metrics:
        na["answer_accuracy"] = "unanswerable_reference"
    annotation = {"mode": "single_annotator", "annotatorIds": ["0123456789abcdef0123"], "reviewedAt": "2026-10-04T00:00:00.000Z"} if kind == "human_book" else {"mode": "model_generated", "humanReviewed": False, "model": "gpt-6-astra", "promptHash": "c" * 64} if kind == "model_generated_book" else None
    return {"id": f"{experiment}:{question}:{method}", "question": "¿Qué explica " + question + "?", "response": "I cannot answer." if abstained else "La respuesta es uno 🧪.", "reference": "La respuesta es uno 🧪." if not negative else "", "contexts": [] if method == "closed-book" else ["[C1] Evidencia completa 🧪."], "metrics": metrics,
            "metadata": {"corpus": corpus, "method": method, "split": scope, "scope": scope, "sourceRunId": f"{experiment}:generation:{question}:{method}", "questionId": question, "documentId": document, "datasetHash": "a" * 64, "retrievalImplementationHash": "b" * 64, "unanswerable": negative, "abstained": abstained, "notApplicable": na, "referenceKind": kind, "referencePolicy": analysis.REFERENCE_POLICIES[kind], "referenceAnnotation": annotation}}


def result(row, score=1.0, metric="faithfulness", status="completed", *, judge_run="judge-1"):
    request_id = "ragas:" + analysis.sha256(json.dumps([judge_run, row["id"], metric, 1], ensure_ascii=False, separators=(",", ":")).encode())
    return {"sampleId": row["id"], "metric": metric, "status": status, "score": score if status == "completed" else None, "metadata": copy.deepcopy(row["metadata"]), "calls": [{"requestId": request_id, "attemptId": request_id + ":attempt", "model": "gpt-6.1-sol", "status": "completed"}]}


def manifests(rows, missing=None, scope="test"):
    missing = missing or []
    counts = {metric: sum(metric in row["metrics"] for row in rows) for metric in analysis.METRICS}
    experiments = sorted({row["metadata"]["sourceRunId"].split(":")[0] for row in rows} | {row["sourceRunId"].split(":")[0] for row in missing})
    export = {"scope": scope, "policy": analysis.POLICY, "metrics": list(analysis.METRICS), "ragasVersion": "0.4.3", "judge": {"model": "gpt-6.1-sol", "reasoningEffort": "medium"}, "sampleCount": len(rows), "requestedMetrics": sum(counts.values()), "metricCounts": counts, "missing": missing,
              "provenance": [{"experimentId": exp, "phase": "test" if scope == "test" else "pilot", "scope": scope, "datasetHash": "a" * 64, "implementationHash": "b" * 64, "reportSha256": "d" * 64, "scheduledGenerations": sum(row["metadata"]["sourceRunId"].startswith(exp + ":") for row in rows) + sum(row["sourceRunId"].startswith(exp + ":") for row in missing)} for exp in experiments]}
    runtime = {"runId": "judge-1", "judgeModel": "gpt-6.1-sol", "ragasVersion": "0.4.3", "retries": 0, "metricConfig": {"faithfulness": {}, "answer_accuracy": {"max_retries": 1}}}
    return export, runtime


def summarize(rows, results, missing=None, **kwargs):
    exported, runtime = manifests(rows, missing, kwargs.get("scope", "test"))
    return analysis.analyze_records(rows, results, exported, runtime, scope=kwargs.pop("scope", "test"), iterations=200, **kwargs)


def group(report, method="jev-scan", metric="faithfulness", negative=False, corpus="qasper-test"):
    return next(row for row in report["groups"] if row["method"] == method and row["metric"] == metric and row["unanswerable"] == negative and row["corpus"] == corpus)


class StudyAnalysisTests(unittest.TestCase):
    def test_document_macro_weights_documents_not_question_counts(self):
        rows = [sample(f"q{i}", "document-a") for i in range(9)] + [sample("q9", "document-b")]
        report = summarize(rows, [result(row, int(index < 9)) for index, row in enumerate(rows)])
        value = group(report)
        self.assertEqual(value["meanDocumentMacro"], .5)
        self.assertEqual(value["nDocumentsScored"], 2)
        self.assertEqual(value["nScored"], 10)
        self.assertEqual(value["nPending"], 0)
        self.assertIsNone(group(report, metric="answer_accuracy")["meanDocumentMacro"])

    def test_pair_questions_before_document_aggregation_and_bootstrap(self):
        left = [sample("q1", "a"), sample("q2", "a"), sample("q3", "a"), sample("q4", "b"), sample("q5", "a")]
        right = [sample(f"q{i}", "a" if i < 4 else "b", "openai-dense") for i in range(1, 5)] + [sample("q6", "b", "openai-dense")]
        rows = left + right
        values = [result(row, 0 if row["metadata"]["questionId"] == "q4" else 1) for row in left]
        values += [result(row, 1 if row["metadata"]["questionId"] == "q4" else 0) for row in right]
        report = summarize(rows, values)
        pair = next(p for p in report["paired"] if p["metric"] == "faithfulness")
        self.assertEqual(pair["meanDifference"], 0)  # a=+1 over 3 questions; b=-1 over one.
        self.assertEqual(pair["nPairs"], 4)
        self.assertEqual(pair["nDocuments"], 2)
        self.assertEqual(pair["nMethodScoredUnmatched"], 1)
        self.assertEqual(pair["nBaselineScoredUnmatched"], 1)
        self.assertEqual(pair["questionIds"], ["q1", "q2", "q3", "q4"])
        reordered = summarize(list(reversed(rows)), list(reversed(values)))
        self.assertEqual(pair, next(p for p in reordered["paired"] if p["metric"] == "faithfulness"))

    def test_only_common_successful_questions_enter_paired_mean(self):
        left = [sample("q1", "a"), sample("q2", "a")]
        right = [sample("q1", "a", "openai-dense"), sample("q2", "a", "openai-dense")]
        values = [result(left[0], 1), result(left[1], status="error"), result(right[0], 0), result(right[1], 1)]
        pair = next(p for p in summarize(left + right, values)["paired"] if p["metric"] == "faithfulness")
        self.assertEqual(pair["meanDifference"], 1)
        self.assertEqual(pair["nPairs"], 1)
        self.assertTrue(pair["limitedDocumentSupport"])
        self.assertEqual((pair["ciLow"], pair["ciHigh"]), (1, 1))

    def test_failures_na_pending_and_missing_generation_are_distinct(self):
        rows = [sample("ok", "a"), sample("error", "b"), sample("unscorable", "b"), sample("pending", "c"), sample("abstain", "c", abstained=True)]
        missing = [{"sourceRunId": "experiment-1:generation:missing:jev-scan", "questionId": "missing", "documentId": "d", "corpus": "qasper-test", "split": "test", "method": "jev-scan", "unanswerable": False, "reason": "fetch failed", "oracleIneligible": False}]
        values = [result(rows[0], .5), result(rows[1], status="error"), result(rows[2], status="unscorable")]
        report = summarize(rows, values, missing)
        value = group(report)
        self.assertEqual({key: value[key] for key in ("nAnswers", "nRequested", "nScored", "nNA", "nFailed", "nUnscorable", "nPending", "nMissingGenerations", "nSourceAssignments")}, {"nAnswers": 5, "nRequested": 4, "nScored": 1, "nNA": 1, "nFailed": 1, "nUnscorable": 1, "nPending": 1, "nMissingGenerations": 1, "nSourceAssignments": 6})
        self.assertEqual(value["meanDocumentMacro"], .5)
        self.assertEqual(value["nDocumentsScored"], 1)
        self.assertEqual(group(report, metric="answer_accuracy")["nRequested"], 5)
        abstention = report["abstention"][0]
        self.assertEqual(abstention["nAbstained"], 1)
        self.assertEqual(abstention["nMissingGenerations"], 1)
        self.assertAlmostEqual(abstention["rateDocumentMacro"], 1 / 6)
        self.assertEqual(abstention["rateAnswerMicro"], .2)

    def test_negative_and_closed_book_na_have_no_fabricated_scores(self):
        rows = [sample("negative", negative=True, abstained=True), sample("positive", method="closed-book")]
        report = summarize(rows, [result(rows[1], .5, metric="answer_accuracy")])
        for metric in analysis.METRICS:
            self.assertIsNone(group(report, metric=metric, negative=True)["meanDocumentMacro"])
            self.assertEqual(group(report, metric=metric, negative=True)["nNA"], 1)
        self.assertIsNone(group(report, method="closed-book")["meanDocumentMacro"])
        self.assertEqual(group(report, method="closed-book", metric="answer_accuracy")["meanDocumentMacro"], .5)
        self.assertEqual(report["accounting"]["notApplicable"], 3)

    def test_mixed_book_reference_counts_deduplicate_questions_and_keep_origins(self):
        rows = [sample(q, "book", method, corpus="openstax-books", kind=kind) for q, kind in (("human-q", "human_book"), ("model-q", "model_generated_book")) for method in ("jev-scan", "openai-dense")]
        report = summarize(rows, [result(row) for row in rows])
        counts = {row["referenceKind"]: row for row in report["referenceCounts"]}
        self.assertEqual(set(counts), {"human_book", "model_generated_book"})
        self.assertEqual(counts["human_book"]["uniqueQuestions"], 1)
        self.assertEqual(counts["model_generated_book"]["answers"], 2)
        rows[2]["metadata"]["referenceAnnotation"]["humanReviewed"] = True
        with self.assertRaisesRegex(ValueError, "must not claim human review"):
            summarize(rows, [])

    def test_scope_result_identity_and_runtime_request_linkage_reject_tampering(self):
        rows = [sample(scope="development")]
        exported, runtime = manifests(rows, scope="development")
        with self.assertRaisesRegex(ValueError, "pilot cannot become test"):
            analysis.analyze_records(rows, [], exported, runtime, scope="test")
        values = [result(rows[0])]
        values[0]["metadata"]["documentId"] = "unrelated-doc"
        with self.assertRaisesRegex(ValueError, "metadata differs"):
            analysis.analyze_records(rows, values, exported, runtime, scope="development")
        values = [result(rows[0], judge_run="old-judge-run")]
        with self.assertRaisesRegex(ValueError, "does not belong"):
            analysis.analyze_records(rows, values, exported, runtime, scope="development")
        rows[0]["metadata"]["corpus"] = "qasper-test"
        with self.assertRaisesRegex(ValueError, "corpus/split"):
            analysis.analyze_records(rows, [], exported, runtime, scope="development")

    def test_duplicate_scores_assignments_and_reused_attempts_are_rejected(self):
        row = sample()
        with self.assertRaisesRegex(ValueError, "Duplicate terminal"):
            summarize([row], [result(row), result(row)])
        duplicate = copy.deepcopy(row)
        duplicate["id"] += "-copy"
        with self.assertRaisesRegex(ValueError, "Duplicate answer"):
            summarize([row, duplicate], [])
        values = [result(row), result(row, metric="answer_accuracy")]
        values[1]["calls"][0]["attemptId"] = values[0]["calls"][0]["attemptId"]
        with self.assertRaisesRegex(ValueError, "attempt reused"):
            summarize([row], values)
        missing = dict(row["metadata"], reason="fake missing")
        with self.assertRaisesRegex(ValueError, "already generated"):
            summarize([row], [], [missing])

    def test_pairing_rejects_question_reference_or_document_changes(self):
        for field in ("question", "reference", "documentId"):
            rows = [sample(), sample(method="openai-dense")]
            target = rows[1]["metadata"] if field == "documentId" else rows[1]
            target[field] = "different"
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "do not share"):
                summarize(rows, [])

    def test_macro_never_pools_experiments_and_empty_pairs_have_null_intervals(self):
        rows = [sample(experiment="first"), sample(method="openai-dense", experiment="second")]
        report = summarize(rows, [result(row) for row in rows])
        self.assertEqual(report["paired"], [])
        self.assertEqual(len(report["provenance"]["experiments"]), 2)
        self.assertNotIn("experimentId", report["provenance"])
        empty = analysis.paired_bootstrap([])
        self.assertIsNone(empty["meanDifference"])
        self.assertIsNone(empty["ciLow"])

    def test_file_hashes_verify_exact_input_semantics_runtime_source_and_report_link(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            samples, results, export_file, runtime_file, runtime_source = [root / name for name in ("samples.jsonl", "results.jsonl", "export.json", "runtime.json", "runtime.py")]
            rows = [sample()]
            samples.write_text(json.dumps(rows[0], ensure_ascii=False) + "\n")
            results.write_text(json.dumps(result(rows[0]), ensure_ascii=False) + "\n")
            runtime_source.write_text("# frozen runtime fixture\n")
            exported, runtime = manifests(rows)
            exported.update(samplesSha256=analysis.sha256(samples.read_bytes()), samplesHash=analysis.sample_hash(samples))
            runtime.update(inputSha256=exported["samplesSha256"], runtimeSha256=analysis.sha256(runtime_source.read_bytes()))
            export_file.write_text(json.dumps(exported))
            runtime_file.write_text(json.dumps(runtime))
            arguments = dict(samples=samples, results=results, export_manifest=export_file, runtime_manifest=runtime_file, runtime_source=runtime_source, scope="test", iterations=100)
            report = analysis.analyze_files(**arguments)
            self.assertTrue(report["integrity"]["runtimeInputHashVerified"])
            self.assertTrue(report["integrity"]["runtimeSourceVerified"])
            self.assertEqual(report["provenance"]["retrievalReportSha256"], "d" * 64)
            # Reformatting is semantically identical but violates the exact runtime input.
            original = samples.read_text()
            samples.write_text(original + "\n")
            with self.assertRaisesRegex(ValueError, "Input bytes differ"):
                analysis.analyze_files(**arguments)
            samples.write_text(original)
            exported["samplesHash"] = "e" * 64
            export_file.write_text(json.dumps(exported))
            with self.assertRaisesRegex(ValueError, "samplesHash mismatch"):
                analysis.analyze_files(**arguments)
            exported["samplesHash"] = analysis.sample_hash(samples)
            export_file.write_text(json.dumps(exported))
            runtime_source.write_text("# tampered source\n")
            with self.assertRaisesRegex(ValueError, "Runtime source hash mismatch"):
                analysis.analyze_files(**arguments)


if __name__ == "__main__":
    unittest.main()
