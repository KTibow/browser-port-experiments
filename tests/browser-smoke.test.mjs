import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { once } from 'node:events';
import test, { after, before } from 'node:test';
import { chromium } from 'playwright-core';
import { browsers, DEFAULT_WISP_URL } from '../src/registry.js';

const HOST = '127.0.0.1';
const PORT = 4173;
const APP_ORIGIN = `http://${HOST}:${PORT}`;
const APP_URL = `${APP_ORIGIN}/browser-port-experiments/`;
const HOME_STORAGE_KEY = 'browser-port-experiments:home-url';
const WISP_STORAGE_KEY = 'browser-port-experiments:wisp-url';

let previewProcess;
let browser;

function findChromiumExecutable() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    process.env.CHROME_BIN,
    process.env.CHROMIUM_BIN,
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate));
}

function startPreview() {
  const viteBin = new URL('../node_modules/vite/bin/vite.js', import.meta.url);
  const child = spawn(
    process.execPath,
    [viteBin.pathname, 'preview', '--host', HOST, '--port', String(PORT), '--strictPort'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  child.stdout.on('data', (chunk) => process.stdout.write(`[vite preview] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[vite preview] ${chunk}`));
  return child;
}

async function waitForPreview() {
  const deadline = Date.now() + 20_000;
  let lastError;

  while (Date.now() < deadline) {
    if (previewProcess.exitCode !== null) {
      throw new Error(`vite preview exited early with code ${previewProcess.exitCode}`);
    }

    try {
      const response = await fetch(APP_URL);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for vite preview at ${APP_URL}: ${lastError?.message ?? 'unknown error'}`);
}

async function newAppPage() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(
    ({ homeKey, homeValue, wispKey, wispValue }) => {
      localStorage.setItem(homeKey, homeValue);
      localStorage.setItem(wispKey, wispValue);
    },
    {
      homeKey: HOME_STORAGE_KEY,
      homeValue: 'about:blank',
      wispKey: WISP_STORAGE_KEY,
      wispValue: DEFAULT_WISP_URL,
    },
  );
  return context.newPage();
}

async function closePage(page) {
  await page.context().close();
}

before(async () => {
  previewProcess = startPreview();
  await Promise.race([
    waitForPreview(),
    once(previewProcess, 'exit').then(([code]) => {
      throw new Error(`vite preview exited before becoming ready with code ${code}`);
    }),
  ]);

  const executablePath = findChromiumExecutable();
  if (!executablePath) {
    throw new Error(
      'No Chromium executable found. Install chromium, set PLAYWRIGHT_CHROMIUM_EXECUTABLE, or run this test in the GitHub Actions Ubuntu image.',
    );
  }

  browser = await chromium.launch({ executablePath, headless: true });
});

after(async () => {
  await browser?.close();
  if (previewProcess && previewProcess.exitCode === null) {
    previewProcess.kill('SIGTERM');
    await Promise.race([
      once(previewProcess, 'exit'),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    if (previewProcess.exitCode === null) previewProcess.kill('SIGKILL');
  }
});

test('root page renders registry launch links and work queue', { timeout: 15_000 }, async () => {
  const page = await newAppPage();
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });

    await page.getByRole('heading', { name: /useful browser ports/i }).waitFor({ state: 'visible' });
    await page.getByRole('heading', { name: 'Available browsers' }).waitFor({ state: 'visible' });
    await page.getByRole('heading', { name: 'Orchestrated work queue' }).waitFor({ state: 'visible' });

    const cards = page.locator('.card');
    await cards.first().waitFor({ state: 'visible' });
    assert.equal(await cards.count(), browsers.length);

    for (const registeredBrowser of browsers) {
      await page.getByRole('heading', { name: registeredBrowser.name }).waitFor({ state: 'visible' });
      const launchLinks = page.locator(`a[href="${registeredBrowser.path}"]`);
      assert.ok(await launchLinks.count(), `expected a launch link for ${registeredBrowser.id}`);
    }
  } finally {
    await closePage(page);
  }
});

test('NetSurf public page paints live full-framebuffer pixels', { timeout: 20_000 }, async () => {
  const page = await newAppPage();
  try {
    await page.goto(`${APP_URL}browsers/netsurf/`, { waitUntil: 'domcontentloaded' });
    await page.locator('body[data-netsurf-framebuffer-visible="true"]').waitFor({ state: 'attached' });
    await page.locator('#viewport').waitFor({ state: 'visible' });

    const canvasLocator = page.locator('#viewport');
    await canvasLocator.click({ position: { x: 32, y: 32 } });
    await page.keyboard.press('a');

    const result = await page.evaluate(() => {
      const canvas = document.querySelector('#viewport');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let opaque = 0;
      let nonWhite = 0;
      let nonBlack = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 255) opaque += 1;
        if (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245) nonWhite += 1;
        if (data[i] > 8 || data[i + 1] > 8 || data[i + 2] > 8) nonBlack += 1;
      }
      return {
        width: canvas.width,
        height: canvas.height,
        opaque,
        nonWhite,
        nonBlack,
        status: document.querySelector('#status')?.textContent ?? '',
        presenter: document.body.dataset.netsurfFramebufferPresenter,
        surface: document.body.dataset.netsurfFramebufferSurface,
        stride: Number(document.body.dataset.netsurfFramebufferStride),
        state: window.netsurfFramebufferState,
        metadata: document.querySelector('#metadata')?.textContent ?? '',
        inputDataset: document.body.dataset.netsurfFramebufferInput,
        canvasTabIndex: canvas.tabIndex,
      };
    });

    assert.equal(result.width, 640);
    assert.equal(result.height, 480);
    assert.match(result.status, /live NetSurf framebuffer/i);
    assert.equal(result.presenter, 'full-frame-poll');
    assert.equal(result.surface, 'frontend-nsfb-ram');
    assert.equal(result.stride, 2560);
    assert.equal(result.state.presenter, 'full-frame-poll');
    assert.equal(result.state.surface, 'full NetSurf framebuffer frontend nsfb_t RAM surface');
    assert.match(result.inputDataset, /^(js-canvas-capture-only|fbtk-event-queue)$/);
    assert.equal(result.canvasTabIndex, 0);
    assert.ok(result.state.inputEventsCaptured >= 2, `expected canvas input events to be captured, got ${JSON.stringify(result)}`);
    assert.ok(result.state.inputEventsForwarded >= 0, `expected input forwarding counter, got ${JSON.stringify(result)}`);
    assert.ok(result.state.ptr > 0, `expected exported nsfb_t buffer pointer, got ${JSON.stringify(result)}`);
    assert.ok(result.state.framesCopied >= 1, `expected copied frames, got ${JSON.stringify(result)}`);
    assert.match(result.metadata, /BrowserPortWisp|standalone offline page/i);
    assert.ok(result.opaque > 250_000, `expected opaque NetSurf framebuffer, got ${JSON.stringify(result)}`);
    assert.ok(result.nonWhite > 1_000, `expected browser chrome/content contrast, got ${JSON.stringify(result)}`);
    assert.ok(result.nonBlack > 1_000, `expected non-empty NetSurf pixels, got ${JSON.stringify(result)}`);
  } finally {
    await closePage(page);
  }
});

for (const registeredBrowser of browsers) {
  test(`browser route starts UI for ${registeredBrowser.id}`, { timeout: 15_000 }, async () => {
    const page = await newAppPage();
    try {
      await page.goto(`${APP_URL}${registeredBrowser.path}`, { waitUntil: 'domcontentloaded' });

      await page.locator('.browser-toolbar').waitFor({ state: 'visible' });
      await page.locator('.engine-layout').waitFor({ state: 'visible' });
      await page.locator('.engine-info').getByRole('heading', { name: registeredBrowser.name }).waitFor({ state: 'visible' });

      for (const selector of ['#back', '#forward', '#reload', '#home', '#url-form', '#save-settings']) {
        await page.locator(selector).waitFor({ state: 'visible' });
      }

      await assertInputValue(page.locator('#url-input'), 'about:blank');
      await assertInputValue(page.locator('#wisp-input'), DEFAULT_WISP_URL);

      const frame = page.locator('#browser-frame');
      await frame.waitFor({ state: 'visible' });
      assert.equal(await frame.getAttribute('title'), `${registeredBrowser.name} viewport`);
      assert.equal(await frame.getAttribute('src'), 'about:blank');
    } finally {
      await closePage(page);
    }
  });
}

async function assertInputValue(locator, expectedValue) {
  await locator.waitFor({ state: 'visible' });
  assert.equal(await locator.inputValue(), expectedValue);
}
