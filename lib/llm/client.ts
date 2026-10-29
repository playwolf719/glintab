import type { Provider, ChatGPTCredentials } from '../../types';
import { adapters, apiBase, type WireMessage } from './adapters';
import { parseSSE } from './sse';
import { CHATGPT_PROVIDER_URL, CHATGPT_CATALOG_VERSION } from '../../config/chatgpt';

export type CredentialSource = (rejectedRevision?: string) => Promise<ChatGPTCredentials>;
async function withAbort<T>(operation: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}
async function chatGPTFetch(
  provider: Provider,
  path: string,
  init: RequestInit,
  fetcher: typeof fetch,
  credentials?: CredentialSource,
) {
  if (provider.baseUrl !== CHATGPT_PROVIDER_URL || !provider.chatgpt?.connectionId || !credentials)
    throw new Error('ChatGPT 连接配置无效，请重新登录。');
  init.signal?.throwIfAborted();
  let session = await withAbort(credentials(), init.signal);
  const request = () => {
    init.signal?.throwIfAborted();
    return fetcher(CHATGPT_PROVIDER_URL + path, {
      ...init,
      redirect: 'error',
      headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        Authorization: `Bearer ${session.accessToken}`,
        'ChatGPT-Account-Id': session.accountId,
      },
    });
  };
  let response = await request();
  if (response.status === 401) {
    await response.body?.cancel();
    init.signal?.throwIfAborted();
    session = await withAbort(credentials(session.revision), init.signal);
    response = await request();
  }
  return response;
}

export function httpError(status: number): Error {
  const errors: Record<number, string> = {
    401: '模型鉴权失败（401），请检查 API Key。',
    403: '模型访问被拒绝（403），请检查密钥及访问权限。',
    404: '未找到模型端点（404），请检查 Base URL、协议和模型名称。',
    429: '模型请求受限（429），请检查配额或稍后重试。',
  };
  return new Error(errors[status] || `模型服务返回 HTTP ${status}，请稍后重试。`);
}
export async function streamCompletion(
  provider: Provider,
  system: string,
  messages: WireMessage[],
  maxTokens: number,
  signal: AbortSignal,
  onDelta: (text: string) => void,
  fetcher: typeof fetch = fetch,
  credentials?: CredentialSource,
): Promise<void> {
  const adapter = adapters[provider.apiFormat];
  let response: Response;
  try {
    const body =
      provider.authType === 'chatgpt'
        ? {
            model: provider.model,
            instructions: system,
            store: false,
            stream: true,
            input: messages.map((message) => ({
              type: 'message',
              role: message.role,
              content: [
                {
                  type: message.role === 'assistant' ? 'output_text' : 'input_text',
                  text: message.content,
                },
              ],
            })),
          }
        : adapter.body(provider.model, system, messages, maxTokens);
    const init: RequestInit = {
      method: 'POST',
      signal,
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...adapter.headers(provider.apiKey) },
      body: JSON.stringify(body),
    };
    response =
      provider.authType === 'chatgpt'
        ? await chatGPTFetch(provider, '/responses', init, fetcher, credentials)
        : await fetcher(apiBase(provider.baseUrl, provider.apiFormat) + adapter.path, init);
  } catch (error) {
    if (signal.aborted) throw error;
    if (
      provider.authType === 'chatgpt' &&
      error instanceof Error &&
      /^(ChatGPT|OpenAI|无法|账号)/.test(error.message)
    )
      throw error;
    throw new Error('无法连接模型服务，请检查网络、Base URL 与域名授权。');
  }
  if (!response.ok) {
    if (provider.authType === 'chatgpt' && (response.status === 401 || response.status === 403))
      throw new Error('ChatGPT 授权或模型权限不可用，请在设置中重新登录。');
    throw httpError(response.status);
  }
  if (response.headers.get('content-type')?.includes('application/json')) {
    const json = await response.json();
    if (json.error) throw new Error('模型服务返回错误，请检查配置与服务状态。');
    const text = adapter.full(json);
    if (!text.trim()) throw new Error('模型返回了空响应，请重试或更换模型。');
    onDelta(text);
    return;
  }
  if (!response.body) throw new Error('模型没有返回响应内容。');
  let received = false,
    completed = false;
  for await (const event of parseSSE(response.body)) {
    if (event.data === '[DONE]') {
      completed = true;
      break;
    }
    let json: any;
    try {
      json = JSON.parse(event.data);
    } catch {
      throw new Error('模型响应格式错误，已保留收到的内容。');
    }
    if (
      json.error ||
      event.event === 'error' ||
      ['error', 'response.failed', 'response.incomplete'].includes(json.type)
    )
      throw new Error('模型生成失败或输出未完成，已保留收到的内容。');
    const delta = adapter.delta(json);
    if (typeof delta === 'string' && delta) {
      received = true;
      onDelta(delta);
    }
    if (adapter.completed(json)) {
      if (!received && json.response) {
        const full = adapter.full(json.response);
        if (full) {
          received = true;
          onDelta(full);
        }
      }
      completed = true;
      break;
    }
  }
  if (!received) throw new Error('模型返回了空响应，请重试或更换模型。');
  if (!completed) throw new Error('连接在回答完成前中断，已保留收到的内容。');
}
export async function listModels(
  provider: Provider,
  fetcher: typeof fetch = fetch,
  credentials?: CredentialSource,
): Promise<string[]> {
  const init: RequestInit = {
    headers: adapters[provider.apiFormat].headers(provider.apiKey),
    signal: AbortSignal.timeout(20000),
    redirect: 'error',
  };
  const response =
    provider.authType === 'chatgpt'
      ? await chatGPTFetch(
          provider,
          `/models?${new URLSearchParams({ client_version: CHATGPT_CATALOG_VERSION })}`,
          init,
          fetcher,
          credentials,
        )
      : await fetcher(apiBase(provider.baseUrl, provider.apiFormat) + '/models', init);
  if (!response.ok) {
    if (provider.authType === 'chatgpt' && (response.status === 401 || response.status === 403))
      throw new Error('ChatGPT 连接或模型权限不可用，请重新连接账号。');
    if (provider.authType === 'chatgpt')
      throw new Error(
        `ChatGPT 模型列表请求失败（HTTP ${response.status}）。可重试或手动填写模型 ID。`,
      );
    throw httpError(response.status);
  }
  const json = await response.json();
  const entries = json.models || json.data || [];
  if (!Array.isArray(entries)) throw new Error('模型列表格式无效，请手动填写模型 ID。');
  const models = entries
    .filter(
      (item: any) =>
        item && (provider.authType !== 'chatgpt' || !['hide', 'hidden'].includes(item.visibility)),
    )
    .map((item: any) => item.id || item.slug)
    .filter((id: unknown): id is string => typeof id === 'string');
  if (!models.length) throw new Error('未获取到模型列表，请手动填写模型名称。');
  return provider.authType === 'chatgpt' ? models : models.sort();
}
