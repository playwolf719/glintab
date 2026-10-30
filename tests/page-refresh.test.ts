import { expect, it, vi } from 'vitest';
import { PageRefreshManager } from '../lib/engine/page-refresh';
import { Repository } from '../lib/storage/repository';
import { memoryStorage } from './helpers/browser-auth';
import { conversation } from './fixtures';
import type { PageRefreshJob, PageSource, TaskSnapshot } from '../types';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup() {
  const storage = memoryStorage();
  const session = new Repository(storage);
  const load = deferred<void>();
  let url = 'https://article.test/read';
  const fresh = { ...conversation(url).source, content: '页面刷新后的最新内容' };
  const snapshot = (job: PageRefreshJob, source: PageSource): TaskSnapshot => ({
    streamId: job.streamId,
    tabId: job.tabId,
    pageKey: source.pageKey,
    startedAt: Date.now(),
    sequence: 1,
    status: 'running',
    conversation: { ...conversation(source.url), source, revision: job.streamId },
  });
  const deps = {
    tab: vi.fn(async () => ({ url })),
    validate: vi.fn(async () => {}),
    snapshot: vi.fn(async (): Promise<TaskSnapshot | null> => null),
    reload: vi.fn(async (_id: number, _key: string, signal: AbortSignal) => {
      signal.addEventListener('abort', () => load.reject(signal.reason), { once: true });
      return load.promise;
    }),
    restore: vi.fn(async () => {}),
    extract: vi.fn(async () => fresh),
    start: vi.fn(async (job: PageRefreshJob, source: PageSource) => snapshot(job, source)),
    stop: vi.fn(async () => {}),
  };
  const manager = new PageRefreshManager(session, deps);
  const wait = async (status: PageRefreshJob['status']) => {
    await vi.waitFor(async () =>
      expect((await manager.get(1, fresh.pageKey))?.status).toBe(status),
    );
  };
  return {
    storage,
    session,
    manager,
    deps,
    fresh,
    load,
    snapshot,
    wait,
    navigate: (next: string) => {
      url = next;
    },
  };
}
it('persists the refresh before reloading, then restores, extracts fresh content and starts exactly one summary', async () => {
  const value = setup();
  const job = await value.manager.start(1, value.fresh.pageKey, 'drawer');
  expect((await value.session.refreshJob(1))?.id).toBe(job.id);
  expect(job.id).not.toBe(job.streamId);
  expect(value.deps.reload).toHaveBeenCalledOnce();
  expect(value.deps.extract).not.toHaveBeenCalled();
  expect(value.deps.start).not.toHaveBeenCalled();
  value.load.resolve();
  await value.wait('started');
  expect(value.deps.start).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ streamId: job.streamId }),
    value.fresh,
  );
  expect(value.deps.restore.mock.invocationCallOrder[0]!).toBeLessThan(
    value.deps.extract.mock.invocationCallOrder[0]!,
  );
  expect(await value.manager.active()).toBe(false);
});
it('rejects duplicate clicks from concurrent panels and allows cancelling without starting a model', async () => {
  const value = setup();
  const first = value.manager.start(1, value.fresh.pageKey, 'window');
  const second = value.manager.start(1, value.fresh.pageKey, 'sidepanel');
  const job = await first;
  await expect(second).rejects.toThrow('正在刷新');
  await value.manager.cancel(1, 'old-refresh-id');
  expect(await value.manager.active()).toBe(true);
  await value.manager.cancel(1, job.id);
  await value.wait('cancelled');
  expect(value.deps.reload).toHaveBeenCalledOnce();
  expect(value.deps.start).not.toHaveBeenCalled();
});
it('does not reload when validation or the initial session write fails', async () => {
  const value = setup();
  value.deps.validate.mockRejectedValueOnce(new Error('供应商未配置'));
  await expect(value.manager.start(1, value.fresh.pageKey, 'window')).rejects.toThrow('供应商');
  value.storage.fail = true;
  await expect(value.manager.start(1, value.fresh.pageKey, 'window')).rejects.toThrow('storage');
  expect(value.deps.reload).not.toHaveBeenCalled();
  expect(value.deps.start).not.toHaveBeenCalled();
});
it('honors a late cancellation after startup without stopping a different stream', async () => {
  const value = setup();
  const job = await value.manager.start(1, value.fresh.pageKey, 'window');
  value.load.resolve();
  await value.wait('started');
  await value.manager.cancel(1, 'different-refresh');
  expect(value.deps.stop).not.toHaveBeenCalled();
  await value.manager.cancel(1, job.id);
  expect(value.deps.stop).toHaveBeenCalledExactlyOnceWith(1, job.streamId);
});
it('does not replace a running task from another panel', async () => {
  const value = setup();
  value.deps.snapshot.mockResolvedValueOnce(
    value.snapshot({ streamId: 'other-stream', tabId: 1 } as PageRefreshJob, value.fresh),
  );
  await expect(value.manager.start(1, value.fresh.pageKey, 'window')).rejects.toThrow('先停止');
  expect(value.deps.reload).not.toHaveBeenCalled();
  expect(await value.manager.active()).toBe(false);
});
it('rejects a different page after loading and never summarizes it', async () => {
  const value = setup();
  await value.manager.start(1, value.fresh.pageKey, 'drawer');
  value.navigate('https://article.test/login');
  value.load.resolve();
  await value.wait('error');
  expect(value.deps.extract).not.toHaveBeenCalled();
  expect(value.deps.start).not.toHaveBeenCalled();
  expect(value.deps.restore).not.toHaveBeenCalled();
});
it('checks navigation again after extraction rather than using stale page content', async () => {
  const value = setup();
  const extracted = deferred<PageSource>();
  value.deps.extract.mockReturnValueOnce(extracted.promise);
  await value.manager.start(1, value.fresh.pageKey, 'window');
  value.load.resolve();
  await value.wait('extracting');
  value.navigate('https://article.test/another');
  extracted.resolve(value.fresh);
  await value.wait('error');
  expect(value.deps.start).not.toHaveBeenCalled();
});
it('cancels a start already in flight using its own stream ID', async () => {
  const value = setup();
  const started = deferred<TaskSnapshot>();
  value.deps.start.mockReturnValueOnce(started.promise);
  const job = await value.manager.start(1, value.fresh.pageKey, 'window');
  value.load.resolve();
  await vi.waitFor(() => expect(value.deps.start).toHaveBeenCalledOnce());
  await value.manager.cancel(1, job.id);
  started.resolve(value.snapshot(job, value.fresh));
  await value.wait('cancelled');
  expect(value.deps.stop).toHaveBeenCalledExactlyOnceWith(1, job.streamId);
});
it('recovers an interrupted preparation as an error without reloading or making a second paid request', async () => {
  const value = setup();
  const job: PageRefreshJob = {
    id: 'refresh-id',
    streamId: 'stream-id',
    tabId: 1,
    pageKey: value.fresh.pageKey,
    mode: 'drawer',
    createdAt: 1,
    updatedAt: Date.now() + 100,
    status: 'starting',
  };
  await value.session.saveRefreshJob(job);
  await value.manager.recover();
  expect((await value.manager.get(1, job.pageKey))?.error).toContain('已中断');
  expect((await value.manager.get(1, job.pageKey))?.updatedAt).toBeGreaterThan(job.updatedAt);
  expect(value.deps.reload).not.toHaveBeenCalled();
  expect(value.deps.start).not.toHaveBeenCalled();
  await value.session.saveRefreshJob(job);
  value.deps.snapshot.mockResolvedValueOnce(value.snapshot(job, value.fresh));
  await value.manager.recover();
  expect((await value.manager.get(1, job.pageKey))?.status).toBe('started');
});
it('reports transition persistence failure through status and does not call the model', async () => {
  const value = setup();
  await value.manager.start(1, value.fresh.pageKey, 'window');
  value.storage.fail = true;
  value.load.resolve();
  await value.wait('error');
  expect((await value.manager.get(1, value.fresh.pageKey))?.error).toContain('状态保存失败');
  expect(value.deps.start).not.toHaveBeenCalled();
  expect(await value.manager.active()).toBe(false);
});
