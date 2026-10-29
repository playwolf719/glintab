import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { pageKey } from '../domain/page';
import type { PageSource } from '../../types';

export function extractWeb(doc: Document, url: string): PageSource {
  const clone = doc.cloneNode(true) as Document;
  clone
    .querySelectorAll(
      'script,style,iframe,noscript,svg,canvas,nav,footer,aside,[data-glintab-host]',
    )
    .forEach((el) => el.remove());
  const article = new Readability(clone.cloneNode(true) as Document).parse();
  const container = doc.createElement('div');
  container.innerHTML = article?.content || clone.body.innerHTML;
  container.querySelectorAll('a[href]').forEach((anchor) => {
    const href = anchor.getAttribute('href') || '';
    try {
      const absolute = new URL(href, url);
      if (href.startsWith('#') || !['http:', 'https:'].includes(absolute.protocol))
        anchor.replaceWith(...anchor.childNodes);
      else anchor.setAttribute('href', absolute.href);
    } catch {
      anchor.replaceWith(...anchor.childNodes);
    }
  });
  const converter = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  converter.use(gfm);
  converter.addRule('image-alt', {
    filter: 'img',
    replacement: (_, node) => {
      const alt = (node as HTMLElement).getAttribute('alt');
      return alt ? `[图片：${alt}]` : '';
    },
  });
  let text = converter.turndown(container.innerHTML).trim();
  let fallback = !article || text.length < 40;
  if (text.length < 40) text = converter.turndown(clone.body.innerHTML).trim();
  if (text.length < 40) text = (clone.body.textContent || '').replace(/\s+/g, ' ').trim();
  if (text.length < 40) throw new Error('当前页面没有足够的可读正文，请等待加载完成后重试。');
  const originalLength = text.length;
  const content = text.slice(0, 120000);
  return {
    pageKey: pageKey(url),
    url,
    title: article?.title || doc.title || new URL(url).hostname,
    content,
    originalLength,
    truncated: content.length < originalLength,
    extractedAt: Date.now(),
    fallback,
  };
}
