#!/usr/bin/env bash
# From the GB10 checkout: --check is free; --run explicitly enables provider calls.
set -euo pipefail
mode="${1:---check}"
case "$mode" in --check|--run) ;; *) echo 'Usage: bash research/scripts/run-gb10-smoke.sh [--check|--run]' >&2; exit 2 ;; esac
test -f research/cli.ts || { echo 'Run from the repository root.' >&2; exit 1; }
export PATH="$PWD/.runtime/node-v24.21.0-linux-arm64/bin:$PATH"
export OMP_NUM_THREADS=4
export TOKENIZERS_PARALLELISM=false
export CUBLAS_WORKSPACE_CONFIG=:4096:8
plan=research/data/gb10-smoke-plan
test -s "$plan/config.json" && test -s "$plan/dataset.bundle.json"
node --version
research/.venv/bin/python research/python/download_models.py \
  --config "$plan/config.json" --cache-dir research/.cache/huggingface/hub --offline-check
# No CUDA initialization and no API request before this guard. The runner checks again.
if ! processes=$(nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader); then
  echo 'Cannot verify GPU availability; stopping.' >&2
  exit 1
fi
if test -n "$processes"; then
  printf 'GPU occupied; no experiment started:\n%s\n' "$processes" >&2
  exit 75
fi
if test "$mode" = --check; then
  echo 'Environment, model cache and idle GPU checked. No API calls made.'
  exit 0
fi
node --input-type=module -e '
import "dotenv/config";
const missing = ["OPENAI_API_KEY", "TYPESAFE_API_KEY"].filter(name => !process.env[name]);
if (missing.length) { console.error("Missing runner secrets: " + missing.join(", ")); process.exit(1); }
'
export HF_HUB_OFFLINE=1
exec node --import tsx research/cli.ts pilot \
  --datasets "$plan/dataset.bundle.json" --config "$plan/config.json" \
  --id gb10-technical-smoke-v1 --out data/research/gb10-technical-smoke-v1 \
  --budget-file data/research/study-budget.sqlite --allow-paid
