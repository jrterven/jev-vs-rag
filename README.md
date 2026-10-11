# Jev vs. RAG

Code and numerical results for reproducible long-document retrieval experiments with Jev, OpenAI Decisions, Cloudflare Clef, and lexical, dense, and hybrid baselines.

The experiments compare lexical, dense, hybrid, and decision-based retrieval on scientific articles and complete textbooks. The evaluation measures evidence coverage, evidence loss during candidate reduction, latency, API cost, and downstream answer quality.

[Experiment guide](research/README.md) · [Results](results/README.md) · [Annotation application](annotation/README.md)

## Methods

| Method | Retrieval strategy |
| --- | --- |
| BM25 | Lexical ranking |
| OpenAI dense | `text-embedding-3-small`, exact cosine search |
| BGE-M3 dense | Local dense retrieval |
| Hybrid | BM25 and BGE-M3 with reciprocal rank fusion |
| Hybrid + BGE | BGE reranking of 50 hybrid candidates |
| Hybrid + Jev / Decisions / Clef | Decision-based reranking of the same 50 candidates |
| Jev / Decisions / Clef full scan | Windowed search over the complete document, followed by candidate reduction |

All methods use common passage boundaries, approximately 500 tokens with 75 tokens of overlap, and return up to five passages. Decisions and Clef were evaluated in separate extensions to the original seven-method experiment.

## Results

Evidence coverage at five passages (**EC@5**), averaged within each document and then across documents:

| Method | QASPER | Textbooks |
| --- | ---: | ---: |
| BM25 | 84.7% | 72.1% |
| OpenAI dense | 90.4% | 81.3% |
| BGE-M3 dense | 89.9% | 74.2% |
| Hybrid | 88.5% | 77.4% |
| Hybrid + BGE | 88.9% | 86.6% |
| Hybrid + Jev | 97.0% | 94.1% |
| Jev full scan | 97.7% | 88.7% |
| Hybrid + Decisions | 96.2% | 87.4% |
| Decisions full scan | 96.2% | 76.6% |
| Hybrid + Clef | 98.8% | 91.2% |
| Clef full scan | 98.8% | 91.6% |

QASPER coverage uses 320 answerable questions; 76 unanswerable questions are evaluated separately. The textbook test set contains 80 questions across eight books: 78 model-authored and two human-authored, without independent human validation. Failed retrievals remain in coverage denominators.

Higher evidence coverage does not consistently produce higher answer scores. Most QASPER articles fit entirely within the hybrid candidate pool. Textbooks provide the long-document comparison, but their reference authorship limits generalization. Cross-system latency comparisons also depend on measurement date, hardware, precision, and concurrency; Clef hybrid measurements cover reranking only.

The [results documentation](results/README.md) describes answer evaluation, uncertainty, timing scopes, failures, cost accounting, and data availability. Numerical artifacts retain the measured values and their source hashes.

## Installation

Requirements: **Node.js 24+** and **Python 3**. Local BGE and Clef inference requires the corresponding Python environments; the mock experiment and aggregate verification do not require a GPU or API credentials.

```sh
npm ci
npm run check:all
npm run test:all
```

## Run an offline experiment

```sh
npm run research -- --help
npm run research -- mock-demo \
  --id mock-demo \
  --out data/research/mock-demo \
  --budget-file data/research/mock-budget.sqlite
python3 results/verify.py
```

The mock experiment exercises the retrieval and generation pipeline with synthetic data and simulated providers. Its outputs are labeled `mock` and are excluded from measured results. See the [experiment guide](research/README.md) for dataset import, model setup, measured runs, and evaluation.

## Interactive applications

### Retrieval demo

```sh
cp .env.example .env
# Set TYPESAFE_API_KEY and OPENAI_API_KEY in .env.
npm run dev
```

Open **http://127.0.0.1:5174**. The demo supports PDF, DOCX, and TXT import, passage inspection, Jev/dense retrieval comparisons, and per-attempt cost accounting. It runs locally and does not generate answers. The interface is in Spanish.

```sh
npm run build
npm start
```

The compiled demo is served at **http://127.0.0.1:3001**.

### Annotation application

```sh
npm run annotation:admin -- bootstrap 'Coordinator'
npm run dev:annotate
```

Open **http://127.0.0.1:5175**. The separate application supports invitations, question authoring, evidence selection, review, adjudication, dataset versions, and blind answer evaluation. It does not require model-provider credentials. See [annotation setup](annotation/README.md) and [deployment](deploy/annotation/README.md).

## Repository structure

| Directory | Contents |
| --- | --- |
| `research/` | Experiment runners, retrieval adapters, metrics, statistical analysis, and RAGAS integration |
| `results/` | Numerical measurements, aggregate audit summaries, and checksum verification |
| `server/`, `src/`, `shared/` | Local retrieval demo and shared document utilities |
| `annotation/` | Standalone annotation server and web interface |
| `deploy/` | Annotation packaging and deployment utilities |
| `tests/` | Demo and extraction tests |

## Data and reproducibility

The repository distributes code and numerical results. Full source documents, question banks, generated answers, provider traces, application databases, and credentials are not distributed. Recomputing measurements from raw inputs requires the matching datasets and frozen run artifacts; verifying the distributed result checksums does not require them.

[Protocol configuration](research/config/protocol.json), [dataset provenance](research/OPENSTAX-ACQUISITION.md), and the [annotation protocol](research/ANNOTATION-PROTOCOL.md) document the recorded experiment. Model revisions, configuration hashes, source hashes, failures, and unresolved API usage are retained in the result provenance. Source-document licenses apply independently to acquired datasets.
