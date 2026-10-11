#!/usr/bin/env python3
"""Read-only held-out RAGAS progress; never calls providers or repairs files."""
import argparse
from collections import Counter
from contextlib import closing
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import json
import math
import os
from pathlib import Path
import sqlite3
import sys

METRICS = ("faithfulness", "answer_accuracy")
TERMINAL = ("completed", "error", "unscorable")


class StatusError(ValueError):
    """Only messages defined in this helper may be emitted to the operator."""


def require(condition, message):
    if not condition:
        raise StatusError(message)


def json_file(path):
    return json.loads(path.read_bytes())


def jsonl(data, allow_partial=False):
    """Keep all complete rows; distinguish an interrupted last write from corruption."""
    rows, partial = [], {"state": "none", "bytes": 0}
    lines = data.splitlines(keepends=True)
    for index, line in enumerate(lines):
        terminated = line.endswith(b"\n")
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except (ValueError, UnicodeDecodeError):
            if allow_partial and index == len(lines) - 1 and not terminated:
                partial = {"state": "incomplete", "bytes": len(line)}
                continue
            raise StatusError("Malformed complete JSONL row") from None
        require(isinstance(row, dict), "JSONL row is not an object")
        rows.append(row)
        if not terminated:
            partial = {"state": "valid_without_newline", "bytes": len(line)}
    return rows, partial


def inputs(phase):
    sample_path, all_path = phase / "samples.jsonl", phase / "all-inputs.jsonl"
    require(sample_path.is_file() or all_path.is_file(), "Frozen inputs are missing")
    data = (sample_path if sample_path.is_file() else all_path).read_bytes()
    if sample_path.is_file() and all_path.is_file():
        require(data == all_path.read_bytes(), "Frozen input files differ")
    rows, _ = jsonl(data)
    ids, expected, na = set(), set(), Counter()
    for row in rows:
        sample_id, metrics = row.get("id"), row.get("metrics")
        require(isinstance(sample_id, str) and sample_id and sample_id not in ids, "Invalid or duplicate input ID")
        require(isinstance(metrics, list) and all(isinstance(m, str) and m in METRICS for m in metrics)
                and len(set(metrics)) == len(metrics), "Invalid or duplicate input metric")
        excluded = row.get("metadata", {}).get("notApplicable", {})
        require(isinstance(excluded, dict) and set(excluded) == set(METRICS) - set(metrics)
                and all(isinstance(reason, str) and reason for reason in excluded.values()), "Unrequested metric lacks explicit NA reason")
        ids.add(sample_id)
        expected.update((sample_id, metric) for metric in metrics)
        na.update(excluded.keys())
    exported = json_file(phase / "export-manifest.json") if (phase / "export-manifest.json").exists() else None
    if exported:
        require(exported.get("sampleCount") == len(rows)
                and exported.get("requestedMetrics") == len(expected)
                and exported.get("metricCounts") == {m: sum(metric == m for _, metric in expected) for m in METRICS}, "Export metric counts differ from inputs")
        require(exported.get("samplesSha256") == hashlib.sha256(data).hexdigest(), "Export input hash differs")
    return len(rows), expected, na, len(exported.get("missing", [])) if exported else None


def result_status(phase, expected, na):
    path = phase / "study.results.jsonl"
    rows, trailing = jsonl(path.read_bytes(), allow_partial=True) if path.exists() else ([], {"state": "none", "bytes": 0})
    seen, counts = set(), Counter()
    for row in rows:
        key = row.get("sampleId"), row.get("metric")
        require(all(isinstance(value, str) for value in key) and key in expected, "Foreign sample or unrequested result metric")
        require(key not in seen, "Duplicate terminal metric result")
        status, score = row.get("status"), row.get("score")
        require(status in TERMINAL, "Invalid terminal metric status")
        if status == "completed":
            require(type(score) in (int, float) and math.isfinite(score) and 0 <= score <= 1, "Invalid completed metric score")
        else:
            require(score is None, "Unscored metric contains a score")
        seen.add(key)
        counts[key[1], status] += 1
    return {metric: {"expected": sum(m == metric for _, m in expected), "notApplicable": na[metric],
                     **{status: counts[metric, status] for status in TERMINAL},
                     "missing": sum(m == metric for _, m in expected - seen)} for metric in METRICS}, trailing


def run_identity(phase):
    identities = []
    for relative in ("study.results.jsonl.manifest.json", "launch-snapshot.json", "preflight.json", "bridge/bridge-config.json"):
        path = phase / relative
        if path.exists():
            run_id = json_file(path).get("runId")
            require(isinstance(run_id, str) and 0 < len(run_id) <= 200, "Invalid run identity")
            identities.append(run_id)
    require(len(set(identities)) <= 1, "Run identities differ")
    return identities[0] if identities else phase.name


def budgets(ledger, run_id):
    prefix = run_id + ":"
    with closing(sqlite3.connect(ledger.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        # Return only billing fields; do not deserialize prompts, answers or usage.
        grouped = db.execute("""SELECT json_extract(value,'$.costUsd') AS cost,
            json_extract(value,'$.reservedUsd') AS reserve, json_extract(value,'$.status') AS status,
            substr(json_extract(value,'$.runId'),1,?)=? AS own, COUNT(*) AS n
            FROM attempts GROUP BY cost,reserve,status,own""", (len(prefix), prefix)).fetchall()
        latest = db.execute("""SELECT MAX(COALESCE(json_extract(value,'$.finishedAt'),json_extract(value,'$.startedAt')))
            FROM attempts WHERE substr(json_extract(value,'$.runId'),1,?)=?""", (len(prefix), prefix)).fetchone()[0]

    def total(only_own):
        known, unknown, pending, states = Decimal(0), Decimal(0), Decimal(0), Counter()
        for cost, reserve, status, own, n in grouped:
            if only_own and not own:
                continue
            require(status in ("completed", "failed", "unknown", "pending"), "Invalid attempt status")
            require(isinstance(reserve, str) and (cost is None or isinstance(cost, str)), "Cost and reservation must use decimal strings")
            amount, held = Decimal(cost if cost is not None else reserve), Decimal(reserve)
            require(amount.is_finite() and amount >= 0 and held.is_finite() and held >= 0, "Invalid cost or reservation")
            if cost is None:
                require(status in ("unknown", "pending"), "Missing cost without unknown or pending status")
                if status == "unknown":
                    unknown += amount * n
                else:
                    pending += amount * n
            else:
                require(status in ("completed", "failed"), "Known cost has unfinished status")
                known += amount * n
            states[status] += n
        return {"knownUsd": format(known, "f"), "unknownReservedUsd": format(unknown, "f"),
                "pendingReservedUsd": format(pending, "f"), "statuses": dict(sorted(states.items()))}
    return total(True), total(False), latest


def process_status(phase, name):
    path = phase / (name + ".pid")
    if not path.exists():
        return {"pid": None, "pidExists": None}
    raw = path.read_text().strip()
    require(raw.isdigit() and int(raw) > 1, "Invalid process PID")
    pid = int(raw)
    try:
        os.kill(pid, 0)  # Existence only: a recycled PID does not prove process identity.
        alive = True
    except ProcessLookupError:
        alive = False
    except PermissionError:
        alive = True
    return {"pid": pid, "pidExists": alive}


def summarize(phase, ledger):
    sample_count, expected, na, missing_generation = inputs(phase)
    metrics, trailing = result_status(phase, expected, na)
    run_id = run_identity(phase)
    scoped, global_budget, latest_attempt = budgets(ledger, run_id)
    progress_paths = [phase / p for p in ("study.results.jsonl", "study.results.jsonl.calls.jsonl", "runtime.exit-code")]
    timestamps = [p.stat().st_mtime for p in progress_paths if p.exists()]
    if latest_attempt:
        timestamps.append(datetime.fromisoformat(latest_attempt.replace("Z", "+00:00")).timestamp())
    exit_path = phase / "runtime.exit-code"
    exit_code = None
    if exit_path.exists():
        raw = exit_path.read_text().strip()
        require(raw.isdigit() and 0 <= int(raw) <= 255, "Invalid runtime exit code")
        exit_code = int(raw)
    return {"schemaVersion": 1, "runId": run_id, "sampleCount": sample_count,
            "missingGenerations": missing_generation, "metrics": metrics, "trailingResultLine": trailing,
            "latestProgressAt": datetime.fromtimestamp(max(timestamps), timezone.utc).isoformat() if timestamps else None,
            "processes": {name: process_status(phase, name) for name in ("runtime", "bridge")},
            "runtimeExitCode": exit_code, "scopedBudget": scoped, "globalBudget": global_budget}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase", type=Path, required=True)
    parser.add_argument("--ledger", type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(summarize(args.phase, args.ledger), ensure_ascii=False, separators=(",", ":")))
    except Exception as error:
        # Error messages from JSON/SQLite/OS can include raw file contents or values.
        message = str(error) if type(error) is StatusError else type(error).__name__
        print(json.dumps({"error": message}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
