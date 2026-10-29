import { expect, it } from 'vitest';
import { buildContext, estimateTokens } from '../lib/domain/context';
import { pageKey } from '../lib/domain/page';
import { DEFAULT_CONFIG } from '../config/defaults';
import { conversation, provider } from './fixtures';
it('normalizes tracking parameters and query order while preserving hash routes', () => {
  expect(pageKey('https://a.test/?z=1&utm_source=x&a=2#section')).toBe('https://a.test/?a=2&z=1');
  expect(pageKey('https://a.test/#/article/1')).toBe('https://a.test/#/article/1');
});
it('fits CJK source, output reserve, and whole recent turns inside context', () => {
  const value = conversation();
  value.source.content = '中文证据'.repeat(30000);
  for (let i = 0; i < 60; i++)
    value.messages.push({
      id: String(i),
      role: i % 2 ? 'assistant' : 'user',
      content: '一个较长的问答回合。'.repeat(10),
    });
  value.messages.push({ id: 'latest', role: 'user', content: '最后的问题' });
  const result = buildContext(value, provider, DEFAULT_CONFIG.settings);
  const total =
    estimateTokens(result.system) +
    result.messages.reduce((sum, message) => sum + estimateTokens(message.content) + 8, 0) +
    result.outputTokens;
  expect(total).toBeLessThan(provider.contextLimit);
  expect(result.messages.at(-1)?.content).toBe('最后的问题');
  expect(result.messages[0]?.role).toBe('user');
  expect(result.reduced).toBe(true);
});
it('rejects a question that cannot fit instead of silently truncating it', () => {
  const value = conversation();
  value.messages = [{ id: '1', role: 'user', content: '问'.repeat(10000) }];
  expect(() => buildContext(value, provider, DEFAULT_CONFIG.settings)).toThrow('问题过长');
});
