import { defineContentScript } from 'wxt/utils/define-content-script';
import { extractWeb } from '../lib/extraction/web';

export default defineContentScript({
  // Empty matches prevents WXT granting permanent all-site host permissions.
  // This bundle is injected by background using activeTab or a user-approved host.
  matches: [],
  registration: 'runtime',
  main() {
    // Each injection computes once and leaves no duplicate message listeners.
    const result = (() => {
      try {
        return { ok: true, data: extractWeb(document, location.href) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : '提取失败。' };
      }
    })();
    void chrome.runtime.sendMessage({ channel: 'glintab:extracted', result }).catch(() => {});
  },
});
