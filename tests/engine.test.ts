import { describe, expect, it, vi } from 'vitest';
import { TaskManager } from '../lib/engine/task-manager';
import { task } from './fixtures';
import type { EngineEvent, TaskSnapshot } from '../types';
import type { streamCompletion } from '../lib/llm/client';
const completeLater = () => {
  const controls: { delta(text: string): void; finish(): void }[] = [];
  const complete = vi.fn<typeof streamCompletion>(
    (_p, _s, _m, _t, signal, delta) =>
      new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        controls.push({ delta, finish: resolve });
      }),
  );
  return { controls, complete };
};
describe('task lifetime and isolation', () => {
  it('deduplicates a retried stream and returns a recoverable snapshot', async () => {
    const { controls, complete } = completeLater();
    const manager = new TaskManager(async () => {}, complete);
    const input = task();
    manager.start(input);
    manager.start(input);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    controls[0]!.delta('partial answer');
    expect(
      manager.get(input.tabId, input.conversation.source.pageKey)?.conversation.messages.at(-1)
        ?.content,
    ).toBe('partial answer');
    controls[0]!.finish();
    await vi.waitFor(() => expect(manager.active()).toHaveLength(0));
    expect(manager.get(1, input.conversation.source.pageKey)?.status).toBe('done');
  });
  it('isolates the same URL across tabs and ignores cancellation by an old stream', async () => {
    const { controls, complete } = completeLater();
    const events: EngineEvent[] = [];
    const manager = new TaskManager(async (event) => {
      events.push(event);
    }, complete);
    const a = task(1),
      b = task(2);
    manager.start(a);
    manager.start(b);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    controls[0]!.delta('kept');
    manager.cancel(1, 'outdated');
    expect(manager.active()).toHaveLength(2);
    manager.cancel(1, a.streamId);
    await vi.waitFor(() =>
      expect(manager.get(1, a.conversation.source.pageKey)?.status).toBe('stopped'),
    );
    expect(
      manager.get(1, a.conversation.source.pageKey)?.conversation.messages.at(-1)?.content,
    ).toBe('kept');
    expect(manager.get(2, b.conversation.source.pageKey)?.status).toBe('running');
    controls[1]!.delta('other');
    controls[1]!.finish();
    await vi.waitFor(() => expect(manager.active()).toHaveLength(0));
    const sequence = events
      .filter((e) => e.snapshot.streamId === a.streamId)
      .map((e) => e.snapshot.sequence);
    expect(sequence).toEqual([...sequence].sort((x, y) => x - y));
  });
  it('edits only the last visible question and replaces its answer', async () => {
    const complete = vi
      .fn<typeof streamCompletion>()
      .mockImplementation(async (_p, _s, _m, _t, _signal, onDelta) => {
        onDelta('new answer');
      });
    const manager = new TaskManager(async () => {}, complete);
    const input = task();
    input.conversation.messages = [
      { id: 'q', role: 'user', content: 'old' },
      { id: 'a', role: 'assistant', content: 'old answer' },
    ];
    input.editMessageId = 'q';
    input.question = 'revised';
    manager.start(input);
    await vi.waitFor(() => expect(manager.active()).toHaveLength(0));
    const saved = manager.get(1, input.conversation.source.pageKey)!;
    expect(saved.conversation.messages.map((m) => m.content)).toEqual(['revised', 'new answer']);
  });
  it('surfaces storage failures and keeps the generated text in the snapshot', async () => {
    let final: TaskSnapshot | undefined;
    const manager = new TaskManager(
      async (event) => {
        if (event.persist && event.snapshot.status === 'done') throw new Error('quota');
        final = event.snapshot;
      },
      async (_p, _s, _m, _t, _signal, onDelta) => {
        onDelta('generated');
      },
    );
    manager.start(task());
    await vi.waitFor(() => expect(manager.active()).toHaveLength(0));
    expect(final?.error).toContain('本地保存失败');
    expect(final?.conversation.messages.at(-1)?.content).toBe('generated');
  });
});
