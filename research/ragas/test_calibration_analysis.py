import copy
import json
import math
import re
import tempfile
from pathlib import Path
import unittest

from calibration import blind_packet, packet_html, preserve_or_create_ratings, technical_controls
from analyze import agreement, analyze, link_accuracy, result_index


def sample(identifier="a", question="q1", cohort="pilot-positive", method="bm25", metrics=None):
    return {"id": identifier, "question": "Which city?", "response": "Oslo.", "contexts": ["The city is Oslo."], "reference": "Oslo.",
            "metrics": list(metrics if metrics is not None else ("faithfulness", "factual_correctness")),
            "metadata": {"questionId": question, "cohort": cohort, "method": method, "unanswerable": False}}


def result(row, metric="faithfulness", score=1, status="completed"):
    return {"schemaVersion": 1, "id": row["id"], "sampleId": row["id"], "metric": metric, "status": status, "score": score}


class TechnicalControlsTest(unittest.TestCase):
    def test_eight_controls_three_identical_content_repeats_explicit_expectations(self):
        rows = technical_controls()
        self.assertEqual(len(rows), 24)
        self.assertEqual(len({row["id"] for row in rows}), 24)
        controls = {row["metadata"]["control"] for row in rows}
        self.assertEqual(len(controls), 8)
        for control in controls:
            group = [row for row in rows if row["metadata"]["control"] == control]
            self.assertEqual([row["metadata"]["repeat"] for row in group], [1, 2, 3])
            self.assertEqual(len({json.dumps({k: row[k] for k in ("question", "response", "contexts", "reference")}, sort_keys=True) for row in group}), 1)
            for row in group:
                self.assertTrue(row["metadata"]["synthetic"])
                self.assertFalse(row["metadata"]["humanCalibration"])
                self.assertEqual(set(row["metadata"]["expected"]), set(row["metrics"]))

    def test_stability_reports_each_repeat_and_no_human_calibration(self):
        rows = technical_controls()[:3]
        results = [result(row, metric, score) for row, score in zip(rows, (1, .9, .5)) for metric in row["metrics"]]
        technical = analyze(rows, results)["technicalControls"]
        self.assertFalse(technical["humanCalibration"])
        metric = technical["controls"][0]["metrics"]["faithfulness"]
        self.assertEqual(metric["n"], 3)
        self.assertAlmostEqual(metric["mean"], .8)
        self.assertFalse(metric["allExpectedRangesPassed"])
        self.assertFalse(metric["stabilityRangeAtMost025"])
        self.assertEqual(metric["range"], .5)


class AnalysisTest(unittest.TestCase):
    def test_additive_metric_discovery_has_no_phantom_baseline_metrics(self):
        aa = sample(metrics=["answer_accuracy"])
        output = analyze([aa], [result(aa, "answer_accuracy", .75)])
        self.assertEqual(set(output["groups"][0]["metrics"]), {"answer_accuracy"})
        baseline = analyze([sample()], [])
        self.assertNotIn("answer_accuracy", baseline["groups"][0]["metrics"])

    def test_accuracy_join_rejects_changed_reference(self):
        row = sample()
        aa = {**row, "id": "aa:a", "metrics": ["answer_accuracy"], "metadata": {**row["metadata"], "sourceSampleId": "a"}}
        self.assertEqual(link_accuracy([row], [aa], []), {"a": None})
        aa["reference"] = "Changed"
        with self.assertRaisesRegex(ValueError, "content differs"):
            link_accuracy([row], [aa], [])

    def test_cohorts_methods_and_answerability_remain_separate(self):
        rows = [sample("a"), sample("b", cohort="negative-diagnostic"), sample("c", cohort="context-repair"), sample("d", method="oracle")]
        rows[1]["metadata"]["unanswerable"] = True
        output = analyze(rows, [result(row) for row in rows])
        self.assertEqual(len(output["groups"]), 4)
        self.assertEqual(output["questionsAppearingInMultipleCohorts"], 1)
        self.assertEqual(output["cohorts"], {"pilot-positive": 2, "negative-diagnostic": 1, "context-repair": 1})
        self.assertNotIn("mean", output)

    def test_repeated_question_scores_are_averaged_before_group_mean(self):
        rows = [sample("a", "q1"), sample("b", "q1"), sample("c", "q2")]
        output = analyze(rows, [result(row, score=score) for row, score in zip(rows, (1, 1, 0))])
        group = output["groups"][0]
        self.assertEqual(group["repeatedQuestionRecords"], 1)
        self.assertEqual(group["metrics"]["faithfulness"]["questionWeighted"]["mean"], .5)
        self.assertEqual(group["metrics"]["faithfulness"]["scoredQuestions"], 2)

    def test_failures_missing_unscorable_and_not_applicable_are_not_zeroes(self):
        rows = [sample(str(i)) for i in range(5)]
        rows[4]["metrics"] = []
        rows[4]["metadata"]["notApplicable"] = {"faithfulness": "abstained", "factual_correctness": "missing reference"}
        output = analyze(rows, [result(rows[0], score=.8), result(rows[1], score=None, status="error"), result(rows[2], score=None, status="unscorable")])
        metric = output["groups"][0]["metrics"]["faithfulness"]
        self.assertEqual({k: metric[k] for k in ("requested", "scored", "error", "unscorable", "missing", "notApplicable")},
                         {"requested": 4, "scored": 1, "error": 1, "unscorable": 1, "missing": 1, "notApplicable": 1})
        self.assertEqual(metric["questionWeighted"]["mean"], .8)
        self.assertEqual(metric["notApplicableReasons"], {"abstained": 1})

    def test_duplicate_unknown_and_invalid_results_fail_closed(self):
        row = sample()
        for results in ([result(row), result(row)], [result(sample("absent"))], [result(row, score=math.nan)], [result(row, score=True)], [result(row, score=0, status="error")]):
            with self.assertRaises(ValueError):
                result_index([row], results)

    def test_unscored_control_cannot_pass_checks(self):
        output = analyze(technical_controls()[:3], [])
        metric = output["technicalControls"]["controls"][0]["metrics"]["faithfulness"]
        self.assertFalse(metric["allExpectedRangesPassed"])
        self.assertFalse(metric["allRepeatsScored"])
        self.assertIsNone(metric["stabilityRangeAtMost025"])


class HumanPacketTest(unittest.TestCase):
    def test_regeneration_preserves_filled_ratings_byte_for_byte(self):
        public, _ = blind_packet([sample()])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ratings.jsonl"
            self.assertEqual(preserve_or_create_ratings(path, public), "created")
            filled = copy.deepcopy(public)
            filled[0].update(raterId="actual-reviewer", ratings={"faithfulness": .5, "factual_correctness": 1}, note="Actual note")
            path.write_text(json.dumps(filled[0]) + "\n")
            before = path.read_bytes()
            self.assertEqual(preserve_or_create_ratings(path, public), "preserved")
            self.assertEqual(path.read_bytes(), before)
            altered = copy.deepcopy(public)
            altered[0]["reference"] = "Different"
            with self.assertRaisesRegex(ValueError, "new output directory"):
                preserve_or_create_ratings(path, altered)
            self.assertEqual(path.read_bytes(), before)

    def test_human_correctness_explicitly_maps_to_additive_answer_accuracy(self):
        row = sample()
        aa = {**row, "id": "aa:a", "metrics": ["answer_accuracy"], "metadata": {**row["metadata"], "sourceSampleId": "a"}}
        public, mapping = blind_packet([row])
        public[0].update(raterId="actual-reviewer", ratings={"factual_correctness": 1})
        output = agreement([row], [result(row, "factual_correctness", 0)], mapping, public, [aa], [result(aa, "answer_accuracy", 1)])
        self.assertEqual(output["groups"][0]["automatedMetric"], "answer_accuracy")
        self.assertEqual(output["groups"][0]["humanRatingField"], "factual_correctness")
        self.assertEqual(output["groups"][0]["humanVsAutomated"]["meanAbsoluteError"], 0)

    def test_cohort_agreement_balances_questions_across_methods(self):
        rows = [sample("a", "q1"), sample("b", "q1", method="oracle"), sample("c", "q2")]
        public, mapping = blind_packet(rows)
        for row in public:
            row.update(raterId="actual-reviewer", ratings={"faithfulness": 1})
        output = agreement(rows, [result(row, score=value) for row, value in zip(rows, (1, 0, 1))], mapping, public)
        cohort = output["cohortAgreement"][0]
        self.assertEqual(cohort["pairedAnswers"], 3)
        self.assertEqual(cohort["pairedQuestions"], 2)
        self.assertEqual(cohort["questionBalancedMeanAbsoluteError"], .25)

    def test_packet_is_blind_deterministic_and_excludes_synthetic_controls(self):
        rows = [sample("source-secret", method="secret-method"), *technical_controls()]
        public, mapping = blind_packet(rows)
        self.assertEqual(len(public), 1)
        self.assertEqual((public, mapping), blind_packet(rows))
        text = json.dumps(public)
        for secret in ("secret-method", "source-secret", "metadata", "expected", "score"):
            self.assertNotIn(secret, text)
        self.assertEqual(mapping["items"][0]["sourceId"], "source-secret")
        self.assertEqual(public[0]["ratings"], {"faithfulness": None, "factual_correctness": None})

    def test_packet_samples_unique_questions_per_stratum_without_score_selection(self):
        rows = [sample("a"), sample("b"), sample("c", question="q2"), sample("d", cohort="context-repair")]
        public, mapping = blind_packet(rows)
        self.assertEqual(len(public), 3)
        limited, _ = blind_packet(rows, per_stratum=1)
        self.assertEqual(len(limited), 2)

    def test_html_json_is_safe_for_untrusted_source_text_and_contains_no_mapping(self):
        rows = [sample("source-secret", method="secret-method")]
        attack = '</script><script>alert("x")</script><img src=x onerror=alert(1)> & \u2028'
        rows[0]["response"] = attack
        public, _ = blind_packet(rows)
        page = packet_html(public)
        self.assertNotIn(attack, page)
        self.assertNotIn("source-secret", page)
        self.assertNotIn("secret-method", page)
        match = re.search(r'<script id="packet-data" type="application/json">(.*?)</script>', page, re.S)
        self.assertIsNotNone(match)
        self.assertEqual(json.loads(match.group(1)), public)
        self.assertIn("localStorage.setItem", page)
        self.assertIn("Descargar calificaciones", page)
        self.assertIn("textContent=row.response", page)

    def test_blank_packet_does_not_claim_human_calibration(self):
        rows = [sample()]
        public, mapping = blind_packet(rows)
        output = agreement(rows, [result(rows[0])], mapping, public)
        self.assertFalse(output["hasActualHumanRatings"])
        self.assertEqual(output["filledRatings"], 0)
        self.assertEqual(output["blankRows"], 1)
        self.assertEqual(output["groups"], [])

    def test_actual_distinct_ratings_have_descriptive_agreement_only(self):
        rows = [sample()]
        public, mapping = blind_packet(rows)
        first, second = copy.deepcopy(public[0]), copy.deepcopy(public[0])
        first.update(raterId="reviewer-a", ratings={"faithfulness": 1, "factual_correctness": None})
        second.update(raterId="reviewer-b", ratings={"faithfulness": .5, "factual_correctness": "not_applicable"})
        output = agreement(rows, [result(rows[0], score=1)], mapping, [first, second])
        self.assertTrue(output["hasActualHumanRatings"])
        group = output["groups"][0]
        self.assertEqual(group["humanRatings"], 2)
        self.assertEqual(group["humanVsAutomated"]["meanAbsoluteError"], .25)
        self.assertIsNone(group["humanVsAutomated"]["pearson"])
        self.assertEqual(group["humanVsHuman"]["questionWeightedMeanAbsoluteDifference"], .5)
        self.assertEqual(output["notApplicableRatings"], 1)

    def test_human_import_rejects_missing_rater_duplicate_or_tampered_content(self):
        rows = [sample()]
        public, mapping = blind_packet(rows)
        rated = copy.deepcopy(public[0])
        rated["ratings"]["faithfulness"] = 1
        with self.assertRaisesRegex(ValueError, "raterId"):
            agreement(rows, [], mapping, [rated])
        rated["raterId"] = "real-reviewer"
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            agreement(rows, [], mapping, [rated, rated])
        rated["response"] = "Tampered"
        with self.assertRaisesRegex(ValueError, "modified"):
            agreement(rows, [], mapping, [rated])

    def test_incident_ratings_do_not_count_as_quality(self):
        rows = [sample()]
        public, mapping = blind_packet(rows)
        public[0].update(raterId="reviewer", ratings={"faithfulness": 0}, issue="corrupt evidence")
        output = agreement(rows, [], mapping, public)
        self.assertEqual(output["incidentRows"], 1)
        self.assertEqual(output["filledRatings"], 0)
        self.assertFalse(output["hasActualHumanRatings"])


if __name__ == "__main__":
    unittest.main()
