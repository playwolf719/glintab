import { describe, expect, it, vi } from 'vitest';
import { streamCompletion } from '../lib/llm/client';
import { provider } from './fixtures';
import type { ApiFormat } from '../types';
const signal = new AbortController().signal;
function sse(events: unknown[]) {
  return new Response(
    events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
describe('model protocols', () => {
  it('finishes on a protocol terminal event even if the server leaves HTTP open', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"response.output_text.delta","delta":"complete"}\n\ndata: {"type":"response.completed"}\n\n',
          ),
        );
      },
      cancel,
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
      );
    const onDelta = vi.fn();
    await streamCompletion(
      { ...provider, apiFormat: 'openai_responses' },
      '',
      [],
      100,
      signal,
      onDelta,
      fetcher,
    );
    expect(onDelta).toHaveBeenCalledWith('complete');
    expect(cancel).toHaveBeenCalled();
  });
  const cases: { format: ApiFormat; path: string; events: unknown[]; header: string }[] = [
    {
      format: 'openai_chat',
      path: '/v1/chat/completions',
      events: [{ choices: [{ delta: { content: '你好' } }] }, '[DONE]'],
      header: 'Authorization',
    },
    {
      format: 'anthropic',
      path: '/v1/messages',
      events: [
        { type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } },
        { type: 'message_stop' },
      ],
      header: 'x-api-key',
    },
    {
      format: 'openai_responses',
      path: '/v1/responses',
      events: [
        { type: 'response.output_text.delta', delta: '你好' },
        { type: 'response.completed' },
      ],
      header: 'Authorization',
    },
  ];
  it.each(cases)('sends and decodes $format', async ({ format, path, events, header }) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(sse(events));
    let output = '';
    await streamCompletion(
      { ...provider, apiFormat: format },
      'system',
      [{ role: 'user', content: 'question' }],
      2048,
      signal,
      (text) => (output += text),
      fetcher,
    );
    expect(output).toBe('你好');
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://example.com' + path);
    const init = fetcher.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>)[header]).toContain('test-only');
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(true);
    expect(body.model).toBe('test-model');
    if (format === 'openai_responses') {
      expect(body.instructions).toBe('system');
      expect(body.max_output_tokens).toBe(2048);
    }
    if (format === 'anthropic') expect(body.system).toBe('system');
    if (format === 'openai_chat')
      expect(body.messages[0]).toEqual({ role: 'system', content: 'system' });
  });
  it('handles a non-streaming JSON response', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ choices: [{ message: { content: 'complete' } }] }));
    const onDelta = vi.fn();
    await streamCompletion(provider, '', [], 100, signal, onDelta, fetcher);
    expect(onDelta).toHaveBeenCalledWith('complete');
  });
  it.each([401, 403, 404, 429, 500])(
    'maps HTTP %s without echoing secret-bearing bodies',
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('secret key', { status }));
      await expect(
        streamCompletion(provider, '', [], 100, signal, vi.fn(), fetcher),
      ).rejects.toThrow(String(status));
    },
  );
  it('rejects empty output and truncated streams', async () => {
    await expect(
      streamCompletion(
        provider,
        '',
        [],
        100,
        signal,
        vi.fn(),
        vi.fn<typeof fetch>().mockResolvedValue(sse(['[DONE]'])),
      ),
    ).rejects.toThrow('空响应');
    const partial = vi.fn();
    await expect(
      streamCompletion(
        provider,
        '',
        [],
        100,
        signal,
        partial,
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(sse([{ choices: [{ delta: { content: 'partial' } }] }])),
      ),
    ).rejects.toThrow('中断');
    expect(partial).toHaveBeenCalledWith('partial');
  });
  it('reports provider error events', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(sse([{ error: { message: 'private diagnostics' } }]));
    await expect(streamCompletion(provider, '', [], 100, signal, vi.fn(), fetcher)).rejects.toThrow(
      '模型生成失败',
    );
  });
});

it('uses direct ChatGPT account credentials, stateless input and one 401 refresh retry', async () => {
  const { CHATGPT_PROVIDER_URL } = await import('../config/chatgpt');
  const credentials = vi
    .fn()
    .mockResolvedValueOnce({ accessToken: 'old', accountId: 'account', revision: 'r1' })
    .mockResolvedValueOnce({ accessToken: 'new', accountId: 'account', revision: 'r2' });
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('', { status: 401 }))
    .mockResolvedValueOnce(
      sse([{ type: 'response.output_text.delta', delta: 'ok' }, { type: 'response.completed' }]),
    );
  await streamCompletion(
    {
      ...provider,
      authType: 'chatgpt',
      apiFormat: 'openai_responses',
      baseUrl: CHATGPT_PROVIDER_URL,
      apiKey: '',
      chatgpt: { connectionId: 'id', email: '' },
    },
    'instructions',
    [{ role: 'user', content: 'question' }],
    100,
    signal,
    vi.fn(),
    fetcher,
    credentials,
  );
  expect(credentials.mock.calls).toEqual([[], ['r1']]);
  expect(fetcher.mock.calls[1]![0]).toBe(CHATGPT_PROVIDER_URL + '/responses');
  const request = fetcher.mock.calls[1]![1]!;
  expect(request.headers).toMatchObject({
    Authorization: 'Bearer new',
    'ChatGPT-Account-Id': 'account',
  });
  expect(request.redirect).toBe('error');
  expect(JSON.parse(String(request.body))).toEqual({
    model: provider.model,
    instructions: 'instructions',
    store: false,
    stream: true,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question' }] }],
  });
});
it('stops immediately while account credentials are refreshing', async () => {
  const { CHATGPT_PROVIDER_URL } = await import('../config/chatgpt');
  const controller = new AbortController();
  let release!: (value: import('../types').ChatGPTCredentials) => void;
  const credentials = () =>
    new Promise<import('../types').ChatGPTCredentials>((resolve) => {
      release = resolve;
    });
  const fetcher = vi.fn<typeof fetch>();
  const result = streamCompletion(
    {
      ...provider,
      authType: 'chatgpt',
      apiFormat: 'openai_responses',
      baseUrl: CHATGPT_PROVIDER_URL,
      chatgpt: { connectionId: 'id', email: '' },
    },
    '',
    [],
    100,
    controller.signal,
    vi.fn(),
    fetcher,
    credentials,
  );
  controller.abort();
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  release({ accessToken: 'unused', accountId: 'account', revision: 'r' });
  expect(fetcher).not.toHaveBeenCalled();
});

it('loads the Codex model catalog with a client_version query and account credentials', async () => {
  const { listModels } = await import('../lib/llm/client');
  const { CHATGPT_PROVIDER_URL } = await import('../config/chatgpt');
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (!/^\d+\.\d+\.\d+$/.test(url.searchParams.get('client_version') || ''))
      return Response.json(
        { detail: [{ loc: ['query', 'client_version'], type: 'missing' }] },
        { status: 400 },
      );
    expect(url.origin + url.pathname).toBe(CHATGPT_PROVIDER_URL + '/models');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer catalog-token');
    expect(new Headers(init?.headers).get('ChatGPT-Account-Id')).toBe('catalog-account');
    return Response.json({
      models: [
        { slug: 'available-model', visibility: 'list' },
        { slug: 'internal-model', visibility: 'hide' },
      ],
    });
  });
  const result = await listModels(
    {
      ...provider,
      authType: 'chatgpt',
      apiFormat: 'openai_responses',
      baseUrl: CHATGPT_PROVIDER_URL,
      apiKey: '',
      chatgpt: { connectionId: 'id', email: '' },
    },
    fetcher,
    async () => ({ accessToken: 'catalog-token', accountId: 'catalog-account', revision: 'r' }),
  );
  expect(result).toEqual(['available-model']);
});

it('reports a catalog HTTP failure without leaking response bodies or requesting a new login', async () => {
  const { listModels } = await import('../lib/llm/client');
  const { CHATGPT_PROVIDER_URL } = await import('../config/chatgpt');
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response('secret-bearing server body', { status: 400 }));
  const credentials = vi
    .fn()
    .mockResolvedValue({ accessToken: 'token', accountId: 'account', revision: 'r' });
  const result = listModels(
    {
      ...provider,
      authType: 'chatgpt',
      baseUrl: CHATGPT_PROVIDER_URL,
      chatgpt: { connectionId: 'id', email: '' },
    },
    fetcher,
    credentials,
  );
  const error = await result.catch((value: Error) => value);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain('模型列表请求失败（HTTP 400）');
  expect((error as Error).message).not.toContain('secret-bearing');
  expect((error as Error).message).not.toContain('重新登录');
  expect(credentials).toHaveBeenCalledTimes(1);
});
it('keeps ordinary API Key discovery at the configured models path', async () => {
  const { listModels } = await import('../lib/llm/client');
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ data: [{ id: 'ordinary-model' }] }));
  expect(await listModels(provider, fetcher)).toEqual(['ordinary-model']);
  expect(fetcher.mock.calls[0]![0]).toBe('https://example.com/v1/models');
});
