import type { Provider } from '../../types';
import { adapters, apiBase, type WireMessage } from './adapters';
import { parseSSE } from './sse';

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
): Promise<void> {
  const adapter = adapters[provider.apiFormat];
  let response: Response;
  try {
    response = await fetcher(apiBase(provider.baseUrl, provider.apiFormat) + adapter.path, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', ...adapter.headers(provider.apiKey) },
      body: JSON.stringify(adapter.body(provider.model, system, messages, maxTokens)),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error('无法连接模型服务，请检查网络、Base URL 与域名授权。');
  }
  if (!response.ok) throw httpError(response.status);
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
export async function listModels(provider: Provider): Promise<string[]> {
  const response = await fetch(apiBase(provider.baseUrl, provider.apiFormat) + '/models', {
    headers: adapters[provider.apiFormat].headers(provider.apiKey),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw httpError(response.status);
  const json = await response.json();
  const models = (json.data || json.models || [])
    .map((item: any) => item.id || item.slug)
    .filter((id: unknown): id is string => typeof id === 'string');
  if (!models.length) throw new Error('未获取到模型列表，请手动填写模型名称。');
  return models.sort();
}
