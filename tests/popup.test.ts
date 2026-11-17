import { searchEntries } from '../src/lib/words';
import type { WordEntry } from '../src/lib/types';

const entry = (word: string, kind: WordEntry['kind'] = 'word'): WordEntry => ({
  word, kind, count: 1, firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z',
  contexts: [], status: 'saved',
});

describe('searchEntries (popup search box)', () => {
  const list = [entry('serendipity'), entry('give up', 'phrase'), entry('look forward to', 'phrase')];

  it('matches single words by substring, ignoring case and spaces around the query', () => {
    expect(searchEntries(list, '  SERENDIP ').map((e) => e.word)).toEqual(['serendipity']);
  });

  it('matches phrases, and a word inside a phrase finds it', () => {
    expect(searchEntries(list, 'give up').map((e) => e.word)).toEqual(['give up']);
    expect(searchEntries(list, 'forward').map((e) => e.word)).toEqual(['look forward to']);
  });

  it('an empty query returns every entry', () => {
    expect(searchEntries(list, '')).toHaveLength(3);
  });
});
