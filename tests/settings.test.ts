import { expect, it } from 'vitest';
import {
  DOMAIN_PROMPT_LIMIT,
  normalizePromptDomain,
  summaryPrompt,
  validateSettings,
} from '../lib/domain/settings';
import { DEFAULT_CONFIG } from '../config/defaults';

it('selects the independently configured prompt for web and either video platform', () => {
  const settings = {
    ...DEFAULT_CONFIG.settings,
    webPrompt: '仅用于网页',
    videoPrompt: '仅用于视频',
  };
  expect(summaryPrompt({ url: 'https://example.com' }, settings)).toBe('仅用于网页');
  for (const platform of ['youtube', 'bilibili'] as const)
    expect(
      summaryPrompt(
        {
          url: 'https://example.com',
          video: { platform, videoId: 'video', language: 'zh', automatic: false, segments: [] },
        },
        settings,
      ),
    ).toBe('仅用于视频');
});

it('matches entire hostname labels and prefers the most specific domain regardless of order', () => {
  const settings = validateSettings({
    ...DEFAULT_CONFIG.settings,
    domainPrompts: [
      { id: 'specific', domain: ' Docs.Example.com. ', prompt: '技术文档摘要' },
      { id: 'general', domain: 'example.com', prompt: '网站摘要' },
      { id: 'another', domain: 'other.test', prompt: '另一网站' },
    ],
  });
  for (const url of ['https://example.com/a', 'http://www.example.com:8080/a'])
    expect(summaryPrompt({ url }, settings)).toBe('网站摘要');
  for (const url of ['https://docs.example.com', 'https://api.docs.example.com./a'])
    expect(summaryPrompt({ url }, settings)).toBe('技术文档摘要');
  expect(summaryPrompt({ url: 'https://other.test' }, settings)).toBe('另一网站');
  for (const url of [
    'https://notexample.com',
    'https://example.com.evil.test',
    'https://example.com@evil.test',
    'https://evil.test/example.com',
    'invalid url',
    'file://example.com/a',
  ])
    expect(summaryPrompt({ url }, settings)).toBe(settings.webPrompt);
  const video = {
    platform: 'youtube' as const,
    videoId: 'video',
    language: 'zh',
    automatic: false,
    segments: [],
  };
  expect(summaryPrompt({ url: 'https://docs.example.com', video }, settings)).toBe('技术文档摘要');
  expect(summaryPrompt({ url: 'https://youtube.com', video }, settings)).toBe(settings.videoPrompt);
});

it('normalizes international domains and rejects URLs, wildcards, ports and malformed hostnames', () => {
  expect(normalizePromptDomain(' 例子.测试. ')).toBe('xn--fsqu00a.xn--0zwm56d');
  expect(normalizePromptDomain('LOCALHOST')).toBe('localhost');
  for (const domain of [
    '',
    'https://example.com',
    'example.com/path',
    '*.example.com',
    'example.com:443',
    'user@example.com',
    'example.com?x=1',
    'example.com#x',
    '%65xample.com',
    'example\\com',
    'example com',
    '.example.com',
    'example..com',
    '-example.com',
    'example_.com',
    'a'.repeat(64) + '.com',
    'a.'.repeat(127) + 'com',
  ])
    expect(() => normalizePromptDomain(domain)).toThrow('域名');
  const settings = validateSettings({
    ...DEFAULT_CONFIG.settings,
    domainPrompts: [{ id: 'idn', domain: '例子.测试', prompt: '中文域名摘要' }],
  });
  expect(summaryPrompt({ url: 'https://例子.测试' }, settings)).toBe('中文域名摘要');
});

it('validates rule limits, unique normalized domains, identifiers and nonempty bounded prompts', () => {
  const rule = { id: 'one', domain: 'example.com', prompt: '摘要要求' };
  const invalidRules: unknown[] = [
    null,
    {},
    [null],
    [{ ...rule, id: '' }],
    [{ ...rule, domain: 123 }],
    [{ ...rule, prompt: ' ' }],
    [{ ...rule, prompt: '字'.repeat(12001) }],
    [rule, { ...rule, id: 'two', domain: 'EXAMPLE.COM.' }],
    [rule, { ...rule, domain: 'other.test' }],
    Array.from({ length: DOMAIN_PROMPT_LIMIT + 1 }, (_, i) => ({
      ...rule,
      id: String(i),
      domain: `domain${i}.test`,
    })),
  ];
  for (const domainPrompts of invalidRules)
    expect(() =>
      validateSettings({
        ...DEFAULT_CONFIG.settings,
        domainPrompts: domainPrompts as never,
      }),
    ).toThrow('域名');
  const { domainPrompts: _, ...legacy } = DEFAULT_CONFIG.settings;
  expect(validateSettings(legacy).domainPrompts).toEqual([]);
  expect(summaryPrompt({ url: 'https://example.com' }, legacy)).toBe(legacy.webPrompt);
});
