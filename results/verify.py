"""Verify distributed numerical results without raw datasets or API calls."""
import csv
from decimal import Decimal
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def load(name):
    return json.loads((ROOT / name).read_text(encoding="utf-8"))


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    manifest = load("manifest.json")
    require(manifest["kind"] == "research-result-distribution", "Unexpected manifest")
    expected = set(manifest["files"]) | {"manifest.json"}
    actual = {str(p.relative_to(ROOT)) for p in ROOT.rglob("*")
              if p.is_file() and "__pycache__" not in p.parts}
    require(actual == expected, "Distribution file inventory differs")
    for name, record in manifest["files"].items():
        path = ROOT / name
        require(not Path(name).is_absolute() and ".." not in Path(name).parts
                and not path.is_symlink(), "Unsafe result path")
        require(digest(path) == record["sha256"]
                and path.stat().st_size == record["bytes"], "File changed: " + name)
    provenance = load("provenance.json")
    for record in provenance["artifacts"]:
        require(digest(ROOT / record["path"]) == record["sha256"],
                "Source-artifact hash differs: " + record["path"])

    original = load("original/measurements.json")
    decisions = load("decisions/retrieval.json")
    clef = load("clef/measurements.json")
    rows = {}
    for row in original["report"]["methods"]:
        rows[row["corpus"], row["id"]] = (row["coverage"], row["coverageLow"], row["coverageHigh"], "original")
    for row in decisions["methods"]:
        if row["id"] in ("hybrid-decisions", "decisions-scan"):
            rows[row["corpus"], row["id"]] = (row["coverage"], row["coverageLow"], row["coverageHigh"], "decisions")
    for row in clef["quality"]:
        if row["method"] in ("hybrid-clef", "clef-scan"):
            rows[row["corpus"], row["method"]] = (row["mean"], row["low"], row["high"], "clef")
    with (ROOT / "retrieval.csv").open(newline="", encoding="utf-8") as handle:
        csv_rows = list(csv.DictReader(handle))
    require(len(rows) == len(csv_rows) == 22, "Expected 11 methods in two corpora")
    seen = set()
    for row in csv_rows:
        key = row["corpus"], row["method"]
        require(key not in seen, "Duplicate coverage row")
        seen.add(key)
        values = tuple(float(row[k]) for k in ("coverage", "confidence_lower", "confidence_upper"))
        require((*values, row["experiment"]) == rows[key], "Coverage summary differs")
        require(0 <= values[1] <= values[0] <= values[2] <= 1, "Invalid coverage interval")

    for name, answers, scored, failed in (
        ("original/answer-metrics.json", 1794, 2869, 5),
        ("decisions/answers.json", 392, 674, 2),
        ("clef/measurements.json", 400, 690, 4),
    ):
        a = load(name)["accounting"]
        require(a["answers"] == answers and a["completed"] == scored
                and a["failed"] == failed and a["pending"] == 0
                and a["requestedMetrics"] == scored + failed, "Answer accounting differs")
    for name, cap in (("global", "200"), ("cumulativeJudge", "80"),
                      ("extension", "100"), ("newJudge", "20")):
        cost = clef["costs"][name]
        require(Decimal(cost["knownUsd"]) + Decimal(cost["reservedUsd"])
                == Decimal(cost["committedUsd"]) <= Decimal(cap), "Cost accounting differs")
    print(json.dumps({"verified": True, "files": len(manifest["files"]),
                      "coverageRows": len(rows), "experiments": 3}))


if __name__ == "__main__":
    main()
