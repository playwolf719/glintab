// Extraction adapters live behind this boundary. Add video/PDF adapters here,
// keeping their platform-specific permissions and lifecycle out of the UI.
import { videoTarget } from '../domain/video';

export interface ExtractorRegistration {
  id: string;
  matches(url: URL): boolean;
  script: string;
}
export const extractors: ExtractorRegistration[] = [
  {
    id: 'web',
    matches: (url) => ['http:', 'https:'].includes(url.protocol),
    script: '/content-scripts/extract.js',
  },
];
export function extractorFor(url: string) {
  const parsed = new URL(url);
  const video = videoTarget(url);
  if (video) return { id: video.platform, video };
  if (
    (/(^|\.)youtube\.com$/.test(parsed.hostname) &&
      /^\/(watch|shorts|live|embed)(\/|$)/.test(parsed.pathname)) ||
    (/(^|\.)bilibili\.com$/.test(parsed.hostname) && parsed.pathname.startsWith('/video/'))
  )
    throw new Error('视频地址无效，请打开完整的视频页面后重试。');
  const extractor = extractors.find((item) => item.matches(parsed));
  if (!extractor) throw new Error('当前页面无法读取，请打开普通 HTTP(S) 网页。');
  return extractor;
}
