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

test('NetSurf public canvas probe paints non-empty framebuffer pixels', { timeout: 15_000 }, async () => {
  const page = await newAppPage();
  try {
    await page.goto(`${APP_URL}browsers/netsurf/`, { waitUntil: 'domcontentloaded' });
    await page.locator('body[data-netsurf-canvas-visible="true"]').waitFor({ state: 'attached' });
    await page.locator('#viewport').waitFor({ state: 'visible' });

    const sample = await page.evaluate(() => {
      const canvas = document.querySelector('#viewport');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const points = [
        ctx.getImageData(48, 48, 1, 1).data,
        ctx.getImageData(220, 60, 1, 1).data,
        ctx.getImageData(360, 60, 1, 1).data,
      ].map((data) => Array.from(data));
      return points;
    });

    assert.ok(sample.every((rgba) => rgba[3] === 255), `expected opaque framebuffer samples, got ${JSON.stringify(sample)}`);
    assert.notDeepEqual(sample[0].slice(0, 3), sample[1].slice(0, 3), 'expected varied colours from libnsfb render');
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
