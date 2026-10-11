"""Acquire every TOC leaf of a pinned official OpenStax web edition, without APIs.

Input is the saved official metadata manifest; cache files are hash-audited in the
output. The text adaptation retains captions, image descriptions and MathML as
text, not rendered illustrations. No questions or human evidence are generated.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import html
import json
from pathlib import Path
import re
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET


def digest(data):
    return hashlib.sha256(data).hexdigest()


def normalize(text):
    return re.sub(r'\s+', ' ', text).strip()


def label(text):
    return normalize(html.unescape(re.sub(r'<[^>]*>', '', text)))


def leaves(node, parents=()):
    if 'contents' in node:
        title = label(node['title'])
        for child in node['contents']:
            yield from leaves(child, (*parents, title))
    else:
        yield {**node, 'path': [*parents, label(node['title'])]}


def tag(element):
    return element.tag.rsplit('}', 1)[-1]


def math_text(element):
    """Keep operator structure in plain text; don't duplicate MathML annotations."""
    name = tag(element)
    children = list(element)
    if name in ('annotation', 'annotation-xml'):
        return ''
    if name == 'semantics':
        return math_text(children[0]) if children else ''
    if name == 'mfrac' and len(children) == 2:
        return f'({math_text(children[0])})/({math_text(children[1])})'
    if name in ('msup', 'msub') and len(children) == 2:
        op = '^' if name == 'msup' else '_'
        return f'{math_text(children[0])}{op}({math_text(children[1])})'
    if name == 'msubsup' and len(children) == 3:
        return f'{math_text(children[0])}_({math_text(children[1])})^({math_text(children[2])})'
    if name == 'msqrt':
        return 'sqrt(' + ' '.join(math_text(c) for c in children) + ')'
    if name == 'mroot' and len(children) == 2:
        return f'root({math_text(children[0])}, {math_text(children[1])})'
    if name == 'mfenced':
        separators = ''.join(element.get('separators', ',').split())
        content = ''
        for index, child in enumerate(children):
            if index and separators:
                content += separators[min(index - 1, len(separators) - 1)] + ' '
            content += math_text(child)
        return element.get('open', '(') + content + element.get('close', ')')
    if name == 'mtable':
        return '[' + '; '.join(math_text(c) for c in children) + ']'
    if name in ('mtr', 'mlabeledtr'):
        return ' | '.join(math_text(c) for c in children)
    if name in ('munder', 'mover') and len(children) == 2:
        position = 'under' if name == 'munder' else 'over'
        return f'{math_text(children[0])} [{position}: {math_text(children[1])}]'
    if name == 'munderover' and len(children) == 3:
        return f'{math_text(children[0])} [under: {math_text(children[1])}; over: {math_text(children[2])}]'
    return normalize((element.text or '') + ' '.join(math_text(c) + (c.tail or '') for c in children))


def extract_page(raw, heading):
    root = ET.fromstring(raw)
    body = root.find('{*}body')
    if body is None or not any(e.get('data-type') == 'page' or e.get('data-book-content') == 'true' for e in body.iter()):
        raise ValueError('Expected an OpenStax book-content page, not an error or TOC.')
    blocks, buffer = [], []
    counts = {'images': 0, 'imagesWithoutAlt': 0, 'math': 0, 'tables': 0}
    boundaries = {'p', 'div', 'section', 'article', 'li', 'ul', 'ol', 'dl', 'dt', 'dd', 'blockquote', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'caption', 'pre'}
    headings = {'h1', 'h2', 'h3', 'h4', 'h5', 'h6'}

    def flush(is_heading=False):
        value = normalize(''.join(buffer)); buffer.clear()
        if value:
            blocks.append({'text': value, **({'heading': value} if is_heading else {})})

    def walk(el, in_cell=False):
        name = tag(el)
        if name in ('script', 'style', 'noscript') or '-dev-permalinker' in el.get('class', ''):
            return
        if name == 'math':
            counts['math'] += 1
            buffer.append(' ' + math_text(el) + ' ')
            return
        if name == 'img':
            counts['images'] += 1
            alt = normalize(el.get('alt', ''))
            if alt:
                flush(); blocks.append({'text': '[Image description] ' + alt})
            else:
                counts['imagesWithoutAlt'] += 1
            return
        if name == 'table':
            counts['tables'] += 1
        in_cell = in_cell or name in ('td', 'th')
        if name in boundaries or name in headings:
            if in_cell:
                buffer.append(' ')
            else:
                flush()
        if name == 'br':
            buffer.append(' ')
        # HTML superscripts/subscripts occur in scientific prose and tables,
        # outside MathML. Flattening 10<sup>20</sup> to 1020 changes its value.
        ordinal = name == 'sup' and normalize(''.join(el.itertext())) in ('st', 'nd', 'rd', 'th')
        citation = name == 'sup' and 'os-citation-number' in el.get('class', '').split()
        if name in ('sup', 'sub') and not ordinal:
            buffer.append('[' if citation else '^(' if name == 'sup' else '_(')
        if el.text:
            buffer.append(el.text)
        for child in el:
            walk(child, in_cell)
            if child.tail:
                buffer.append(child.tail)
        if name in ('sup', 'sub') and not ordinal:
            buffer.append(']' if citation else ')')
        if name in ('td', 'th'):
            buffer.append(' | ')
        if name in boundaries or name in headings:
            if in_cell:
                buffer.append(' ')
            else:
                flush(name in headings)

    walk(body); flush()
    if not blocks:
        raise ValueError('No text extracted from a TOC leaf.')
    # Full chapter/section path disambiguates repeated Introduction/Review titles.
    if 'heading' in blocks[0]:
        blocks[0]['heading'] = heading
    else:
        blocks.insert(0, {'text': heading, 'heading': heading})
    return blocks, counts


def fetch_page(url, target):
    if target.exists():
        raw = target.read_bytes()
        ET.fromstring(raw)
        return raw
    for attempt in range(4):
        try:
            with urlopen(Request(url, headers={'User-Agent': 'ResearchAnnotation/1.0 (noncommercial human annotation)'}), timeout=45) as response:
                raw = response.read(10 * 1024 * 1024 + 1)
                if len(raw) > 10 * 1024 * 1024:
                    raise ValueError('Page exceeds acquisition size limit.')
                ET.fromstring(raw)
                target.parent.mkdir(parents=True, exist_ok=True)
                temporary = target.with_suffix('.part'); temporary.write_bytes(raw); temporary.replace(target)
                return raw
        except HTTPError as error:
            if error.code not in (408, 429, 500, 502, 503, 504) or attempt == 3:
                raise
            delay = error.headers.get('Retry-After', '')
            time.sleep(min(45, int(delay)) if delay.isdigit() else 2 ** attempt)
        except (TimeoutError, OSError):
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)
    raise RuntimeError('Unreachable retry state.')


def acquire_book(doc, directory, workers=6):
    slug = doc['slug']; base = directory / slug
    page_list = list(leaves(doc['tree']))
    ids = [p['id'].split('@')[0] for p in page_list]
    if len(ids) != len(set(ids)) or len(ids) != doc['coverage']['leaves']:
        raise ValueError(f'{slug}: duplicate/mismatched TOC coverage')
    # Bind the normalized acquisition manifest to the preserved official bytes.
    for path_key, hash_key in (('metadataPath', 'metadataSha256'), ('rawStatePath', 'rawStateSha256'), ('rawHtmlPath', 'rawHtmlSha256')):
        if digest(Path(doc[path_key]).read_bytes()) != doc[hash_key]:
            raise ValueError(f'{slug}: source hash mismatch ({path_key})')
    saved_metadata = json.loads(Path(doc['metadataPath']).read_bytes())
    if any(saved_metadata.get(key) != doc[value] for key, value in (('tree', 'tree'), ('id', 'bookId'), ('version', 'bookVersion'), ('license', 'license'))):
        raise ValueError(f'{slug}: normalized metadata differs from preserved source')
    results = {}
    def run(index, page):
        url = doc['pageUrlTemplate'].replace('{pageUUID}', ids[index])
        target = base / 'pages' / (ids[index] + '.xhtml')
        raw = fetch_page(url, target)
        blocks, counts = extract_page(raw, ' / '.join(page['path'][1:]))
        return index, blocks, counts, {'id': ids[index], 'title': label(page['title']), 'slug': page.get('slug'), 'url': url, 'rawSha256': digest(raw), 'bytes': len(raw), 'blockCount': len(blocks)}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        jobs = [pool.submit(run, i, p) for i, p in enumerate(page_list)]
        for job in as_completed(jobs):
            index, blocks, counts, audit = job.result(); results[index] = (blocks, counts, audit)
            if len(results) % 50 == 0 or len(results) == len(jobs):
                print(f'{slug}: {len(results)}/{len(jobs)} sections', flush=True)
    all_blocks, pages = [], []
    totals = {'images': 0, 'imagesWithoutAlt': 0, 'math': 0, 'tables': 0}
    for index in range(len(page_list)):
        blocks, counts, audit = results[index]
        pages.append({**audit, 'firstBlock': len(all_blocks), 'lastBlock': len(all_blocks) + len(blocks) - 1})
        all_blocks.extend(blocks)
        for key in totals:
            totals[key] += counts[key]
    text = '\n\n'.join(b['text'] for b in all_blocks)
    if len(text.encode('utf-16-le')) // 2 + 2 > 20_000_000 or len(all_blocks) > 100000:
        raise ValueError(f'{slug}: complete book exceeds annotation limits; no truncation performed')
    raw_pages = [{key: value for key, value in page.items() if key not in ('blockCount', 'firstBlock', 'lastBlock')} for page in pages]
    archive = {'schemaVersion': 1, 'bookId': doc['bookId'], 'bookVersion': doc['bookVersion'], 'archiveVersion': doc['archiveVersion'], 'metadataUrl': doc['metadataUrl'], 'metadataSha256': doc['metadataSha256'], 'rawStateSha256': doc['rawStateSha256'], 'rawHtmlSha256': doc['rawHtmlSha256'], 'pages': raw_pages}
    raw_manifest = (json.dumps(archive, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode()
    (base / 'raw-manifest.json').write_bytes(raw_manifest)
    (base / 'source-map.json').write_text(json.dumps({'schemaVersion': 1, 'pages': pages}, ensure_ascii=False, indent=2) + '\n')
    license_url = doc['license']['url'].replace('http:', 'https:')
    license_name = 'CC BY-NC-SA 4.0' if '/by-nc-sa/' in license_url else 'CC BY 4.0' if '/by/4.0/' in license_url else doc['license']['name']
    warnings = ['Complete web TOC acquired in document order, including end matter and exercises. Text adaptation normalizes whitespace; tables use text rows and MathML uses linear notation. Figures retain source captions and supplied alt text, not image pixels.', f'{totals["imagesWithoutAlt"]} image elements have no alt text; consult the original for graphical-only evidence.']
    notice = 'Adaptación a texto: espacios normalizados; tablas y fórmulas linealizadas. Incluye pies de figura y descripciones disponibles; consulta el original para las imágenes. No bases preguntas en información exclusivamente visual.'
    # Preserve the publisher's actual current notice; annotation makes no model calls.
    html_source = Path(doc['rawHtmlPath']).read_text()
    if 'prior written permission' in html_source and 'large language models' in html_source:
        warnings.append('The acquired web edition displays a prior written permission requirement for LLM/AI ingestion. Acquired for human annotation only; resolve permissions before model experiments.')
        notice += ' La edición web solicita permiso previo de OpenStax para incorporar su contenido a LLM o servicios de IA. Esta plataforma solo realiza anotación humana.'
    authors = ', '.join(a['value']['name'] for a in doc['authors'] if a.get('type') == 'author')
    source = {'documentId': 'openstax:' + slug, 'corpus': 'openstax-development' if doc['split'] == 'development' else 'openstax-books', 'split': doc['split'], 'url': doc['sourceUrl'], 'license': license_name, 'licenseUrl': license_url, 'acquiredAt': datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'), 'rawSha256': digest(raw_manifest), 'textSha256': digest(text.encode()), 'warnings': warnings}
    attribution = {'text': f'{doc["title"]} — {authors}. OpenStax, Rice University. Adaptación a texto bajo {license_name}.', 'url': doc['sourceUrl'], 'license': license_name, 'licenseUrl': license_url, 'notice': notice}
    output = {'title': doc['title'], 'sourceUrl': doc['sourceUrl'], 'blocks': all_blocks, 'source': source, 'attribution': attribution}
    (base / 'annotation-document.json').write_text(json.dumps(output, ensure_ascii=False) + '\n')
    report = {'title': doc['title'], 'slug': slug, 'split': doc['split'], 'bookVersion': doc['bookVersion'], 'archiveVersion': doc['archiveVersion'], 'chapters': doc['coverage']['chapters'], 'expectedSections': len(page_list), 'acquiredSections': len(pages), 'blocks': len(all_blocks), 'characters': len(text), 'firstSection': pages[0]['title'], 'lastSection': pages[-1]['title'], 'rawSha256': source['rawSha256'], 'textSha256': source['textSha256'], 'license': license_name, **totals}
    (base / 'extraction-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report), flush=True)
    return output, report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--metadata', default='data/research/openstax-acquisition/official-metadata.json')
    parser.add_argument('--workers', type=int, default=6)
    parser.add_argument('--slug')
    args = parser.parse_args()
    if not 1 <= args.workers <= 8:
        raise ValueError('Use 1–8 download workers.')
    metadata_path = Path(args.metadata)
    metadata = json.loads(metadata_path.read_text())
    reports = []
    for doc in metadata['documents']:
        if args.slug and doc['slug'] != args.slug:
            continue
        _, report = acquire_book(doc, metadata_path.parent, args.workers)
        reports.append(report)
    if not reports:
        raise ValueError('No matching books.')
    (metadata_path.parent / ('extraction-reports-' + (args.slug or 'all') + '.json')).write_text(json.dumps(reports, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
