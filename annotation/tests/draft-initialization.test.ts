import assert from 'node:assert/strict';
import test from 'node:test';
import type { AnnotationDraft, TaskView } from '../shared/types';
import { initialDraft } from '../web/useDraft';

const author: TaskView = {
  task: { id: 'task', projectId: 'project', documentId: 'document', assigneeId: 'person', kind: 'author', status: 'assigned', revision: 0, title: 'Book · Explanation 1/3', createdAt: '2026-10-03T00:00:00Z' },
  document: { id: 'document', projectId: 'project', title: 'Book', hash: 'hash', version: 1, blockCount: 1, sections: [] },
  annotationMode: 'single_annotator', draft: null,
};

test('assigned author types initialize correctly without inventing question, answer, or evidence', () => {
  for (const assignedQuestionType of ['factual', 'explanatory', 'multi_section'] as const) {
    const view = { ...author, task: { ...author.task, assignedQuestionType } };
    const draft = initialDraft(view);
    assert.equal(draft.questionType, assignedQuestionType);
    assert.equal(draft.question, '');
    assert.equal(draft.answer, '');
    assert.deepEqual(draft.evidenceSets, [[]]);
    assert.equal(view.draft, null);
  }
});

test('resuming a draft preserves its content and review tasks retain the original question type', () => {
  const existing: AnnotationDraft = { question: 'Human question', questionType: 'multi_section', answer: 'Human answer', evidenceSets: [[{ blockId: 'block', start: 0, end: 4, quote: 'Text' }]], note: 'Human note' };
  const resumed = initialDraft({ ...author, draft: existing, task: { ...author.task, assignedQuestionType: 'multi_section' } });
  assert.deepEqual(resumed, existing);
  resumed.evidenceSets[0]![0]!.quote = 'Changed clone';
  assert.equal(existing.evidenceSets[0]![0]!.quote, 'Text');
  assert.equal(initialDraft({ ...author, questionType: 'explanatory', task: { ...author.task, kind: 'review' } }).questionType, 'explanatory');
  assert.equal(initialDraft(author).questionType, 'factual');
});
