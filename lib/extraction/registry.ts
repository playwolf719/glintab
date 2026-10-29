// Extraction adapters live behind this boundary. Add video/PDF adapters here,
// keeping their platform-specific permissions and lifecycle out of the UI.
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
  // Until subtitle adapters are implemented, do not silently summarize video UI.
  if (
    (/(^|\.)youtube\.com$/.test(parsed.hostname) && parsed.pathname === '/watch') ||
    (/(^|\.)bilibili\.com$/.test(parsed.hostname) && parsed.pathname.startsWith('/video/'))
  )
    throw new Error('此版本支持网页正文；YouTube 与 B 站字幕适配将在后续版本加入。');
  const extractor = extractors.find((item) => item.matches(parsed));
  if (!extractor) throw new Error('当前页面无法读取，请打开普通 HTTP(S) 网页。');
  return extractor;
}
