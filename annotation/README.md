# Annotation application

A standalone React, Fastify, and SQLite application for creating reference questions, selecting evidence, reviewing annotations, and evaluating generated answers. It uses canonical document text shared with the research pipeline and requires no model-provider credentials. The interface is in Spanish and uses a dark theme.

## Local setup

```sh
npm ci
npm run annotation:admin -- bootstrap 'Coordinator'
npm run dev:annotate
```

The frontend runs at **http://127.0.0.1:5175** and the API at **http://127.0.0.1:3002**. Bootstrap creates the first coordinator and prints a private invitation link. Additional participants and assignments are managed through the administration interface.

```sh
npm run build:annotate
ANNOTATION_ORIGIN=http://127.0.0.1:3002 npm run start:annotate
npm run test:annotate
```

## Access and roles

Personal invitations are reusable for seven days. Each accepted invitation creates a persistent session lasting 30 days. Reissuing an invitation replaces its link; revoking a participant invalidates invitations and sessions. Only hashes of access tokens are stored.

Coordinators manage projects, documents, participants, task assignments, and dataset versions. Adjudication requires a separate permission. Contributors see their own assignments and drafts. Invitation links must be shared directly with their intended recipient.

## Annotation workflow

1. **Author a question:** write the question and reference answer, then select every passage needed to support it. Authors do not see system retrieval outputs.
2. **Review:** an independent reviewer answers and selects evidence before seeing the author's annotation. Single-annotator projects use an explicitly labeled personal review instead.
3. **Adjudicate:** compare the preserved versions, resolve disagreements, or return the question for correction.
4. **Freeze:** publish an immutable dataset version with fixed document and annotation hashes. Subsequent corrections produce a new version.

An evidence set contains all spans sufficient to answer the question. Alternative sets represent other complete ways to support the same answer. UTF-16 offsets, document versions, and quotes are checked against immutable canonical text.

The document reader supports a chapter index, text search, complete paragraphs, text selection, and a keyboard evidence-selection alternative. Drafts autosave with revision checks and a local offline copy. Submissions are idempotent, and concurrent edits are detected rather than overwritten.

## Blind answer evaluation

Evaluation tasks show the question, an anonymous answer, its citations, and the human reference. Method names, prices, and latencies are excluded from contributor payloads. Independent ratings remain hidden from other evaluators until both are submitted.

Ratings distinguish answer correctness, unsupported claims, citation support, justified abstention, and cases that cannot be evaluated. Dataset construction and answer evaluation have separate assignment rules.

## Document import

```json
{
  "title": "Book title",
  "sourceUrl": "https://example.org/book.pdf",
  "blocks": [
    {"text": "Chapter 1", "heading": "Chapter 1", "page": 1},
    {"text": "Complete paragraph text.", "page": 1}
  ]
}
```

Direct API imports additionally include `projectId`. The server generates identifiers and offsets. The annotation application accepts prepared canonical text; PDF, DOCX, and TXT extraction is handled by the demo or research importer. Imported answer citations use neutral labels such as `C1`.

## Deployment and storage

[Deployment utilities](../deploy/annotation/README.md) package this application independently from the demo, experiments, and model environments. HTTPS, an exact public `ANNOTATION_ORIGIN`, and persistent SQLite storage are required for remote use.

The supplied Compose configuration can run with its own Caddy proxy:

```sh
cp annotation/.env.example annotation/.env
# Configure ANNOTATION_DOMAIN and ANNOTATION_ORIGIN.
docker compose --env-file annotation/.env -f annotation/compose.yaml up -d --build
```

For a host that already has a reverse proxy, use the separate deployment package instead. Provider credentials are not needed on the annotation server.

## Backup and restore

```sh
npm run annotation:admin -- backup annotation/backups/snapshot.sqlite
ANNOTATION_DATA_DIR=output/restore-check \
  npm run annotation:admin -- restore annotation/backups/snapshot.sqlite
```

Backup uses SQLite's consistent backup API. Restore requires a new data directory, checks database integrity, and invalidates prior invitations and sessions. Store backups separately from the active server and verify restoration before replacing its data volume.

API writes require authentication, permissions, an allowed origin, and `x-annotation-csrf: 1`. Invitation tokens are carried in URL fragments rather than server query logs. Application databases, contributor mappings, sessions, and invitation links are excluded from Git.
