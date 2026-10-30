import { pageKey } from '../domain/page';
import { timestamp, videoTarget, videoTimestampUrl } from '../domain/video';
import type { PageSource, SubtitleSegment, VideoPageResult } from '../../types';

export function videoSource(input: VideoPageResult, expectedUrl: string): PageSource {
  const target = videoTarget(expectedUrl);
  if (
    !target ||
    !input ||
    input.url !== expectedUrl ||
    input.videoId !== target.videoId ||
    input.part !== target.part
  )
    throw new Error('字幕来源与当前视频不匹配，请重新提取。');
  if (
    typeof input.body !== 'string' ||
    input.body.length > 4000000 ||
    typeof input.title !== 'string' ||
    typeof input.language !== 'string' ||
    typeof input.automatic !== 'boolean'
  )
    throw new Error('字幕数据无效，请刷新后重试。');
  if (
    input.format === 'bilibili-audio-required' &&
    target.platform === 'bilibili' &&
    input.body === ''
  )
    return {
      pageKey: pageKey(expectedUrl),
      url: expectedUrl,
      title: input.title.slice(0, 500),
      content: '',
      originalLength: 0,
      truncated: false,
      extractedAt: Date.now(),
      fallback: false,
      video: {
        ...target,
        language: 'und',
        automatic: true,
        segments: [],
        transcription: 'required',
        timestamps: false,
      },
    };
  let raw: unknown;
  try {
    raw = JSON.parse(input.body);
  } catch {
    throw new Error('字幕格式无效，请刷新后重试。');
  }
  let candidates: unknown[];
  if (input.format === 'youtube-json3' && target.platform === 'youtube') {
    const events = (raw as { events?: unknown[] } | null)?.events;
    if (!Array.isArray(events)) throw new Error('字幕格式无效，请刷新后重试。');
    candidates = events.map((event) => {
      const item = event as {
        tStartMs?: number;
        dDurationMs?: number;
        segs?: { utf8?: string }[];
      } | null;
      return {
        start: typeof item?.tStartMs === 'number' ? item.tStartMs / 1000 : NaN,
        end:
          typeof item?.tStartMs === 'number' && typeof item.dDurationMs === 'number'
            ? (item.tStartMs + item.dDurationMs) / 1000
            : NaN,
        text: Array.isArray(item?.segs)
          ? item.segs.map((seg) => (typeof seg?.utf8 === 'string' ? seg.utf8 : '')).join('')
          : '',
      };
    });
  } else if (input.format === 'segments' && Array.isArray(raw)) candidates = raw;
  else throw new Error('字幕格式无效，请刷新后重试。');
  const segments: SubtitleSegment[] = [];
  for (const candidate of candidates) {
    const item = candidate as SubtitleSegment | null;
    if (
      !item ||
      !Number.isFinite(item.start) ||
      !Number.isFinite(item.end) ||
      item.start < 0 ||
      item.end < item.start ||
      item.end > 60 * 60 * 24 * 7 ||
      typeof item.text !== 'string'
    )
      continue;
    const text = item.text
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) segments.push({ start: item.start, end: item.end, text });
  }
  segments.sort((a, b) => a.start - b.start);
  const unique = segments.filter(
    (item, index) =>
      !index ||
      item.start !== segments[index - 1]!.start ||
      item.text !== segments[index - 1]!.text,
  );
  if (!unique.length) throw new Error('没有可读取的字幕片段，请开启播放器字幕后重试。');
  const kept: SubtitleSegment[] = [];
  let content = '',
    originalLength = 0;
  for (const item of unique) {
    // Escape caption text so it cannot become fake Markdown links in the source.
    const text = item.text.replace(/[\\`*_[\]<>]/g, '\\$&');
    const line = `[${timestamp(item.start)}](${videoTimestampUrl(expectedUrl, item.start)}) ${text}\n`;
    originalLength += line.length;
    if (content.length === originalLength - line.length && content.length + line.length <= 120000) {
      content += line;
      kept.push(item);
    }
  }
  if (!kept.length) throw new Error('单条字幕过长，暂时无法读取此视频。');
  return {
    pageKey: pageKey(expectedUrl),
    url: expectedUrl,
    title: input.title.slice(0, 500),
    content,
    originalLength,
    truncated: content.length < originalLength,
    extractedAt: Date.now(),
    fallback: false,
    video: {
      ...target,
      language: input.language.slice(0, 50),
      automatic: input.automatic,
      segments: kept,
    },
  };
}
