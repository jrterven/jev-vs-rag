"""Offline input/control invariants for the additive question-aware phase."""
import json
from pathlib import Path
import tempfile
import unittest

from accuracy import prepare, select_samples, technical_controls


SAMPLE = {"id": "original", "question": "Do they propose future extensions?", "response": "Yes, they propose future extensions.",
          "reference": "Yes", "contexts": ["Original evidence"], "metrics": ["faithfulness", "factual_correctness"],
          "metadata": {"cohort": "pilot-positive", "method": "method", "unanswerable": False, "abstained": False,
                       "referencePolicy": "frozen-first-human-answer", "generationPayloadHash": "existing-hash"}}


class AccuracyInputTests(unittest.TestCase):
    def test_preserves_all_original_content_and_provenance(self):
        selected, excluded = select_samples([SAMPLE], "source-hash")
        self.assertEqual(excluded, {})
        row = selected[0]
        for key in ("question", "response", "reference", "contexts"):
            self.assertEqual(row[key], SAMPLE[key])
        self.assertEqual(row["reference"], "Yes")
        self.assertEqual(row["metrics"], ["answer_accuracy"])
        self.assertEqual(row["metadata"]["generationPayloadHash"], "existing-hash")
        self.assertEqual(row["metadata"]["sourceSampleId"], "original")
        self.assertNotEqual(row["id"], "original")

    def test_abstentions_kept_and_negative_reference_excluded(self):
        abstain = {**SAMPLE, "id": "abstain", "response": "I cannot answer.", "metadata": {**SAMPLE["metadata"], "abstained": True}}
        negative = {**SAMPLE, "id": "negative", "metadata": {**SAMPLE["metadata"], "unanswerable": True}}
        selected, excluded = select_samples([abstain, negative], "hash")
        self.assertEqual(len(selected), 1)
        self.assertTrue(selected[0]["metadata"]["abstained"])
        self.assertEqual(excluded, {"unanswerable_reference": 1})

    def test_duplicate_and_nonfrozen_references_rejected(self):
        with self.assertRaisesRegex(ValueError, "unique"):
            select_samples([SAMPLE, SAMPLE], "hash")
        with self.assertRaisesRegex(ValueError, "reference policy"):
            select_samples([{**SAMPLE, "metadata": {**SAMPLE["metadata"], "referencePolicy": "rewritten"}}], "hash")

    def test_controls_unique_predeclared_and_three_repeats(self):
        controls = technical_controls()
        case_count = len({row["metadata"]["control"] for row in controls})
        self.assertEqual(case_count, 11)
        self.assertEqual(len(controls), 3 * case_count)
        self.assertEqual(len({row["id"] for row in controls}), len(controls))
        shared = [row for row in controls if row["metadata"]["control"] == "shared-irrelevant-fact"]
        self.assertEqual(len(shared), 3)
        self.assertTrue(all(row["metadata"]["expected"]["answer_accuracy"]["max"] == 0.25 for row in shared))
        for row in controls:
            self.assertFalse(row["metadata"]["humanCalibration"])
            bounds = row["metadata"]["expected"]["answer_accuracy"]
            self.assertLess(bounds["min"], bounds["max"])
            self.assertEqual(row["metrics"], ["answer_accuracy"])

    def test_export_freezes_source_bytes_and_rejects_changed_input(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.jsonl"
            source.write_text(json.dumps(SAMPLE) + "\n")
            first = prepare(source, root / "phase")
            self.assertEqual(first["researchRecords"], 1)
            self.assertEqual(first["maximumPlannedCalls"], 2 * (1 + len(technical_controls())))
            self.assertEqual(first, prepare(source, root / "phase"))
            source.write_text(json.dumps({**SAMPLE, "reference": "No"}) + "\n")
            with self.assertRaisesRegex(ValueError, "Frozen file differs"):
                prepare(source, root / "phase")


if __name__ == "__main__":
    unittest.main()
