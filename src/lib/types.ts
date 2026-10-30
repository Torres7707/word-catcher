export type Status = 'seen' | 'saved' | 'mastered';
export interface Context { sentence: string; url: string; date: string }
export interface WordEntry {
  word: string; count: number; firstSeen: string; lastSeen: string;
  contexts: Context[]; status: Status;
}
export type Words = Record<string, WordEntry>;
export interface Settings { toast: boolean }
/** Last capture per word, for the anti-misclick window: key `${word}|${url}` -> epoch ms */
export type RecentMap = Record<string, number>;
export interface SelectionEvent { word: string; sentence: string; url: string; time: number }

export type Msg =
  | { type: 'capture'; payload: SelectionEvent }
  | { type: 'setStatus'; word: string; status: Status }
  | { type: 'delete'; word: string }
  | { type: 'import'; words: Words }
  | { type: 'clear' };
export interface CaptureResult { accepted: boolean; becameSaved: boolean; entry?: WordEntry }
