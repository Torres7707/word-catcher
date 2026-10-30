import { acceptSelection, applySelection, cleanUrl, extractSentence, mergeWords, normalizeWord, DEDUP_MS } from '../src/lib/words';
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
    alpha: { word: 'alpha', count: 2, status: 'saved', firstSeen: '2026-01-02T00:00:00.000Z', lastSeen: '2026-01-05T00:00:00.000Z',
      contexts: [{ sentence: 's1', url: 'u1', date: '2026-01-02T00:00:00.000Z' }, { sentence: 's2', url: 'u2', date: '2026-01-05T00:00:00.000Z' }] },
  };
  it('re-importing own backup is idempotent', () => {
    expect(mergeWords(base, structuredClone(base))).toEqual(base);
  });
  it('unions contexts, takes max count, min/max dates, higher status', () => {
    const inc: Words = {
      alpha: { word: 'alpha', count: 1, status: 'mastered', firstSeen: '2025-12-01T00:00:00.000Z', lastSeen: '2025-12-01T00:00:00.000Z',
        contexts: [{ sentence: 's0', url: 'u0', date: '2025-12-01T00:00:00.000Z' }] },
      beta: { word: 'Beta', count: 1, status: 'seen', firstSeen: 'x', lastSeen: 'x', contexts: [] },
      'bad word': { word: 'bad word', count: 1, status: 'seen', firstSeen: 'x', lastSeen: 'x', contexts: [] },
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
