"""Run official RAGAS collection metrics through the metered local Node bridge.

No provider SDK is used here. Every generation is one HTTP request, with no
transport, parsing, or metric retries. Metric formulas and prompts are RAGAS's.
"""

from __future__ import annotations

import argparse
import asyncio
import copy
import hashlib
import importlib.metadata
import json
import math
import os
import platform
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib import error, parse, request

# Set before importing RAGAS: evaluation data never enters package telemetry.
os.environ["RAGAS_DO_NOT_TRACK"] = "true"
os.environ["LANGCHAIN_TRACING_V2"] = "false"
os.environ["LANGSMITH_TRACING"] = "false"

from pydantic import BaseModel
from ragas.llms.base import InstructorBaseRagasLLM
from ragas.metrics.collections import AnswerAccuracy, FactualCorrectness, Faithfulness

RAGAS_VERSION = "0.4.3"
JUDGE_MODEL = "gpt-6.1-sol"
METRICS = ("faithfulness", "factual_correctness", "answer_accuracy")
METRIC_CONFIG = {
    "faithfulness": {},
    "factual_correctness": {"mode": "f1", "beta": 1.0, "atomicity": "high", "coverage": "high"},
    # RAGAS calls this max_retries, but it is the number of total attempts.
    "answer_accuracy": {"max_retries": 1},
}


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def strict_schema(schema: dict) -> dict:
    """Make Pydantic's output schema valid for strict structured output.

    This adds structural constraints only; it does not change metric prompts,
    claim decomposition, or score formulas.
    """
    result = copy.deepcopy(schema)

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            if node.get("type") == "object" or "properties" in node:
                node["additionalProperties"] = False
                node["required"] = list(node.get("properties", {}))
            node.pop("default", None)
            for child in node.values():
                visit(child)
        elif isinstance(node, list):
            for child in node:
                visit(child)

    visit(result)
    return result


class BridgeError(RuntimeError):
    def __init__(self, message: str, attempt_id: str | None = None):
        super().__init__(message)
        self.attempt_id = attempt_id


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise BridgeError("The local bridge must not redirect requests")


def validate_bridge_url(url: str) -> None:
    address = parse.urlsplit(url)
    if address.scheme != "http" or address.hostname != "127.0.0.1" or not address.port or address.path != "/judge" or address.query or address.fragment or address.username:
        raise ValueError("Bridge URL must be http://127.0.0.1:<port>/judge")


def post_bridge(url: str, token: str, payload: dict, timeout: float) -> dict:
    validate_bridge_url(url)
    data = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode()
    req = request.Request(url, data=data, method="POST", headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    opener = request.build_opener(request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(req, timeout=timeout) as response:
            body = json.load(response)
    except error.HTTPError as exc:
        try:
            body = json.loads(exc.read())
        except (ValueError, OSError):
            body = {}
        # Do not include response bodies, provider secrets, or prompts in logs.
        raise BridgeError(f"Judge bridge returned HTTP {exc.code}: {body.get('error', 'request failed')}", body.get("attemptId")) from exc
    except (error.URLError, TimeoutError, OSError) as exc:
        raise BridgeError(f"Judge bridge transport failed ({type(exc).__name__}); no retry was sent") from exc
    if not isinstance(body, dict) or not all(isinstance(body.get(key), str) and body[key] for key in ("text", "attemptId", "model")):
        raise BridgeError("Judge bridge returned an invalid response envelope")
    return body


class BridgeLLM(InstructorBaseRagasLLM):
    def __init__(self, *, url: str, token: str, run_id: str, sample_id: str, metric: str, timeout: float = 600, trace: Callable[[dict], None] | None = None, sender: Callable | None = None):
        validate_bridge_url(url)
        if metric not in METRICS:
            raise ValueError("Unsupported metric")
        self.url, self.token = url, token
        self.run_id, self.sample_id, self.metric = run_id, sample_id, metric
        self.timeout, self.trace, self.sender = timeout, trace, sender
        self.calls: list[dict] = []
        self.ordinal = 0
        self.first_error: Exception | None = None

    def generate(self, prompt: str, response_model: type[BaseModel]) -> BaseModel:
        raise RuntimeError("This evaluator is async-only; use agenerate")

    async def agenerate(self, prompt: str, response_model: type[BaseModel]) -> BaseModel:
        # AnswerAccuracy catches errors internally and otherwise calls its
        # second judge after a failed first judge. Stop without another request.
        if self.first_error is not None:
            raise self.first_error
        self.ordinal += 1
        request_id = "ragas:" + digest([self.run_id, self.sample_id, self.metric, self.ordinal])
        payload = {
            "requestId": request_id,
            "sampleId": self.sample_id,
            "metric": self.metric,
            "messages": [{"role": "user", "content": prompt}],
            "schema": strict_schema(response_model.model_json_schema()),
            "schemaName": response_model.__name__,
        }
        if self.trace:
            self.trace({"event": "request", "sampleId": self.sample_id, "metric": self.metric, "payload": payload, "createdAt": now()})
        call = {"requestId": request_id, "schemaName": response_model.__name__}
        self.calls.append(call)
        try:
            body = await self.sender(payload) if self.sender else await asyncio.to_thread(post_bridge, self.url, self.token, payload, self.timeout)
            call.update({"attemptId": body["attemptId"], "model": body["model"], "rawText": body["text"]})
            if body["model"] != JUDGE_MODEL:
                raise BridgeError("Judge model differs from the frozen gpt-6.1-sol selection", body["attemptId"])
            result = response_model.model_validate_json(body["text"], strict=True)
            call["response"] = result.model_dump()
            # RAGAS asks for each original statement word-for-word, with a 0/1
            # verdict. Its schemas do not enforce correspondence or the range.
            # Reject malformed judge output instead of silently scoring it.
            if response_model.__name__ == "NLIStatementOutput":
                supplied = json.loads(prompt.rsplit("\ninput: ", 1)[1].rsplit("\nOutput:", 1)[0])["statements"]
                returned = result.model_dump()["statements"]
                if [item["statement"] for item in returned] != supplied:
                    raise ValueError("NLI output must preserve the complete input statement list in order")
                if any(type(item["verdict"]) is not int or item["verdict"] not in (0, 1) for item in returned):
                    raise ValueError("NLI verdicts must be integer 0 or 1")
            if response_model.__name__ == "AnswerAccuracyOutput":
                if type(result.rating) is not int or result.rating not in (0, 2, 4):
                    raise ValueError("AnswerAccuracy ratings must be integer 0, 2 or 4")
            call["status"] = "completed"
            return result
        except Exception as exc:
            self.first_error = exc
            if isinstance(exc, BridgeError) and exc.attempt_id:
                call["attemptId"] = exc.attempt_id
            call.update({"status": "error", "error": {"type": type(exc).__name__, "message": str(exc)}})
            raise
        finally:
            if self.trace:
                self.trace({"event": "response", "sampleId": self.sample_id, "metric": self.metric, **call, "createdAt": now()})


async def score_metric(sample: dict, metric: str, llm: BridgeLLM) -> dict:
    started = time.perf_counter()
    row = {"schemaVersion": 1, "id": sample["id"], "sampleId": sample["id"], "metric": metric, "status": "error", "score": None, "metadata": sample.get("metadata", {}), "createdAt": now()}
    fatal = False
    try:
        if metric == "faithfulness":
            result = await Faithfulness(llm=llm).ascore(user_input=sample["question"], response=sample["response"], retrieved_contexts=sample["contexts"])
        elif metric == "factual_correctness":
            result = await FactualCorrectness(llm=llm, **METRIC_CONFIG[metric]).ascore(response=sample["response"], reference=sample.get("reference", ""))
        elif metric == "answer_accuracy":
            result = await AnswerAccuracy(llm=llm, **METRIC_CONFIG[metric]).ascore(user_input=sample["question"], response=sample["response"], reference=sample.get("reference", ""))
            # The official class can silently return a one-judge score after
            # the other fails. Require the complete dual evaluation instead.
            if llm.first_error is not None:
                raise llm.first_error
            if len(llm.calls) != 2 or any(call.get("status") != "completed" for call in llm.calls):
                raise ValueError("AnswerAccuracy requires both official judge calls to succeed")
        else:
            raise ValueError("Unsupported metric")
        value = float(result.value)
        if not math.isfinite(value):
            row.update({"status": "unscorable", "error": {"type": "NonFiniteMetric", "message": "Official RAGAS metric returned a non-finite score"}})
        elif not 0 <= value <= 1:
            raise ValueError("Official RAGAS score is outside [0,1]")
        else:
            row.update({"status": "completed", "score": value})
    except Exception as exc:
        row["error"] = {"type": type(exc).__name__, "message": str(exc)}
        fatal = isinstance(exc, BridgeError)
    row.update({"attemptIds": list(dict.fromkeys(call["attemptId"] for call in llm.calls if call.get("attemptId"))), "calls": llm.calls, "elapsedMs": (time.perf_counter() - started) * 1000})
    return {"row": row, "fatal": fatal}


def append_jsonl(path: Path, value: dict) -> None:
    # Flushed per event; an interrupted metric reuses the bridge's request IDs.
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(value, ensure_ascii=False, allow_nan=False) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows = []
    for number, line in enumerate(path.read_text().splitlines(), 1):
        if line.strip():
            try:
                rows.append(json.loads(line))
            except ValueError as exc:
                raise ValueError(f"Invalid JSONL at {path.name}:{number}; repair the interrupted line explicitly before resuming") from exc
    return rows


def load_samples(path: Path) -> list[dict]:
    samples = read_jsonl(path)
    if not samples:
        raise ValueError("Input must contain at least one sample")
    ids = set()
    for sample in samples:
        sample_id = sample.get("id")
        if not isinstance(sample_id, str) or not 1 <= len(sample_id) <= 200 or sample_id in ids:
            raise ValueError("Sample IDs must be unique strings of 1–200 characters")
        ids.add(sample_id)
        for field in ("question", "response"):
            if not isinstance(sample.get(field), str):
                raise ValueError(f"Sample {sample_id}: {field} must be a string")
        if not isinstance(sample.get("contexts"), list) or any(not isinstance(item, str) for item in sample["contexts"]):
            raise ValueError(f"Sample {sample_id}: contexts must be a string array")
        if "reference" in sample and not isinstance(sample["reference"], str):
            raise ValueError(f"Sample {sample_id}: reference must be a string")
        metrics = sample.get("metrics")
        if not isinstance(metrics, list) or len(set(metrics)) != len(metrics) or any(item not in METRICS for item in metrics):
            raise ValueError(f"Sample {sample_id}: metrics must be distinct known metric names")
    return samples


def runtime_manifest(input_path: Path, run_id: str) -> dict:
    version = importlib.metadata.version("ragas")
    if version != RAGAS_VERSION:
        raise ValueError(f"Requires ragas=={RAGAS_VERSION}; found {version}")
    packages = {dist.metadata["Name"].lower(): dist.version for dist in importlib.metadata.distributions() if dist.metadata.get("Name")}
    return {
        "schemaVersion": 1, "runId": run_id, "judgeModel": JUDGE_MODEL,
        "ragasVersion": version, "pythonVersion": platform.python_version(),
        "packages": dict(sorted(packages.items())), "metricConfig": METRIC_CONFIG,
        "metricContracts": {"answer_accuracy": "Both official 0/2/4 judge ratings required; no retries, one-judge fallback, or modified prompts."},
        "inputSha256": hashlib.sha256(input_path.read_bytes()).hexdigest(),
        "runtimeSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "retries": 0, "telemetry": False,
    }


async def run(args: argparse.Namespace) -> dict:
    samples = load_samples(args.input)
    info = json.loads(args.bridge_info.read_text())
    if info.get("model") != JUDGE_MODEL or info.get("runId") != args.run_id:
        raise ValueError("Bridge model/runId differs from evaluation run")
    validate_bridge_url(info["url"])
    token_path = Path(info["tokenFile"])
    if token_path.stat().st_mode & 0o077:
        raise ValueError("Bridge token file must not be readable by group or other users")
    token = token_path.read_text().strip()
    if not token:
        raise ValueError("Bridge token is empty")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    lock_path = Path(str(args.output) + ".lock")
    lock_handle = lock_path.open("x")
    try:
        lock_handle.write(str(os.getpid()))
        lock_handle.close()
        manifest = runtime_manifest(args.input, args.run_id)
        manifest["concurrency"] = args.concurrency
        manifest["httpTimeoutSeconds"] = args.timeout
        manifest_path = Path(str(args.output) + ".manifest.json")
        if manifest_path.exists():
            if json.loads(manifest_path.read_text()) != manifest:
                raise ValueError("Resume rejected: inputs, metric configuration, code, or Python runtime changed")
        else:
            if args.output.exists():
                raise ValueError("Existing results have no runtime manifest")
            with manifest_path.open("x") as handle:
                json.dump(manifest, handle, indent=2)
                handle.write("\n")
        previous = read_jsonl(args.output)
        terminal = {(row["sampleId"], row["metric"]) for row in previous}
        expected = {(sample["id"], metric) for sample in samples for metric in sample["metrics"]}
        if len(terminal) != len(previous) or not terminal.issubset(expected) or any(row.get("status") not in ("completed", "error", "unscorable") for row in previous):
            raise ValueError("Result history contains duplicates or incompatible rows")
        trace_path = Path(str(args.output) + ".calls.jsonl")
        added = 0
        aborted = False
        queue = asyncio.Queue()
        for sample in samples:
            for metric in sample["metrics"]:
                if (sample["id"], metric) not in terminal:
                    queue.put_nowait((sample, metric))

        async def worker():
            nonlocal added, aborted
            while not aborted:
                try:
                    sample, metric = queue.get_nowait()
                except asyncio.QueueEmpty:
                    return
                llm = BridgeLLM(url=info["url"], token=token, run_id=args.run_id, sample_id=sample["id"], metric=metric, timeout=args.timeout, trace=lambda event: append_jsonl(trace_path, event))
                result = await score_metric(sample, metric, llm)
                append_jsonl(args.output, result["row"])
                added += 1
                print(json.dumps({key: result["row"][key] for key in ("sampleId", "metric", "status", "score")}), flush=True)
                if result["fatal"]:
                    aborted = True
                queue.task_done()

        await asyncio.gather(*(worker() for _ in range(args.concurrency)))
        all_rows = read_jsonl(args.output)
        counts = {status: sum(row["status"] == status for row in all_rows) for status in ("completed", "error", "unscorable")}
        return {"aborted": aborted, "previous": len(previous), "added": added, "remaining": len(expected) - len(previous) - added, "statusCounts": counts}
    finally:
        lock_path.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--bridge-info", type=Path, required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--timeout", type=float, default=600)
    parser.add_argument("--concurrency", type=int, default=2, choices=range(1, 5))
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error("timeout must be positive")
    try:
        result = asyncio.run(run(args))
        print(json.dumps({"summary": result}), flush=True)
        return 2 if result["aborted"] or result["statusCounts"]["error"] else 0
    except (ValueError, OSError, KeyError) as exc:
        print(json.dumps({"error": type(exc).__name__, "message": str(exc)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
