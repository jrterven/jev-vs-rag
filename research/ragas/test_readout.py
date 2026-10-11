import copy
import unittest

from analyze import analyze
from calibration import technical_controls
from readout import duplicate_input_audit, make_readout, metric_cell, money, pilot_diagnostics
from test_calibration_analysis import sample, result


def retrieval_report():
    return {"kind": "measured", "aggregation": "document_macro", "methods": [{"id": "bm25", "corpus": "qasper-development", "coverage": .75, "latencyP50Ms": 12, "preparationUsd": "0", "queryMeanUsd": "0", "nQueries": 60, "nTimingRuns": 180}]}


class ReadoutTest(unittest.TestCase):
    def test_paired_scores_and_prompt_identity_are_distinct_diagnostics(self):
        left, right = sample("a", method="jev-scan", metrics=["answer_accuracy"]), sample("b", method="hybrid-jev", metrics=["answer_accuracy"])
        for row in (left, right):
            row["metadata"]["generationPayloadHash"] = "same-payload"
        right["response"] = "Different generated wording"
        before = copy.deepcopy([left, right])
        diagnostics = pilot_diagnostics([left, right], [result(left, "answer_accuracy", .75), result(right, "answer_accuracy", .5)], {})
        pair = diagnostics["pairedAnswerAccuracy"][0]
        self.assertEqual((pair["higher"], pair["equal"], pair["lower"]), (1, 0, 0))
        self.assertEqual(pair["identicalGenerationPayloads"], 1)
        self.assertEqual(pair["identicalResponseTexts"], 0)
        self.assertEqual([left, right], before)

    def test_reference_and_semantic_window_diagnostics_preserve_all_rows(self):
        row = sample()
        row["reference"] = "Answer with content missing: (formula for CIC) known qualifier"
        report = retrieval_report()
        report["preparation"] = [{"documentId": "d1", "chunks": 2}, {"documentId": "d2", "chunks": 27}]
        report["perQuery"] = [{"method": "jev-scan", "round": 0, "status": "completed", "traces": [{"stage": "window", "level": 0}, {"stage": "window", "level": 0}, {"stage": "window", "level": 1}]}]
        summary, markdown = make_readout([row], [], {}, report, {})
        self.assertEqual(summary["inputRecords"], 1)
        diagnostics = summary["pilotDiagnostics"]
        self.assertEqual(diagnostics["referenceMissingContent"]["cicFormulaRecords"], 1)
        self.assertEqual(diagnostics["retrievalScope"]["initialWindowCounts"], {"2": 1})
        self.assertEqual(diagnostics["retrievalScope"]["medianChunks"], 14.5)
        self.assertIn("no garantiza un oro completo", markdown)
        self.assertIn("Se conservan todas las observaciones", markdown)

    def test_additive_accuracy_is_primary_and_factual_correctness_is_diagnostic(self):
        row = sample()
        aa = {**row, "id": "aa:a", "metrics": ["answer_accuracy"], "metadata": {**row["metadata"], "sourceSampleId": "a"}}
        summary, text = make_readout([row], [result(row, "factual_correctness", 0)], {}, retrieval_report(), {}, [aa], [result(aa, "answer_accuracy", .75)])
        self.assertEqual(summary["primaryCorrectnessMetric"], "answer_accuracy")
        self.assertIn("Answer Accuracy (pregunta)", text)
        self.assertIn("0.750 [1/1]", text)
        self.assertIn("Factual Correctness se conserva como diagnóstico", text)
        self.assertEqual(summary["answerAccuracy"]["inputRecords"], 1)

    def test_natural_duplicates_report_variation_without_independence_claims(self):
        rows = [sample("a", metrics=["answer_accuracy"]), sample("b", method="oracle", metrics=["answer_accuracy"])]
        output = duplicate_input_audit(rows, [result(rows[0], "answer_accuracy", .75), result(rows[1], "answer_accuracy", 1)])
        self.assertEqual(output["duplicateGroups"], 1)
        self.assertEqual(output["duplicateRecords"], 2)
        self.assertEqual(output["maximumRange"], .25)
        self.assertIn("not planned", output["policy"])

    def test_report_uses_original_retrieval_and_separate_generation_denominators(self):
        rows = [sample("a"), sample("b", question="q2"), sample("c", method="oracle"), sample("d", method="closed-book", metrics=["factual_correctness"])]
        original = retrieval_report()
        snapshot = copy.deepcopy(original)
        scores = [result(rows[0], score=1), result(rows[1], score=0), result(rows[2]), result(rows[3], "factual_correctness", .2)]
        summary, markdown = make_readout(rows, scores, {}, original, {"evaluation": {"knownUsd": "1.25", "reservedUsd": "0", "unknownAttempts": 0}})
        self.assertEqual(original, snapshot)
        self.assertIn("60 consultas de calidad y 180 ejecuciones", markdown)
        self.assertIn("4 respuestas de 2 preguntas", markdown)
        self.assertIn("0.500 [2/2]", markdown)
        self.assertIn("N/A (1)", markdown)
        self.assertIn("75.0", markdown)
        self.assertIn("USD 1.25", markdown)
        self.assertEqual(summary["humanCalibration"]["status"], "pending-actual-ratings")

    def test_negative_abstention_and_positive_controls_are_separate(self):
        rows = [sample("a", cohort="negative-diagnostic", metrics=[]), sample("b", cohort="negative-diagnostic", metrics=[])]
        rows[0]["metadata"].update(unanswerable=True, abstained=True)
        rows[1]["metadata"].update(unanswerable=False, abstained=False)
        summary, _ = make_readout(rows, [], {}, retrieval_report(), {})
        self.assertEqual(summary["negativeDiagnosticAbstention"], [
            {"method": "bm25", "unanswerable": True, "records": 1, "questions": 1, "abstained": 1, "answered": 0, "unknown": 0},
            {"method": "bm25", "unanswerable": False, "records": 1, "questions": 1, "abstained": 0, "answered": 1, "unknown": 0}])

    def test_incomplete_controls_never_claim_pass(self):
        controls = analyze(technical_controls(), [])
        _, markdown = make_readout([sample()], [], controls, retrieval_report(), {})
        self.assertIn("0/16 combinaciones", markdown)
        self.assertIn("0/16 tienen todas las repeticiones", markdown)

    def test_missing_metrics_and_costs_are_not_zero_filled(self):
        row = sample()
        report = retrieval_report()
        report["methods"][0]["coverage"] = None
        _, markdown = make_readout([row], [], {}, report, {})
        self.assertIn("| BM25 | — |", markdown)
        self.assertEqual(money(None), "—")
        self.assertEqual(money("0"), "0")
        self.assertEqual(metric_cell(None, "faithfulness"), "—")

    def test_unmeasured_or_mixed_retrieval_reports_rejected(self):
        report = retrieval_report()
        report["kind"] = "mock"
        with self.assertRaisesRegex(ValueError, "measured"):
            make_readout([sample()], [], {}, report, {})
        report = retrieval_report()
        report["methods"].append({**report["methods"][0], "corpus": "other"})
        with self.assertRaisesRegex(ValueError, "single"):
            make_readout([sample()], [], {}, report, {})


if __name__ == "__main__":
    unittest.main()
