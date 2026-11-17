import { useEffect, useState } from 'react';
import { DEFAULT_AI_CONFIG, TIMEOUT_RANGE, originPattern, validateBaseUrl } from '../lib/ai';
import type { AiConfig, AiFailure, AiTestResult } from '../lib/types';

const LANGUAGES = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en', label: 'English' },
];
const REASON: Record<AiFailure, string> = {
  address: '地址或网络问题',
  key: 'key 问题',
  model: '模型名问题',
  timeout: '超时',
  unknown: '未知错误',
};

type Notice = { kind: 'ok' | 'err' | 'info'; text: string };

/** Trims the form and checks the address. Throws with a message the user can read. */
function normalize(form: AiConfig): AiConfig {
  return {
    baseUrl: validateBaseUrl(form.baseUrl),
    apiKey: form.apiKey.trim(),
    model: form.model.trim(),
    language: form.language,
    timeoutSeconds: checkTimeout(form.timeoutSeconds),
  };
}

function checkTimeout(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds < TIMEOUT_RANGE.min || seconds > TIMEOUT_RANGE.max) {
    throw new Error(`请求超时需为 ${TIMEOUT_RANGE.min} 到 ${TIMEOUT_RANGE.max} 之间的整数（秒）`);
  }
  return seconds;
}

/**
 * Requests access to the gateway origin. Chrome shows its own prompt and resolves after the user answers.
 * `onPrompt` runs first so the page can say that a prompt is waiting.
 */
async function ensureOrigin(baseUrl: string, onPrompt: () => void): Promise<boolean> {
  const origins = [originPattern(baseUrl)];
  if (await chrome.permissions.contains({ origins })) return true;
  onPrompt();
  return chrome.permissions.request({ origins });
}

export function App() {
  const [form, setForm] = useState<AiConfig>(DEFAULT_AI_CONFIG);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void chrome.storage.local.get('aiConfig').then((r) => {
      if (r.aiConfig) setForm({ ...DEFAULT_AI_CONFIG, ...(r.aiConfig as Partial<AiConfig>) });
    });
  }, []);

  const field = (k: keyof AiConfig) => (value: string) => setForm((f) => ({ ...f, [k]: value }));

  const onSave = async () => {
    setBusy(true); setNotice(null);
    try {
      const next = normalize(form);
      const granted = await ensureOrigin(next.baseUrl, () => setNotice({ kind: 'info', text: `请在浏览器弹出的授权框中允许访问 ${originPattern(next.baseUrl)}` }));
      if (!granted) throw new Error(`没有授权访问 ${originPattern(next.baseUrl)}，配置未保存`);
      await chrome.storage.local.set({ aiConfig: next });
      setForm(next);
      setNotice({ kind: 'ok', text: '已保存' });
    } catch (e) {
      setNotice({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  };

  const onTest = async () => {
    setBusy(true); setNotice({ kind: 'info', text: '正在测试…' });
    try {
      const next = normalize(form);
      if (!next.model) throw new Error('请先填写模型名');
      const granted = await ensureOrigin(next.baseUrl, () => setNotice({ kind: 'info', text: `请在浏览器弹出的授权框中允许访问 ${originPattern(next.baseUrl)}` }));
      if (!granted) throw new Error(`没有授权访问 ${originPattern(next.baseUrl)}`);
      const r = await chrome.runtime.sendMessage({ type: 'testAi', config: next }) as AiTestResult | { error: string };
      if (!r || !('ok' in r)) throw new Error(r && 'error' in r ? r.error : '后台没有返回结果');
      setNotice(r.ok
        ? { kind: 'ok', text: '连接成功' }
        : { kind: 'err', text: `连接失败（${REASON[r.reason]}）：${r.message}` });
    } catch (e) {
      setNotice({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  };

  return (
    <div className="app opts">
      <header><h1>Word Catcher 设置</h1></header>

      <h2>AI 接入</h2>
      <label>接口地址 (baseUrl)</label>
      <input value={form.baseUrl} onChange={(e) => field('baseUrl')(e.target.value)} placeholder="http://127.0.0.1:3425/v1" />
      <div className="hint">默认是本机 magpie 网关。填其他 OpenAI 兼容服务时，保存会请求访问该地址的权限。</div>

      <label>API Key</label>
      <input type="password" value={form.apiKey} onChange={(e) => field('apiKey')(e.target.value)} placeholder="本地网关可留空" autoComplete="off" />

      <label>模型 (model)</label>
      <input value={form.model} onChange={(e) => field('model')(e.target.value)} placeholder="例如 gpt-4o-mini" autoComplete="off" />

      <label>请求超时（秒）</label>
      <input type="number" min={TIMEOUT_RANGE.min} max={TIMEOUT_RANGE.max} step={1} value={form.timeoutSeconds}
        onChange={(e) => setForm((f) => ({ ...f, timeoutSeconds: Number(e.target.value) }))} />
      <div className="hint">查词和判定短语最多等待这么久，{TIMEOUT_RANGE.min} 到 {TIMEOUT_RANGE.max} 秒。网关较慢时可以调大；失败时要等满这段时间才会提示。</div>

      <label>释义语言</label>
      <select value={form.language} onChange={(e) => field('language')(e.target.value)}>
        {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
      </select>

      <div className="actions">
        <button className="on" disabled={busy} onClick={() => void onSave()}>保存</button>
        <button disabled={busy} onClick={() => void onTest()}>测试连接</button>
      </div>
      {notice && <div className={`msg ${notice.kind}`}>{notice.text}</div>}
    </div>
  );
}
