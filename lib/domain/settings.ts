import type { PageSource, Settings } from '../../types';

export const SUMMARY_PROMPT_LIMIT = 12000;

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
  return {
    summaryLanguage: value.summaryLanguage,
    showContent: value.showContent,
    webPrompt: value.webPrompt,
    videoPrompt: value.videoPrompt,
  };
}

export function summaryPrompt(source: Pick<PageSource, 'video'>, settings: Settings) {
  return source.video ? settings.videoPrompt : settings.webPrompt;
}
