#!/usr/bin/env python3
"""Descriptive, cohort-separated RAGAS analysis and actual human-rating agreement."""
import argparse
from collections import Counter, defaultdict
from itertools import combinations
import json
import math
from pathlib import Path
import statistics

from calibration import METRICS, fingerprint, read_jsonl


def discovered_metrics(rows):
    found = set()
    for row in rows:
        found.update(row.get("metrics", []))
        found.update(row.get("metadata", {}).get("notApplicable", {}))
        found.update(row.get("metadata", {}).get("expected", {}))
    order = (*METRICS, "answer_accuracy")
    return sorted(found or set(METRICS), key=lambda value: (order.index(value) if value in order else len(order), value))


def read_results(path):
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def result_index(rows, results):
    sources = {row["id"]: row for row in rows}
    if len(sources) != len(rows):
        raise ValueError("Duplicate input IDs")
    indexed = {}
    for result in results:
        sample_id, metric = result.get("sampleId", result.get("id")), result.get("metric")
        if sample_id not in sources or metric not in sources[sample_id].get("metrics", []):
            raise ValueError("Result has unknown sample or unrequested metric")
        key = (sample_id, metric)
        if key in indexed:
            raise ValueError("Duplicate terminal sample/metric result")
        if result.get("status") not in ("completed", "error", "unscorable"):
            raise ValueError("Unknown result status")
        score = result.get("score")
        if result["status"] == "completed" and (isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score) or not 0 <= score <= 1):
            raise ValueError("Completed metric requires a finite score in [0,1]")
        if result["status"] != "completed" and score is not None:
            raise ValueError("Failed/unscorable metric must not carry a numeric score")
        indexed[key] = result
    return indexed


def summary_stats(values):
    return {"n": len(values), "mean": statistics.mean(values) if values else None,
            "min": min(values) if values else None, "max": max(values) if values else None,
            "sd": statistics.stdev(values) if len(values) > 1 else None}


def stratum(row):
    meta = row.get("metadata", {})
    return meta.get("cohort", "unspecified"), meta.get("method", "unspecified"), bool(meta.get("unanswerable", False))


def question_id(row):
    return row.get("metadata", {}).get("questionId") or fingerprint(row["question"])


def analyze(rows, results):
    indexed = result_index(rows, results)
    metric_names = discovered_metrics(rows)
    groups = defaultdict(list)
    cohort_questions = defaultdict(set)
    for row in rows:
        groups[stratum(row)].append(row)
        cohort_questions[question_id(row)].add(stratum(row)[0])
    output = []
    for (cohort, method, unanswerable), members in sorted(groups.items()):
        questions = {question_id(row) for row in members}
        metrics = {}
        for metric in metric_names:
            counts = Counter({name: 0 for name in ("requested", "scored", "error", "unscorable", "missing", "notApplicable")})
            reasons, by_question = Counter(), defaultdict(list)
            failures = []
            for row in members:
                if metric not in row.get("metrics", []):
                    counts["notApplicable"] += 1
                    reason = row.get("metadata", {}).get("notApplicable", {}).get(metric, "metric not requested")
                    reasons[str(reason)] += 1
                    continue
                counts["requested"] += 1
                result = indexed.get((row["id"], metric))
                if result is None:
                    counts["missing"] += 1
                elif result["status"] == "completed":
                    counts["scored"] += 1
                    by_question[question_id(row)].append(result["score"])
                else:
                    counts[result["status"]] += 1
                    failures.append({"id": row["id"], "status": result["status"], "error": result.get("error")})
            # Repeats of a question contribute a single mean inside a method/cohort.
            means = [statistics.mean(values) for values in by_question.values()]
            metrics[metric] = {**counts, "notApplicableReasons": dict(reasons), "scoredQuestions": len(means),
                               "questionWeighted": summary_stats(means), "failures": failures}
        output.append({"cohort": cohort, "method": method, "unanswerable": unanswerable, "records": len(members),
                       "uniqueQuestions": len(questions), "repeatedQuestionRecords": len(members) - len(questions), "metrics": metrics})
    technical = technical_summary(rows, indexed)
    return {"schemaVersion": 1, "kind": "descriptive-automated-metrics", "inputRecords": len(rows),
            "uniqueQuestionsOverall": len(cohort_questions),
            "terminalMetricResults": len(indexed), "cohorts": dict(Counter(stratum(row)[0] for row in rows)),
            "questionsAppearingInMultipleCohorts": sum(len(cohorts) > 1 for cohorts in cohort_questions.values()),
            "policy": "No pooled score across cohorts or methods. Within each cohort/method/unanswerable stratum, repeated answers for the same question are averaged before the descriptive mean. Missing, failed, unscorable and not-applicable scores are excluded, never zero-filled. Technical synthetic controls are not human calibration. No significance or independent-sample confidence claims.",
            "groups": output, "technicalControls": technical}


def technical_summary(rows, indexed):
    grouped = defaultdict(list)
    for row in rows:
        meta = row.get("metadata", {})
        if meta.get("control"):
            grouped[meta["control"]].append(row)
    controls = []
    for control, members in sorted(grouped.items()):
        metrics = {}
        for metric in discovered_metrics(members):
            observations, expected_checks = [], []
            for row in members:
                result = indexed.get((row["id"], metric))
                expectation = row["metadata"]["expected"][metric]
                score = result["score"] if result and result["status"] == "completed" else None
                if score is not None:
                    observations.append(score)
                expected_checks.append({"id": row["id"], "repeat": row["metadata"].get("repeat"), "score": score,
                                        "expected": expectation, "withinExpectedRange": expectation["min"] <= score <= expectation["max"] if score is not None else None})
            stats = summary_stats(observations)
            spread = stats["max"] - stats["min"] if observations else None
            metrics[metric] = {"plannedRepeats": len(members), **stats, "range": spread,
                               "allRepeatsScored": len(observations) == len(members),
                               "allExpectedRangesPassed": all(check["withinExpectedRange"] is True for check in expected_checks),
                               "stabilityRangeAtMost025": spread <= 0.25 if len(observations) == len(members) and len(members) > 1 else None,
                               "repeats": expected_checks}
        controls.append({"control": control, "metrics": metrics})
    return {"kind": "synthetic-technical-controls", "humanCalibration": False, "controls": controls,
            "interpretation": "Ranges and the 0.25 repeat-spread diagnostic were specified before evaluation. Passing checks supports technical behavior only; it does not establish agreement with human judgments or scientific validity."}


def pearson(pairs):
    if len(pairs) < 3:
        return None
    left, right = zip(*pairs)
    ml, mr = statistics.mean(left), statistics.mean(right)
    numerator = sum((x - ml) * (y - mr) for x, y in pairs)
    denominator = math.sqrt(sum((x - ml) ** 2 for x in left) * sum((y - mr) ** 2 for y in right))
    return numerator / denominator if denominator else None


def link_accuracy(rows, accuracy_rows, accuracy_results):
    """One-to-one join to unchanged original samples; no question/reference rewriting."""
    sources = {row["id"]: row for row in rows}
    indexed = result_index(accuracy_rows, accuracy_results)
    linked = {}
    for row in accuracy_rows:
        source_id = row.get("metadata", {}).get("sourceSampleId")
        if source_id not in sources or source_id in linked:
            raise ValueError("AnswerAccuracy requires a unique known sourceSampleId")
        source = sources[source_id]
        if source.get("metadata", {}).get("unanswerable") is not False or not source.get("reference"):
            raise ValueError("AnswerAccuracy requires an answerable original sample with a reference")
        if any(row.get(key) != source.get(key) for key in ("question", "response", "contexts", "reference")):
            raise ValueError("AnswerAccuracy source content differs from original sample")
        if any(row.get("metadata", {}).get(key) != source.get("metadata", {}).get(key) for key in ("cohort", "method", "questionId", "documentId", "unanswerable")):
            raise ValueError("AnswerAccuracy source metadata differs from original sample")
        if row.get("metrics") != ["answer_accuracy"] or row.get("metadata", {}).get("synthetic"):
            raise ValueError("AnswerAccuracy join accepts research samples only")
        linked[source_id] = indexed.get((row["id"], "answer_accuracy"))
    return linked


def agreement(rows, results, mapping, ratings, accuracy_rows=None, accuracy_results=None):
    indexed = result_index(rows, results)
    accuracy = link_accuracy(rows, accuracy_rows, accuracy_results or []) if accuracy_rows is not None else None
    if mapping.get("inputHash") != fingerprint(rows):
        raise ValueError("Human mapping does not match these input records")
    by_item = {item["itemId"]: item for item in mapping["items"]}
    sources = {row["id"]: row for row in rows}
    if len(by_item) != len(mapping["items"]) or any(item["sourceId"] not in sources for item in by_item.values()):
        raise ValueError("Invalid human mapping")
    actual = defaultdict(list)
    seen, counters = set(), Counter({"submittedRows": len(ratings), "blankRows": 0, "incidentRows": 0, "filledRatings": 0, "notApplicableRatings": 0})
    for rating in ratings:
        item_id = rating.get("itemId")
        if item_id not in by_item:
            raise ValueError("Unknown blind item ID")
        item = by_item[item_id]
        if rating.get("contentHash") != item["contentHash"]:
            raise ValueError("Human rating content hash mismatch")
        if "question" in rating:
            content = {key: rating[key] for key in ("question", "response", "contexts", "reference") if key in rating}
            if fingerprint(content) != item["contentHash"]:
                raise ValueError("Human packet content was modified")
        values = rating.get("ratings", {})
        if any(key not in METRICS for key in values):
            raise ValueError("Unknown human metric")
        if all(value is None for value in values.values()):
            counters["blankRows"] += 1
            continue
        rater = rating.get("raterId", "").strip()
        if not rater:
            raise ValueError("Completed ratings require an actual raterId")
        if (item_id, rater) in seen:
            raise ValueError("Duplicate rater/item rating")
        seen.add((item_id, rater))
        for metric, value in values.items():
            if value is not None and value != "not_applicable" and (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1):
                raise ValueError("Human rating must be null, not_applicable, or a number in [0,1]")
        if rating.get("issue", "").strip():
            counters["incidentRows"] += 1
            continue
        for metric, value in values.items():
            if value == "not_applicable":
                counters["notApplicableRatings"] += 1
            elif value is not None:
                counters["filledRatings"] += 1
                actual[(item["sourceId"], metric)].append((rater, value))
    grouped = defaultdict(lambda: {"auto": defaultdict(list), "human": defaultdict(list), "answers": 0, "ratings": 0, "pairs": 0, "unpaired": 0})
    cohort_groups = defaultdict(lambda: {"errors": defaultdict(list), "answers": 0, "ratings": 0, "pairedAnswers": 0})
    for (source_id, metric), values in actual.items():
        source = sources[source_id]
        group = grouped[(*stratum(source), metric)]
        cohort, _, unanswerable = stratum(source)
        cohort_group = cohort_groups[(cohort, unanswerable, metric)]
        qid = question_id(source)
        group["answers"] += 1
        group["ratings"] += len(values)
        cohort_group["answers"] += 1
        cohort_group["ratings"] += len(values)
        result = accuracy.get(source_id) if accuracy is not None and metric == "factual_correctness" else indexed.get((source_id, metric))
        if result and result["status"] == "completed":
            group["auto"][qid].append((statistics.mean(value for _, value in values), result["score"]))
            cohort_group["errors"][qid].append(abs(statistics.mean(value for _, value in values) - result["score"]))
            cohort_group["pairedAnswers"] += 1
        else:
            group["unpaired"] += 1
        for (_, left), (_, right) in combinations(values, 2):
            group["human"][qid].append(abs(left - right))
            group["pairs"] += 1
    summaries = []
    for (cohort, method, unanswerable, metric), group in sorted(grouped.items()):
        pairs = [(statistics.mean(x for x, _ in pairs), statistics.mean(y for _, y in pairs)) for pairs in group["auto"].values()]
        human_errors = [statistics.mean(values) for values in group["human"].values()]
        summaries.append({"cohort": cohort, "method": method, "unanswerable": unanswerable, "metric": metric,
                          "humanRatingField": metric, "automatedMetric": "answer_accuracy" if accuracy is not None and metric == "factual_correctness" else metric,
                          "humanRatings": group["ratings"], "ratedAnswers": group["answers"], "answersWithoutAutomatedScore": group["unpaired"],
                          "humanVsAutomated": {"pairedQuestions": len(pairs), "meanAbsoluteError": statistics.mean(abs(a - b) for a, b in pairs) if pairs else None, "pearson": pearson(pairs)},
                          "humanVsHuman": {"raterPairs": group["pairs"], "pairedQuestions": len(human_errors), "questionWeightedMeanAbsoluteDifference": statistics.mean(human_errors) if human_errors else None}})
    cohort_summaries = []
    for (cohort, unanswerable, metric), group in sorted(cohort_groups.items()):
        errors = [statistics.mean(values) for values in group["errors"].values()]
        cohort_summaries.append({"cohort": cohort, "unanswerable": unanswerable, "humanRatingField": metric,
                                 "automatedMetric": "answer_accuracy" if accuracy is not None and metric == "factual_correctness" else metric,
                                 "ratedAnswers": group["answers"], "humanRatings": group["ratings"], "pairedAnswers": group["pairedAnswers"], "pairedQuestions": len(errors),
                                 "questionBalancedMeanAbsoluteError": statistics.mean(errors) if errors else None})
    return {"schemaVersion": 1, "kind": "actual-human-agreement", "packetItems": len(by_item), **counters,
            "hasActualHumanRatings": bool(actual), "groups": summaries,
            "cohortAgreement": cohort_summaries,
            "cohortAgreementPolicy": "Descriptive cross-method agreement only: first average raters for an answer, then absolute answer-level error, then average errors within each question, then average questions. Answers/methods sharing a question are not independent; no confidence intervals or significance claims.",
            "policy": "Only explicit filled numeric judgments from named raters contribute. Blank, not-applicable and incident ratings are excluded. No synthetic or inferred human labels. Metrics and cohorts remain separate; repeated question pairs are averaged. Human rubric is a scalar judgment, not RAGAS claim decomposition. Correlation is descriptive, null for fewer than three questions or zero variance."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for command in ("summarize", "human"):
        child = sub.add_parser(command)
        child.add_argument("--input", required=True)
        child.add_argument("--results", required=True)
        child.add_argument("--output", required=True)
        if command == "human":
            child.add_argument("--mapping", required=True)
            child.add_argument("--ratings", required=True)
            child.add_argument("--accuracy-samples")
            child.add_argument("--accuracy-results")
    args = parser.parse_args()
    rows, results = read_jsonl(args.input), read_results(args.results)
    if args.command == "summarize":
        value = analyze(rows, results)
    else:
        if bool(args.accuracy_samples) != bool(args.accuracy_results):
            parser.error("Both --accuracy-samples and --accuracy-results are required together")
        ratings = [json.loads(line) for line in Path(args.ratings).read_text().splitlines() if line.strip()]
        value = agreement(rows, results, json.loads(Path(args.mapping).read_text()), ratings,
                          read_jsonl(args.accuracy_samples) if args.accuracy_samples else None,
                          read_results(args.accuracy_results) if args.accuracy_results else None)
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n")
    print(json.dumps({"output": str(out), "kind": value["kind"]}))


if __name__ == "__main__":
    main()
