import { useCallback, useEffect, useRef, useState } from 'react';
import type { Conversation, EngineEvent, PageSource, Settings, TaskSnapshot } from '../../types';
import { pageKey } from '../../lib/domain/page';
import { isCurrentSnapshot } from '../../lib/domain/task-events';
import { rpc, errorText } from '../../lib/platform/rpc';
import { grantPageAccess } from '../../lib/platform/permissions';

export function useChat(settings: Settings) {
  const params = new URLSearchParams(location.search);
  const fixedTab = params.has('tabId') ? Number(params.get('tabId')) : null;
  const [tab, setTab] = useState<chrome.tabs.Tab | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [phase, setPhase] = useState<'loading' | 'idle' | 'extracting' | 'starting' | 'running'>(
    'loading',
  );
  const [error, setError] = useState('');
  const identity = useRef('');
  const stream = useRef<string | null>(null);
  const latest = useRef<TaskSnapshot | null>(null);
  const requestedStream = useRef<string | null>(null);
  const actionPending = useRef(false);
  const mounted = useRef(true);
  const currentTab = useRef<chrome.tabs.Tab | null>(null);
  const tabQuery = useRef(0);
  const acceptSnapshot = useCallback((snapshot: TaskSnapshot) => {
    if (!mounted.current || identity.current !== `${snapshot.tabId}:${snapshot.pageKey}`) return;
    if (!isCurrentSnapshot(latest.current, snapshot, requestedStream.current)) return;
    latest.current = snapshot;
    requestedStream.current = null;
    stream.current = snapshot.streamId;
    setConversation(snapshot.conversation);
    setPhase(snapshot.status === 'running' ? 'running' : 'idle');
    setError(snapshot.error || '');
  }, []);
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
      actionPending.current = false;
      setConversation(null);
      setError('');
      setPhase('loading');
      const [saved, snapshot] = await Promise.all([
        rpc<Conversation | null>({ type: 'conversation:get', pageKey: key }),
        rpc<TaskSnapshot | null>({ type: 'task:snapshot', tabId: target.id, pageKey: key }),
      ]);
      if (!mounted.current || identity.current !== nextIdentity) return;
      // An engine event may have arrived while storage was being read.
      if (stream.current) return;
      if (snapshot) acceptSnapshot(snapshot);
      else {
        setConversation(saved);
        setPhase('idle');
      }
    } catch (e) {
      if (mounted.current && identity.current === expectedIdentity) {
        setError(errorText(e));
        setPhase('idle');
      }
    }
  }, [fixedTab, acceptSnapshot]);
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
  }, [load, fixedTab, acceptSnapshot]);

  async function send(question: string, summary = false, refresh = false, editMessageId?: string) {
    const sourceTab = currentTab.current;
    if (
      !sourceTab?.id ||
      actionPending.current ||
      ['running', 'extracting', 'starting', 'loading'].includes(phase)
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
        question: summary ? settings.webPrompt : question,
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
  async function stop() {
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
    setError,
    send,
    stop,
    authorize,
    busy: phase !== 'idle',
  };
}
