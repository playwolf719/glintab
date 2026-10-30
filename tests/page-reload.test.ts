import { afterEach, expect, it, vi } from 'vitest';
import { reloadPage } from '../lib/platform/page-reload';

function event<T extends (...args: any[]) => void>() {
  const listeners = new Set<T>();
  return {
    addListener: (callback: T) => listeners.add(callback),
    removeListener: (callback: T) => listeners.delete(callback),
    emit: (...args: Parameters<T>) => listeners.forEach((callback) => callback(...args)),
    listeners,
  };
}
function setup() {
  const updated =
    event<(id: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void>();
  const removed = event<(id: number) => void>();
  let tab = { id: 1, url: 'https://article.test/read', status: 'complete' } as chrome.tabs.Tab;
  let documentId = 'old-document';
  const reload = vi.fn(async () => {});
  vi.stubGlobal('chrome', {
    tabs: { get: vi.fn(async () => tab), reload, onUpdated: updated, onRemoved: removed },
    webNavigation: {
      getFrame: vi.fn(async () => ({ documentId, url: tab.url, errorOccurred: false })),
    },
  });
  const notify = (status: 'loading' | 'complete', id = documentId) => {
    documentId = id;
    tab = { ...tab, status };
    updated.emit(1, { status }, tab);
  };
  return {
    reload,
    updated,
    removed,
    notify,
    navigate: (url: string) => {
      tab = { ...tab, url };
      updated.emit(1, { url }, tab);
    },
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('waits for a different completed document rather than command resolution or stale completion events', async () => {
  const value = setup();
  let complete = false;
  const operation = reloadPage(1, 'https://article.test/read', new AbortController().signal).then(
    () => {
      complete = true;
    },
  );
  await vi.waitFor(() => expect(value.reload).toHaveBeenCalledOnce());
  value.notify('complete');
  value.notify('loading');
  value.notify('complete');
  await Promise.resolve();
  await Promise.resolve();
  expect(complete).toBe(false);
  value.notify('complete', 'new-document');
  await operation;
  expect(complete).toBe(true);
  expect(value.updated.listeners.size).toBe(0);
  expect(value.removed.listeners.size).toBe(0);
});
it('cleans up and rejects if navigation changes or the tab closes', async () => {
  for (const close of [false, true]) {
    const value = setup();
    const operation = reloadPage(1, 'https://article.test/read', new AbortController().signal);
    const failure = expect(operation).rejects.toThrow(close ? '已关闭' : '已跳转');
    await vi.waitFor(() => expect(value.reload).toHaveBeenCalledOnce());
    if (close) value.removed.emit(1);
    else value.navigate('https://article.test/login');
    await failure;
    expect(value.updated.listeners.size).toBe(0);
  }
});
it('supports cancellation and a bounded load timeout', async () => {
  const value = setup();
  const controller = new AbortController();
  const operation = reloadPage(1, 'https://article.test/read', controller.signal);
  const cancelled = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(value.reload).toHaveBeenCalledOnce());
  controller.abort();
  await cancelled;
  expect(value.updated.listeners.size).toBe(0);
  vi.useFakeTimers();
  const timeout = reloadPage(1, 'https://article.test/read', new AbortController().signal);
  const failed = expect(timeout).rejects.toThrow('25 秒');
  await vi.advanceTimersByTimeAsync(25001);
  await failed;
  expect(value.updated.listeners.size).toBe(0);
});
