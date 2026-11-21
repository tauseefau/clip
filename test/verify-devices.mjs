// A device plugged in after setup (a Bluetooth headset pairing late) must appear in the pickers.
// Usage: node test/verify-devices.mjs <base-url>   (needs playwright-core; PLAYWRIGHT_FROM=<dir>/ works)
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(process.env.PLAYWRIGHT_FROM || import.meta.url);
const { chromium } = require('playwright-core');

const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const page = await browser.newPage();
await page.goto(process.argv[2]);
await page.click('button:has-text("Cam only")');
await page.waitForSelector('#micSelect option', { state: 'attached' });

// Pretend a Bluetooth headset connected: the OS adds a device and the browser fires devicechange.
await page.evaluate(() => {
  const md = navigator.mediaDevices;
  const real = md.enumerateDevices.bind(md);
  const headset = { kind: 'audioinput', label: 'Bluetooth Headset', deviceId: 'bt-1', groupId: 'bt' };
  md.enumerateDevices = async () => [...(await real()), headset];
  md.dispatchEvent(new Event('devicechange'));
});
await page.waitForFunction(() => [...document.querySelectorAll('#micSelect option')].some((o) => o.textContent === 'Bluetooth Headset'), null, { timeout: 3000 })
  .catch(() => assert.fail('Bluetooth headset connected after setup is not listed'));
await browser.close();
console.log('devices: ok');
