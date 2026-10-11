"""CPU/network-free tests: python -m unittest discover -s research/python -p 'test_*.py'."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace


SPEC = importlib.util.spec_from_file_location("download_models", Path(__file__).with_name("download_models.py"))
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)

CONFIG = {"models": {"bge": "BAAI/bge-m3", "bgeRevision": "a" * 40,
                      "reranker": "BAAI/bge-reranker-v2-m3", "rerankerRevision": "b" * 40}}


class FakeHub:
    def __init__(self, repositories):
        self.repositories = repositories
        self.calls = []

    def list_repo_files(self, **options):
        self.calls.append(("list", options))
        return list(self.repositories[options["repo_id"]])

    def snapshot_download(self, **options):
        self.calls.append(("snapshot", options.copy()))
        cache = Path(options["cache_dir"])
        snapshot = helper.snapshot_path(cache, {"repoId": options["repo_id"], "revision": options["revision"]})
        if not options["local_files_only"]:
            snapshot.mkdir(parents=True, exist_ok=True)
            blobs = snapshot.parent.parent / "blobs"
            blobs.mkdir(exist_ok=True)
            for name in options["allow_patterns"]:
                content = self.repositories[options["repo_id"]][name]
                blob = blobs / (options["revision"] + "-" + name)
                blob.write_bytes(content)
                destination = snapshot / name
                if not destination.exists():
                    destination.symlink_to(blob)
        return str(snapshot)


def single_repository():
    return {"config.json": b'{"model_type":"xlm-roberta"}',
            "tokenizer.json": b'{}', "tokenizer_config.json": b'{}',
            "sentencepiece.bpe.model": b"test sentencepiece data",
            "model.safetensors": b"test safetensors data", "pytorch_model.bin": b"not selected",
            "onnx/model.onnx": b"not selected", "sparse_linear.pt": b"not selected",
            "README.md": b"not selected"}


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.cache = Path(self.directory.name).resolve()
        self.repositories = {spec["repoId"]: single_repository() for spec in helper.model_specs(CONFIG)}
        self.hub = FakeHub(self.repositories)

    def test_minimal_safetensors_download_and_offline_verification(self):
        manifest = helper.download(CONFIG, self.cache, self.hub)
        self.assertEqual(len(manifest["models"]), 2)
        self.assertEqual(manifest["environment"], {"HF_HUB_CACHE": str(self.cache)})
        for record in manifest["models"]:
            self.assertEqual({item["name"] for item in record["files"]},
                             {"config.json", "tokenizer.json", "tokenizer_config.json", "sentencepiece.bpe.model", "model.safetensors"})
            self.assertTrue(all(len(item["sha256"]) == 64 for item in record["files"]))
        self.hub.calls.clear()
        self.assertEqual(helper.offline_check(CONFIG, self.cache, self.hub), manifest)
        self.assertEqual(self.hub.calls, [])

    def test_sharded_safetensors_and_pytorch_fallback(self):
        dense = self.repositories[CONFIG["models"]["bge"]]
        dense.pop("model.safetensors")
        dense["model.safetensors.index.json"] = json.dumps({"weight_map": {
            "encoder.a": "model-00001-of-00002.safetensors", "encoder.b": "model-00002-of-00002.safetensors",
        }}).encode()
        dense["model-00001-of-00002.safetensors"] = b"shard one"
        dense["model-00002-of-00002.safetensors"] = b"shard two"
        reranker = self.repositories[CONFIG["models"]["reranker"]]
        reranker.pop("model.safetensors")
        manifest = helper.download(CONFIG, self.cache, self.hub)
        self.assertEqual([record["format"] for record in manifest["models"]], ["safetensors", "pytorch"])
        self.assertNotIn("pytorch_model.bin", {item["name"] for item in manifest["models"][0]["files"]})
        self.assertEqual(helper.offline_check(CONFIG, self.cache, self.hub), manifest)

    def test_sharded_pytorch_fallback(self):
        for repository in self.repositories.values():
            repository.pop("model.safetensors")
            repository.pop("pytorch_model.bin")
            repository["pytorch_model.bin.index.json"] = json.dumps({"weight_map": {
                "encoder.a": "pytorch_model-00001-of-00001.bin",
            }}).encode()
            repository["pytorch_model-00001-of-00001.bin"] = b"test bin shard"
        manifest = helper.download(CONFIG, self.cache, self.hub)
        self.assertEqual(helper.offline_check(CONFIG, self.cache, self.hub), manifest)

    def test_tampered_missing_and_external_files_fail(self):
        manifest = helper.download(CONFIG, self.cache, self.hub)
        path = self.cache / manifest["models"][0]["files"][0]["path"]
        original = path.read_bytes()
        path.write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "hash, size, or path"):
            helper.offline_check(CONFIG, self.cache, self.hub)
        path.write_bytes(original)
        path.unlink()
        with self.assertRaisesRegex(ValueError, "Missing model file"):
            helper.offline_check(CONFIG, self.cache, self.hub)
        with tempfile.TemporaryDirectory() as outside:
            external = Path(outside) / "config.json"
            external.write_bytes(original)
            path.symlink_to(external)
            with self.assertRaisesRegex(ValueError, "outside project cache"):
                helper.offline_check(CONFIG, self.cache, self.hub)

    def test_commit_model_and_manifest_path_validation(self):
        invalid = copy.deepcopy(CONFIG)
        invalid["models"]["bgeRevision"] = "main"
        with self.assertRaisesRegex(ValueError, "40-character"):
            helper.download(invalid, self.cache, self.hub)
        invalid = copy.deepcopy(CONFIG)
        invalid["models"]["bge"] = "../model"
        with self.assertRaisesRegex(ValueError, "model ID"):
            helper.model_specs(invalid)
        helper.download(CONFIG, self.cache, self.hub)
        different = copy.deepcopy(CONFIG)
        different["models"]["bgeRevision"] = "c" * 40
        with self.assertRaisesRegex(ValueError, "differs from config"):
            helper.offline_check(different, self.cache, self.hub)
        path = self.cache / helper.MANIFEST_NAME
        manifest = json.loads(path.read_text())
        manifest["models"][0]["snapshotPath"] = "../outside"
        path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "snapshot path"):
            helper.offline_check(CONFIG, self.cache, self.hub)

    def test_index_cannot_request_unlisted_or_external_weights(self):
        repository = self.repositories[CONFIG["models"]["bge"]]
        repository.pop("model.safetensors")
        for name in ("../outside.safetensors", "model-00001-of-00001.safetensors"):
            repository["model.safetensors.index.json"] = json.dumps({"weight_map": {"encoder": name}}).encode()
            with self.assertRaisesRegex(ValueError, "absent or unsupported shard"):
                helper.download(CONFIG, self.cache, self.hub)
        self.assertFalse((self.cache / helper.MANIFEST_NAME).exists())

    def test_project_cache_matches_worker_config(self):
        config = copy.deepcopy(CONFIG)
        config["local"] = {"modelCacheDir": str(self.cache)}
        manifest = helper.download(config, self.cache, self.hub)
        self.assertEqual(helper.offline_check(config, self.cache, self.hub), manifest)
        config["local"]["modelCacheDir"] = str(self.cache / "different")
        with self.assertRaisesRegex(ValueError, "config.local.modelCacheDir"):
            helper.offline_check(config, self.cache, self.hub)
        with self.assertRaisesRegex(ValueError, "config.local.modelCacheDir"):
            helper.download(config, self.cache, self.hub)

    def test_http_timeout_defaults_and_explicit_values(self):
        class Session:
            def request(self, method, url, **kwargs):
                return {"method": method, "url": url, **kwargs}

        with patch.dict("sys.modules", {"requests": SimpleNamespace(Session=Session)}):
            session = helper.http_session()
        for options in ({}, {"timeout": None}):
            with self.subTest(options=options):
                result = session.request("GET", "https://example.invalid", **options)
                self.assertEqual(result["timeout"], (10, 60))
        for timeout in (4, (3, 30), (None, 120)):
            with self.subTest(timeout=timeout):
                result = session.request("GET", "https://example.invalid", timeout=timeout, headers={"x-test": "1"})
                self.assertEqual(result["timeout"], timeout)
                self.assertEqual(result["headers"], {"x-test": "1"})


if __name__ == "__main__":
    unittest.main()
