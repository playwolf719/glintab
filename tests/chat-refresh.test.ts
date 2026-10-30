// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChat } from '../components/chat/use-chat';
import { conversation } from './fixtures';
import type { PageRefreshJob, Request, TaskSnapshot } from '../types';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/platform/rpc', () => ({
  rpc,
  errorText: (error: unknown) => (error as Error).message,
}));
function events() {
  const handlers = new Set<(...args: any[]) => void>();
  return {
    addListener: (fn: (...args: any[]) => void) => handlers.add(fn),
    removeListener: (fn: (...args: any[]) => void) => handlers.delete(fn),
    emit: (...args: any[]) => handlers.forEach((fn) => fn(...args)),
  };
}
let root: Root, container: HTMLDivElement;
let chat: ReturnType<typeof useChat>;
let storage: ReturnType<typeof events>, messages: ReturnType<typeof events>;
let job: PageRefreshJob | null;
const saved = conversation('https://article.test/read');
const accepted: PageRefreshJob = {
  id: 'refresh-id',
  streamId: 'fresh-stream',
  tabId: 1,
  pageKey: saved.source.pageKey,
  mode: 'window',
  status: 'refreshing',
  createdAt: Date.now() + 100,
  updatedAt: Date.now() + 100,
};
function Probe() {
  chat = useChat();
  return null;
}
beforeEach(async () => {
  vi.clearAllMocks();
  job = null;
  storage = events();
  messages = events();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('location', new URL('chrome-extension://test/sidepanel.html?tabId=1&mode=window'));
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'test',
      getURL: (path: string) => 'chrome-extension://test' + path,
      onMessage: messages,
    },
    tabs: {
      get: vi.fn(async () => ({ id: 1, url: saved.source.url, title: 'Source' })),
      onActivated: events(),
      onUpdated: events(),
      onRemoved: events(),
    },
    storage: { onChanged: storage },
  });
  rpc.mockImplementation(async (request: Request) => {
    if (request.type === 'conversation:get') return saved;
    if (request.type === 'task:snapshot') return null;
    if (request.type === 'page:refresh-status') return job;
    if (request.type === 'page:refresh-summary') {
      job = { ...accepted };
      return job;
    }
    if (request.type === 'page:refresh-cancel') return;
    throw new Error(`Unexpected request: ${request.type}`);
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(Probe)));
  expect(chat.phase).toBe('idle');
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('starts once, reconnects after the refresh destroys the original panel, and ignores old task events', async () => {
  await act(async () => {
    await chat.refreshAndSummarize();
  });
  expect(chat.phase).toBe('refreshing');
  await act(async () => {
    expect(await chat.send('another question')).toBe(false);
  });
  expect(
    rpc.mock.calls.filter(([request]) => request.type === 'page:refresh-summary'),
  ).toHaveLength(1);
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(createElement(Probe)));
  expect(chat.phase).toBe('refreshing');
  expect(
    rpc.mock.calls.filter(([request]) => request.type === 'page:refresh-summary'),
  ).toHaveLength(1);
  const snapshot: TaskSnapshot = {
    streamId: accepted.streamId,
    startedAt: accepted.createdAt + 1,
    sequence: 1,
    tabId: 1,
    pageKey: accepted.pageKey,
    status: 'running',
    conversation: {
      ...saved,
      revision: accepted.streamId,
      source: { ...saved.source, content: '刷新后的内容' },
    },
  };
  const emit = (value: TaskSnapshot) =>
    messages.emit(
      { channel: 'glintab:event', snapshot: value },
      { id: 'test', url: 'chrome-extension://test/offscreen.html' },
    );
  await act(async () => {
    emit({ ...snapshot, streamId: 'old-stream', status: 'done', startedAt: 1 });
  });
  expect(chat.phase).toBe('refreshing');
  await act(async () => {
    emit(snapshot);
  });
  expect(chat.phase).toBe('running');
  expect(chat.conversation?.source.content).toBe('刷新后的内容');
  await act(async () => {
    emit({ ...snapshot, status: 'done', sequence: 2 });
  });
  expect(chat.phase).toBe('idle');
});
it('honors a cancellation clicked before the background acceptance arrives', async () => {
  let release!: (value: PageRefreshJob) => void;
  const wait = new Promise<PageRefreshJob>((resolve) => {
    release = resolve;
  });
  rpc.mockImplementation(async (request: Request) => {
    if (request.type === 'page:refresh-summary') return wait;
    if (request.type === 'page:refresh-cancel') return;
    if (request.type === 'page:refresh-status') return null;
    throw new Error('Unexpected request');
  });
  let operation!: Promise<boolean>;
  await act(async () => {
    operation = chat.refreshAndSummarize();
  });
  await act(async () => {
    await chat.stop();
  });
  await act(async () => {
    release({ ...accepted });
    await operation;
  });
  expect(rpc).toHaveBeenCalledWith({
    type: 'page:refresh-cancel',
    tabId: 1,
    refreshId: accepted.id,
  });
});
it('keeps the old conversation and restores input state when the refresh cannot start', async () => {
  rpc.mockRejectedValueOnce(new Error('刷新状态保存失败'));
  await act(async () => {
    expect(await chat.refreshAndSummarize()).toBe(false);
  });
  expect(chat.phase).toBe('idle');
  expect(chat.error).toContain('保存失败');
  expect(chat.conversation?.id).toBe(saved.id);
});
