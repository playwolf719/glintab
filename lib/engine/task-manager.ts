import type { EngineEvent, PageSource, StartTask, TaskSnapshot } from '../../types';
import { buildContext } from '../domain/context';
import { streamCompletion } from '../llm/client';
import { errorText } from '../platform/rpc';

type Complete = typeof streamCompletion;
interface RunningTask {
  snapshot: TaskSnapshot;
  controller: AbortController;
  lastEmit: number;
  timer: ReturnType<typeof setTimeout>;
}
export class TaskManager {
  private tasks = new Map<string, RunningTask>();
  private snapshots = new Map<string, TaskSnapshot>();
  private seen = new Map<string, { tabId: number; pageKey: string }>();
  constructor(
    private emit: (event: EngineEvent) => Promise<void>,
    private complete: Complete = streamCompletion,
    private prepare?: (
      input: StartTask,
      signal: AbortSignal,
      progress: (text: string) => void,
    ) => Promise<PageSource>,
  ) {}
  private key(tabId: number, pageKey: string) {
    return `${tabId}:${pageKey}`;
  }
  get(tabId: number, pageKey: string) {
    return this.snapshots.get(this.key(tabId, pageKey)) || null;
  }
  active() {
    return [...this.tasks.values()].map((task) => task.snapshot);
  }
  cancel(tabId: number, streamId: string) {
    for (const task of this.tasks.values())
      if (task.snapshot.tabId === tabId && task.snapshot.streamId === streamId)
        task.controller.abort();
  }
  start(input: StartTask): TaskSnapshot {
    const key = this.key(input.tabId, input.conversation.source.pageKey);
    const previous = this.seen.get(input.streamId);
    if (previous) {
      if (previous.tabId !== input.tabId || previous.pageKey !== input.conversation.source.pageKey)
        throw new Error('任务 ID 与来源页面不匹配。');
      const snapshot = this.get(input.tabId, previous.pageKey);
      if (!snapshot || snapshot.streamId !== input.streamId)
        throw new Error('此任务已过期，请重新发送。');
      return snapshot;
    }
    if (this.tasks.has(key)) throw new Error('此页面正在生成回答，请先停止。');
    const conversation = structuredClone(input.conversation);
    if (input.editMessageId) {
      const index = conversation.messages.findIndex(
        (m) => m.id === input.editMessageId && m.role === 'user',
      );
      const lastUser = conversation.messages.findLast((m) => m.role === 'user' && !m.hidden);
      if (index < 0 || lastUser?.id !== input.editMessageId)
        throw new Error('只能编辑最后一条问题。');
      conversation.messages = conversation.messages.slice(0, index);
    }
    // Bound retention by complete turns. The source remains independent of history.
    if (conversation.messages.length > 96) conversation.messages = conversation.messages.slice(-96);
    conversation.messages.push({
      id: crypto.randomUUID(),
      role: 'user',
      content: input.question,
      hidden: input.summary || undefined,
    });
    conversation.revision = input.streamId;
    conversation.updatedAt = Date.now();
    conversation.notice = undefined;
    const snapshot: TaskSnapshot = {
      streamId: input.streamId,
      startedAt: Math.max(Date.now(), (this.snapshots.get(key)?.startedAt || 0) + 1),
      sequence: 0,
      tabId: input.tabId,
      pageKey: conversation.source.pageKey,
      status: 'running',
      conversation,
    };
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(
          new Error(
            conversation.source.video?.transcription === 'required'
              ? '音轨转写超过 20 分钟，已停止。'
              : '请求超过 5 分钟，已停止并保留收到的内容。',
          ),
        ),
      (conversation.source.video?.transcription === 'required' ? 20 : 5) * 60 * 1000,
    );
    const task: RunningTask = { snapshot, controller, timer, lastEmit: 0 };
    this.tasks.set(key, task);
    this.snapshots.set(key, snapshot);
    this.seen.set(input.streamId, { tabId: input.tabId, pageKey: snapshot.pageKey });
    if (this.seen.size > 200) this.seen.delete(this.seen.keys().next().value!);
    void this.run(key, task, input);
    return structuredClone(snapshot);
  }
  private async publish(task: RunningTask, persist: boolean) {
    task.snapshot.sequence++;
    await this.emit({
      channel: 'glintab:event',
      snapshot: structuredClone(task.snapshot),
      persist,
    });
  }
  private async run(key: string, task: RunningTask, input: StartTask) {
    const { snapshot, controller } = task;
    const conversation = snapshot.conversation;
    let partial = '';
    const assistantId = crypto.randomUUID();
    try {
      if (conversation.source.video?.transcription === 'required') {
        if (!this.prepare || !input.transcription?.enabled)
          throw new Error('当前分 P 没有字幕。请在设置 → 语音转写中配置并启用 B 站音轨转写。');
        snapshot.progress = '正在获取 B 站音轨…';
        await this.publish(task, true);
        controller.signal.throwIfAborted();
        conversation.source = await this.prepare(input, controller.signal, (text) => {
          if (controller.signal.aborted || this.tasks.get(key) !== task) return;
          snapshot.progress = text;
          if (Date.now() - task.lastEmit > 250) {
            task.lastEmit = Date.now();
            void this.publish(task, false).catch(() => {});
          }
        });
        controller.signal.throwIfAborted();
        snapshot.progress = undefined;
        // Persist the completed transcript before a summary request can fail.
        await this.publish(task, true);
        clearTimeout(task.timer);
        task.timer = setTimeout(
          () => controller.abort(new Error('模型请求超过 5 分钟，已停止。')),
          5 * 60 * 1000,
        );
      }
      controller.signal.throwIfAborted();
      const context = buildContext(conversation, input.provider, input.settings);
      if (context.reduced)
        conversation.notice =
          '为适应模型上限，本轮已缩减正文或较早的历史；可在提取内容中查看原文。';
      conversation.messages.push({ id: assistantId, role: 'assistant', content: '' });
      await this.publish(task, true);
      await this.complete(
        input.provider,
        context.system,
        context.messages,
        context.outputTokens,
        controller.signal,
        (delta) => {
          if (controller.signal.aborted || this.tasks.get(key) !== task) return;
          partial += delta;
          if (partial.length > 200000) {
            controller.abort(new Error('回答已达到长度上限。'));
            return;
          }
          conversation.messages[conversation.messages.length - 1]!.content = partial;
          if (Date.now() - task.lastEmit > 80) {
            task.lastEmit = Date.now();
            void this.publish(task, false).catch(() => {});
          }
        },
      );
      if (controller.signal.aborted) throw controller.signal.reason;
      snapshot.status = 'done';
    } catch (error) {
      const userStop = controller.signal.aborted && controller.signal.reason?.name === 'AbortError';
      snapshot.status = userStop ? 'stopped' : 'error';
      snapshot.error = userStop
        ? undefined
        : controller.signal.aborted
          ? errorText(controller.signal.reason)
          : errorText(error);
      const assistant = conversation.messages.find((m) => m.id === assistantId);
      const text = partial || (userStop ? '已停止生成。' : '本次未能生成回答，请检查提示后重试。');
      if (assistant) assistant.content = text;
      else conversation.messages.push({ id: assistantId, role: 'assistant', content: text });
      conversation.notice = userStop ? '已停止，生成内容已保留。' : snapshot.error;
    } finally {
      snapshot.progress = undefined;
      clearTimeout(task.timer);
      conversation.updatedAt = Date.now();
      try {
        await this.publish(task, true);
      } catch {
        snapshot.error = '回答已生成，但本地保存失败。请复制回答后再关闭面板。';
        snapshot.status = 'error';
        await this.publish(task, false).catch(() => {});
      }
      if (this.tasks.get(key) === task) this.tasks.delete(key);
      while (this.snapshots.size > 40) {
        const oldest = [...this.snapshots.keys()].find((candidate) => !this.tasks.has(candidate));
        if (!oldest) break;
        this.snapshots.delete(oldest);
      }
    }
  }
}
