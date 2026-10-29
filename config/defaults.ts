import type { AppConfig } from '../types';
export const WEB_PROMPT =
  '请总结这篇网页的核心观点。先用一句话说明主旨，再列出关键事实与论据，最后给出值得继续思考的问题。保留重要数字，区分事实与作者观点，不编造正文没有的信息。';
export const DEFAULT_CONFIG: AppConfig = {
  schemaVersion: 1,
  providers: [],
  currentProviderId: null,
  settings: { summaryLanguage: 'zh', webPrompt: WEB_PROMPT, showContent: true },
};
export const PRESETS = [
  { name: '自定义', baseUrl: '', model: '', apiFormat: 'openai_chat' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: '', apiFormat: 'openai_chat' },
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: '', apiFormat: 'openai_chat' },
  { name: 'Anthropic', baseUrl: 'https://api.anthropic.com', model: '', apiFormat: 'anthropic' },
  { name: 'Ollama', baseUrl: 'http://localhost:11434/v1', model: '', apiFormat: 'openai_chat' },
] as const;
