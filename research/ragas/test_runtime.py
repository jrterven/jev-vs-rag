"""Offline contract tests using the real RAGAS metric classes and prompts."""

import argparse
import asyncio
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from runtime import BridgeError, BridgeLLM, JUDGE_MODEL, load_samples, run, score_metric, strict_schema, validate_bridge_url
from ragas.metrics.collections.faithfulness.util import StatementGeneratorOutput


def official_input(payload):
    return json.loads(payload["messages"][0]["content"].rsplit("\ninput: ", 1)[1].rsplit("\nOutput:", 1)[0])


def fake_response(payload):
    data = official_input(payload)
    if payload["schemaName"] == "StatementGeneratorOutput":
        value = {"statements": [data["answer"]]}
    elif payload["schemaName"] == "AnswerAccuracyOutput":
        value = {"rating": 4}
    elif payload["schemaName"] == "ClaimDecompositionOutput":
        value = {"claims": [data["response"]]}
    else:
        value = {"statements": [{"statement": statement, "reason": "Supported by the context.", "verdict": 1} for statement in data["statements"]]}
    return {"text": json.dumps(value), "attemptId": payload["requestId"] + ":attempt", "model": JUDGE_MODEL}


SAMPLE = {"id": "sample:1", "question": "Where is Paris?", "response": "Paris is in France.", "contexts": ["Paris is in France."], "reference": "Paris is in France.", "metrics": ["faithfulness", "factual_correctness"], "metadata": {"method": "hidden-from-judge"}}


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    def llm(self, metric="faithfulness", sender=None, sample_id="sample:1"):
        return BridgeLLM(url="http://127.0.0.1:34567/judge", token="test-token", run_id="test-run", sample_id=sample_id, metric=metric, sender=sender)

    async def test_official_metrics_and_prompt_mapping(self):
        for metric, count in (("faithfulness", 2), ("factual_correctness", 4), ("answer_accuracy", 2)):
            payloads = []

            async def sender(payload):
                payloads.append(payload)
                return fake_response(payload)

            result = await score_metric(SAMPLE, metric, self.llm(metric, sender))
            self.assertEqual(result["row"]["status"], "completed")
            self.assertEqual(result["row"]["score"], 1.0)
            self.assertEqual(len(payloads), count)
            self.assertEqual(len(result["row"]["attemptIds"]), count)
            self.assertEqual(result["row"]["metadata"], SAMPLE["metadata"])
            for payload in payloads:
                self.assertEqual(payload["sampleId"], SAMPLE["id"])
                self.assertEqual(payload["metric"], metric)
                self.assertNotIn("hidden-from-judge", json.dumps(payload))
                self.assertFalse(payload["schema"]["additionalProperties"])
                self.assertEqual(set(payload["schema"]["required"]), set(payload["schema"]["properties"]))
                for definition in payload["schema"].get("$defs", {}).values():
                    if definition.get("type") == "object":
                        self.assertFalse(definition["additionalProperties"])
            if metric == "factual_correctness":
                self.assertEqual(official_input(payloads[0])["atomicity"], "high")
                self.assertEqual(official_input(payloads[0])["coverage"], "high")

    async def test_answer_accuracy_question_and_short_reference_swapped(self):
        sample = {**SAMPLE, "question": "Do the authors suggest future extensions?", "response": "Yes, they suggest future extensions.", "reference": "Yes"}
        payloads = []

        async def sender(payload):
            payloads.append(payload)
            return {**fake_response(payload), "text": json.dumps({"rating": 4 if len(payloads) == 1 else 2})}

        result = await score_metric(sample, "answer_accuracy", self.llm("answer_accuracy", sender))
        self.assertEqual(result["row"]["score"], 0.75)
        first, second = [official_input(payload) for payload in payloads]
        self.assertEqual(first, {"query": sample["question"], "user_answer": sample["response"], "reference_answer": "Yes"})
        self.assertEqual(second, {"query": sample["question"], "user_answer": "Yes", "reference_answer": sample["response"]})

    async def test_answer_accuracy_no_retry_or_single_judge_fallback(self):
        for failure_at in (1, 2):
            calls = []

            async def sender(payload):
                calls.append(payload)
                if len(calls) == failure_at:
                    raise BridgeError("unknown usage", "failed-attempt")
                return fake_response(payload)

            result = await score_metric(SAMPLE, "answer_accuracy", self.llm("answer_accuracy", sender))
            self.assertEqual(len(calls), failure_at)
            self.assertTrue(result["fatal"])
            self.assertEqual(result["row"]["status"], "error")
            self.assertIsNone(result["row"]["score"])
            self.assertIn("failed-attempt", result["row"]["attemptIds"])

    async def test_answer_accuracy_rejects_invalid_rating_without_more_calls(self):
        for rating in (1, 3, 5, True, "4"):
            calls = []

            async def sender(payload):
                calls.append(payload)
                return {**fake_response(payload), "text": json.dumps({"rating": rating})}

            result = await score_metric(SAMPLE, "answer_accuracy", self.llm("answer_accuracy", sender))
            self.assertEqual(len(calls), 1)
            self.assertEqual(result["row"]["status"], "error")
            self.assertIsNone(result["row"]["score"])

    async def test_request_ids_resume_and_independent_repeats(self):
        requests = []

        async def sender(payload):
            requests.append(payload["requestId"])
            return fake_response(payload)

        for sample_id in ("sample:1", "sample:1", "sample:1-repeat2"):
            llm = self.llm(sender=sender, sample_id=sample_id)
            await score_metric(SAMPLE, "faithfulness", llm)
        self.assertEqual(requests[:2], requests[2:4])
        self.assertNotEqual(requests[:2], requests[4:])

    async def test_invalid_json_keeps_attempt_without_retry(self):
        calls = []

        async def sender(payload):
            calls.append(payload)
            return {"text": "not json", "attemptId": "paid-attempt", "model": JUDGE_MODEL}

        result = await score_metric(SAMPLE, "faithfulness", self.llm(sender=sender))
        self.assertEqual(len(calls), 1)
        self.assertEqual(result["row"]["status"], "error")
        self.assertIsNone(result["row"]["score"])
        self.assertEqual(result["row"]["attemptIds"], ["paid-attempt"])

    async def test_rejects_omitted_nli_statements(self):
        async def sender(payload):
            result = fake_response(payload)
            if payload["schemaName"] == "NLIStatementOutput":
                result["text"] = '{"statements": []}'
            return result

        for metric in SAMPLE["metrics"]:
            result = await score_metric(SAMPLE, metric, self.llm(metric, sender))
            self.assertEqual(result["row"]["status"], "error")
            self.assertIn("complete input statement list", result["row"]["error"]["message"])

    async def test_rejects_out_of_range_verdict(self):
        async def sender(payload):
            result = fake_response(payload)
            if payload["schemaName"] == "NLIStatementOutput":
                data = json.loads(result["text"])
                data["statements"][0]["verdict"] = 2
                result["text"] = json.dumps(data)
            return result

        result = await score_metric(SAMPLE, "faithfulness", self.llm(sender=sender))
        self.assertEqual(result["row"]["status"], "error")
        self.assertIn("integer 0 or 1", result["row"]["error"]["message"])

    async def test_empty_claims_are_unscorable_not_zero(self):
        async def sender(payload):
            return {"text": '{"statements": []}', "attemptId": "empty-claims", "model": JUDGE_MODEL}

        result = await score_metric(SAMPLE, "faithfulness", self.llm(sender=sender))
        self.assertEqual(result["row"]["status"], "unscorable")
        self.assertIsNone(result["row"]["score"])

    async def test_model_mismatch_is_fatal(self):
        async def sender(payload):
            return {**fake_response(payload), "model": "other-model"}

        result = await score_metric(SAMPLE, "faithfulness", self.llm(sender=sender))
        self.assertTrue(result["fatal"])
        self.assertEqual(result["row"]["status"], "error")

    async def test_bridge_error_is_terminal_without_retry(self):
        count = 0

        async def sender(payload):
            nonlocal count
            count += 1
            raise BridgeError("budget limit", "budget-attempt")

        result = await score_metric(SAMPLE, "faithfulness", self.llm(sender=sender))
        self.assertTrue(result["fatal"])
        self.assertEqual(count, 1)
        self.assertEqual(result["row"]["attemptIds"], ["budget-attempt"])

    async def test_append_only_resume_and_input_change_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            source = path / "samples.jsonl"
            source.write_text(json.dumps(SAMPLE) + "\n")
            token = path / "token"
            token.write_text("test-token")
            token.chmod(0o600)
            info = path / "info.json"
            info.write_text(json.dumps({"url": "http://127.0.0.1:34567/judge", "tokenFile": str(token), "model": JUDGE_MODEL, "runId": "test-run"}))
            args = argparse.Namespace(input=source, output=path / "results.jsonl", bridge_info=info, run_id="test-run", timeout=600, concurrency=2)
            requests = []

            def post(url, token, payload, timeout):
                requests.append(payload)
                return fake_response(payload)

            with patch("runtime.post_bridge", side_effect=post), contextlib.redirect_stdout(io.StringIO()):
                first = await run(args)
                original = args.output.read_bytes()
                second = await run(args)
                self.assertEqual(first["added"], 2)
                self.assertEqual(first["statusCounts"], {"completed": 2, "error": 0, "unscorable": 0})
                self.assertEqual(second["added"], 0)
                self.assertEqual(len(requests), 6)
                self.assertEqual(args.output.read_bytes(), original)
                source.write_text(json.dumps({**SAMPLE, "question": "Changed question"}) + "\n")
                with self.assertRaisesRegex(ValueError, "Resume rejected"):
                    await run(args)

    def test_local_only_bridge(self):
        for url in ("https://example.com/judge", "http://localhost:80/judge", "http://127.0.0.1:80/judge?secret=1", "http://user@127.0.0.1:80/judge"):
            with self.assertRaises(ValueError):
                validate_bridge_url(url)

    def test_strict_schema_does_not_mutate_original(self):
        original = StatementGeneratorOutput.model_json_schema()
        strict = strict_schema(original)
        self.assertNotIn("additionalProperties", original)
        self.assertFalse(strict["additionalProperties"])

    def test_duplicate_sample_ids_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "samples.jsonl"
            source.write_text((json.dumps(SAMPLE) + "\n") * 2)
            with self.assertRaisesRegex(ValueError, "unique"):
                load_samples(source)


if __name__ == "__main__":
    unittest.main()
