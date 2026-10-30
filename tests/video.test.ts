// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { videoTarget, videoTimestampUrl } from '../lib/domain/video';
import { extractorFor } from '../lib/extraction/registry';
import { readVideoPage } from '../lib/extraction/video-page';
import { videoSource } from '../lib/extraction/video';
import type { VideoPageResult } from '../types';

const youtube = 'https://www.youtube.com/watch?v=abcdefghijk';
const bili = 'https://www.bilibili.com/video/BV1xx411c7mD/?p=2';
const track = {
  languageCode: 'en',
  baseUrl: 'https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en',
};
function player(tracks: unknown[] = [track], id = 'abcdefghijk') {
  const node = document.createElement('div') as unknown as HTMLElement & {
    getPlayerResponse(): unknown;
  };
  node.id = 'movie_player';
  node.getPlayerResponse = () => ({
    videoDetails: { videoId: id, title: 'Caption evidence' },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } },
  });
  document.body.replaceChildren(node);
}
function response(body: unknown) {
  return new Response(JSON.stringify(body));
}
function raw(overrides: Partial<VideoPageResult> = {}): VideoPageResult {
  return {
    url: youtube,
    videoId: 'abcdefghijk',
    title: 'A video',
    language: 'en',
    automatic: false,
    format: 'youtube-json3',
    body: JSON.stringify({
      events: [
        { tStartMs: 1200, dDurationMs: 2000, segs: [{ utf8: 'First ' }, { utf8: 'caption.' }] },
        { tStartMs: 65000, dDurationMs: 3000, segs: [{ utf8: 'Evidence at one minute.' }] },
      ],
    }),
    ...overrides,
  };
}
beforeEach(() => {
  vi.stubGlobal('location', new URL(youtube));
  vi.stubGlobal('performance', { getEntriesByType: () => [] });
  player();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});

it('routes video pages without capturing lookalike hosts or ordinary platform pages', () => {
  expect(extractorFor(youtube).id).toBe('youtube');
  expect(extractorFor(bili).id).toBe('bilibili');
  expect(videoTarget('https://m.youtube.com/shorts/abcdefghijk')?.videoId).toBe('abcdefghijk');
  expect(extractorFor('https://www.youtube.com/results?search_query=test').id).toBe('web');
  expect(videoTarget('https://youtube.com.evil.test/watch?v=abcdefghijk')).toBeUndefined();
  expect(() => extractorFor('https://www.bilibili.com/video/BV1xx411c7mD/?p=0')).toThrow(
    '视频地址无效',
  );
});
it('fetches actual caption data, preferring Chinese and marking automatic captions', async () => {
  player([
    track,
    {
      ...track,
      languageCode: 'zh-Hans',
      kind: 'asr',
      baseUrl: track.baseUrl.replace('lang=en', 'lang=zh-Hans'),
    },
  ]);
  const fetcher = vi.fn().mockResolvedValue(response(JSON.parse(raw().body)));
  vi.stubGlobal('fetch', fetcher);
  const result = await readVideoPage('youtube', youtube, 'abcdefghijk');
  expect(result.ok).toBe(true);
  expect(result.data).toMatchObject({ language: 'zh-Hans', automatic: true });
  expect(fetcher.mock.calls[0]?.[0]).toContain('lang=zh-Hans&fmt=json3');
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: 'include', redirect: 'error' });
  expect(videoSource(result.data!, youtube).content).toContain('First caption.');
});
it('uses current player identity and rejects stale SPA metadata before fetching', async () => {
  player([track], 'oldvideo123');
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  expect((await readVideoPage('youtube', youtube, 'abcdefghijk')).error).toContain(
    '尚未加载当前视频',
  );
  expect(fetcher).not.toHaveBeenCalled();
});
it('fails clearly without summarizing video navigation when there are no captions', async () => {
  player([]);
  vi.stubGlobal('fetch', vi.fn());
  expect((await readVideoPage('youtube', youtube, 'abcdefghijk')).error).toContain(
    '没有可读取的字幕',
  );
});
it('rejects untrusted caption destinations without making a request', async () => {
  player([{ ...track, baseUrl: 'https://attacker.test/subtitle' }]);
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  expect((await readVideoPage('youtube', youtube, 'abcdefghijk')).ok).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});
it('converts XML captions safely without treating text as HTML', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          '<transcript><text start="1.5" dur="2">A &amp; B &lt;script&gt;</text></transcript>',
        ),
      ),
  );
  const result = await readVideoPage('youtube', youtube, 'abcdefghijk');
  const source = videoSource(result.data!, youtube);
  expect(source.video?.segments).toEqual([{ start: 1.5, end: 3.5, text: 'A & B <script>' }]);
});
it('can reuse a current player caption URL and recover from an empty response', async () => {
  vi.stubGlobal('performance', {
    getEntriesByType: () => [
      { name: track.baseUrl + '&pot=current-player-token' },
      { name: track.baseUrl + '&kind=asr&pot=wrong-caption-kind' },
      { name: track.baseUrl + '&tlang=es&pot=wrong-translation' },
      { name: track.baseUrl.replace('abcdefghijk', 'oldvideo123') },
    ],
  });
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(''))
    .mockResolvedValueOnce(response(JSON.parse(raw().body)));
  vi.stubGlobal('fetch', fetcher);
  expect((await readVideoPage('youtube', youtube, 'abcdefghijk')).ok).toBe(true);
  expect(fetcher.mock.calls[0]?.[0]).toContain('pot=current-player-token');
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('binds Bilibili subtitles to the URL video and current part, omitting CDN cookies', async () => {
  vi.stubGlobal('location', new URL(bili));
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      response({
        code: 0,
        data: {
          bvid: 'BV1xx411c7mD',
          title: 'B video',
          pages: [
            { cid: 111, page: 1, part: 'First' },
            { cid: 222, page: 2, part: 'Second' },
          ],
        },
      }),
    )
    .mockResolvedValueOnce(
      response({
        code: 0,
        data: {
          cid: 222,
          subtitle: {
            subtitles: [
              { lan: 'ai-zh', subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/test.json' },
            ],
          },
        },
      }),
    )
    .mockResolvedValueOnce(response({ body: [{ from: 3.5, to: 6, content: '第二部分的字幕' }] }));
  vi.stubGlobal('fetch', fetcher);
  const result = await readVideoPage('bilibili', bili, 'BV1xx411c7mD', 2);
  expect(result.ok).toBe(true);
  expect(fetcher.mock.calls[1]?.[0]).toContain('cid=222');
  expect(fetcher.mock.calls[2]?.[1]).toMatchObject({ credentials: 'omit' });
  const source = videoSource(result.data!, bili);
  expect(source.video).toMatchObject({
    part: 2,
    automatic: true,
    segments: [{ start: 3.5, end: 6, text: '第二部分的字幕' }],
  });
  expect(source.content).toContain('p=2&t=3');
});
it('reports Bilibili login requirements distinctly', async () => {
  vi.stubGlobal('location', new URL(bili));
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(
        response({ code: 0, data: { bvid: 'BV1xx411c7mD', pages: [{ cid: 222, page: 2 }] } }),
      )
      .mockResolvedValueOnce(response({ code: 0, data: { need_login_subtitle: true } })),
  );
  expect((await readVideoPage('bilibili', bili, 'BV1xx411c7mD', 2)).error).toContain(
    '需要登录 B 站',
  );
});
it('rejects navigation that happens during caption fetching', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => {
      vi.stubGlobal('location', new URL(youtube.replace('abcdefghijk', 'nextvideo12')));
      return response(JSON.parse(raw().body));
    }),
  );
  expect((await readVideoPage('youtube', youtube, 'abcdefghijk')).error).toContain('视频已变化');
});
it('aborts slow requests and a fresh extraction can succeed afterwards', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    ),
  );
  const pending = readVideoPage('youtube', youtube, 'abcdefghijk');
  await vi.advanceTimersByTimeAsync(12000);
  expect((await pending).error).toContain('超时');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(JSON.parse(raw().body))));
  expect((await readVideoPage('youtube', youtube, 'abcdefghijk')).ok).toBe(true);
});
it('validates and bounds segments, keeps timestamp links and never persists signed caption URLs', () => {
  const source = videoSource(raw(), youtube);
  expect(source.content).toContain('[01:05](https://www.youtube.com/watch?v=abcdefghijk&t=65s)');
  expect(source.video?.segments[0]).toEqual({ start: 1.2, end: 3.2, text: 'First caption.' });
  expect(() => videoSource(raw({ videoId: 'oldvideo123' }), youtube)).toThrow('来源');
  expect(() =>
    videoSource(
      raw({ format: 'segments', body: JSON.stringify([{ start: -1, end: 2, text: 'invalid' }]) }),
      youtube,
    ),
  ).toThrow('没有可读取');
  const long = videoSource(
    raw({
      format: 'segments',
      body: JSON.stringify(
        Array.from({ length: 2000 }, (_, i) => ({
          start: i * 10,
          end: i * 10 + 5,
          text: '字幕证据'.repeat(25),
        })),
      ),
    }),
    youtube,
  );
  expect(long.truncated).toBe(true);
  expect(long.content.length).toBeLessThanOrEqual(120000);
  expect(long.video!.segments.length).toBeLessThan(2000);
  expect(long.content.endsWith('\n')).toBe(true);
  expect(videoTimestampUrl(bili, 3661)).toBe(
    'https://www.bilibili.com/video/BV1xx411c7mD/?p=2&t=3661',
  );
});
