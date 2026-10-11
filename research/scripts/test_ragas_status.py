"""Focused offline fixtures for the read-only RAGAS monitor."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("ragas-status.py")
SPEC = importlib.util.spec_from_file_location("ragas_status", SCRIPT)
STATUS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(STATUS)


class StatusTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.phase = Path(self.tmp.name) / "test-judge"
        self.phase.mkdir()
        self.ledger = Path(self.tmp.name) / "ledger.sqlite"
        with sqlite3.connect(self.ledger) as db:
            db.execute("CREATE TABLE attempts(id TEXT PRIMARY KEY,value TEXT)")
            attempts = [
                ("test-judge:a", "completed", "0.000000007", "0.8"),
                ("test-judge:b", "failed", "0.000000003", "0.8"),
                ("test-judge:c", "unknown", None, "0.76192"),
                ("test-judge:d", "pending", None, "0.76192"),
                ("test-judge-other:a", "completed", "0.12", "0.8"),
                ("earlier:a", "unknown", None, "0.042"),
            ]
            for i, (run_id, state, cost, reserve) in enumerate(attempts):
                db.execute("INSERT INTO attempts VALUES(?,?)", (str(i), json.dumps({"runId": run_id, "status": state, "costUsd": cost, "reservedUsd": reserve,
                    "startedAt": "2026-10-05T04:00:00Z", "finishedAt": "2026-10-05T04:00:01Z" if state != "pending" else None,
                    "prompt": "SECRET PROMPT", "response": "SECRET RESPONSE", "inputTokens": 999})))
        self.samples = [
            {"id": "one", "metrics": list(STATUS.METRICS), "metadata": {"notApplicable": {}}, "question": "SECRET QUESTION"},
            {"id": "two", "metrics": ["answer_accuracy"], "metadata": {"notApplicable": {"faithfulness": "closed_book"}}},
            {"id": "three", "metrics": [], "metadata": {"notApplicable": {"faithfulness": "abstention", "answer_accuracy": "unanswerable_reference"}}},
        ]
        self.write_inputs()

    def write_inputs(self):
        data = b"".join((json.dumps(s) + "\n").encode() for s in self.samples)
        (self.phase / "samples.jsonl").write_bytes(data)
        (self.phase / "all-inputs.jsonl").write_bytes(data)
        (self.phase / "export-manifest.json").write_text(json.dumps({"sampleCount": len(self.samples), "requestedMetrics": 3,
            "metricCounts": {"faithfulness": 1, "answer_accuracy": 2}, "samplesSha256": hashlib.sha256(data).hexdigest(), "missing": [{"reason": "unavailable"}]}))

    def write_results(self, rows, tail=b""):
        (self.phase / "study.results.jsonl").write_bytes(b"".join((json.dumps(row) + "\n").encode() for row in rows) + tail)

    def row(self, sample="one", metric="faithfulness", status="completed"):
        return {"sampleId": sample, "metric": metric, "status": status, "score": 1 if status == "completed" else None, "response": "SECRET ANSWER"}

    def summary(self):
        return STATUS.summarize(self.phase, self.ledger)

    def test_read_only_counts_cost_precision_and_na(self):
        self.write_results([self.row(), self.row(metric="answer_accuracy", status="error"), self.row("two", "answer_accuracy", "unscorable")])
        before = {p: p.read_bytes() for p in self.phase.iterdir() if p.is_file()}
        ledger_before = self.ledger.read_bytes()
        result = self.summary()
        self.assertEqual(result["metrics"]["faithfulness"], {"expected": 1, "notApplicable": 2, "completed": 1, "error": 0, "unscorable": 0, "missing": 0})
        self.assertEqual(result["metrics"]["answer_accuracy"], {"expected": 2, "notApplicable": 1, "completed": 0, "error": 1, "unscorable": 1, "missing": 0})
        self.assertEqual(result["scopedBudget"]["knownUsd"], "0.000000010")
        self.assertEqual(result["globalBudget"]["knownUsd"], "0.120000010")
        self.assertEqual(result["scopedBudget"]["unknownReservedUsd"], "0.76192")
        self.assertEqual(result["globalBudget"]["unknownReservedUsd"], "0.80392")
        self.assertEqual(result["globalBudget"]["pendingReservedUsd"], "0.76192")
        self.assertEqual(result["missingGenerations"], 1)
        encoded = json.dumps(result)
        self.assertLess(len(encoded), 3000)
        self.assertNotIn("SECRET", encoded)
        self.assertNotIn("inputTokens", encoded)
        self.assertEqual(self.ledger.read_bytes(), ledger_before)
        self.assertEqual(before, {p: p.read_bytes() for p in self.phase.iterdir() if p.is_file()})

    def test_partial_final_write_preserves_completed_rows_and_missing(self):
        for tail in (b'{"sampleId":"two"', b'{"sampleId":"\xe2\x82'):
            with self.subTest(tail=tail):
                self.write_results([self.row()], tail)
                result = self.summary()
                self.assertEqual(result["trailingResultLine"], {"state": "incomplete", "bytes": len(tail)})
                self.assertEqual(result["metrics"]["faithfulness"]["completed"], 1)
                self.assertEqual(result["metrics"]["answer_accuracy"]["missing"], 2)
                self.assertEqual(result["metrics"]["answer_accuracy"]["error"], 0)
        self.write_results([], json.dumps(self.row()).encode())
        self.assertEqual(self.summary()["trailingResultLine"]["state"], "valid_without_newline")
        self.assertEqual(self.summary()["metrics"]["faithfulness"]["completed"], 1)

    def test_rejects_corrupt_complete_duplicate_foreign_and_na_results(self):
        bad_histories = [[self.row(), self.row()], [self.row("missing")], [self.row("two")],
                         [self.row(metric="factual_correctness")], [self.row(status="pending")],
                         [{**self.row(), "score": True}], [{**self.row(status="error"), "score": 0}]]
        for rows in bad_histories:
            with self.subTest(rows=rows):
                self.write_results(rows)
                with self.assertRaises(STATUS.StatusError):
                    self.summary()
        self.write_results([self.row()], b'{"broken":\n')
        with self.assertRaisesRegex(STATUS.StatusError, "Malformed complete"):
            self.summary()

    def test_validates_inputs_and_manifest_and_all_inputs_fallback(self):
        (self.phase / "samples.jsonl").unlink()
        self.assertEqual(self.summary()["metrics"]["answer_accuracy"]["missing"], 2)
        self.write_inputs()
        (self.phase / "all-inputs.jsonl").write_text("different")
        with self.assertRaisesRegex(STATUS.StatusError, "input files differ"):
            self.summary()
        self.write_inputs()
        self.samples[0]["metrics"].append("faithfulness")
        self.write_inputs()
        with self.assertRaisesRegex(STATUS.StatusError, "duplicate input metric"):
            self.summary()
        self.samples[0]["metrics"].pop()
        self.samples[1]["metadata"]["notApplicable"] = {}
        self.write_inputs()
        with self.assertRaisesRegex(STATUS.StatusError, "explicit NA"):
            self.summary()

    def test_process_exit_and_identity(self):
        (self.phase / "runtime.pid").write_text(str(os.getpid()))
        (self.phase / "runtime.exit-code").write_text("2\n")
        (self.phase / "study.results.jsonl.manifest.json").write_text(json.dumps({"runId": "test-judge"}))
        result = self.summary()
        self.assertEqual(result["processes"]["runtime"], {"pid": os.getpid(), "pidExists": True})
        self.assertEqual(result["runtimeExitCode"], 2)
        self.assertIsNotNone(result["latestProgressAt"])
        (self.phase / "preflight.json").write_text(json.dumps({"runId": "another-run"}))
        with self.assertRaisesRegex(STATUS.StatusError, "identities differ"):
            self.summary()

    def test_invalid_billing_is_not_silently_zero(self):
        with sqlite3.connect(self.ledger) as db:
            db.execute("UPDATE attempts SET value=json_set(value,'$.status','completed') WHERE id='2'")
        with self.assertRaisesRegex(STATUS.StatusError, "Missing cost"):
            self.summary()

    def test_cli_redacts_corrupt_input_and_outputs_small_json(self):
        result = subprocess.run([sys.executable, str(SCRIPT), "--phase", str(self.phase), "--ledger", str(self.ledger)], capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertLess(len(result.stdout), 3000)
        self.assertNotIn("SECRET", result.stdout)
        self.write_results([], b'{"SECRET ANSWER": invalid}\n')
        result = subprocess.run([sys.executable, str(SCRIPT), "--phase", str(self.phase), "--ledger", str(self.ledger)], capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn("SECRET", result.stderr)
        self.assertEqual(json.loads(result.stderr), {"error": "Malformed complete JSONL row"})


if __name__ == "__main__":
    unittest.main()
