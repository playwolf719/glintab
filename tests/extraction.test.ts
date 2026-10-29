// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { extractWeb } from '../lib/extraction/web';
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
