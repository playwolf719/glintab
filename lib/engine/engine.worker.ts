import { TaskManager } from './task-manager';
import type {
  EngineRequest,
  RpcResponse,
  ChatGPTCredentials,
  AuthCredentialRequest,
} from '../../types';
import { errorText } from '../platform/rpc';
import { streamCompletion } from '../llm/client';

export function startEngineWorker() {
  const pending = new Map<
    string,
    { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  const authPending = new Map<
    string,
    {
      resolve(value: ChatGPTCredentials): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const manager = new TaskManager(
    (event) =>
      new Promise<void>((resolve, reject) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('本地保存超时，请复制回答后重试。'));
        }, 10000);
        pending.set(id, { resolve, reject, timer });
        postMessage({ kind: 'event', id, event });
      }),
    (provider, system, messages, maxTokens, signal, onDelta) =>
      streamCompletion(
        provider,
        system,
        messages,
        maxTokens,
        signal,
        onDelta,
        fetch,
        provider.authType === 'chatgpt'
          ? (rejectedRevision) =>
              new Promise<ChatGPTCredentials>((resolve, reject) => {
                const id = crypto.randomUUID();
                const timer = setTimeout(() => {
                  authPending.delete(id);
                  reject(new Error('ChatGPT 账号响应超时，请重试。'));
                }, 40000);
                authPending.set(id, { resolve, reject, timer });
                postMessage({
                  kind: 'auth',
                  id,
                  request: {
                    channel: 'glintab:auth',
                    connectionId: provider.chatgpt!.connectionId,
                    rejectedRevision,
                  } satisfies AuthCredentialRequest,
                });
              })
          : undefined,
      ),
  );
  self.onmessage = (event: MessageEvent) => {
    if (event.data.kind === 'auth-result') {
      const waiting = authPending.get(event.data.id);
      if (!waiting) return;
      clearTimeout(waiting.timer);
      authPending.delete(event.data.id);
      const response = event.data.response as RpcResponse<ChatGPTCredentials>;
      if (response.ok && response.data) waiting.resolve(response.data);
      else waiting.reject(new Error(response.error || 'ChatGPT 账号凭证不可用。'));
    } else if (event.data.kind === 'ack') {
      const waiting = pending.get(event.data.id);
      if (!waiting) return;
      clearTimeout(waiting.timer);
      pending.delete(event.data.id);
      const response = event.data.response as RpcResponse;
      if (response.ok) waiting.resolve();
      else waiting.reject(new Error(response.error || '本地保存失败。'));
    } else if (event.data.kind === 'command') {
      const request = event.data.request as EngineRequest;
      try {
        let data: unknown;
        switch (request.type) {
          case 'start':
            data = manager.start(request.task);
            break;
          case 'snapshot':
            data = manager.get(request.tabId, request.pageKey);
            break;
          case 'cancel':
            manager.cancel(request.tabId, request.streamId);
            break;
          case 'active':
            data = manager.active();
            break;
        }
        postMessage({ kind: 'response', id: event.data.id, response: { ok: true, data } });
      } catch (error) {
        postMessage({
          kind: 'response',
          id: event.data.id,
          response: { ok: false, error: errorText(error) },
        });
      }
    }
  };
}
