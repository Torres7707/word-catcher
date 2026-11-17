import { acceptSelection, applySelection, buildExport, cleanUrl, extractSentence, mergeWords, normalizeWord, normalizeWords, parseImport, DEDUP_MS } from '../src/lib/words';
import { createStore, type Area } from '../src/lib/store';
import type { Words } from '../src/lib/types';

describe('normalize & filter', () => {
  it('normalizes', () => {
    expect(normalizeWord('  "Hello," ')).toBe('hello');
    expect(normalizeWord('(Don’t)')).toBe("don't");
  });
  it('accepts single english words', () => {
    expect(acceptSelection('Ephemeral.')).toBe('ephemeral');
    expect(acceptSelection('well-known')).toBe('well-known');
    expect(acceptSelection("it's")).toBe("it's");
  });
  it('rejects others', () => {
    for (const s of ['a', 'two words', '中文', 'abc123', '--', '', 'x'.repeat(31), 'foo--bar', 'é']) expect(acceptSelection(s)).toBeNull();
  });
  it('cleans url and sentence', () => {
    expect(cleanUrl('https://a.com/p/x?q=1#h')).toBe('https://a.com/p/x');
    expect(extractSentence('First one. The cat is ephemeral here! Last.', 'ephemeral')).toBe('The cat is ephemeral here!');
    expect(extractSentence('x'.repeat(500), 'x').length).toBe(300);
  });
});

const ev = (word: string, url: string, time: number) => ({ word, url, time, sentence: `A ${word} sentence.` });

describe('applySelection / dedup', () => {
  it('dedups same page within 5 min, counts otherwise, saves at 2', () => {
    let s = { words: {} as Words, recent: {} };
    const t0 = Date.UTC(2026, 0, 1);
    s = applySelection(s.words, s.recent, ev('retry', 'https://a.com/x', t0));
    const dup = applySelection(s.words, s.recent, ev('retry', 'https://a.com/x', t0 + 60_000));
    expect(dup.accepted).toBe(false);
    const other = applySelection(s.words, s.recent, ev('retry', 'https://b.com/', t0 + 60_000));
    expect(other.accepted).toBe(true);
    expect(other.becameSaved).toBe(true);
    const later = applySelection(s.words, s.recent, ev('retry', 'https://a.com/x', t0 + DEDUP_MS));
    expect(later.words.retry.count).toBe(2);
    expect(later.words.retry.status).toBe('saved');
    // months later still counts
    const m = applySelection(later.words, later.recent, ev('retry', 'https://a.com/x', t0 + 1e10));
    expect(m.words.retry.count).toBe(3);
    expect(m.words.retry.firstSeen).toBe(new Date(t0).toISOString());
  });
  it('keeps mastered and caps contexts at 20', () => {
    let words: Words = {}; let recent = {};
    for (let i = 0; i < 25; i++) ({ words, recent } = applySelection(words, recent, ev('foo', `https://a.com/${i}`, i * 1000)));
    expect(words.foo.contexts).toHaveLength(20);
    expect(words.foo.contexts[19].url).toBe('https://a.com/24');
    words.foo.status = 'mastered';
    const r = applySelection(words, recent, ev('foo', 'https://z.com/', 1e9));
    expect(r.words.foo.status).toBe('mastered');
    expect(r.words.foo.count).toBe(26);
    expect(r.becameSaved).toBe(false);
  });
});

function mockArea(): Area & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    async get(keys) { await new Promise((r) => setTimeout(r, Math.random() * 5)); return Object.fromEntries(keys.map((k) => [k, structuredClone(data[k])])); },
    async set(items) { await new Promise((r) => setTimeout(r, Math.random() * 5)); Object.assign(data, structuredClone(items)); },
  };
}

describe('store (mock chrome.storage)', () => {
  it('serializes concurrent captures without losing updates', async () => {
    const area = mockArea(); let badge = -1;
    const store = createStore(area, (n) => { badge = n; });
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.handle({ type: 'capture', payload: ev('race', `https://t.com/${i}`, 1000 + i) })));
    const words = area.data.words as Words;
    expect(words.race.count).toBe(10);
    expect(words.race.status).toBe('saved');
    expect(badge).toBe(1);
    await store.handle({ type: 'setStatus', word: 'race', status: 'mastered' });
    expect(badge).toBe(0);
    await store.handle({ type: 'delete', word: 'race' });
    expect(area.data.words).toEqual({});
  });
});

describe('mergeWords', () => {
  const base: Words = {
    alpha: { word: 'alpha', kind: 'word', count: 2, status: 'saved', firstSeen: '2026-01-02T00:00:00.000Z', lastSeen: '2026-01-05T00:00:00.000Z',
      contexts: [{ sentence: 's1', url: 'u1', date: '2026-01-02T00:00:00.000Z' }, { sentence: 's2', url: 'u2', date: '2026-01-05T00:00:00.000Z' }] },
  };
  it('re-importing own backup is idempotent', () => {
    expect(mergeWords(base, structuredClone(base))).toEqual(base);
  });
  it('unions contexts, takes max count, min/max dates, higher status', () => {
    const inc: Words = {
      alpha: { word: 'alpha', kind: 'word', count: 1, status: 'mastered', firstSeen: '2025-12-01T00:00:00.000Z', lastSeen: '2025-12-01T00:00:00.000Z',
        contexts: [{ sentence: 's0', url: 'u0', date: '2025-12-01T00:00:00.000Z' }] },
      beta: { word: 'Beta', kind: 'word', count: 1, status: 'seen', firstSeen: 'x', lastSeen: 'x', contexts: [] },
      'bad word': { word: 'bad word', kind: 'word', count: 1, status: 'seen', firstSeen: 'x', lastSeen: 'x', contexts: [] },
    };
    const m = mergeWords(base, inc);
    expect(m.alpha.contexts.map((c) => c.url)).toEqual(['u0', 'u1', 'u2']);
    expect(m.alpha.count).toBe(3);
    expect(m.alpha.status).toBe('mastered');
    expect(m.alpha.firstSeen).toBe('2025-12-01T00:00:00.000Z');
    expect(m.alpha.lastSeen).toBe('2026-01-05T00:00:00.000Z');
    expect(m.beta.word).toBe('beta');
    expect(m['bad word']).toBeUndefined();
  });
});

describe('entry kind and data format (ticket #2)', () => {
  const legacy = {
    alpha: { word: 'alpha', count: 2, status: 'saved', firstSeen: '2026-01-02T00:00:00.000Z', lastSeen: '2026-01-05T00:00:00.000Z', contexts: [] },
  };
  it('normalizeWords gives legacy entries without kind the kind word', () => {
    expect(normalizeWords(legacy).alpha.kind).toBe('word');
  });
  it('normalizeWords keeps an explicit kind', () => {
    expect(normalizeWords({ x: { ...legacy.alpha, kind: 'phrase' } }).x.kind).toBe('phrase');
  });
  it('normalizeWords does not change counts or status of legacy data', () => {
    const n = normalizeWords(legacy).alpha;
    expect([n.count, n.status, n.firstSeen, n.lastSeen]).toEqual([2, 'saved', '2026-01-02T00:00:00.000Z', '2026-01-05T00:00:00.000Z']);
  });
  it('applySelection creates new entries with kind word', () => {
    const r = applySelection({}, {}, ev('retry', 'https://a.com/', 1000));
    expect(r.words.retry.kind).toBe('word');
  });
  it('mergeWords output always has kind word', () => {
    const m = mergeWords({}, normalizeWords(legacy));
    expect(m.alpha.kind).toBe('word');
  });
  it('buildExport writes version 2 with the words', () => {
    const words = normalizeWords(legacy);
    expect(buildExport(words)).toEqual({ version: 2, words });
  });
  it('parseImport accepts version 1 files', () => {
    const w = parseImport(JSON.stringify({ version: 1, words: legacy }));
    expect(w.alpha.count).toBe(2);
    expect(w.alpha.kind).toBe('word');
  });
  it('parseImport accepts version 2 files', () => {
    const w = parseImport(JSON.stringify({ version: 2, words: normalizeWords(legacy) }));
    expect(w.alpha.kind).toBe('word');
  });
  it('parseImport accepts a bare words object with no version', () => {
    expect(parseImport(JSON.stringify(legacy)).alpha.count).toBe(2);
  });
  it('parseImport rejects unknown versions and non-object files', () => {
    expect(() => parseImport(JSON.stringify({ version: 3, words: legacy }))).toThrow();
    expect(() => parseImport('[]')).toThrow();
    expect(() => parseImport('"hello"')).toThrow();
    expect(() => parseImport('not json')).toThrow();
  });
  it('export then import round trip keeps every entry', () => {
    const words = normalizeWords(legacy);
    const back = mergeWords({}, parseImport(JSON.stringify(buildExport(words))));
    expect(back).toEqual(words);
  });
  it('mergeWords keeps phrase kind when either side is a phrase', () => {
    const phrase = { word: 'give up', kind: 'phrase' as const, count: 2, status: 'seen' as const, firstSeen: '2026-01-02T00:00:00.000Z', lastSeen: '2026-01-05T00:00:00.000Z', contexts: [] };
    expect(mergeWords({}, { 'give up': phrase })['give up'].kind).toBe('phrase');
    expect(mergeWords({ 'give up': phrase }, normalizeWords(legacy))['give up'].kind).toBe('phrase');
  });
  it('parseImport reads a bare map whose key is the real word "words"', () => {
    const bare = { words: { word: 'words', count: 3, status: 'seen', firstSeen: '2026-01-02T00:00:00.000Z', lastSeen: '2026-01-02T00:00:00.000Z', contexts: [] } };
    expect(parseImport(JSON.stringify(bare)).words.count).toBe(3);
  });
  it('normalizeWords keeps non-object values instead of dropping them', () => {
    const raw = { alpha: legacy.alpha, broken: null, junk: 'x', list: [1, 2] };
    const out = normalizeWords(raw as Record<string, unknown>);
    expect(Object.keys(out).sort()).toEqual(['alpha', 'broken', 'junk', 'list']);
    expect(out.broken).toBeNull();
    expect(out.junk).toBe('x');
  });
});
