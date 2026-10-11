#!/usr/bin/env python3
"""Prepare an additive, question-aware official AnswerAccuracy evaluation.

No API calls, new references, or changes to the original evaluation are made.
Synthetic controls are technical checks, not labels for the research corpus.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path

METRIC = "answer_accuracy"
POLICY = "official-answer-accuracy-question-aware-v1"


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def jsonl(rows: list[dict]) -> bytes:
    return "".join(json.dumps(row, ensure_ascii=False, allow_nan=False) + "\n" for row in rows).encode()


def freeze(path: Path, content: bytes) -> None:
    if path.exists():
        if path.read_bytes() != content:
            raise ValueError(f"Frozen file differs: {path.name}; use a new version directory")
        return
    with path.open("xb") as handle:
        handle.write(content)


def select_samples(rows: list[dict], source_hash: str) -> tuple[list[dict], dict]:
    ids, selected, excluded = set(), [], Counter()
    for row in rows:
        source_id = row.get("id")
        if not isinstance(source_id, str) or not source_id or source_id in ids:
            raise ValueError("Original sample IDs must be unique nonempty strings")
        ids.add(source_id)
        meta = row.get("metadata", {})
        if meta.get("synthetic") or meta.get("control"):
            raise ValueError("Research input must not contain synthetic controls")
        if meta.get("unanswerable") is True:
            excluded["unanswerable_reference"] += 1
            continue
        if meta.get("unanswerable") is not False:
            raise ValueError("Original samples must declare answerability explicitly")
        if not isinstance(row.get("reference"), str) or not row["reference"].strip():
            excluded["missing_human_reference"] += 1
            continue
        if not isinstance(row.get("response"), str) or not row["response"].strip():
            excluded["empty_response"] += 1
            continue
        if not isinstance(row.get("question"), str) or not row["question"].strip():
            raise ValueError("Question-aware correctness requires the original question")
        if "factual_correctness" not in row.get("metrics", []):
            raise ValueError("Positive answer with reference was not eligible in the frozen original export")
        if meta.get("referencePolicy") != "frozen-first-human-answer":
            raise ValueError("Original reference policy must be frozen-first-human-answer")
        # Keep every answer (including explicit abstentions) with a positive
        # human reference. Never rewrite a terse Yes/No/entity reference.
        selected.append({**row, "id": "aa-v1:" + sha256(source_id.encode())[:24], "metrics": [METRIC],
                         "metadata": {**meta, "sourceSampleId": source_id, "sourceInputSha256": source_hash,
                                      "questionAwareCorrectnessPolicy": POLICY,
                                      "sourceNotApplicable": meta.get("notApplicable", {}), "notApplicable": {}}})
    return selected, dict(excluded)


def technical_controls(repeats: int = 3) -> list[dict]:
    if repeats < 1:
        raise ValueError("repeats must be positive")
    high, low, partial = (0.75, 1.0, "high"), (0.0, 0.25, "low"), (0.25, 0.75, "intermediate")
    question = "When did Vega Observatory open, and where is it located?"
    reference = "Vega Observatory opened in 2012 and is located in Oslo."
    cases = [
        ("short-yes-expanded", "Do the authors propose future extensions?", "Yes, the authors propose future extensions.", "Yes", high),
        ("short-no-expanded", "Does the method require labeled training data?", "No, the method does not require labeled training data.", "No", high),
        ("short-entity-expanded", "Which dataset is used in the experiment?", "The experiment uses KVRET.", "KVRET", high),
        ("short-yes-contradicted", "Do the authors propose future extensions?", "No, the authors do not propose future extensions.", "Yes", low),
        ("short-entity-wrong", "Which dataset is used in the experiment?", "The experiment uses MultiWOZ.", "KVRET", low),
        ("relevant-complete", question, "It began operating in 2012, in Oslo.", reference, high),
        ("relevant-partial", question, "Vega Observatory opened in 2012.", reference, partial),
        ("irrelevant-facts", question, "The article uses the KVRET dataset.", reference, low),
        ("contradicted-facts", question, "Vega Observatory opened in 2018 and is located in Bergen.", reference, low),
        ("shared-irrelevant-fact", question, "The fictional Vega Observatory opened in 2018. It is located in Bergen.", "The fictional Vega Observatory opened in 2012. It is located in Oslo.", low),
        ("abstention-positive-reference", question, "The available excerpts do not provide enough information to answer.", reference, low),
    ]
    output = []
    for name, query, response, gold, bounds in cases:
        for repeat in range(1, repeats + 1):
            output.append({"id": f"accuracy-controls-v1:{name}:repeat-{repeat}", "question": query, "response": response,
                           "contexts": [], "reference": gold, "metrics": [METRIC],
                           "metadata": {"cohort": "accuracy-technical-controls", "control": name,
                                        "questionId": f"accuracy-control:{name}", "repeat": repeat,
                                        "synthetic": True, "humanCalibration": False,
                                        "expected": {METRIC: {"min": bounds[0], "max": bounds[1], "direction": bounds[2]}}}})
    return output


def prepare(source: Path, directory: Path, repeats: int = 3) -> dict:
    raw = source.read_bytes()
    rows = [json.loads(line) for line in raw.decode().splitlines() if line.strip()]
    if not rows:
        raise ValueError("Research input is empty")
    source_hash = sha256(raw)
    selected, excluded = select_samples(rows, source_hash)
    controls = technical_controls(repeats)
    inputs, fixtures = jsonl(selected), jsonl(controls)
    manifest = {"schemaVersion": 1, "kind": POLICY, "sourceSha256": source_hash,
                "sourceRecords": len(rows), "researchRecords": len(selected), "excluded": excluded,
                "researchSha256": sha256(inputs), "controlsSha256": sha256(fixtures),
                "controlRecords": len(controls), "controlCases": len(controls) // repeats, "controlRepeats": repeats,
                "ragasVersion": "0.4.3", "metric": METRIC, "judgeModel": "gpt-6.1-sol",
                "metricConfig": {"max_retries": 1}, "expectedCallsPerMetric": 2,
                "maximumPlannedCalls": 2 * (len(selected) + len(controls)),
                "referencePolicy": "Unchanged first human answer from the frozen original export; no model-inferred gold.",
                "interpretation": "Question-conditioned answer/reference agreement. It does not validate extra claims against the document; Faithfulness, abstention, citations and human review remain separate. Technical controls are not human calibration.",
                "selection": "All original positive-reference nonempty answers, including explicit abstentions. Negative references excluded. No selection by metric scores.",
                "exporterSha256": sha256(Path(__file__).read_bytes())}
    directory.mkdir(parents=True, exist_ok=True)
    freeze(directory / "samples.jsonl", inputs)
    freeze(directory / "controls.jsonl", fixtures)
    freeze(directory / "input-manifest.json", (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode())
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--repeats", default=3, type=int)
    args = parser.parse_args()
    print(json.dumps(prepare(args.input, args.out_dir, args.repeats), ensure_ascii=False))


if __name__ == "__main__":
    main()
