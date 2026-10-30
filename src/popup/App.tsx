import { useEffect, useMemo, useRef, useState } from 'react';
import type { Msg, Settings, Status, WordEntry, Words } from '../lib/types';
import { toMarkdown } from '../lib/words';

const send = (m: Msg) => chrome.runtime.sendMessage(m);
const TABS: { key: Status; label: string }[] = [
  { key: 'saved', label: '生词本' }, { key: 'seen', label: '只划过一次' }, { key: 'mastered', label: '已掌握' },
];
const d = (iso: string) => iso.slice(0, 10);

function download(name: string, text: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function App() {
  const [words, setWords] = useState<Words>({});
  const [settings, setSettings] = useState<Settings>({ toast: true });
  const [tab, setTab] = useState<Status>('saved');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const load = () => chrome.storage.local.get(['words', 'settings']).then((r) => {
      setWords((r.words as Words) ?? {});
      setSettings({ toast: true, ...(r.settings as Settings | undefined) });
    });
    void load();
    chrome.storage.onChanged.addListener(load);
    return () => chrome.storage.onChanged.removeListener(load);
  }, []);

  const all = Object.values(words);
  const stats = { saved: 0, seen: 0, mastered: 0 } as Record<Status, number>;
  all.forEach((w) => stats[w.status]++);
  const list = useMemo(() => Object.values(words)
    .filter((w) => w.status === tab && w.word.includes(q.trim().toLowerCase()))
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)), [words, tab, q]);

  const today = new Date().toISOString().slice(0, 10);
  const onImport = async (f: File | undefined) => {
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const w = (data.words ?? data) as Words;
      if (typeof w !== 'object' || Array.isArray(w)) throw new Error('格式不对');
      await send({ type: 'import', words: w });
      alert('导入完成');
    } catch (e) { alert('导入失败: ' + String(e)); }
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div className="app">
      <header>
        <h1>Word Catcher</h1>
        <span className="stats">共 {all.length} 词 · 生词 {stats.saved} · 一次 {stats.seen} · 掌握 {stats.mastered}</span>
      </header>
      <nav>{TABS.map((t) => (
        <button key={t.key} className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>{t.label} ({stats[t.key]})</button>
      ))}</nav>
      <input className="search" placeholder="搜索单词…" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className="list">
        {list.length === 0 && <li className="empty">暂无单词。在网页上划选英文单词试试，第二次划到会自动进入生词本。</li>}
        {list.map((w: WordEntry) => (
          <li key={w.word}>
            <div className="row" onClick={() => setOpen(open === w.word ? null : w.word)}>
              <b>{w.word}</b><span className="cnt">×{w.count}</span>
              <span className="dates">{d(w.firstSeen)} → {d(w.lastSeen)}</span>
            </div>
            <div className="acts">
              {w.status !== 'mastered'
                ? <button onClick={() => send({ type: 'setStatus', word: w.word, status: 'mastered' })}>标记已掌握</button>
                : <button onClick={() => send({ type: 'setStatus', word: w.word, status: 'saved' })}>移回生词本</button>}
              {w.status === 'seen' && <button onClick={() => send({ type: 'setStatus', word: w.word, status: 'saved' })}>加入生词本</button>}
              <button className="danger" onClick={() => send({ type: 'delete', word: w.word })}>删除</button>
            </div>
            {open === w.word && <ol className="ctx">{[...w.contexts].reverse().map((c) => (
              <li key={c.url + c.date}>{c.sentence} <a href={c.url} target="_blank" rel="noreferrer">{d(c.date)} ↗</a></li>
            ))}</ol>}
          </li>
        ))}
      </ul>
      <footer>
        <button onClick={() => download(`word-catcher-${today}.md`, toMarkdown(words), 'text/markdown')}>导出 Markdown</button>
        <button onClick={() => download(`word-catcher-${today}.json`, JSON.stringify({ version: 1, words }, null, 2), 'application/json')}>导出 JSON</button>
        <button onClick={() => fileRef.current?.click()}>导入 JSON</button>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => void onImport(e.target.files?.[0])} />
        <button className="danger" onClick={() => { if (confirm('确定清空所有单词？此操作不可撤销（建议先导出 JSON 备份）。')) void send({ type: 'clear' }); }}>清空</button>
        <label className="toggle"><input type="checkbox" checked={settings.toast}
          onChange={(e) => void chrome.storage.local.set({ settings: { ...settings, toast: e.target.checked } })} /> 页面提示</label>
      </footer>
    </div>
  );
}
