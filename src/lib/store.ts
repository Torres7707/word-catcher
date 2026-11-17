import type { AiConfig, AiLookupResult, AiPhraseResult, AiTestResult, CaptureResult, LookupReply, Msg, PhraseCheck, RecentMap, SelectionEvent, Settings, WordEntry, Words } from './types';
import { acceptSelection, addPhraseCheck, applySelection, mergeWords, normalizeWords, PHRASE_THRESHOLD, phraseCandidate, savedCount } from './words';
import { judgePhrase, lookupWord, testConnection } from './ai';

/** The AI gateway seam. Production uses the AI SDK; tests pass a fake. */
export interface AiPort {
  test(config: AiConfig): Promise<AiTestResult>;
  lookup(config: AiConfig, word: string): Promise<AiLookupResult>;
  judgePhrase(config: AiConfig, text: string): Promise<AiPhraseResult>;
}
export const liveAiPort: AiPort = {
  test: (config) => testConnection(config),
  lookup: (config, word) => lookupWord(config, word),
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

  /** One AI request per word and config at a time, so repeated taps share a single call. */
  const inflight = new Map<string, Promise<AiLookupResult>>();

  /**
   * Returns the cached lookup, or asks AI and caches the answer on the entry.
   * The AI call runs outside the storage chain so a slow request does not block selections.
   */
  async function lookup(raw: string): Promise<LookupReply> {
    const word = acceptSelection(raw);
    if (!word) return { ok: false, reason: 'unknown', message: '只能查单个英文单词' };

    const snap = await run(async () => {
      const { words, aiConfig } = await load();
      return { entry: words[word] as WordEntry | undefined, aiConfig };
    });
    if (snap.entry?.lookup) return { ok: true, lookup: snap.entry.lookup, count: snap.entry.count };
    if (!snap.aiConfig || !isConfigured(snap.aiConfig)) return { ok: false, reason: 'unconfigured', message: 'AI 未配置' };

    const key = JSON.stringify([snap.aiConfig.baseUrl, snap.aiConfig.model, snap.aiConfig.language, word]);
    let pending = inflight.get(key);
    if (!pending) {
      pending = ai.lookup(snap.aiConfig, word).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    const r = await pending;
    if (!r.ok) return r;

    return run(async (): Promise<LookupReply> => {
      const { words } = await load();
      const e = words[word];
      if (!e) return { ok: true, lookup: r.lookup };
      const next: WordEntry = { ...e, lookup: r.lookup };
      await saveWords({ ...words, [word]: next });
      return { ok: true, lookup: r.lookup, count: next.count };
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
      if (!r.ok) return { accepted: false, becameSaved: false, aiConfigured: true };
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
        return { accepted: false, becameSaved: false, aiConfigured: true };
      }
      const r = applySelection(words, recent, { ...ev, word: key, kind: 'phrase' });
      if (r.accepted) await saveWords(r.words, { recent: r.recent, phraseChecks: checks });
      else if (checks !== phraseChecks) await area.set({ phraseChecks: checks });
      return { accepted: r.accepted, becameSaved: r.becameSaved, entry: r.entry, aiConfigured: true };
    });
  }

  return {
    handle(msg: Msg): Promise<CaptureResult | { ok: true } | AiTestResult | LookupReply> {
      if (msg.type === 'testAi') return ai.test(msg.config);
      if (msg.type === 'lookup') return lookup(msg.word);
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
