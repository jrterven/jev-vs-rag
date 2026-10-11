"""Audit a frozen local OpenStax acquisition without network or model calls.

Every visible source text node must occur in order in its stored page's canonical
blocks. This checks preservation, not the correctness of a visual interpretation.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import xml.etree.ElementTree as ET

from acquire_openstax import digest, leaves, normalize, tag


def source_text_nodes(element):
    name = tag(element)
    if name in ('script', 'style', 'noscript', 'annotation', 'annotation-xml') or '-dev-permalinker' in element.get('class', ''):
        return
    if name == 'img':
        alt = normalize(element.get('alt', ''))
        if alt:
            yield alt
        return
    if element.text and normalize(element.text):
        yield normalize(element.text)
    children = list(element)
    if name == 'semantics':
        children = children[:1]  # Presentation MathML, not its duplicate annotation.
    for child in children:
        yield from source_text_nodes(child)
        if child.tail and normalize(child.tail):
            yield normalize(child.tail)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def audit(metadata_path, lock_path=None):
    base = metadata_path.parent
    metadata = json.loads(metadata_path.read_bytes())
    locks = json.loads(lock_path.read_bytes()) if lock_path else {}
    if locks.get('metadataSha256'):
        require(digest(metadata_path.read_bytes()) == locks['metadataSha256'], 'Acquisition metadata differs from lock')
    lock_docs = {d['url']: d for d in locks.get('documents', [])}
    documents = []
    totals = {'pages': 0, 'blocks': 0, 'sourceTextNodes': 0, 'images': 0, 'imagesWithoutAlt': 0, 'math': 0, 'tables': 0}
    for doc in metadata['documents']:
        slug = doc['slug']; directory = base / slug
        raw_manifest = (directory / 'raw-manifest.json').read_bytes()
        manifest = json.loads(raw_manifest)
        source_map_bytes = (directory / 'source-map.json').read_bytes()
        source_map = json.loads(source_map_bytes)['pages']
        canonical_bytes = (directory / 'annotation-document.json').read_bytes()
        canonical = json.loads(canonical_bytes)
        report = json.loads((directory / 'extraction-report.json').read_bytes())
        expected_ids = [p['id'].split('@')[0] for p in leaves(doc['tree'])]
        require([p['id'] for p in manifest['pages']] == expected_ids, f'{slug}: TOC page order differs')
        require(len(expected_ids) == len(source_map) == doc['coverage']['leaves'] == report['acquiredSections'] == report['expectedSections'], f'{slug}: incomplete TOC')
        for path_key, hash_key in (('metadataPath', 'metadataSha256'), ('rawStatePath', 'rawStateSha256'), ('rawHtmlPath', 'rawHtmlSha256')):
            require(digest(Path(doc[path_key]).read_bytes()) == doc[hash_key] == manifest[hash_key], f'{slug}: {hash_key} mismatch')
        raw_hash = digest(raw_manifest)
        require(raw_hash == canonical['source']['rawSha256'] == report['rawSha256'], f'{slug}: raw manifest hash mismatch')
        text = '\n\n'.join(b['text'] for b in canonical['blocks'])
        text_hash = digest(text.encode())
        require(text_hash == canonical['source']['textSha256'] == report['textSha256'], f'{slug}: canonical text hash mismatch')
        block_index = 0; source_nodes = 0
        observed = {'images': 0, 'imagesWithoutAlt': 0, 'math': 0, 'tables': 0}
        for original, mapped in zip(manifest['pages'], source_map):
            raw = (directory / 'pages' / (original['id'] + '.xhtml')).read_bytes()
            require(digest(raw) == original['rawSha256'] and len(raw) == original['bytes'], f'{slug}: page {original["id"]} hash/size mismatch')
            require(mapped['id'] == original['id'] and mapped['firstBlock'] == block_index and mapped['lastBlock'] - mapped['firstBlock'] + 1 == mapped['blockCount'], f'{slug}: discontinuous source map')
            block_index = mapped['lastBlock'] + 1
            body = ET.fromstring(raw).find('{*}body')
            require(body is not None, f'{slug}: missing XHTML body')
            page_text = ' '.join(b['text'] for b in canonical['blocks'][mapped['firstBlock']:block_index])
            position = 0
            for expected in source_text_nodes(body):
                found = page_text.find(expected, position)
                require(found >= 0, f'{slug}/{original["id"]}: missing or reordered source text {expected[:160]!r}')
                position = found + len(expected); source_nodes += 1
            for element in body.iter():
                name = tag(element)
                if name == 'img':
                    observed['images'] += 1
                    if not normalize(element.get('alt', '')):
                        observed['imagesWithoutAlt'] += 1
                if name == 'math': observed['math'] += 1
                if name == 'table': observed['tables'] += 1
        require(block_index == len(canonical['blocks']) == report['blocks'], f'{slug}: trailing or missing canonical blocks')
        require(all(observed[key] == report[key] for key in observed), f'{slug}: image/math/table count mismatch')
        entry = {'slug': slug, 'split': doc['split'], 'bookId': doc['bookId'], 'bookVersion': doc['bookVersion'], 'archiveVersion': doc['archiveVersion'],
                 'pages': len(expected_ids), 'blocks': block_index, 'sourceTextNodes': source_nodes, **observed,
                 'rawSha256': raw_hash, 'textSha256': text_hash, 'sourceMapSha256': digest(source_map_bytes),
                 'canonicalFileSha256': digest(canonical_bytes), 'metadataSha256': doc['metadataSha256'], 'missingTextNodes': 0}
        locked = lock_docs.get(doc['sourceUrl'], {})
        for key in ('bookId', 'bookVersion', 'archiveVersion', 'rawSha256', 'textSha256', 'sourceMapSha256', 'metadataSha256'):
            if key in locked:
                require(entry[key] == locked[key], f'{slug}: {key} differs from lock')
        documents.append(entry)
        for key in totals:
            totals[key] += entry[key]
    return {'schemaVersion': 1, 'status': 'passed', 'auditedAt': datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
            'metadataSha256': digest(metadata_path.read_bytes()), 'documents': documents, 'totals': totals, 'missingTextNodes': 0,
            'scope': 'Ordered preservation of every visible source text node and image alt text in stored canonical blocks; complete TOC, byte hashes, text hashes and source-map continuity. Excludes developer scripts/styles/permalinkers and duplicate MathML annotations. Does not validate visual layout or graphical-only evidence.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--metadata', type=Path, default=Path('data/research/openstax-acquisition/official-metadata.json'))
    parser.add_argument('--lock', type=Path, default=Path('research/config/openstax-acquisition.json'))
    parser.add_argument('--out', type=Path, default=Path('data/research/openstax-acquisition/text-audit.json'))
    args = parser.parse_args()
    result = audit(args.metadata, args.lock)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': result['status'], 'totals': result['totals'], 'missingTextNodes': 0}))


if __name__ == '__main__':
    main()
