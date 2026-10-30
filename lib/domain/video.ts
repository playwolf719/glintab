import type { VideoPlatform } from '../../types';

export function videoTarget(
  raw: string,
): { platform: VideoPlatform; videoId: string; part?: number } | undefined {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return;
    if (/(^|\.)youtube\.com$/.test(url.hostname)) {
      const id =
        url.pathname === '/watch'
          ? url.searchParams.get('v')
          : /^\/(?:shorts|live|embed)\/([^/]+)/.exec(url.pathname)?.[1];
      if (id && /^[\w-]{11}$/.test(id)) return { platform: 'youtube', videoId: id };
    }
    if (/(^|\.)bilibili\.com$/.test(url.hostname)) {
      const id = /^\/video\/(BV[\w]+|av\d+)(?:\/|$)/i.exec(url.pathname)?.[1];
      const part = Number(url.searchParams.get('p') || 1);
      if (id && Number.isSafeInteger(part) && part > 0)
        return { platform: 'bilibili', videoId: id, part };
    }
  } catch {
    /* non-web pages */
  }
}

export function timestamp(seconds: number) {
  const total = Math.floor(seconds);
  const parts = [Math.floor(total / 60) % 60, total % 60];
  if (total >= 3600) parts.unshift(Math.floor(total / 3600));
  return parts.map((part) => String(part).padStart(2, '0')).join(':');
}

export function videoTimestampUrl(url: string, seconds: number) {
  const target = videoTarget(url);
  if (!target || !Number.isFinite(seconds) || seconds < 0) return;
  const link = new URL(url);
  link.searchParams.set(
    't',
    String(Math.floor(seconds)) + (target.platform === 'youtube' ? 's' : ''),
  );
  link.hash = '';
  return link.href;
}
