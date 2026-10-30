import type { TranscriptionConfig } from '../../types';
import { providerOrigin } from '../platform/permissions';

export const AUDIO_ORIGINS = ['https://*.bilivideo.com/*', 'https://*.bilivideo.cn/*'];
export const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
export const MAX_AUDIO_SECONDS = 3600;
export const AUDIO_CHUNK_SECONDS = 300;

export function validateTranscription(value: TranscriptionConfig): TranscriptionConfig {
  if (
    !value ||
    typeof value.enabled !== 'boolean' ||
    typeof value.baseUrl !== 'string' ||
    typeof value.apiKey !== 'string' ||
    typeof value.model !== 'string' ||
    !['json', 'verbose_json'].includes(value.responseFormat)
  )
    throw new Error('转写配置无效，请重新保存。');
  const baseUrl = value.baseUrl.trim().replace(/\/+$/, '');
  if (value.enabled || baseUrl) providerOrigin(baseUrl);
  if (value.enabled && !value.model.trim()) throw new Error('请填写转写模型 ID。');
  if (value.model.length > 200 || value.apiKey.length > 4096) throw new Error('转写配置字段过长。');
  return {
    enabled: value.enabled,
    baseUrl,
    apiKey: value.apiKey.trim(),
    model: value.model.trim(),
    responseFormat: value.responseFormat,
  };
}

export function audioUrl(raw: string) {
  const url = new URL(raw);
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !/(^|\.)(bilivideo\.com|bilivideo\.cn)$/.test(url.hostname)
  )
    throw new Error('音轨地址不属于支持的 B 站音频域名。');
  return url.href;
}

// Each chunk is an independent PCM WAV file, not a byte slice of compressed media.
export function pcmWav(samples: Float32Array, sampleRate = 16000): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) =>
    [...text].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  write(0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => {
    const clipped = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + i * 2, clipped < 0 ? clipped * 32768 : clipped * 32767, true);
  });
  return buffer;
}
