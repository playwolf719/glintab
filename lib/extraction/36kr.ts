export function is36KrHome(url: URL) {
  return (
    ['http:', 'https:'].includes(url.protocol) &&
    /^(www\.)?36kr\.com$/.test(url.hostname) &&
    url.pathname === '/'
  );
}

export function select36KrHomeContent(doc: Document) {
  const feed = doc.querySelector('.kr-home-flow');
  const hasArticles = Array.from(feed?.querySelectorAll('.article-item-title[href]') || []).some(
    (title) => title.textContent?.trim(),
  );
  if (!feed || !hasArticles)
    throw new Error('未找到 36 氪首页文章列表，请等待页面加载或完成网站验证后重新提取。');
  return feed;
}
