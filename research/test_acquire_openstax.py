"""Offline fidelity and whole-book provenance checks for OpenStax acquisition."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('acquire_openstax', Path(__file__).with_name('acquire_openstax.py'))
acquire = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(acquire)


def page(content):
    return ('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Site title</title></head>'
            '<body><div data-type="page" data-book-content="true">' + content + '</div></body></html>').encode()


class TextFidelityTests(unittest.TestCase):
    def test_unicode_inline_tails_headings_caption_and_footer_in_order(self):
        raw = page('<h2>1 <span>Estrellas y océanos 🪐</span></h2>'
                   '<p>Antes <em>del</em> Sol — después.</p><h3>Qué observar</h3>'
                   '<ol><li>Primero</li><li>Segundo</li></ol>'
                   '<figure><img alt="Órbita elíptica"/><figcaption>Figura 1. Crédito: María.</figcaption></figure>'
                   '<img/><p>Texto final <a class="-dev-permalinker">¶</a>con cola.</p>'
                   '<footer><p>Copyright Rice University. CC BY 4.0.</p></footer>'
                   '<script>do not retain</script><style>invisible</style>')
        blocks, counts = acquire.extract_page(raw, 'Capítulo 1 / Estrellas')
        self.assertEqual([b['text'] for b in blocks], [
            '1 Estrellas y océanos 🪐', 'Antes del Sol — después.', 'Qué observar',
            'Primero', 'Segundo', '[Image description] Órbita elíptica',
            'Figura 1. Crédito: María.', 'Texto final con cola.',
            'Copyright Rice University. CC BY 4.0.'])
        self.assertEqual(blocks[0]['heading'], 'Capítulo 1 / Estrellas')
        self.assertEqual(blocks[2]['heading'], 'Qué observar')
        self.assertEqual(counts, {'images': 2, 'imagesWithoutAlt': 1, 'math': 0, 'tables': 0})

    def test_scientific_scripts_are_distinct_from_ordinals_and_citations(self):
        blocks, _ = acquire.extract_page(page('<h2>Units</h2><p>Mass 10<sup>20</sup> kg; '
            'CO<sub>2</sub>; the 1<sup>st</sup> observation<sup class="os-citation-number">127</sup>.</p>'), 'Units')
        self.assertEqual(blocks[1]['text'], 'Mass 10^(20) kg; CO_(2); the 1st observation[127].')

    def test_table_nested_paragraphs_preserve_row_and_column_order(self):
        blocks, counts = acquire.extract_page(page('<h2>Measurements</h2><table><caption>Table 1</caption>'
            '<thead><tr><th>Object</th><th>Mass (10<sup>20</sup> kg)</th></tr></thead>'
            '<tbody><tr><td>Moon</td><td><p>First value</p><p>Second value</p></td></tr>'
            '<tr><td>Mars</td><td>42</td></tr></tbody></table><p>After table.</p>'), 'Measurements')
        self.assertEqual([b['text'] for b in blocks], ['Measurements', 'Table 1',
            'Object | Mass (10^(20) kg) |', 'Moon | First value Second value |', 'Mars | 42 |', 'After table.'])
        self.assertEqual(counts['tables'], 1)
        self.assertFalse(any(b['text'] == '|' for b in blocks))

    def test_math_fences_fraction_matrix_and_annotation_not_duplicated(self):
        raw = page('<h2>Equation</h2><p>Find <math><semantics><mrow><mi>E</mi><mo>=</mo>'
                   '<mfrac><msup><mi>x</mi><mn>2</mn></msup><mi>y</mi></mfrac>'
                   '<mfenced><mi>a</mi><mi>b</mi></mfenced>'
                   '<mtable><mtr><mtd><mn>1</mn></mtd><mtd><mn>2</mn></mtd></mtr>'
                   '<mtr><mtd><mn>3</mn></mtd><mtd><mn>4</mn></mtd></mtr></mtable>'
                   '<mover><mi>v</mi><mo>→</mo></mover></mrow>'
                   '<annotation-xml>DO NOT DUPLICATE</annotation-xml></semantics></math> now.</p>')
        blocks, counts = acquire.extract_page(raw, 'Equation')
        self.assertEqual(blocks[1]['text'], 'Find E = (x^(2))/(y) (a, b) [1 | 2; 3 | 4] v [over: →] now.')
        self.assertEqual(counts['math'], 1)

    def test_errors_and_empty_pages_reject_instead_of_returning_partial_text(self):
        for raw in (b'<html><body>Service unavailable</body></html>', page(''), b'<html>'):
            with self.assertRaises((ValueError, acquire.ET.ParseError)):
                acquire.extract_page(raw, 'Missing')


class BookCoverageTests(unittest.TestCase):
    def make_fixture(self, directory):
        tree = {'id': 'book@revision', 'title': 'Book', 'contents': [
            {'id': 'preface@', 'title': '<span>Preface</span>', 'slug': 'preface'},
            {'id': 'chapter@revision', 'title': 'Chapter 1', 'contents': [
                {'id': 'section@', 'title': '1.1 Science', 'slug': '1-1-science'}]},
            {'id': 'index@revision', 'title': 'Index', 'slug': 'index'}]}
        license = {'url': 'http://creativecommons.org/licenses/by/4.0/', 'name': 'CC BY'}
        doc = {'slug': 'example', 'title': 'Example Book', 'split': 'development', 'tree': tree,
               'bookId': 'book', 'bookVersion': 'revision', 'archiveVersion': '20261003',
               'sourceUrl': 'https://openstax.org/books/example/pages/preface',
               'metadataUrl': 'https://openstax.org/apps/archive/20261003/contents/book@revision.json',
               'pageUrlTemplate': 'https://openstax.org/apps/archive/20261003/contents/book@revision:{pageUUID}.xhtml',
               'coverage': {'chapters': 1, 'leaves': 3}, 'license': license,
               'authors': [{'type': 'author', 'value': {'name': 'A. Author'}}]}
        originals = {'metadata': json.dumps({'id': 'book', 'version': 'revision', 'tree': tree, 'license': license}).encode(),
                     'rawState': b'{"official":"state"}',
                     'rawHtml': b'<html>prior written permission; large language models</html>'}
        for key, raw in originals.items():
            path = directory / (key + '.json'); path.write_bytes(raw)
            doc[key + 'Path'] = str(path); doc[key + 'Sha256'] = acquire.digest(raw)
        pages = directory / 'example' / 'pages'; pages.mkdir(parents=True)
        for name, text in [('preface', 'Intro'), ('section', 'Unicode café 🪐'), ('index', 'Terminal marker')]:
            (pages / (name + '.xhtml')).write_bytes(page(f'<h2>{name}</h2><p>{text}</p>'))
        return doc

    def test_all_toc_leaves_order_hashes_spans_and_notices_are_auditable(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(acquire, 'urlopen', side_effect=AssertionError('No network')):
            directory = Path(temp); doc = self.make_fixture(directory)
            output, report = acquire.acquire_book(doc, directory, 3)
            base = directory / 'example'
            raw_manifest = (base / 'raw-manifest.json').read_bytes()
            raw = json.loads(raw_manifest)
            source_map = json.loads((base / 'source-map.json').read_text())
            self.assertEqual([p['id'] for p in raw['pages']], ['preface', 'section', 'index'])
            self.assertEqual(report['expectedSections'], 3); self.assertEqual(report['acquiredSections'], 3)
            self.assertEqual(output['blocks'][-1]['text'], 'Terminal marker')
            self.assertEqual(output['blocks'][2]['heading'], 'Chapter 1 / 1.1 Science')
            self.assertEqual(output['source']['rawSha256'], acquire.digest(raw_manifest))
            self.assertEqual(output['source']['textSha256'], acquire.digest('\n\n'.join(b['text'] for b in output['blocks']).encode()))
            self.assertRegex(output['source']['acquiredAt'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$')
            for p in raw['pages']:
                self.assertEqual(p['rawSha256'], acquire.digest((base / 'pages' / (p['id'] + '.xhtml')).read_bytes()))
                self.assertFalse({'firstBlock', 'lastBlock', 'blockCount'} & p.keys())
            self.assertEqual([(p['firstBlock'], p['lastBlock']) for p in source_map['pages']], [(0, 1), (2, 3), (4, 5)])
            self.assertIn('A. Author', output['attribution']['text'])
            self.assertEqual(output['source']['license'], 'CC BY 4.0')
            self.assertTrue(any('prior written permission' in w for w in output['source']['warnings']))
            # Derived block changes never change the archive's raw-source hash.
            original = acquire.extract_page
            def changed(*args):
                blocks, counts = original(*args)
                return [*blocks, {'text': 'Different parser representation'}], counts
            with patch.object(acquire, 'extract_page', side_effect=changed):
                changed_output, _ = acquire.acquire_book(doc, directory, 1)
            self.assertEqual(changed_output['source']['rawSha256'], output['source']['rawSha256'])
            self.assertNotEqual(changed_output['source']['textSha256'], output['source']['textSha256'])

    def test_incorrect_count_duplicate_page_tampered_metadata_and_missing_page_fail(self):
        for scenario in ('count', 'duplicate', 'metadata', 'normalized', 'missing'):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as temp:
                directory = Path(temp); doc = self.make_fixture(directory)
                if scenario == 'count': doc['coverage']['leaves'] = 4
                if scenario == 'duplicate': doc['tree']['contents'][-1]['id'] = 'preface@revision'
                if scenario == 'metadata': Path(doc['metadataPath']).write_text('{}')
                if scenario == 'normalized': doc['bookVersion'] = 'other'
                if scenario == 'missing': (directory / 'example/pages/index.xhtml').unlink()
                with patch.object(acquire, 'urlopen', side_effect=ValueError('Missing leaf')):
                    with self.assertRaises(ValueError): acquire.acquire_book(doc, directory, 2)
                self.assertFalse((directory / 'example/annotation-document.json').exists())


if __name__ == '__main__':
    unittest.main()
