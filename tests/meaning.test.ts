import { MockLanguageModelV3 } from 'ai/test';
import { DEFAULT_AI_CONFIG, judgePhrase, lookupWord, meaningInSentence } from '../src/lib/ai';
import { createStore, type Area, type AiPort } from '../src/lib/store';
import type { AiConfig, AiFailure, AiLookupResult, AiMeaningResult, Lookup, SelectionEvent, Words } from '../src/lib/types';

const cfg: AiConfig = { ...DEFAULT_AI_CONFIG, model: 'gpt-test', language: 'zh-CN' };
const general = { definitions: ['n. 意外发现珍奇事物的运气'], collocations: [], phrases: [], examples: [] };

type Call = { kind: 'lookup' | 'meaning'; word: string; sentence?: string };

function memoryArea(init: Record<string, unknown> = {}): Area & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = { ...init };
  return {
    data,
    get: async (keys) => Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]])),
    set: async (items) => { Object.assign(data, items); },
  };
}

/** A fake gateway. `state.fail` makes every call fail with that reason until it is cleared. */
function fakeAi() {
  const calls: Call[] = [];
  const state: { fail?: AiFailure; n: number } = { n: 0 };
  const fail = (): { ok: false; reason: AiFailure; message: string } | undefined =>
    state.fail ? { ok: false, reason: state.fail, message: `失败：${state.fail}` } : undefined;
  const port: AiPort = {
    test: async () => ({ ok: true }),
    lookup: async (_c, word, sentence): Promise<AiLookupResult> => {
      calls.push({ kind: 'lookup', word, sentence });
      const f = fail(); if (f) return f;
      state.n++;
      const lookup: Lookup = { ...general, generatedAt: `gen-${state.n}` };
      return { ok: true, lookup, ...(sentence ? { meaning: `意思#${state.n}：${sentence}` } : {}) };
    },
    meaning: async (_c, word, sentence): Promise<AiMeaningResult> => {
      calls.push({ kind: 'meaning', word, sentence });
      const f = fail(); if (f) return f;
      state.n++;
      return { ok: true, meaning: `意思#${state.n}：${sentence}` };
    },
    judgePhrase: async () => ({ ok: false, reason: 'unknown', message: 'unused' }),
  };
  return { port, calls, state };
}

const captureEv = (sentence: string, i: number): SelectionEvent => ({
  word: 'serendipity', sentence, url: `http://a.test/${i}`, time: 1_000_000 + i * 10 * 60_000,
});

describe('lookup in a sentence', () => {
  it('the first open in a sentence asks once, for the word and its meaning together', async () => {
    const ai = fakeAi();
    const store = createStore(memoryArea({ aiConfig: cfg }), undefined, ai.port);
    await store.handle({ type: 'capture', payload: captureEv('The serendipity here.', 0) });
    const r = await store.handle({ type: 'lookup', word: 'serendipity', sentence: 'The serendipity here.' });
    expect(r).toMatchObject({ ok: true, meaning: expect.stringContaining('The serendipity here.') });
    expect(ai.calls).toEqual([{ kind: 'lookup', word: 'serendipity', sentence: 'The serendipity here.' }]);
  });

  it('reopening the same sentence sends no request', async () => {
    const ai = fakeAi();
    const store = createStore(memoryArea({ aiConfig: cfg }), undefined, ai.port);
    await store.handle({ type: 'capture', payload: captureEv('The serendipity here.', 0) });
    await store.handle({ type: 'lookup', word: 'serendipity', sentence: 'The serendipity here.' });
    const again = await store.handle({ type: 'lookup', word: 'serendipity', sentence: 'The serendipity here.' });
    expect(again).toMatchObject({ ok: true });
    expect(ai.calls).toHaveLength(1);
  });

  it('a new sentence asks only for its meaning when the word is already cached', async () => {
    const area = memoryArea({ aiConfig: cfg });
    const ai = fakeAi();
    const store = createStore(area, undefined, ai.port);
    await store.handle({ type: 'capture', payload: captureEv('First sentence.', 0) });
    await store.handle({ type: 'lookup', word: 'serendipity', sentence: 'First sentence.' });
    await store.handle({ type: 'capture', payload: captureEv('Second sentence.', 1) });
    const r = await store.handle({ type: 'lookup', word: 'serendipity', sentence: 'Second sentence.' });
    expect(r).toMatchObject({ ok: true, meaning: expect.stringContaining('Second sentence.') });
    expect(ai.calls.map((c) => c.kind)).toEqual(['lookup', 'meaning']);
    const meanings = (area.data.words as Words).serendipity.meanings ?? {};
    expect(Object.keys(meanings).sort()).toEqual(['First sentence.', 'Second sentence.']);
  });

  it('regenerate replaces the cached lookup and this sentence\'s meaning', async () => {
    const area = memoryArea({ aiConfig: cfg });
    const ai = fakeAi();
    const store = createStore(area, undefined, ai.port);
    await store.handle({ type: 'capture', payload: captureEv('The serendipity here.', 0) });
    await store.handle({ type: 'lookup', word: 'serendipity', sentence: 'The serendipity here.' });
    const before = (area.data.words as Words).serendipity.lookup!.generatedAt;
    const r = await store.handle({ type: 'lookup', word: 'serendipity', sentence: 'The serendipity here.', regenerate: true });
    expect(r).toMatchObject({ ok: true });
    expect(ai.calls).toHaveLength(2);
    const after = area.data.words as Words;
    expect(after.serendipity.lookup!.generatedAt).not.toBe(before);
    expect(after.serendipity.meanings!['The serendipity here.']).toContain('意思#');
  });

  it('a timeout is reported, nothing is cached, and nothing is retried automatically', async () => {
    const area = memoryArea({ aiConfig: cfg });
    const ai = fakeAi();
    const store = createStore(area, undefined, ai.port);
    await store.handle({ type: 'capture', payload: captureEv('The serendipity here.', 0) });
    ai.state.fail = 'timeout';
    const r = await store.handle({ type: 'lookup', word: 'serendipity', sentence: 'The serendipity here.' });
    expect(r).toMatchObject({ ok: false, reason: 'timeout' });
    expect((area.data.words as Words).serendipity.lookup).toBeUndefined();
    expect(ai.calls).toHaveLength(1);
    ai.state.fail = undefined;
    expect(await store.handle({ type: 'lookup', word: 'serendipity', sentence: 'The serendipity here.' })).toMatchObject({ ok: true });
    expect(ai.calls).toHaveLength(2);
  });

  it('meanings are kept only for sentences that are still among the word\'s contexts', async () => {
    const area = memoryArea({ aiConfig: cfg });
    const store = createStore(area, undefined, fakeAi().port);
    for (let i = 0; i < 21; i++) {
      const s = `Sentence number ${i}.`;
      await store.handle({ type: 'capture', payload: captureEv(s, i) });
      await store.handle({ type: 'lookup', word: 'serendipity', sentence: s });
    }
    const entry = (area.data.words as Words).serendipity;
    expect(entry.contexts).toHaveLength(20);
    const keys = Object.keys(entry.meanings ?? {});
    expect(keys.length).toBeLessThanOrEqual(20);
    expect(keys).not.toContain('Sentence number 0.');
    expect(keys).toContain('Sentence number 20.');
  });

  it('a later capture and an import keep the cached meanings', async () => {
    const area = memoryArea({ aiConfig: cfg });
    const store = createStore(area, undefined, fakeAi().port);
    await store.handle({ type: 'capture', payload: captureEv('The serendipity here.', 0) });
    await store.handle({ type: 'lookup', word: 'serendipity', sentence: 'The serendipity here.' });
    await store.handle({ type: 'capture', payload: captureEv('Another one.', 1) });
    const words = area.data.words as Words;
    expect(words.serendipity.meanings).toHaveProperty(['The serendipity here.']);
    await store.handle({ type: 'import', words: { serendipity: { ...words.serendipity, meanings: undefined } } });
    expect((area.data.words as Words).serendipity.meanings).toHaveProperty(['The serendipity here.']);
  });

  it('a saved lookup still shows when the model has been cleared', async () => {
    const area = memoryArea({ aiConfig: cfg });
    const ai = fakeAi();
    const store = createStore(area, undefined, ai.port);
    await store.handle({ type: 'capture', payload: captureEv('First.', 0) });
    await store.handle({ type: 'lookup', word: 'serendipity', sentence: 'First.' });
    area.data.aiConfig = { ...cfg, model: '' };
    const r = await store.handle({ type: 'lookup', word: 'serendipity', sentence: 'Second.' });
    expect(r).toMatchObject({ ok: true, count: 1 });
    expect(ai.calls).toHaveLength(1);
  });

  it('an import keeps meanings for the sentences the word still has', async () => {
    const area = memoryArea({ aiConfig: cfg });
    const store = createStore(area, undefined, fakeAi().port);
    await store.handle({ type: 'capture', payload: captureEv('Mine.', 0) });
    await store.handle({ type: 'lookup', word: 'serendipity', sentence: 'Mine.' });
    const mine = (area.data.words as Words).serendipity;
    const theirs = { sentence: 'Theirs.', url: 'http://b.test/1', date: mine.lastSeen };
    const incoming = { serendipity: { ...mine, contexts: [...mine.contexts, theirs], meanings: { 'Theirs.': '他们的意思', 'Mine.': '旧' } } };
    await store.handle({ type: 'import', words: incoming as Words });
    const m = (area.data.words as Words).serendipity.meanings!;
    expect(m).toHaveProperty(['Theirs.']);
    expect(m['Mine.']).toContain('意思#');
  });

  it('without a saved model a sentence lookup is refused', async () => {
    const ai = fakeAi();
    const store = createStore(memoryArea(), undefined, ai.port);
    await store.handle({ type: 'capture', payload: captureEv('The serendipity here.', 0) });
    expect(await store.handle({ type: 'lookup', word: 'serendipity', sentence: 'The serendipity here.' })).toMatchObject({ ok: false, reason: 'unconfigured' });
    expect(ai.calls).toEqual([]);
  });
});

describe('sentence meaning AI adapter', () => {
  const model = (text: string) => new MockLanguageModelV3({
    doGenerate: {
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
      warnings: [],
    },
  });

  it('lookupWord with a sentence returns the meaning in that sentence', async () => {
    const r = await lookupWord(cfg, 'serendipity', { sentence: 'A lucky find.', model: model(JSON.stringify({ ...general, meaning: '意外的发现' })) });
    expect(r).toMatchObject({ ok: true, meaning: '意外的发现' });
  });
  it('meaningInSentence returns the meaning', async () => {
    expect(await meaningInSentence(cfg, 'serendipity', 'A lucky find.', model('{"meaning":"意外的发现"}'))).toEqual({ ok: true, meaning: '意外的发现' });
  });
  it('an answer in the wrong shape gives a readable reason', async () => {
    const r = await meaningInSentence(cfg, 'serendipity', 'A lucky find.', model('{"meaning":42}'));
    expect(r).toMatchObject({ ok: false, reason: 'unknown', message: '返回的数据格式不符合要求' });
  });
});

describe('prompts name the JSON keys the schema needs', () => {
  /** A model that records the system prompt it was sent. */
  function spy(text: string) {
    const seen: string[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (opts) => {
        seen.push(opts.prompt.filter((m) => m.role === 'system').map((m) => m.content).join('\n'));
        return {
          content: [{ type: 'text', text }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
          warnings: [],
        };
      },
    });
    return { model, seen };
  }

  it('a word lookup lists definitions, collocations, phrases and examples', async () => {
    const { model, seen } = spy(JSON.stringify(general));
    await lookupWord(cfg, 'serendipity', { model });
    for (const key of ['definitions', 'collocations', 'phrases', 'examples', '"en"', '"translation"']) expect(seen[0]).toContain(key);
    expect(seen[0]).not.toContain('"meaning"');
  });
  it('a lookup in a sentence also names the meaning key', async () => {
    const { model, seen } = spy(JSON.stringify({ ...general, meaning: '意思' }));
    await lookupWord(cfg, 'serendipity', { sentence: 'A lucky find.', model });
    expect(seen[0]).toContain('definitions');
    expect(seen[0]).toContain('"meaning"');
  });
  it('the meaning and phrase requests name their keys', async () => {
    const m = spy('{"meaning":"意思"}');
    await meaningInSentence(cfg, 'bank', 'The river bank.', m.model);
    expect(m.seen[0]).toContain('"meaning"');
    const p = spy('{"isPhrase":true,"confidence":0.9}');
    await judgePhrase(cfg, 'give up', p.model);
    expect(p.seen[0]).toContain('isPhrase');
    expect(p.seen[0]).toContain('confidence');
  });
});

describe('AI calls ask for low reasoning effort (latency)', () => {
  function recorder(text: string) {
    const seen: unknown[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (opts) => {
        seen.push(opts.providerOptions);
        return {
          content: [{ type: 'text', text }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
          warnings: [],
        };
      },
    });
    return { model, seen };
  }
  const low = { 'word-catcher': { reasoningEffort: 'low' } };

  it('lookup, meaning and phrase judgement all send reasoningEffort low', async () => {
    const a = recorder(JSON.stringify(general));
    await lookupWord(cfg, 'serendipity', { model: a.model });
    const b = recorder('{"meaning":"意思"}');
    await meaningInSentence(cfg, 'bank', 'The river bank.', b.model);
    const c = recorder('{"isPhrase":true,"confidence":0.9}');
    await judgePhrase(cfg, 'give up', c.model);
    expect(a.seen[0]).toEqual(low);
    expect(b.seen[0]).toEqual(low);
    expect(c.seen[0]).toEqual(low);
  });
});
