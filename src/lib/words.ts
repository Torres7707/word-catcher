import type { Context, RecentMap, SelectionEvent, WordEntry, Words } from './types';

export const MAX_CONTEXTS = 20;
export const DEDUP_MS = 5 * 60 * 1000;
export const MAX_SENTENCE = 300;

const WORD_RE = /^[a-z]+(?:['’-][a-z]+)*$/;

/** Lowercase, trim, strip surrounding punctuation/quotes, unify curly apostrophe. */
export function normalizeWord(raw: string): string {
  return raw
    .trim()
    .replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '')
    .replace(/’/g, "'")
    .toLowerCase();
}

/** Returns the normalized word if the raw selection is a single English word, else null. */
export function acceptSelection(raw: string): string | null {
  if (!raw || /\s/.test(raw.trim())) return null;
  const w = normalizeWord(raw);
  if (w.length < 2 || w.length > 30) return null;
  return WORD_RE.test(w) ? w : null;
}

/** origin + pathname, no query/hash. */
export function cleanUrl(href: string): string {
  try { const u = new URL(href); return u.origin + u.pathname; } catch { return href.split(/[?#]/)[0]; }
}

export function clipSentence(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > MAX_SENTENCE ? t.slice(0, MAX_SENTENCE - 1) + '…' : t;
}

/** Pick the sentence containing `word` out of a block of text (best effort). */
export function extractSentence(text: string, word: string, offset = -1): string {
  const flat = text.replace(/\s+/g, ' ');
  const parts = flat.match(/[^.!?。！？]+[.!?。！？]*/g) ?? [flat];
  if (offset >= 0) {
    let pos = 0;
    for (const p of parts) { if (offset < pos + p.length) return clipSentence(p); pos += p.length; }
  }
  const re = new RegExp(`\\b${word.replace(/[-']/g, '.')}\\b`, 'i');
  return clipSentence(parts.find((p) => re.test(p)) ?? flat);
}

export function isDuplicate(recent: RecentMap, ev: SelectionEvent): boolean {
  const last = recent[`${ev.word}|${ev.url}`];
  return last !== undefined && ev.time - last >= 0 && ev.time - last < DEDUP_MS;
}

export function pruneRecent(recent: RecentMap, now: number): RecentMap {
  const out: RecentMap = {};
  for (const [k, t] of Object.entries(recent)) if (now - t < DEDUP_MS) out[k] = t;
  return out;
}

/**
 * Pure update: apply one selection. Returns new words/recent maps and whether it counted.
 * Rules: same word + same page within 5 min => ignored. Otherwise count++ forever (no expiry).
 * count >= 2 => 'saved' unless already 'mastered' (mastered is never downgraded).
 */
export function applySelection(words: Words, recent: RecentMap, ev: SelectionEvent) {
  if (isDuplicate(recent, ev)) return { words, recent, accepted: false, becameSaved: false };
  const date = new Date(ev.time).toISOString();
  const prev = words[ev.word];
  const ctx: Context = { sentence: clipSentence(ev.sentence), url: ev.url, date };
  const count = (prev?.count ?? 0) + 1;
  const prevStatus = prev?.status ?? 'seen';
  const status = prevStatus === 'mastered' ? 'mastered' : count >= 2 ? 'saved' : prevStatus;
  const entry: WordEntry = {
    word: ev.word,
    count,
    firstSeen: prev?.firstSeen ?? date,
    lastSeen: date,
    contexts: [...(prev?.contexts ?? []), ctx].slice(-MAX_CONTEXTS),
    status,
  };
  return {
    words: { ...words, [ev.word]: entry },
    recent: { ...pruneRecent(recent, ev.time), [`${ev.word}|${ev.url}`]: ev.time },
    accepted: true,
    becameSaved: prevStatus === 'seen' && status === 'saved',
    entry,
  };
}

const rank = { seen: 0, saved: 1, mastered: 2 } as const;

/**
 * Merge imported data into existing.
 * - contexts: union, deduplicated by url+date, sorted by date, keep latest 20
 * - count: max(local, imported, number of unique contexts) — avoids double counting when
 *   re-importing your own backup, never loses counts.
 * - firstSeen = min, lastSeen = max
 * - status: highest of (local, imported) by seen < saved < mastered, then upgraded to 'saved' if count >= 2.
 */
export function mergeWords(base: Words, incoming: Words): Words {
  const out: Words = { ...base };
  for (const [key, inc] of Object.entries(incoming)) {
    const w = acceptSelection(inc?.word ?? key);
    if (!w || typeof inc.count !== 'number') continue;
    const cur = out[w];
    const all = [...(cur?.contexts ?? []), ...(Array.isArray(inc.contexts) ? inc.contexts : [])];
    const seen = new Set<string>();
    const contexts = all
      .filter((c) => { const k = `${c.url}|${c.date}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => a.date.localeCompare(b.date));
    const count = Math.max(cur?.count ?? 0, inc.count, contexts.length);
    let status = cur && rank[cur.status] > rank[inc.status] ? cur.status : inc.status;
    if (!(status in rank)) status = 'seen';
    if (status === 'seen' && count >= 2) status = 'saved';
    const dates = [cur?.firstSeen, inc.firstSeen].filter(Boolean) as string[];
    const lasts = [cur?.lastSeen, inc.lastSeen].filter(Boolean) as string[];
    out[w] = {
      word: w, count, status,
      firstSeen: dates.sort()[0] ?? new Date().toISOString(),
      lastSeen: lasts.sort().at(-1) ?? new Date().toISOString(),
      contexts: contexts.slice(-MAX_CONTEXTS),
    };
  }
  return out;
}

export function toMarkdown(words: Words): string {
  const groups: [string, WordEntry['status']][] = [['生词本', 'saved'], ['只划过一次', 'seen'], ['已掌握', 'mastered']];
  let md = `# Word Catcher 导出 (${new Date().toISOString().slice(0, 10)})\n`;
  for (const [title, st] of groups) {
    const list = Object.values(words).filter((w) => w.status === st).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
    md += `\n## ${title} (${list.length})\n\n`;
    for (const w of list) {
      md += `- **${w.word}** ×${w.count} (${w.firstSeen.slice(0, 10)} → ${w.lastSeen.slice(0, 10)})\n`;
      for (const c of w.contexts) md += `  - ${c.sentence} — [${c.date.slice(0, 10)}](${c.url})\n`;
    }
  }
  return md;
}

export const savedCount = (words: Words) => Object.values(words).filter((w) => w.status === 'saved').length;
