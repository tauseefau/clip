// Drives the recorder in headless Chromium with a fake camera and checks the live tools.
// Usage: node test/verify-annotate.mjs <base-url> [screenshot.png]   (needs playwright-core on NODE_PATH or in cwd)
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(process.env.PLAYWRIGHT_FROM || import.meta.url);
const { chromium } = require('playwright-core');

const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(process.argv[2]);
await page.click('button:has-text("Cam only")');
await page.waitForSelector('#stage canvas');
await page.waitForFunction(() => document.querySelector('#stage canvas').width > 300);
const box = await page.locator('#stage canvas').boundingBox();
const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
const pixel = (fx, fy) => page.evaluate(([fx, fy]) => {
  const c = document.querySelector('#stage canvas');
  return [...c.getContext('2d').getImageData(Math.round(c.width * fx), Math.round(c.height * fy), 1, 1).data];
}, [fx, fy]);
const isRed = ([r, g, b]) => r > 200 && g < 110 && b < 110;
const drag = async (a, b) => { await page.mouse.move(...at(...a)); await page.mouse.down(); await page.mouse.move(...at(...b), { steps: 8 }); await page.mouse.up(); };
const settle = () => page.waitForTimeout(400);

// Pen: a horizontal stroke leaves red ink on its path.
await page.keyboard.press('p');
await drag([0.2, 0.3], [0.6, 0.3]);
await settle();
assert(isRed(await pixel(0.4, 0.3)), 'pen stroke is drawn');

// Text: typed letters land on the canvas and do not fire shortcuts (c would clear, h would switch tool).
await page.keyboard.press('t');
await page.mouse.click(...at(0.2, 0.5));
await page.keyboard.type('chz HELLO');
await page.keyboard.press('Escape');
await settle();
assert(isRed(await pixel(0.4, 0.3)), 'typing "c" did not clear the pen stroke');
assert.equal(await page.getAttribute('[data-tool="text"]', 'aria-pressed'), 'true', 'typing "h" kept the text tool');

// Comment box: dark panel behind the text.
await page.keyboard.press('n');
await page.mouse.click(...at(0.2, 0.7));
await page.keyboard.type('MMMMMMMMMMMMMMMM');
await page.keyboard.press('Escape');
await page.keyboard.press('Escape'); // leave the tool
await settle();
if (process.argv[3]) await page.screenshot({ path: process.argv[3] });

// Zoom 2x with the mouse at (0.01, 0.01): content point c shows at 2c - 0.01, so (0.4, 0.3) moves to (0.79, 0.59).
await page.mouse.move(...at(0.01, 0.01));
await page.keyboard.press('z');
await page.waitForTimeout(1200);
assert(isRed(await pixel(0.79, 0.59)), 'zoom scales annotations with the scene');
assert(!isRed(await pixel(0.4, 0.3)), 'zoom moved the stroke off its old spot');
// Drawing while zoomed lands under the cursor.
await page.keyboard.press('p');
await drag([0.3, 0.9], [0.7, 0.9]);
await settle();
assert(isRed(await pixel(0.5, 0.9)), 'pen follows the cursor while zoomed');
await page.keyboard.press('Escape');
await page.keyboard.press('z');
await page.waitForTimeout(1200);
assert(isRed(await pixel(0.4, 0.3)), 'zoom out restores the frame');
assert(isRed(await pixel(0.25, 0.455)), 'stroke drawn while zoomed sits at its content position');

// Undo removes the last mark, Clear the rest.
await page.keyboard.press('Control+z');
await settle();
assert(!isRed(await pixel(0.25, 0.455)), 'undo removed the last stroke');
await page.keyboard.press('c');
await settle();
assert(!isRed(await pixel(0.4, 0.3)), 'clear removed everything');

// Spotlight dims everything outside the dragged area and leaves the inside alone.
const lum = (p) => p[0] + p[1] + p[2];
const [out0, in0] = [await pixel(0.1, 0.62), await pixel(0.32, 0.32)];
await page.keyboard.press('o');
await drag([0.3, 0.3], [0.6, 0.6]);
await settle();
assert(lum(await pixel(0.1, 0.62)) < lum(out0) * 0.6, 'spotlight dims outside the area');
assert(Math.abs(lum(await pixel(0.32, 0.32)) - lum(in0)) < 30, 'spotlight leaves the inside lit');

// Step markers: a filled badge where clicked, numbered up from 1.
await page.keyboard.press('m');
await page.mouse.click(...at(0.8, 0.2));
await page.mouse.click(...at(0.8, 0.4));
await settle();
assert(isRed(await pixel(0.8, 0.222)), 'step badge is drawn');

// Fade: with the box ticked, marks are gone a little after 5 s.
await page.check('#fadeMarks');
await page.waitForTimeout(5800);
assert(!isRed(await pixel(0.8, 0.222)), 'marks fade out');
assert(lum(await pixel(0.1, 0.62)) > lum(out0) * 0.9, 'spotlight fades out');

assert.deepEqual(errors, []);
await browser.close();
console.log('verify-annotate: ok');
