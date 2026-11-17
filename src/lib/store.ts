import type { AiConfig, AiTestResult, CaptureResult, Msg, RecentMap, Settings, Words } from './types';
import { applySelection, mergeWords, savedCount } from './words';
import { testConnection } from './ai';

/** The AI gateway seam. Production uses the AI SDK; tests pass a fake. */
export interface AiPort {
  test(config: AiConfig): Promise<AiTestResult>;
}
export const liveAiPort: AiPort = { test: (config) => testConnection(config) };

/** Minimal storage interface so tests can mock chrome.storage.local. */
export interface Area {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export const DEFAULT_SETTINGS: Settings = { toast: true };

/** Serializes all read-modify-write operations through one promise chain. */
export function createStore(area: Area, onSaved?: (n: number) => void, ai: AiPort = liveAiPort) {
  let chain: Promise<unknown> = Promise.resolve();
  const run = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => undefined);
    return p;
  };
  const load = async () => {
    const d = await area.get(['words', 'recent']);
    return { words: (d.words as Words) ?? {}, recent: (d.recent as RecentMap) ?? {} };
  };
  const saveWords = async (words: Words, extra: Record<string, unknown> = {}) => {
    await area.set({ words, ...extra });
    onSaved?.(savedCount(words));
  };

  return {
    handle(msg: Msg): Promise<CaptureResult | { ok: true } | AiTestResult> {
      if (msg.type === 'testAi') return ai.test(msg.config);
      return run(async () => {
        const { words, recent } = await load();
        switch (msg.type) {
          case 'capture': {
            const r = applySelection(words, recent, msg.payload);
            if (r.accepted) await saveWords(r.words, { recent: r.recent });
            return { accepted: r.accepted, becameSaved: r.becameSaved, entry: r.entry };
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
