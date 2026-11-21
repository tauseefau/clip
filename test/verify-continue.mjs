// "Record more": opens the recorder with ?continue=<id>, records a short fake-camera take and checks it is joined
// onto the end of that recording as a new clip (the original untouched).
// Usage: node test/verify-continue.mjs <base-url> <recording-id>   (needs playwright-core)
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(process.env.PLAYWRIGHT_FROM || import.meta.url);
const { chromium } = require('playwright-core');

const [base, id] = process.argv.slice(2);
const get = async (path) => (await fetch(base + path)).json();
const original = await get(`/api/recordings/${id}`);
const before = (await get('/api/recordings')).length;

const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`${base}/watch/${id}`);
assert.equal(await page.getAttribute('#recordMore', 'href'), `/?continue=${id}`);
await page.click('#recordMore');
await page.waitForSelector('#continueNote:not([hidden])');
assert.equal(await page.textContent('#continueLink'), original.title);

await page.click('button:has-text("Cam only")');
await page.waitForSelector('#stage canvas');
await page.click('#startBtn');
await page.waitForSelector('#stopBtn:not([hidden])', { timeout: 15000 });
await page.waitForTimeout(3000);
await page.click('#stopBtn');
await page.waitForURL(/\/watch\//, { timeout: 120000 });

const joinedId = page.url().split('/').pop();
const joined = await get(`/api/recordings/${joinedId}`);
assert.equal(joined.title, original.title);
assert.ok(joined.duration_ms > original.duration_ms + 1500, `joined ${joined.duration_ms} ms vs original ${original.duration_ms} ms`);
assert.equal((await get(`/api/recordings/${id}`)).duration_ms, original.duration_ms, 'original untouched');
assert.equal((await get('/api/recordings')).length, before + 2, 'the take and the joined clip are both saved');
assert.deepEqual(errors, []);
console.log(`ok   record more: ${original.duration_ms} ms + take -> ${joined.duration_ms} ms as ${joinedId}`);
await browser.close();
