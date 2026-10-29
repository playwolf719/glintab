export interface SSEEvent {
  event: string;
  data: string;
}
export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '',
    event = '',
    data: string[] = [];
  function line(value: string): SSEEvent | undefined {
    if (!value) {
      const result = data.length ? { event, data: data.join('\n') } : undefined;
      event = '';
      data = [];
      return result;
    }
    if (value.startsWith(':')) return;
    const index = value.indexOf(':');
    const field = index < 0 ? value : value.slice(0, index);
    let content = index < 0 ? '' : value.slice(index + 1);
    if (content.startsWith(' ')) content = content.slice(1);
    if (field === 'event') event = content;
    if (field === 'data') data.push(content);
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let position: number;
      while ((position = buffer.indexOf('\n')) >= 0) {
        const result = line(buffer.slice(0, position).replace(/\r$/, ''));
        buffer = buffer.slice(position + 1);
        if (result) yield result;
      }
      if (done) break;
    }
    if (buffer) {
      const result = line(buffer.replace(/\r$/, ''));
      if (result) yield result;
    }
    const last = line('');
    if (last) yield last;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
