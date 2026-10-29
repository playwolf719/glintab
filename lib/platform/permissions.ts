export function providerOrigin(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('请输入不含账号、查询参数或锚点的 HTTP(S) Base URL。');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('远程模型端点需使用 HTTPS；本机服务可以使用 HTTP。');
  return `${url.origin}/*`;
}
export async function grantProvider(baseUrl: string) {
  const origin = providerOrigin(baseUrl);
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) throw new Error('未获得模型域名访问权限。请再次保存并允许访问。');
}
