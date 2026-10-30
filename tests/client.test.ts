import { describe, expect, it, vi } from 'vitest';
import { streamCompletion } from '../lib/llm/client';
import { provider } from './fixtures';
import type { ApiFormat, ReasoningEffort } from '../types';
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
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('reasoning');
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
  it.each([400, 401, 403, 404, 429, 500, 503])(
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
  it('classifies a 400 parameter without reflecting credentials or source text', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          error: {
            param: 'input[0].content',
            message: 'invalid input contains private-source and sk-private',
          },
        },
        { status: 400 },
      ),
    );
    const error = await streamCompletion(provider, '', [], 100, signal, vi.fn(), fetcher).catch(
      (error: Error) => error,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('参数：input');
    expect((error as Error).message).not.toContain('private');
  });
  it('recognizes stream errors from a compatible service and discards unknown diagnostics', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { error: { message: 'Streaming is not supported. stream must be false. secret-key' } },
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          { error: { param: 'secret-param', message: 'private diagnostics' } },
          { status: 400 },
        ),
      );
    const first = await streamCompletion(provider, '', [], 100, signal, vi.fn(), fetcher).catch(
      (error: Error) => error,
    );
    expect((first as Error).message).toContain('参数：stream');
    expect((first as Error).message).not.toContain('secret-key');
    const second = await streamCompletion(provider, '', [], 100, signal, vi.fn(), fetcher).catch(
      (error: Error) => error,
    );
    expect((second as Error).message).toContain('HTTP 400');
    expect((second as Error).message).not.toMatch(/secret-param|private diagnostics/);
  });
  it('bounds error body reads and cancels oversized diagnostic responses', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('private'.repeat(3000)));
      },
      cancel,
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 400 }));
    const error = await streamCompletion(provider, '', [], 100, signal, vi.fn(), fetcher).catch(
      (error: Error) => error,
    );
    expect((error as Error).message).toContain('HTTP 400');
    expect((error as Error).message).not.toContain('private');
    expect(cancel).toHaveBeenCalled();
  });
  it('does not hang while an error response body stays open', async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 400 }),
        );
      const result = streamCompletion(provider, '', [], 100, signal, vi.fn(), fetcher).catch(
        (error: Error) => error,
      );
      await vi.advanceTimersByTimeAsync(1500);
      expect(((await result) as Error).message).toContain('HTTP 400');
      expect(cancel).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([
    { format: 'openai_chat', json: { choices: [{ message: { content: '完整回答' } }] } },
    {
      format: 'openai_responses',
      json: { output: [{ content: [{ type: 'output_text', text: '完整回答' }] }] },
    },
    { format: 'anthropic', json: { content: [{ type: 'text', text: '完整回答' }] } },
  ] as const)(
    'requests non-streaming $format and emits the complete answer once',
    async ({ format, json }) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(json));
      const onDelta = vi.fn();
      await streamCompletion(
        { ...provider, apiFormat: format, stream: false },
        'system',
        [{ role: 'user', content: 'question' }],
        2048,
        signal,
        onDelta,
        fetcher,
      );
      expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).stream).toBe(false);
      expect(onDelta.mock.calls).toEqual([['完整回答']]);
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

describe('reasoning effort', () => {
  const efforts: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  it.each(efforts)(
    'sends %s using the selected protocol in streaming and JSON modes',
    async (effort) => {
      for (const apiFormat of ['openai_chat', 'openai_responses'] as const) {
        for (const stream of [true, false]) {
          const response = stream
            ? sse(
                apiFormat === 'openai_chat'
                  ? [{ choices: [{ delta: { content: 'ok' } }] }, '[DONE]']
                  : [
                      { type: 'response.output_text.delta', delta: 'ok' },
                      { type: 'response.completed' },
                    ],
              )
            : Response.json(
                apiFormat === 'openai_chat'
                  ? { choices: [{ message: { content: 'ok' } }] }
                  : { output_text: 'ok' },
              );
          const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
          const onDelta = vi.fn();
          await streamCompletion(
            { ...provider, apiFormat, stream, reasoningEffort: effort },
            '',
            [],
            4096,
            signal,
            onDelta,
            fetcher,
          );
          const body = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
          expect(body.stream).toBe(stream);
          if (apiFormat === 'openai_chat') {
            expect(body.reasoning_effort).toBe(effort);
            expect(body).not.toHaveProperty('reasoning');
          } else {
            expect(body.reasoning).toEqual({ effort });
            expect(body).not.toHaveProperty('reasoning_effort');
          }
          expect(onDelta).toHaveBeenCalledWith('ok');
        }
      }
    },
  );
  it('does not send OpenAI reasoning parameters to Anthropic even with a stale setting', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ content: [{ type: 'text', text: 'ok' }] }));
    await streamCompletion(
      { ...provider, apiFormat: 'anthropic', reasoningEffort: 'high', stream: false },
      '',
      [],
      4096,
      signal,
      vi.fn(),
      fetcher,
    );
    const body = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
    expect(body).not.toHaveProperty('reasoning');
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('thinking');
  });
  it('rejects an invalid saved effort before sending a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      streamCompletion(
        { ...provider, reasoningEffort: 'invalid-secret' as ReasoningEffort },
        '',
        [],
        4096,
        signal,
        vi.fn(),
        fetcher,
      ),
    ).rejects.toThrow('推理强度设置无效');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['reasoning_effort', 'reasoning.effort'])(
    'reports an unsupported %s without leaking server text or retrying',
    async (param) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json(
            { error: { param, message: 'invalid effort; private diagnostics' } },
            { status: 400 },
          ),
        );
      const onDelta = vi.fn();
      const error = await streamCompletion(
        { ...provider, reasoningEffort: 'high' },
        '',
        [],
        4096,
        signal,
        onDelta,
        fetcher,
      ).catch((value: Error) => value);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(`参数：${param.split('.')[0]}`);
      expect((error as Error).message).not.toContain('private diagnostics');
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(onDelta).not.toHaveBeenCalled();
    },
  );
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
      reasoningEffort: 'high',
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
    reasoning: { effort: 'high' },
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question' }] }],
  });
  expect(fetcher.mock.calls[0]![1]!.body).toBe(request.body);
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
