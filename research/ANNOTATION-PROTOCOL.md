# Reference annotation protocol

The textbook reference set contains 100 questions on ten complete OpenStax books. Two books and 20 questions are reserved for development; eight other books and 80 questions are used for test. Each book has four factual, three explanatory, and three multi-section questions.

## Authorship

The full collection contains 98 model-authored questions and two preserved human-authored questions. Development contains 20 model-authored questions. Test contains 78 model-authored and two human-authored questions.

Model authoring was requested with GPT-6 Astra and Ultra reasoning. Requested settings, the authoring protocol, source hashes, and verification records are preserved as provenance; they do not independently verify model weights. Natural paraphrases retain necessary technical terms. Authors use canonical source sections and their context without access to method rankings or scores.

The two human questions retain their original wording, references, evidence, and personal-review provenance. Model-authored records remain explicitly labeled `model_generated`, with `humanReviewed: false`. Author self-checks and separate AI reference audits do not establish independent human validation. QASPER retains its original human references and is analyzed separately.

## Evidence representation

Evidence is stored against an immutable document version, block identifier, and UTF-16 offsets. Each selected quote must match the canonical source slice exactly, including Unicode boundaries. A set contains every span needed to support an answer; alternative sets represent distinct complete sources of support.

Source intervals are converted to canonical tokens for retrieval evaluation. Overlapping passage contributions are counted once. Evidence units have equal weight regardless of length, and units from different alternatives are not combined to form an artificial complete set.

## Application workflows

The [annotation application](../annotation/README.md) supports independent author/reviewer assignments and adjudication. In a single-annotator project, the author submits a question and then explicitly confirms a personal review. A personal review is not a second independent annotation, and such records do not support an inter-annotator agreement estimate.

Frozen datasets contain document hashes, source acquisition records, reference answers, evidence alternatives, annotation mode, author identifiers, and timestamps. A corrected annotation creates a new version; it does not alter the dataset used by an existing experiment.

## Evaluation limits

The reported study did not collect independent human ratings of generated answers. Its secondary evaluation uses the fixed answer generator and RAGAS. Synthetic judge controls and AI reference audits are technical checks rather than substitutes for human agreement.

Textbook and QASPER results are reported separately. Textbook sensitivity analysis includes per-book results and exclusion of the two human-authored questions. Acquisition, licensing, and extraction limits are documented in [OPENSTAX-ACQUISITION.md](OPENSTAX-ACQUISITION.md).
