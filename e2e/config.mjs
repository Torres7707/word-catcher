// Checks the options page and the popup's settings entry in a real extension build.
// Headless Chrome never shows the optional-host-permission prompt, so chrome.permissions.request
// stays pending. This test checks that the page asks for permission before it waits on the prompt.
// The success path (request sent, model answers) is covered by unit tests with the AI SDK mock model.
import { chromium } from 'playwright-core';
import fs from 'node:fs'; import path from 'node:path';
const dist = path.resolve('dist');
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync('/tmp/wc-cfg-'), {
  headless: false,
  args: ['--headless=new', `--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--disable-features=DisableLoadExtensionCommandLineSwitch', '--no-sandbox'],
});
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const id = new URL(sw.url()).host;
const failures = [];
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures.push(name); };

const page = await ctx.newPage();
await page.goto(`chrome-extension://${id}/options.html`);
await page.waitForSelector('.opts');
const base = await page.inputValue('input[placeholder="http://127.0.0.1:3425/v1"]');
check('default baseUrl is the local magpie gateway', base === 'http://127.0.0.1:3425/v1', base);

await page.fill('input[placeholder="http://127.0.0.1:3425/v1"]', 'not a url');
await page.getByRole('button', { name: '保存' }).click();
await page.waitForSelector('.msg.err');
check('invalid address is rejected on save', (await page.textContent('.msg')).includes('不是合法的 URL'));

await page.fill('input[placeholder="http://127.0.0.1:3425/v1"]', 'http://127.0.0.1:8799/v1');
await page.fill('input[placeholder="例如 gpt-4o-mini"]', 'gpt-test');
await page.getByRole('button', { name: '测试连接' }).click();
await page.waitForFunction(() => (document.querySelector('.msg')?.textContent ?? '').includes('授权框'), null, { timeout: 5000 });
const msg = await page.textContent('.msg');
check('test connection asks for the origin permission before waiting', msg.includes('允许访问 http://127.0.0.1:8799/*'), msg);

const pop = await ctx.newPage();
await pop.goto(`chrome-extension://${id}/popup.html`);
await pop.waitForSelector('.app');
check('popup has a settings entry', (await pop.getByRole('button', { name: '设置' }).count()) === 1);

await ctx.close();
if (failures.length) { console.log(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log('\nall config checks passed');
