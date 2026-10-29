import type { EngineEvent, EngineRequest, RpcResponse } from '../../types';
import { errorText } from '../../lib/platform/rpc';

// Bridge Chrome runtime messaging to a dedicated worker, using the WORKERS reason.
let worker: Worker | null = null;
let engineError: string | null = null;
try {
  worker = new Worker(chrome.runtime.getURL('/engine-worker.js'));
} catch {
  engineError = '任务引擎加载失败，请重新加载扩展后重试。';
}
const waiting = new Map<
  string,
  { respond(value: RpcResponse): void; timer: ReturnType<typeof setTimeout> }
>();
if (worker)
  worker.onmessage = (event: MessageEvent) => {
    if (event.data.kind === 'auth') {
      // Credentials only travel between background and this dedicated worker.
      void chrome.runtime
        .sendMessage(event.data.request)
        .then((response: RpcResponse) => {
          worker?.postMessage({ kind: 'auth-result', id: event.data.id, response });
        })
        .catch(() =>
          worker?.postMessage({
            kind: 'auth-result',
            id: event.data.id,
            response: { ok: false, error: 'ChatGPT 账号请求失败。' },
          }),
        );
    } else if (event.data.kind === 'event') {
      const { id, event: engineEvent } = event.data as { id: string; event: EngineEvent };
      void chrome.runtime
        .sendMessage(engineEvent)
        .then((response: RpcResponse) => {
          worker?.postMessage({
            kind: 'ack',
            id,
            response: response || { ok: false, error: '后台没有响应。' },
          });
        })
        .catch((error) =>
          worker?.postMessage({
            kind: 'ack',
            id,
            response: { ok: false, error: errorText(error) },
          }),
        );
    } else if (event.data.kind === 'response') {
      const pending = waiting.get(event.data.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      waiting.delete(event.data.id);
      pending.respond(event.data.response);
    }
  };
if (worker)
  worker.onerror = (event) => {
    event.preventDefault();
    engineError = '任务引擎异常，请重新加载扩展。';
    for (const { respond, timer } of waiting.values()) {
      clearTimeout(timer);
      respond({ ok: false, error: engineError });
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
  if (engineError || !worker) {
    respond({ ok: false, error: engineError || '任务引擎不可用，请重新加载扩展。' });
    return;
  }
  const id = crypto.randomUUID();
  const timer = setTimeout(() => {
    waiting.delete(id);
    respond({ ok: false, error: '任务引擎响应超时，请重试。' });
  }, 10000);
  waiting.set(id, { respond, timer });
  worker.postMessage({ kind: 'command', id, request });
  return true;
});
