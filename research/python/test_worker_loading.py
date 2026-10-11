"""Verify local model resolution without importing torch or using GPU/network."""
import copy
import importlib.util
import io
from pathlib import Path
import socket
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from test_download_models import CONFIG, FakeHub, helper, single_repository


def import_worker():
    spec = importlib.util.spec_from_file_location("test_local_model_worker", Path(__file__).with_name("worker.py"))
    module = importlib.util.module_from_spec(spec)
    with patch("sys.stdin", io.StringIO("")):
        spec.loader.exec_module(module)
    return module


class WorkerModelLoadingTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.cache = Path(self.directory.name).resolve()
        self.config = copy.deepcopy(CONFIG)
        self.config.update({"seed": 42, "local": {"modelCacheDir": str(self.cache), "device": "cpu", "precision": "fp32"}})
        repositories = {spec["repoId"]: single_repository() for spec in helper.model_specs(self.config)}
        # Match the verified GB10 manifest: dense PyTorch, reranker safetensors.
        repositories[self.config["models"]["bge"]].pop("model.safetensors")
        self.manifest = helper.download(self.config, self.cache, FakeHub(repositories))
        self.worker = import_worker()
        self.worker.config = self.config
        self.calls = []
        self.torch = SimpleNamespace(manual_seed=Mock(), use_deterministic_algorithms=Mock())

        def tokenizer(location, **kwargs):
            # Transformers 4.57.3 only short-circuits the Mistral metadata query
            # for a physical local directory; model IDs are intentionally refused.
            if not Path(location).is_dir():
                raise RuntimeError("OfflineModeIsEnabled: remote metadata requested")
            self.calls.append(("tokenizer", location, kwargs))
            return object()

        def factory(kind):
            def load(location, **kwargs):
                self.assertTrue(Path(location).is_dir())
                self.calls.append((kind, location, kwargs))
                model = SimpleNamespace()
                model.to = lambda device: model
                model.eval = lambda: model
                model.half = lambda: model
                return model
            return SimpleNamespace(from_pretrained=load)

        self.transformers = SimpleNamespace(AutoTokenizer=SimpleNamespace(from_pretrained=tokenizer),
                                            AutoModel=factory("dense"), AutoModelForSequenceClassification=factory("reranker"))
        self.modules = patch.dict(sys.modules, {"torch": self.torch, "transformers": self.transformers})
        self.modules.start()
        self.addCleanup(self.modules.stop)
        self.network = patch.object(socket, "create_connection", side_effect=AssertionError("Network is forbidden"))
        self.network.start()
        self.addCleanup(self.network.stop)

    def test_verified_local_snapshots_and_weight_formats_are_used_and_hashed_once(self):
        with patch.object(self.worker, "offline_check", wraps=self.worker.offline_check) as verify:
            first = self.worker.load_model("dense")
            self.assertIs(self.worker.load_model("dense"), first)
            self.worker.load_model("reranker")
            self.assertEqual(verify.call_count, 1)
        self.assertEqual(len(self.calls), 4)
        for kind, location, options in self.calls:
            self.assertTrue(str(Path(location).resolve()).startswith(str(self.cache) + "/"))
            self.assertTrue(options["local_files_only"])
            self.assertFalse(options["trust_remote_code"])
            self.assertNotIn("revision", options)
            self.assertNotIn("cache_dir", options)
            if kind != "tokenizer":
                record = next(record for record in self.manifest["models"] if record["kind"] == kind)
                self.assertEqual(Path(location), self.cache / record["snapshotPath"])
                self.assertEqual(options["use_safetensors"], kind == "reranker")

    def test_tampered_weights_fail_before_runtime_or_model_loading(self):
        dense = self.manifest["models"][0]
        weights = next(item for item in dense["files"] if item["name"] == "pytorch_model.bin")
        (self.cache / weights["path"]).write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "hash, size, or path"):
            self.worker.load_model("dense")
        self.assertEqual(self.calls, [])
        self.torch.manual_seed.assert_not_called()
        self.assertIsNone(self.worker.model_snapshots)

    def test_missing_cache_or_changed_commit_fails_closed_without_remote_fallback(self):
        del self.config["local"]["modelCacheDir"]
        with self.assertRaisesRegex(ValueError, "explicit verified modelCacheDir"):
            self.worker.load_model("dense")
        self.config["local"]["modelCacheDir"] = str(self.cache)
        self.config["models"]["bgeRevision"] = "c" * 40
        with self.assertRaisesRegex(ValueError, "differs from config"):
            self.worker.load_model("dense")
        self.assertEqual(self.calls, [])
        self.torch.manual_seed.assert_not_called()


if __name__ == "__main__":
    unittest.main()
