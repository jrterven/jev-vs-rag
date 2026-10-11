import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('export-book-review-package.py')
SPEC = importlib.util.spec_from_file_location('book_review_export', SCRIPT)
export = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(export)


class ReviewPackageTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.package = export.build_package()
        cls.bank = json.loads(cls.package['book-questions.json'])

    def test_real_frozen_counts_and_hashes(self):
        manifest = json.loads(self.package['package-manifest.json'])
        self.assertEqual(manifest['counts'], {'documents': 10, 'questions': 100, 'aiAuthored': 98,
            'humanPreserved': 2, 'development': 20, 'test': 80, 'canonicalUtf16QuoteMatches': 148})
        for name, metadata in manifest['files'].items():
            self.assertEqual(export.digest(self.package[name]), metadata['sha256'])
        self.assertEqual(export.digest(self.package['review.html']), export.PINNED['review.html'])

    def test_scientific_ids_and_human_text_preserved(self):
        source_questions = []
        for split in ('development', 'test'):
            source = json.loads((export.ROOT / export.AUTHORING / f'{split}.bundle.json').read_bytes())
            source_questions.extend(source['freeze']['questions'])
        frozen = {q['id']: q for q in source_questions}
        self.assertEqual(set(frozen), {q['id'] for q in self.bank['questions']})
        for question in self.bank['questions']:
            original = frozen[question['id']]
            for key in ('question', 'answer', 'questionType', 'documentId'):
                self.assertEqual(question[key], original[key])
            for exported_set, frozen_set in zip(question['evidenceSets'], original['evidenceSets']):
                self.assertEqual([{k: e[k] for k in ('blockId', 'start', 'end', 'quote')} for e in exported_set], frozen_set)
            if original['annotation']['mode'] == 'single_annotator':
                self.assertTrue(question['reviewId'].startswith('human:'))
                for account in original['annotation']['annotatorIds']:
                    self.assertFalse(any(account.encode() in content for content in self.package.values()))

    def test_only_selected_source_text_and_allowed_documents(self):
        for document in self.bank['documents']:
            self.assertNotIn('blocks', document)
            self.assertNotIn('sections', document)
            self.assertNotIn('text', document)
            self.assertIn('license', document['edition'])
            self.assertIn('textSha256', document['edition'])
        self.assertFalse(any(name.endswith(('.sqlite', '.env', '.bundle.json')) for name in self.package))
        rows = export.review_rows(self.package['review.html'])
        self.assertEqual(sum(len(group) for row in rows for group in row['evidenceSets']), 148)

    def test_utf16_non_bmp_and_rejection(self):
        block = {'id': 'block', 'text': 'A😀B text', 'start': 10}
        export.validate_quote(block, {'blockId': 'block', 'start': 11, 'end': 13, 'quote': '😀'})
        with self.assertRaises(ValueError):
            export.validate_quote(block, {'blockId': 'block', 'start': 11, 'end': 13, 'quote': 'B'})
        with self.assertRaises((ValueError, UnicodeDecodeError)):
            export.utf16_slice(block['text'], 1, 2)

    def test_review_allowlist_rejects_extra_content(self):
        altered = self.package['review.html'].replace(b'"id":', b'"blocks":[],"id":', 1)
        with self.assertRaisesRegex(ValueError, 'Unexpected review field'):
            export.review_rows(altered)

    def test_exclusive_output_and_idempotence(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary).resolve() / 'package'
            self.assertEqual(export.write_package(target, self.package), 'created')
            self.assertEqual(export.write_package(target, self.package), 'identical')
            original = (target / 'README.md').read_bytes()
            changed = dict(self.package, **{'README.md': b'Changed'})
            with self.assertRaisesRegex(ValueError, 'no files overwritten'):
                export.write_package(target, changed)
            self.assertEqual((target / 'README.md').read_bytes(), original)
            (target / 'extra.txt').write_text('unexpected')
            with self.assertRaisesRegex(ValueError, 'different file set'):
                export.write_package(target, self.package)

    def test_symlink_output_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            real = Path(temporary).resolve() / 'real'
            real.mkdir()
            target = Path(temporary).resolve() / 'alias'
            target.symlink_to(real, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'Symlink'):
                export.write_package(target, self.package)


if __name__ == '__main__':
    unittest.main()
