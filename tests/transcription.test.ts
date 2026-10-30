import { expect, it, vi } from 'vitest';
import { audioUrl, pcmWav, validateTranscription } from '../lib/domain/transcription';
import { transcribeAudio } from '../lib/llm/transcription';
import { prepareAudio } from '../lib/engine/audio';
import { buildContext } from '../lib/domain/context';
import { DEFAULT_CONFIG } from '../config/defaults';
import { conversation, provider } from './fixtures';
import type { PageSource, PreparedAudio, TranscriptionConfig } from '../types';

const config: TranscriptionConfig = {
  enabled: true,
  baseUrl: 'https://asr.test/v1',
  apiKey: 'asr-secret',
  model: 'asr-test',
  responseFormat: 'verbose_json',
};
const signal = new AbortController().signal;
function source(): PageSource {
  return {
    ...conversation('https://www.bilibili.com/video/BV1xx411c7mD/?p=2').source,
    content: '',
    video: {
      platform: 'bilibili',
      videoId: 'BV1xx411c7mD',
      part: 2,
      language: 'und',
      automatic: true,
      transcription: 'required',
      timestamps: false,
      segments: [],
    },
  };
}
function audio(count = 1): PreparedAudio {
  return {
    chunks: Array.from({ length: count }, (_, index) => ({
      data: pcmWav(new Float32Array([0, -1, 1])),
      offset: index * 300,
      duration: 10,
    })),
  };
}
it('validates configuration and restricts signed audio URLs to Bilibili CDNs', () => {
  expect(validateTranscription({ ...config, extra: 'discard' } as TranscriptionConfig)).toEqual(
    config,
  );
  expect(() => validateTranscription({ ...config, baseUrl: 'http://remote.test/v1' })).toThrow(
    'HTTPS',
  );
  expect(() => validateTranscription({ ...config, model: '' })).toThrow('模型 ID');
  expect(() => validateTranscription({ ...config, responseFormat: 'srt' as 'json' })).toThrow(
    '无效',
  );
  for (const raw of [
    'https://bilivideo.com.evil.test/a',
    'https://u:p@cdn.bilivideo.com/a',
    'http://cdn.bilivideo.com/a',
    'https://cdn.bilivideo.com:8443/a',
  ])
    expect(() => audioUrl(raw)).toThrow();
  expect(audioUrl('https://cdn.bilivideo.cn/audio.m4s?deadline=1')).toContain('deadline=1');
});
it('encodes independent valid mono PCM WAV chunks', () => {
  const data = pcmWav(new Float32Array([-2, 0, 2]));
  const view = new DataView(data);
  expect(new TextDecoder().decode(data.slice(0, 4))).toBe('RIFF');
  expect(view.getUint32(4, true)).toBe(data.byteLength - 8);
  expect(view.getUint32(24, true)).toBe(16000);
  expect(view.getUint32(40, true)).toBe(6);
  expect(view.getInt16(44, true)).toBe(-32768);
  expect(view.getInt16(48, true)).toBe(32767);
});
it('rejects oversized or empty audio before allocating a decoder', async () => {
  const metadata = {
    url: source().url,
    videoId: 'BV1xx411c7mD',
    part: 2,
    cid: 222,
    duration: 10,
    audioUrl: 'https://cdn.bilivideo.com/a',
  };
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response('small body', { headers: { 'Content-Length': String(65 * 1024 * 1024) } }),
      ),
  );
  try {
    await expect(prepareAudio(metadata, signal, vi.fn())).rejects.toThrow('64 MB');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('')));
    await expect(prepareAudio(metadata, signal, vi.fn())).rejects.toThrow('音轨为空');
  } finally {
    vi.unstubAllGlobals();
  }
});
it('uploads valid files and merges actual timestamp segments with chunk offsets and current part', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const form = init!.body as FormData;
    expect(form.get('model')).toBe('asr-test');
    expect(form.get('response_format')).toBe('verbose_json');
    expect((form.get('file') as File).name).toMatch(/part-\d\.wav/);
    expect(
      new TextDecoder().decode((await (form.get('file') as File).arrayBuffer()).slice(0, 4)),
    ).toBe('RIFF');
    expect(init).toMatchObject({
      credentials: 'omit',
      redirect: 'error',
      headers: { Authorization: 'Bearer asr-secret' },
    });
    return Response.json({ text: '音轨证据', segments: [{ start: 2, end: 4, text: '音轨证据' }] });
  });
  const prepared = audio(2);
  const result = await transcribeAudio(source(), prepared, config, signal, vi.fn(), fetcher);
  expect(fetcher.mock.calls[0]![0]).toBe('https://asr.test/v1/audio/transcriptions');
  expect(result.video).toMatchObject({ transcription: 'complete', timestamps: true, part: 2 });
  expect(result.video!.segments.map((item) => item.start)).toEqual([2, 302]);
  expect(result.content).toContain('p=2&t=302');
  expect(JSON.stringify(result)).not.toContain('asr-secret');
  expect(prepared.chunks[0]!.data.byteLength).toBe(0);
});
it('keeps plain text without inventing video timestamps or source links', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ text: '只有文字转写' }));
  const result = await transcribeAudio(
    source(),
    audio(),
    { ...config, responseFormat: 'json' },
    signal,
    vi.fn(),
    fetcher,
  );
  expect(result.content).toBe('只有文字转写');
  expect(result.video).toMatchObject({
    transcription: 'complete',
    timestamps: false,
    segments: [],
  });
  const context = buildContext(
    { ...conversation(), source: result, messages: [{ id: 'q', role: 'user', content: '总结' }] },
    provider,
    DEFAULT_CONFIG.settings,
  );
  expect(context.system).toContain('No timestamp data is available');
});
it.each([
  { text: '' },
  { text: 'invalid', segments: [{ start: -1, end: 3, text: 'bad' }] },
  { text: 'invalid', segments: [{ start: 1, end: 100, text: 'bad' }] },
])('rejects empty or untrustworthy transcription %j', async (result) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(result));
  await expect(
    transcribeAudio(source(), audio(), config, signal, vi.fn(), fetcher),
  ).rejects.toThrow();
});
it('does not echo server diagnostics or retry a potentially charged transcription', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response('asr-secret and raw diagnostics', { status: 429 }));
  await expect(
    transcribeAudio(source(), audio(2), config, signal, vi.fn(), fetcher),
  ).rejects.toThrow('HTTP 429');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('stops between audio chunks without submitting any later uploads', async () => {
  const controller = new AbortController();
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
    controller.abort();
    return Response.json({ text: 'first' });
  });
  await expect(
    transcribeAudio(source(), audio(2), config, controller.signal, vi.fn(), fetcher),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
