#!/usr/bin/env python3
"""Descriptive phrase-overlap audit; no scores, model calls or automatic exclusions."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import statistics


def words(text):
    return re.findall(r"\w+(?:['’]\w+)?", text.casefold(), flags=re.UNICODE)


def longest_shared(left, right):
    previous = [0] * (len(right) + 1)
    best, end = 0, 0
    for i, word in enumerate(left):
        current = [0] * (len(right) + 1)
        for j, other in enumerate(right):
            if word == other:
                current[j + 1] = previous[j] + 1
                if current[j + 1] > best:
                    best, end = current[j + 1], i + 1
        previous = current
    return best, " ".join(left[end - best:end])


def audit(paths):
    rows, sources = [], []
    for path in paths:
        raw = path.read_bytes()
        bundle = json.loads(raw)
        sources.append({"path": str(path), "sha256": hashlib.sha256(raw).hexdigest(), "freezeHash": bundle["freeze"]["hash"]})
        docmap = {document["id"]: document for document in bundle["freeze"]["documents"]}
        source_map = {source["documentId"]: source for source in bundle["sources"]}
        normalized = {key: " " + " ".join(words("\n\n".join(block["text"] for block in document["blocks"]))) + " " for key, document in docmap.items()}
        for q in bundle["freeze"]["questions"]:
            tokens = words(q["question"])
            matches = [longest_shared(tokens, words(span["quote"])) for evidence_set in q["evidenceSets"] for span in evidence_set]
            length, phrase = max(matches, default=(0, ""), key=lambda match: match[0])
            exact = " " + " ".join(tokens) + " " in normalized[q["documentId"]]
            rows.append({"questionId": q["id"], "documentId": q["documentId"], "split": source_map[q["documentId"]]["split"],
                         "origin": "model_generated" if q.get("annotation", {}).get("mode") == "model_generated" else "human",
                         "questionWords": len(tokens), "longestSharedPhraseWords": length, "longestSharedPhrase": phrase,
                         "completeNormalizedQuestionFoundInBook": exact,
                         "completeQuestionAtLeast10WordsFound": exact and len(tokens) >= 10})
    groups = []
    for origin in ("model_generated", "human"):
        for split in ("development", "test"):
            own = [row for row in rows if row["origin"] == origin and row["split"] == split]
            if not own:
                continue
            groups.append({"origin": origin, "split": split, "questions": len(own),
                           "medianLongestSharedWords": statistics.median(row["longestSharedPhraseWords"] for row in own),
                           "maximumLongestSharedWords": max(row["longestSharedPhraseWords"] for row in own),
                           "fullQuestionMatches": sum(row["completeNormalizedQuestionFoundInBook"] for row in own),
                           "matchesOfAtLeast10Words": sum(row["completeQuestionAtLeast10WordsFound"] for row in own)})
    return {"schemaVersion": 1, "kind": "descriptive-paraphrase-audit", "sources": sources,
            "policy": "Unicode casefolded word tokens; apostrophes retained inside words; punctuation/hyphens separate tokens; no stemming or stop-word removal. Longest exact contiguous match is computed separately for each evidence quotation, never across quotation boundaries. Whole-question matching uses the entire canonical source. No case is changed or excluded by this descriptive audit.",
            "interpretation": "Phrase overlap describes wording only. Necessary technical terms can be shared. Low overlap does not establish semantic novelty, independent authorship or absence of model training contamination.",
            "counts": dict(Counter(row["origin"] for row in rows)), "groups": groups, "cases": rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = audit(args.bundle)
    result["scriptSha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output.exists():
        if args.output.read_text() != text:
            raise ValueError("Audit differs; select a new output path")
    else:
        args.output.write_text(text)
    print(json.dumps({"output": str(args.output), "counts": result["counts"], "groups": result["groups"]}))


if __name__ == "__main__":
    main()
