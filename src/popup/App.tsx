import { useEffect, useMemo, useRef, useState } from 'react';
import type { Lookup, LookupReply, Msg, Settings, Status, WordEntry, Words } from '../lib/types';
import { buildExport, newerLookup, normalizeWords, parseImport, searchEntries, toMarkdown } from '../lib/words';

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

/** Turns whatever the background sent back into a reply the panel can show. */
function toReply(r: LookupReply | { error: string } | undefined): LookupReply {
  if (r && 'ok' in r) return r;
  return { ok: false, reason: 'unknown', message: r && 'error' in r ? r.error : '后台没有返回结果' };
}

function LookupBody({ lookup }: { lookup: Lookup }) {
  const sections: [string, string[]][] = [['释义', lookup.definitions], ['搭配', lookup.collocations], ['短语', lookup.phrases]];
  return (
    <>
      {sections.filter(([, items]) => items.length > 0).map(([title, items]) => (
        <div key={title}><h4>{title}</h4><ul>{items.map((t, i) => <li key={i}>{t}</li>)}</ul></div>
      ))}
      {lookup.examples.length > 0 && (
        <div><h4>例句</h4><ol>{lookup.examples.map((ex, i) => (
          <li key={i}>{ex.en}<div className="ex-t">{ex.translation}</div></li>
        ))}</ol></div>
      )}
    </>
  );
}

/** What the popup knows about a lookup request for one word. */
interface LookupState { busy: boolean; regenerate: boolean; reply?: LookupReply }

/**
 * Lookup panel for one word. A saved lookup shows at once. Otherwise the first open asks AI.
 * Requests share the page card's cache through the background, so saved results are the same everywhere.
 */
function LookupPanel({ saved, state, onAsk }: { saved?: Lookup; state?: LookupState; onAsk: (regenerate: boolean) => void }) {
  const reply = state?.reply;
  const busy = !!state?.busy;
  // The newer of the saved lookup and a fresh reply, so a regenerate shows before storage reloads.
  const shown = newerLookup(saved, reply?.ok ? reply.lookup : undefined);
  const failed = reply && !reply.ok ? reply : null;
  return (
    <div className="lk">
      {busy && <div className="muted">{shown ? '重新生成中…' : '查词中…'}</div>}
      {failed?.reason === 'unconfigured' && <div className="msg">请先在设置中配置 AI</div>}
      {failed && failed.reason !== 'unconfigured' && <div className="msg">查词失败：{failed.message}</div>}
      {shown && <LookupBody lookup={shown} />}
      <div className="acts">
        {failed && failed.reason !== 'unconfigured' && <button disabled={busy} onClick={() => onAsk(!!state?.regenerate)}>重试</button>}
        {shown && <button disabled={busy} onClick={() => onAsk(true)}>重新生成</button>}
      </div>
    </div>
  );
}

export function App() {
  const [words, setWords] = useState<Words>({});
  const [settings, setSettings] = useState<Settings>({ toast: true });
  const [tab, setTab] = useState<Status>('saved');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [lookups, setLookups] = useState<Record<string, LookupState>>({});
  const fileRef = useRef<HTMLInputElement>(null);

  const ask = (word: string, regenerate: boolean) => {
    setLookups((prev) => ({ ...prev, [word]: { busy: true, regenerate } }));
    chrome.runtime.sendMessage({ type: 'lookup', word, regenerate } as Msg)
      .then((r: LookupReply | { error: string } | undefined) => setLookups((prev) => ({
        ...prev,
        [word]: { busy: false, regenerate, reply: toReply(r) },
      })))
      .catch(() => setLookups((prev) => ({
        ...prev,
        [word]: { busy: false, regenerate, reply: { ok: false, reason: 'unknown', message: '扩展已重新加载，请关闭后重新打开弹窗' } },
      })));
  };
  const toggle = (w: WordEntry) => {
    if (open === w.word) { setOpen(null); return; }
    setOpen(w.word);
    // Only the first open asks. After a failure the panel shows 重试 and nothing is sent on reopen.
    if (!w.lookup && !lookups[w.word]) ask(w.word, false);
  };

  useEffect(() => {
    const load = () => chrome.storage.local.get(['words', 'settings']).then((r) => {
      setWords(normalizeWords((r.words as Record<string, unknown>) ?? {}));
      setSettings({ toast: true, ...(r.settings as Settings | undefined) });
    });
    void load();
    chrome.storage.onChanged.addListener(load);
    return () => chrome.storage.onChanged.removeListener(load);
  }, []);

  const all = Object.values(words);
  const stats = { saved: 0, seen: 0, mastered: 0 } as Record<Status, number>;
  all.forEach((w) => stats[w.status]++);
  const list = useMemo(() => searchEntries(Object.values(words).filter((w) => w.status === tab), q)
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)), [words, tab, q]);

  const today = new Date().toISOString().slice(0, 10);
  const onImport = async (f: File | undefined) => {
    if (!f) return;
    try {
      const w = parseImport(await f.text());
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
            <div className="row" onClick={() => toggle(w)}>
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
            {open === w.word && <LookupPanel saved={w.lookup} state={lookups[w.word]} onAsk={(regen) => ask(w.word, regen)} />}
            {open === w.word && <ol className="ctx">{[...w.contexts].reverse().map((c) => (
              <li key={c.url + c.date}>{c.sentence} <a href={c.url} target="_blank" rel="noreferrer">{d(c.date)} ↗</a></li>
            ))}</ol>}
          </li>
        ))}
      </ul>
      <footer>
        <button onClick={() => download(`word-catcher-${today}.md`, toMarkdown(words), 'text/markdown')}>导出 Markdown</button>
        <button onClick={() => download(`word-catcher-${today}.json`, JSON.stringify(buildExport(words), null, 2), 'application/json')}>导出 JSON</button>
        <button onClick={() => fileRef.current?.click()}>导入 JSON</button>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => void onImport(e.target.files?.[0])} />
        <button className="danger" onClick={() => { if (confirm('确定清空所有单词？此操作不可撤销（建议先导出 JSON 备份）。')) void send({ type: 'clear' }); }}>清空</button>
        <button onClick={() => void chrome.runtime.openOptionsPage()}>设置</button>
        <label className="toggle"><input type="checkbox" checked={settings.toast}
          onChange={(e) => void chrome.storage.local.set({ settings: { ...settings, toast: e.target.checked } })} /> 页面提示</label>
      </footer>
    </div>
  );
}
