import { ChatGPTAccounts } from './accounts';
import { CHATGPT_AUTH_ORIGIN } from '../../config/chatgpt';
import { callbackParameters } from './oauth';
import type { Repository } from '../storage/repository';

export function browserAccounts(repository: Repository, session: Repository) {
  return new ChatGPTAccounts(repository, session, {
    async create() {
      return (await chrome.tabs.create({ url: 'about:blank' })).id!;
    },
    async open(tabId, url) {
      await chrome.tabs.update(tabId, { url });
    },
    async urls(tabId) {
      const tab = await chrome.tabs.get(tabId);
      return [tab.pendingUrl, tab.url].filter((url): url is string => !!url);
    },
    async close(tabId) {
      const tab = await chrome.tabs.get(tabId);
      const url = tab.pendingUrl || tab.url || '';
      // Leave a tab alone if the user has since navigated it elsewhere.
      if (
        url === 'about:blank' ||
        url === chrome.runtime.getURL('/auth-complete.html') ||
        new URL(url).origin === CHATGPT_AUTH_ORIGIN ||
        callbackParameters(url)
      )
        await chrome.tabs.remove(tabId);
    },
    async complete(tabId) {
      await chrome.tabs.update(tabId, { url: chrome.runtime.getURL('/auth-complete.html') });
    },
  });
}
