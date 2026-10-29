import { expect, it } from 'vitest';
import { isCurrentSnapshot } from '../lib/domain/task-events';
import { conversation } from './fixtures';
import type { TaskSnapshot } from '../types';
const current: TaskSnapshot = {
  streamId: 'new',
  startedAt: 200,
  sequence: 5,
  tabId: 1,
  pageKey: 'page',
  status: 'done',
  conversation: conversation(),
};
it('does not regress a completed answer when the start acknowledgement arrives late', () => {
  expect(isCurrentSnapshot(current, { ...current, sequence: 1, status: 'running' }, null)).toBe(
    false,
  );
});
it('rejects old tasks and allows a newer task started in another panel', () => {
  expect(
    isCurrentSnapshot(current, { ...current, streamId: 'old', startedAt: 100, sequence: 99 }, null),
  ).toBe(false);
  expect(
    isCurrentSnapshot(current, { ...current, streamId: 'next', startedAt: 201, sequence: 1 }, null),
  ).toBe(true);
});
it('ignores any other stream while the current user request is starting', () => {
  expect(
    isCurrentSnapshot(current, { ...current, streamId: 'other', startedAt: 500 }, 'requested'),
  ).toBe(false);
  expect(
    isCurrentSnapshot(current, { ...current, streamId: 'requested', startedAt: 500 }, 'requested'),
  ).toBe(true);
});
