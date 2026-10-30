// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProviderForm } from '../components/providers/ProviderForm';
import { provider } from './fixtures';
import { CHATGPT_PROVIDER_URL } from '../config/chatgpt';
import type { Request } from '../types';

const { rpc, grantProvider } = vi.hoisted(() => ({ rpc: vi.fn(), grantProvider: vi.fn() }));
vi.mock('../lib/platform/rpc', () => ({
  rpc,
  errorText: (error: unknown) => (error as Error).message,
}));
vi.mock('../lib/platform/permissions', () => ({ grantProvider }));
let root: Root;
let container: HTMLDivElement;
let close = vi.fn<() => void>();
let writeText = vi.fn();
const original = '{"tokens":{"access_token":"synthetic-current"}}';
const edited = '{"tokens":{"access_token":"synthetic-edited"}}';
beforeEach(async () => {
  vi.clearAllMocks();
  close = vi.fn();
  writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('navigator', {
    clipboard: { readText: vi.fn().mockResolvedValue(edited), writeText },
  });
  vi.stubGlobal('chrome', { permissions: { request: vi.fn().mockResolvedValue(true) } });
  rpc.mockImplementation(async (request: Request) => {
    if (request.type === 'chatgpt:auth:get')
      return { json: original, revision: 'current-revision', invalid: false };
    if (request.type === 'provider:save') return {};
    throw new Error(`Unexpected request: ${request.type}`);
  });
  grantProvider.mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(ProviderForm, {
        provider: {
          ...provider,
          apiKey: '',
          baseUrl: CHATGPT_PROVIDER_URL,
          apiFormat: 'openai_responses',
          authType: 'chatgpt',
          chatgpt: { connectionId: 'account', email: 'reader@example.test' },
        },
        onClose: close,
      }),
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === label,
  )!;
  expect(!!button).toBe(true);
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
}
const textarea = () =>
  container.querySelector<HTMLTextAreaElement>('textarea[aria-label="账号 auth.json"]')!;
const saves = () =>
  rpc.mock.calls
    .map(([request]) => request as Request)
    .filter((request) => request.type === 'provider:save');

it('displays and copies the current document, stages pasted edits and saves only after clicking save', async () => {
  expect(textarea().value).toBe(original);
  await click('复制 auth.json');
  expect(writeText).toHaveBeenCalledWith(original);
  await click('粘贴 auth.json');
  expect(textarea().value).toBe(edited);
  expect(saves()).toHaveLength(0);
  await click('保存连接');
  expect(saves()[0]).toMatchObject({
    authJson: edited,
    authRevision: 'current-revision',
    replaceAuth: true,
  });
  expect(close).toHaveBeenCalledOnce();
});
it('marks native keyboard paste as an explicit replacement even when the pasted text matches the displayed JSON', async () => {
  await act(async () => {
    textarea().dispatchEvent(new Event('paste', { bubbles: true }));
  });
  expect(saves()).toHaveLength(0);
  await click('保存连接');
  expect(saves()[0]).toMatchObject({ authJson: original, replaceAuth: true });
});
it('keeps unsaved edits after a save conflict and lets the user explicitly reload current credentials', async () => {
  await click('粘贴 auth.json');
  rpc.mockImplementation(async (request: Request) => {
    if (request.type === 'provider:save')
      throw new Error('凭证已刷新或修改，请重新读取 auth.json 后再编辑保存。');
    if (request.type === 'chatgpt:auth:get')
      return {
        json: '{"tokens":{"access_token":"newer"}}',
        revision: 'new-revision',
        invalid: false,
      };
    throw new Error('Unexpected request');
  });
  await click('保存连接');
  expect(textarea().value).toBe(edited);
  expect(close).not.toHaveBeenCalled();
  expect(container.textContent).toContain('凭证已刷新或修改');
  await click('重新读取');
  expect(textarea().value).toContain('newer');
});
