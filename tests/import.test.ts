import { expect, it } from 'vitest';
import { importConfig } from '../lib/config/import';
import { providerOrigin } from '../lib/platform/permissions';
it('imports all three generic protocols without retaining source text', () => {
  const result = importConfig(
    '{"baseURL":"https://a.test/v1","api_key":"secret","model":"x","apiFormat":"openai_responses","unknown":"discard"}',
  );
  expect(result).toEqual({
    baseUrl: 'https://a.test/v1',
    apiKey: 'secret',
    model: 'x',
    apiFormat: 'openai_responses',
  });
});
it('prefers Claude auth token and supports Codex TOML', () => {
  expect(
    importConfig('{"env":{"ANTHROPIC_AUTH_TOKEN":"preferred","ANTHROPIC_API_KEY":"other"}}').apiKey,
  ).toBe('preferred');
  expect(
    importConfig(
      'model = "reader"\nmodel_provider = "custom"\n[model_providers.custom]\nbase_url = "https://a.test/v1"\nwire_api = "responses"',
    ),
  ).toMatchObject({ model: 'reader', baseUrl: 'https://a.test/v1', apiFormat: 'openai_responses' });
});
it('keeps OpenCode model IDs with slashes and context metadata', () => {
  const result = importConfig(
    JSON.stringify({
      model: 'custom/org/model',
      provider: {
        custom: {
          npm: '@ai-sdk/anthropic',
          options: { baseURL: 'https://a.test' },
          models: { 'org/model': { limit: { context: 64000 } } },
        },
      },
    }),
  );
  expect(result).toMatchObject({ model: 'org/model', apiFormat: 'anthropic', contextLimit: 64000 });
});
it('rejects invalid imports and unsafe or ambiguous endpoints', () => {
  expect(() => importConfig('bad syntax @')).toThrow();
  expect(() => importConfig('{"tokens":{"access_token":"unsupported"}}')).toThrow('OAuth');
  expect(() => providerOrigin('http://remote.test/v1')).toThrow('HTTPS');
  expect(() => providerOrigin('https://a.test/?key=secret')).toThrow();
  expect(providerOrigin('http://localhost:11434/v1')).toBe('http://localhost:11434/*');
});
