// Drives the editor's one-step slicer in headless Chromium: mark, cut, guard against cutting everything,
// and render with a caption that runs past the cut clip (used to fail with "Caption ends past the trimmed clip").
// Usage: node test/verify-slicer.mjs <base-url> <recording-id> [screenshot.png]   (20 s recording; needs playwright-core)
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(process.env.PLAYWRIGHT_FROM || import.meta.url);
const { chromium } = require('playwright-core');

const [base, id, shot] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}/edit/${id}`);
await page.waitForFunction(() => Number(document.getElementById('end').value) > 19);

const seek = (t) => page.evaluate((t) => new Promise((done) => {
  const v = document.getElementById('player');
  v.addEventListener('seeked', done, { once: true });
  v.currentTime = t;
}), t);
const rows = () => page.$$eval('#cutRows li span', (spans) => spans.map((s) => s.textContent.replace(/→ 00:20\.\d$/, '→ end'))); // the test take runs 20.0x s

// Cut 5-10 s with the buttons.
assert.equal(await page.isDisabled('#cutOut'), true);
await seek(5);
await page.click('#markCut');
await seek(10);
assert.match(await page.textContent('#markReadout'), /00:05.0 → 00:10.0/);
if (shot) await page.screenshot({ path: shot });
await page.click('#cutOut');
assert.deepEqual(await rows(), ['00:00.0 → 00:05.0', '00:10.0 → end']);
assert.match(await page.textContent('#keptReadout'), /00:15.\d of 00:20.\d/);

// Cut 12-14 s with the X key, marking the end first: order must not matter.
await page.waitForTimeout(500); // undo folds edits under 400 ms apart into one step
await page.click('body', { position: { x: 5, y: 5 } }); // focus off the buttons so keys reach the page
await seek(14);
await page.keyboard.press('x');
await seek(12);
await page.keyboard.press('x');
assert.deepEqual(await rows(), ['00:00.0 → 00:05.0', '00:10.0 → 00:12.0', '00:14.0 → end']);

// Ctrl+Z brings the last cut back.
await page.waitForTimeout(500); // undo folds edits under 400 ms apart into one step
await page.keyboard.press('Control+z');
assert.deepEqual(await rows(), ['00:00.0 → 00:05.0', '00:10.0 → end']);

// Cutting the whole clip is refused with a message, and nothing changes.
await seek(0);
await page.click('#markCut');
await seek(25); // clamps to the very end of the take
await page.click('#cutOut');
assert.match(await page.textContent('#notice'), /cut the whole clip/);
assert.deepEqual(await rows(), ['00:00.0 → 00:05.0', '00:10.0 → end']);
await page.click('#clearMark');
assert.equal(await page.isHidden('#cutMark'), true);

// A caption written for the uncut 20 s clip (ends at 19 s, past the 15 s kept) must not block the render.
await page.click('#addCaption');
await page.fill('#captionRows .cap-start', '13');
await page.fill('#captionRows .cap-end', '19');
await page.fill('#captionRows .cap-text', 'late caption');
await page.click('#render');
await page.waitForURL(/\/watch\//, { timeout: 60000 });

assert.deepEqual(errors, []);
console.log('ok   slicer: mark/cut, X key, undo, whole-clip guard, caption past cut renders');
await browser.close();
