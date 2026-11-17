import type { CaptureResult, Settings } from './lib/types';
import { acceptSelection, cleanUrl, extractSentence, phraseCandidate } from './lib/words';
import { initLookupUi, showIcon } from './content/lookup-ui';

function inEditable(node: Node | null): boolean {
  const el = node instanceof Element ? node : node?.parentElement;
  if (!el) return false;
  return !!el.closest('input, textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]');
}

function sentenceFor(sel: Selection, word: string): string {
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  let block: Element | null = node instanceof Element ? node : node.parentElement;
  while (block && getComputedStyle(block).display.startsWith('inline')) block = block.parentElement;
  const text = block?.textContent ?? '';
  let offset = -1;
  if (block) {
    try {
      const pre = document.createRange();
      pre.selectNodeContents(block);
      pre.setEnd(range.startContainer, range.startOffset);
      offset = pre.toString().replace(/\s+/g, ' ').length;
    } catch { /* ignore */ }
  }
  return extractSentence(text, word, offset);
}

let lastKey = '';
function onSelectionEnd() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { lastKey = ''; return; }
  if (inEditable(sel.anchorNode) || inEditable(document.activeElement)) return;
  const text = sel.toString();
  const word = acceptSelection(text);
  const phrase = word ? null : phraseCandidate(text);
  if (!word && !phrase) return;
  const target = (word ?? phrase)!;
  // mouseup + keyup can both fire for one selection; only send once per distinct selection
  const key = target + '|' + sel.anchorOffset + '|' + sel.focusOffset;
  if (key === lastKey) return;
  lastKey = key;
  const payload = { word: target, sentence: sentenceFor(sel, target), url: cleanUrl(location.href), time: Date.now() };
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  // Phrases are judged by AI first. The lookup icon for phrases comes later (ticket #8).
  const msg = word ? { type: 'capture', payload } : { type: 'capturePhrase', payload };
  chrome.runtime.sendMessage(msg).then(async (r: CaptureResult) => {
    // The icon shows for every valid word once AI is set up, including repeats that do not count.
    if (word && r?.aiConfigured) showIcon(word, payload.sentence, rect);
    if (!r?.becameSaved) return;
    const { settings } = await chrome.storage.local.get('settings');
    if ((settings as Settings | undefined)?.toast === false) return;
    toast(`✓ 已加入生词本: ${target}`);
  }).catch(() => { /* extension reloaded; ignore */ });
}

function toast(text: string) {
  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>div{font:14px/1.4 system-ui,sans-serif;background:#111827;color:#fff;padding:8px 14px;border-radius:8px;box-shadow:0 4px 12px #0004;opacity:1;transition:opacity .4s}</style><div></div>`;
  root.querySelector('div')!.textContent = text;
  document.documentElement.appendChild(host);
  setTimeout(() => { (root.querySelector('div') as HTMLElement).style.opacity = '0'; }, 2000);
  setTimeout(() => host.remove(), 2500);
}

document.addEventListener('mouseup', () => setTimeout(onSelectionEnd, 0), true);
document.addEventListener('keyup', (e) => { if (e.shiftKey || e.key === 'Shift') setTimeout(onSelectionEnd, 0); }, true);
initLookupUi();
