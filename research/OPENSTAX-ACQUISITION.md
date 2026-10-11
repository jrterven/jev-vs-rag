# OpenStax acquisition — 3 October 2026

The ten selected books were acquired from the official OpenStax web archive for human annotation: two development books and eight test books. All 2,884 table-of-contents leaves were retained in source order, including prefaces, chapter introductions, exercises, appendices and indexes. The final corpus contains 123,434 text blocks. No questions, answers, evidence labels or model results were generated during acquisition.

| Book | Split | Book revision | TOC leaves | Acquired edition license |
|---|---|---|---:|---|
| Astronomy 2e | Test | `dff6acf` | 404 | CC BY-NC-SA 4.0 |
| Biology 2e | Test | `63f8b6f` | 495 | CC BY-NC-SA 4.0 |
| Psychology 2e | Test | `de7e40c` | 187 | CC BY-NC-SA 4.0 |
| Principles of Economics 3e | Test | `d5cadb4` | 419 | CC BY-NC-SA 4.0 |
| American Government 3e | Test | `dd9a377` | 204 | CC BY 4.0 |
| Introduction to Business | Test | `9d3b8c4` | 267 | CC BY 4.0 |
| Introduction to Sociology 3e | Test | `ab8839c` | 243 | CC BY-NC-SA 4.0 |
| Introduction to Philosophy | Test | `f1c2fbd` | 126 | CC BY-NC-SA 4.0 |
| U.S. History | Development | `4ec6fca` | 338 | CC BY-NC-SA 4.0 |
| Introduction to Anthropology | Development | `52021fd` | 201 | CC BY-NC-SA 4.0 |

## Sources and immutable records

[The acquisition lock](config/openstax-acquisition.json) records each official reader URL, book UUID, revision, license, page URL template and hashes. The captured archive version is `20260604.144757`. Public reader state identifies the pinned book metadata:

```text
https://openstax.org/apps/archive/{archiveVersion}/contents/{bookId}@{bookVersion}.json
https://openstax.org/apps/archive/{archiveVersion}/contents/{bookId}@{bookVersion}:{pageUUID}.xhtml
```

The book-level XHTML represents the table of contents, not the complete book. Acquisition therefore traverses every leaf in the official metadata tree and downloads each module. A missing, duplicated or malformed page aborts completion; no partial book is accepted.

Raw source files remain excluded from Git under `data/research/openstax-acquisition/`. Preserve this directory with the study data. It contains the exact public reader HTML, embedded state and book metadata; all module XHTML files; and, for each book:

- `raw-manifest.json`: ordered page IDs, URLs, byte lengths and SHA-256 hashes, bound to metadata/state/reader hashes. Its hash is independent of the parser's block representation.
- `source-map.json`: each module's first and last canonical block and block count. Its hash is pinned separately in the acquisition lock.
- `annotation-document.json`: canonical blocks, attribution, actual license and warnings for import into the annotation app.
- `extraction-report.json`: coverage and extraction counts.

Canonical text is the ordered block text joined by two newlines and hashed as UTF-8. Do not change its normalization or regenerate it after annotations have been created; evidence offsets refer to this frozen representation. A changed acquisition requires a distinct document version and renewed annotation validation.

## Text adaptation and limits

The parser retains source headings, paragraphs, lists, table cells, captions, footnotes and footer text in document order. Whitespace is normalized. Original inline Unicode is retained. Chapter/section paths from the table of contents disambiguate repeated headings.

HTML superscripts and subscripts receive explicit linear markers, such as `10^(20)` and `CO_(2)`; ordinal suffixes remain ordinary text and superscript citation numbers use brackets. MathML fractions, powers, roots, fences, matrices and over/under notation are linearized, using the presentation representation once rather than duplicating its annotation. Tables retain cell order and row grouping, including paragraphs within a cell. This is a text adaptation: visual alignment, merged-cell layout and equation typography are not reconstructed.

The source has 4,290 image elements, 685 MathML expressions and 564 tables. Captions and available alternative text are retained; image pixels are not imported. Twelve images lack alt text, all in *Introduction to Business*, and that limitation appears in the book's source warnings. An annotator must consult the official original and avoid questions whose evidence exists only in an image or ambiguous visual layout.

The complete canonical text of each book was checked against the configured one-million-token limit; the largest is *Biology 2e*, with 954,082 tokens under the study's `cl100k_base` estimate. This is not a provider-specific Jev token count. No book was truncated to fit. Each book also fits the annotation app's character/block limits.

## Verification and repeatability

Seven offline unit tests cover Unicode, text/tail order, headings, captions/footer text, scientific scripts, nested table paragraphs, MathML, error pages, complete TOC coverage, hash stability, source-map continuity and rejection of missing or altered inputs:

```bash
python3 -m unittest research/test_acquire_openstax.py
```

The full offline audit validates the stored canonical blocks against every source page, rather than assuming that rerunning the parser produces equivalent data:

```bash
python3 research/audit_openstax.py
```

It checks all source and canonical hashes against the acquisition lock, exact TOC order/count and contiguous block ranges. The saved `text-audit.json` records 270,772 source text nodes, including supplied image alt text, found in order across all 2,884 pages, with zero missing nodes. Developer scripts, styles and permalink controls, and duplicate MathML annotations, are excluded deliberately. Ordered text preservation does not establish visual fidelity or the completeness of future human evidence labels.

Before any annotations exist, the complete cached acquisition can be reprocessed without downloading already present pages:

```bash
python3 research/acquire_openstax.py --metadata data/research/openstax-acquisition/official-metadata.json
```

After annotation starts, use the audit command to verify preserved inputs; do not rerun acquisition over the locked canonical files.

## Attribution and model-use notice

The imported document includes its authors, OpenStax/Rice University attribution, source URL, actual edition license and adaptation notice. Do not assume that all OpenStax editions carry the same license.

All ten captured public readers display a notice requiring prior written permission for LLM/AI ingestion, including the two books whose edition metadata states CC BY 4.0. The source records preserve that notice. This acquisition serves human annotation; permission for subsequent model experiments remains unresolved and must be addressed separately. No model API calls were made during acquisition or verification.
