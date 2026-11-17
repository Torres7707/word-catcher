export type Status = 'seen' | 'saved' | 'mastered';
export type EntryKind = 'word' | 'phrase';
export interface Context { sentence: string; url: string; date: string }
export interface WordEntry {
  word: string; kind: EntryKind; count: number; firstSeen: string; lastSeen: string;
  contexts: Context[]; status: Status;
}
export type Words = Record<string, WordEntry>;
export interface Settings { toast: boolean }
/** Last capture per word, for the anti-misclick window: key `${word}|${url}` -> epoch ms */
export type RecentMap = Record<string, number>;
export interface SelectionEvent { word: string; sentence: string; url: string; time: number }

/** AI gateway settings. Stored under its own key, never in the exported word data. */
export interface AiConfig { baseUrl: string; apiKey: string; model: string; language: string }
export type AiFailure = 'address' | 'key' | 'model' | 'timeout' | 'unknown';
export type AiTestResult = { ok: true } | { ok: false; reason: AiFailure; message: string };

export type Msg =
  | { type: 'capture'; payload: SelectionEvent }
  | { type: 'setStatus'; word: string; status: Status }
  | { type: 'delete'; word: string }
  | { type: 'import'; words: Words }
  | { type: 'clear' }
  | { type: 'testAi'; config: AiConfig };
export interface CaptureResult { accepted: boolean; becameSaved: boolean; entry?: WordEntry }
