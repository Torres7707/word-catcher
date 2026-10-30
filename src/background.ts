import { createStore } from './lib/store';
import type { Msg, Words } from './lib/types';
import { savedCount } from './lib/words';

const setBadge = (n: number) => {
  void chrome.action.setBadgeText({ text: n > 0 ? String(n) : '' });
  void chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
};
const store = createStore(chrome.storage.local, setBadge);

chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
  store.handle(msg).then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true; // async response
});

const refresh = () => chrome.storage.local.get('words').then((d) => setBadge(savedCount((d.words as Words) ?? {})));
chrome.runtime.onInstalled.addListener(refresh);
chrome.runtime.onStartup.addListener(refresh);
