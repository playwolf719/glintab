import type { BilibiliAudio, PreparedAudio } from '../../types';
import {
  audioUrl,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_SECONDS,
  AUDIO_CHUNK_SECONDS,
  pcmWav,
} from '../domain/transcription';

async function mediaDuration(blob: Blob, signal: AbortSignal): Promise<number> {
  signal.throwIfAborted();
  const media = document.createElement('audio');
  const url = URL.createObjectURL(blob);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  try {
    return await new Promise<number>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      media.onloadedmetadata = () => resolve(media.duration);
      media.onerror = () => reject(new Error('浏览器无法读取此音轨的时长或格式。'));
      timer = setTimeout(() => reject(new Error('读取音轨时长超时。')), 10000);
      media.preload = 'metadata';
      media.src = url;
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    media.onloadedmetadata = null;
    media.onerror = null;
    media.removeAttribute('src');
    media.load();
    URL.revokeObjectURL(url);
  }
}

export async function prepareAudio(
  metadata: BilibiliAudio,
  signal: AbortSignal,
  progress: (text: string) => void,
): Promise<PreparedAudio> {
  signal.throwIfAborted();
  const response = await fetch(audioUrl(metadata.audioUrl), {
    signal,
    credentials: 'omit',
    redirect: 'error',
  }).catch(() => {
    if (signal.aborted) throw signal.reason;
    throw new Error('B 站音轨下载网络失败，请检查域名权限、网络或重新提取后重试。');
  });
  if (!response.ok)
    throw new Error(`B 站音轨下载失败（HTTP ${response.status}），请重新提取后重试。`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('音轨响应为空。');
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    if (Number(response.headers.get('content-length')) > MAX_AUDIO_BYTES)
      throw new Error('音轨超过首版 64 MB 下载上限。');
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_AUDIO_BYTES) throw new Error('音轨超过首版 64 MB 下载上限。');
      parts.push(value);
      progress(`正在下载 B 站音轨 · ${(size / 1024 / 1024).toFixed(1)} MB`);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (!size) throw new Error('下载的音轨为空。');
  signal.throwIfAborted();
  progress('正在解码音轨并准备转写片段…');
  // Check container duration before allocating full decoded PCM memory.
  const duration = await mediaDuration(new Blob(parts, { type: 'audio/mp4' }), signal);
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > MAX_AUDIO_SECONDS + 1 ||
    Math.abs(duration - metadata.duration) > Math.max(3, metadata.duration * 0.02)
  )
    throw new Error('音轨时长与当前视频不符或超过 60 分钟，无法继续转写。');
  const context = new AudioContext({ sampleRate: 16000 });
  try {
    const bytes = new Uint8Array(size);
    let position = 0;
    for (const part of parts) {
      bytes.set(part, position);
      position += part.length;
    }
    parts.length = 0;
    const decoded = await context.decodeAudioData(bytes.buffer);
    signal.throwIfAborted();
    if (decoded.numberOfChannels < 1 || decoded.numberOfChannels > 2)
      throw new Error('首版仅支持单声道或双声道音轨。');
    if (
      !Number.isFinite(decoded.duration) ||
      decoded.duration <= 0 ||
      decoded.duration > MAX_AUDIO_SECONDS + 1 ||
      Math.abs(decoded.duration - metadata.duration) > Math.max(3, metadata.duration * 0.02)
    )
      throw new Error('下载音轨的时长与当前视频不符，无法确认完整音频。');
    const chunks: PreparedAudio['chunks'] = [];
    const frames = Math.floor(decoded.sampleRate * AUDIO_CHUNK_SECONDS);
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) =>
      decoded.getChannelData(index),
    );
    for (let start = 0; start < decoded.length; start += frames) {
      signal.throwIfAborted();
      const length = Math.min(frames, decoded.length - start);
      const mono = new Float32Array(length);
      for (const channel of channels)
        for (let i = 0; i < length; i++) mono[i] = mono[i]! + channel[start + i]! / channels.length;
      chunks.push({
        data: pcmWav(mono, decoded.sampleRate),
        offset: start / decoded.sampleRate,
        duration: length / decoded.sampleRate,
      });
    }
    return { chunks };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof DOMException)
      throw new Error('浏览器无法解码此音轨，暂不支持该音频格式。');
    throw error;
  } finally {
    await context.close().catch(() => {});
  }
}
