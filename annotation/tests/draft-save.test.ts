import assert from 'node:assert/strict';
import test from 'node:test';
import { saveLatestDraft } from '../web/saveLatestDraft';

test('flush waits for the latest edit made while an earlier save is in flight', async () => {
  let current = 'first edit';
  let saved = 'original';
  let finishFirst!: () => void;
  let finishSecond!: () => void;
  let secondStarted!: () => void;
  const firstResponse = new Promise<void>(resolve => { finishFirst = resolve; });
  const secondResponse = new Promise<void>(resolve => { finishSecond = resolve; });
  const secondRequest = new Promise<void>(resolve => { secondStarted = resolve; });
  const requests: string[] = [];
  let finished = false;
  const saving = saveLatestDraft(() => current === saved ? null : current, async value => {
    requests.push(value);
    if (requests.length === 1) await firstResponse;
    else { secondStarted(); await secondResponse; }
    saved = value;
  }).then(() => { finished = true; });

  assert.deepEqual(requests, ['first edit']);
  current = 'edit while first request is pending';
  finishFirst();
  await secondRequest;
  assert.equal(finished, false);
  assert.deepEqual(requests, ['first edit', 'edit while first request is pending']);
  finishSecond();
  await saving;
  assert.equal(saved, current);
  assert.equal(finished, true);
});

test('a failed save rejects flush, preserves the latest pending draft, and allows retry', async () => {
  let current = 'first edit';
  let saved = 'original';
  let fail!: (error: Error) => void;
  const response = new Promise<void>((_, reject) => { fail = reject; });
  const readPending = () => current === saved ? null : current;
  const saving = saveLatestDraft(readPending, async value => { await response; saved = value; });
  const rejection = assert.rejects(saving, /connection failed/);
  current = 'latest local edit';
  fail(new Error('connection failed'));
  await rejection;
  assert.equal(saved, 'original');
  assert.equal(readPending(), 'latest local edit');
  const retryRequests: string[] = [];
  await saveLatestDraft(readPending, async value => { retryRequests.push(value); saved = value; });
  assert.deepEqual(retryRequests, ['latest local edit']);
  assert.equal(readPending(), null);
});
