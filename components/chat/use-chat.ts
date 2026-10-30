import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Conversation,
  EngineEvent,
  PageRefreshJob,
  PageSource,
  TaskSnapshot,
} from '../../types';
import { pageKey } from '../../lib/domain/page';
import { isCurrentSnapshot } from '../../lib/domain/task-events';
import { rpc, errorText } from '../../lib/platform/rpc';
import { grantPageAccess } from '../../lib/platform/permissions';
import { refreshPending } from '../../lib/engine/page-refresh';

export function useChat() {
  const params = new URLSearchParams(location.search);
  const fixedTab = params.has('tabId') ? Number(params.get('tabId')) : null;
  const [tab, setTab] = useState<chrome.tabs.Tab | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [phase, setPhase] = useState<
    'loading' | 'idle' | 'refreshing' | 'extracting' | 'starting' | 'running'
  >('loading');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const identity = useRef('');
  const stream = useRef<string | null>(null);
  const latest = useRef<TaskSnapshot | null>(null);
  const requestedStream = useRef<string | null>(null);
  const actionPending = useRef(false);
  const mounted = useRef(true);
  const currentTab = useRef<chrome.tabs.Tab | null>(null);
  const tabQuery = useRef(0);
  const refreshJob = useRef<PageRefreshJob | null>(null);
  const cancelRefresh = useRef(false);
  const acceptSnapshot = useCallback((snapshot: TaskSnapshot) => {
    if (!mounted.current || identity.current !== `${snapshot.tabId}:${snapshot.pageKey}`) return;
    if (!isCurrentSnapshot(latest.current, snapshot, requestedStream.current)) return;
    latest.current = snapshot;
    requestedStream.current = null;
    stream.current = snapshot.streamId;
    actionPending.current = false;
    setConversation(snapshot.conversation);
    setPhase(snapshot.status === 'running' ? 'running' : 'idle');
    setError(snapshot.error || '');
    setProgress(snapshot.status === 'running' ? snapshot.progress || '' : '');
  }, []);
  const acceptRefresh = useCallback(
    (job: PageRefreshJob) => {
      if (!mounted.current || identity.current !== `${job.tabId}:${job.pageKey}`) return;
      const previous = refreshJob.current;
      if (
        previous &&
        (job.createdAt < previous.createdAt ||
          (job.id === previous.id && job.updatedAt < previous.updatedAt))
      )
        return;
      refreshJob.current = job;
      // Model events are authoritative once generation has begun, including a
      // concurrent task that won the race before the refresh reservation.
      if (
        latest.current &&
        (latest.current.status === 'running' || latest.current.startedAt >= job.createdAt)
      )
        return;
      if (refreshPending(job)) {
        actionPending.current = true;
        requestedStream.current = job.streamId;
        setPhase('refreshing');
        setError('');
        setProgress(
          job.status === 'refreshing'
            ? '正在刷新页面，等待加载完成…'
            : job.status === 'extracting'
              ? '页面已刷新，正在重新读取内容…'
              : '正在启动新摘要…',
        );
      } else if (job.status === 'started') {
        requestedStream.current = job.streamId;
        void rpc<TaskSnapshot | null>({
          type: 'task:snapshot',
          tabId: job.tabId,
          pageKey: job.pageKey,
        })
          .then(async (snapshot) => {
            if (snapshot?.streamId === job.streamId) {
              acceptSnapshot(snapshot);
              return;
            }
            const saved = await rpc<Conversation | null>({
              type: 'conversation:get',
              pageKey: job.pageKey,
            });
            if (
              !mounted.current ||
              identity.current !== `${job.tabId}:${job.pageKey}` ||
              refreshJob.current?.id !== job.id ||
              (latest.current && latest.current.startedAt >= job.createdAt)
            )
              return;
            if (saved?.revision === job.streamId) {
              setConversation(saved);
              setError('');
            } else setError('摘要状态暂时无法恢复，请重新打开面板。');
            actionPending.current = false;
            requestedStream.current = null;
            setPhase('idle');
            setProgress('');
          })
          .catch((error) => {
            if (
              !mounted.current ||
              identity.current !== `${job.tabId}:${job.pageKey}` ||
              (latest.current && latest.current.startedAt >= job.createdAt)
            )
              return;
            actionPending.current = false;
            requestedStream.current = null;
            setPhase('idle');
            setError(errorText(error));
          });
      } else {
        actionPending.current = false;
        requestedStream.current = null;
        setPhase('idle');
        setProgress('');
        setError(job.error || '刷新摘要未完成，请重试。');
      }
    },
    [acceptSnapshot],
  );
  const load = useCallback(async () => {
    const query = ++tabQuery.current;
    let expectedIdentity = identity.current;
    try {
      const target =
        fixedTab !== null
          ? await chrome.tabs.get(fixedTab)
          : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
      if (!mounted.current || query !== tabQuery.current) return;
      if (!target?.id) {
        setError('没有可处理的网页。');
        setPhase('idle');
        return;
      }
      const key = pageKey(target.url || '');
      const nextIdentity = `${target.id}:${key}`;
      expectedIdentity = nextIdentity;
      setTab(target);
      currentTab.current = target;
      if (identity.current === nextIdentity) return;
      identity.current = nextIdentity;
      stream.current = null;
      latest.current = null;
      requestedStream.current = null;
      refreshJob.current = null;
      actionPending.current = false;
      setConversation(null);
      setProgress('');
      setError('');
      setPhase('loading');
      const [saved, snapshot, refreshing] = await Promise.all([
        rpc<Conversation | null>({ type: 'conversation:get', pageKey: key }),
        rpc<TaskSnapshot | null>({ type: 'task:snapshot', tabId: target.id, pageKey: key }),
        rpc<PageRefreshJob | null>({ type: 'page:refresh-status', tabId: target.id, pageKey: key }),
      ]);
      if (!mounted.current || identity.current !== nextIdentity) return;
      // An engine event may have arrived while storage was being read.
      if (stream.current) {
        if (refreshing) acceptRefresh(refreshing);
        return;
      }
      if (snapshot) acceptSnapshot(snapshot);
      else {
        setConversation(saved);
        setPhase('idle');
      }
      if (
        refreshing &&
        (!saved || saved.updatedAt < refreshing.createdAt || refreshPending(refreshing))
      )
        acceptRefresh(refreshing);
    } catch (e) {
      if (mounted.current && identity.current === expectedIdentity) {
        setError(errorText(e));
        setPhase('idle');
      }
    }
  }, [fixedTab, acceptSnapshot, acceptRefresh]);
  useEffect(() => {
    mounted.current = true;
    void load();
    const message = (event: EngineEvent, sender: chrome.runtime.MessageSender) => {
      if (
        event?.channel !== 'glintab:event' ||
        sender.id !== chrome.runtime.id ||
        !sender.url?.startsWith(chrome.runtime.getURL('/offscreen.html'))
      )
        return;
      acceptSnapshot(event.snapshot);
    };
    const activated = () => {
      if (fixedTab === null) void load();
    };
    const updated = (id: number, changes: chrome.tabs.OnUpdatedInfo) => {
      if (id === currentTab.current?.id && (changes.url || changes.status === 'complete'))
        void load();
    };
    const removed = (id: number) => {
      if (id === currentTab.current?.id) {
        identity.current = '';
        setTab(null);
        setConversation(null);
        setPhase('idle');
        setError('来源标签页已关闭，请在其他网页重新打开 Glintab。');
      }
    };
    const storageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area === 'session') {
        const job = changes['page-refresh:' + currentTab.current?.id]?.newValue as
          PageRefreshJob | undefined;
        if (job) acceptRefresh(job);
        return;
      }
      if (area !== 'local' || !changes.config || changes.config.newValue) return;
      // A successful clear also removes in-memory history in already-open panels.
      stream.current = null;
      latest.current = null;
      requestedStream.current = null;
      setConversation(null);
      setError('');
      setPhase('idle');
    };
    chrome.runtime.onMessage.addListener(message);
    chrome.tabs.onActivated.addListener(activated);
    chrome.tabs.onUpdated.addListener(updated);
    chrome.tabs.onRemoved.addListener(removed);
    chrome.storage.onChanged.addListener(storageChanged);
    return () => {
      mounted.current = false;
      chrome.runtime.onMessage.removeListener(message);
      chrome.tabs.onActivated.removeListener(activated);
      chrome.tabs.onUpdated.removeListener(updated);
      chrome.tabs.onRemoved.removeListener(removed);
      chrome.storage.onChanged.removeListener(storageChanged);
    };
  }, [load, fixedTab, acceptSnapshot, acceptRefresh]);
  useEffect(() => {
    if (phase !== 'refreshing' || !tab?.id) return;
    let alive = true;
    const timer = setInterval(() => {
      void rpc<PageRefreshJob | null>({
        type: 'page:refresh-status',
        tabId: tab.id!,
        pageKey: pageKey(tab.url || ''),
      })
        .then((job) => {
          if (alive && job) acceptRefresh(job);
        })
        .catch((error) => {
          if (!alive) return;
          if (latest.current?.status === 'running') return;
          actionPending.current = false;
          setError(errorText(error));
          setPhase('idle');
        });
    }, 800);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [phase, tab?.id, tab?.url, acceptRefresh]);

  async function send(question: string, summary = false, refresh = false, editMessageId?: string) {
    const sourceTab = currentTab.current;
    if (
      !sourceTab?.id ||
      actionPending.current ||
      ['running', 'refreshing', 'extracting', 'starting', 'loading'].includes(phase)
    )
      return false;
    const expected = identity.current;
    const key = pageKey(sourceTab.url || '');
    actionPending.current = true;
    setError('');
    try {
      let next = conversation;
      if (!next || refresh) {
        setPhase('extracting');
        const source = await rpc<PageSource>({
          type: 'page:extract',
          tabId: sourceTab.id,
          expectedPageKey: key,
        });
        if (identity.current !== expected) return false;
        next = {
          id: crypto.randomUUID(),
          source,
          messages: [],
          updatedAt: Date.now(),
          revision: '',
        };
        setConversation(next);
      } else if (summary) next = { ...next, messages: [], notice: undefined };
      if (identity.current !== expected) return false;
      setPhase('starting');
      const streamId = crypto.randomUUID();
      stream.current = streamId;
      requestedStream.current = streamId;
      const snapshot = await rpc<TaskSnapshot>({
        type: 'task:start',
        tabId: sourceTab.id,
        conversation: next,
        question,
        summary,
        streamId,
        editMessageId,
      });
      if (identity.current !== expected) return false;
      acceptSnapshot(snapshot);
      return true;
    } catch (e) {
      if (identity.current === expected) {
        setError(errorText(e));
        setPhase('idle');
        stream.current = null;
        requestedStream.current = null;
      }
      return false;
    } finally {
      if (identity.current === expected) actionPending.current = false;
    }
  }
  async function refreshAndSummarize() {
    const sourceTab = currentTab.current;
    if (!sourceTab?.id || phase !== 'idle' || actionPending.current) return false;
    const expected = identity.current;
    actionPending.current = true;
    cancelRefresh.current = false;
    setPhase('refreshing');
    setProgress('正在刷新页面，等待加载完成…');
    setError('');
    try {
      const mode = params.get('mode');
      const job = await rpc<PageRefreshJob>({
        type: 'page:refresh-summary',
        tabId: sourceTab.id,
        expectedPageKey: pageKey(sourceTab.url || ''),
        mode: mode === 'drawer' || mode === 'window' ? mode : 'sidepanel',
      });
      if (!mounted.current || identity.current !== expected) return false;
      acceptRefresh(job);
      if (cancelRefresh.current)
        await rpc({ type: 'page:refresh-cancel', tabId: job.tabId, refreshId: job.id });
      return true;
    } catch (error) {
      if (mounted.current && identity.current === expected) {
        actionPending.current = false;
        setError(errorText(error));
        setPhase(latest.current?.status === 'running' ? 'running' : 'idle');
      }
      return false;
    }
  }
  async function stop() {
    if (phase === 'refreshing') {
      cancelRefresh.current = true;
      const job = refreshJob.current;
      if (job && refreshPending(job)) {
        try {
          setProgress('正在取消刷新后的摘要…');
          await rpc({ type: 'page:refresh-cancel', tabId: job.tabId, refreshId: job.id });
        } catch (error) {
          setError(errorText(error));
        }
      }
      return;
    }
    if (!tab?.id || !stream.current) return;
    try {
      await rpc({ type: 'task:cancel', tabId: tab.id, streamId: stream.current });
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function authorize(allSites: boolean) {
    if (!tab?.url) return;
    const expected = identity.current;
    try {
      await grantPageAccess(tab.url, allSites);
      if (mounted.current && identity.current === expected) setError('');
    } catch (e) {
      if (mounted.current && identity.current === expected) setError(errorText(e));
    }
  }
  return {
    tab,
    conversation,
    phase,
    error,
    progress,
    setError,
    send,
    refreshAndSummarize,
    stop,
    authorize,
    busy: phase !== 'idle',
  };
}
