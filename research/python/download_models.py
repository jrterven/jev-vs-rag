#!/usr/bin/env python3
"""Download pinned Hugging Face model files without importing a model runtime.

Only huggingface_hub.list_repo_files/snapshot_download access the Hub. This script
never imports torch/transformers, initializes CUDA, or deserializes model weights.
config.local.modelCacheDir must match this cache when configured. The manifest also
records HF_HUB_CACHE for standalone tools that use the environment default.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from datetime import datetime, timezone


MANIFEST_NAME = "models-manifest.json"
TOKENIZER_FILES = {
    "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json",
    "added_tokens.json", "vocab.json", "vocab.txt", "merges.txt",
    "sentencepiece.bpe.model", "sentencepiece.model", "spiece.model", "tokenizer.model",
}
TOKENIZER_DATA = TOKENIZER_FILES - {
    "tokenizer_config.json", "special_tokens_map.json", "added_tokens.json", "merges.txt",
}


def http_session():
    """Bound Hub API requests that otherwise pass timeout=None (e.g. listing)."""
    import requests

    class TimeoutSession(requests.Session):
        def request(self, method, url, **kwargs):
            if kwargs.get("timeout") is None:
                kwargs["timeout"] = (10, 60)  # Connection / inactivity while reading, seconds.
            return super().request(method, url, **kwargs)

    return TimeoutSession()


def model_specs(config):
    models = config.get("models") if isinstance(config, dict) else None
    if not isinstance(models, dict):
        raise ValueError("Config must contain models")
    specs = []
    for kind, key in (("dense", "bge"), ("reranker", "reranker")):
        repo, revision = models.get(key), models.get(key + "Revision")
        if (not isinstance(repo, str) or len(repo) > 193
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*", repo)
                or any(part.endswith((".", "-", ".git")) or ".." in part or "--" in part
                       for part in repo.split("/"))):
            raise ValueError("Invalid Hugging Face model ID for " + key)
        if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40}", revision):
            raise ValueError(key + "Revision must be a pinned lowercase 40-character commit")
        specs.append({"kind": kind, "repoId": repo, "revision": revision})
    return specs


def selection(repo_files):
    """Select only root-level Transformers weights and tokenizer/config files."""
    files = set(repo_files)
    if "config.json" not in files or not files.intersection(TOKENIZER_DATA):
        raise ValueError("Model repository lacks config.json or tokenizer data")
    metadata = sorted({"config.json"} | files.intersection(TOKENIZER_FILES))
    for weights, format_name, is_index in (
        ("model.safetensors", "safetensors", False),
        ("model.safetensors.index.json", "safetensors", True),
        ("pytorch_model.bin", "pytorch", False),
        ("pytorch_model.bin.index.json", "pytorch", True),
    ):
        if weights in files:
            return metadata + [weights], format_name, weights if is_index else None
    raise ValueError("No supported Transformers safetensors or PyTorch weights")


def snapshot_path(cache, spec):
    return cache / ("models--" + spec["repoId"].replace("/", "--")) / "snapshots" / spec["revision"]


def project_cache(config, cache):
    cache = Path(cache).expanduser().resolve()
    local = config.get("local", {})
    if not isinstance(local, dict):
        raise ValueError("Config local must be an object")
    if "modelCacheDir" in local:
        configured = local["modelCacheDir"]
        if (not isinstance(configured, str) or not configured.strip()
                or Path(configured).expanduser().resolve() != cache):
            raise ValueError("--cache-dir must match config.local.modelCacheDir used by the worker")
    return cache


def checked_snapshot(raw_path, cache, spec):
    actual, expected = Path(raw_path).resolve(), snapshot_path(cache, spec)
    if actual != expected or not actual.is_dir():
        raise ValueError("Snapshot path does not match the pinned repository and commit")
    return actual


def checked_file(snapshot, name, cache):
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+", name) or name in (".", ".."):
        raise ValueError("Invalid model file path")
    path = snapshot / name
    if not path.is_file() or not path.resolve().is_relative_to(cache):
        raise ValueError("Missing model file or file outside project cache: " + name)
    return path


def shards(snapshot, index_name, format_name, available, cache):
    index = json.loads(checked_file(snapshot, index_name, cache).read_text(encoding="utf-8"))
    weight_map = index.get("weight_map") if isinstance(index, dict) else None
    if not isinstance(weight_map, dict) or not weight_map:
        raise ValueError("Weight index has no weight_map")
    names = set()
    pattern = (r"model-\d+-of-\d+\.safetensors" if format_name == "safetensors"
               else r"pytorch_model-\d+-of-\d+\.bin")
    for name in weight_map.values():
        if not isinstance(name, str) or not re.fullmatch(pattern, name) or name not in available:
            raise ValueError("Weight index references an absent or unsupported shard")
        names.add(name)
    return sorted(names)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def describe_files(snapshot, names, cache):
    result = []
    for name in sorted(names):
        path = checked_file(snapshot, name, cache)
        result.append({"name": name, "path": path.relative_to(cache).as_posix(),
                       "size": path.stat().st_size, "sha256": sha256(path)})
    return result


def download(config, cache, hub):
    specs = model_specs(config)
    cache = project_cache(config, cache)
    cache.mkdir(parents=True, exist_ok=True)
    records = []
    for spec in specs:
        print("Downloading " + spec["repoId"] + " @ " + spec["revision"], file=sys.stderr)
        available = set(hub.list_repo_files(repo_id=spec["repoId"], revision=spec["revision"], repo_type="model"))
        names, format_name, index_name = selection(available)
        options = {"repo_id": spec["repoId"], "revision": spec["revision"], "repo_type": "model",
                   "cache_dir": str(cache), "allow_patterns": names, "local_files_only": False}
        snapshot = checked_snapshot(hub.snapshot_download(**options), cache, spec)
        if index_name:
            names = sorted(set(names) | set(shards(snapshot, index_name, format_name, available, cache)))
            options["allow_patterns"] = names
            snapshot = checked_snapshot(hub.snapshot_download(**options), cache, spec)
        records.append({**spec, "format": format_name, "snapshotPath": snapshot.relative_to(cache).as_posix(),
                        "files": describe_files(snapshot, names, cache)})
    manifest = {"schemaVersion": 1, "createdAt": datetime.now(timezone.utc).isoformat(),
                "cacheDir": str(cache), "environment": {"HF_HUB_CACHE": str(cache)}, "models": records}
    target = cache / MANIFEST_NAME
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=cache, prefix=".models-manifest-", delete=False) as output:
            temporary = Path(output.name)
            json.dump(manifest, output, indent=2, ensure_ascii=False, allow_nan=False)
            output.write("\n")
        os.replace(temporary, target)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()
    return manifest


def offline_check(config, cache, hub=None):
    """Verify the pinned local files directly; never invoke the Hub client.

    The optional hub argument remains accepted for existing callers, but model
    discovery and snapshot resolution are intentionally filesystem-only.
    """
    specs = model_specs(config)
    cache = project_cache(config, cache)
    manifest = json.loads((cache / MANIFEST_NAME).read_text(encoding="utf-8"))
    if (manifest.get("schemaVersion") != 1 or manifest.get("cacheDir") != str(cache)
            or manifest.get("environment") != {"HF_HUB_CACHE": str(cache)}):
        raise ValueError("Manifest version or project cache path does not match")
    records = manifest.get("models")
    if not isinstance(records, list) or len(records) != len(specs):
        raise ValueError("Manifest does not contain both configured models")
    for spec, record in zip(specs, records):
        if not isinstance(record, dict) or any(record.get(key) != value for key, value in spec.items()):
            raise ValueError("Manifest model or commit differs from config")
        files = record.get("files")
        if not isinstance(files, list) or not files:
            raise ValueError("Manifest file list is empty")
        names = [item.get("name") for item in files if isinstance(item, dict)]
        if len(names) != len(files) or any(not isinstance(name, str) for name in names) or len(set(names)) != len(names):
            raise ValueError("Invalid or duplicate manifest file names")
        names = sorted(names)
        required, format_name, index_name = selection(names)
        snapshot = checked_snapshot(snapshot_path(cache, spec), cache, spec)
        if record.get("snapshotPath") != snapshot.relative_to(cache).as_posix() or record.get("format") != format_name:
            raise ValueError("Manifest snapshot path or weight format differs")
        if index_name:
            required += shards(snapshot, index_name, format_name, set(names), cache)
        if names != sorted(required):
            raise ValueError("Manifest includes unexpected files or omits required shards")
        actual = describe_files(snapshot, names, cache)
        expected = sorted(files, key=lambda item: item["name"])
        if actual != expected:
            raise ValueError("Model file hash, size, or path does not match manifest")
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--cache-dir", required=True, type=Path)
    parser.add_argument("--offline-check", action="store_true", help="Verify existing pinned snapshots and SHA256 hashes without network")
    args = parser.parse_args(argv)
    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
        model_specs(config)
        if args.offline_check:
            os.environ["HF_HUB_OFFLINE"] = "1"
            manifest = offline_check(config, args.cache_dir)
        else:
            # Configure Hub HTTP without importing any model runtime.
            from huggingface_hub import configure_http_backend, list_repo_files, snapshot_download
            from types import SimpleNamespace
            configure_http_backend(backend_factory=http_session)
            hub = SimpleNamespace(list_repo_files=list_repo_files, snapshot_download=snapshot_download)
            manifest = download(config, args.cache_dir, hub)
        print(json.dumps({"status": "verified" if args.offline_check else "downloaded",
                          "manifest": str(Path(manifest["cacheDir"]) / MANIFEST_NAME),
                          "cacheDir": manifest["cacheDir"],
                          "models": [{"kind": model["kind"], "repoId": model["repoId"], "revision": model["revision"],
                                      "files": len(model["files"]), "bytes": sum(item["size"] for item in model["files"])}
                                     for model in manifest["models"]]}))
        return 0
    except Exception as error:
        print(type(error).__name__ + ": " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
