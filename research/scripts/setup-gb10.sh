#!/usr/bin/env bash
# Run from the repository on Ubuntu ARM64. Installs only inside this checkout.
set -euo pipefail
test "$(uname -m)" = aarch64 || { echo 'This setup requires Linux ARM64.' >&2; exit 1; }
test -f research/python/requirements.txt || { echo 'Run from the repository root.' >&2; exit 1; }
umask 077
mkdir -p .runtime/downloads data/research/environment
python3 - <<'PY'
import hashlib, pathlib, urllib.request
version = 'v24.21.0'
name = f'node-{version}-linux-arm64.tar.xz'
base = f'https://nodejs.org/dist/{version}/'
directory = pathlib.Path('.runtime/downloads')
checksums = urllib.request.urlopen(base + 'SHASUMS256.txt', timeout=60).read().decode()
expected = next(line.split()[0] for line in checksums.splitlines() if line.split()[-1] == name)
path = directory / name
if not path.exists():
    urllib.request.urlretrieve(base + name, path)
if hashlib.file_digest(path.open('rb'), 'sha256').hexdigest() != expected:
    raise SystemExit('Node archive checksum mismatch; remove the invalid archive before retrying.')
(directory / 'SHASUMS256.txt').write_text(checksums)
print('Verified Node', version, expected, flush=True)
PY
if ! test -x .runtime/node-v24.21.0-linux-arm64/bin/node; then
  tar -xJf .runtime/downloads/node-v24.21.0-linux-arm64.tar.xz -C .runtime
fi
export PATH="$PWD/.runtime/node-v24.21.0-linux-arm64/bin:$PATH"
node --version
npm ci --no-audit --no-fund
if ! test -x research/.venv/bin/python; then
  python3 -m venv research/.venv
fi
research/.venv/bin/python -m pip install 'torch==2.9.1+cu130' --index-url https://download.pytorch.org/whl/cu130
research/.venv/bin/python -m pip install -r research/python/requirements.txt
research/.venv/bin/python -m pip check
research/.venv/bin/python -m pip freeze > data/research/environment/pip-freeze.txt
node --version > data/research/environment/node-version.txt
# This inspection does not initialize CUDA or load models onto the occupied GPU.
research/.venv/bin/python - <<'PY'
import importlib.metadata, json, platform, torch
from pathlib import Path
result = {'python': platform.python_version(), 'architecture': platform.machine(),
          'torch': torch.__version__, 'cudaBuild': torch.version.cuda,
          'packages': {name: importlib.metadata.version(name) for name in
                       ('transformers', 'numpy', 'huggingface-hub', 'snowballstemmer')},
          'gpuExecutionVerified': False}
Path('data/research/environment/runtime.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
PY
echo 'Environment installed. GPU execution still requires an idle-device check.'
