#!/usr/bin/env python3
"""Read-only progress and budget summary; optionally create a consistent backup."""
import argparse
from collections import Counter
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import sqlite3


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ledger", type=Path, required=True)
    parser.add_argument("--experiment-dir", type=Path, required=True)
    parser.add_argument("--backup", type=Path)
    args = parser.parse_args()
    manifest = json.loads((args.experiment_dir / "manifest.json").read_text())
    experiment = manifest["id"]
    source = sqlite3.connect(args.ledger.resolve().as_uri() + "?mode=ro", uri=True)
    source.execute("PRAGMA query_only=ON")
    source.execute("BEGIN")  # One coherent read snapshot while the runner can keep writing WAL.
    prefix = experiment + ":"
    # Do not load run values: they contain large rankings and hierarchical traces.
    statuses = dict(source.execute("SELECT status,COUNT(*) FROM runs WHERE substr(id,1,?)=? GROUP BY status", (len(prefix), prefix)))
    preparations = source.execute("SELECT COUNT(*) FROM immutable WHERE substr(key,1,?)=?", (len(experiment + ":preparation:"), experiment + ":preparation:")).fetchone()[0]
    generations = source.execute("""SELECT
        COALESCE(SUM(json_type(value,'$.generation') IS NOT NULL),0),
        COALESCE(SUM(json_type(value,'$.generationError') IS NOT NULL),0)
        FROM immutable WHERE substr(key,1,?)=? AND key LIKE '%:generation-result'""", (len(prefix), prefix)).fetchone()
    # SQL only returns minimal grouped billing fields. Decimal arithmetic stays
    # in Python; SQLite SUM would introduce floating-point errors for USD.
    attempts = source.execute("""SELECT
        json_extract(value,'$.costUsd') AS cost,
        json_extract(value,'$.reservedUsd') AS reserve,
        json_extract(value,'$.status') AS status,
        substr(json_extract(value,'$.runId'),1,?)=? AS own,
        COUNT(*) AS n
        FROM attempts GROUP BY cost,reserve,status,own""", (len(prefix), prefix)).fetchall()
    def budget(only_own=False):
        observed, reserved, states = Decimal(0), Decimal(0), Counter()
        for cost, reserve, status, own, count in attempts:
            if only_own and not own:
                continue
            if cost is None:
                reserved += Decimal(reserve) * count
            else:
                observed += Decimal(cost) * count
            states[status] += count
        return {"observedUsd": str(observed), "reservedUsd": str(reserved), "statuses": dict(states)}
    output = {"experiment": experiment, "phase": manifest["phase"], "preparedDocuments": preparations,
              "scheduledRuns": len(manifest["schedule"]), "runStatuses": statuses,
              "scheduledGenerations": sum(row["generate"] for row in manifest["schedule"]),
              "generationCompleted": generations[0], "generationFailedOrUnavailable": generations[1],
              "experimentBudget": budget(True), "globalBudget": budget(),
              "reportReady": (args.experiment_dir / "report.json").exists()}
    if args.backup:
        if args.backup.exists():
            raise ValueError("Backup path exists; use a new snapshot name")
        args.backup.parent.mkdir(parents=True, exist_ok=True)
        destination = sqlite3.connect(args.backup)
        try:
            source.backup(destination)
            if destination.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("Backup integrity failure")
        finally:
            destination.close()
        args.backup.chmod(0o600)
        output["backup"] = str(args.backup)
        output["backupSha256"] = hashlib.sha256(args.backup.read_bytes()).hexdigest()
    source.close()
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
