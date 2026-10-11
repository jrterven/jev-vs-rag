"""Persistent JSONL worker. BM25 uses Snowball; models load only on explicit prepare.
No hidden truncation, no approximate index, no automatic retries or query caching.
"""
import collections
import contextlib
import importlib.metadata
import json
import math
import os
import platform
import re
import sys
import time
from pathlib import Path
from download_models import offline_check

documents = {}
models = {}
model_snapshots = None
config = {}
stemmer = None

def tokenize(text):
    global stemmer
    if stemmer is None:
        import snowballstemmer
        stemmer = snowballstemmer.stemmer("english")
    return stemmer.stemWords(re.findall(r"\w+", text.lower(), flags=re.UNICODE))

def sync():
    if "torch" in sys.modules:
        torch = sys.modules["torch"]
        if torch.cuda.is_available():
            torch.cuda.synchronize()

def load_model(kind):
    global model_snapshots
    if kind in models:
        return models[kind]
    if model_snapshots is None:
        cache_dir = config.get("local", {}).get("modelCacheDir")
        if not isinstance(cache_dir, str) or not cache_dir.strip():
            raise ValueError("Local model loading requires an explicit verified modelCacheDir")
        cache = Path(cache_dir).expanduser().resolve()
        manifest = offline_check(config, cache)
        model_snapshots = {record["kind"]: {
            "path": str(cache / record["snapshotPath"]), "format": record["format"],
        } for record in manifest["models"]}
    snapshot = model_snapshots[kind]
    import torch
    from transformers import AutoTokenizer, AutoModel, AutoModelForSequenceClassification
    torch.manual_seed(config["seed"])
    torch.use_deterministic_algorithms(True)
    # Repo IDs can trigger tokenizer metadata calls even with HF_HUB_OFFLINE=1.
    # A verified local directory also prevents remote weight-format conversion.
    tokenizer = AutoTokenizer.from_pretrained(snapshot["path"], local_files_only=True, trust_remote_code=False)
    factory = AutoModel if kind == "dense" else AutoModelForSequenceClassification
    model = factory.from_pretrained(snapshot["path"], local_files_only=True, trust_remote_code=False,
                                    use_safetensors=snapshot["format"] == "safetensors")
    device = config["local"]["device"]
    model = model.to(device).eval()
    if config["local"]["precision"] == "fp16":
        if not device.startswith("cuda"):
            raise ValueError("fp16 mode requires explicit CUDA device")
        model.half()
    models[kind] = (tokenizer, model)
    return models[kind]

def infer(texts, kind="dense", query=None):
    import torch
    import numpy as np
    tokenizer, model = load_model(kind)
    result = []
    batch_size = config["local"]["batchSize"]
    for offset in range(0, len(texts), batch_size):
        batch = texts[offset:offset + batch_size]
        inputs = tokenizer(batch if query is None else [query] * len(batch), text_pair=None if query is None else batch,
                           padding=True, truncation=False, return_tensors="pt")
        if inputs["input_ids"].shape[1] > 8192:
            raise ValueError("BGE input exceeds 8192 model tokens; no text was truncated")
        inputs = {key: value.to(model.device) for key, value in inputs.items()}
        with torch.inference_mode():
            output = model(**inputs)
            if kind == "dense":
                vectors = torch.nn.functional.normalize(output.last_hidden_state[:, 0].float(), p=2, dim=1)
                result.append(vectors.cpu().numpy())
            else:
                result.append(output.logits.view(-1).float().cpu().numpy())
    sync()
    return np.concatenate(result, axis=0)

def rank(ids, scores):
    return [{"chunkId": ids[i], "score": float(scores[i])} for i in sorted(range(len(ids)), key=lambda i: (-float(scores[i]), i))]

def handle(request):
    global config, model_snapshots
    operation = request["operation"]
    if operation == "init":
        config = request["config"]
        models.clear()
        model_snapshots = None
        versions = {}
        for name in ("torch", "transformers", "numpy", "huggingface-hub", "snowballstemmer"):
            try:
                versions[name] = importlib.metadata.version(name)
            except importlib.metadata.PackageNotFoundError:
                versions[name] = None
        return {"python": platform.python_version(), "platform": platform.platform(), "versions": versions,
                "bm25": {"k1": 1.2, "b": 0.75, "idf": "log(1+(N-df+0.5)/(df+0.5))", "tokenizer": "Python Unicode \\w+ lowercase + Snowball English; no stopwords"}}
    if operation == "prepare":
        chunks = request["chunks"]
        counters = [collections.Counter(tokenize(chunk["text"])) for chunk in chunks]
        lengths = [sum(counter.values()) for counter in counters]
        df = collections.Counter(term for counter in counters for term in counter)
        documents[request["documentId"]] = {"chunks": chunks, "counts": counters, "lengths": lengths,
          "average": sum(lengths) / max(1, len(lengths)), "df": df}
        doc = documents[request["documentId"]]
        if request.get("dense"):
            import numpy as np
            load_model("dense")
            cache = request.get("cachePath")
            if cache and os.path.isfile(cache):
                vectors = np.load(cache, allow_pickle=False)
                if vectors.shape != (len(chunks), 1024):
                    raise ValueError("Dense checkpoint dimensions mismatch")
            else:
                vectors = infer([c["text"] for c in chunks])
                if cache:
                    os.makedirs(os.path.dirname(cache), exist_ok=True)
                    with open(cache + ".tmp", "wb") as output:
                        np.save(output, vectors, allow_pickle=False)
                    os.replace(cache + ".tmp", cache)
            doc["vectors"] = vectors
        if request.get("reranker"):
            load_model("reranker")
        return {"chunks": len(chunks)}
    doc = documents[request["documentId"]]
    ids = [c["id"] for c in doc["chunks"]]
    if operation == "bm25":
        count = len(ids)
        scores = [0.0] * count
        for term, frequency in collections.Counter(tokenize(request["query"])).items():
            df = doc["df"].get(term, 0)
            idf = math.log(1 + (count - df + 0.5) / (df + 0.5))
            for i, counter in enumerate(doc["counts"]):
                tf = counter.get(term, 0)
                denominator = tf + 1.2 * (1 - 0.75 + 0.75 * doc["lengths"][i] / max(doc["average"], 1))
                scores[i] += frequency * idf * tf * 2.2 / denominator
        return rank(ids, scores)
    if operation == "dense":
        query = infer([request["query"]])[0]
        return rank(ids, doc["vectors"] @ query)
    if operation == "rerank":
        by_id = {c["id"]: c for c in doc["chunks"]}
        selected = request["candidateIds"]
        scores = infer([by_id[c]["text"] for c in selected], "reranker", request["query"])
        return rank(selected, scores)
    raise ValueError("Unknown operation")

for line in sys.stdin:
    request = None
    try:
        request = json.loads(line)
        with contextlib.redirect_stdout(sys.stderr):
            sync()
            started = time.perf_counter()
            result = handle(request)
            sync()
        response = {"id": request["id"], "result": result, "elapsedMs": (time.perf_counter() - started) * 1000}
    except Exception as error:
        response = {"id": request.get("id") if isinstance(request, dict) else None, "error": type(error).__name__ + ": " + str(error)}
    print(json.dumps(response, allow_nan=False), flush=True)
