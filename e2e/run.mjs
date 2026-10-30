import { chromium } from 'playwright-core';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const dist = path.resolve('dist'); const out = path.resolve('e2e/out'); fs.mkdirSync(out, { recursive: true });
const srv = http.createServer((_q, r) => { r.setHeader('content-type', 'text/html'); r.end(fs.readFileSync('e2e/page.html')); }).listen(8765);
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync('/tmp/wc-'), {
  executablePath: '/usr/bin/google-chrome', headless: false,
  args: ['--headless=new', `--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--disable-features=DisableLoadExtensionCommandLineSwitch', '--no-sandbox'],
});
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const id = new URL(sw.url()).host; console.log('extension id', id);
const page = await ctx.newPage(); await page.goto('http://localhost:8765/doc'); await page.waitForTimeout(800);
async function select(word) {
  const box = await page.evaluate((w) => {
    const t = document.getElementById('p').firstChild; const i = t.data.indexOf(w);
    const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + w.length);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r); const b = r.getBoundingClientRect(); return { x: b.right, y: b.top + b.height / 2 };
  }, word);
  await page.mouse.move(box.x, box.y); await page.mouse.down(); await page.mouse.up(); // mouseup collapses? re-select after
  await page.waitForTimeout(500);
}
// first select via dispatching mouseup with selection held
async function selectKeep(word) {
  await page.evaluate((w) => {
    const t = document.getElementById('p').firstChild; const i = t.data.indexOf(w);
    const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + w.length);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, word);
  await page.waitForTimeout(600);
}
void select;
await selectKeep('serendipity');
const s1 = await sw.evaluate(() => chrome.storage.local.get('words'));
console.log('after 1st:', JSON.stringify(s1.words?.serendipity));
// second selection on a different page path (same page within 5 min would be deduped by design)
await selectKeep('serendipity');
const sDup = await sw.evaluate(() => chrome.storage.local.get('words'));
console.log('same page re-select count (expect 1):', sDup.words?.serendipity?.count);
await page.goto('http://localhost:8765/doc2'); await page.waitForTimeout(800);
await selectKeep('serendipity');
await page.waitForTimeout(300);
const toast = await page.evaluate(() => document.documentElement.lastElementChild?.shadowRoot === null && document.documentElement.children.length);
await page.screenshot({ path: `${out}/page-toast.png` });
const s2 = await sw.evaluate(() => chrome.storage.local.get('words'));
console.log('after 2nd:', JSON.stringify(s2.words?.serendipity));
const badge = await sw.evaluate(() => chrome.action.getBadgeText({}));
console.log('badge:', badge, 'html children', toast);
// textarea should be ignored
await page.evaluate(() => { const t = document.getElementById('ta'); t.focus(); t.select(); document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
await page.waitForTimeout(500);
console.log('count after textarea select (expect 2):', (await sw.evaluate(() => chrome.storage.local.get('words'))).words.serendipity.count);
const pop = await ctx.newPage(); await pop.setViewportSize({ width: 420, height: 400 });
await pop.goto(`chrome-extension://${id}/popup.html`); await pop.waitForTimeout(800);
await pop.click('text=serendipity'); await pop.waitForTimeout(300);
await pop.screenshot({ path: `${out}/popup.png` });
const ok = s2.words?.serendipity?.count === 2 && s2.words.serendipity.status === 'saved' && sDup.words.serendipity.count === 1;
console.log(ok ? 'E2E PASS' : 'E2E FAIL');
await ctx.close(); srv.close(); process.exit(ok ? 0 : 1);
