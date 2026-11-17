// Page card end to end: selection → icon → card → cache → dismissal, against a fake OpenAI-compatible gateway.
// Headless Chrome never answers the optional-host-permission prompt, so this run loads a copy of dist whose
// manifest grants the fake gateway's origin at install. The product manifest is not changed.
import { chromium } from 'playwright-core';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';

const GATEWAY_PORT = 8766, PAGE_PORT = 8767;
const dist = path.resolve('dist');
const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-lookup-ext-'));
fs.cpSync(dist, extDir, { recursive: true });
const manifestPath = path.join(extDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.host_permissions = [`http://127.0.0.1:${GATEWAY_PORT}/*`];
fs.writeFileSync(manifestPath, JSON.stringify(manifest));

const answer = {
  definitions: ['n. 意外发现珍奇事物的运气'],
  collocations: ['by serendipity'],
  phrases: [],
  examples: [{ en: 'A happy serendipity brought them together.', translation: '一次幸运的邂逅让他们走到了一起。' }],
  meaning: '在这句里指读文档时的意外收获',
};
// A phrase the fake judges as a phrase, with empty collocations and phrases so the card skips those sections.
const phraseAnswer = { definitions: ['n. 读文档时的收获'], collocations: [], phrases: [], examples: [], meaning: '读文档这件事' };
// Route by what each request asks for. The judgement and the phrase lookup both carry the phrase text.
const replyFor = (body) => {
  // The judgement's system prompt is the only place that describes a fixed expression.
  if (body.includes('fixed expression that a learner')) return { isPhrase: true, confidence: 0.9 };
  // A phrase lookup names the phrase alone or as 'Word: reading docs'. A word in a sentence containing it does not match.
  if (body.includes('"reading docs"') || body.includes('Word: reading docs')) return phraseAnswer;
  return answer;
};
let gatewayCalls = 0;
let gatewayFails = false;
const gateway = http.createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (req.url === '/v1/chat/completions') {
      gatewayCalls++;
      if (gatewayFails) { res.writeHead(500, { ...cors, 'content-type': 'application/json' }); res.end('{"error":{"message":"boom"}}'); return; }
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'x', object: 'chat.completion', created: 0, model: 'fake',
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(replyFor(body)) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
      return;
    }
    res.writeHead(404, cors); res.end();
  });
}).listen(GATEWAY_PORT);
const pages = http.createServer((_q, r) => { r.setHeader('content-type', 'text/html'); r.end(fs.readFileSync('e2e/page.html')); }).listen(PAGE_PORT);

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-lookup-')), {
  headless: false,
  args: ['--headless=new', `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--disable-features=DisableLoadExtensionCommandLineSwitch', '--no-sandbox'],
});
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });

fs.mkdirSync('e2e/out', { recursive: true });
const failures = [];
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures.push(name); };
const cfg = { baseUrl: `http://127.0.0.1:${GATEWAY_PORT}/v1`, apiKey: '', model: 'fake-model', language: 'zh-CN' };
await sw.evaluate((c) => chrome.storage.local.set({ aiConfig: c }), cfg);

const page = await ctx.newPage();
await page.goto(`http://localhost:${PAGE_PORT}/doc`); await page.waitForTimeout(800);

// Selects a word on the page without a real mouse, then sends the mouseup the content script listens for.
async function selectWord(word) {
  // Clicking elsewhere first: a collapsed selection resets the content script's repeat check.
  await page.evaluate(() => { getSelection().removeAllRanges(); document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
  await page.waitForTimeout(50);
  await page.evaluate((w) => {
    const t = document.getElementById('p').firstChild; const i = t.data.indexOf(w);
    const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + w.length);
    const s = getSelection(); s.removeAllRanges(); // a real mousedown clears the old selection first
    s.addRange(r);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, word);
}
const hostExists = () => page.evaluate(() => !!document.getElementById('word-catcher-lookup'));
const cardText = () => page.evaluate(() => document.getElementById('word-catcher-lookup')?.shadowRoot?.querySelector('.card')?.textContent ?? '');
async function clickIcon() {
  const c = await page.evaluate(() => {
    const b = document.getElementById('word-catcher-lookup').shadowRoot.querySelector('.icon').getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  await page.mouse.click(c.x, c.y);
}
async function clickButton(label) {
  const c = await page.evaluate((l) => {
    const b = [...document.getElementById('word-catcher-lookup').shadowRoot.querySelectorAll('.btn')].find((x) => x.textContent === l);
    if (!b) return null;
    const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, label);
  if (!c) return false;
  await page.mouse.click(c.x, c.y);
  return true;
}
async function waitCalls(n, timeout = 8000) {
  for (const end = Date.now() + timeout; gatewayCalls < n && Date.now() < end;) await new Promise((r) => setTimeout(r, 20));
  await page.waitForTimeout(200);
}
const waitCard = (needle, timeout = 8000) => page.waitForFunction((n) => (document.getElementById('word-catcher-lookup')?.shadowRoot?.querySelector('.card')?.textContent ?? '').includes(n), needle, { timeout });
const count = async () => (await sw.evaluate(() => chrome.storage.local.get('words'))).words?.serendipity?.count;

// 1. First selection: icon appears, click opens the card with the answer and ×N.
await selectWord('serendipity');
await page.waitForSelector('#word-catcher-lookup', { state: 'attached', timeout: 5000 });
check('icon appears after a selection when AI is configured', await hostExists());
await clickIcon();
await page.waitForFunction(() => (document.getElementById('word-catcher-lookup')?.shadowRoot?.querySelector('.card')?.textContent ?? '').includes('释义'), null, { timeout: 8000 });
let text = await cardText();
check('card shows the definition and collocation', text.includes('意外发现珍奇事物') && text.includes('by serendipity'), text.slice(0, 80));
check('card shows the example with its translation', text.includes('幸运的邂逅'));
check('card shows the count ×1', text.includes('×1'));
check('card shows the meaning in the original sentence', text.includes('原句中的意思') && text.includes('意外收获'));
check('first open makes one gateway request', gatewayCalls === 1, `calls=${gatewayCalls}`);
await page.screenshot({ path: 'e2e/out/lookup-card.png' });

// 2. Escape closes the card.
await page.keyboard.press('Escape');
check('Escape closes the card', !(await hostExists()));

// 3. Selecting again in the same page within 5 minutes: not counted, but the icon still appears.
await selectWord('serendipity');
await page.waitForSelector('#word-catcher-lookup', { state: 'attached', timeout: 5000 });
check('repeat selection inside 5 minutes still shows the icon', await hostExists());
check('repeat selection does not change the count', (await count()) === 1, `count=${await count()}`);

// 4. Reopening shows the cached result with no new request.
await clickIcon();
await page.waitForFunction(() => (document.getElementById('word-catcher-lookup')?.shadowRoot?.querySelector('.card')?.textContent ?? '').includes('释义'), null, { timeout: 5000 });
check('reopen shows the cached card', (await cardText()).includes('意外发现珍奇事物'));
check('reopen sends no new gateway request', gatewayCalls === 1, `calls=${gatewayCalls}`);
const stored = await sw.evaluate(() => chrome.storage.local.get('words'));
check('lookup is cached on the entry in storage', !!stored.words?.serendipity?.lookup?.definitions?.length);

// 5. 重新生成 sends a new request. A failure shows the reason and 重试, with no automatic retry.
check('重新生成 button is shown', await clickButton('重新生成'));
await waitCalls(2);
await waitCard('释义');
check('重新生成 makes one new gateway request', gatewayCalls === 2, `calls=${gatewayCalls}`);
gatewayFails = true;
await clickButton('重新生成');
await waitCard('查词失败');
await page.waitForTimeout(500);
text = await cardText();
check('a failure shows the reason and a 重试 button', text.includes('查词失败') && text.includes('重试'), text.slice(0, 80));
check('a failure is not retried automatically', gatewayCalls === 3, `calls=${gatewayCalls}`);
const kept = await sw.evaluate(() => chrome.storage.local.get('words'));
check('a failed regenerate keeps the cached lookup', !!kept.words?.serendipity?.lookup?.definitions?.length);
gatewayFails = false;
await clickButton('重试');
await waitCard('释义');
await page.waitForTimeout(300);
check('重试 succeeds once the gateway recovers', gatewayCalls === 4 && (await cardText()).includes('意外收获'), `calls=${gatewayCalls}`);

// 6. A click outside closes the card.
await page.mouse.click(5, 5);
check('clicking outside closes the card', !(await hostExists()));

// 6b. A phrase that the judgement passes gets an icon, and its card shows the same sections as a word.
await selectWord('reading docs');
await page.waitForTimeout(2500);
await page.waitForSelector('#word-catcher-lookup', { state: 'attached', timeout: 8000 });
check('phrase icon appears once the judgement passes', await hostExists());
await clickIcon();
await page.waitForFunction(() => (document.getElementById('word-catcher-lookup')?.shadowRoot?.querySelector('.card')?.textContent ?? '').includes('释义'), null, { timeout: 8000 });
text = await cardText();
check('phrase card shows the definition', text.includes('读文档时的收获'), text.slice(0, 80));
check('phrase card shows the meaning in the sentence', text.includes('原句中的意思') && text.includes('读文档这件事'));
check('empty collocation and phrase sections are not shown', !text.includes('搭配') && !text.includes('短语'), text.slice(0, 120));
await page.keyboard.press('Escape');

// 7. Without a saved model there is no icon, and counting still works.
await sw.evaluate(() => chrome.storage.local.set({ aiConfig: { baseUrl: 'http://127.0.0.1:3425/v1', apiKey: '', model: '', language: 'zh-CN' } }));
await page.goto(`http://localhost:${PAGE_PORT}/doc2`); await page.waitForTimeout(800);
await selectWord('serendipity');
await page.waitForTimeout(800);
check('no icon when AI is not configured', !(await hostExists()));
check('counting still works without AI', (await count()) === 2, `count=${await count()}`);

await ctx.close(); gateway.close(); pages.close();
fs.rmSync(extDir, { recursive: true, force: true });
if (failures.length) { console.log(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log('\nall lookup checks passed');
