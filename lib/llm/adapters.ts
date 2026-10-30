import type { ApiFormat, Provider, ReasoningEffort } from '../../types';
import { validateReasoningEffort } from '../domain/reasoning';

export function reasoningParameters(provider: Provider): {
  reasoning_effort?: ReasoningEffort;
  reasoning?: { effort: ReasoningEffort };
} {
  validateReasoningEffort(provider.reasoningEffort);
  if (provider.reasoningEffort === undefined) return {};
  if (provider.authType === 'chatgpt' || provider.apiFormat === 'openai_responses')
    return { reasoning: { effort: provider.reasoningEffort } };
  if (provider.apiFormat === 'openai_chat') return { reasoning_effort: provider.reasoningEffort };
  return {};
}
export interface WireMessage {
  role: 'user' | 'assistant';
  content: string;
}
export interface Adapter {
  path: string;
  headers(key: string): Record<string, string>;
  body(model: string, system: string, messages: WireMessage[], maxTokens: number): object;
  delta(json: any): string;
  full(json: any): string;
  completed(json: any): boolean;
}
export const adapters: Record<ApiFormat, Adapter> = {
  openai_chat: {
    path: '/chat/completions',
    headers: (key) => (key ? { Authorization: `Bearer ${key}` } : ({} as Record<string, string>)),
    body: (model, system, messages, max_tokens) => ({
      model,
      messages: [{ role: 'system', content: system }, ...messages],
      stream: true,
      max_tokens,
    }),
    delta: (json) =>
      typeof json.choices?.[0]?.delta?.content === 'string' ? json.choices[0].delta.content : '',
    full: (json) => json.choices?.[0]?.message?.content || '',
    completed: (json) => json.choices?.[0]?.finish_reason != null,
  },
  anthropic: {
    path: '/messages',
    headers: (key) => ({
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    }),
    body: (model, system, messages, max_tokens) => ({
      model,
      system,
      messages,
      max_tokens,
      stream: true,
    }),
    delta: (json) =>
      json.type === 'content_block_delta' && json.delta?.type === 'text_delta'
        ? json.delta.text
        : '',
    full: (json) =>
      (json.content || [])
        .filter((block: any) => block.type === 'text')
        .map((block: any) => block.text)
        .join(''),
    completed: (json) => json.type === 'message_stop',
  },
  openai_responses: {
    path: '/responses',
    headers: (key) => (key ? { Authorization: `Bearer ${key}` } : ({} as Record<string, string>)),
    body: (model, instructions, input, max_output_tokens) => ({
      model,
      instructions,
      input,
      max_output_tokens,
      stream: true,
    }),
    delta: (json) => (json.type === 'response.output_text.delta' ? json.delta : ''),
    full: (json) =>
      typeof json.output_text === 'string'
        ? json.output_text
        : (json.output || [])
            .flatMap((item: any) => item.content || [])
            .filter((item: any) => item.type === 'output_text')
            .map((item: any) => item.text)
            .join(''),
    completed: (json) => json.type === 'response.completed',
  },
};
export function apiBase(baseUrl: string, format: ApiFormat) {
  const base = baseUrl.replace(/\/+$/, '');
  return format === 'anthropic' && !/\/v1$/.test(base) ? `${base}/v1` : base;
}
