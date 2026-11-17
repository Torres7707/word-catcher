// Popup lookup end to end: a saved lookup shows in the popup and on the page card with no request,
// an uncached word asks once, 重新生成 replaces the cache, and a failure shows 重试 without retrying itself.
// Like e2e/lookup.mjs, this runs a copy of dist whose manifest grants the fake gateway's origin.
import { chromium } from 'playwright-core';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';

const GATEWAY_PORT = 8768, PAGE_PORT = 8769;
const dist = path.resolve('dist');
const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-popup-ext-'));
fs.cpSync(dist, extDir, { recursive: true });
const manifestPath = path.join(extDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.host_permissions = [`http://127.0.0.1:${GATEWAY_PORT}/*`];
fs.writeFileSync(manifestPath, JSON.stringify(manifest));

const answer = (n) => ({
  definitions: [`n. 意外发现珍奇事物的运气 (${n})`],
  collocations: ['by serendipity'],
  phrases: [],
  examples: [{ en: 'A happy serendipity brought them together.', translation: '一次幸运的邂逅让他们走到了一起。' }],
  meaning: '在这句里指读文档时的意外收获',
});
let gatewayCalls = 0, gatewayFails = false;
const gateway = http.createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    if (req.url !== '/v1/chat/completions') { res.writeHead(404, cors); res.end(); return; }
    gatewayCalls++;
    if (gatewayFails) { res.writeHead(500, { ...cors, 'content-type': 'application/json' }); res.end('{"error":{"message":"boom"}}'); return; }
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'x', object: 'chat.completion', created: 0, model: 'fake',
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(answer(gatewayCalls)) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
}).listen(GATEWAY_PORT);
const pages = http.createServer((_q, r) => { r.setHeader('content-type', 'text/html'); r.end(fs.readFileSync('e2e/page.html')); }).listen(PAGE_PORT);

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-popup-')), {
  headless: false,
  args: ['--headless=new', `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--disable-features=DisableLoadExtensionCommandLineSwitch', '--no-sandbox'],
});
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const extId = new URL(sw.url()).host;

fs.mkdirSync('e2e/out', { recursive: true });
const failures = [];
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures.push(name); };
const cfg = { baseUrl: `http://127.0.0.1:${GATEWAY_PORT}/v1`, apiKey: '', model: 'fake-model', language: 'zh-CN' };
const cached = { definitions: ['n. 意外发现珍奇事物的运气'], collocations: ['by serendipity'], phrases: ['serendipity of'],
  examples: [{ en: 'A happy serendipity brought them together.', translation: '一次幸运的邂逅让他们走到了一起。' }], generatedAt: '2026-01-02T00:00:00.000Z' };
const seen = '2026-01-01T10:00:00.000Z';
const seed = {
  serendipity: { word: 'serendipity', kind: 'word', count: 2, firstSeen: seen, lastSeen: seen, contexts: [], status: 'saved', lookup: cached },
  'give up': { word: 'give up', kind: 'phrase', count: 2, firstSeen: seen, lastSeen: seen, contexts: [], status: 'saved' },
};
await sw.evaluate(([c, w]) => chrome.storage.local.set({ aiConfig: c, words: w }), [cfg, seed]);

// The page card and the popup read the same storage, so compare what each shows.
const page = await ctx.newPage();
await page.goto(`http://localhost:${PAGE_PORT}/doc`); await page.waitForTimeout(800);
async function selectWord(word) {
  await page.evaluate(() => { getSelection().removeAllRanges(); document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
  await page.waitForTimeout(50);
  await page.evaluate((w) => {
    const t = document.getElementById('p').firstChild; const i = t.data.indexOf(w);
    const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + w.length);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, word);
}
const cardText = () => page.evaluate(() => document.getElementById('word-catcher-lookup')?.shadowRoot?.querySelector('.card')?.textContent ?? '');
async function clickIcon() {
  const c = await page.evaluate(() => {
    const b = document.getElementById('word-catcher-lookup').shadowRoot.querySelector('.icon').getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  await page.mouse.click(c.x, c.y);
}

const pop = await ctx.newPage();
await pop.goto(`chrome-extension://${extId}/popup.html`);
await pop.waitForSelector('.row');
const lkText = () => pop.evaluate(() => document.querySelector('.lk')?.textContent ?? '');
const openRow = async (word) => { await pop.locator('.row', { hasText: word }).first().click(); };

// 1. A saved lookup opens at once in the popup, with no request.
await openRow('serendipity');
await pop.waitForSelector('.lk', { timeout: 3000 });
check('a saved lookup shows in the popup', (await lkText()).includes('意外发现珍奇事物'), (await lkText()).slice(0, 60));
check('opening a saved word sends no request', gatewayCalls === 0, `calls=${gatewayCalls}`);

// 2. The page card shows the same saved lookup for the same word, also with no request.
await selectWord('serendipity');
await page.waitForSelector('#word-catcher-lookup', { state: 'attached', timeout: 5000 });
await page.bringToFront(); // the popup tab took focus; the real mouse click needs this page on top
await clickIcon();
await page.waitForFunction(() => (document.getElementById('word-catcher-lookup')?.shadowRoot?.querySelector('.card')?.textContent ?? '').includes('释义'), null, { timeout: 8000 });
// The seeded entry has no meaning for this sentence yet, so the page card asks for that one meaning only.
const pageDefs = (await cardText()).includes('意外发现珍奇事物');
const popDefs = (await lkText()).includes('意外发现珍奇事物');
check('the page card shows the same definition as the popup', pageDefs && popDefs);
check('the page card asks only for the sentence meaning, once', gatewayCalls === 1, `calls=${gatewayCalls}`);
const base = gatewayCalls;

// 3. An uncached word asks once and then shows the answer.
await openRow('give up');
await pop.waitForFunction(() => (document.querySelector('.lk')?.textContent ?? '').includes('释义'), null, { timeout: 8000 });
check('an uncached word asks once', gatewayCalls === base + 1, `calls=${gatewayCalls}`);
const stored = await sw.evaluate(() => chrome.storage.local.get('words'));
check('the answer is saved on the entry', !!stored.words?.['give up']?.lookup?.definitions?.length);

// 4. 重新生成 replaces the cached lookup.
const before = stored.words.serendipity.lookup.generatedAt;
await openRow('serendipity'); // opening a row closes the one that was open
// The fake answer names the call number, so the text shows which request produced it.
const expectN = gatewayCalls + 1;
await pop.locator('.lk button', { hasText: '重新生成' }).click();
await pop.waitForFunction((n) => (document.querySelector('.lk')?.textContent ?? '').includes(`(${n})`), expectN, { timeout: 8000 });
const after = (await sw.evaluate(() => chrome.storage.local.get('words'))).words.serendipity.lookup;
check('重新生成 replaces the cached lookup', after.generatedAt !== before && (await lkText()).includes(`(${expectN})`), `calls=${gatewayCalls}`);

// 5. A failure shows the reason and 重试, with no automatic retry. The saved lookup stays.
gatewayFails = true;
await pop.locator('.lk button', { hasText: '重新生成' }).click();
await pop.waitForFunction(() => (document.querySelector('.lk')?.textContent ?? '').includes('查词失败'), null, { timeout: 8000 });
await pop.waitForTimeout(800);
const callsAfterFail = gatewayCalls;
check('a failure shows the reason and 重试', (await lkText()).includes('查词失败') && (await pop.getByRole('button', { name: '重试' }).count()) === 1);
check('a failure keeps the saved definition visible', (await lkText()).includes('意外发现珍奇事物'));
check('a failure is not retried automatically', gatewayCalls === callsAfterFail, `calls=${gatewayCalls}`);

// 6. 重试 repeats the failed regenerate, and the card recovers.
gatewayFails = false;
await pop.getByRole('button', { name: '重试' }).click();
// The error clears as soon as the retry starts, so wait for the answer itself.
await pop.waitForFunction((n) => (document.querySelector('.lk')?.textContent ?? '').includes(`(${n})`), callsAfterFail + 1, { timeout: 8000 });
check('重试 recovers once the gateway answers', !(await lkText()).includes('查词失败') && gatewayCalls === callsAfterFail + 1);

// 7. Search matches phrases and single words.
await pop.fill('.search', 'give');
await pop.waitForTimeout(200);
check('search finds a phrase', (await pop.locator('.row').count()) === 1 && (await pop.textContent('.row')).includes('give up'));

await ctx.close(); gateway.close(); pages.close();
fs.rmSync(extDir, { recursive: true, force: true });
if (failures.length) { console.log(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log('\nall popup checks passed');
