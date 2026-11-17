import type { AiConfig, AiLookupResult, AiMeaningResult, AiPhraseResult, AiTestResult, CaptureResult, Lookup, LookupReply, Msg, PhraseCheck, RecentMap, SelectionEvent, Settings, WordEntry, Words } from './types';
import { acceptSelection, addPhraseCheck, applySelection, clipSentence, mergeWords, newerLookup, normalizeWords, PHRASE_THRESHOLD, phraseCandidate, pruneMeanings, savedCount } from './words';
import { judgePhrase, lookupWord, meaningInSentence, testConnection } from './ai';

/** The AI gateway seam. Production uses the AI SDK; tests pass a fake. */
export interface AiPort {
  test(config: AiConfig): Promise<AiTestResult>;
  lookup(config: AiConfig, word: string, sentence?: string): Promise<AiLookupResult>;
  meaning(config: AiConfig, word: string, sentence: string): Promise<AiMeaningResult>;
  judgePhrase(config: AiConfig, text: string): Promise<AiPhraseResult>;
}
export const liveAiPort: AiPort = {
  test: (config) => testConnection(config),
  lookup: (config, word, sentence) => lookupWord(config, word, { sentence }),
  meaning: (config, word, sentence) => meaningInSentence(config, word, sentence),
  judgePhrase: (config, text) => judgePhrase(config, text),
};

/** Minimal storage interface so tests can mock chrome.storage.local. */
export interface Area {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export const DEFAULT_SETTINGS: Settings = { toast: true };

/** AI counts as configured once a model name is saved. Other fields have defaults. */
const isConfigured = (c?: AiConfig) => !!c?.model;


/** Serializes all read-modify-write operations through one promise chain. */
export function createStore(area: Area, onSaved?: (n: number) => void, ai: AiPort = liveAiPort) {
  let chain: Promise<unknown> = Promise.resolve();
  const run = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => undefined);
    return p;
  };
  const load = async () => {
    const d = await area.get(['words', 'recent', 'aiConfig', 'phraseChecks']);
    return {
      words: normalizeWords((d.words as Record<string, unknown>) ?? {}),
      recent: (d.recent as RecentMap) ?? {},
      aiConfig: d.aiConfig as AiConfig | undefined,
      phraseChecks: (d.phraseChecks as Record<string, PhraseCheck>) ?? {},
    };
  };
  const saveWords = async (words: Words, extra: Record<string, unknown> = {}) => {
    await area.set({ words, ...extra });
    onSaved?.(savedCount(words));
  };

  /** Shares one in-flight AI request per key, so repeated taps send one call. */
  const inflight = new Map<string, Promise<AiLookupResult>>();
  const meaningInflight = new Map<string, Promise<AiMeaningResult>>();
  const shared = <T>(map: Map<string, Promise<T>>, key: string, start: () => Promise<T>): Promise<T> => {
    let p = map.get(key);
    if (!p) { p = start().finally(() => map.delete(key)); map.set(key, p); }
    return p;
  };

  /**
   * Returns the cached lookup and the sentence meaning, asking AI only for what is missing.
   * A new sentence costs one request, shared with the word lookup when both are missing.
   * `regenerate` replaces both. The AI calls run outside the storage chain.
   */
  async function lookup(raw: string, sentence?: string, regenerate = false): Promise<LookupReply> {
    // Single words and 2 to 6 word phrases both have a lookup. The popup opens phrases too.
    const word = acceptSelection(raw) ?? phraseCandidate(raw);
    if (!word) return { ok: false, reason: 'unknown', message: '只能查单词或 2 到 6 个词的短语' };
    const context = sentence ? clipSentence(sentence) : undefined;

    const snap = await run(async () => {
      const { words, aiConfig } = await load();
      return { entry: words[word] as WordEntry | undefined, aiConfig };
    });
    const entry = snap.entry;
    const needGeneral = regenerate || !entry?.lookup;
    const needMeaning = !!context && (regenerate || entry?.meanings?.[context] === undefined);
    if (!needGeneral && !needMeaning) {
      return { ok: true, lookup: entry!.lookup!, meaning: context ? entry!.meanings![context] : undefined, count: entry!.count };
    }
    if (!isConfigured(snap.aiConfig)) {
      // A saved lookup still shows without AI. Only a request needs the model.
      if (!regenerate && entry?.lookup) return { ok: true, lookup: entry.lookup, count: entry.count };
      return { ok: false, reason: 'unconfigured', message: 'AI 未配置' };
    }
    const cfg = snap.aiConfig!;
    const base = JSON.stringify([cfg.baseUrl, cfg.model, cfg.language, word, regenerate]);

    let got: { lookup?: Lookup; meaning?: string };
    if (needGeneral && needMeaning) {
      const r = await shared(inflight, JSON.stringify([base, context]), () => ai.lookup(cfg, word, context));
      if (!r.ok) return r;
      got = { lookup: r.lookup, meaning: r.meaning };
    } else if (needGeneral) {
      const r = await shared(inflight, JSON.stringify([base]), () => ai.lookup(cfg, word));
      if (!r.ok) return r;
      got = { lookup: r.lookup };
    } else {
      const r = await shared(meaningInflight, JSON.stringify([base, context]), () => ai.meaning(cfg, word, context!));
      if (!r.ok) return r;
      got = { meaning: r.meaning };
    }

    return run(async (): Promise<LookupReply> => {
      const { words } = await load();
      const e = words[word];
      // Re-read inside the chain: a newer lookup saved meanwhile wins over the snapshot taken before AI ran.
      const general = (got.lookup ? newerLookup(e?.lookup, got.lookup) : e?.lookup ?? entry?.lookup) as Lookup;
      const meaning = context ? got.meaning ?? entry?.meanings?.[context] : undefined;
      if (!e) return { ok: true, lookup: general, meaning };
      const next: WordEntry = { ...e, lookup: general };
      if (context && got.meaning !== undefined) {
        next.meanings = pruneMeanings({ ...e.meanings, [context]: got.meaning }, e.contexts, context);
      }
      await saveWords({ ...words, [word]: next });
      return { ok: true, lookup: general, meaning, count: next.count };
    });
  }

  /** One judgement per phrase and config at a time, so repeated selections share one call. */
  const phraseInflight = new Map<string, Promise<AiPhraseResult>>();

  /**
   * Judges a 2 to 6 word selection, caches the judgement, and counts it when the model is at least
   * PHRASE_THRESHOLD sure it is a phrase. The AI call runs outside the storage chain.
   * Words inside the phrase are not counted.
   */
  async function capturePhrase(ev: SelectionEvent): Promise<CaptureResult> {
    const key = phraseCandidate(ev.word);
    if (!key) return { accepted: false, becameSaved: false, aiConfigured: false };

    const snap = await run(async () => {
      const { aiConfig, phraseChecks } = await load();
      return { aiConfig, cached: phraseChecks[key] as PhraseCheck | undefined };
    });
    if (!isConfigured(snap.aiConfig)) return { accepted: false, becameSaved: false, aiConfigured: false };
    const cfg = snap.aiConfig!;

    let check = snap.cached;
    if (!check) {
      const flightKey = JSON.stringify([cfg.baseUrl, cfg.model, cfg.language, key]);
      let pending = phraseInflight.get(flightKey);
      if (!pending) {
        pending = ai.judgePhrase(cfg, key).finally(() => phraseInflight.delete(flightKey));
        phraseInflight.set(flightKey, pending);
      }
      const r = await pending;
      if (!r.ok) return { accepted: false, becameSaved: false, aiConfigured: true, isPhrase: false };
      check = { isPhrase: r.isPhrase, confidence: r.confidence, checkedAt: new Date().toISOString() };
    }

    return run(async (): Promise<CaptureResult> => {
      const { words, recent, phraseChecks } = await load();
      // A verdict stored by another selection in the meantime wins, so the count and the cache agree.
      const known = phraseChecks[key];
      const verdict = known ?? check!;
      const checks = known ? phraseChecks : addPhraseCheck(phraseChecks, key, verdict);
      const isPhrase = verdict.isPhrase && verdict.confidence >= PHRASE_THRESHOLD;
      if (!isPhrase) {
        if (checks !== phraseChecks) await area.set({ phraseChecks: checks });
        return { accepted: false, becameSaved: false, aiConfigured: true, isPhrase: false };
      }
      const r = applySelection(words, recent, { ...ev, word: key, kind: 'phrase' });
      if (r.accepted) await saveWords(r.words, { recent: r.recent, phraseChecks: checks });
      else if (checks !== phraseChecks) await area.set({ phraseChecks: checks });
      return { accepted: r.accepted, becameSaved: r.becameSaved, entry: r.entry, aiConfigured: true, isPhrase: true };
    });
  }

  return {
    handle(msg: Msg): Promise<CaptureResult | { ok: true } | AiTestResult | LookupReply> {
      if (msg.type === 'testAi') return ai.test(msg.config);
      if (msg.type === 'lookup') return lookup(msg.word, msg.sentence, msg.regenerate);
      if (msg.type === 'capturePhrase') return capturePhrase(msg.payload);
      return run(async () => {
        const { words, recent, aiConfig } = await load();
        switch (msg.type) {
          case 'capture': {
            const r = applySelection(words, recent, msg.payload);
            if (r.accepted) await saveWords(r.words, { recent: r.recent });
            return { accepted: r.accepted, becameSaved: r.becameSaved, entry: r.entry, aiConfigured: isConfigured(aiConfig) };
          }
          case 'setStatus': {
            const e = words[msg.word];
            if (e) await saveWords({ ...words, [msg.word]: { ...e, status: msg.status } });
            return { ok: true };
          }
          case 'delete': {
            const rest = { ...words }; delete rest[msg.word];
            await saveWords(rest);
            return { ok: true };
          }
          case 'import':
            await saveWords(mergeWords(words, msg.words));
            return { ok: true };
          case 'clear':
            await saveWords({}, { recent: {} });
            return { ok: true };
        }
      });
    },
  };
}
