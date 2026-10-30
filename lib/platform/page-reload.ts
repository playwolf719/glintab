import { isReadableUrl, pageKey } from '../domain/page';

export async function reloadPage(
  tabId: number,
  expectedPageKey: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const initial = await chrome.tabs.get(tabId);
  if (
    !isReadableUrl(initial.url) ||
    pageKey(initial.url || '') !== expectedPageKey ||
    (initial.pendingUrl && pageKey(initial.pendingUrl) !== expectedPageKey)
  )
    throw new Error('来源页面已变化，请在当前页面重新操作。');
  const original = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
  if (!original?.documentId) throw new Error('无法确认页面文档，请等待页面加载完成后重试。');
  return new Promise((resolve, reject) => {
    let loading = false,
      finished = false;
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(updated);
      chrome.tabs.onRemoved.removeListener(removed);
      signal.removeEventListener('abort', aborted);
      if (error) reject(error);
      else resolve();
    };
    const updated = (id: number, changes: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
      if (id !== tabId) return;
      const url = tab.pendingUrl || tab.url;
      if (url && (!isReadableUrl(url) || pageKey(url) !== expectedPageKey)) {
        finish(new Error('刷新时页面已跳转，已取消重新摘要。'));
        return;
      }
      if (changes.status === 'loading') loading = true;
      // Match a newly loaded document rather than a delayed event from the old
      // page. The reload command's resolution alone does not mean loading ended.
      if (loading && changes.status === 'complete') {
        void Promise.all([
          chrome.tabs.get(tabId),
          chrome.webNavigation.getFrame({ tabId, frameId: 0 }),
        ])
          .then(([current, frame]) => {
            if (finished) return;
            if (pageKey(current.pendingUrl || current.url || '') !== expectedPageKey)
              finish(new Error('刷新时页面已跳转，已取消重新摘要。'));
            else if (frame?.errorOccurred) finish(new Error('页面加载失败，请稍后重试。'));
            else if (
              current.status === 'complete' &&
              frame?.documentId &&
              frame.documentId !== original.documentId
            )
              finish();
          })
          .catch(() => finish(new Error('无法确认刷新结果，请重试。')));
      }
    };
    const removed = (id: number) => {
      if (id === tabId) finish(new Error('来源标签页已关闭。'));
    };
    const aborted = () => finish(signal.reason || new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(
      () => finish(new Error('页面刷新超过 25 秒，请等待页面加载完成后重试。')),
      25000,
    );
    chrome.tabs.onUpdated.addListener(updated);
    chrome.tabs.onRemoved.addListener(removed);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) {
      aborted();
      return;
    }
    void chrome.tabs
      .reload(tabId)
      .catch(() => finish(new Error('无法刷新来源页面，请确认标签页仍然打开。')));
  });
}
