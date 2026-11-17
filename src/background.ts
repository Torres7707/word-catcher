import { createStore } from './lib/store';
import type { Msg, Words } from './lib/types';
import { savedCount } from './lib/words';

const setBadge = (n: number) => {
  void chrome.action.setBadgeText({ text: n > 0 ? String(n) : '' });
  void chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
};
const store = createStore(chrome.storage.local, setBadge);

chrome.runtime.onMessage.addListener((msg: Msg, sender, sendResponse) => {
  // Only extension pages (options, popup) may test the AI config; web pages run content scripts in tabs.
  if (msg.type === 'testAi' && sender.tab) {
    sendResponse({ error: 'testAi is only allowed from extension pages' });
    return false;
  }
  store.handle(msg).then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true; // async response
});

const refresh = () => chrome.storage.local.get('words').then((d) => setBadge(savedCount((d.words as Words) ?? {})));
chrome.runtime.onInstalled.addListener(refresh);
chrome.runtime.onStartup.addListener(refresh);
