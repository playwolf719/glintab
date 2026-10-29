import { afterEach, expect, it, vi } from 'vitest';
import {
  extractionInjectionError,
  grantPageAccess,
  PAGE_ACCESS_DECLINED,
  PAGE_ACCESS_REQUIRED,
} from '../lib/platform/permissions';

afterEach(() => vi.unstubAllGlobals());

it('requests optional access to both web schemes in a single user action', async () => {
  const request = vi.fn().mockResolvedValue(true);
  vi.stubGlobal('chrome', { permissions: { request } });
  await grantPageAccess('https://article.test/read', true);
  expect(request).toHaveBeenCalledExactlyOnceWith({ origins: ['http://*/*', 'https://*/*'] });
});

it('keeps per-site access available and reports declined permission', async () => {
  const request = vi.fn().mockResolvedValue(false);
  vi.stubGlobal('chrome', { permissions: { request } });
  await expect(grantPageAccess('https://article.test/read?private=value', false)).rejects.toThrow(
    PAGE_ACCESS_DECLINED,
  );
  expect(request).toHaveBeenCalledExactlyOnceWith({ origins: ['https://article.test/*'] });
});

it('does not request web permission for browser-restricted pages', async () => {
  const request = vi.fn();
  vi.stubGlobal('chrome', { permissions: { request } });
  await expect(grantPageAccess('chrome://settings', true)).rejects.toThrow('浏览器限制');
  expect(request).not.toHaveBeenCalled();
});

it('only suggests permission for host permission failures', () => {
  expect(
    extractionInjectionError(
      new Error(
        'Cannot access contents of url "https://private.test/?secret=value". Extension manifest must request permission to access this host.',
      ),
    ),
  ).toBe(PAGE_ACCESS_REQUIRED);
  expect(
    extractionInjectionError(new Error("Could not load file: 'content-scripts/extract.js'.")),
  ).toContain('重新加载扩展');
  expect(extractionInjectionError(new Error('No tab with id: 12.'))).toContain('已关闭');
  expect(extractionInjectionError(new Error('Cannot access a chrome:// URL'))).toContain(
    '浏览器限制',
  );
  expect(
    extractionInjectionError(new Error('unknown https://private.test/?secret=value')),
  ).not.toContain('private.test');
});
