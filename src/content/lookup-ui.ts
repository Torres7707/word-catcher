import type { LookupReply } from '../lib/types';

const CARD_WIDTH = 320;
const ICON_SIZE = 26;

// Open shadow root so the page can be inspected by tests. Styles stay isolated from the page either way.
const STYLE = `
.icon { position: fixed; width: ${ICON_SIZE}px; height: ${ICON_SIZE}px; border: 0; border-radius: 50%; padding: 0;
  background: #2563eb; color: #fff; font: 600 13px/${ICON_SIZE}px system-ui, sans-serif; text-align: center;
  box-shadow: 0 2px 8px #0003; cursor: pointer; }
.card { position: fixed; width: ${CARD_WIDTH}px; max-height: 60vh; overflow: auto; box-sizing: border-box;
  background: #fff; color: #111827; border: 1px solid #e5e7eb; border-radius: 10px; box-shadow: 0 6px 20px #0003;
  padding: 12px 14px; font: 14px/1.5 system-ui, sans-serif; }
.head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
.word { font-size: 18px; font-weight: 600; }
.cnt { color: #2563eb; font-size: 12px; }
h4 { margin: 10px 0 4px; font-size: 12px; color: #6b7280; font-weight: 600; }
ul, ol { margin: 0; padding-left: 18px; }
.ex-t { color: #6b7280; }
.msg { color: #b91c1c; }
.meaning { background: #eff6ff; border-radius: 6px; padding: 6px 8px; margin-top: 6px; }
.actions { margin-top: 10px; text-align: right; }
.btn { border: 1px solid #d1d5db; background: #fff; color: #374151; border-radius: 6px; padding: 2px 10px;
  font: 12px/1.6 system-ui, sans-serif; cursor: pointer; }
.btn:hover { background: #f3f4f6; }
`;

let host: HTMLElement | null = null;
let root: ShadowRoot | null = null;
/** Bumped on every open or dismiss, so a reply that arrives late cannot draw on a closed card. */
let seq = 0;

function mount(): ShadowRoot {
  if (!root || !host) {
    host = document.createElement('div');
    host.id = 'word-catcher-lookup';
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;left:0;top:0;';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${STYLE}</style>`;
    document.documentElement.appendChild(host);
  }
  return root;
}

export function dismiss() {
  seq++;
  host?.remove();
  host = null;
  root = null;
}

function isInside(e: Event): boolean {
  return host !== null && e.composedPath().includes(host);
}

/** Closes the icon or card on a click elsewhere, Escape, or scrolling the page. */
export function initLookupUi() {
  document.addEventListener('mousedown', (e) => { if (!isInside(e)) dismiss(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') dismiss(); }, true);
  window.addEventListener('scroll', (e) => { if (!isInside(e)) dismiss(); }, { capture: true, passive: true });
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

function clampX(x: number): number {
  return Math.max(8, Math.min(x, window.innerWidth - CARD_WIDTH - 8));
}

/** Shows the lookup icon just below the end of a selection. `sentence` is the sentence the word was selected in. */
export function showIcon(word: string, sentence: string, rect: DOMRect) {
  dismiss();
  const r = mount();
  const btn = el('button', 'icon', '查');
  btn.title = `查看 ${word} 的释义`;
  const x = Math.min(rect.right, window.innerWidth - ICON_SIZE - 8);
  const y = Math.min(rect.bottom + 4, window.innerHeight - ICON_SIZE - 8);
  btn.style.left = `${x}px`;
  btn.style.top = `${y}px`;
  btn.addEventListener('click', (e) => { e.stopPropagation(); void openCard(word, sentence, x, y + ICON_SIZE + 4); });
  r.append(btn);
}

/** Asks the background for the lookup. AI is only called again when the user presses 重新生成 or 重试. */
async function openCard(word: string, sentence: string, x: number, y: number, regenerate = false) {
  const id = ++seq;
  const r = mount();
  const card = el('div', 'card', '查词中…');
  r.replaceChildren(r.querySelector('style')!, card);
  placeCard(card, x, y);

  let reply: LookupReply;
  try {
    reply = (await chrome.runtime.sendMessage({ type: 'lookup', word, sentence, regenerate })) as LookupReply;
  } catch {
    reply = { ok: false, reason: 'unknown', message: '扩展已重新加载，请刷新页面' };
  }
  if (id !== seq) return;
  if (!reply || !('ok' in reply)) reply = { ok: false, reason: 'unknown', message: '后台没有返回结果' };
  // 重试 repeats the same request; 重新生成 forces a fresh one.
  renderCard(card, word, reply, regenerate, (again) => void openCard(word, sentence, x, y, again));
  placeCard(card, x, y);
}

function placeCard(card: HTMLElement, x: number, y: number) {
  card.style.left = `${clampX(x)}px`;
  card.style.top = `${y}px`;
  // Above the word when the card would run past the bottom of the viewport.
  const h = card.getBoundingClientRect().height;
  if (y + h > window.innerHeight - 8) card.style.top = `${Math.max(8, y - h - ICON_SIZE - 8)}px`;
}

function section(card: HTMLElement, title: string, items: string[]) {
  if (items.length === 0) return;
  card.append(el('h4', '', title));
  const list = el('ul');
  for (const item of items) list.append(el('li', '', item));
  card.append(list);
}

function button(card: HTMLElement, text: string, onClick: () => void) {
  const row = el('div', 'actions');
  const btn = el('button', 'btn', text);
  btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  row.append(btn);
  card.append(row);
}

/**
 * `sent` is the regenerate flag of the request that produced this reply. `again` reloads the card:
 * 重新生成 always asks for a fresh result, 重试 repeats the request that failed.
 */
function renderCard(card: HTMLElement, word: string, reply: LookupReply, sent: boolean, again: (regenerate: boolean) => void) {
  card.replaceChildren();
  const head = el('div', 'head');
  head.append(el('span', 'word', word));
  if (reply.ok && reply.count !== undefined) head.append(el('span', 'cnt', `×${reply.count}`));
  card.append(head);

  if (!reply.ok) {
    if (reply.reason === 'unconfigured') { card.append(el('div', 'msg', '请先在设置中配置 AI')); return; }
    card.append(el('div', 'msg', `查词失败：${reply.message}`));
    button(card, '重试', () => again(sent));
    return;
  }
  if (reply.meaning) {
    card.append(el('h4', '', '原句中的意思'));
    card.append(el('div', 'meaning', reply.meaning));
  }
  const { definitions, collocations, phrases, examples } = reply.lookup;
  section(card, '释义', definitions);
  section(card, '搭配', collocations);
  section(card, '短语', phrases);
  if (examples.length > 0) {
    card.append(el('h4', '', '例句'));
    const list = el('ol');
    for (const ex of examples) {
      const li = el('li', '', ex.en);
      li.append(el('div', 'ex-t', ex.translation));
      list.append(li);
    }
    card.append(list);
  }
  button(card, '重新生成', () => again(true));
}
