// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { extractWeb } from '../lib/extraction/web';
import { buildContext } from '../lib/domain/context';
import { DEFAULT_CONFIG } from '../config/defaults';
import { conversation, provider } from './fixtures';
it('extracts a detached clone, absolutizes links and removes script noise', () => {
  document.body.innerHTML = `<nav>navigation noise</nav><article><h1>A careful article</h1><p>${'This is the actual evidence. '.repeat(50)}</p><a href="/evidence">Evidence</a><img alt="Diagram" src="/image.jpg"><script>private noise</script></article>`;
  document.title = 'Source title';
  const before = document.body.innerHTML;
  const result = extractWeb(document, 'https://article.test/page');
  expect(result.content).toContain('https://article.test/evidence');
  expect(result.content).toContain('[图片：Diagram]');
  expect(result.content).not.toContain('private noise');
  expect(document.body.innerHTML).toBe(before);
});
it('rejects a page with no meaningful text', () => {
  document.body.innerHTML = '<div>Empty</div>';
  expect(() => extractWeb(document, 'https://article.test/empty')).toThrow('没有足够');
});
it('preserves a signed image-only cover link, including empty query values, without changing the live page', () => {
  const relative = '/explore/note-test?xsec_token=synthetic%2Btoken%3D&xsec_source=';
  document.body.innerHTML = `<article><h1>阅读列表</h1><p>${'文章中有需要核对的观点与证据。'.repeat(60)}</p><a class="cover mask ld" target="_self" href="${relative.replaceAll('&', '&amp;')}"><img src="https://images.example.test/cover.jpg"></a><h2>一篇笔记的标题</h2></article>`;
  const before = document.body.innerHTML;
  const result = extractWeb(document, 'https://www.xiaohongshu.com/search_result');
  expect(result.content).toContain(`[查看原文](https://www.xiaohongshu.com${relative})`);
  expect(result.content).not.toContain('&amp;');
  expect(result.content).not.toContain('images.example.test');
  expect(document.body.innerHTML).toBe(before);
  const value = conversation(result.url);
  value.source = result;
  value.messages = [{ id: 'q', role: 'user', content: '分析这些笔记并提供来源链接' }];
  const context = buildContext(value, provider, DEFAULT_CONFIG.settings);
  expect(context.system).toContain(`https://www.xiaohongshu.com${relative}`);
  expect(context.system).toContain('including all query parameters and their values');
});
it('uses existing accessible labels for image links and rejects unsafe destinations before fallback conversion', () => {
  document.body.innerHTML = `<p>${'用于核对内容的正文。'.repeat(8)}</p><a href="/note?signature=fake%2Bvalue%3D&amp;source=" aria-label="原页面提供的标题"><img src="/cover.jpg"></a><a href="javascript:alert(1)">危险地址</a>`;
  const result = extractWeb(document, 'https://source.example.test/list');
  expect(result.content).toContain(
    '[原页面提供的标题](https://source.example.test/note?signature=fake%2Bvalue%3D&source=)',
  );
  expect(result.content).not.toContain('javascript:');
  expect(result.content).not.toContain('cover.jpg');
});
