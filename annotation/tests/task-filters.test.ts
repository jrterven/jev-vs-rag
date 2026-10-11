import assert from 'node:assert/strict';
import test from 'node:test';
import type { Task } from '../shared/types';
import { selectTasks, taskFilterOptions, type TaskFilters } from '../web/taskFilters';

function task(id: string, projectId: string, documentId: string, status: Task['status'], kind: Task['kind'] = 'author'): Task {
  return { id, projectId, projectName: projectId === 'development' ? 'Libros · desarrollo' : 'Libros · evaluación',
    documentId, documentTitle: 'Same book title', assigneeId: 'person', kind, status,
    revision: 0, title: `Same book title · ${id}`, createdAt: '2026-10-03T00:00:00Z' };
}
const tasks = [
  task('evaluation-assigned', 'evaluation', 'evaluation-book', 'assigned'),
  task('development-completed', 'development', 'development-book', 'completed'),
  task('development-draft', 'development', 'development-book', 'draft'),
  task('development-review', 'development', 'development-book', 'submitted', 'review'),
  task('development-other', 'development', 'other-book', 'assigned'),
];
const base: TaskFilters = { status: 'pending', kind: 'all', projectId: 'development', documentId: 'development-book' };

test('project/book filters isolate IDs despite identical titles and preserve status/type combinations', () => {
  const pending = selectTasks(tasks, base);
  assert.deepEqual(pending.visible.map(item => item.id), ['development-draft', 'development-review']);
  assert.equal(pending.total, 3);
  assert.equal(pending.pending, 2);
  const completed = selectTasks(tasks, { ...base, status: 'completed' });
  assert.deepEqual(completed.visible.map(item => item.id), ['development-completed']);
  assert.equal(completed.total, 3);
  assert.equal(completed.pending, 2);
  const authors = selectTasks(tasks, { ...base, kind: 'author' });
  assert.deepEqual(authors.visible.map(item => item.id), ['development-draft']);
  assert.equal(authors.total, 2);
  assert.equal(selectTasks(tasks, { ...base, documentId: 'evaluation-book' }).total, 0);
});

test('book options are deduplicated by ID and restricted to the selected project', () => {
  const all = taskFilterOptions(tasks, '');
  assert.equal(all.projects.length, 2);
  assert.equal(all.documents.length, 3);
  const development = taskFilterOptions(tasks, 'development');
  assert.deepEqual(development.documents.map(item => item.id).sort(), ['development-book', 'other-book']);
  assert(development.documents.every(item => item.projectName === 'Libros · desarrollo'));
  assert.equal(taskFilterOptions(tasks, 'missing-project').documents.length, 0);
});

test('100 tasks retain source ordering and accurate development/book counts', () => {
  const hundred = Array.from({ length: 100 }, (_, index) => {
    const book = Math.floor(index / 10);
    return task(`task-${index}`, book < 2 ? 'development' : 'evaluation', `book-${book}`, index % 10 === 9 ? 'completed' : 'assigned');
  }).reverse();
  const development = selectTasks(hundred, { ...base, documentId: '' });
  assert.equal(development.total, 20);
  assert.equal(development.pending, 18);
  assert.equal(development.visible.length, 18);
  assert.deepEqual(development.visible.map(item => item.id), hundred.filter(item => item.projectId === 'development' && item.status !== 'completed').map(item => item.id));
  const book = selectTasks(hundred, { ...base, documentId: 'book-0', status: 'completed' });
  assert.equal(book.total, 10);
  assert.equal(book.pending, 9);
  assert.deepEqual(book.visible.map(item => item.id), ['task-9']);
});
