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
};
let gatewayCalls = 0;
const gateway = http.createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (req.url === '/v1/chat/completions') {
      gatewayCalls++;
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'x', object: 'chat.completion', created: 0, model: 'fake',
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(answer) }, finish_reason: 'stop' }],
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

// 5. A click outside closes the card.
await page.mouse.click(5, 5);
check('clicking outside closes the card', !(await hostExists()));

// 6. Without a saved model there is no icon, and counting still works.
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
