import type { Context, Lookup, PhraseCheck, RecentMap, SelectionEvent, WordEntry, Words } from './types';

export const MAX_CONTEXTS = 20;
export const DEDUP_MS = 5 * 60 * 1000;
export const MAX_SENTENCE = 300;
/** A phrase candidate needs at least this confidence from the model to be counted. Boundary is inclusive. */
export const PHRASE_THRESHOLD = 0.8;
const PHRASE_MIN_WORDS = 2;
const PHRASE_MAX_WORDS = 6;
const PHRASE_MAX_LENGTH = 60;
/** Cached phrase judgements kept on the device. The oldest are dropped past this many. */
export const MAX_PHRASE_CHECKS = 2000;
/** One-letter words allowed inside a phrase, as in "a lot" or "as I see it". */
const PHRASE_SHORT_WORDS = new Set(['a', 'i']);

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

/**
 * Returns the phrase key for a selection of 2 to 6 English words (max 60 characters), else null.
 * Each word must pass the single-word rule. Case and extra spaces are dropped; forms are not changed.
 */
export function phraseCandidate(raw: string): string | null {
  const text = raw.trim().replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '').replace(/’/g, "'").replace(/\s+/g, ' ').toLowerCase();
  if (!text || text.length > PHRASE_MAX_LENGTH) return null;
  const tokens = text.split(' ');
  if (tokens.length < PHRASE_MIN_WORDS || tokens.length > PHRASE_MAX_WORDS) return null;
  // A token must already be the form the single-word rule would keep, so "give, up" is not a phrase.
  return tokens.every((t) => PHRASE_SHORT_WORDS.has(t) || acceptSelection(t) === t) ? text : null;
}

/** Adds one phrase judgement and drops the oldest ones past MAX_PHRASE_CHECKS. */
export function addPhraseCheck(checks: Record<string, PhraseCheck>, key: string, check: PhraseCheck): Record<string, PhraseCheck> {
  const next = { ...checks, [key]: check };
  const keys = Object.keys(next);
  if (keys.length <= MAX_PHRASE_CHECKS) return next;
  keys.sort((a, b) => next[a].checkedAt.localeCompare(next[b].checkedAt));
  for (const k of keys.slice(0, keys.length - MAX_PHRASE_CHECKS)) delete next[k];
  return next;
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
/** Keeps meanings only for sentences that are still among the contexts, plus the optional `keep` sentence. */
export function pruneMeanings(meanings: Record<string, string>, contexts: Context[], keep?: string): Record<string, string> {
  const live = new Set(contexts.map((c) => c.sentence));
  if (keep) live.add(keep);
  return Object.fromEntries(Object.entries(meanings).filter(([k]) => live.has(k)));
}

export function applySelection(words: Words, recent: RecentMap, ev: SelectionEvent) {
  if (isDuplicate(recent, ev)) return { words, recent, accepted: false, becameSaved: false };
  const date = new Date(ev.time).toISOString();
  const prev = words[ev.word];
  const ctx: Context = { sentence: clipSentence(ev.sentence), url: ev.url, date };
  const count = (prev?.count ?? 0) + 1;
  const kind = prev?.kind ?? ev.kind ?? 'word';
  const prevStatus = prev?.status ?? 'seen';
  const status = prevStatus === 'mastered' ? 'mastered' : count >= 2 ? 'saved' : prevStatus;
  const contexts = [...(prev?.contexts ?? []), ctx].slice(-MAX_CONTEXTS);
  const entry: WordEntry = {
    word: ev.word,
    kind,
    count,
    firstSeen: prev?.firstSeen ?? date,
    lastSeen: date,
    contexts,
    status,
    ...(prev?.lookup ? { lookup: prev.lookup } : {}),
    ...(prev?.meanings ? { meanings: pruneMeanings(prev.meanings, contexts) } : {}),
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

/** The lookup generated later wins. A missing lookup loses to any lookup. */
export function newerLookup(a?: Lookup, b?: Lookup): Lookup | undefined {
  if (!a) return b;
  if (!b) return a;
  return b.generatedAt > a.generatedAt ? b : a;
}

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
    const w = inc?.kind === 'phrase' ? phraseCandidate(inc.word ?? key) : acceptSelection(inc?.word ?? key);
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
    const lookup = newerLookup(cur?.lookup, inc.lookup);
    // The current device's meaning wins for a sentence both sides have.
    const meanings = pruneMeanings({ ...incMeanings(inc.meanings), ...cur?.meanings }, contexts);
    out[w] = {
      word: w, kind: cur?.kind === 'phrase' || inc.kind === 'phrase' ? 'phrase' : 'word', count, status,
      firstSeen: dates.sort()[0] ?? new Date().toISOString(),
      lastSeen: lasts.sort().at(-1) ?? new Date().toISOString(),
      contexts: contexts.slice(-MAX_CONTEXTS),
      ...(lookup ? { lookup } : {}),
      ...(Object.keys(meanings).length ? { meanings } : {}),
    };
  }
  return out;
}

function incMeanings(m: unknown): Record<string, string> {
  return m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, string>) : {};
}

/** Entries saved before the kind field existed are words. Counts, status and dates are untouched. */
export function normalizeWords(raw: Record<string, unknown>): Words {
  const out: Words = {};
  for (const [key, v] of Object.entries(raw)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) { out[key] = v as WordEntry; continue; }
    const e = v as WordEntry;
    out[key] = { ...e, kind: e.kind === 'phrase' ? 'phrase' : 'word' };
  }
  return out;
}

export const EXPORT_VERSION = 2;
const IMPORTABLE_VERSIONS = [1, 2];

export function buildExport(words: Words) {
  return { version: EXPORT_VERSION, words };
}

/**
 * Parse an exported file. Accepts the wrapped `{ version, words }` form (versions 1 and 2)
 * or a bare words object with no wrapper.
 */
export function parseImport(text: string): Words {
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('格式不对');
  const file = data as { version?: unknown; words?: unknown };
  let raw: unknown = data;
  // A wrapper always carries a numeric version. A bare map may hold a word named "words" or "version".
  if (typeof file.version === 'number') {
    if (!IMPORTABLE_VERSIONS.includes(file.version)) throw new Error(`不支持的文件版本: ${file.version}`);
    raw = file.words;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('格式不对');
  return normalizeWords(raw as Record<string, unknown>);
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
