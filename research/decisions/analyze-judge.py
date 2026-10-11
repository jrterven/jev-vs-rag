#!/usr/bin/env python3
"""Offline, paired Decisions extension analysis; no APIs or changes to old results."""
from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("original_study_analysis", ROOT / "research/ragas/study-analysis.py")
BASE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BASE)
ORIGINAL_METHODS = BASE.METHODS
NEW_METHODS = ("hybrid-decisions", "decisions-scan")
# Extend only this imported module's in-memory allowlist. The original source is immutable.
BASE.METHODS = (*ORIGINAL_METHODS, *NEW_METHODS)
BASELINES = ("openai-dense", "hybrid-bge", "hybrid-jev", "jev-scan")
ORIGINAL_ID = "gb10-main-study-20261004-v1"
EXTENSION_ID = "decisions-extension-20261007-v1:v2:main"
RUNTIME_SHA = "d497d7fa6ad46348d1cf92ba0788c08dd8c2ddf7fd2b24e25c2b7e1c2d998a5b"
ORIGINAL_FILES = {
    "samples.jsonl": "a9f834fb5fffccb76378fe1f910cd354b613ada5174a93a77702aa6022c870dc",
    "study.results.jsonl": "1ded1c16c8fd3948ea904b3fa40dd122dd69bc37c222c9ddbe5d1317eb511009",
    "study.results.jsonl.manifest.json": "933d9e18fd94ff41d7c869533bbb221ef6857e4820cb8306f0313890b11aba81",
    "export-manifest.json": "b8d2b230108c2e8e0d37ede6a50bab7c823513bb740bcea55a4735b924c12e0b",
}


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        h = hashlib.sha256()
        for part in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(part)
        return h.hexdigest()


def canonical(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def compare_records(old_samples, old_results, old_export, old_runtime,
                    new_samples, new_results, new_export, new_runtime, *, iterations=10000, seed=42):
    """Validate each cohort, then pair questions across their separate executions."""
    reports = [BASE.analyze_records(s, r, e, m, scope="test", iterations=iterations, seed=seed)
               for s, r, e, m in ((old_samples, old_results, old_export, old_runtime),
                                 (new_samples, new_results, new_export, new_runtime))]
    if any(report["accounting"]["pending"] for report in reports):
        raise ValueError("Judge cohort still has pending metrics")
    if len(old_export["provenance"]) != 1 or len(new_export["provenance"]) != 1:
        raise ValueError("Exactly one original and one extension experiment are required")
    if old_export["provenance"][0]["experimentId"] == new_export["provenance"][0]["experimentId"]:
        raise ValueError("The extension must have a distinct experiment identity")
    if old_runtime["runId"] == new_runtime["runId"]:
        raise ValueError("The extension must have a distinct judge identity")
    if old_export["provenance"][0]["datasetHash"] != new_export["provenance"][0]["datasetHash"]:
        raise ValueError("Extension dataset differs from the original")
    all_calls = [call["attemptId"] for result in old_results + new_results
                 for call in result.get("calls", []) if call.get("attemptId")]
    if len(set(all_calls)) != len(all_calls):
        raise ValueError("Paid judge attempts reused across cohorts")
    if {s["id"] for s in old_samples} & {s["id"] for s in new_samples}:
        raise ValueError("Judge sample IDs reused across cohorts")

    identities, assignments = {}, defaultdict(set)
    for label, samples, exported, allowed in (("original", old_samples, old_export, ORIGINAL_METHODS),
                                              ("extension", new_samples, new_export, NEW_METHODS)):
        for row in samples:
            meta, qid = row["metadata"], row["metadata"]["questionId"]
            if meta["method"] not in allowed:
                raise ValueError("Method assigned to the wrong cohort")
            identity = canonical({key: meta.get(key) for key in
                                  ("documentId", "corpus", "unanswerable", "datasetHash", "split", "scope",
                                   "referenceKind", "referencePolicy", "referenceAnnotation")}
                                 | {"question": row["question"], "reference": row.get("reference")})
            if qid in identities and identities[qid] != identity:
                raise ValueError("Cross-cohort question/reference/document/authorship mismatch")
            identities[qid] = identity
            assignments[(label, meta["method"])].add(qid)
        for missing in exported.get("missing", []):
            if missing["method"] not in allowed:
                raise ValueError("Missing generation assigned to the wrong cohort")
            assignments[(label, missing["method"])].add(missing["questionId"])
    question_sets = list(assignments.values())
    if not question_sets or any(q != question_sets[0] for q in question_sets):
        raise ValueError("Generation assignments do not cover exactly the same questions")
    for exported in (old_export, new_export):
        for missing in exported.get("missing", []):
            if missing["questionId"] not in identities:
                raise ValueError("Missing generation has no independently frozen question identity")
            identity = json.loads(identities[missing["questionId"]])
            if any(identity[key] != missing[key] for key in ("documentId", "corpus", "unanswerable", "split")):
                raise ValueError("Missing generation has a mismatched document/corpus/answerability")

    indexed = {(r.get("sampleId", r.get("id")), r["metric"]): r for r in old_results + new_results}
    grouped_rows = defaultdict(list)
    for row in old_samples + new_samples:
        m = row["metadata"]
        grouped_rows[(m["corpus"], m["unanswerable"], m["method"])].append(row)
    group_intervals = []
    for key, rows in sorted(grouped_rows.items()):
        for metric in BASE.METRICS:
            scores = [(r["metadata"]["documentId"], indexed[(r["id"], metric)]["score"]) for r in rows
                      if indexed.get((r["id"], metric), {}).get("status") == "completed"]
            ci = BASE.paired_bootstrap(scores, iterations, seed)
            group_intervals.append({"corpus": key[0], "unanswerable": key[1], "method": key[2], "metric": metric,
                                    "meanDocumentMacro": ci["meanDifference"], "ciLow": ci["ciLow"], "ciHigh": ci["ciHigh"],
                                    "nScored": len(scores), "nDocuments": ci["nDocuments"],
                                    "limitedDocumentSupport": ci["limitedDocumentSupport"]})

    paired = []
    contrasts = [(method, baseline) for method in NEW_METHODS for baseline in BASELINES]
    contrasts.append(("decisions-scan", "hybrid-decisions"))
    strata = sorted({(json.loads(v)["corpus"], json.loads(v)["unanswerable"]) for v in identities.values()})
    for corpus, negative in strata:
        for method, baseline in contrasts:
            available_methods = {name for _, name in assignments}
            if method not in available_methods or baseline not in available_methods:
                continue
            for metric in BASE.METRICS:
                maps, requested = [], []
                for name in (method, baseline):
                    rows = grouped_rows[(corpus, negative, name)]
                    requested.append({r["metadata"]["questionId"] for r in rows if metric in r["metrics"]})
                    maps.append({r["metadata"]["questionId"]: indexed[(r["id"], metric)]["score"] for r in rows
                                 if indexed.get((r["id"], metric), {}).get("status") == "completed"})
                left, right = maps
                common = sorted(left.keys() & right.keys())
                differences = [(json.loads(identities[q])["documentId"], left[q] - right[q]) for q in common]
                paired.append({"corpus": corpus, "unanswerable": negative, "metric": metric,
                               "method": method, "baseline": baseline, "nPairs": len(common),
                               "nBothRequested": len(requested[0] & requested[1]),
                               "nMethodScored": len(left), "nBaselineScored": len(right),
                               "nMethodScoredUnmatched": len(left.keys() - right.keys()),
                               "nBaselineScoredUnmatched": len(right.keys() - left.keys()), "questionIds": common,
                               **BASE.paired_bootstrap(differences, iterations, seed)})
    return {"schemaVersion": 1, "kind": "decisions-extension-ragas-comparison", "scope": "test",
            "original": reports[0], "extension": reports[1], "groupIntervals": group_intervals, "paired": paired,
            "sharedGenerationQuestions": sorted(question_sets[0]),
            "bootstrap": {"unit": "document", "iterations": iterations, "seed": seed, "interval": "percentile_95",
                          "withinDocument": "mean of paired question differences", "acrossDocuments": "equal document weight"},
            "limitations": [
                "This is an extension designed after the original results, not a preregistered contemporary comparison.",
                "The judge model is an alias invoked on different dates. Shared prompts, references and questions do not rule out provider drift.",
                "Pairs require both scores to be completed; failures, NA and unscorable scores remain explicit and are never zero-filled.",
                "Faithfulness additionally conditions on both methods supplying a nonabstaining answer with context. Applicability can differ by method.",
                "Bootstrap intervals are exploratory and unadjusted for multiple comparisons; eight test books limit precision.",
                "Book reference authorship is unchanged. Automated judging does not provide independent human validation.",
                "This file checks metric/sample provenance. A separate ledger audit must bind scores to paid attempts and establish spending.",
            ]}


def read_cohort(directory, node):
    # Exact-byte checks, original hashObject semantics and frozen runtime checks.
    report = BASE.analyze_files(samples=directory / "samples.jsonl", results=directory / "study.results.jsonl",
                                export_manifest=directory / "export-manifest.json",
                                runtime_manifest=directory / "study.results.jsonl.manifest.json", scope="test",
                                runtime_source=ROOT / "research/ragas/runtime.py", node=node)
    return (BASE.read_jsonl(directory / "samples.jsonl"), BASE.read_jsonl(directory / "study.results.jsonl"),
            json.loads((directory / "export-manifest.json").read_text()),
            json.loads((directory / "study.results.jsonl.manifest.json").read_text()), report["integrity"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--original", type=Path, required=True)
    parser.add_argument("--extension", type=Path, required=True)
    parser.add_argument("--node", default="node")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    for name, sha in ORIGINAL_FILES.items():
        if digest(args.original / name) != sha:
            raise ValueError("Closed original artifact changed: " + name)
    if digest(ROOT / "research/ragas/runtime.py") != RUNTIME_SHA:
        raise ValueError("Original scientific runtime changed")
    freeze = json.loads((args.extension / "extension-judge-freeze.json").read_text())
    for name, sha in freeze["files"].items():
        if digest(ROOT / name) != sha:
            raise ValueError("Executed extension source changed: " + name)
    if digest(args.extension / "samples.jsonl") != freeze["sampleSha256"]:
        raise ValueError("Extension samples differ from the judge freeze")
    completed = json.loads((args.extension / "completion.json").read_text())
    if completed.get("allMetricsTerminal") is not True or completed["terminal"] != completed["expected"]:
        raise ValueError("Extension judge is not complete")
    old, new = read_cohort(args.original, args.node), read_cohort(args.extension, args.node)
    if old[2]["provenance"][0]["experimentId"] != ORIGINAL_ID or new[2]["provenance"][0]["experimentId"] != EXTENSION_ID:
        raise ValueError("Unexpected frozen experiment")
    if new[3]["runId"] != freeze["runId"] or old[3]["runtimeSha256"] != new[3]["runtimeSha256"]:
        raise ValueError("Scientific runtime/judge identity changed")
    if old[2]["provenance"][0]["scheduledGenerations"] != 1800 or new[2]["provenance"][0]["scheduledGenerations"] != 400:
        raise ValueError("Unexpected frozen generation counts")
    report = compare_records(*old[:4], *new[:4])
    if len(report["sharedGenerationQuestions"]) != 200:
        raise ValueError("Expected the original 200 generation questions")
    report["integrity"] = {"original": old[4], "extension": new[4], "originalFiles": ORIGINAL_FILES,
                           "comparisonSourceSha256": digest(Path(__file__)),
                           "freezeSha256": digest(args.extension / "extension-judge-freeze.json")}
    # Scientific inputs and original artifacts are never overwritten.
    if args.out.resolve() == args.original.resolve() or args.original.resolve() in args.out.resolve().parents:
        raise ValueError("Output must not be inside the closed original cohort")
    protected = {p.resolve() for p in args.extension.rglob("*") if p.is_file()}
    if args.out.resolve() in protected:
        raise ValueError("Output already exists; preserve artifacts and choose a new analysis path")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("x") as stream:
        json.dump(report, stream, ensure_ascii=False, allow_nan=False, indent=2)
        stream.write("\n")
    print(json.dumps({"out": str(args.out), "questions": len(report["sharedGenerationQuestions"]),
                      "extension": report["extension"]["accounting"], "pairedComparisons": len(report["paired"])}))


if __name__ == "__main__":
    main()
