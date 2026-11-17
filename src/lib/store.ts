import type { AiConfig, AiLookupResult, AiTestResult, CaptureResult, LookupReply, Msg, RecentMap, Settings, WordEntry, Words } from './types';
import { acceptSelection, applySelection, mergeWords, normalizeWords, savedCount } from './words';
import { lookupWord, testConnection } from './ai';

/** The AI gateway seam. Production uses the AI SDK; tests pass a fake. */
export interface AiPort {
  test(config: AiConfig): Promise<AiTestResult>;
  lookup(config: AiConfig, word: string): Promise<AiLookupResult>;
}
export const liveAiPort: AiPort = {
  test: (config) => testConnection(config),
  lookup: (config, word) => lookupWord(config, word),
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
    const d = await area.get(['words', 'recent', 'aiConfig']);
    return {
      words: normalizeWords((d.words as Record<string, unknown>) ?? {}),
      recent: (d.recent as RecentMap) ?? {},
      aiConfig: d.aiConfig as AiConfig | undefined,
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

  return {
    handle(msg: Msg): Promise<CaptureResult | { ok: true } | AiTestResult | LookupReply> {
      if (msg.type === 'testAi') return ai.test(msg.config);
      if (msg.type === 'lookup') return lookup(msg.word);
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
