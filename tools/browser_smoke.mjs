/** Fresh-profile browser checks. Requires playwright-core (bundled Codex runtime
 * or a local installation); DICHROIC_PLAYWRIGHT_ROOT selects its package root.
 * Run against a built preview: node tools/browser_smoke.mjs --depth --offline
 * The --depth option explicitly exercises the model download button.
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const require = createRequire(process.env.DICHROIC_PLAYWRIGHT_ROOT
  ? resolve(process.env.DICHROIC_PLAYWRIGHT_ROOT, 'package.json') : new URL('../package.json', import.meta.url));
const { chromium } = require('playwright-core');
const base = process.env.DICHROIC_SMOKE_URL ?? 'http://127.0.0.1:5183/';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 },
  // Exercise the low-memory CPU depth policy in Chrome, without claiming
  // that browser emulation validates physical iPhone hardware.
  userAgent: process.argv.includes('--gpu-depth') ? undefined : 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1',
});
const page = await context.newPage();
const errors = [];
const nativeWarnings = [];
let depthRequests = 0;
const depthUrls = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  const value = message.text();
  // Emscripten routes ORT's native stderr through console.error. These
  // explicit W-level notices describe normal CPU shape ops in a GPU graph.
  if (/\[W:onnxruntime:, session_state\.cc:\d+ VerifyEachNodeIsAssignedToAnEp\]/.test(value)) nativeWarnings.push(value);
  else errors.push(value);
});
context.on('request', (request) => {
  const url = new URL(request.url());
  // Vite serves ?import&url as a tiny JS URL module, without the WASM bytes.
  if (/huggingface\.co/.test(url.hostname) || (/ort-wasm.*\.wasm$/.test(url.pathname) && !url.searchParams.has('import'))) {
    depthRequests += 1;
    depthUrls.push(request.url());
  }
});
const waitEditing = async () => {
  await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 120_000 });
  await page.getByRole('dialog', { name: 'Opening photo' }).waitFor({ state: 'hidden', timeout: 120_000 });
};
try {
  await page.goto(base);
  await page.getByText('Darkroom ready.', { exact: false }).waitFor({ timeout: 120_000 });
  console.log('PASS startup');
  const input = page.locator('input[type=file]');
  await input.setInputFiles(resolve('test/fixtures/io/tiff_rgb8/input.tif'));
  await waitEditing();
  console.log('PASS photo preparation and preview');

  await input.setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) });
  const alert = page.getByRole('alertdialog'); await alert.waitFor();
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press('Tab');
    assert(await alert.evaluate((node) => node.contains(document.activeElement)), 'alert leaked keyboard focus');
  }
  await page.keyboard.press('Escape'); await alert.waitFor({ state: 'hidden' });
  await waitEditing();
  console.log('PASS failed replacement retains editor; alert traps and restores focus');

  if (process.argv.includes('--depth')) {
    await page.getByText('Lens', { exact: true }).first().click();
    await page.getByRole('switch', { name: /Lens Blur/i }).click();
    const download = page.getByRole('button', { name: /^Download/ });
    await download.waitFor({ timeout: 30_000 });
    assert.equal(depthRequests, 0, `depth assets fetched without download consent: ${depthUrls.join(', ')}`);
    console.log('PASS no depth asset download before consent');
    await download.click();
    await page.waitForFunction(() => /Depth ready|Couldn.t measure depth/.test(document.body.innerText), undefined, { timeout: 240_000 });
    const status = await page.locator('body').innerText();
    assert(status.includes('Depth ready'), status.match(/Couldn.t measure depth:.*/)?.[0] ?? 'depth inference failed');
    console.log(`PASS real depth model inference (${depthRequests} asset requests): ${status.split('\n').filter((line) => /Depth ready|WebGPU|WASM|CPU/.test(line)).join(' / ')}`);
  }

  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/browser-smoke.png' });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const discard = page.getByRole('button', { name: 'Discard Edits', exact: true });
  if (await discard.isVisible()) await discard.click();
  await page.locator('canvas').first().waitFor({ state: 'hidden' });
  await page.locator('input[type=file]').setInputFiles(resolve('test/fixtures/io/tiff_rgb8/input.tif'));
  await waitEditing();
  console.log('PASS close retires worker; reopening initializes and renders again');
  if (process.argv.includes('--offline')) {
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 30_000 });
    await context.setOffline(true);
    await page.reload();
    await page.getByText('Darkroom ready.', { exact: false }).waitFor({ timeout: 120_000 });
    await page.locator('input[type=file]').setInputFiles(resolve('test/fixtures/io/tiff_rgb8/input.tif'));
    await waitEditing();
    console.log('PASS offline PWA reload and local photo rendering');
    if (process.argv.includes('--depth')) {
      await page.getByText('Lens', { exact: true }).first().click();
      const blur = page.getByRole('switch', { name: /Lens Blur/i });
      if (await blur.getAttribute('aria-checked') !== 'true') await blur.click();
      await page.getByText(/Depth ready/).waitFor({ timeout: 120_000 });
      console.log('PASS cached depth inference offline');
    }
  }
  assert.deepEqual(errors, [], 'browser errors');
  console.log(`PASS no browser failures (${nativeWarnings.length} native provider-assignment warnings)`);
} finally {
  await context.close(); await browser.close();
}
