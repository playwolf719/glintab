// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { readBilibiliAudio } from '../lib/extraction/bilibili-audio';
import { readVideoPage } from '../lib/extraction/video-page';
import { videoSource } from '../lib/extraction/video';
const url = 'https://www.bilibili.com/video/BV1xx411c7mD/?p=2';
const metadata = {
  code: 0,
  data: {
    bvid: 'BV1xx411c7mD',
    title: 'B test',
    pages: [
      { page: 1, cid: 111, duration: 10 },
      { page: 2, cid: 222, duration: 10 },
    ],
  },
};
const play = {
  code: 0,
  data: {
    timelength: 10000,
    dash: {
      audio: [
        { bandwidth: 128000, mimeType: 'audio/mp4', baseUrl: 'https://cdn.bilivideo.com/high.m4s' },
        {
          bandwidth: 64000,
          mimeType: 'audio/mp4',
          baseUrl: 'https://cdn.bilivideo.com/low.m4s?token=transient',
        },
      ],
    },
  },
};
function fetcher(result: unknown) {
  vi.stubGlobal('location', new URL(url));
  const mock = vi
    .fn()
    .mockResolvedValueOnce(Response.json(metadata))
    .mockResolvedValueOnce(Response.json(result));
  vi.stubGlobal('fetch', mock);
  return mock;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('marks missing captions for transcription without fetching audio or persisting signed URLs', async () => {
  const mock = fetcher({ code: 0, data: { subtitle: { subtitles: [] } } });
  const result = await readVideoPage('bilibili', url, 'BV1xx411c7mD', 2);
  expect(result.ok).toBe(true);
  const source = videoSource(result.data!, url);
  expect(source.content).toBe('');
  expect(source.video).toMatchObject({ part: 2, transcription: 'required' });
  expect(mock).toHaveBeenCalledTimes(2);
});
it.each([{}, { subtitle: { subtitles: [{ lan: 'zh-CN' }] } }])(
  'does not mistake a malformed subtitle response for an empty list: %j',
  async (data) => {
    fetcher({ code: 0, data });
    const result = await readVideoPage('bilibili', url, 'BV1xx411c7mD', 2);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('未启动音轨转写');
  },
);
it('fetches fresh metadata for the current part and selects the lowest-bandwidth AAC audio', async () => {
  const mock = fetcher(play);
  const result = await readBilibiliAudio(url, 'BV1xx411c7mD', 2);
  expect(result.data).toMatchObject({ cid: 222, duration: 10, part: 2 });
  expect(result.data?.audioUrl).toContain('/low.m4s');
  expect(mock.mock.calls[1]![0]).toContain('cid=222');
  expect(mock.mock.calls[1]![1]).toMatchObject({ credentials: 'include', redirect: 'error' });
});
it('uses a supported backup CDN when the primary points at a foreign peer or nonstandard port', async () => {
  fetcher({
    code: 0,
    data: {
      ...play.data,
      dash: {
        audio: [
          {
            bandwidth: 64000,
            mimeType: 'audio/mp4',
            baseUrl: 'https://peer.example.cn:4483/a',
            backupUrl: ['https://cdn.bilivideo.cn:8082/a', 'https://cdn.bilivideo.com/backup.m4s'],
          },
        ],
      },
    },
  });
  const result = await readBilibiliAudio(url, 'BV1xx411c7mD', 2);
  expect(result.data?.audioUrl).toBe('https://cdn.bilivideo.com/backup.m4s');
});
it.each([
  { ...play.data, is_preview: 1 },
  { ...play.data, is_drm: true },
  { ...play.data, timelength: 1000 },
  { ...play.data, timelength: 3601000 },
  {
    ...play.data,
    dash: { audio: [{ bandwidth: 10, mimeType: 'audio/mp4', baseUrl: 'https://evil.test/a' }] },
  },
])('rejects previews, protected, partial, oversized, or foreign audio %j', async (data) => {
  fetcher({ code: 0, data });
  expect((await readBilibiliAudio(url, 'BV1xx411c7mD', 2)).ok).toBe(false);
});
it('rejects stale metadata and navigations', async () => {
  vi.stubGlobal('location', new URL(url));
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => {
      vi.stubGlobal('location', new URL(url.replace('p=2', 'p=1')));
      return Response.json(metadata);
    }),
  );
  expect((await readBilibiliAudio(url, 'BV1xx411c7mD', 2)).ok).toBe(false);
});
