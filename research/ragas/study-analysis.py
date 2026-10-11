#!/usr/bin/env python3
"""Offline document-macro analysis for scope-bound Faithfulness/AnswerAccuracy.

Scores remain conditional on applicability and successful judging. Missing,
failed and unscorable observations are never assigned a zero. No model calls.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
import random
import statistics
import subprocess

METRICS = ("faithfulness", "answer_accuracy")
METHODS = ("bm25", "openai-dense", "bge-m3", "hybrid", "hybrid-bge", "hybrid-jev", "jev-scan", "closed-book", "oracle")
POLICY = "ragas-faithfulness-answer-accuracy-explicit-authorship-v1"
REFERENCE_POLICIES = {"human_qasper": "frozen-first-human-answer", "human_book": "frozen-single-annotator-book-answer", "model_generated_book": "frozen-model-generated-book-answer"}


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def sample_hash(path: Path, node: str = "node") -> str:
    """Match research/util.ts exactly, including JavaScript numeric rendering/ICU keys."""
    program = """import{readFileSync}from'node:fs';import{createHash}from'node:crypto';
const stable=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(stable).join(',')+']':'{'+Object.entries(v).sort(([a],[b])=>a.localeCompare(b,'en')).map(([k,x])=>JSON.stringify(k)+':'+stable(x)).join(',')+'}';
const rows=readFileSync(process.argv[1],'utf8').split('\\n').filter(x=>x.trim()).map(JSON.parse);process.stdout.write(createHash('sha256').update(stable(rows)).digest('hex'));"""
    result = subprocess.run([node, "--input-type=module", "-e", program, str(path.resolve())], capture_output=True, text=True, check=False, timeout=60)
    if result.returncode or len(result.stdout.strip()) != 64:
        raise ValueError("Cannot verify the exporter JavaScript samplesHash")
    return result.stdout.strip()


def quantile(values: list[float], probability: float) -> float:
    ordered = sorted(values)
    position = (len(ordered) - 1) * probability
    lower = int(position)
    return ordered[lower] + (ordered[min(lower + 1, len(ordered) - 1)] - ordered[lower]) * (position - lower)


def document_macro(rows: list[tuple[str, float]]) -> tuple[float | None, dict[str, float]]:
    grouped = defaultdict(list)
    for document, value in rows:
        grouped[document].append(value)
    means = {document: statistics.mean(values) for document, values in sorted(grouped.items())}
    return (statistics.mean(means.values()) if means else None), means


def paired_bootstrap(rows: list[tuple[str, float]], iterations: int = 10000, seed: int = 42) -> dict:
    mean, documents = document_macro(rows)
    if not documents:
        return {"meanDifference": None, "ciLow": None, "ciHigh": None, "nDocuments": 0, "documentDifferences": [], "limitedDocumentSupport": True}
    values = list(documents.values())
    rng = random.Random(seed)
    draws = [statistics.mean(values[rng.randrange(len(values))] for _ in values) for _ in range(iterations)]
    return {"meanDifference": mean, "ciLow": quantile(draws, .025), "ciHigh": quantile(draws, .975), "nDocuments": len(values), "limitedDocumentSupport": len(values) < 2, "documentDifferences": [{"documentId": key, "difference": value} for key, value in documents.items()]}


def analyze_records(samples: list[dict], results: list[dict], export: dict, runtime: dict, *, scope: str, iterations: int = 10000, seed: int = 42) -> dict:
    if scope not in ("development", "test") or export.get("scope") != scope or export.get("policy") != POLICY:
        raise ValueError("Explicit scope differs from the frozen study export; a pilot cannot become test")
    if export.get("metrics") != list(METRICS) or export.get("ragasVersion") != "0.4.3" or export.get("judge") != {"model": "gpt-6.1-sol", "reasoningEffort": "medium"}:
        raise ValueError("Export metric/model protocol differs")
    if runtime.get("judgeModel") != "gpt-6.1-sol" or runtime.get("ragasVersion") != "0.4.3" or runtime.get("retries") != 0 or runtime.get("metricConfig", {}).get("faithfulness") != {} or runtime.get("metricConfig", {}).get("answer_accuracy") != {"max_retries": 1}:
        raise ValueError("Runtime does not declare the official fixed metric configuration")
    if not isinstance(runtime.get("runId"), str) or not runtime["runId"]:
        raise ValueError("Missing judge run ID")
    if not isinstance(iterations, int) or iterations < 1 or not isinstance(seed, int):
        raise ValueError("Invalid bootstrap configuration")
    experiments = export.get("provenance", [])
    if not experiments or len({p.get("experimentId") for p in experiments}) != len(experiments):
        raise ValueError("Missing or duplicated experiment provenance")
    for entry in experiments:
        if entry.get("scope") != scope or entry.get("phase") != ("test" if scope == "test" else "pilot"):
            raise ValueError("Experiment provenance crosses development/test scope")
        if not isinstance(entry.get("experimentId"), str) or not entry["experimentId"]:
            raise ValueError("Missing experiment identifier")

    def source(meta):
        matches = [p for p in experiments if str(meta.get("sourceRunId", "")).startswith(p["experimentId"] + ":")]
        if len(matches) != 1:
            raise ValueError("Cannot link sourceRunId to exactly one frozen experiment")
        return matches[0]

    allowed = ("qasper-test", "openstax-books") if scope == "test" else ("qasper-development", "openstax-development")
    by_id, row_experiment, unique_assignments, question_identity, source_runs = {}, {}, set(), {}, set()
    group_rows = defaultdict(list)
    expected_counts = Counter()
    sample_links = []
    for row in samples:
        sample_id, meta = row.get("id"), row.get("metadata", {})
        if not isinstance(sample_id, str) or not sample_id or sample_id in by_id:
            raise ValueError("Duplicate/invalid judge sample IDs")
        entry = source(meta)
        experiment_id = entry["experimentId"]
        corpus, method, negative = meta.get("corpus"), meta.get("method"), meta.get("unanswerable")
        if corpus not in allowed or meta.get("split") != scope or meta.get("scope") != scope or method not in METHODS or type(negative) is not bool or type(meta.get("abstained")) is not bool:
            raise ValueError("Sample corpus/split/method/answerability is inconsistent")
        if meta.get("datasetHash") != entry.get("datasetHash") or meta.get("retrievalImplementationHash") != entry.get("implementationHash"):
            raise ValueError("Sample dataset/implementation differs from frozen experiment provenance")
        if not meta.get("sourceRunId") or not meta.get("questionId") or not meta.get("documentId"):
            raise ValueError("Missing source/question/document linkage")
        if not isinstance(row.get("question"), str) or not row["question"].strip() or not isinstance(row.get("response"), str) or not isinstance(row.get("contexts"), list) or any(not isinstance(context, str) for context in row["contexts"]):
            raise ValueError("Malformed frozen question/response/contexts")
        kind = meta.get("referenceKind")
        if meta.get("referencePolicy") != REFERENCE_POLICIES.get(kind):
            raise ValueError("Unknown or mislabeled reference provenance")
        annotation = meta.get("referenceAnnotation")
        if corpus.startswith("qasper"):
            if kind != "human_qasper" or (annotation or {}).get("mode") == "model_generated":
                raise ValueError("QASPER reference cannot be relabeled from a model")
        elif kind == "human_book":
            if (annotation or {}).get("mode") != "single_annotator":
                raise ValueError("Human book reference lacks personal review provenance")
        elif kind == "model_generated_book":
            if (annotation or {}).get("mode") != "model_generated" or annotation.get("humanReviewed") is not False:
                raise ValueError("Model-generated reference must not claim human review")
        else:
            raise ValueError("Book reference must retain explicit human/model origin")
        if not negative and (not isinstance(row.get("reference"), str) or not row["reference"].strip()):
            # Missing positive references are permitted only when explicitly NA.
            if meta.get("notApplicable", {}).get("answer_accuracy") != "missing_frozen_reference":
                raise ValueError("Positive reference is missing without an explicit NA")
        requested = row.get("metrics")
        if not isinstance(requested, list) or len(set(requested)) != len(requested) or any(metric not in METRICS for metric in requested):
            raise ValueError("Only official Faithfulness and AnswerAccuracy may be requested")
        na = meta.get("notApplicable", {})
        if set(na) != set(METRICS) - set(requested) or any(not isinstance(reason, str) or not reason for reason in na.values()):
            raise ValueError("Every unrequested metric needs exactly one explicit NA reason")
        if "answer_accuracy" in requested and negative:
            raise ValueError("Unanswerable references cannot receive AnswerAccuracy")
        if "faithfulness" in requested and (meta["abstained"] or method == "closed-book" or not row.get("contexts") or not row.get("response", "").strip()):
            raise ValueError("Faithfulness requested outside its declared conditional population")
        assignment = experiment_id, meta["questionId"], method
        if assignment in unique_assignments:
            raise ValueError("Duplicate answer for the same experiment/question/method")
        if meta["sourceRunId"] in source_runs:
            raise ValueError("Duplicate source generation")
        source_runs.add(meta["sourceRunId"])
        unique_assignments.add(assignment)
        question_key = experiment_id, meta["questionId"]
        identity = (meta["documentId"], corpus, negative, row.get("question"), row.get("reference"), kind, meta["referencePolicy"])
        if question_key in question_identity and question_identity[question_key] != identity:
            raise ValueError("Paired methods do not share the same question/reference/document")
        question_identity[question_key] = identity
        by_id[sample_id], row_experiment[sample_id] = row, experiment_id
        for metric in METRICS:
            group_rows[(experiment_id, corpus, negative, method, metric)].append(row)
            expected_counts[metric] += metric in requested
        sample_links.append({"sampleId": sample_id, "sourceRunId": meta["sourceRunId"], "experimentId": experiment_id, "questionId": meta["questionId"], "documentId": meta["documentId"], "corpus": corpus, "split": scope, "datasetHash": meta["datasetHash"], "referenceKind": kind, "referencePolicy": meta["referencePolicy"]})
    if export.get("sampleCount") != len(samples) or export.get("requestedMetrics") != sum(expected_counts.values()) or export.get("metricCounts") != dict(expected_counts):
        raise ValueError("Export counts differ from the hashed samples")

    indexed, paid_attempts = {}, set()
    for result in results:
        sample_id, metric = result.get("sampleId", result.get("id")), result.get("metric")
        if sample_id not in by_id or metric not in by_id[sample_id]["metrics"]:
            raise ValueError("Result refers to an unknown sample or unrequested metric")
        if (sample_id, metric) in indexed:
            raise ValueError("Duplicate terminal sample/metric result")
        if result.get("metadata") != by_id[sample_id]["metadata"]:
            raise ValueError("Result metadata differs from its frozen source sample")
        status, score = result.get("status"), result.get("score")
        if status not in ("completed", "error", "unscorable"):
            raise ValueError("Invalid terminal metric status")
        if status == "completed":
            if isinstance(score, bool) or not isinstance(score, (float, int)) or not math.isfinite(score) or not 0 <= score <= 1:
                raise ValueError("Completed score must be finite in [0,1]")
        elif score is not None:
            raise ValueError("Failed/unscorable metric cannot contain a numeric score")
        for ordinal, call in enumerate(result.get("calls", []), 1):
            request_hash = sha256(json.dumps([runtime["runId"], sample_id, metric, ordinal], ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode())
            if call.get("requestId") != "ragas:" + request_hash:
                raise ValueError("Judge request does not belong to this runtime/sample/metric")
            attempt = call.get("attemptId")
            if attempt:
                if attempt in paid_attempts:
                    raise ValueError("Judge attempt reused across terminal metric calls")
                paid_attempts.add(attempt)
            if call.get("status") == "completed" and call.get("model") != runtime["judgeModel"]:
                raise ValueError("Result call model differs from the frozen judge")
        indexed[(sample_id, metric)] = result

    missing_generations = defaultdict(list)
    for missing in export.get("missing", []):
        entry = source(missing)
        if missing.get("split") != scope or type(missing.get("unanswerable")) is not bool or missing.get("corpus") not in allowed or missing.get("method") not in METHODS or not missing.get("documentId") or not missing.get("questionId") or not missing.get("reason"):
            raise ValueError("Missing-generation record lacks explicit scope/answerability")
        assignment = entry["experimentId"], missing["questionId"], missing["method"]
        if assignment in unique_assignments or missing["sourceRunId"] in source_runs:
            raise ValueError("Duplicate or already generated missing assignment")
        unique_assignments.add(assignment)
        source_runs.add(missing["sourceRunId"])
        key = entry["experimentId"], missing["corpus"], missing["unanswerable"], missing["method"]
        missing_generations[key].append(missing)
        for metric in METRICS:
            group_rows.setdefault((*key, metric), [])
    for entry in experiments:
        observed = sum(exp == entry["experimentId"] for exp, _, _ in unique_assignments)
        if entry.get("scheduledGenerations") != observed:
            raise ValueError("Successful and missing generations do not cover the frozen schedule")

    groups, score_maps, requested_maps = [], {}, {}
    for key, rows in sorted(group_rows.items()):
        experiment_id, corpus, negative, method, metric = key
        requested = [row for row in rows if metric in row["metrics"]]
        scored = [(row, indexed[(row["id"], metric)]["score"]) for row in requested if indexed.get((row["id"], metric), {}).get("status") == "completed"]
        mean, doc_means = document_macro([(row["metadata"]["documentId"], value) for row, value in scored])
        counts = Counter(indexed.get((row["id"], metric), {}).get("status", "pending") for row in requested)
        missing = missing_generations[key[:4]]
        groups.append({"experimentId": experiment_id, "corpus": corpus, "unanswerable": negative, "method": method, "metric": metric,
                       "nAnswers": len(rows), "nRequested": len(requested), "nScored": len(scored), "nNA": len(rows) - len(requested),
                       "nFailed": counts["error"], "nUnscorable": counts["unscorable"], "nPending": counts["pending"],
                       "nMissingGenerations": len(missing), "nOracleIneligible": sum(bool(m.get("oracleIneligible")) for m in missing),
                       "nSourceAssignments": len(rows) + len(missing), "nDocumentsScored": len(doc_means), "meanDocumentMacro": mean,
                       "naReasons": dict(Counter(row["metadata"]["notApplicable"][metric] for row in rows if metric not in row["metrics"])),
                       "referenceKinds": dict(Counter(row["metadata"]["referenceKind"] for row in rows)),
                       "conditionalPopulation": "nonabstaining nonempty answers with supplied context and successful scores" if metric == "faithfulness" else "positive-reference nonempty answers, including abstentions, with successful scores"})
        score_maps[key] = {row["metadata"]["questionId"]: (row["metadata"]["documentId"], value) for row, value in scored}
        requested_maps[key] = {row["metadata"]["questionId"] for row in requested}

    paired = []
    strata = sorted({key[:3] for key in group_rows})
    for stratum in strata:
        for metric in METRICS:
            method = "jev-scan"
            for baseline in ("openai-dense", "hybrid-bge"):
                key_a, key_b = (*stratum, method, metric), (*stratum, baseline, metric)
                if key_a not in score_maps or key_b not in score_maps:
                    continue
                left, right = score_maps[key_a], score_maps[key_b]
                common = sorted(set(left) & set(right))
                if any(left[q][0] != right[q][0] for q in common):
                    raise ValueError("Paired question has mismatched documents")
                differences = [(left[q][0], left[q][1] - right[q][1]) for q in common]
                paired.append({"experimentId": stratum[0], "corpus": stratum[1], "unanswerable": stratum[2], "metric": metric, "method": method, "baseline": baseline,
                               "nPairs": len(common), "nBothRequested": len(requested_maps[key_a] & requested_maps[key_b]),
                               "nMethodScored": len(left), "nBaselineScored": len(right), "nMethodScoredUnmatched": len(set(left) - set(right)), "nBaselineScoredUnmatched": len(set(right) - set(left)),
                               "questionIds": common, **paired_bootstrap(differences, iterations, seed),
                               "population": "Same experiment/question/document; both metrics completed. Faithfulness additionally conditions on applicability for both methods.",
                               "bootstrap": {"unit": "document", "iterations": iterations, "seed": seed, "interval": "percentile_95", "withinDocument": "mean of paired question differences", "acrossDocuments": "equal document weight"}})

    abstention = []
    for stratum in sorted({key[:4] for key in group_rows}):
        rows = group_rows[(*stratum, "faithfulness")]
        mean, docs = document_macro([(row["metadata"]["documentId"], float(row["metadata"]["abstained"])) for row in rows])
        abstained = sum(row["metadata"]["abstained"] for row in rows)
        abstention.append({"experimentId": stratum[0], "corpus": stratum[1], "unanswerable": stratum[2], "method": stratum[3], "nAnswers": len(rows), "nAbstained": abstained, "rateDocumentMacro": mean, "rateAnswerMicro": abstained / len(rows) if rows else None, "nDocuments": len(docs), "nMissingGenerations": len(missing_generations[stratum])})
    reference_counts = []
    for experiment_id, corpus, kind in sorted({(row_experiment[s["id"]], s["metadata"]["corpus"], s["metadata"]["referenceKind"]) for s in samples}):
        own = [s for s in samples if row_experiment[s["id"]] == experiment_id and s["metadata"]["corpus"] == corpus and s["metadata"]["referenceKind"] == kind]
        reference_counts.append({"experimentId": experiment_id, "corpus": corpus, "referenceKind": kind, "answers": len(own), "uniqueQuestions": len({s["metadata"]["questionId"] for s in own}), "uniqueDocuments": len({s["metadata"]["documentId"] for s in own})})
    provenance = {"experiments": [{**entry, "retrievalReportSha256": entry["reportSha256"]} for entry in experiments], "judgeRunId": runtime["runId"], "judgeModel": runtime["judgeModel"], "ragasVersion": runtime["ragasVersion"], "metricConfig": {metric: runtime["metricConfig"][metric] for metric in METRICS}, "amendmentSha256": export.get("amendmentSha256"), "datasetBookAnnotation": [{"experimentId": entry["experimentId"], "annotation": entry.get("bookAnnotation")} for entry in experiments if entry.get("bookAnnotation")]}
    if len(experiments) == 1:
        provenance.update({"experimentId": experiments[0]["experimentId"], "datasetHash": experiments[0]["datasetHash"], "retrievalReportSha256": experiments[0]["reportSha256"]})
    status_counts = Counter(result["status"] for result in results)
    return {"schemaVersion": 1, "kind": "ragas-study-analysis", "scope": scope, "aggregation": "document_macro", "metrics": list(METRICS),
            "provenance": provenance, "groups": groups, "paired": paired, "abstention": abstention, "referenceCounts": reference_counts, "sampleLinks": sample_links,
            "accounting": {"answers": len(samples), "requestedMetrics": sum(expected_counts.values()), "terminalMetrics": len(results), "completed": status_counts["completed"], "failed": status_counts["error"], "unscorable": status_counts["unscorable"], "pending": sum(expected_counts.values()) - len(results), "notApplicable": len(samples) * len(METRICS) - sum(expected_counts.values()), "missingGenerations": len(export.get("missing", []))},
            "limitations": ["Faithfulness is conditional on a nonabstaining answer with supplied evidence; each method can have a different applicable population. Overall means are not a matched comparison.", "Paired differences use only common successfully scored questions within the same experiment/document; failures, NA and unscorable outcomes are excluded and counted explicitly, never assigned zero.", "Documents, not questions or generated answers, receive equal weight and are bootstrap units. Few books imply limited precision; the intervals are exploratory and unadjusted for multiple comparisons.", "Human QASPER, personally reviewed human book answers and AI-generated book references remain explicitly identified. An automatic judge does not convert model references into human gold.", "Abstention rates describe generated answers with known outcomes, stratified by answerability; missing generations remain a separate denominator.", "This analysis verifies sample/result provenance and metric settings; the separate ledger audit establishes costs and API attempt accounting."]}


def analyze_files(*, samples: Path, results: Path, export_manifest: Path, runtime_manifest: Path, scope: str, runtime_source: Path | None = None, node: str = "node", iterations: int = 10000, seed: int = 42) -> dict:
    exported, runtime = json.loads(export_manifest.read_text()), json.loads(runtime_manifest.read_text())
    raw_hash = sha256(samples.read_bytes())
    if raw_hash != exported.get("samplesSha256") or raw_hash != runtime.get("inputSha256"):
        raise ValueError("Input bytes differ from frozen exporter/runtime hashes")
    if sample_hash(samples, node) != exported.get("samplesHash"):
        raise ValueError("Exporter samplesHash mismatch")
    source = runtime_source or samples.parent / "source-snapshot" / "ragas" / "runtime.py"
    source_verified = source.exists()
    if runtime_source and not source_verified:
        raise ValueError("Requested runtime source is missing")
    if source_verified and sha256(source.read_bytes()) != runtime.get("runtimeSha256"):
        raise ValueError("Runtime source hash mismatch")
    report = analyze_records(read_jsonl(samples), read_jsonl(results), exported, runtime, scope=scope, iterations=iterations, seed=seed)
    report["integrity"] = {"samplesSha256": raw_hash, "samplesHash": exported["samplesHash"], "runtimeInputHashVerified": True, "exportManifestSha256": sha256(export_manifest.read_bytes()), "runtimeManifestSha256": sha256(runtime_manifest.read_bytes()), "resultsSha256": sha256(results.read_bytes()), "runtimeSourceHash": runtime.get("runtimeSha256"), "runtimeSourceVerified": source_verified, "analysisSourceSha256": sha256(Path(__file__).read_bytes())}
    if not source_verified:
        report["limitations"].append("Executed Python runtime source is recorded by hash but not supplied locally for byte comparison.")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=Path, required=True)
    parser.add_argument("--results", type=Path, required=True)
    parser.add_argument("--export-manifest", type=Path, required=True)
    parser.add_argument("--runtime-manifest", type=Path, required=True)
    parser.add_argument("--runtime-source", type=Path)
    parser.add_argument("--scope", choices=("dev", "development", "test"), required=True)
    parser.add_argument("--node", default="node")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    report = analyze_files(samples=args.samples, results=args.results, export_manifest=args.export_manifest, runtime_manifest=args.runtime_manifest, runtime_source=args.runtime_source, scope="development" if args.scope == "dev" else args.scope, node=args.node)
    if args.out.resolve() in {p.resolve() for p in (args.samples, args.results, args.export_manifest, args.runtime_manifest)}:
        raise ValueError("Analysis output must not overwrite input artifacts")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2) + "\n")
    print(json.dumps({"output": str(args.out), "scope": report["scope"], "groups": len(report["groups"]), "pairs": len(report["paired"]), "accounting": report["accounting"]}))


if __name__ == "__main__":
    main()
