import type { Conversation, Provider, StartTask } from '../types';
import { DEFAULT_CONFIG } from '../config/defaults';
export const provider: Provider = {
  id: 'p',
  name: 'Test',
  baseUrl: 'https://example.com/v1',
  apiKey: 'test-only',
  model: 'test-model',
  apiFormat: 'openai_chat',
  contextLimit: 8192,
  createdAt: 1,
};
export function conversation(url = 'https://article.test/read'): Conversation {
  return {
    id: crypto.randomUUID(),
    source: {
      pageKey: url,
      url,
      title: 'Test reading',
      content: 'A meaningful article about evidence and careful reading. '.repeat(100),
      originalLength: 5500,
      truncated: false,
      extractedAt: 1,
      fallback: false,
    },
    messages: [],
    updatedAt: 1,
    revision: '',
  };
}
export function task(tabId = 1): StartTask {
  return {
    streamId: crypto.randomUUID(),
    tabId,
    conversation: conversation(),
    provider,
    settings: DEFAULT_CONFIG.settings,
    question: 'What is the core idea?',
    summary: false,
  };
}
