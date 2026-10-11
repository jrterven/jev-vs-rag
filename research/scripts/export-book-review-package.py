#!/usr/bin/env python3
"""Export this study's frozen question references, never canonical books or accounts."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
AUTHORING = Path('output/astra-book-authoring-20261004')
PINNED = {
    'development.bundle.json': '14308d59db7b1e857bab9826a65cc7024f9c6aec78754c2318bc66d6b80fb78d',
    'test.bundle.json': 'bc86ce49dddb8c261264a37d58750dafa2d313861037439b241cabd08d3dff53',
    'authoring-final-manifest.json': '418aaf8c1f95726286135c4d5415243ea0cb365eeb5d860dc24cc47bfbc840d4',
    'review.html': 'b1e1d8cd1e5581195d651976a366a1fb6cdebac3439345b2bb0bc4d5820fdd9a',
}
REVIEW_KEYS = set('id slug book split type authorship model question answer evidenceSets rationale attribution license licenseUrl'.split())
EVIDENCE_KEYS = set('blockOrder startOffset endOffset documentStart documentEnd quote sectionTitle sourceUrl'.split())
HUMAN_TEXT = {
    'introduction-philosophy': ('What is the origin of the word philosophy',
        'The word philosophy derives from ancient Greek, in which the philosopher is a lover or pursuer (philia) of wisdom (sophia).'),
    'astronomy-2e': ('How we know that dark matter exists?',
        'We know the dark matter is there by the pull its gravity exerts on the stars and raw material we can observe, but what this dark matter is made of and how much of it exists remain a mystery.'),
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encode(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()


def select(value, keys):
    return {key: value[key] for key in keys if key in value}


def utf16_slice(text, start, end):
    raw = text.encode('utf-16-le')
    require(isinstance(start, int) and isinstance(end, int) and 0 <= start < end <= len(raw) // 2,
            'Invalid UTF-16 interval')
    return raw[2 * start:2 * end].decode('utf-16-le')


def validate_quote(block, span):
    require(span['blockId'] == block['id'], 'Evidence block mismatch')
    require(utf16_slice(block['text'], span['start'] - block['start'],
                        span['end'] - block['start']) == span['quote'], 'Evidence quote mismatch')


def review_rows(raw):
    text = raw.decode()
    matches = re.findall(r'<script nonce="openstaxReview" id="review-data" type="application/json">(.*?)</script>', text, re.S)
    require(len(matches) == 1, 'Review data script missing or duplicated')
    rows = json.loads(matches[0])
    require(len(rows) == 100 and len({row['id'] for row in rows}) == 100, 'Review count/IDs mismatch')
    for row in rows:
        require(set(row) == REVIEW_KEYS, 'Unexpected review field')
        for group in row['evidenceSets']:
            for span in group:
                require(set(span) == EVIDENCE_KEYS, 'Unexpected review evidence field')
    # Only the verified display code and these selected Q/A/quotation records are scripts.
    require(len(re.findall(r'<script\b', text)) == 2 and not re.search(r'<script[^>]+src=', text),
            'Unexpected review script')
    require("connect-src 'none'" in text, 'Review must remain offline')
    return rows


README = '''# Book reference set · 2026-10-04

[Review the 100 questions](review.html) or inspect [book-questions.json](book-questions.json).
This is a local review package, not a publication or a complete benchmark download.

There are **98 AI-authored questions and two preserved human questions**: 20 AI
development cases on two books, and 78 AI plus two human test cases on eight books.
Each book has four factual, three explanatory and three multi-section questions.
The AI authors were requested as **GPT-6 Astra, Ultra**. Their self-checks and a
separate, blinded AI reference audit are not human validation. The source records
document requested model settings, not an independent verification of model weights.
Questions, reference answers and all 148 selected evidence spans retain the frozen
wording. Scientific question IDs are retained for joins to the frozen experiment;
`reviewId` maps them to the interface's public aliases. Account and task identifiers
are omitted. No question is relabeled as human-authored.

## Contents and provenance

- `book-questions.json`: exact Q/A and selected quotations; document-global and
  block-local UTF-16 offsets; section URLs; frozen edition hashes and attribution.
- `review.html`: byte-identical copy of the existing offline review interface.
  It embeds only the selected questions, answers, quotations and display metadata.
- `provenance/`: original authoring procedure/manifest, source-selection records,
  descriptive wording audit and the separate AI reference audit (selective export).
- `config/`: frozen pilot/test settings and protocol amendment. The local Python
  path remains the recorded execution setting and must be adapted for a new host.
- `package-manifest.json`: input and output SHA-256 hashes, counts and validation.

The full canonical books, databases, sessions, API keys and experimental results
are deliberately absent. The selected quotations retain each acquired edition's
attribution and license. Historical acquisition notices are preserved as historical
metadata; they neither describe this AI workflow nor establish publisher permission.
This package does not authorize publication or redistribution of the source books.

## Reproduce and verify locally

From the repository root, with the original local frozen artifacts available:

```sh
python3 research/scripts/export-book-review-package.py
python3 -m unittest research/scripts/test_export_book_review_package.py
```

The exporter checks pinned source hashes, all 148 canonical UTF-16 slices, quotas,
the two unchanged human Q/A, exact evidence agreement with the review interface,
and a strict field allowlist. It makes no network or API calls and reads no system
results. Identical reruns succeed; different existing content is never overwritten.
Original input paths are recorded in the manifest; full books remain under the
local ignored `data/` and `output/` directories. Reproduction of this selective
export requires those originals; the package alone cannot rebuild whole-book
retrieval experiments.

See the [research workflow](../README.md),
[source acquisition settings](../config/openstax-acquisition.json) and
[exporter](../scripts/export-book-review-package.py).
'''


def build_package(root=ROOT):
    inputs = {}

    def read(path):
        raw = (root / path).read_bytes()
        inputs[str(path)] = {'sha256': digest(raw), 'bytes': len(raw)}
        return raw

    pinned = {name: read(AUTHORING / name) for name in PINNED}
    for name, raw in pinned.items():
        require(digest(raw) == PINNED[name], f'Frozen source changed: {name}')
    author = json.loads(pinned['authoring-final-manifest.json'])
    for name, expected in author['files'].items():
        require(digest(read(AUTHORING / name)) == expected, f'Authoring input changed: {name}')
    acquisition = json.loads(read(Path('research/config/openstax-acquisition.json')))
    lock_hash = inputs['research/config/openstax-acquisition.json']['sha256']
    editions = {row['slug']: row for row in acquisition['documents']}
    reviewed = {row['id']: row for row in review_rows(pinned['review.html'])}
    documents, questions, freezes, private_values = [], [], [], set()
    span_count = 0
    for split in ('development', 'test'):
        bundle = json.loads(pinned[f'{split}.bundle.json'])
        freeze = bundle['freeze']
        freezes.append(select(freeze, ('id', 'version', 'createdAt', 'hash')) | {'split': split})
        docmap = {doc['id']: doc for doc in freeze['documents']}
        blocks = {key: {block['id']: block for block in doc['blocks']} for key, doc in docmap.items()}
        sources = {source['documentId']: source for source in bundle['sources']}
        for doc in freeze['documents']:
            slug = doc['id'].removeprefix('openstax:')
            edition = editions[slug]
            source = sources[doc['id']]
            require(source['split'] == edition['split'] == split, 'Document split mismatch')
            require(doc['hash'] == source['textSha256'] == edition['textSha256'], 'Document hash mismatch')
            require(source['sourceLockHash'] == lock_hash, 'Source lock mismatch')
            documents.append({
                **select(doc, ('id', 'title', 'hash', 'version', 'blockCount', 'sourceUrl', 'attribution')),
                'slug': slug, 'split': split,
                'edition': select(edition, ('bookId', 'bookVersion', 'archiveVersion', 'pages', 'blocks',
                    'rawSha256', 'textSha256', 'sourceMapSha256', 'metadataSha256', 'metadataUrl', 'license', 'licenseUrl')),
                'acquiredAt': source['acquiredAt'], 'sourceLockHash': lock_hash,
                'historicalAcquisitionWarnings': source['warnings'],
            })
        for q in freeze['questions']:
            mode = q['annotation']['mode']
            require(mode in ('model_generated', 'single_annotator'), 'Unexpected authorship mode')
            slug = q['documentId'].removeprefix('openstax:')
            public_id = q['id'] if mode == 'model_generated' else f'human:{slug}:01'
            row = reviewed[public_id]
            require(row['question'] == q['question'] and row['answer'] == q['answer'] and
                    row['type'] == q['questionType'] and row['split'] == split and row['slug'] == slug,
                    'Review question differs from frozen question')
            require(row['authorship'] == ('AI' if mode == 'model_generated' else 'Human'), 'Authorship mismatch')
            require(len(row['evidenceSets']) == len(q['evidenceSets']), 'Evidence-set count mismatch')
            evidence = []
            for group, displayed in zip(q['evidenceSets'], row['evidenceSets']):
                require(len(group) == len(displayed), 'Evidence-span count mismatch')
                selected = []
                for span, shown in zip(group, displayed):
                    block = blocks[q['documentId']][span['blockId']]
                    validate_quote(block, span)
                    require((shown['documentStart'], shown['documentEnd'], shown['quote'], shown['blockOrder'],
                             shown['startOffset'], shown['endOffset']) ==
                            (span['start'], span['end'], span['quote'], block['index'],
                             span['start'] - block['start'], span['end'] - block['start']), 'Review evidence mismatch')
                    selected.append(select(span, ('blockId', 'start', 'end', 'quote')) |
                                    select(shown, ('blockOrder', 'startOffset', 'endOffset', 'sectionTitle', 'sourceUrl')))
                    span_count += 1
                evidence.append(selected)
            if mode == 'model_generated':
                annotation = select(q['annotation'], ('mode', 'model', 'reasoningEffort', 'authoringRunId',
                    'promptHash', 'documentHash', 'sourceLockHash', 'generatedAt', 'humanReviewed', 'validation'))
                require(annotation['model'] == 'gpt-6-astra' and annotation['reasoningEffort'] == 'ultra' and
                        annotation['humanReviewed'] is False, 'AI authorship metadata mismatch')
            else:
                require((q['question'], q['answer']) == HUMAN_TEXT[slug], 'Preserved human text changed')
                annotation = select(q['annotation'], ('mode', 'reviewedAt')) | {'publicAuthorAlias': 'human-01'}
                private_values.update(q['annotation']['annotatorIds'])
            questions.append({**select(q, ('documentId', 'question', 'questionType', 'answer', 'unanswerable')),
                'id': q['id'], 'reviewId': public_id, 'split': split, 'annotation': annotation, 'evidenceSets': evidence,
                'frozenQuestionRecordSha256': digest(json.dumps(q, ensure_ascii=False, separators=(',', ':')).encode()),
                'recordHashConvention': 'SHA-256 of compact UTF-8 JSON in frozen source field order; public alias and selective fields do not replace the original study ID',
                'multiSectionRationale': row['rationale']})
    require(len(questions) == 100 and span_count == 148, 'Case or evidence totals differ')
    require(len({q['id'] for q in questions}) == 100, 'Duplicate question IDs')
    require(Counter(q['annotation']['mode'] for q in questions) == {'model_generated': 98, 'single_annotator': 2}, 'Authorship counts differ')
    require(Counter(q['split'] for q in questions) == {'development': 20, 'test': 80}, 'Split counts differ')
    for doc in documents:
        require(Counter(q['questionType'] for q in questions if q['documentId'] == doc['id']) ==
                {'factual': 4, 'explanatory': 3, 'multi_section': 3}, 'Per-book quotas differ')
    package = {
        'README.md': README.encode(),
        'review.html': pinned['review.html'],
        'book-questions.json': encode({'schemaVersion': 1, 'kind': 'selective-frozen-reference-export',
            'status': 'local-author-review; no experiment results included',
            'offsetConvention': 'zero-based UTF-16, end-exclusive; start/end are document-global, startOffset/endOffset are block-local',
            'humanAliasPolicy': 'Two human cases retain exact question/answer/evidence, frozen scientific question IDs and single-annotator authorship. reviewId maps to the display alias. Account and task IDs are omitted.',
            'freezes': freezes, 'documents': documents, 'questions': questions}),
    }
    for name in ('generation-protocol.md', 'authoring-final-manifest.json', 'source-selection-plan.json',
                 'source-selection-executed.json', 'human-preservation-addendum.json'):
        package[f'provenance/{name}'] = read(AUTHORING / name)
    for name in ('pilot-config.json', 'test-config.json'):
        package[f'config/{name}'] = read(Path('research/data/book-completion-20261004') / name)
    package['config/study-amendment-20261004.json'] = read(Path('research/config/study-amendment-20261004.json'))
    wording = json.loads(read(AUTHORING / 'paraphrase-audit.json'))
    package['provenance/wording-audit-summary.json'] = encode(select(wording,
        ('schemaVersion', 'kind', 'policy', 'interpretation', 'counts', 'groups', 'scriptSha256')))
    audit = json.loads(read(AUTHORING / 'independent-reference-audit.json'))
    package['provenance/reference-audit-summary.json'] = encode(select(audit,
        ('schemaVersion', 'auditId', 'createdAt', 'reviewer', 'timing', 'blinding', 'method', 'counts',
         'countsBySplitAndOrigin', 'countsByBook', 'findings', 'limitations')))
    for value in private_values:
        require(all(value.encode() not in content for content in package.values()), 'Private identifier entered export')
    manifest = {'schemaVersion': 1, 'kind': 'local-review-package', 'createdFromFrozenAt': author['frozenAt'],
        'exporterSha256': digest(Path(__file__).read_bytes()), 'sources': inputs,
        'counts': {'documents': 10, 'questions': 100, 'aiAuthored': 98, 'humanPreserved': 2,
                   'development': 20, 'test': 80, 'canonicalUtf16QuoteMatches': span_count},
        'validation': {'sourceHashesPinned': True, 'humanTextPreserved': True, 'reviewByteIdentical': True,
            'reviewSelectedFieldsOnly': True, 'allEvidenceMatchesCanonical': True,
            'fullBooksExported': False, 'experimentalResultsRead': False, 'networkCalls': 0},
        'files': {name: {'sha256': digest(content), 'bytes': len(content)} for name, content in sorted(package.items())}}
    package['package-manifest.json'] = encode(manifest)
    return package


def write_package(destination, package):
    require(not any(path.is_symlink() for path in (destination, *destination.parents)), 'Symlink output is not allowed')
    if destination.exists():
        existing = {str(p.relative_to(destination)): p for p in destination.rglob('*') if p.is_file() or p.is_symlink()}
        require(set(existing) == set(package), 'Existing package has different file set; choose a new destination')
        require(all(not existing[name].is_symlink() and existing[name].read_bytes() == content
                    for name, content in package.items()), 'Existing package differs; no files overwritten')
        return 'identical'
    destination.mkdir(parents=True, exist_ok=False)
    for name, content in package.items():
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as handle:
            handle.write(content)
    return 'created'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'research/study-20261004')
    args = parser.parse_args()
    package = build_package()
    status = write_package(args.output, package)
    print(json.dumps({'status': status, 'output': str(args.output), 'files': len(package),
                      'manifestSha256': digest(package['package-manifest.json'])}))


if __name__ == '__main__':
    main()
