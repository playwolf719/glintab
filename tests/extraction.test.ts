// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { extractWeb } from '../lib/extraction/web';
import { extractorFor } from '../lib/extraction/registry';
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
it('keeps all loaded 36kr homepage articles instead of selecting a sidebar flash', () => {
  document.title = '36氪_让一部分人先看到未来';
  document.body.innerHTML = `<nav>站点导航</nav><div class="kr-home-flow"><div>最新文章</div>${[
    ['1001', '机器人进入工厂', '新的生产线开始使用机器人，企业分享了落地进展。'],
    ['1002', '算力建设的下一步', '报道比较了不同地区的算力投资与能源需求。'],
    ['1003', '消费市场观察', '本周消费市场出现了值得关注的新变化。'],
  ]
    .map(
      ([id, title, summary]) =>
        `<div class="kr-flow-article-item"><p><a class="article-item-title" href="/p/${id}?source=home&amp;ref=">${title}</a></p><a class="article-item-description" href="/p/${id}">${summary}</a></div>`,
    )
    .join(
      '',
    )}</div><div class="kr-home-column"><p>${'侧栏快讯不是首页文章列表。'.repeat(50)}</p></div><div data-glintab-host>扩展面板内容</div>`;
  const before = document.body.innerHTML;
  const result = extractWeb(document, 'https://36kr.com/');
  expect(result.title).toBe(document.title);
  expect(result.content).toContain('[机器人进入工厂](https://36kr.com/p/1001?source=home&ref=)');
  expect(result.content).toContain('算力建设的下一步');
  expect(result.content).toContain('消费市场观察');
  expect(result.content).toContain('不同地区的算力投资与能源需求');
  expect(result.content).not.toContain('侧栏快讯');
  expect(result.content).not.toContain('站点导航');
  expect(result.content).not.toContain('扩展面板内容');
  expect(result.fallback).toBe(false);
  expect(document.body.innerHTML).toBe(before);
});
it('rejects an unloaded 36kr homepage instead of treating sidebar or verification text as articles', () => {
  for (const html of [
    `<div class="kr-home-flow"></div><p>${'只有侧栏快讯。'.repeat(50)}</p>`,
    '<p>正在进行安全检测，为保障您的访问安全，系统正在检测当前网络环境，该过程通常需要几秒钟，请耐心等待。</p>',
  ]) {
    document.body.innerHTML = html;
    expect(() => extractWeb(document, 'https://www.36kr.com/?from=test')).toThrow(
      '未找到 36 氪首页文章列表',
    );
  }
});
it('limits the 36kr homepage adapter to the root URL on the main site', () => {
  for (const url of ['https://36kr.com/', 'https://www.36kr.com/?from=test'])
    expect(extractorFor(url).id).toBe('36kr-home');
  for (const url of [
    'https://36kr.com/p/1001',
    'https://36kr.com/information/web_recommend',
    'https://ai.36kr.com/',
    'https://36kr.com.example.test/',
  ])
    expect(extractorFor(url).id).toBe('web');
  document.body.innerHTML = `<article><h1>文章详情</h1><p>${'这是需要完整保留的文章正文与证据。'.repeat(50)}</p></article>`;
  const result = extractWeb(document, 'https://36kr.com/p/1001');
  expect(result.content).toContain('这是需要完整保留的文章正文与证据。');
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
