import type { PageSource, PreparedAudio, SubtitleSegment, TranscriptionConfig } from '../../types';
import { validateTranscription } from '../domain/transcription';
import { videoSource } from '../extraction/video';

export async function transcribeAudio(
  source: PageSource,
  audio: PreparedAudio,
  rawConfig: TranscriptionConfig,
  signal: AbortSignal,
  progress: (text: string) => void,
  fetcher: typeof fetch = fetch,
): Promise<PageSource> {
  const config = validateTranscription(rawConfig);
  if (!config.enabled) throw new Error('请先启用语音转写。');
  const video = source.video;
  if (video?.platform !== 'bilibili' || !audio.chunks.length)
    throw new Error('没有可转写的 B 站音轨。');
  const segments: SubtitleSegment[] = [];
  const texts: string[] = [];
  let allTimed = true,
    total = 0;
  for (let index = 0; index < audio.chunks.length; index++) {
    signal.throwIfAborted();
    const chunk = audio.chunks[index]!;
    progress(`正在转写音频 · ${index + 1}/${audio.chunks.length}`);
    const form = new FormData();
    form.append('file', new Blob([chunk.data], { type: 'audio/wav' }), `part-${index + 1}.wav`);
    form.append('model', config.model);
    form.append('response_format', config.responseFormat);
    const response = await fetcher(`${config.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      body: form,
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
      signal,
      redirect: 'error',
      credentials: 'omit',
    }).catch(() => {
      if (signal.aborted) throw signal.reason;
      throw new Error('语音转写网络失败，请检查转写服务域名权限及网络后重试。');
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(
        `语音转写失败（HTTP ${response.status}），请检查转写接口、模型、响应格式及额度。不会自动重试计费请求。`,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('转写服务返回空响应。');
    let body = '',
      size = 0;
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4_000_000) throw new Error('转写结果过大，请更换转写服务。');
        body += decoder.decode(value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    signal.throwIfAborted();
    let json: any;
    try {
      json = JSON.parse(body + decoder.decode());
    } catch {
      throw new Error('转写服务返回了无效 JSON，请检查响应格式。');
    }
    if (!json || typeof json !== 'object' || Array.isArray(json))
      throw new Error('转写服务返回了无效 JSON 对象，请检查响应格式。');
    const local: SubtitleSegment[] = Array.isArray(json.segments) ? json.segments : [];
    if (
      local.some(
        (item) =>
          !item ||
          typeof item.text !== 'string' ||
          !Number.isFinite(item.start) ||
          !Number.isFinite(item.end) ||
          item.start < 0 ||
          item.end < item.start ||
          item.end > chunk.duration + 1,
      )
    )
      throw new Error('转写服务返回的分段时间戳无效。');
    const text =
      typeof json.text === 'string'
        ? json.text.trim()
        : local
            .map((item) => item.text)
            .join(' ')
            .trim();
    if (!text) throw new Error('音频片段未识别到文字，无法生成完整转写。');
    total += text.length + 1;
    if (total > 4_000_000) throw new Error('转写文字过长，无法继续处理。');
    texts.push(text);
    if (local.length)
      segments.push(
        ...local.map((item) => ({
          start: item.start + chunk.offset,
          end: item.end + chunk.offset,
          text: item.text,
        })),
      );
    else allTimed = false;
    chunk.data = new ArrayBuffer(0);
  }
  signal.throwIfAborted();
  if (allTimed && segments.length) {
    const result = videoSource(
      {
        url: source.url,
        videoId: video.videoId,
        part: video.part,
        title: source.title,
        language: '自动识别',
        automatic: true,
        format: 'segments',
        body: JSON.stringify(segments),
      },
      source.url,
    );
    result.video!.transcription = 'complete';
    result.video!.timestamps = true;
    return result;
  }
  const content = texts.join('\n\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  return {
    ...source,
    content: content.slice(0, 120000),
    originalLength: content.length,
    truncated: content.length > 120000,
    extractedAt: Date.now(),
    video: {
      ...video,
      transcription: 'complete',
      timestamps: false,
      language: '自动识别',
      automatic: true,
      segments: [],
    },
  };
}
