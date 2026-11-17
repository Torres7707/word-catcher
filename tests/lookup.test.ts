import { APICallError } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { DEFAULT_AI_CONFIG, lookupWord } from '../src/lib/ai';
import { createStore, type Area, type AiPort } from '../src/lib/store';
import type { AiConfig, AiLookupResult, Lookup, Words } from '../src/lib/types';
import { applySelection, mergeWords } from '../src/lib/words';

const cfg: AiConfig = { ...DEFAULT_AI_CONFIG, model: 'gpt-test', language: 'zh-CN' };
const lookup: Lookup = {
  definitions: ['n. 意外发现珍奇事物的运气'],
  collocations: ['by serendipity'],
  phrases: [],
  examples: [{ en: 'A happy serendipity.', translation: '一次幸运的偶遇。' }],
  generatedAt: '2026-11-17T00:00:00.000Z',
};

function memoryArea(init: Record<string, unknown> = {}): Area & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = { ...init };
  return {
    data,
    get: async (keys) => Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]])),
    set: async (items) => { Object.assign(data, items); },
  };
}

function fakeAi(result: AiLookupResult | ((word: string) => Promise<AiLookupResult>) = { ok: true, lookup }) {
  const calls: string[] = [];
  const port: AiPort = {
    test: async () => ({ ok: true }),
    lookup: async (_c, word) => { calls.push(word); return typeof result === 'function' ? result(word) : result; },
    judgePhrase: async () => ({ ok: false, reason: 'unknown', message: 'unused' }),
  };
  return { port, calls };
}

const selection = (word: string, time: number, url = 'http://a.test/p') => ({ word, sentence: `The ${word} here.`, url, time });

describe('applySelection keeps the cached lookup', () => {
  it('a new selection of a word with a lookup does not drop the lookup', () => {
    const first = applySelection({}, {}, selection('serendipity', 1_000_000));
    const withLookup: Words = { serendipity: { ...first.entry!, lookup } };
    const again = applySelection(withLookup, {}, selection('serendipity', 2_000_000, 'http://a.test/other'));
    expect(again.entry?.lookup).toEqual(lookup);
  });
});

describe('mergeWords keeps the local lookup', () => {
  it('importing a word does not drop the lookup already on this device', () => {
    const first = applySelection({}, {}, selection('serendipity', 1_000_000));
    const local: Words = { serendipity: { ...first.entry!, lookup } };
    const incoming: Words = { serendipity: { ...first.entry!, lookup: undefined } };
    expect(mergeWords(local, incoming).serendipity.lookup).toEqual(lookup);
  });
});

describe('mergeWords picks the newer lookup', () => {
  const older: Lookup = { ...lookup, generatedAt: '2026-01-01T00:00:00.000Z' };
  const newer: Lookup = { ...lookup, definitions: ['newer'], generatedAt: '2026-06-01T00:00:00.000Z' };
  const base = applySelection({}, {}, selection('serendipity', 1_000_000)).entry!;

  it('a newer incoming lookup replaces an older local one', () => {
    const local: Words = { serendipity: { ...base, lookup: older } };
    const incoming: Words = { serendipity: { ...base, lookup: newer } };
    expect(mergeWords(local, incoming).serendipity.lookup).toEqual(newer);
  });
  it('an older incoming lookup does not replace a newer local one', () => {
    const local: Words = { serendipity: { ...base, lookup: newer } };
    const incoming: Words = { serendipity: { ...base, lookup: older } };
    expect(mergeWords(local, incoming).serendipity.lookup).toEqual(newer);
  });
  it('a word new to this device takes the lookup from the file', () => {
    const incoming: Words = { serendipity: { ...base, lookup: older } };
    expect(mergeWords({}, incoming).serendipity.lookup).toEqual(older);
  });
});

describe('lookupWord (AI adapter)', () => {
  const model = (text: string) => new MockLanguageModelV3({
    doGenerate: {
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
      warnings: [],
    },
  });
  const content = { definitions: lookup.definitions, collocations: lookup.collocations, phrases: [], examples: lookup.examples };

  it('parses the structured answer into a lookup', async () => {
    const r = await lookupWord(cfg, 'serendipity', model(JSON.stringify(content)));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.lookup).toMatchObject(content);
      expect(typeof r.lookup.generatedAt).toBe('string');
    }
  });
  it('an answer that does not match the schema is a failure', async () => {
    const r = await lookupWord(cfg, 'serendipity', model('{"definitions":"not a list"}'));
    expect(r).toMatchObject({ ok: false, reason: 'unknown' });
  });
  it('a 401 from the gateway is reported as a key problem', async () => {
    const bad = new MockLanguageModelV3({
      doGenerate: async () => { throw new APICallError({ message: 'Unauthorized', url: 'x', requestBodyValues: {}, statusCode: 401, isRetryable: false }); },
    });
    expect(await lookupWord(cfg, 'serendipity', bad)).toMatchObject({ ok: false, reason: 'key' });
  });
});

describe('store lookup message', () => {
  it('capture says whether AI is configured, even for a duplicate selection', async () => {
    const area = memoryArea({ aiConfig: cfg });
    const store = createStore(area, undefined, fakeAi().port);
    const first = await store.handle({ type: 'capture', payload: selection('serendipity', 1_000_000) });
    expect(first).toMatchObject({ accepted: true, aiConfigured: true });
    const dup = await store.handle({ type: 'capture', payload: selection('serendipity', 1_100_000) });
    expect(dup).toMatchObject({ accepted: false, aiConfigured: true });
  });

  it('capture reports no AI when the saved config has no model', async () => {
    const store = createStore(memoryArea(), undefined, fakeAi().port);
    expect(await store.handle({ type: 'capture', payload: selection('serendipity', 1_000_000) })).toMatchObject({ aiConfigured: false });
  });

  it('without a saved model the lookup is refused and no request is sent', async () => {
    const ai = fakeAi();
    const store = createStore(memoryArea(), undefined, ai.port);
    await store.handle({ type: 'capture', payload: selection('serendipity', 1_000_000) });
    const r = await store.handle({ type: 'lookup', word: 'serendipity' });
    expect(r).toMatchObject({ ok: false, reason: 'unconfigured' });
    expect(ai.calls).toEqual([]);
  });

  it('the first lookup calls AI and caches the result on the entry', async () => {
    const area = memoryArea({ aiConfig: cfg });
    const ai = fakeAi();
    const store = createStore(area, undefined, ai.port);
    await store.handle({ type: 'capture', payload: selection('serendipity', 1_000_000) });
    const r = await store.handle({ type: 'lookup', word: 'serendipity' });
    expect(r).toMatchObject({ ok: true, count: 1, lookup: { definitions: lookup.definitions } });
    expect(ai.calls).toEqual(['serendipity']);
    expect((area.data.words as Words).serendipity.lookup).toMatchObject({ definitions: lookup.definitions });
  });

  it('a second lookup of the same word is served from the cache', async () => {
    const area = memoryArea({ aiConfig: cfg });
    const ai = fakeAi();
    const store = createStore(area, undefined, ai.port);
    await store.handle({ type: 'capture', payload: selection('serendipity', 1_000_000) });
    await store.handle({ type: 'lookup', word: 'serendipity' });
    const again = await store.handle({ type: 'lookup', word: 'serendipity' });
    expect(again).toMatchObject({ ok: true });
    expect(ai.calls).toHaveLength(1);
  });

  it('two lookups of one word at the same time send one request', async () => {
    const area = memoryArea({ aiConfig: cfg });
    const ai = fakeAi(async () => { await new Promise((r) => setTimeout(r, 20)); return { ok: true, lookup }; });
    const store = createStore(area, undefined, ai.port);
    await store.handle({ type: 'capture', payload: selection('serendipity', 1_000_000) });
    await Promise.all([store.handle({ type: 'lookup', word: 'serendipity' }), store.handle({ type: 'lookup', word: 'serendipity' })]);
    expect(ai.calls).toHaveLength(1);
  });

  it('a failed lookup is returned and nothing is cached', async () => {
    const area = memoryArea({ aiConfig: cfg });
    const store = createStore(area, undefined, fakeAi({ ok: false, reason: 'timeout', message: '请求超时（30 秒）' }).port);
    await store.handle({ type: 'capture', payload: selection('serendipity', 1_000_000) });
    expect(await store.handle({ type: 'lookup', word: 'serendipity' })).toMatchObject({ ok: false, reason: 'timeout' });
    expect((area.data.words as Words).serendipity.lookup).toBeUndefined();
  });

  it('a slow lookup does not hold up a selection', async () => {
    const area = memoryArea({ aiConfig: cfg });
    let release!: () => void;
    const ai = fakeAi(() => new Promise((r) => { release = () => r({ ok: true, lookup }); }));
    const store = createStore(area, undefined, ai.port);
    await store.handle({ type: 'capture', payload: selection('serendipity', 1_000_000) });
    const pending = store.handle({ type: 'lookup', word: 'serendipity' });
    const captured = await store.handle({ type: 'capture', payload: selection('gratitude', 1_000_000) });
    expect(captured).toMatchObject({ accepted: true });
    release();
    expect(await pending).toMatchObject({ ok: true });
  });
});
