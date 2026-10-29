import { describe, expect, it } from 'vitest';
import { parseSSE } from '../lib/llm/sse';
function stream(text: string, size = 1) {
  const data = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < data.length; i += size) controller.enqueue(data.slice(i, i + size));
      controller.close();
    },
  });
}
describe('SSE framing', () => {
  it('decodes unicode split across chunks, CRLF, comments and multiline data', async () => {
    const result = [];
    for await (const item of parseSSE(
      stream(': ping\r\nevent: delta\r\ndata: 你好\r\ndata: 世界\r\n\r\ndata: [DONE]\r\n\r\n'),
    ))
      result.push(item);
    expect(result).toEqual([
      { event: 'delta', data: '你好\n世界' },
      { event: '', data: '[DONE]' },
    ]);
  });
  it('flushes an event without its final newline', async () => {
    const result = [];
    for await (const item of parseSSE(stream('event: tail\ndata: final'))) result.push(item);
    expect(result).toEqual([{ event: 'tail', data: 'final' }]);
  });
});
