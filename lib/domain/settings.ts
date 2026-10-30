import type { PageSource, Settings } from '../../types';

export const SUMMARY_PROMPT_LIMIT = 12000;
export const DOMAIN_PROMPT_LIMIT = 50;

export function normalizePromptDomain(value: string): string {
  const domain = value.trim().replace(/\.$/, '');
  const invalid = () =>
    new Error('请填写有效域名（如 example.com），不含协议、路径、端口或通配符。');
  if (!domain || domain.length > 253 || /[/\\:@?#%\s]/.test(domain)) throw invalid();
  let hostname: string;
  try {
    hostname = new URL(`https://${domain}`).hostname;
  } catch {
    throw invalid();
  }
  if (
    hostname.length > 253 ||
    hostname.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    throw invalid();
  return hostname;
}

export function validateSettings(value: Settings): Settings {
  if (
    !value ||
    !['zh', 'en', 'auto'].includes(value.summaryLanguage) ||
    typeof value.showContent !== 'boolean'
  )
    throw new Error('设置无效，请重新打开设置页。');
  for (const [key, label] of [
    ['webPrompt', '网页'],
    ['videoPrompt', '视频'],
  ] as const) {
    if (typeof value[key] !== 'string' || !value[key].trim())
      throw new Error(`${label}摘要指令不能为空。`);
    if (value[key].length > SUMMARY_PROMPT_LIMIT)
      throw new Error(`${label}摘要指令不能超过 ${SUMMARY_PROMPT_LIMIT} 个字符。`);
  }
  if (
    value.domainPrompts !== undefined &&
    (!Array.isArray(value.domainPrompts) || value.domainPrompts.length > DOMAIN_PROMPT_LIMIT)
  )
    throw new Error(`域名摘要指令最多设置 ${DOMAIN_PROMPT_LIMIT} 条。`);
  const domains = new Set<string>();
  const ids = new Set<string>();
  const domainPrompts = (value.domainPrompts || []).map((rule) => {
    if (
      !rule ||
      typeof rule.id !== 'string' ||
      !rule.id.trim() ||
      rule.id.length > 100 ||
      ids.has(rule.id) ||
      typeof rule.domain !== 'string'
    )
      throw new Error('域名摘要指令无效，请删除后重新添加。');
    const domain = normalizePromptDomain(rule.domain);
    if (domains.has(domain)) throw new Error('同一个域名只能设置一条摘要指令。');
    if (typeof rule.prompt !== 'string' || !rule.prompt.trim())
      throw new Error('域名摘要指令不能为空。');
    if (rule.prompt.length > SUMMARY_PROMPT_LIMIT)
      throw new Error(`域名摘要指令不能超过 ${SUMMARY_PROMPT_LIMIT} 个字符。`);
    domains.add(domain);
    ids.add(rule.id);
    return { id: rule.id, domain, prompt: rule.prompt };
  });
  return {
    summaryLanguage: value.summaryLanguage,
    showContent: value.showContent,
    webPrompt: value.webPrompt,
    videoPrompt: value.videoPrompt,
    domainPrompts,
  };
}

export function summaryPrompt(source: Pick<PageSource, 'url' | 'video'>, settings: Settings) {
  let hostname = '';
  try {
    const url = new URL(source.url);
    if (url.protocol === 'http:' || url.protocol === 'https:')
      hostname = url.hostname.replace(/\.$/, '');
  } catch {
    // Invalid or unsupported source URLs use the existing general prompt.
  }
  const matched = (settings.domainPrompts || [])
    .filter((rule) => hostname === rule.domain || hostname.endsWith(`.${rule.domain}`))
    .sort((a, b) => b.domain.length - a.domain.length)[0];
  if (matched) return matched.prompt;
  return source.video ? settings.videoPrompt : settings.webPrompt;
}
