import type { PageRefreshJob, PageSource, TaskSnapshot } from '../../types';
import { isReadableUrl, pageKey } from '../domain/page';
import type { Repository } from '../storage/repository';
import { errorText } from '../platform/rpc';

export const refreshPending = (job: PageRefreshJob | null | undefined) =>
  !!job && ['refreshing', 'extracting', 'starting'].includes(job.status);
interface Dependencies {
  tab(tabId: number): Promise<{ url?: string; pendingUrl?: string }>;
  validate(): Promise<void>;
  snapshot(tabId: number, key: string): Promise<TaskSnapshot | null>;
  reload(tabId: number, key: string, signal: AbortSignal): Promise<void>;
  restore(job: PageRefreshJob): Promise<void>;
  extract(tabId: number, key: string): Promise<PageSource>;
  start(job: PageRefreshJob, source: PageSource): Promise<TaskSnapshot>;
  stop(tabId: number, streamId: string): Promise<void>;
}
export class PageRefreshManager {
  private starts = new Map<number, Promise<unknown>>();
  private controllers = new Map<string, AbortController>();
  private failures = new Map<number, PageRefreshJob>();
  constructor(
    private session: Repository,
    private deps: Dependencies,
  ) {}
  private async check(job: Pick<PageRefreshJob, 'tabId' | 'pageKey'>) {
    const tab = await this.deps.tab(job.tabId);
    if (
      !isReadableUrl(tab.url) ||
      pageKey(tab.url || '') !== job.pageKey ||
      (tab.pendingUrl && pageKey(tab.pendingUrl) !== job.pageKey)
    )
      throw new Error('来源页面已变化，请在当前页面重新操作。');
  }
  async get(tabId: number, key: string) {
    const saved = await this.session.refreshJob(tabId);
    const failure = this.failures.get(tabId);
    const job = failure?.id === saved?.id ? failure : saved;
    return job?.pageKey === key ? job : null;
  }
  async active() {
    return (await this.session.refreshJobs()).some((job) => {
      const failed = this.failures.get(job.tabId);
      return refreshPending(failed?.id === job.id ? failed : job);
    });
  }
  async recover() {
    for (const job of await this.session.refreshJobs()) {
      if (!refreshPending(job)) continue;
      const snapshot = await this.deps.snapshot(job.tabId, job.pageKey).catch(() => null);
      const next: PageRefreshJob = {
        ...job,
        updatedAt: Math.max(Date.now(), job.updatedAt + 1),
        status: snapshot?.streamId === job.streamId ? 'started' : 'error',
        error:
          snapshot?.streamId === job.streamId
            ? undefined
            : '刷新摘要已中断，请点击「刷新页面并摘要」重试。',
      };
      await this.session.saveRefreshJob(next).catch(() => this.failures.set(job.tabId, next));
    }
  }
  start(tabId: number, key: string, mode: PageRefreshJob['mode']): Promise<PageRefreshJob> {
    const previous = this.starts.get(tabId) || Promise.resolve();
    const result = previous
      .catch(() => {})
      .then(async () => {
        const saved = await this.session.refreshJob(tabId);
        const failed = this.failures.get(tabId);
        const old = failed?.id === saved?.id ? failed : saved;
        if (refreshPending(old) || (old && this.controllers.has(old.id)))
          throw new Error('此页面正在刷新或重新读取，请稍候。');
        await this.check({ tabId, pageKey: key });
        await this.deps.validate();
        const createdAt = Math.max(Date.now(), (old?.createdAt || 0) + 1);
        const job: PageRefreshJob = {
          id: crypto.randomUUID(),
          streamId: crypto.randomUUID(),
          tabId,
          pageKey: key,
          mode,
          status: 'refreshing',
          createdAt,
          updatedAt: createdAt,
        };
        await this.session.saveRefreshJob(job);
        this.failures.delete(tabId);
        try {
          if ((await this.deps.snapshot(tabId, key))?.status === 'running')
            throw new Error('此页面正在生成回答，请先停止。');
        } catch (error) {
          await this.publish(job, 'error', errorText(error)).catch(() => {
            this.failures.set(job.tabId, { ...job });
          });
          throw error;
        }
        const controller = new AbortController();
        this.controllers.set(job.id, controller);
        void this.run(job, controller);
        return job;
      });
    this.starts.set(tabId, result);
    void result
      .finally(() => {
        if (this.starts.get(tabId) === result) this.starts.delete(tabId);
      })
      .catch(() => {});
    return result;
  }
  private async publish(job: PageRefreshJob, status: PageRefreshJob['status'], error?: string) {
    const current = await this.session.refreshJob(job.tabId);
    if (current?.id !== job.id) throw new Error('刷新任务已被替换。');
    job.status = status;
    job.error = error;
    job.updatedAt = Math.max(Date.now(), job.updatedAt + 1);
    try {
      await this.session.saveRefreshJob({ ...job });
    } catch {
      throw new Error('刷新状态保存失败，请重试。');
    }
  }
  private async run(job: PageRefreshJob, controller: AbortController) {
    let loaded = false,
      restored = false;
    try {
      await this.deps.reload(job.tabId, job.pageKey, controller.signal);
      loaded = true;
      controller.signal.throwIfAborted();
      await this.check(job);
      await this.publish(job, 'extracting');
      await this.deps.restore(job);
      restored = true;
      const source = await this.deps.extract(job.tabId, job.pageKey);
      controller.signal.throwIfAborted();
      await this.check(job);
      if (source.pageKey !== job.pageKey) throw new Error('提取来源已变化，请重试。');
      await this.publish(job, 'starting');
      controller.signal.throwIfAborted();
      await this.deps.start(job, source);
      if (controller.signal.aborted) {
        try {
          await this.deps.stop(job.tabId, job.streamId);
        } catch {
          await this.publish(job, 'error', '取消摘要失败，请在面板中再次点击停止。');
          return;
        }
        controller.signal.throwIfAborted();
      }
      await this.publish(job, 'started');
    } catch (error) {
      await this.publish(
        job,
        controller.signal.aborted ? 'cancelled' : 'error',
        controller.signal.aborted ? '已取消刷新后的摘要。' : errorText(error),
      ).catch(() => {
        this.failures.set(job.tabId, { ...job });
      });
    } finally {
      this.controllers.delete(job.id);
      if (loaded && !restored) {
        await this.check(job)
          .then(() => this.deps.restore(job))
          .catch(() => {});
      }
    }
  }
  async cancel(tabId: number, id: string) {
    const job = await this.session.refreshJob(tabId);
    if (!job || job.id !== id) return;
    if (job.status === 'started') {
      await this.deps.stop(tabId, job.streamId);
      return;
    }
    if (!refreshPending(job)) return;
    this.controllers.get(id)?.abort();
  }
}
