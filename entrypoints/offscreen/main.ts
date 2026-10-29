import type { EngineEvent, EngineRequest, RpcResponse } from '../../types';
import { errorText } from '../../lib/platform/rpc';

// Bridge Chrome runtime messaging to a dedicated worker, using the WORKERS reason.
const worker = new Worker(new URL('../../lib/engine/engine.worker.ts', import.meta.url), {
  type: 'module',
});
const waiting = new Map<
  string,
  { respond(value: RpcResponse): void; timer: ReturnType<typeof setTimeout> }
>();
worker.onmessage = (event: MessageEvent) => {
  if (event.data.kind === 'event') {
    const { id, event: engineEvent } = event.data as { id: string; event: EngineEvent };
    void chrome.runtime
      .sendMessage(engineEvent)
      .then((response: RpcResponse) => {
        worker.postMessage({
          kind: 'ack',
          id,
          response: response || { ok: false, error: '后台没有响应。' },
        });
      })
      .catch((error) =>
        worker.postMessage({ kind: 'ack', id, response: { ok: false, error: errorText(error) } }),
      );
  } else if (event.data.kind === 'response') {
    const pending = waiting.get(event.data.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    waiting.delete(event.data.id);
    pending.respond(event.data.response);
  }
};
worker.onerror = () => {
  for (const { respond, timer } of waiting.values()) {
    clearTimeout(timer);
    respond({ ok: false, error: '任务引擎异常，请重新加载扩展。' });
  }
  waiting.clear();
};
chrome.runtime.onMessage.addListener((request: EngineRequest, sender, respond) => {
  if (
    request?.target !== 'engine' ||
    sender.id !== chrome.runtime.id ||
    (sender.url && sender.url !== chrome.runtime.getURL('/background.js'))
  )
    return;
  const id = crypto.randomUUID();
  const timer = setTimeout(() => {
    waiting.delete(id);
    respond({ ok: false, error: '任务引擎响应超时，请重试。' });
  }, 10000);
  waiting.set(id, { respond, timer });
  worker.postMessage({ kind: 'command', id, request });
  return true;
});
