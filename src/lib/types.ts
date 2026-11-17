export type Status = 'seen' | 'saved' | 'mastered';
export type EntryKind = 'word' | 'phrase';
export interface Context { sentence: string; url: string; date: string }
export interface Example { en: string; translation: string }
/** AI lookup result for a word, cached on its entry until regenerated. */
export interface Lookup {
  definitions: string[]; collocations: string[]; phrases: string[]; examples: Example[]; generatedAt: string;
}
export interface WordEntry {
  word: string; kind: EntryKind; count: number; firstSeen: string; lastSeen: string;
  contexts: Context[]; status: Status; lookup?: Lookup;
  /** Meaning of the word in a sentence, keyed by the sentence text. Only sentences in `contexts` are kept. */
  meanings?: Record<string, string>;
}
export type Words = Record<string, WordEntry>;
export interface Settings { toast: boolean }
/** Last capture per word, for the anti-misclick window: key `${word}|${url}` -> epoch ms */
export type RecentMap = Record<string, number>;
export interface SelectionEvent { word: string; sentence: string; url: string; time: number; kind?: EntryKind }
/** Model judgement on whether a 2 to 6 word selection is a fixed phrase. Cached per phrase, negatives included. */
export interface PhraseCheck { isPhrase: boolean; confidence: number; checkedAt: string }
export type AiPhraseResult = { ok: true; isPhrase: boolean; confidence: number } | { ok: false; reason: AiFailure; message: string };

/** AI gateway settings. Stored under its own key, never in the exported word data. */
export interface AiConfig { baseUrl: string; apiKey: string; model: string; language: string; timeoutSeconds: number }
export type AiFailure = 'address' | 'key' | 'model' | 'timeout' | 'unknown';
export type AiTestResult = { ok: true } | { ok: false; reason: AiFailure; message: string };
export type AiLookupResult = { ok: true; lookup: Lookup; meaning?: string } | { ok: false; reason: AiFailure; message: string };
export type AiMeaningResult = { ok: true; meaning: string } | { ok: false; reason: AiFailure; message: string };
/** What the page card receives. `unconfigured` means no AI config is saved yet. */
export type LookupReply =
  | { ok: true; lookup: Lookup; meaning?: string; count?: number }
  | { ok: false; reason: AiFailure | 'unconfigured'; message: string };

export type Msg =
  | { type: 'capture'; payload: SelectionEvent }
  | { type: 'setStatus'; word: string; status: Status }
  | { type: 'delete'; word: string }
  | { type: 'import'; words: Words }
  | { type: 'clear' }
  | { type: 'testAi'; config: AiConfig }
  | { type: 'lookup'; word: string; sentence?: string; regenerate?: boolean }
  | { type: 'capturePhrase'; payload: SelectionEvent };
/**
 * `aiConfigured` tells the content script whether to show the lookup icon.
 * `isPhrase` is set on a phrase capture whose judgement passed, counted or not, so the icon shows for it.
 */
export interface CaptureResult { accepted: boolean; becameSaved: boolean; entry?: WordEntry; aiConfigured: boolean; isPhrase?: boolean }
