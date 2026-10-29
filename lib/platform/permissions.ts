import { isReadableUrl } from '../domain/page';

export const PAGE_ACCESS_REQUIRED =
  '尚未获得此网站的读取权限。可一次授权所有网站，之后跨站使用无需重复授权。';
export const PAGE_ACCESS_DECLINED = '未获得网站读取权限，问题已保留，可再次授权后发送。';

export async function grantPageAccess(url: string, allSites: boolean) {
  if (!isReadableUrl(url)) throw new Error('当前页面受浏览器限制，请打开普通网页。');
  const origins = allSites ? ['http://*/*', 'https://*/*'] : [`${new URL(url).origin}/*`];
  const granted = await chrome.permissions.request({ origins });
  if (!granted) throw new Error(PAGE_ACCESS_DECLINED);
}

export function extractionInjectionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Extension manifest must request permission|Missing host permission/i.test(message))
    return PAGE_ACCESS_REQUIRED;
  if (/Cannot access a chrome|extensions gallery cannot be scripted/i.test(message))
    return '当前页面受浏览器限制，无法读取。请打开普通网页。';
  if (/No tab with id|Frame with ID .* was removed|No frame with id/i.test(message))
    return '来源页面已关闭或正在跳转，请等待加载后重试。';
  return '正文脚本注入失败，请重新加载扩展并刷新网页后重试。';
}

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
