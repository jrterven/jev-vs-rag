"""Offline regressions for cross-experiment pairing; no model calls."""
import copy
import importlib.util
from pathlib import Path
import unittest


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


HERE = Path(__file__).resolve().parent
ANALYSIS = load("clef_judge_analysis", HERE / "analyze_judge.py")
FIXTURE = load("original_judge_test_fixtures", HERE.parent / "ragas/test_study_analysis.py")


def sample(qid="q1", document="d1", method="clef-scan", **kwargs):
    return FIXTURE.sample(qid, document, method, experiment="new" if method in ANALYSIS.NEW_METHODS else "old", **kwargs)


def cohort(rows, scores=None, missing=None):
    export, runtime = FIXTURE.manifests(rows, missing)
    runtime["runId"] = "new-judge" if export["provenance"][0]["experimentId"] == "new" else "old-judge"
    values = [FIXTURE.result(row, score=(scores or {}).get((row["metadata"]["questionId"], metric), .5),
                             metric=metric, judge_run=runtime["runId"])
              for row in rows for metric in row["metrics"]]
    return rows, values, export, runtime


def compare(old, new):
    return ANALYSIS.compare_records(*old, *new, iterations=200, seed=42)


def pair(report, metric="answer_accuracy"):
    return next(p for p in report["paired"] if p["method"] == "clef-scan" and p["baseline"] == "openai-dense" and p["metric"] == metric)


class ExtensionAnalysisTests(unittest.TestCase):
    def test_decisions_baseline_is_a_distinct_allowed_cohort(self):
        old,new=cohort([sample(method='decisions-scan')]),cohort([sample()])
        report=ANALYSIS.compare_records(*old,*new,baseline='decisions',iterations=200,seed=42)
        row=next(p for p in report['paired'] if p['method']=='clef-scan' and p['baseline']=='decisions-scan' and p['metric']=='answer_accuracy')
        self.assertEqual(row['nPairs'],1);self.assertEqual(row['meanDifference'],0)
        self.assertTrue(all(p['method'] in ANALYSIS.NEW_METHODS for p in report['paired']))
        with self.assertRaisesRegex(ValueError,'wrong cohort'):
            ANALYSIS.compare_records(*cohort([sample(method='openai-dense')]),*new,baseline='decisions',iterations=200,seed=42)

    def test_cross_experiment_pairs_weight_documents_not_questions(self):
        old = cohort([sample(q, d, "openai-dense") for q, d in (("q1", "d1"), ("q2", "d1"), ("q3", "d2"))])
        new = cohort([sample(q, d) for q, d in (("q1", "d1"), ("q2", "d1"), ("q3", "d2"))],
                     {(q, m): score for q, score in (("q1", 1), ("q2", 1), ("q3", 0)) for m in ANALYSIS.BASE.METRICS})
        result = compare(old, new)
        self.assertEqual(pair(result)["nPairs"], 3)
        self.assertEqual(pair(result)["nDocuments"], 2)
        self.assertEqual(pair(result)["meanDifference"], 0)
        self.assertEqual(pair(result)["ciLow"], -.5)
        self.assertEqual(pair(result)["ciHigh"], .5)

    def test_failures_and_na_remain_outside_scored_pairs(self):
        old = cohort([sample(q, method="openai-dense") for q in ("q1", "q2")])
        new = cohort([sample("q1", abstained=True), sample("q2")])
        failed = next(r for r in new[1] if r["metric"] == "answer_accuracy" and r["sampleId"].endswith("q2:clef-scan"))
        failed.update(status="error", score=None)
        report = compare(old, new)
        self.assertEqual(pair(report)["nPairs"], 1)
        self.assertEqual(pair(report)["meanDifference"], 0)
        self.assertEqual(pair(report, "faithfulness")["nBothRequested"], 1)
        self.assertEqual(report["extension"]["accounting"]["failed"], 1)
        self.assertEqual(report["extension"]["accounting"]["notApplicable"], 1)

    def test_missing_generation_preserves_assignment_and_null_all_failed_mean(self):
        old = cohort([sample(method="openai-dense")])
        missing = dict(sample()["metadata"], reason="provider_error")
        new = cohort([sample(method="hybrid-clef")], missing=[missing])
        report = compare(old, new)
        self.assertEqual(report["extension"]["accounting"]["missingGenerations"], 1)
        self.assertEqual(pair(report)["nPairs"], 0)
        self.assertIsNone(pair(report)["meanDifference"])
        self.assertEqual(report["sharedGenerationQuestions"], ["q1"])

    def test_identity_checks_include_unicode_reference_and_authorship(self):
        for field in ("question", "reference", "documentId", "referenceAnnotation"):
            old = cohort([sample(method="openai-dense", corpus="openstax-books", kind="model_generated_book")])
            row = sample(corpus="openstax-books", kind="model_generated_book")
            if field in ("question", "reference"):
                row[field] += " changed 🧪"
            elif field == "referenceAnnotation":
                row["metadata"][field]["model"] = "different-alias"
            else:
                row["metadata"][field] = "other"
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "Cross-cohort"):
                compare(old, cohort([row]))

    def test_dataset_scope_judge_identity_and_sample_assignment_must_match(self):
        old = cohort([sample(method="openai-dense")])
        new = cohort([sample()])
        new[3]["runId"] = old[3]["runId"]
        new[1].clear()
        with self.assertRaises(ValueError):
            compare(old, new)
        with self.assertRaisesRegex(ValueError, "exactly the same questions"):
            compare(old, cohort([sample("other")]))
        with self.assertRaisesRegex(ValueError, "still has pending"):
            new = cohort([sample()])
            new[1].pop()
            compare(old, new)
        new = cohort([sample()])
        new[0][0]["metadata"]["datasetHash"] = "c" * 64
        new[2]["provenance"][0]["datasetHash"] = "c" * 64
        for result in new[1]:
            result["metadata"]["datasetHash"] = "c" * 64
        with self.assertRaisesRegex(ValueError, "dataset differs"):
            compare(old, new)

    def test_paid_attempt_cannot_be_reused_between_cohorts(self):
        old, new = cohort([sample(method="openai-dense")]), cohort([sample()])
        new[1][0]["calls"][0]["attemptId"] = old[1][0]["calls"][0]["attemptId"]
        with self.assertRaisesRegex(ValueError, "reused across cohorts"):
            compare(old, new)

    def test_unanswerable_accuracy_stays_na_and_empty_intervals_are_null(self):
        old = cohort([sample(method="openai-dense", negative=True, abstained=True)])
        new = cohort([sample(negative=True, abstained=True)])
        report = compare(old, new)
        self.assertEqual(pair(report)["nPairs"], 0)
        self.assertIsNone(pair(report)["ciLow"])
        self.assertEqual(report["extension"]["accounting"]["notApplicable"], 2)

    def test_extension_cannot_claim_an_original_method(self):
        old = cohort([sample(method="openai-dense")])
        row = FIXTURE.sample(method="jev-scan", experiment="new")
        with self.assertRaisesRegex(ValueError, "wrong cohort"):
            compare(old, cohort([row]))

    def test_missing_generation_must_match_frozen_identity(self):
        old = cohort([sample(method="openai-dense")])
        missing = dict(sample()["metadata"], documentId="other", reason="provider_error")
        with self.assertRaisesRegex(ValueError, "mismatched document"):
            compare(old, cohort([sample(method="hybrid-clef")], missing=[missing]))

    def test_bootstrap_is_deterministic_and_inputs_are_not_mutated(self):
        old, new = cohort([sample(method="openai-dense")]), cohort([sample()])
        before = copy.deepcopy((old, new))
        self.assertEqual(compare(old, new), compare(old, new))
        self.assertEqual((old, new), before)


if __name__ == "__main__":
    unittest.main()
