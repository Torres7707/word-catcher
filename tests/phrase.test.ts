import { MockLanguageModelV3 } from 'ai/test';
import { DEFAULT_AI_CONFIG, judgePhrase } from '../src/lib/ai';
import { createStore, type Area, type AiPort } from '../src/lib/store';
import type { AiConfig, AiPhraseResult, SelectionEvent, Words } from '../src/lib/types';
import { addPhraseCheck, applySelection, MAX_PHRASE_CHECKS, mergeWords, phraseCandidate, PHRASE_THRESHOLD } from '../src/lib/words';
import type { PhraseCheck } from '../src/lib/types';

const cfg: AiConfig = { ...DEFAULT_AI_CONFIG, model: 'gpt-test', language: 'zh-CN' };

function memoryArea(init: Record<string, unknown> = {}): Area & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = { ...init };
  return {
    data,
    get: async (keys) => Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]])),
    set: async (items) => { Object.assign(data, items); },
  };
}

function fakeAi(result: AiPhraseResult | ((text: string) => Promise<AiPhraseResult>) = { ok: true, isPhrase: true, confidence: 0.9 }) {
  const calls: string[] = [];
  const port: AiPort = {
    test: async () => ({ ok: true }),
    lookup: async () => ({ ok: false, reason: 'unknown', message: 'unused' }),
    meaning: async () => ({ ok: false, reason: 'unknown', message: 'unused' }),
    judgePhrase: async (_c, text) => { calls.push(text); return typeof result === 'function' ? result(text) : result; },
  };
  return { port, calls };
}

const sel = (word: string, time = 1_000_000, url = 'http://a.test/p'): SelectionEvent => ({ word, sentence: `We ${word} today.`, url, time });
const capture = (store: ReturnType<typeof createStore>, word: string, time?: number, url?: string) =>
  store.handle({ type: 'capturePhrase', payload: sel(word, time, url) });

describe('phraseCandidate', () => {
  it('accepts 2 to 6 plain words and normalizes case and spacing', () => {
    expect(phraseCandidate('Give   UP')).toBe('give up');
    expect(phraseCandidate('look\tforward   to it')).toBe('look forward to it');
    expect(phraseCandidate('ab cd ef gh ij kl')).toBe('ab cd ef gh ij kl');
  });
  it('strips punctuation around the whole selection', () => {
    expect(phraseCandidate('"give up."')).toBe('give up');
  });
  it('rejects one word, seven words, and text over 60 characters', () => {
    expect(phraseCandidate('serendipity')).toBeNull();
    expect(phraseCandidate('a b c d e f g')).toBeNull();
    expect(phraseCandidate(`${'abcdefghij '.repeat(6).trim()}`)).toBeNull();
  });
  it('allows the one-letter words a and I inside a phrase', () => {
    expect(phraseCandidate('a lot')).toBe('a lot');
    expect(phraseCandidate('All of a sudden')).toBe('all of a sudden');
    expect(phraseCandidate('as I see it')).toBe('as i see it');
    expect(phraseCandidate('x ray')).toBeNull();
  });
  it('rejects text with digits or punctuation inside a word', () => {
    expect(phraseCandidate('give 2 up')).toBeNull();
    expect(phraseCandidate('give, up')).toBeNull();
    expect(phraseCandidate('give up!!! now')).toBeNull();
  });
});

describe('phrase entries in word data', () => {
  it('a selection of a phrase keeps the phrase kind', () => {
    const r = applySelection({}, {}, { ...sel('give up'), kind: 'phrase' });
    expect(r.entry).toMatchObject({ word: 'give up', kind: 'phrase', count: 1 });
  });
  it('importing a phrase keeps it instead of dropping it as an invalid word', () => {
    const phrase = applySelection({}, {}, { ...sel('give up'), kind: 'phrase' }).entry!;
    const merged = mergeWords({}, { 'give up': phrase });
    expect(merged['give up']).toMatchObject({ kind: 'phrase', count: 1 });
  });
});

describe('addPhraseCheck', () => {
  const at = (i: number): PhraseCheck => ({ isPhrase: false, confidence: 0.1, checkedAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString() });
  it('keeps only the newest judgements once the limit is reached', () => {
    let checks: Record<string, PhraseCheck> = {};
    for (let i = 0; i < MAX_PHRASE_CHECKS; i++) checks = addPhraseCheck(checks, `k${i} x`, at(i));
    checks = addPhraseCheck(checks, 'newest one', at(MAX_PHRASE_CHECKS));
    expect(Object.keys(checks)).toHaveLength(MAX_PHRASE_CHECKS);
    expect(checks['k0 x']).toBeUndefined();
    expect(checks['newest one']).toBeDefined();
  });
});

describe('judgePhrase (AI adapter)', () => {
  const model = (text: string) => new MockLanguageModelV3({
    doGenerate: {
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
      warnings: [],
    },
  });

  it('reads whether the text is a phrase and how sure the model is', async () => {
    const r = await judgePhrase(cfg, 'give up', model('{"isPhrase":true,"confidence":0.93}'));
    expect(r).toEqual({ ok: true, isPhrase: true, confidence: 0.93 });
  });
  it('a confidence outside 0 to 1 is a failure', async () => {
    expect(await judgePhrase(cfg, 'give up', model('{"isPhrase":true,"confidence":1.5}'))).toMatchObject({ ok: false });
  });
});

describe('store capturePhrase message', () => {
  it('the threshold is 0.8', () => {
    expect(PHRASE_THRESHOLD).toBe(0.8);
  });

  it('a confidence of exactly 0.8 is recorded as a phrase and counted', async () => {
    const area = memoryArea({ aiConfig: cfg });
    const store = createStore(area, undefined, fakeAi({ ok: true, isPhrase: true, confidence: 0.8 }).port);
    const r = await capture(store, 'give up');
    expect(r).toMatchObject({ accepted: true, entry: { word: 'give up', kind: 'phrase', count: 1 } });
    expect((area.data.words as Words)['give up']).toMatchObject({ kind: 'phrase' });
  });

  it('a confidence just under 0.8 is ignored', async () => {
    const area = memoryArea({ aiConfig: cfg });
    const store = createStore(area, undefined, fakeAi({ ok: true, isPhrase: true, confidence: 0.79 }).port);
    expect(await capture(store, 'give up')).toMatchObject({ accepted: false, becameSaved: false });
    expect(area.data.words).toBeUndefined();
  });

  it('text the model says is not a phrase is ignored, even when it is confident', async () => {
    const area = memoryArea({ aiConfig: cfg });
    const store = createStore(area, undefined, fakeAi({ ok: true, isPhrase: false, confidence: 0.99 }).port);
    expect(await capture(store, 'red car')).toMatchObject({ accepted: false });
    expect(area.data.words).toBeUndefined();
  });

  it('the second counted selection of a phrase makes it saved', async () => {
    const store = createStore(memoryArea({ aiConfig: cfg }), undefined, fakeAi().port);
    await capture(store, 'give up', 1_000_000, 'http://a.test/p');
    const second = await capture(store, 'give up', 1_000_000 + 10 * 60_000, 'http://a.test/q');
    expect(second).toMatchObject({ accepted: true, becameSaved: true, entry: { count: 2, status: 'saved' } });
  });

  it('judgements are cached, including negative ones', async () => {
    const ai = fakeAi({ ok: true, isPhrase: false, confidence: 0.2 });
    const store = createStore(memoryArea({ aiConfig: cfg }), undefined, ai.port);
    await capture(store, 'red car');
    await capture(store, 'red car', 1_000_000 + 10 * 60_000, 'http://a.test/q');
    expect(ai.calls).toEqual(['red car']);
  });

  it('casing and extra spaces are one phrase with one judgement', async () => {
    const area = memoryArea({ aiConfig: cfg });
    const ai = fakeAi();
    const store = createStore(area, undefined, ai.port);
    await capture(store, 'Give  up');
    await capture(store, 'give up', 1_000_000 + 10 * 60_000, 'http://a.test/q');
    expect(ai.calls).toEqual(['give up']);
    expect(Object.keys(area.data.words as Words)).toEqual(['give up']);
  });

  it('words inside a counted phrase are not counted', async () => {
    const area = memoryArea({ aiConfig: cfg });
    const store = createStore(area, undefined, fakeAi().port);
    await capture(store, 'give up');
    const words = area.data.words as Words;
    expect(words.give).toBeUndefined();
    expect(words.up).toBeUndefined();
  });

  it('a failed judgement ignores the selection and is not cached', async () => {
    const area = memoryArea({ aiConfig: cfg });
    let fail = true;
    const ai = fakeAi(async () => (fail ? { ok: false, reason: 'timeout', message: '请求超时（30 秒）' } : { ok: true, isPhrase: true, confidence: 0.9 }));
    const store = createStore(area, undefined, ai.port);
    expect(await capture(store, 'give up')).toMatchObject({ accepted: false });
    expect(area.data.words).toBeUndefined();
    fail = false;
    expect(await capture(store, 'give up', 1_000_000 + 10 * 60_000, 'http://a.test/q')).toMatchObject({ accepted: true });
    expect(ai.calls).toHaveLength(2);
  });

  it('when another selection stored a verdict first, that verdict decides the count', async () => {
    const area = memoryArea({ aiConfig: cfg });
    let release!: () => void;
    const ai = fakeAi(() => new Promise((r) => { release = () => r({ ok: true, isPhrase: true, confidence: 0.95 }); }));
    const store = createStore(area, undefined, ai.port);
    const pending = capture(store, 'give up');
    await new Promise((r) => setTimeout(r, 0));
    area.data.phraseChecks = { 'give up': { isPhrase: false, confidence: 0.1, checkedAt: '2026-01-01T00:00:00.000Z' } };
    release();
    expect(await pending).toMatchObject({ accepted: false });
    expect(area.data.words).toBeUndefined();
  });

  it('without a saved model nothing is judged or counted', async () => {
    const ai = fakeAi();
    const store = createStore(memoryArea(), undefined, ai.port);
    expect(await capture(store, 'give up')).toMatchObject({ accepted: false });
    expect(ai.calls).toEqual([]);
  });

  it('a selection outside 2 to 6 words is not judged', async () => {
    const ai = fakeAi();
    const store = createStore(memoryArea({ aiConfig: cfg }), undefined, ai.port);
    expect(await capture(store, 'a b c d e f g')).toMatchObject({ accepted: false });
    expect(ai.calls).toEqual([]);
  });

  it('a repeat of the same phrase on the same page within 5 minutes is not counted again', async () => {
    const area = memoryArea({ aiConfig: cfg });
    const store = createStore(area, undefined, fakeAi().port);
    await capture(store, 'give up', 1_000_000);
    const dup = await capture(store, 'give up', 1_100_000);
    expect(dup).toMatchObject({ accepted: false });
    expect((area.data.words as Words)['give up'].count).toBe(1);
  });
});
