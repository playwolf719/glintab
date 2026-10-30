import type { AppConfig } from '../types';
export const DEFAULT_CONTEXT_LIMIT = 1_000_000;
export const WEB_PROMPT =
  '请总结这篇网页的核心观点。先用一句话说明主旨，再列出关键事实与论据，最后给出值得继续思考的问题。保留重要数字，区分事实与作者观点，不编造正文没有的信息。';
export const VIDEO_PROMPT =
  '请根据视频字幕总结核心内容。先用一句话概括主旨，再按主题或时间线列出关键观点、事实与结论，并引用字幕中提供的相关时间戳链接。保留重要数字，区分事实与讲述者观点；自动字幕可能有误，不编造字幕中没有的内容，也不要推断未提供的视频画面。';
export const DEFAULT_CONFIG: AppConfig = {
  schemaVersion: 2,
  providers: [],
  currentProviderId: null,
  settings: {
    summaryLanguage: 'zh',
    webPrompt: WEB_PROMPT,
    videoPrompt: VIDEO_PROMPT,
    domainPrompts: [],
    showContent: true,
  },
};
export const PRESETS = [
  { name: '自定义', baseUrl: '', model: '', apiFormat: 'openai_chat' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: '', apiFormat: 'openai_chat' },
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: '', apiFormat: 'openai_chat' },
  { name: 'Anthropic', baseUrl: 'https://api.anthropic.com', model: '', apiFormat: 'anthropic' },
  { name: 'Ollama', baseUrl: 'http://localhost:11434/v1', model: '', apiFormat: 'openai_chat' },
] as const;
