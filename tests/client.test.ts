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
