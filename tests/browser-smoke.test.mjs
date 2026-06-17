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

async function netSurfCanvasCssPosition(canvasLocator, x, y) {
  const box = await canvasLocator.boundingBox();
  if (!box) throw new Error('NetSurf canvas is not visible');
  const canvasSize = await canvasLocator.evaluate((canvas) => ({ width: canvas.width, height: canvas.height }));
  return {
    x: x * box.width / canvasSize.width,
    y: y * box.height / canvasSize.height,
  };
}

async function clickNetSurfCanvasPixel(canvasLocator, x, y) {
  await canvasLocator.click({ position: await netSurfCanvasCssPosition(canvasLocator, x, y) });
}

async function hoverNetSurfCanvasPixel(canvasLocator, x, y) {
  await canvasLocator.hover({ position: await netSurfCanvasCssPosition(canvasLocator, x, y) });
}

async function readNetSurfRegionMetrics(page, region) {
  return page.evaluate(({ x, y, width, height }) => {
    const canvas = document.querySelector('#viewport');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const { data } = ctx.getImageData(x, y, width, height);
    let black = 0;
    let nonGrey = 0;
    let nonWhite = 0;
    let hash = 0;
    for (let i = 0; i < data.length; i += 4) {
      const red = data[i];
      const green = data[i + 1];
      const blue = data[i + 2];
      if (red < 16 && green < 16 && blue < 16) black += 1;
      if (!(red === 221 && green === 221 && blue === 221)) nonGrey += 1;
      if (red < 245 || green < 245 || blue < 245) nonWhite += 1;
      hash = (hash * 31 + red * 3 + green * 5 + blue * 7) >>> 0;
    }
    return { black, nonGrey, nonWhite, hash };
  }, region);
}

async function readNetSurfStatusBarMetrics(page) {
  return readNetSurfRegionMetrics(page, { x: 0, y: 462, width: 200, height: 18 });
}

async function readNetSurfAddressBarMetrics(page) {
  return readNetSurfRegionMetrics(page, { x: 95, y: 3, width: 520, height: 28 });
}

async function waitForNetSurfRegionMetrics(page, expected, beforeDirtyRects) {
  return page.waitForFunction(
    ({ expectedMetrics, minimumDirtyRects }) => {
      const state = window.netsurfFramebufferState;
      if (!state || state.dirtyRectsObserved <= minimumDirtyRects) return null;
      const canvas = document.querySelector('#viewport');
      if (!canvas) return null;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const metricsFor = ({ x, y, width, height }) => {
        const { data } = ctx.getImageData(x, y, width, height);
        let black = 0;
        let nonGrey = 0;
        let nonWhite = 0;
        let hash = 0;
        for (let i = 0; i < data.length; i += 4) {
          const red = data[i];
          const green = data[i + 1];
          const blue = data[i + 2];
          if (red < 16 && green < 16 && blue < 16) black += 1;
          if (!(red === 221 && green === 221 && blue === 221)) nonGrey += 1;
          if (red < 245 || green < 245 || blue < 245) nonWhite += 1;
          hash = (hash * 31 + red * 3 + green * 5 + blue * 7) >>> 0;
        }
        return { black, nonGrey, nonWhite, hash };
      };
      const metrics = Object.fromEntries(
        Object.entries(expectedMetrics).map(([name, expected]) => [name, metricsFor(expected.region)]),
      );
      const stable = Object.entries(expectedMetrics).every(([name, expected]) => (
        Object.entries(expected.metrics).every(([key, value]) => metrics[name][key] === value)
      ));
      return stable ? {
        dirtyRectsObserved: state.dirtyRectsObserved,
        inputEventsForwarded: state.inputEventsForwarded,
        inputEventsDelivered: state.inputEventsDelivered,
        inputEventsDropped: state.inputEventsDropped,
        lastInputEvent: state.lastInputEvent,
        cursor: state.cursor,
        metrics,
        dataset: document.body.dataset.netsurfFramebufferLastInput,
        activeElementId: document.activeElement?.id,
      } : null;
    },
    { expectedMetrics: expected, minimumDirtyRects: beforeDirtyRects },
    { timeout: 10_000 },
  ).then((handle) => handle.jsonValue());
}

async function waitForNetSurfToolbarNavigationMetrics(page, expected, beforeDirtyRects) {
  return page.waitForFunction(
    ({ expectedMetrics, minimumDirtyRects }) => {
      const state = window.netsurfFramebufferState;
      if (!state || state.dirtyRectsObserved <= minimumDirtyRects) return null;
      const canvas = document.querySelector('#viewport');
      if (!canvas) return null;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const metricsFor = ({ x, y, width, height }) => {
        const { data } = ctx.getImageData(x, y, width, height);
        let black = 0;
        let nonGrey = 0;
        let nonWhite = 0;
        let hash = 0;
        for (let i = 0; i < data.length; i += 4) {
          const red = data[i];
          const green = data[i + 1];
          const blue = data[i + 2];
          if (red < 16 && green < 16 && blue < 16) black += 1;
          if (!(red === 221 && green === 221 && blue === 221)) nonGrey += 1;
          if (red < 245 || green < 245 || blue < 245) nonWhite += 1;
          hash = (hash * 31 + red * 3 + green * 5 + blue * 7) >>> 0;
        }
        return { black, nonGrey, nonWhite, hash };
      };
      const regions = {
        toolbar: { x: 0, y: 0, width: 95, height: 36 },
        address: { x: 95, y: 3, width: 520, height: 28 },
        status: { x: 0, y: 462, width: 620, height: 18 },
        content: { x: 0, y: 36, width: 640, height: 426 },
        logo: { x: 15, y: 118, width: 570, height: 45 },
      };
      const metrics = Object.fromEntries(
        Object.entries(regions).map(([name, region]) => [name, metricsFor(region)]),
      );
      const stable = Object.entries(expectedMetrics).every(([name, expectedMetric]) => (
        Object.entries(expectedMetric).every(([key, value]) => metrics[name][key] === value)
      ));
      return stable ? {
        dirtyRectsObserved: state.dirtyRectsObserved,
        inputEventsForwarded: state.inputEventsForwarded,
        inputEventsDelivered: state.inputEventsDelivered,
        lastInputEvent: state.lastInputEvent,
        metrics,
      } : null;
    },
    { expectedMetrics: expected, minimumDirtyRects: beforeDirtyRects },
    { timeout: 10_000 },
  ).then((handle) => handle.jsonValue());
}

async function waitForNetSurfVisibleTextSignatures(page) {
  return page.waitForFunction(() => {
    const canvas = document.querySelector('#viewport');
    if (!canvas) return null;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

    const darkGlyphSignatures = {
      toolbarChrome: { x: 0, y: 0, width: 95, height: 36, expectedCount: 262, expectedHash: 1066696110 },
      addressChrome: { x: 95, y: 3, width: 520, height: 28, expectedCount: 1607, expectedHash: 460374291 },
      welcomeHeading: { x: 35, y: 188, width: 330, height: 44, expectedCount: 3164, expectedHash: 1554281271 },
      welcomeBodyCopy: { x: 35, y: 230, width: 530, height: 84, expectedCount: 5197, expectedHash: 4192242756 },
    };
    const colorBitmapSignatures = {
      toolbarIconBitmaps: { x: 0, y: 0, width: 95, height: 30, expectedCount: 265, expectedHash: 3910769378, predicate: 'saturatedChrome' },
      welcomeLogoBitmap: { x: 15, y: 118, width: 570, height: 45, expectedCount: 3287, expectedHash: 736990473, predicate: 'netsurfBlue' },
    };

    const groups = (items) => {
      const result = [];
      for (const item of items) {
        if (!result.length || item[0] > result[result.length - 1][result[result.length - 1].length - 1][0] + 1) {
          result.push([]);
        }
        result[result.length - 1].push(item);
      }
      return result.map((group) => [
        group[0][0],
        group[group.length - 1][0],
        group.reduce((sum, value) => sum + value[1], 0),
        Math.max(...group.map((value) => value[1])),
      ]);
    };

    const signatureForPredicate = ({ x, y, width, height }, predicate, includeRgbInHash = false) => {
      const rowCounts = [];
      const colCounts = [];
      let count = 0;
      let hash = 2166136261 >>> 0;
      for (let yy = y; yy < y + height; yy += 1) {
        let rowCount = 0;
        for (let xx = x; xx < x + width; xx += 1) {
          const offset = (yy * canvas.width + xx) * 4;
          const red = image[offset];
          const green = image[offset + 1];
          const blue = image[offset + 2];
          if (predicate(red, green, blue)) {
            rowCount += 1;
            count += 1;
            const colorHash = includeRgbInHash ? red ^ (green << 8) ^ (blue << 16) : 0;
            hash = (Math.imul(hash, 16777619) ^ ((xx - x) * 13) ^ ((yy - y) * 17) ^ colorHash) >>> 0;
          }
        }
        if (rowCount) rowCounts.push([yy, rowCount]);
      }
      for (let xx = x; xx < x + width; xx += 1) {
        let colCount = 0;
        for (let yy = y; yy < y + height; yy += 1) {
          const offset = (yy * canvas.width + xx) * 4;
          if (predicate(image[offset], image[offset + 1], image[offset + 2])) colCount += 1;
        }
        if (colCount) colCounts.push([xx, colCount]);
      }
      return { x, y, width, height, count, hash, rowBands: groups(rowCounts), colBands: groups(colCounts) };
    };

    const darkGlyph = (red, green, blue) => {
      // NetSurf's default bitmap font draws black headings/chrome and #666
      // body copy. Threshold just those glyph strokes, not the blue
      // about:welcome panels or white body background.
      return red <= 110 && green <= 110 && blue <= 110;
    };
    const colorPredicates = {
      saturatedChrome: (red, green, blue) => Math.max(red, green, blue) - Math.min(red, green, blue) > 30 && !(red === 221 && green === 221 && blue === 221),
      netsurfBlue: (red, green, blue) => blue > 120 && red < 120 && green < 180 && blue > red + 40 && blue > green + 20,
    };
    const signatureFor = (region) => signatureForPredicate(region, darkGlyph);
    const colorSignatureFor = (region) => signatureForPredicate(region, colorPredicates[region.predicate], true);

    const signatures = {
      ...Object.fromEntries(
        Object.entries(darkGlyphSignatures).map(([name, region]) => [name, signatureFor(region)]),
      ),
      ...Object.fromEntries(
        Object.entries(colorBitmapSignatures).map(([name, region]) => [name, colorSignatureFor(region)]),
      ),
    };
    const stableGlyphs = Object.entries(darkGlyphSignatures).every(([name, expected]) => (
      signatures[name].count === expected.expectedCount && signatures[name].hash === expected.expectedHash
    ));
    const stableBitmaps = Object.entries(colorBitmapSignatures).every(([name, expected]) => (
      signatures[name].count === expected.expectedCount && signatures[name].hash === expected.expectedHash
    ));
    return stableGlyphs && stableBitmaps ? signatures : null;
  }, null, { timeout: 15_000 }).then((handle) => handle.jsonValue());
}

async function waitForNetSurfWelcomeScrollSignatures(page, expected, beforeDirtyRects) {
  return page.waitForFunction(
    ({ expectedSignatures, minimumDirtyRects }) => {
      const state = window.netsurfFramebufferState;
      if (!state || state.dirtyRectsObserved <= minimumDirtyRects) return null;
      const canvas = document.querySelector('#viewport');
      if (!canvas) return null;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

      const groups = (items) => {
        const result = [];
        for (const item of items) {
          if (!result.length || item[0] > result[result.length - 1][result[result.length - 1].length - 1][0] + 1) {
            result.push([]);
          }
          result[result.length - 1].push(item);
        }
        return result.map((group) => [
          group[0][0],
          group[group.length - 1][0],
          group.reduce((sum, value) => sum + value[1], 0),
          Math.max(...group.map((value) => value[1])),
        ]);
      };

      const darkGlyph = (red, green, blue) => red <= 110 && green <= 110 && blue <= 110;
      const blueLinkGlyph = (red, green, blue) => blue > 120 && red < 120 && green < 180 && blue > red + 40 && blue > green + 20;
      const scrollbarChrome = (red, green, blue) => !(red === 255 && green === 255 && blue === 255) && !(red === 221 && green === 221 && blue === 221);
      const predicates = { darkGlyph, blueLinkGlyph, scrollbarChrome };
      const signatureFor = ({ x, y, width, height, predicate }) => {
        const testPixel = predicates[predicate];
        const rowCounts = [];
        const colCounts = [];
        let count = 0;
        let hash = 2166136261 >>> 0;
        for (let yy = y; yy < y + height; yy += 1) {
          let rowCount = 0;
          for (let xx = x; xx < x + width; xx += 1) {
            const offset = (yy * canvas.width + xx) * 4;
            const red = image[offset];
            const green = image[offset + 1];
            const blue = image[offset + 2];
            if (testPixel(red, green, blue)) {
              rowCount += 1;
              count += 1;
              const colorHash = predicate === 'blueLinkGlyph' || predicate === 'scrollbarChrome' ? red ^ (green << 8) ^ (blue << 16) : 0;
              hash = (Math.imul(hash, 16777619) ^ ((xx - x) * 13) ^ ((yy - y) * 17) ^ colorHash) >>> 0;
            }
          }
          if (rowCount) rowCounts.push([yy, rowCount]);
        }
        for (let xx = x; xx < x + width; xx += 1) {
          let colCount = 0;
          for (let yy = y; yy < y + height; yy += 1) {
            const offset = (yy * canvas.width + xx) * 4;
            if (testPixel(image[offset], image[offset + 1], image[offset + 2])) colCount += 1;
          }
          if (colCount) colCounts.push([xx, colCount]);
        }
        return { x, y, width, height, count, hash, rowBands: groups(rowCounts), colBands: groups(colCounts) };
      };

      const signatures = Object.fromEntries(
        Object.entries(expectedSignatures).map(([name, region]) => [name, signatureFor(region)]),
      );
      const stable = Object.entries(expectedSignatures).every(([name, expected]) => (
        signatures[name].count === expected.expectedCount && signatures[name].hash === expected.expectedHash
      ));
      return stable ? { dirtyRectsObserved: state.dirtyRectsObserved, signatures } : null;
    },
    { expectedSignatures: expected, minimumDirtyRects: beforeDirtyRects },
    { timeout: 10_000 },
  ).then((handle) => handle.jsonValue());
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

test('NetSurf public page paints deterministic dirty-rect framebuffer pixels', { timeout: 40_000 }, async () => {
  const page = await newAppPage();
  try {
    await page.goto(`${APP_URL}browsers/netsurf/`, { waitUntil: 'domcontentloaded' });
    await page.locator('body[data-netsurf-framebuffer-visible="true"]').waitFor({ state: 'attached' });
    await page.locator('#viewport').waitFor({ state: 'visible' });
    await page.waitForFunction(() => window.netsurfFramebufferState?.cursor && document.body.dataset.netsurfFramebufferCursor);
    await page.locator('body[data-netsurf-resources-packaged="true"]').waitFor({ state: 'attached' });
    const textSignatures = await waitForNetSurfVisibleTextSignatures(page);

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
      const pixelAt = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
      return {
        width: canvas.width,
        height: canvas.height,
        opaque,
        nonWhite,
        nonBlack,
        topChrome: pixelAt(5, 5),
        toolbarIcon: pixelAt(40, 20),
        urlChrome: pixelAt(120, 20),
        blankPage: pixelAt(320, 240),
        status: document.querySelector('#status')?.textContent ?? '',
        log: document.querySelector('#log')?.textContent ?? '',
        resourceText: document.body.dataset.netsurfResourceText || '',
        resourcePackage: window.netsurfFramebufferState.resourcePackage,
        presenter: document.body.dataset.netsurfFramebufferPresenter,
        surface: document.body.dataset.netsurfFramebufferSurface,
        stride: Number(document.body.dataset.netsurfFramebufferStride),
        state: window.netsurfFramebufferState,
        metadata: document.querySelector('#metadata')?.textContent ?? '',
        inputDataset: document.body.dataset.netsurfFramebufferInput,
        canvasTabIndex: canvas.tabIndex,
        dirtyRectCount: Number(canvas.dataset.dirtyRectCount || 0),
        dirtyRectCallbacks: Number(canvas.dataset.dirtyRectCallbacks || 0),
        cursorDataset: document.body.dataset.netsurfFramebufferCursor,
      };
    });

    assert.equal(result.width, 640);
    assert.equal(result.height, 480);
    assert.match(result.status, /dirty-rect updates/i);
    assert.equal(result.presenter, 'libnsfb-dirty-rect');
    assert.equal(result.surface, 'libnsfb-emscripten');
    assert.equal(result.stride, 2560);
    assert.equal(result.state.presenter, 'libnsfb-dirty-rect');
    assert.equal(result.state.surface, 'libnsfb emscripten nsfb_t surface');
    assert.equal(result.inputDataset, 'fbtk-event-queue');
    assert.equal(result.canvasTabIndex, 0);
    assert.equal(result.state.inputEventsDropped, 0, `expected no dropped libnsfb input events before interaction, got ${JSON.stringify(result)}`);
    assert.ok(result.state.ptr > 0, `expected exported nsfb_t buffer pointer, got ${JSON.stringify(result)}`);
    assert.ok(result.dirtyRectCount > 0, `expected at least one NetSurf dirty rect, got ${JSON.stringify(result)}`);
    assert.ok(result.state.dirtyRectsObserved > 0, `expected dirty rect state, got ${JSON.stringify(result)}`);
    assert.ok(result.state.dirtyRectCallbacksObserved >= result.state.dirtyRectsObserved, `expected dirty rect callback accounting, got ${JSON.stringify(result)}`);
    assert.ok(result.dirtyRectCallbacks >= result.dirtyRectCount, `expected canvas dirty rect callback accounting, got ${JSON.stringify(result)}`);
    assert.match(result.metadata, /BrowserPortWisp|standalone offline page/i);
    assert.match(result.metadata, /embedded \/netsurf resources loaded/i);
    assert.equal(result.resourcePackage.status, 'embedded /netsurf resources loaded');
    assert.ok(result.resourcePackage.messagesBytes > 10_000, `expected embedded English Messages, got ${JSON.stringify(result.resourcePackage)}`);
    assert.ok(result.resourcePackage.defaultCssBytes > 1_000, `expected embedded default.css, got ${JSON.stringify(result.resourcePackage)}`);
    assert.ok(result.resourcePackage.welcomeBytes > 1_000, `expected embedded about:welcome HTML, got ${JSON.stringify(result.resourcePackage)}`);
    assert.match(result.resourceText, /NetSurf\|Back[^|]*\|Reload\|Welcome to NetSurf/);
    assert.deepEqual(
      {
        toolbarChrome: { count: textSignatures.toolbarChrome.count, hash: textSignatures.toolbarChrome.hash, rowBands: textSignatures.toolbarChrome.rowBands, colBandCount: textSignatures.toolbarChrome.colBands.length },
        addressChrome: { count: textSignatures.addressChrome.count, hash: textSignatures.addressChrome.hash, rowBands: textSignatures.addressChrome.rowBands, colBandCount: textSignatures.addressChrome.colBands.length },
        welcomeHeading: { count: textSignatures.welcomeHeading.count, hash: textSignatures.welcomeHeading.hash, rowBands: textSignatures.welcomeHeading.rowBands, colBandCount: textSignatures.welcomeHeading.colBands.length },
        welcomeBodyCopy: { count: textSignatures.welcomeBodyCopy.count, hash: textSignatures.welcomeBodyCopy.hash, rowBands: textSignatures.welcomeBodyCopy.rowBands, colBandCount: textSignatures.welcomeBodyCopy.colBands.length },
        toolbarIconBitmaps: { count: textSignatures.toolbarIconBitmaps.count, hash: textSignatures.toolbarIconBitmaps.hash, rowBands: textSignatures.toolbarIconBitmaps.rowBands, colBands: textSignatures.toolbarIconBitmaps.colBands },
        welcomeLogoBitmap: { count: textSignatures.welcomeLogoBitmap.count, hash: textSignatures.welcomeLogoBitmap.hash, rowBands: textSignatures.welcomeLogoBitmap.rowBands, colBands: textSignatures.welcomeLogoBitmap.colBands },
      },
      {
        toolbarChrome: { count: 262, hash: 1066696110, rowBands: [[4, 25, 262, 24]], colBandCount: 2 },
        addressChrome: { count: 1607, hash: 460374291, rowBands: [[3, 27, 1607, 451]], colBandCount: 3 },
        welcomeHeading: { count: 3164, hash: 1554281271, rowBands: [[196, 219, 3164, 202]], colBandCount: 16 },
        welcomeBodyCopy: { count: 5197, hash: 4192242756, rowBands: [[247, 261, 1996, 294], [268, 282, 1911, 300], [289, 303, 1290, 197]], colBandCount: 64 },
        toolbarIconBitmaps: { count: 265, hash: 3910769378, rowBands: [[5, 24, 265, 21]], colBands: [[29, 34, 48, 8], [43, 48, 72, 12], [82, 94, 145, 14]] },
        welcomeLogoBitmap: { count: 3287, hash: 736990473, rowBands: [[123, 156, 3287, 365]], colBands: [[19, 114, 698, 26], [140, 243, 612, 13], [284, 403, 1021, 24], [487, 574, 956, 22]] },
      },
      `expected deterministic visible NetSurf chrome/about:welcome glyph and bitmap coverage, got ${JSON.stringify(textSignatures)}`,
    );
    assert.doesNotMatch(result.log, /Message translations failed to load|Unable to open Messages|Unable to find resource|Invalid UTF-8/i);
    assert.ok(result.state.cursor, `expected deterministic libnsfb cursor callback metadata, got ${JSON.stringify(result)}`);
    assert.equal(result.cursorDataset, result.state.cursor.rect.join(','));
    assert.equal(result.state.cursor.rect.length, 4);
    assert.equal(result.state.cursor.hotspot.length, 2);
    assert.ok(result.state.cursor.rect[2] > result.state.cursor.rect[0], `expected positive cursor width, got ${JSON.stringify(result)}`);
    assert.ok(result.state.cursor.rect[3] > result.state.cursor.rect[1], `expected positive cursor height, got ${JSON.stringify(result)}`);
    assert.match(result.metadata, /Cursor hook\d+,\d+,\d+,\d+ hotspot \d+,\d+/);
    assert.ok(result.opaque > 250_000, `expected opaque NetSurf framebuffer, got ${JSON.stringify(result)}`);
    assert.ok(result.nonWhite > 1_000, `expected browser chrome/content contrast, got ${JSON.stringify(result)}`);
    assert.ok(result.nonBlack > 1_000, `expected non-empty NetSurf pixels, got ${JSON.stringify(result)}`);
    assert.deepEqual(result.topChrome, [221, 221, 221, 255], `expected deterministic NetSurf top chrome pixel, got ${JSON.stringify(result)}`);
    assert.deepEqual(result.toolbarIcon, [42, 42, 42, 255], `expected deterministic NetSurf toolbar icon pixel, got ${JSON.stringify(result)}`);
    assert.deepEqual(result.urlChrome, [76, 76, 204, 255], `expected deterministic NetSurf URL bar chrome pixel, got ${JSON.stringify(result)}`);
    assert.deepEqual(result.blankPage, [255, 255, 255, 255], `expected deterministic about:blank content pixel, got ${JSON.stringify(result)}`);

    const canvasLocator = page.locator('#viewport');
    const beforeToolbarBackDirtyRects = result.state.dirtyRectsObserved;
    await clickNetSurfCanvasPixel(canvasLocator, 30, 15);
    const toolbarBackNavigation = await waitForNetSurfToolbarNavigationMetrics(
      page,
      {
        toolbar: { black: 46, nonGrey: 3420, nonWhite: 3420, hash: 2020031204 },
        address: { black: 0, nonGrey: 14560, nonWhite: 14560, hash: 1016345560 },
        status: { black: 0, nonGrey: 3860, nonWhite: 11160, hash: 1827365023 },
        content: { black: 596, nonGrey: 267611, nonWhite: 266865, hash: 651458069 },
        logo: { black: 175, nonGrey: 25650, nonWhite: 25650, hash: 1841983218 },
      },
      beforeToolbarBackDirtyRects,
    );
    assert.equal(toolbarBackNavigation.lastInputEvent.type, 'pointerup-button');
    assert.deepEqual(toolbarBackNavigation.lastInputEvent.detail, { button: 0 });
    assert.ok(toolbarBackNavigation.inputEventsForwarded >= result.state.inputEventsForwarded + 3, `expected toolbar back click forwarding, got ${JSON.stringify(toolbarBackNavigation)}`);
    assert.deepEqual(
      toolbarBackNavigation.metrics,
      {
        toolbar: { black: 46, nonGrey: 3420, nonWhite: 3420, hash: 2020031204 },
        address: { black: 0, nonGrey: 14560, nonWhite: 14560, hash: 1016345560 },
        status: { black: 0, nonGrey: 3860, nonWhite: 11160, hash: 1827365023 },
        content: { black: 596, nonGrey: 267611, nonWhite: 266865, hash: 651458069 },
        logo: { black: 175, nonGrey: 25650, nonWhite: 25650, hash: 1841983218 },
      },
      `expected NetSurf toolbar Back action to visibly navigate away from about:welcome chrome/status/content/logo rasters, got ${JSON.stringify(toolbarBackNavigation)}`,
    );

    await clickNetSurfCanvasPixel(canvasLocator, 45, 15);
    const toolbarForwardRestoredSignatures = await waitForNetSurfVisibleTextSignatures(page);
    assert.deepEqual(
      {
        toolbarChrome: { count: toolbarForwardRestoredSignatures.toolbarChrome.count, hash: toolbarForwardRestoredSignatures.toolbarChrome.hash },
        addressChrome: { count: toolbarForwardRestoredSignatures.addressChrome.count, hash: toolbarForwardRestoredSignatures.addressChrome.hash },
        welcomeLogoBitmap: { count: toolbarForwardRestoredSignatures.welcomeLogoBitmap.count, hash: toolbarForwardRestoredSignatures.welcomeLogoBitmap.hash },
      },
      {
        toolbarChrome: { count: 262, hash: 1066696110 },
        addressChrome: { count: 1607, hash: 460374291 },
        welcomeLogoBitmap: { count: 3287, hash: 736990473 },
      },
      `expected NetSurf toolbar Forward action to visibly restore about:welcome, got ${JSON.stringify(toolbarForwardRestoredSignatures)}`,
    );
    assert.ok(
      (await page.evaluate(() => window.netsurfFramebufferState.dirtyRectsObserved)) > toolbarBackNavigation.dirtyRectsObserved,
      `expected toolbar forward restore to preserve dirty-rect advancement, got ${JSON.stringify(toolbarBackNavigation)}`,
    );
    const toolbarForwardRestoredRasterMetrics = {
      status: await readNetSurfRegionMetrics(page, { x: 0, y: 462, width: 620, height: 18 }),
      content: await readNetSurfRegionMetrics(page, { x: 0, y: 36, width: 640, height: 426 }),
      logo: await readNetSurfRegionMetrics(page, { x: 15, y: 118, width: 570, height: 45 }),
    };
    assert.deepEqual(
      toolbarForwardRestoredRasterMetrics,
      {
        status: { black: 404, nonGrey: 1708, nonWhite: 11160, hash: 3968113013 },
        content: { black: 1808, nonGrey: 268532, nonWhite: 135133, hash: 4161839195 },
        logo: { black: 0, nonGrey: 25650, nonWhite: 24510, hash: 1950299052 },
      },
      `expected toolbar Forward to restore deterministic about:welcome status/content/logo rasters, got ${JSON.stringify(toolbarForwardRestoredRasterMetrics)}`,
    );

    const stableAboutWelcomeChromeMetrics = {
      toolbar: {
        region: { x: 0, y: 0, width: 95, height: 36 },
        metrics: { black: 145, nonGrey: 1804, nonWhite: 3420, hash: 2787099418 },
      },
      address: {
        region: { x: 95, y: 3, width: 520, height: 28 },
        metrics: { black: 1503, nonGrey: 12610, nonWhite: 4649, hash: 1458272501 },
      },
      status: {
        region: { x: 0, y: 462, width: 620, height: 18 },
        metrics: { black: 404, nonGrey: 1708, nonWhite: 11160, hash: 3968113013 },
      },
      content: {
        region: { x: 0, y: 36, width: 640, height: 426 },
        metrics: { black: 1808, nonGrey: 268532, nonWhite: 135133, hash: 4161839195 },
      },
      logo: {
        region: { x: 15, y: 118, width: 570, height: 45 },
        metrics: { black: 0, nonGrey: 25650, nonWhite: 24510, hash: 1950299052 },
      },
    };

    const beforeReloadClick = await page.evaluate(() => ({
      dirtyRectsObserved: window.netsurfFramebufferState.dirtyRectsObserved,
      inputEventsForwarded: window.netsurfFramebufferState.inputEventsForwarded,
    }));
    await clickNetSurfCanvasPixel(canvasLocator, 62, 15);
    const toolbarReloadStableChrome = await waitForNetSurfRegionMetrics(
      page,
      stableAboutWelcomeChromeMetrics,
      beforeReloadClick.dirtyRectsObserved,
    );
    assert.equal(toolbarReloadStableChrome.lastInputEvent.type, 'pointerup-button');
    assert.deepEqual(toolbarReloadStableChrome.lastInputEvent.detail, { button: 0 });
    assert.ok(toolbarReloadStableChrome.inputEventsForwarded >= beforeReloadClick.inputEventsForwarded + 3, `expected toolbar Reload click forwarding, got ${JSON.stringify(toolbarReloadStableChrome)}`);
    assert.deepEqual(toolbarReloadStableChrome.cursor.hotspot, [4, 0], `expected toolbar Reload to expose NetSurf's hand cursor, got ${JSON.stringify(toolbarReloadStableChrome)}`);
    assert.deepEqual(
      toolbarReloadStableChrome.metrics,
      Object.fromEntries(Object.entries(stableAboutWelcomeChromeMetrics).map(([name, expected]) => [name, expected.metrics])),
      `expected toolbar Reload to preserve deterministic about:welcome chrome/status/content rasters, got ${JSON.stringify(toolbarReloadStableChrome)}`,
    );

    const beforeHomeClick = await page.evaluate(() => ({
      dirtyRectsObserved: window.netsurfFramebufferState.dirtyRectsObserved,
      inputEventsForwarded: window.netsurfFramebufferState.inputEventsForwarded,
    }));
    await clickNetSurfCanvasPixel(canvasLocator, 85, 15);
    const toolbarHomeStableChrome = await waitForNetSurfRegionMetrics(
      page,
      stableAboutWelcomeChromeMetrics,
      beforeHomeClick.dirtyRectsObserved,
    );
    assert.equal(toolbarHomeStableChrome.lastInputEvent.type, 'pointerup-button');
    assert.deepEqual(toolbarHomeStableChrome.lastInputEvent.detail, { button: 0 });
    assert.ok(toolbarHomeStableChrome.inputEventsForwarded >= beforeHomeClick.inputEventsForwarded + 3, `expected toolbar Home click forwarding, got ${JSON.stringify(toolbarHomeStableChrome)}`);
    assert.deepEqual(toolbarHomeStableChrome.cursor.hotspot, [4, 0], `expected toolbar Home to expose NetSurf's hand cursor, got ${JSON.stringify(toolbarHomeStableChrome)}`);
    assert.deepEqual(
      toolbarHomeStableChrome.metrics,
      Object.fromEntries(Object.entries(stableAboutWelcomeChromeMetrics).map(([name, expected]) => [name, expected.metrics])),
      `expected toolbar Home to preserve deterministic about:welcome chrome/status/content rasters, got ${JSON.stringify(toolbarHomeStableChrome)}`,
    );

    const toolbarHoverTargets = [
      { name: 'Back', x: 30, expectedRect: [31, 16, 47, 38] },
      { name: 'Forward', x: 45, expectedRect: [46, 16, 62, 38] },
      { name: 'Reload', x: 62, expectedRect: [63, 16, 79, 38] },
      { name: 'Home', x: 85, expectedRect: [86, 16, 102, 38] },
    ];
    let beforeToolbarHoverDirtyRects = await page.evaluate(() => window.netsurfFramebufferState.dirtyRectsObserved);
    for (const target of toolbarHoverTargets) {
      await hoverNetSurfCanvasPixel(canvasLocator, target.x, 15);
      const toolbarHover = await page.waitForFunction(
        ({ minimumDirtyRects, expectedRect }) => {
          const state = window.netsurfFramebufferState;
          if (!state || state.dirtyRectsObserved <= minimumDirtyRects || state.lastInputEvent?.type !== 'pointermove') return null;
          const cursor = state.cursor;
          const handCursorOverToolbar = cursor?.hotspot?.[0] === 4
            && cursor.hotspot?.[1] === 0
            && cursor.rect?.[0] === expectedRect[0]
            && cursor.rect?.[1] === expectedRect[1]
            && cursor.rect?.[2] === expectedRect[2]
            && cursor.rect?.[3] === expectedRect[3];
          if (!handCursorOverToolbar) return null;
          const canvas = document.querySelector('#viewport');
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          const metricsFor = ({ x, y, width, height }) => {
            const { data } = ctx.getImageData(x, y, width, height);
            let black = 0;
            let nonGrey = 0;
            let nonWhite = 0;
            let hash = 0;
            for (let i = 0; i < data.length; i += 4) {
              const red = data[i];
              const green = data[i + 1];
              const blue = data[i + 2];
              if (red < 16 && green < 16 && blue < 16) black += 1;
              if (!(red === 221 && green === 221 && blue === 221)) nonGrey += 1;
              if (red < 245 || green < 245 || blue < 245) nonWhite += 1;
              hash = (hash * 31 + red * 3 + green * 5 + blue * 7) >>> 0;
            }
            return { black, nonGrey, nonWhite, hash };
          };
          const toolbar = metricsFor({ x: 0, y: 0, width: 95, height: 36 });
          const status = metricsFor({ x: 0, y: 462, width: 620, height: 18 });
          const stableToolbarChrome = toolbar.black === 145 && toolbar.nonGrey === 1804 && toolbar.nonWhite === 3420 && toolbar.hash === 2787099418;
          const stableStatusChrome = status.black === 404 && status.nonGrey === 1708 && status.nonWhite === 11160 && status.hash === 3968113013;
          return stableToolbarChrome && stableStatusChrome ? {
            dirtyRectsObserved: state.dirtyRectsObserved,
            inputEventsForwarded: state.inputEventsForwarded,
            lastInputEvent: state.lastInputEvent,
            cursor,
            toolbar,
            status,
          } : null;
        },
        { minimumDirtyRects: beforeToolbarHoverDirtyRects, expectedRect: target.expectedRect },
      ).then((handle) => handle.jsonValue());
      assert.deepEqual(toolbarHover.cursor.rect, target.expectedRect, `expected toolbar ${target.name} hover to expose a deterministic hand-cursor rect, got ${JSON.stringify(toolbarHover)}`);
      assert.deepEqual(toolbarHover.cursor.hotspot, [4, 0], `expected toolbar ${target.name} hover to expose NetSurf's hand cursor hotspot, got ${JSON.stringify(toolbarHover)}`);
      assert.deepEqual(
        { toolbar: toolbarHover.toolbar, status: toolbarHover.status },
        {
          toolbar: { black: 145, nonGrey: 1804, nonWhite: 3420, hash: 2787099418 },
          status: { black: 404, nonGrey: 1708, nonWhite: 11160, hash: 3968113013 },
        },
        `expected toolbar ${target.name} hover to preserve stable about:welcome toolbar/status rasters, got ${JSON.stringify(toolbarHover)}`,
      );
      assert.ok(toolbarHover.inputEventsForwarded >= toolbarHomeStableChrome.inputEventsForwarded + 1, `expected toolbar ${target.name} hover to forward pointer motion, got ${JSON.stringify(toolbarHover)}`);
      beforeToolbarHoverDirtyRects = toolbarHover.dirtyRectsObserved;
    }

    const beforeLogoLinkHoverDirtyRects = await page.evaluate(() => window.netsurfFramebufferState.dirtyRectsObserved);
    await hoverNetSurfCanvasPixel(canvasLocator, 200, 138);
    const logoLinkHoverStatusBar = await page.waitForFunction(
      (minimumDirtyRects) => {
        const state = window.netsurfFramebufferState;
        if (!state || state.dirtyRectsObserved <= minimumDirtyRects || state.lastInputEvent?.type !== 'pointermove') return null;
        const cursor = state.cursor;
        const logoHandCursor = cursor?.rect?.[0] >= 199 && cursor.rect[0] <= 202
          && cursor.rect[1] >= 137 && cursor.rect[1] <= 140
          && cursor.hotspot?.[0] === 4
          && cursor.hotspot?.[1] === 0
          && cursor.rect[2] - cursor.rect[0] === 16
          && cursor.rect[3] - cursor.rect[1] === 22;
        if (!logoHandCursor) return null;
        const canvas = document.querySelector('#viewport');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const { data } = ctx.getImageData(0, 462, 620, 18);
        let black = 0;
        let nonGrey = 0;
        let nonWhite = 0;
        let hash = 0;
        for (let i = 0; i < data.length; i += 4) {
          const red = data[i];
          const green = data[i + 1];
          const blue = data[i + 2];
          if (red < 16 && green < 16 && blue < 16) black += 1;
          if (!(red === 221 && green === 221 && blue === 221)) nonGrey += 1;
          if (red < 245 || green < 245 || blue < 245) nonWhite += 1;
          hash = (hash * 31 + red * 3 + green * 5 + blue * 7) >>> 0;
        }
        const status = { black, nonGrey, nonWhite, hash };
        const visibleLogoUrl = black === 1571 && nonGrey === 2875 && nonWhite === 11160 && hash === 3548889376;
        return visibleLogoUrl ? {
          dirtyRectsObserved: state.dirtyRectsObserved,
          lastInputEvent: state.lastInputEvent,
          cursor,
          status,
        } : null;
      },
      beforeLogoLinkHoverDirtyRects,
    ).then((handle) => handle.jsonValue());
    assert.deepEqual(
      logoLinkHoverStatusBar.status,
      { black: 1571, nonGrey: 2875, nonWhite: 11160, hash: 3548889376 },
      `expected visible about:welcome logo link hover to rasterize its website URL in the status bar, got ${JSON.stringify(logoLinkHoverStatusBar)}`,
    );
    assert.deepEqual(logoLinkHoverStatusBar.cursor.hotspot, [4, 0], `expected NetSurf logo link hover to expose its hand cursor hotspot, got ${JSON.stringify(logoLinkHoverStatusBar)}`);

    await clickNetSurfCanvasPixel(canvasLocator, 200, 138);
    const logoLinkActivationStatusBar = await page.waitForFunction(
      (minimumDirtyRects) => {
        const state = window.netsurfFramebufferState;
        if (!state || state.dirtyRectsObserved <= minimumDirtyRects || state.lastInputEvent?.type !== 'pointerup-button') return null;
        const canvas = document.querySelector('#viewport');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const statusPixels = ctx.getImageData(0, 462, 620, 18).data;
        const logoPixels = ctx.getImageData(15, 118, 570, 45).data;
        const metricsFor = (data) => {
          let black = 0;
          let nonGrey = 0;
          let nonWhite = 0;
          let hash = 0;
          for (let i = 0; i < data.length; i += 4) {
            const red = data[i];
            const green = data[i + 1];
            const blue = data[i + 2];
            if (red < 16 && green < 16 && blue < 16) black += 1;
            if (!(red === 221 && green === 221 && blue === 221)) nonGrey += 1;
            if (red < 245 || green < 245 || blue < 245) nonWhite += 1;
            hash = (hash * 31 + red * 3 + green * 5 + blue * 7) >>> 0;
          }
          return { black, nonGrey, nonWhite, hash };
        };
        const status = metricsFor(statusPixels);
        const logo = metricsFor(logoPixels);
        const visibleActivationStatus = status.black === 285 && status.nonGrey === 1589 && status.nonWhite === 11160 && status.hash === 1681376340;
        const logoStillVisible = logo.black === 0 && logo.nonGrey === 25650 && logo.nonWhite === 24510 && logo.hash === 1950299052;
        return visibleActivationStatus && logoStillVisible ? {
          dirtyRectsObserved: state.dirtyRectsObserved,
          lastInputEvent: state.lastInputEvent,
          cursor: state.cursor,
          status,
          logo,
        } : null;
      },
      logoLinkHoverStatusBar.dirtyRectsObserved,
    ).then((handle) => handle.jsonValue());
    assert.deepEqual(
      logoLinkActivationStatusBar.status,
      { black: 285, nonGrey: 1589, nonWhite: 11160, hash: 1681376340 },
      `expected about:welcome logo link activation to visibly redraw a deterministic status-bar loading raster without network access, got ${JSON.stringify(logoLinkActivationStatusBar)}`,
    );
    assert.deepEqual(
      logoLinkActivationStatusBar.logo,
      { black: 0, nonGrey: 25650, nonWhite: 24510, hash: 1950299052 },
      `expected about:welcome logo bitmap to remain visibly present after offline link activation, got ${JSON.stringify(logoLinkActivationStatusBar)}`,
    );

    await hoverNetSurfCanvasPixel(canvasLocator, 320, 240);
    await page.waitForFunction(() => {
      const rect = window.netsurfFramebufferState?.cursor?.rect;
      return rect && rect[0] >= 319 && rect[0] <= 321 && rect[1] >= 239 && rect[1] <= 241;
    });
    const pageCursor = await page.evaluate(() => ({
      cursor: window.netsurfFramebufferState.cursor,
      inputEventsForwarded: window.netsurfFramebufferState.inputEventsForwarded,
    }));
    assert.deepEqual(pageCursor.cursor.hotspot, [0, 0], `expected normal content cursor hotspot before address-bar hit testing, got ${JSON.stringify(pageCursor)}`);
    assert.equal(pageCursor.cursor.rect[2] - pageCursor.cursor.rect[0], 12, `expected normal content cursor width, got ${JSON.stringify(pageCursor)}`);
    assert.equal(pageCursor.cursor.rect[3] - pageCursor.cursor.rect[1], 22, `expected normal content cursor height, got ${JSON.stringify(pageCursor)}`);

    const beforeAddressStatus = await readNetSurfStatusBarMetrics(page);
    await hoverNetSurfCanvasPixel(canvasLocator, 180, 16);
    const addressHover = await page.waitForFunction(
      ({ beforeInputCount, beforeStatus }) => {
        const state = window.netsurfFramebufferState;
        const rect = state?.cursor?.rect;
        const hotspot = state?.cursor?.hotspot;
        if (!rect || !hotspot) return null;
        const canvas = document.querySelector('#viewport');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const { data } = ctx.getImageData(0, 462, 200, 18);
        let black = 0;
        let nonGrey = 0;
        let hash = 0;
        for (let i = 0; i < data.length; i += 4) {
          const red = data[i];
          const green = data[i + 1];
          const blue = data[i + 2];
          if (red < 16 && green < 16 && blue < 16) black += 1;
          if (!(red === 221 && green === 221 && blue === 221)) nonGrey += 1;
          hash = (hash * 31 + red * 3 + green * 5 + blue * 7) >>> 0;
        }
        const overAddressBar = rect[0] >= 179 && rect[0] <= 181 && rect[1] >= 15 && rect[1] <= 17;
        const iBeamShape = rect[2] - rect[0] === 7 && rect[3] - rect[1] === 19 && hotspot[0] === 3 && hotspot[1] === 8;
        if (!overAddressBar || !iBeamShape || state.inputEventsForwarded <= beforeInputCount) return null;
        return {
          cursor: state.cursor,
          dataset: document.body.dataset.netsurfFramebufferCursor,
          inputEventsForwarded: state.inputEventsForwarded,
          lastInputEvent: state.lastInputEvent,
          lastDirtyRect: state.lastDirtyRect,
          status: { black, nonGrey, hash },
        };
      },
      { beforeInputCount: pageCursor.inputEventsForwarded, beforeStatus: beforeAddressStatus },
    ).then((handle) => handle.jsonValue());
    assert.equal(addressHover.dataset, addressHover.cursor.rect.join(','));
    assert.equal(addressHover.lastInputEvent.type, 'pointermove');
    assert.ok(
      Math.abs(addressHover.lastInputEvent.detail.x - 180) <= 1 && Math.abs(addressHover.lastInputEvent.detail.y - 16) <= 1,
      `expected address-bar hover motion near 180,16, got ${JSON.stringify(addressHover)}`,
    );
    assert.equal(addressHover.cursor.rect[2] - addressHover.cursor.rect[0], 7, `expected address-bar hover to switch to NetSurf's I-beam cursor, got ${JSON.stringify(addressHover)}`);
    assert.equal(addressHover.cursor.rect[3] - addressHover.cursor.rect[1], 19, `expected address-bar hover to switch to NetSurf's I-beam cursor, got ${JSON.stringify(addressHover)}`);

    const beforeAddressFocus = await readNetSurfAddressBarMetrics(page);
    const beforeAddressKeyCount = addressHover.inputEventsForwarded;
    await clickNetSurfCanvasPixel(canvasLocator, 180, 16);
    const addressFocus = await page.waitForFunction(
      (before) => {
        const state = window.netsurfFramebufferState;
        const canvas = document.querySelector('#viewport');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const { data } = ctx.getImageData(95, 3, 520, 28);
        let black = 0;
        let nonGrey = 0;
        let nonWhite = 0;
        let hash = 0;
        for (let i = 0; i < data.length; i += 4) {
          const red = data[i];
          const green = data[i + 1];
          const blue = data[i + 2];
          if (red < 16 && green < 16 && blue < 16) black += 1;
          if (!(red === 221 && green === 221 && blue === 221)) nonGrey += 1;
          if (red < 245 || green < 245 || blue < 245) nonWhite += 1;
          hash = (hash * 31 + red * 3 + green * 5 + blue * 7) >>> 0;
        }
        const cursor = state?.cursor;
        const clickForwarded = state?.inputEventsForwarded >= before.inputCount + 3 && state?.lastInputEvent?.type === 'pointerup-button';
        // The hover step already proves deterministic address-bar hit testing via
        // NetSurf's I-beam cursor. Some libnsfb/fbtk timings redraw the cursor back
        // into content immediately after the click, so prove the click had a stable
        // fbtk chrome effect by waiting for NetSurf's address widget to redraw its
        // focused caret/text surface rather than requiring the transient I-beam to
        // persist.
        const addressFocusedCaretVisible = black === 1501 && nonGrey === 12610 && nonWhite === 4665 && hash === 3992501551;
        if (!clickForwarded || !addressFocusedCaretVisible) return null;
        return {
          before: before.metrics,
          after: { black, nonGrey, nonWhite, hash },
          cursor,
          inputEventsForwarded: state.inputEventsForwarded,
          lastInputEvent: state.lastInputEvent,
          dataset: document.body.dataset.netsurfFramebufferLastInput,
        };
      },
      { metrics: beforeAddressFocus, inputCount: beforeAddressKeyCount },
    ).then((handle) => handle.jsonValue());
    assert.equal(addressFocus.dataset, 'pointerup-button');
    assert.deepEqual(addressFocus.lastInputEvent.detail, { button: 0 });
    assert.ok(addressFocus.cursor.rect.length === 4, `expected cursor metadata after address-bar click, got ${JSON.stringify(addressFocus)}`);
    assert.notDeepEqual(addressFocus.after, addressFocus.before, `expected address-bar click to visibly focus the fbtk text widget, got ${JSON.stringify(addressFocus)}`);
    assert.deepEqual(
      addressFocus.after,
      { black: 1501, nonGrey: 12610, nonWhite: 4665, hash: 3992501551 },
      `expected deterministic visible address-bar caret/focus redraw after fbtk click, got ${JSON.stringify(addressFocus)}`,
    );

    await page.keyboard.press('x');
    const addressKeyForwarding = await page.waitForFunction(
      (beforeCount) => {
        const state = window.netsurfFramebufferState;
        if (!state || state.inputEventsForwarded < beforeCount + 2 || state.lastInputEvent?.type !== 'keyup') return null;
        const canvas = document.querySelector('#viewport');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const addressPixels = ctx.getImageData(95, 3, 520, 28).data;
        const statusPixels = ctx.getImageData(0, 462, 200, 18).data;
        const metricsFor = (data) => {
          let black = 0;
          let nonGrey = 0;
          let nonWhite = 0;
          let hash = 0;
          for (let i = 0; i < data.length; i += 4) {
            const red = data[i];
            const green = data[i + 1];
            const blue = data[i + 2];
            if (red < 16 && green < 16 && blue < 16) black += 1;
            if (!(red === 221 && green === 221 && blue === 221)) nonGrey += 1;
            if (red < 245 || green < 245 || blue < 245) nonWhite += 1;
            hash = (hash * 31 + red * 3 + green * 5 + blue * 7) >>> 0;
          }
          return { black, nonGrey, nonWhite, hash };
        };
        const address = metricsFor(addressPixels);
        const visibleTypedText = address.black === 1539 && address.nonGrey === 12610 && address.nonWhite === 4703 && address.hash === 1576672781;
        if (!visibleTypedText) return null;
        return {
          before: beforeCount,
          after: state.inputEventsForwarded,
          cursor: state.cursor,
          lastInputEvent: state.lastInputEvent,
          lastDirtyRect: state.lastDirtyRect,
          address,
          status: metricsFor(statusPixels),
          dataset: document.body.dataset.netsurfFramebufferLastInput,
        };
      },
      addressFocus.inputEventsForwarded,
    ).then((handle) => handle.jsonValue());
    assert.ok(addressKeyForwarding.after >= addressKeyForwarding.before + 2, `expected address-bar keydown/keyup forwarding, got ${JSON.stringify(addressKeyForwarding)}`);
    assert.equal(addressKeyForwarding.lastInputEvent.detail.key, 'x');
    assert.equal(addressKeyForwarding.lastInputEvent.detail.nsfb, 120);
    assert.equal(addressKeyForwarding.dataset, 'keyup');
    assert.ok(addressKeyForwarding.cursor.rect.length === 4, `expected NetSurf to report cursor metadata after address-bar typing, got ${JSON.stringify(addressKeyForwarding)}`);
    assert.deepEqual(
      addressKeyForwarding.address,
      { black: 1539, nonGrey: 12610, nonWhite: 4703, hash: 1576672781 },
      `expected forwarded fbtk key events to visibly insert deterministic address-bar text, got ${JSON.stringify(addressKeyForwarding)}`,
    );

    const beforeBrowserTextInputCount = addressKeyForwarding.after;
    const beforeBrowserTextInputDirtyRects = await page.evaluate(() => window.netsurfFramebufferState.dirtyRectsObserved);
    await page.keyboard.type('é');
    const browserBeforeInputCoverage = await page.waitForFunction(
      ({ before, minimumDirtyRects }) => {
        const state = window.netsurfFramebufferState;
        if (!state || state.inputEventsForwarded < before + 2 || state.lastInputEvent?.type !== 'beforeinput' || state.dirtyRectsObserved <= minimumDirtyRects) return null;
        const canvas = document.querySelector('#viewport');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const addressPixels = ctx.getImageData(95, 3, 520, 28).data;
        let black = 0;
        let nonGrey = 0;
        let nonWhite = 0;
        let hash = 0;
        for (let i = 0; i < addressPixels.length; i += 4) {
          const red = addressPixels[i];
          const green = addressPixels[i + 1];
          const blue = addressPixels[i + 2];
          if (red < 16 && green < 16 && blue < 16) black += 1;
          if (!(red === 221 && green === 221 && blue === 221)) nonGrey += 1;
          if (red < 245 || green < 245 || blue < 245) nonWhite += 1;
          hash = (hash * 31 + red * 3 + green * 5 + blue * 7) >>> 0;
        }
        const address = { black, nonGrey, nonWhite, hash };
        const visibleBeforeInputText = black === 1580 && nonGrey === 12610 && nonWhite === 4744 && hash === 628844700;
        if (!visibleBeforeInputText) return null;
        return {
          before,
          after: state.inputEventsForwarded,
          dirtyBefore: minimumDirtyRects,
          dirtyAfter: state.dirtyRectsObserved,
          activeElementId: document.activeElement?.id,
          lastInputEvent: state.lastInputEvent,
          history: state.inputEventHistory.slice(-6).map(({ type, detail }) => ({ type, detail })),
          address,
          dataset: document.body.dataset.netsurfFramebufferLastInput,
        };
      },
      { before: beforeBrowserTextInputCount, minimumDirtyRects: beforeBrowserTextInputDirtyRects },
    ).then((handle) => handle.jsonValue());
    assert.equal(browserBeforeInputCoverage.activeElementId, 'netsurf-text-input');
    assert.equal(browserBeforeInputCoverage.dataset, 'beforeinput');
    assert.ok(browserBeforeInputCoverage.after >= beforeBrowserTextInputCount + 2, `expected browser-generated beforeinput text to forward key down/up, got ${JSON.stringify(browserBeforeInputCoverage)}`);
    assert.ok(browserBeforeInputCoverage.dirtyAfter > browserBeforeInputCoverage.dirtyBefore, `expected browser-generated beforeinput text to redraw the fbtk address bar, got ${JSON.stringify(browserBeforeInputCoverage)}`);
    assert.deepEqual(
      browserBeforeInputCoverage.address,
      { black: 1580, nonGrey: 12610, nonWhite: 4744, hash: 628844700 },
      `expected trusted browser beforeinput to visibly add a deterministic address-bar glyph after x, got ${JSON.stringify(browserBeforeInputCoverage)}`,
    );
    assert.deepEqual(
      browserBeforeInputCoverage.lastInputEvent.detail,
      { text: 'é', inputType: 'insertText', isComposing: false, trusted: true, compositionActive: false, forwardedCharacters: 1, duplicateCompositionCommit: false },
      `expected trusted browser-generated beforeinput metadata, got ${JSON.stringify(browserBeforeInputCoverage)}`,
    );
    const browserBeforeInputByTypeAndCode = new Map(
      browserBeforeInputCoverage.history
        .filter((event) => event.detail && Number.isFinite(event.detail.nsfb))
        .map((event) => [`${event.type}:${event.detail.nsfb}`, event.detail]),
    );
    assert.equal(browserBeforeInputByTypeAndCode.get('beforeinput-keydown:233')?.source, 'beforeinput', `expected beforeinput Latin-1 keydown mapping, got ${JSON.stringify(browserBeforeInputCoverage)}`);
    assert.equal(browserBeforeInputByTypeAndCode.get('beforeinput-keyup:233')?.char, 'é', `expected beforeinput Latin-1 keyup mapping, got ${JSON.stringify(browserBeforeInputCoverage)}`);

    const beforeTrustedImeCount = browserBeforeInputCoverage.after;
    const cdpSession = await page.context().newCDPSession(page);
    await cdpSession.send('Input.imeSetComposition', {
      text: 'é',
      selectionStart: 1,
      selectionEnd: 1,
      replacementStart: 0,
      replacementEnd: 0,
    });
    const trustedImeCompositionCoverage = await page.waitForFunction(
      ({ before, expectedAddress }) => {
        const state = window.netsurfFramebufferState;
        if (!state || state.lastInputEvent?.type !== 'beforeinput') return null;
        const history = state.inputEventHistory.slice(-8).map(({ type, detail }) => ({ type, detail }));
        const hasTrustedUpdate = history.some((event) => event.type === 'compositionupdate' && event.detail?.text === 'é' && event.detail?.trusted === true);
        if (!hasTrustedUpdate || state.lastInputEvent.detail?.inputType !== 'insertCompositionText') return null;
        const canvas = document.querySelector('#viewport');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const addressPixels = ctx.getImageData(95, 3, 520, 28).data;
        let black = 0;
        let nonGrey = 0;
        let nonWhite = 0;
        let hash = 0;
        for (let i = 0; i < addressPixels.length; i += 4) {
          const red = addressPixels[i];
          const green = addressPixels[i + 1];
          const blue = addressPixels[i + 2];
          if (red < 16 && green < 16 && blue < 16) black += 1;
          if (!(red === 221 && green === 221 && blue === 221)) nonGrey += 1;
          if (red < 245 || green < 245 || blue < 245) nonWhite += 1;
          hash = (hash * 31 + red * 3 + green * 5 + blue * 7) >>> 0;
        }
        const address = { black, nonGrey, nonWhite, hash };
        const compositionDidNotPaintUncommittedText = Object.entries(expectedAddress).every(([key, value]) => address[key] === value);
        if (!compositionDidNotPaintUncommittedText) return null;
        return {
          before,
          after: state.inputEventsForwarded,
          compositionSession: state.compositionSession,
          lastInputEvent: state.lastInputEvent,
          history,
          address,
          dirtyRectsObserved: state.dirtyRectsObserved,
          dataset: document.body.dataset.netsurfFramebufferLastInput,
        };
      },
      { before: beforeTrustedImeCount, expectedAddress: browserBeforeInputCoverage.address },
    ).then((handle) => handle.jsonValue());
    assert.equal(trustedImeCompositionCoverage.after, beforeTrustedImeCount, `expected trusted IME composition updates to update metadata without premature key forwarding, got ${JSON.stringify(trustedImeCompositionCoverage)}`);
    assert.equal(trustedImeCompositionCoverage.dataset, 'beforeinput');
    assert.deepEqual(
      trustedImeCompositionCoverage.address,
      browserBeforeInputCoverage.address,
      `expected uncommitted trusted Chromium IME composition text to leave the visible address bar unchanged, got ${JSON.stringify(trustedImeCompositionCoverage)}`,
    );
    assert.deepEqual(
      trustedImeCompositionCoverage.lastInputEvent.detail,
      { text: 'é', inputType: 'insertCompositionText', isComposing: true, trusted: true, compositionActive: true, forwardedCharacters: 0, duplicateCompositionCommit: false },
      `expected trusted Chromium IME insertCompositionText metadata, got ${JSON.stringify(trustedImeCompositionCoverage)}`,
    );
    assert.equal(trustedImeCompositionCoverage.compositionSession.active, true);
    assert.equal(trustedImeCompositionCoverage.compositionSession.text, 'é');
    assert.ok(trustedImeCompositionCoverage.compositionSession.updates >= 1, `expected tracked IME composition updates, got ${JSON.stringify(trustedImeCompositionCoverage)}`);

    const beforeTrustedImeCommitDirtyRects = trustedImeCompositionCoverage.dirtyRectsObserved;
    await cdpSession.send('Input.insertText', { text: 'é' });
    const trustedImeCommitCoverage = await page.waitForFunction(
      ({ before, minimumDirtyRects }) => {
        const state = window.netsurfFramebufferState;
        if (!state || state.inputEventsForwarded < before + 2 || state.lastInputEvent?.type !== 'beforeinput' || state.dirtyRectsObserved <= minimumDirtyRects) return null;
        if (state.lastInputEvent.detail?.inputType !== 'insertText') return null;
        const canvas = document.querySelector('#viewport');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const addressPixels = ctx.getImageData(95, 3, 520, 28).data;
        let black = 0;
        let nonGrey = 0;
        let nonWhite = 0;
        let hash = 0;
        for (let i = 0; i < addressPixels.length; i += 4) {
          const red = addressPixels[i];
          const green = addressPixels[i + 1];
          const blue = addressPixels[i + 2];
          if (red < 16 && green < 16 && blue < 16) black += 1;
          if (!(red === 221 && green === 221 && blue === 221)) nonGrey += 1;
          if (red < 245 || green < 245 || blue < 245) nonWhite += 1;
          hash = (hash * 31 + red * 3 + green * 5 + blue * 7) >>> 0;
        }
        const address = { black, nonGrey, nonWhite, hash };
        const visibleCommittedImeText = black === 1621 && nonGrey === 12610 && nonWhite === 4785 && hash === 924561963;
        if (!visibleCommittedImeText) return null;
        return {
          before,
          after: state.inputEventsForwarded,
          dirtyBefore: minimumDirtyRects,
          dirtyAfter: state.dirtyRectsObserved,
          compositionSession: state.compositionSession,
          lastInputEvent: state.lastInputEvent,
          history: state.inputEventHistory.slice(-8).map(({ type, detail }) => ({ type, detail })),
          address,
          dataset: document.body.dataset.netsurfFramebufferLastInput,
        };
      },
      { before: beforeTrustedImeCount, minimumDirtyRects: beforeTrustedImeCommitDirtyRects },
    ).then((handle) => handle.jsonValue());
    assert.ok(trustedImeCommitCoverage.after >= beforeTrustedImeCount + 2, `expected trusted CDP IME commit to forward Latin-1 key down/up, got ${JSON.stringify(trustedImeCommitCoverage)}`);
    assert.ok(trustedImeCommitCoverage.dirtyAfter > trustedImeCommitCoverage.dirtyBefore, `expected trusted CDP IME commit to redraw the fbtk address bar, got ${JSON.stringify(trustedImeCommitCoverage)}`);
    assert.deepEqual(
      trustedImeCommitCoverage.address,
      { black: 1621, nonGrey: 12610, nonWhite: 4785, hash: 924561963 },
      `expected committed trusted IME text to visibly add a deterministic address-bar glyph after xé, got ${JSON.stringify(trustedImeCommitCoverage)}`,
    );
    assert.equal(trustedImeCommitCoverage.compositionSession.active, false);
    assert.deepEqual(
      trustedImeCommitCoverage.lastInputEvent.detail,
      { text: 'é', inputType: 'insertText', isComposing: false, trusted: true, compositionActive: false, forwardedCharacters: 1, duplicateCompositionCommit: false },
      `expected committed trusted IME text metadata, got ${JSON.stringify(trustedImeCommitCoverage)}`,
    );
    const trustedImeByTypeAndCode = new Map(
      trustedImeCommitCoverage.history
        .filter((event) => event.detail && Number.isFinite(event.detail.nsfb))
        .map((event) => [`${event.type}:${event.detail.nsfb}`, event.detail]),
    );
    assert.equal(trustedImeByTypeAndCode.get('beforeinput-keydown:233')?.char, 'é', `expected trusted IME commit keydown mapping, got ${JSON.stringify(trustedImeCommitCoverage)}`);
    assert.equal(trustedImeByTypeAndCode.get('beforeinput-keyup:233')?.source, 'beforeinput', `expected trusted IME commit keyup mapping, got ${JSON.stringify(trustedImeCommitCoverage)}`);

    const beforeNonLatinImeCommit = await page.evaluate(() => ({
      inputEventsForwarded: window.netsurfFramebufferState.inputEventsForwarded,
      dirtyRectsObserved: window.netsurfFramebufferState.dirtyRectsObserved,
      address: (() => {
        const canvas = document.querySelector('#viewport');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const data = ctx.getImageData(95, 3, 520, 28).data;
        let black = 0;
        let nonGrey = 0;
        let nonWhite = 0;
        let hash = 0;
        for (let i = 0; i < data.length; i += 4) {
          const red = data[i];
          const green = data[i + 1];
          const blue = data[i + 2];
          if (red < 16 && green < 16 && blue < 16) black += 1;
          if (!(red === 221 && green === 221 && blue === 221)) nonGrey += 1;
          if (red < 245 || green < 245 || blue < 245) nonWhite += 1;
          hash = (hash * 31 + red * 3 + green * 5 + blue * 7) >>> 0;
        }
        return { black, nonGrey, nonWhite, hash };
      })(),
    }));
    await cdpSession.send('Input.insertText', { text: 'あ' });
    const trustedNonLatinImeCommitCoverage = await page.waitForFunction(
      (before) => {
        const state = window.netsurfFramebufferState;
        if (!state || state.lastInputEvent?.type !== 'beforeinput') return null;
        const detail = state.lastInputEvent.detail;
        if (detail?.text !== 'あ' || detail.inputType !== 'insertText') return null;
        if (state.inputEventsForwarded !== before.inputEventsForwarded) return null;
        const canvas = document.querySelector('#viewport');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const data = ctx.getImageData(95, 3, 520, 28).data;
        let black = 0;
        let nonGrey = 0;
        let nonWhite = 0;
        let hash = 0;
        for (let i = 0; i < data.length; i += 4) {
          const red = data[i];
          const green = data[i + 1];
          const blue = data[i + 2];
          if (red < 16 && green < 16 && blue < 16) black += 1;
          if (!(red === 221 && green === 221 && blue === 221)) nonGrey += 1;
          if (red < 245 || green < 245 || blue < 245) nonWhite += 1;
          hash = (hash * 31 + red * 3 + green * 5 + blue * 7) >>> 0;
        }
        const address = { black, nonGrey, nonWhite, hash };
        const addressUnchanged = Object.entries(before.address).every(([key, value]) => address[key] === value);
        if (!addressUnchanged) return null;
        return {
          before,
          after: state.inputEventsForwarded,
          dirtyAfter: state.dirtyRectsObserved,
          compositionCommit: state.compositionCommit,
          lastInputEvent: state.lastInputEvent,
          address,
          dataset: document.body.dataset.netsurfFramebufferLastInput,
        };
      },
      beforeNonLatinImeCommit,
    ).then((handle) => handle.jsonValue());
    assert.equal(trustedNonLatinImeCommitCoverage.after, beforeNonLatinImeCommit.inputEventsForwarded, `expected non-Latin trusted IME commit metadata without unsupported libnsfb key forwarding, got ${JSON.stringify(trustedNonLatinImeCommitCoverage)}`);
    assert.equal(trustedNonLatinImeCommitCoverage.dataset, 'beforeinput');
    assert.deepEqual(
      trustedNonLatinImeCommitCoverage.address,
      beforeNonLatinImeCommit.address,
      `expected non-Latin trusted IME commit to leave the Latin-1-only fbtk address raster unchanged, got ${JSON.stringify(trustedNonLatinImeCommitCoverage)}`,
    );
    assert.deepEqual(
      trustedNonLatinImeCommitCoverage.lastInputEvent.detail,
      { text: 'あ', inputType: 'insertText', isComposing: false, trusted: true, compositionActive: false, forwardedCharacters: 0, duplicateCompositionCommit: false },
      `expected trusted non-Latin IME commit metadata to be recorded without key forwarding, got ${JSON.stringify(trustedNonLatinImeCommitCoverage)}`,
    );
    assert.deepEqual(
      trustedNonLatinImeCommitCoverage.compositionCommit,
      { text: 'あ', source: 'beforeinput', forwardedCharacters: 0, duplicateBeforeinputSuppressed: false, at: trustedNonLatinImeCommitCoverage.compositionCommit.at, trusted: true },
      `expected trusted non-Latin IME commit guard metadata, got ${JSON.stringify(trustedNonLatinImeCommitCoverage)}`,
    );
    assert.ok(Number.isFinite(trustedNonLatinImeCommitCoverage.compositionCommit.at), `expected trusted non-Latin IME commit timestamp, got ${JSON.stringify(trustedNonLatinImeCommitCoverage)}`);

    const beforeDuplicateImeCommit = await page.evaluate(() => ({
      inputEventsForwarded: window.netsurfFramebufferState.inputEventsForwarded,
      dirtyRectsObserved: window.netsurfFramebufferState.dirtyRectsObserved,
      address: (() => {
        const canvas = document.querySelector('#viewport');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const data = ctx.getImageData(95, 3, 520, 28).data;
        let black = 0;
        let nonGrey = 0;
        let nonWhite = 0;
        let hash = 0;
        for (let i = 0; i < data.length; i += 4) {
          const red = data[i];
          const green = data[i + 1];
          const blue = data[i + 2];
          if (red < 16 && green < 16 && blue < 16) black += 1;
          if (!(red === 221 && green === 221 && blue === 221)) nonGrey += 1;
          if (red < 245 || green < 245 || blue < 245) nonWhite += 1;
          hash = (hash * 31 + red * 3 + green * 5 + blue * 7) >>> 0;
        }
        return { black, nonGrey, nonWhite, hash };
      })(),
    }));
    await page.evaluate(() => {
      const target = document.querySelector('#netsurf-text-input');
      target.focus({ preventScroll: true });
      target.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true, cancelable: true }));
      target.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'y', bubbles: true, cancelable: true }));
      target.dispatchEvent(new CompositionEvent('compositionend', { data: 'y', bubbles: true, cancelable: true }));
      target.dispatchEvent(new InputEvent('beforeinput', { data: 'y', inputType: 'insertText', bubbles: true, cancelable: true }));
    });
    const duplicateImeCommitCoverage = await page.waitForFunction(
      (before) => {
        const state = window.netsurfFramebufferState;
        if (!state || state.lastInputEvent?.type !== 'beforeinput') return null;
        if (state.inputEventsForwarded !== before.inputEventsForwarded + 2) return null;
        if (state.dirtyRectsObserved <= before.dirtyRectsObserved) return null;
        const lastDetail = state.lastInputEvent.detail;
        if (!lastDetail?.duplicateCompositionCommit || lastDetail.forwardedCharacters !== 0) return null;
        const canvas = document.querySelector('#viewport');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const data = ctx.getImageData(95, 3, 520, 28).data;
        let black = 0;
        let nonGrey = 0;
        let nonWhite = 0;
        let hash = 0;
        for (let i = 0; i < data.length; i += 4) {
          const red = data[i];
          const green = data[i + 1];
          const blue = data[i + 2];
          if (red < 16 && green < 16 && blue < 16) black += 1;
          if (!(red === 221 && green === 221 && blue === 221)) nonGrey += 1;
          if (red < 245 || green < 245 || blue < 245) nonWhite += 1;
          hash = (hash * 31 + red * 3 + green * 5 + blue * 7) >>> 0;
        }
        const address = { black, nonGrey, nonWhite, hash };
        const addressChangedOnce = Object.entries(before.address).some(([key, value]) => address[key] !== value);
        if (!addressChangedOnce) return null;
        return {
          before,
          after: state.inputEventsForwarded,
          dirtyAfter: state.dirtyRectsObserved,
          lastInputEvent: state.lastInputEvent,
          compositionCommit: state.compositionCommit,
          compositionSession: state.compositionSession,
          history: state.inputEventHistory.slice(-8).map(({ type, detail }) => ({ type, detail })),
          address,
          dataset: document.body.dataset.netsurfFramebufferLastInput,
        };
      },
      beforeDuplicateImeCommit,
    ).then((handle) => handle.jsonValue());
    assert.equal(duplicateImeCommitCoverage.after, beforeDuplicateImeCommit.inputEventsForwarded + 2, `expected duplicate real-browser IME beforeinput commit to be suppressed after compositionend fallback, got ${JSON.stringify(duplicateImeCommitCoverage)}`);
    assert.equal(duplicateImeCommitCoverage.dataset, 'beforeinput');
    assert.deepEqual(
      duplicateImeCommitCoverage.lastInputEvent.detail,
      { text: 'y', inputType: 'insertText', isComposing: false, trusted: false, compositionActive: false, forwardedCharacters: 0, duplicateCompositionCommit: true },
      `expected duplicate IME beforeinput metadata, got ${JSON.stringify(duplicateImeCommitCoverage)}`,
    );
    assert.deepEqual(
      duplicateImeCommitCoverage.compositionCommit,
      { text: 'y', source: 'beforeinput-duplicate', forwardedCharacters: 0, duplicateBeforeinputSuppressed: true, at: duplicateImeCommitCoverage.compositionCommit.at, trusted: false },
      `expected duplicate IME commit guard metadata, got ${JSON.stringify(duplicateImeCommitCoverage)}`,
    );
    assert.ok(Number.isFinite(duplicateImeCommitCoverage.compositionCommit.at), `expected duplicate IME commit guard timestamp, got ${JSON.stringify(duplicateImeCommitCoverage)}`);
    const duplicateImeByTypeAndCode = new Map(
      duplicateImeCommitCoverage.history
        .filter((event) => event.detail && Number.isFinite(event.detail.nsfb))
        .map((event) => [`${event.type}:${event.detail.nsfb}`, event.detail]),
    );
    assert.equal(duplicateImeByTypeAndCode.get('composition-keydown:121')?.char, 'y', `expected compositionend fallback to forward y once, got ${JSON.stringify(duplicateImeCommitCoverage)}`);
    assert.equal(duplicateImeByTypeAndCode.get('composition-keyup:121')?.source, 'compositionend', `expected duplicate beforeinput not to add a second y keyup, got ${JSON.stringify(duplicateImeCommitCoverage)}`);

    const beforePlaywrightNativeText = await page.evaluate(() => ({
      inputEventsForwarded: window.netsurfFramebufferState.inputEventsForwarded,
      dirtyRectsObserved: window.netsurfFramebufferState.dirtyRectsObserved,
      address: (() => {
        const canvas = document.querySelector('#viewport');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const data = ctx.getImageData(95, 3, 520, 28).data;
        let black = 0;
        let nonGrey = 0;
        let nonWhite = 0;
        let hash = 0;
        for (let i = 0; i < data.length; i += 4) {
          const red = data[i];
          const green = data[i + 1];
          const blue = data[i + 2];
          if (red < 16 && green < 16 && blue < 16) black += 1;
          if (!(red === 221 && green === 221 && blue === 221)) nonGrey += 1;
          if (red < 245 || green < 245 || blue < 245) nonWhite += 1;
          hash = (hash * 31 + red * 3 + green * 5 + blue * 7) >>> 0;
        }
        return { black, nonGrey, nonWhite, hash };
      })(),
    }));
    await page.keyboard.insertText('ø');
    const playwrightNativeTextCoverage = await page.waitForFunction(
      (before) => {
        const state = window.netsurfFramebufferState;
        if (!state || state.inputEventsForwarded < before.inputEventsForwarded + 2 || state.lastInputEvent?.type !== 'beforeinput') return null;
        const detail = state.lastInputEvent.detail;
        if (detail?.text !== 'ø' || detail.inputType !== 'insertText') return null;
        if (state.dirtyRectsObserved <= before.dirtyRectsObserved) return null;
        const canvas = document.querySelector('#viewport');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const data = ctx.getImageData(95, 3, 520, 28).data;
        let black = 0;
        let nonGrey = 0;
        let nonWhite = 0;
        let hash = 0;
        for (let i = 0; i < data.length; i += 4) {
          const red = data[i];
          const green = data[i + 1];
          const blue = data[i + 2];
          if (red < 16 && green < 16 && blue < 16) black += 1;
          if (!(red === 221 && green === 221 && blue === 221)) nonGrey += 1;
          if (red < 245 || green < 245 || blue < 245) nonWhite += 1;
          hash = (hash * 31 + red * 3 + green * 5 + blue * 7) >>> 0;
        }
        const address = { black, nonGrey, nonWhite, hash };
        const addressChanged = Object.entries(before.address).some(([key, value]) => address[key] !== value);
        if (!addressChanged) return null;
        return {
          before,
          after: state.inputEventsForwarded,
          dirtyAfter: state.dirtyRectsObserved,
          compositionCommit: state.compositionCommit,
          lastInputEvent: state.lastInputEvent,
          history: state.inputEventHistory.slice(-8).map(({ type, detail }) => ({ type, detail })),
          address,
          dataset: document.body.dataset.netsurfFramebufferLastInput,
          activeElementId: document.activeElement?.id,
        };
      },
      beforePlaywrightNativeText,
    ).then((handle) => handle.jsonValue());
    assert.equal(playwrightNativeTextCoverage.activeElementId, 'netsurf-text-input');
    assert.equal(playwrightNativeTextCoverage.dataset, 'beforeinput');
    assert.ok(playwrightNativeTextCoverage.after >= beforePlaywrightNativeText.inputEventsForwarded + 2, `expected Playwright high-level browser text insertion to forward key down/up, got ${JSON.stringify(playwrightNativeTextCoverage)}`);
    assert.ok(playwrightNativeTextCoverage.dirtyAfter > beforePlaywrightNativeText.dirtyRectsObserved, `expected Playwright high-level browser text insertion to preserve dirty-rect advancement, got ${JSON.stringify(playwrightNativeTextCoverage)}`);
    assert.deepEqual(
      playwrightNativeTextCoverage.address,
      { black: 1714, nonGrey: 12610, nonWhite: 4878, hash: 53789304 },
      `expected Playwright high-level browser-generated insertText to visibly add a deterministic address-bar glyph, got ${JSON.stringify(playwrightNativeTextCoverage)}`,
    );
    assert.deepEqual(
      playwrightNativeTextCoverage.lastInputEvent.detail,
      { text: 'ø', inputType: 'insertText', isComposing: false, trusted: true, compositionActive: false, forwardedCharacters: 1, duplicateCompositionCommit: false },
      `expected Playwright high-level browser-generated insertText metadata, got ${JSON.stringify(playwrightNativeTextCoverage)}`,
    );
    assert.deepEqual(
      playwrightNativeTextCoverage.compositionCommit,
      { text: 'ø', source: 'beforeinput', forwardedCharacters: 1, duplicateBeforeinputSuppressed: false, at: playwrightNativeTextCoverage.compositionCommit.at, trusted: true },
      `expected Playwright high-level browser-generated insertText to update commit guard metadata, got ${JSON.stringify(playwrightNativeTextCoverage)}`,
    );
    assert.ok(Number.isFinite(playwrightNativeTextCoverage.compositionCommit.at), `expected Playwright high-level browser-generated insertText timestamp, got ${JSON.stringify(playwrightNativeTextCoverage)}`);
    const playwrightNativeByTypeAndCode = new Map(
      playwrightNativeTextCoverage.history
        .filter((event) => event.detail && Number.isFinite(event.detail.nsfb))
        .map((event) => [`${event.type}:${event.detail.nsfb}`, event.detail]),
    );
    assert.equal(playwrightNativeByTypeAndCode.get('beforeinput-keydown:248')?.char, 'ø', `expected Playwright high-level insertText keydown mapping, got ${JSON.stringify(playwrightNativeTextCoverage)}`);
    assert.equal(playwrightNativeByTypeAndCode.get('beforeinput-keyup:248')?.source, 'beforeinput', `expected Playwright high-level insertText keyup mapping, got ${JSON.stringify(playwrightNativeTextCoverage)}`);

    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP_ORIGIN });
    await page.evaluate(() => navigator.clipboard.writeText('ñ'));
    const beforeNativePaste = await page.evaluate(() => ({
      inputEventsForwarded: window.netsurfFramebufferState.inputEventsForwarded,
      dirtyRectsObserved: window.netsurfFramebufferState.dirtyRectsObserved,
      address: (() => {
        const canvas = document.querySelector('#viewport');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const data = ctx.getImageData(95, 3, 520, 28).data;
        let black = 0;
        let nonGrey = 0;
        let nonWhite = 0;
        let hash = 0;
        for (let i = 0; i < data.length; i += 4) {
          const red = data[i];
          const green = data[i + 1];
          const blue = data[i + 2];
          if (red < 16 && green < 16 && blue < 16) black += 1;
          if (!(red === 221 && green === 221 && blue === 221)) nonGrey += 1;
          if (red < 245 || green < 245 || blue < 245) nonWhite += 1;
          hash = (hash * 31 + red * 3 + green * 5 + blue * 7) >>> 0;
        }
        return { black, nonGrey, nonWhite, hash };
      })(),
    }));
    await page.keyboard.press('Control+V');
    const nativeClipboardPasteCoverage = await page.waitForFunction(
      (before) => {
        const state = window.netsurfFramebufferState;
        if (!state || state.inputEventsForwarded < before.inputEventsForwarded + 2 || state.dirtyRectsObserved <= before.dirtyRectsObserved) return null;
        const pasteCommit = state.compositionCommit;
        if (pasteCommit?.text !== 'ñ' || pasteCommit.source !== 'beforeinput') return null;
        const history = state.inputEventHistory.slice(-10).map(({ type, detail }) => ({ type, detail }));
        const pasteEvent = history.find((event) => event.type === 'beforeinput' && event.detail?.text === 'ñ' && event.detail?.inputType === 'insertFromPaste');
        if (!pasteEvent) return null;
        const canvas = document.querySelector('#viewport');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const data = ctx.getImageData(95, 3, 520, 28).data;
        let black = 0;
        let nonGrey = 0;
        let nonWhite = 0;
        let hash = 0;
        for (let i = 0; i < data.length; i += 4) {
          const red = data[i];
          const green = data[i + 1];
          const blue = data[i + 2];
          if (red < 16 && green < 16 && blue < 16) black += 1;
          if (!(red === 221 && green === 221 && blue === 221)) nonGrey += 1;
          if (red < 245 || green < 245 || blue < 245) nonWhite += 1;
          hash = (hash * 31 + red * 3 + green * 5 + blue * 7) >>> 0;
        }
        const address = { black, nonGrey, nonWhite, hash };
        const addressChanged = Object.entries(before.address).some(([key, value]) => address[key] !== value);
        if (!addressChanged) return null;
        return {
          before,
          after: state.inputEventsForwarded,
          dirtyAfter: state.dirtyRectsObserved,
          compositionCommit: pasteCommit,
          lastInputEvent: state.lastInputEvent,
          history,
          pasteEvent,
          address,
          dataset: document.body.dataset.netsurfFramebufferLastInput,
          activeElementId: document.activeElement?.id,
        };
      },
      beforeNativePaste,
    ).then((handle) => handle.jsonValue());
    assert.equal(nativeClipboardPasteCoverage.activeElementId, 'netsurf-text-input');
    assert.ok(nativeClipboardPasteCoverage.after >= beforeNativePaste.inputEventsForwarded + 2, `expected native browser clipboard paste to forward pasted Latin-1 key events without leaking the host paste shortcut into NetSurf, got ${JSON.stringify(nativeClipboardPasteCoverage)}`);
    assert.ok(nativeClipboardPasteCoverage.dirtyAfter > beforeNativePaste.dirtyRectsObserved, `expected native browser clipboard paste to preserve dirty-rect advancement, got ${JSON.stringify(nativeClipboardPasteCoverage)}`);
    assert.deepEqual(
      nativeClipboardPasteCoverage.address,
      { black: 1755, nonGrey: 12610, nonWhite: 4919, hash: 2647394567 },
      `expected native browser clipboard paste to visibly add a deterministic address-bar glyph, got ${JSON.stringify(nativeClipboardPasteCoverage)}`,
    );
    assert.deepEqual(
      nativeClipboardPasteCoverage.pasteEvent.detail,
      { text: 'ñ', inputType: 'insertFromPaste', isComposing: false, trusted: true, compositionActive: false, forwardedCharacters: 1, duplicateCompositionCommit: false },
      `expected trusted native clipboard paste beforeinput metadata, got ${JSON.stringify(nativeClipboardPasteCoverage)}`,
    );
    assert.deepEqual(
      nativeClipboardPasteCoverage.compositionCommit,
      { text: 'ñ', source: 'beforeinput', forwardedCharacters: 1, duplicateBeforeinputSuppressed: false, at: nativeClipboardPasteCoverage.compositionCommit.at, trusted: true },
      `expected native clipboard paste to update commit guard metadata, got ${JSON.stringify(nativeClipboardPasteCoverage)}`,
    );
    assert.ok(Number.isFinite(nativeClipboardPasteCoverage.compositionCommit.at), `expected native clipboard paste timestamp, got ${JSON.stringify(nativeClipboardPasteCoverage)}`);
    assert.ok(
      !nativeClipboardPasteCoverage.history.some((event) => event.detail?.code === 'ControlLeft' || event.detail?.code === 'MetaLeft'),
      `expected host paste shortcut modifiers to be left to the browser instead of forwarded to NetSurf, got ${JSON.stringify(nativeClipboardPasteCoverage)}`,
    );
    const nativePasteByTypeAndCode = new Map(
      nativeClipboardPasteCoverage.history
        .filter((event) => event.detail && Number.isFinite(event.detail.nsfb))
        .map((event) => [`${event.type}:${event.detail.nsfb}`, event.detail]),
    );
    assert.equal(nativePasteByTypeAndCode.get('beforeinput-keydown:241')?.char, 'ñ', `expected native clipboard paste keydown mapping, got ${JSON.stringify(nativeClipboardPasteCoverage)}`);
    assert.equal(nativePasteByTypeAndCode.get('beforeinput-keyup:241')?.source, 'beforeinput', `expected native clipboard paste keyup mapping, got ${JSON.stringify(nativeClipboardPasteCoverage)}`);

    const beforeToolbarInputCount = await page.evaluate(() => window.netsurfFramebufferState.inputEventsForwarded);
    await clickNetSurfCanvasPixel(canvasLocator, 75, 15);
    const toolbarActivation = await page.waitForFunction(
      (before) => {
        const state = window.netsurfFramebufferState;
        if (!state || state.inputEventsForwarded < before + 3 || state.lastInputEvent?.type !== 'pointerup-button') return null;
        return {
          before,
          after: state.inputEventsForwarded,
          lastDirtyRect: state.lastDirtyRect,
          lastInputEvent: state.lastInputEvent,
        };
      },
      beforeToolbarInputCount,
    ).then((handle) => handle.jsonValue());
    assert.equal(toolbarActivation.lastInputEvent.type, 'pointerup-button');
    assert.deepEqual(toolbarActivation.lastInputEvent.detail, { button: 0 });
    assert.ok(toolbarActivation.after >= beforeToolbarInputCount + 3, `expected toolbar click forwarding, got ${JSON.stringify(toolbarActivation)}`);

    const beforeInputCount = await page.evaluate(() => window.netsurfFramebufferState.inputEventsForwarded);
    const beforeScrollDirtyRects = await page.evaluate(() => window.netsurfFramebufferState.dirtyRectsObserved);
    const beforeDeliveredCount = await page.evaluate(() => window.netsurfFramebufferState.inputEventsDelivered);
    await canvasLocator.click({ position: { x: 320, y: 240 } });
    await page.mouse.wheel(0, 120);
    const wheelScrollSignatures = await waitForNetSurfWelcomeScrollSignatures(
      page,
      {
        welcomeLinksAfterWheel: { x: 20, y: 120, width: 590, height: 340, predicate: 'blueLinkGlyph', expectedCount: 4187, expectedHash: 3706658537 },
        welcomeLowerTextAfterWheel: { x: 25, y: 260, width: 590, height: 190, predicate: 'darkGlyph', expectedCount: 844, expectedHash: 2532503896 },
        welcomeBottomLinksAfterWheel: { x: 20, y: 360, width: 590, height: 100, predicate: 'blueLinkGlyph', expectedCount: 4187, expectedHash: 3130853337 },
        scrollbarAfterWheel: { x: 620, y: 38, width: 18, height: 424, predicate: 'scrollbarChrome', expectedCount: 3535, expectedHash: 1373962969 },
      },
      beforeScrollDirtyRects,
    );
    assert.deepEqual(
      {
        welcomeLinksAfterWheel: {
          count: wheelScrollSignatures.signatures.welcomeLinksAfterWheel.count,
          hash: wheelScrollSignatures.signatures.welcomeLinksAfterWheel.hash,
          rowBands: wheelScrollSignatures.signatures.welcomeLinksAfterWheel.rowBands,
          colBandCount: wheelScrollSignatures.signatures.welcomeLinksAfterWheel.colBands.length,
        },
        welcomeLowerTextAfterWheel: {
          count: wheelScrollSignatures.signatures.welcomeLowerTextAfterWheel.count,
          hash: wheelScrollSignatures.signatures.welcomeLowerTextAfterWheel.hash,
          rowBands: wheelScrollSignatures.signatures.welcomeLowerTextAfterWheel.rowBands,
          colBandCount: wheelScrollSignatures.signatures.welcomeLowerTextAfterWheel.colBands.length,
        },
        welcomeBottomLinksAfterWheel: {
          count: wheelScrollSignatures.signatures.welcomeBottomLinksAfterWheel.count,
          hash: wheelScrollSignatures.signatures.welcomeBottomLinksAfterWheel.hash,
          rowBands: wheelScrollSignatures.signatures.welcomeBottomLinksAfterWheel.rowBands,
          colBandCount: wheelScrollSignatures.signatures.welcomeBottomLinksAfterWheel.colBands.length,
        },
        scrollbarAfterWheel: {
          count: wheelScrollSignatures.signatures.scrollbarAfterWheel.count,
          hash: wheelScrollSignatures.signatures.scrollbarAfterWheel.hash,
          rowBands: wheelScrollSignatures.signatures.scrollbarAfterWheel.rowBands,
          colBandCount: wheelScrollSignatures.signatures.scrollbarAfterWheel.colBands.length,
        },
      },
      {
        welcomeLinksAfterWheel: { count: 4187, hash: 3706658537, rowBands: [[363, 377, 1454, 196], [382, 396, 1174, 163], [401, 415, 1192, 173], [420, 431, 367, 43]], colBandCount: 41 },
        welcomeLowerTextAfterWheel: { count: 844, hash: 2532503896, rowBands: [[293, 304, 396, 58], [368, 373, 128, 24], [387, 392, 128, 24], [406, 411, 128, 24], [425, 430, 64, 12]], colBandCount: 11 },
        welcomeBottomLinksAfterWheel: { count: 4187, hash: 3130853337, rowBands: [[363, 377, 1454, 196], [382, 396, 1174, 163], [401, 415, 1192, 173], [420, 431, 367, 43]], colBandCount: 41 },
        scrollbarAfterWheel: { count: 3535, hash: 1373962969, rowBands: [[38, 442, 3396, 18], [444, 461, 139, 16]], colBandCount: 1 },
      },
      `expected deterministic scroll-revealed about:welcome link/lower-page glyph coverage after wheel, got ${JSON.stringify(wheelScrollSignatures)}`,
    );
    assert.ok(wheelScrollSignatures.dirtyRectsObserved > beforeScrollDirtyRects, `expected wheel scroll to preserve dirty-rect advancement, got ${JSON.stringify(wheelScrollSignatures)}`);

    const beforeLinkHoverDirtyRects = wheelScrollSignatures.dirtyRectsObserved;
    await hoverNetSurfCanvasPixel(canvasLocator, 130, 370);
    const linkHoverStatusBar = await page.waitForFunction(
      (minimumDirtyRects) => {
        const state = window.netsurfFramebufferState;
        if (!state || state.dirtyRectsObserved <= minimumDirtyRects || state.lastInputEvent?.type !== 'pointermove') return null;
        const cursor = state.cursor;
        const linkHandCursor = cursor?.rect?.[0] >= 129 && cursor.rect[0] <= 132
          && cursor.rect[1] >= 369 && cursor.rect[1] <= 372
          && cursor.hotspot?.[0] === 4
          && cursor.hotspot?.[1] === 0
          && cursor.rect[2] - cursor.rect[0] === 16
          && cursor.rect[3] - cursor.rect[1] === 22;
        if (!linkHandCursor) return null;
        const canvas = document.querySelector('#viewport');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const { data } = ctx.getImageData(0, 462, 620, 18);
        let black = 0;
        let nonGrey = 0;
        let nonWhite = 0;
        let hash = 0;
        for (let i = 0; i < data.length; i += 4) {
          const red = data[i];
          const green = data[i + 1];
          const blue = data[i + 2];
          if (red < 16 && green < 16 && blue < 16) black += 1;
          if (!(red === 221 && green === 221 && blue === 221)) nonGrey += 1;
          if (red < 245 || green < 245 || blue < 245) nonWhite += 1;
          hash = (hash * 31 + red * 3 + green * 5 + blue * 7) >>> 0;
        }
        const status = { black, nonGrey, nonWhite, hash };
        const visibleStatusUrl = black === 737 && nonGrey === 2041 && nonWhite === 11160 && hash === 4169533564;
        return visibleStatusUrl ? {
          dirtyRectsObserved: state.dirtyRectsObserved,
          lastInputEvent: state.lastInputEvent,
          cursor,
          status,
        } : null;
      },
      beforeLinkHoverDirtyRects,
    ).then((handle) => handle.jsonValue());
    assert.deepEqual(
      linkHoverStatusBar.status,
      { black: 737, nonGrey: 2041, nonWhite: 11160, hash: 4169533564 },
      `expected scroll-revealed about:welcome link hover to visibly rasterize a status-bar URL, got ${JSON.stringify(linkHoverStatusBar)}`,
    );
    assert.deepEqual(linkHoverStatusBar.cursor.hotspot, [4, 0], `expected NetSurf link hover to expose its hand cursor hotspot, got ${JSON.stringify(linkHoverStatusBar)}`);

    await hoverNetSurfCanvasPixel(canvasLocator, 320, 240);
    const restoredStatusBarAfterLinkHover = await page.waitForFunction(
      (minimumDirtyRects) => {
        const state = window.netsurfFramebufferState;
        if (!state || state.dirtyRectsObserved <= minimumDirtyRects || state.lastInputEvent?.type !== 'pointermove') return null;
        const cursor = state.cursor;
        const normalCursor = cursor?.rect?.[0] >= 319 && cursor.rect[0] <= 322
          && cursor.rect[1] >= 239 && cursor.rect[1] <= 242
          && cursor.hotspot?.[0] === 0
          && cursor.hotspot?.[1] === 0
          && cursor.rect[2] - cursor.rect[0] === 12
          && cursor.rect[3] - cursor.rect[1] === 22;
        if (!normalCursor) return null;
        const canvas = document.querySelector('#viewport');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const { data } = ctx.getImageData(0, 462, 620, 18);
        let black = 0;
        let nonGrey = 0;
        let nonWhite = 0;
        let hash = 0;
        for (let i = 0; i < data.length; i += 4) {
          const red = data[i];
          const green = data[i + 1];
          const blue = data[i + 2];
          if (red < 16 && green < 16 && blue < 16) black += 1;
          if (!(red === 221 && green === 221 && blue === 221)) nonGrey += 1;
          if (red < 245 || green < 245 || blue < 245) nonWhite += 1;
          hash = (hash * 31 + red * 3 + green * 5 + blue * 7) >>> 0;
        }
        const status = { black, nonGrey, nonWhite, hash };
        const statusRestored = black === 404 && nonGrey === 1708 && nonWhite === 11160 && hash === 3968113013;
        return statusRestored ? {
          dirtyRectsObserved: state.dirtyRectsObserved,
          lastInputEvent: state.lastInputEvent,
          cursor,
          status,
        } : null;
      },
      linkHoverStatusBar.dirtyRectsObserved,
    ).then((handle) => handle.jsonValue());
    assert.deepEqual(
      restoredStatusBarAfterLinkHover.status,
      { black: 404, nonGrey: 1708, nonWhite: 11160, hash: 3968113013 },
      `expected moving off the about:welcome link to visibly restore the status bar raster, got ${JSON.stringify(restoredStatusBarAfterLinkHover)}`,
    );

    await page.keyboard.press('a');
    const interaction = await page.waitForFunction(
      ({ before, deliveredBefore }) => {
        const state = window.netsurfFramebufferState;
        if (!state || state.inputEventsForwarded < before + 8 || state.inputEventsDelivered <= deliveredBefore) return null;
        return {
          before,
          after: state.inputEventsForwarded,
          deliveredBefore,
          deliveredAfter: state.inputEventsDelivered,
          pending: state.inputEventsPending,
          dropped: state.inputEventsDropped,
          lastInputEvent: state.lastInputEvent,
          dataset: document.body.dataset.netsurfFramebufferLastInput,
        };
      },
      { before: beforeInputCount, deliveredBefore: beforeDeliveredCount },
    ).then((handle) => handle.jsonValue());
    assert.ok(beforeDeliveredCount >= 0);
    assert.ok(interaction.after >= beforeInputCount + 8, `expected deterministic forwarded click/wheel/key events, got ${JSON.stringify(interaction)}`);
    assert.ok(interaction.deliveredAfter > interaction.deliveredBefore, `expected fbtk_event to consume forwarded libnsfb events, got ${JSON.stringify(interaction)}`);
    assert.equal(interaction.dropped, 0, `expected no dropped libnsfb input events, got ${JSON.stringify(interaction)}`);
    assert.equal(interaction.lastInputEvent.type, 'keyup');
    assert.equal(interaction.lastInputEvent.detail.key, 'a');
    assert.equal(interaction.lastInputEvent.detail.nsfb, 97);
    assert.equal(interaction.lastInputEvent.detail.modifiers.shift, false);
    assert.equal(interaction.dataset, 'keyup');

    const beforeExpandedInputCount = interaction.after;
    const beforePageDownDirtyRects = await page.evaluate(() => window.netsurfFramebufferState.dirtyRectsObserved);
    await page.evaluate(() => {
      const canvas = document.querySelector('#viewport');
      canvas.focus();
      const dispatch = (event) => canvas.dispatchEvent(event);
      const keyEvents = [
        ['keydown', { key: 'Control', code: 'ControlRight', location: KeyboardEvent.DOM_KEY_LOCATION_RIGHT, ctrlKey: true }],
        ['keyup', { key: 'Control', code: 'ControlRight', location: KeyboardEvent.DOM_KEY_LOCATION_RIGHT }],
        ['keydown', { key: 'F5', code: 'F5' }],
        ['keyup', { key: 'F5', code: 'F5' }],
        ['keydown', { key: 'PageDown', code: 'PageDown' }],
        ['keyup', { key: 'PageDown', code: 'PageDown' }],
        ['keydown', { key: '+', code: 'NumpadAdd', location: KeyboardEvent.DOM_KEY_LOCATION_NUMPAD }],
        ['keyup', { key: '+', code: 'NumpadAdd', location: KeyboardEvent.DOM_KEY_LOCATION_NUMPAD }],
      ];
      for (const [type, init] of keyEvents) {
        dispatch(new KeyboardEvent(type, { ...init, bubbles: true, cancelable: true }));
      }
      dispatch(new CompositionEvent('compositionend', { data: 'éZ', bubbles: true, cancelable: true }));
    });
    const expandedInputCoverage = await page.waitForFunction(
      (before) => {
        const state = window.netsurfFramebufferState;
        if (!state || state.inputEventsForwarded < before + 12 || state.lastInputEvent?.type !== 'compositionend') return null;
        return {
          before,
          after: state.inputEventsForwarded,
          lastInputEvent: state.lastInputEvent,
          history: state.inputEventHistory.slice(-16).map(({ type, detail }) => ({ type, detail })),
          dataset: document.body.dataset.netsurfFramebufferLastInput,
        };
      },
      beforeExpandedInputCount,
    ).then((handle) => handle.jsonValue());
    assert.equal(expandedInputCoverage.dataset, 'compositionend');
    assert.ok(expandedInputCoverage.after >= beforeExpandedInputCount + 12, `expected expanded modifier/navigation/numpad/IME forwarding, got ${JSON.stringify(expandedInputCoverage)}`);
    assert.equal(expandedInputCoverage.lastInputEvent.detail.text, 'éZ');
    assert.equal(expandedInputCoverage.lastInputEvent.detail.trusted, false);
    assert.equal(expandedInputCoverage.lastInputEvent.detail.forwardedCharacters, 2);
    assert.ok(Number.isInteger(expandedInputCoverage.lastInputEvent.detail.updates), `expected IME composition metadata to include update count, got ${JSON.stringify(expandedInputCoverage)}`);
    const expandedByTypeAndCode = new Map(
      expandedInputCoverage.history
        .filter((event) => event.detail && Number.isFinite(event.detail.nsfb))
        .map((event) => [`${event.type}:${event.detail.nsfb}`, event.detail]),
    );
    assert.equal(expandedByTypeAndCode.get('keydown:305')?.code, 'ControlRight', `expected right Control modifier mapping, got ${JSON.stringify(expandedInputCoverage)}`);
    assert.equal(expandedByTypeAndCode.get('keydown:305')?.modifiers.ctrl, true, `expected modifier state capture, got ${JSON.stringify(expandedInputCoverage)}`);
    assert.equal(expandedByTypeAndCode.get('keyup:286')?.key, 'F5', `expected function-key mapping, got ${JSON.stringify(expandedInputCoverage)}`);
    assert.equal(expandedByTypeAndCode.get('keyup:281')?.key, 'PageDown', `expected navigation-key mapping, got ${JSON.stringify(expandedInputCoverage)}`);
    assert.equal(expandedByTypeAndCode.get('keyup:270')?.code, 'NumpadAdd', `expected numpad operator mapping, got ${JSON.stringify(expandedInputCoverage)}`);
    assert.equal(expandedByTypeAndCode.get('composition-keyup:233')?.char, 'é', `expected Latin-1 IME composition mapping, got ${JSON.stringify(expandedInputCoverage)}`);
    assert.equal(expandedByTypeAndCode.get('composition-keyup:90')?.char, 'Z', `expected ASCII IME composition mapping, got ${JSON.stringify(expandedInputCoverage)}`);

    const pageDownScrollSignatures = await waitForNetSurfWelcomeScrollSignatures(
      page,
      {
        welcomeLinksAfterPageDown: { x: 20, y: 120, width: 590, height: 340, predicate: 'blueLinkGlyph', expectedCount: 4187, expectedHash: 167346089 },
        welcomeLowerTextAfterPageDown: { x: 25, y: 260, width: 590, height: 190, predicate: 'darkGlyph', expectedCount: 2281, expectedHash: 2120331461 },
        welcomeBottomTextAfterPageDown: { x: 20, y: 360, width: 590, height: 100, predicate: 'darkGlyph', expectedCount: 1897, expectedHash: 417783980 },
        welcomeBottomLinksAfterPageDown: { x: 20, y: 360, width: 590, height: 100, predicate: 'blueLinkGlyph', expectedCount: 237, expectedHash: 3163971331 },
        scrollbarAfterPageDown: { x: 620, y: 38, width: 18, height: 424, predicate: 'scrollbarChrome', expectedCount: 3489, expectedHash: 3888503820 },
      },
      beforePageDownDirtyRects,
    );
    assert.deepEqual(
      {
        welcomeLinksAfterPageDown: {
          count: pageDownScrollSignatures.signatures.welcomeLinksAfterPageDown.count,
          hash: pageDownScrollSignatures.signatures.welcomeLinksAfterPageDown.hash,
          rowBands: pageDownScrollSignatures.signatures.welcomeLinksAfterPageDown.rowBands,
          colBandCount: pageDownScrollSignatures.signatures.welcomeLinksAfterPageDown.colBands.length,
        },
        welcomeLowerTextAfterPageDown: {
          count: pageDownScrollSignatures.signatures.welcomeLowerTextAfterPageDown.count,
          hash: pageDownScrollSignatures.signatures.welcomeLowerTextAfterPageDown.hash,
          rowBands: pageDownScrollSignatures.signatures.welcomeLowerTextAfterPageDown.rowBands,
          colBandCount: pageDownScrollSignatures.signatures.welcomeLowerTextAfterPageDown.colBands.length,
        },
        welcomeBottomTextAfterPageDown: {
          count: pageDownScrollSignatures.signatures.welcomeBottomTextAfterPageDown.count,
          hash: pageDownScrollSignatures.signatures.welcomeBottomTextAfterPageDown.hash,
          rowBands: pageDownScrollSignatures.signatures.welcomeBottomTextAfterPageDown.rowBands,
          colBandCount: pageDownScrollSignatures.signatures.welcomeBottomTextAfterPageDown.colBands.length,
        },
        welcomeBottomLinksAfterPageDown: {
          count: pageDownScrollSignatures.signatures.welcomeBottomLinksAfterPageDown.count,
          hash: pageDownScrollSignatures.signatures.welcomeBottomLinksAfterPageDown.hash,
          rowBands: pageDownScrollSignatures.signatures.welcomeBottomLinksAfterPageDown.rowBands,
          colBandCount: pageDownScrollSignatures.signatures.welcomeBottomLinksAfterPageDown.colBands.length,
        },
        scrollbarAfterPageDown: {
          count: pageDownScrollSignatures.signatures.scrollbarAfterPageDown.count,
          hash: pageDownScrollSignatures.signatures.scrollbarAfterPageDown.hash,
          rowBands: pageDownScrollSignatures.signatures.scrollbarAfterPageDown.rowBands,
          colBandCount: pageDownScrollSignatures.signatures.scrollbarAfterPageDown.colBands.length,
        },
      },
      {
        welcomeLinksAfterPageDown: { count: 4187, hash: 167346089, rowBands: [[299, 313, 1454, 196], [318, 332, 1174, 163], [337, 351, 1192, 173], [356, 367, 367, 43]], colBandCount: 41 },
        welcomeLowerTextAfterPageDown: { count: 2281, hash: 2120331461, rowBands: [[304, 309, 128, 24], [323, 328, 128, 24], [342, 347, 128, 24], [361, 366, 64, 12], [429, 440, 1833, 263]], colBandCount: 36 },
        welcomeBottomTextAfterPageDown: { count: 1897, hash: 417783980, rowBands: [[361, 366, 64, 12], [429, 440, 1833, 263]], colBandCount: 35 },
        welcomeBottomLinksAfterPageDown: { count: 237, hash: 3163971331, rowBands: [[360, 367, 237, 43]], colBandCount: 7 },
        scrollbarAfterPageDown: { count: 3489, hash: 3888503820, rowBands: [[38, 47, 83, 16], [49, 442, 3267, 14], [444, 461, 139, 16]], colBandCount: 1 },
      },
      `expected deterministic scroll-revealed about:welcome link/lower-page glyph coverage after PageDown, got ${JSON.stringify(pageDownScrollSignatures)}`,
    );
    assert.ok(pageDownScrollSignatures.dirtyRectsObserved > beforePageDownDirtyRects, `expected PageDown scroll to preserve dirty-rect advancement, got ${JSON.stringify(pageDownScrollSignatures)}`);

    await hoverNetSurfCanvasPixel(canvasLocator, 320, 240);
    const beforeBackToTopDirtyRects = await page.evaluate(() => window.netsurfFramebufferState.dirtyRectsObserved);
    await page.mouse.wheel(0, -120);
    await page.mouse.wheel(0, -120);
    const backToTopSignatures = await waitForNetSurfWelcomeScrollSignatures(
      page,
      {
        welcomeLogoBackToTop: { x: 20, y: 120, width: 590, height: 340, predicate: 'blueLinkGlyph', expectedCount: 3274, expectedHash: 2837369989 },
        welcomeIntroBackToTop: { x: 25, y: 120, width: 590, height: 340, predicate: 'darkGlyph', expectedCount: 8757, expectedHash: 1088269131 },
        scrollbarBackToTop: { x: 620, y: 38, width: 18, height: 424, predicate: 'scrollbarChrome', expectedCount: 3735, expectedHash: 4246721373 },
      },
      beforeBackToTopDirtyRects,
    );
    assert.deepEqual(
      {
        welcomeLogoBackToTop: {
          count: backToTopSignatures.signatures.welcomeLogoBackToTop.count,
          hash: backToTopSignatures.signatures.welcomeLogoBackToTop.hash,
          rowBands: backToTopSignatures.signatures.welcomeLogoBackToTop.rowBands,
          colBandCount: backToTopSignatures.signatures.welcomeLogoBackToTop.colBands.length,
        },
        welcomeIntroBackToTop: {
          count: backToTopSignatures.signatures.welcomeIntroBackToTop.count,
          hash: backToTopSignatures.signatures.welcomeIntroBackToTop.hash,
          rowBands: backToTopSignatures.signatures.welcomeIntroBackToTop.rowBands,
          colBandCount: backToTopSignatures.signatures.welcomeIntroBackToTop.colBands.length,
        },
        scrollbarBackToTop: {
          count: backToTopSignatures.signatures.scrollbarBackToTop.count,
          hash: backToTopSignatures.signatures.scrollbarBackToTop.hash,
          rowBands: backToTopSignatures.signatures.scrollbarBackToTop.rowBands,
          colBandCount: backToTopSignatures.signatures.scrollbarBackToTop.colBands.length,
        },
      },
      {
        welcomeLogoBackToTop: { count: 3274, hash: 2837369989, rowBands: [[123, 156, 3274, 364]], colBandCount: 4 },
        welcomeIntroBackToTop: { count: 8757, hash: 1088269131, rowBands: [[196, 219, 3164, 202], [247, 261, 1996, 294], [268, 282, 1911, 300], [289, 303, 1290, 197], [393, 404, 396, 58]], colBandCount: 43 },
        scrollbarBackToTop: { count: 3735, hash: 4246721373, rowBands: [[38, 442, 3596, 18], [444, 461, 139, 16]], colBandCount: 1 },
      },
      `expected deterministic about:welcome back-to-top glyph/logo coverage after upward wheel navigation, got ${JSON.stringify(backToTopSignatures)}`,
    );
    assert.ok(backToTopSignatures.dirtyRectsObserved > beforeBackToTopDirtyRects, `expected upward wheel back-to-top navigation to preserve dirty-rect advancement, got ${JSON.stringify(backToTopSignatures)}`);

    await hoverNetSurfCanvasPixel(canvasLocator, 320, 240);
    const beforeKeyboardScrollDirtyRects = await page.evaluate(() => window.netsurfFramebufferState.dirtyRectsObserved);
    await page.mouse.wheel(0, 120);
    await page.keyboard.press('PageDown');
    const keyboardPageDownSignatures = await waitForNetSurfWelcomeScrollSignatures(
      page,
      {
        welcomeLinksAfterKeyboardPageDown: { x: 20, y: 120, width: 590, height: 340, predicate: 'blueLinkGlyph', expectedCount: 4187, expectedHash: 167346089 },
        welcomeLowerTextAfterKeyboardPageDown: { x: 25, y: 260, width: 590, height: 190, predicate: 'darkGlyph', expectedCount: 2281, expectedHash: 2120331461 },
        welcomeBottomTextAfterKeyboardPageDown: { x: 20, y: 360, width: 590, height: 100, predicate: 'darkGlyph', expectedCount: 1897, expectedHash: 417783980 },
        scrollbarAfterKeyboardPageDown: { x: 620, y: 38, width: 18, height: 424, predicate: 'scrollbarChrome', expectedCount: 3489, expectedHash: 3888503820 },
      },
      beforeKeyboardScrollDirtyRects,
    );
    assert.ok(keyboardPageDownSignatures.dirtyRectsObserved > beforeKeyboardScrollDirtyRects, `expected repeated wheel+PageDown alternate navigation to preserve dirty-rect advancement, got ${JSON.stringify(keyboardPageDownSignatures)}`);

    await page.keyboard.press('PageUp');
    const keyboardPageUpBackToTopSignatures = await waitForNetSurfWelcomeScrollSignatures(
      page,
      {
        welcomeLogoAfterKeyboardPageUp: { x: 20, y: 120, width: 590, height: 340, predicate: 'blueLinkGlyph', expectedCount: 3274, expectedHash: 2837369989 },
        welcomeIntroAfterKeyboardPageUp: { x: 25, y: 120, width: 590, height: 340, predicate: 'darkGlyph', expectedCount: 8757, expectedHash: 1088269131 },
        scrollbarAfterKeyboardPageUp: { x: 620, y: 38, width: 18, height: 424, predicate: 'scrollbarChrome', expectedCount: 3735, expectedHash: 4246721373 },
      },
      keyboardPageDownSignatures.dirtyRectsObserved,
    );
    assert.deepEqual(
      {
        welcomeLogoAfterKeyboardPageUp: {
          count: keyboardPageUpBackToTopSignatures.signatures.welcomeLogoAfterKeyboardPageUp.count,
          hash: keyboardPageUpBackToTopSignatures.signatures.welcomeLogoAfterKeyboardPageUp.hash,
          rowBands: keyboardPageUpBackToTopSignatures.signatures.welcomeLogoAfterKeyboardPageUp.rowBands,
          colBandCount: keyboardPageUpBackToTopSignatures.signatures.welcomeLogoAfterKeyboardPageUp.colBands.length,
        },
        welcomeIntroAfterKeyboardPageUp: {
          count: keyboardPageUpBackToTopSignatures.signatures.welcomeIntroAfterKeyboardPageUp.count,
          hash: keyboardPageUpBackToTopSignatures.signatures.welcomeIntroAfterKeyboardPageUp.hash,
          rowBands: keyboardPageUpBackToTopSignatures.signatures.welcomeIntroAfterKeyboardPageUp.rowBands,
          colBandCount: keyboardPageUpBackToTopSignatures.signatures.welcomeIntroAfterKeyboardPageUp.colBands.length,
        },
        scrollbarAfterKeyboardPageUp: {
          count: keyboardPageUpBackToTopSignatures.signatures.scrollbarAfterKeyboardPageUp.count,
          hash: keyboardPageUpBackToTopSignatures.signatures.scrollbarAfterKeyboardPageUp.hash,
          rowBands: keyboardPageUpBackToTopSignatures.signatures.scrollbarAfterKeyboardPageUp.rowBands,
          colBandCount: keyboardPageUpBackToTopSignatures.signatures.scrollbarAfterKeyboardPageUp.colBands.length,
        },
      },
      {
        welcomeLogoAfterKeyboardPageUp: { count: 3274, hash: 2837369989, rowBands: [[123, 156, 3274, 364]], colBandCount: 4 },
        welcomeIntroAfterKeyboardPageUp: { count: 8757, hash: 1088269131, rowBands: [[196, 219, 3164, 202], [247, 261, 1996, 294], [268, 282, 1911, 300], [289, 303, 1290, 197], [393, 404, 396, 58]], colBandCount: 43 },
        scrollbarAfterKeyboardPageUp: { count: 3735, hash: 4246721373, rowBands: [[38, 442, 3596, 18], [444, 461, 139, 16]], colBandCount: 1 },
      },
      `expected deterministic keyboard PageUp restoration of about:welcome top glyph/logo coverage, got ${JSON.stringify(keyboardPageUpBackToTopSignatures)}`,
    );
    assert.ok(keyboardPageUpBackToTopSignatures.dirtyRectsObserved > keyboardPageDownSignatures.dirtyRectsObserved, `expected keyboard PageUp back-to-top navigation to preserve dirty-rect advancement, got ${JSON.stringify(keyboardPageUpBackToTopSignatures)}`);
    const pageUpInput = await page.evaluate(() => window.netsurfFramebufferState.lastInputEvent);
    assert.equal(pageUpInput.type, 'keyup');
    assert.equal(pageUpInput.detail.key, 'PageUp');
    assert.equal(pageUpInput.detail.nsfb, 280);

    const dispatchSyntheticKeyBatch = async (events) => page.evaluate((batch) => {
      const canvas = document.querySelector('#viewport');
      canvas.focus();
      const state = window.netsurfFramebufferState;
      const before = state.inputEventsForwarded;
      for (const event of batch) {
        const common = {
          key: event.key,
          code: event.code,
          location: event.location || 0,
          bubbles: true,
          cancelable: true,
          altKey: Boolean(event.altKey),
          ctrlKey: Boolean(event.ctrlKey),
          metaKey: Boolean(event.metaKey),
          shiftKey: Boolean(event.shiftKey),
        };
        canvas.dispatchEvent(new KeyboardEvent('keydown', common));
        canvas.dispatchEvent(new KeyboardEvent('keyup', { ...common, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }));
      }
      return {
        before,
        after: state.inputEventsForwarded,
        history: state.inputEventHistory.slice(-(batch.length * 2)).map(({ type, detail }) => ({ type, detail })),
      };
    }, events);

    const assertSyntheticKeyBatch = (coverage, expectedEvents) => {
      assert.equal(
        coverage.after,
        coverage.before + expectedEvents.length * 2,
        `expected all synthetic alternate keycodes to forward keydown/keyup pairs, got ${JSON.stringify(coverage)}`,
      );
      const byCode = new Map(
        coverage.history
          .filter((event) => event.type === 'keydown' && event.detail && Number.isFinite(event.detail.nsfb))
          .map((event) => [event.detail.code || event.detail.key, event.detail]),
      );
      for (const expectedEvent of expectedEvents) {
        const detail = byCode.get(expectedEvent.code || expectedEvent.key);
        assert.equal(detail?.nsfb, expectedEvent.nsfb, `expected ${expectedEvent.code || expectedEvent.key} to map to nsfb ${expectedEvent.nsfb}, got ${JSON.stringify(coverage)}`);
        assert.equal(detail?.location || 0, expectedEvent.location || 0, `expected ${expectedEvent.code || expectedEvent.key} to preserve KeyboardEvent.location, got ${JSON.stringify(coverage)}`);
        if (expectedEvent.altKey) assert.equal(detail.modifiers.alt, true, `expected alt modifier metadata for ${expectedEvent.code}, got ${JSON.stringify(coverage)}`);
        if (expectedEvent.ctrlKey) assert.equal(detail.modifiers.ctrl, true, `expected ctrl modifier metadata for ${expectedEvent.code}, got ${JSON.stringify(coverage)}`);
        if (expectedEvent.metaKey) assert.equal(detail.modifiers.meta, true, `expected meta modifier metadata for ${expectedEvent.code}, got ${JSON.stringify(coverage)}`);
        if (expectedEvent.shiftKey) assert.equal(detail.modifiers.shift, true, `expected shift modifier metadata for ${expectedEvent.code}, got ${JSON.stringify(coverage)}`);
      }
    };

    const namedKeyCoverageEvents = [
      { key: 'Backspace', code: 'Backspace', nsfb: 8 },
      { key: 'Tab', code: 'Tab', nsfb: 9 },
      { key: 'Enter', code: 'Enter', nsfb: 13 },
      { key: 'Escape', code: 'Escape', nsfb: 27 },
      { key: 'Delete', code: 'Delete', nsfb: 127 },
      { key: 'ArrowUp', code: 'ArrowUp', nsfb: 273 },
      { key: 'ArrowDown', code: 'ArrowDown', nsfb: 274 },
      { key: 'ArrowRight', code: 'ArrowRight', nsfb: 275 },
      { key: 'ArrowLeft', code: 'ArrowLeft', nsfb: 276 },
      { key: 'Insert', code: 'Insert', nsfb: 277 },
      { key: 'Home', code: 'Home', nsfb: 278 },
      { key: 'End', code: 'End', nsfb: 279 },
      { key: 'PageUp', code: 'PageUp', nsfb: 280 },
      { key: 'Shift', code: 'ShiftLeft', nsfb: 304, shiftKey: true },
      { key: 'Shift', code: 'ShiftRight', location: 2, nsfb: 303, shiftKey: true },
      { key: 'Control', code: 'ControlLeft', nsfb: 306, ctrlKey: true },
      { key: 'Alt', code: 'AltLeft', nsfb: 308, altKey: true },
      { key: 'Alt', code: 'AltRight', location: 2, nsfb: 307, altKey: true },
    ];
    assertSyntheticKeyBatch(await dispatchSyntheticKeyBatch(namedKeyCoverageEvents), namedKeyCoverageEvents);

    const systemFunctionNumpadCoverageEvents = [
      { key: 'Meta', code: 'MetaLeft', nsfb: 310, metaKey: true },
      { key: 'Meta', code: 'MetaRight', location: 2, nsfb: 309, metaKey: true },
      { key: 'CapsLock', code: 'CapsLock', nsfb: 301 },
      { key: 'NumLock', code: 'NumLock', nsfb: 300 },
      { key: 'ScrollLock', code: 'ScrollLock', nsfb: 302 },
      { key: 'Pause', code: 'Pause', nsfb: 19 },
      { key: 'PrintScreen', code: 'PrintScreen', nsfb: 316 },
      { key: 'ContextMenu', code: 'ContextMenu', nsfb: 319 },
      { key: 'F1', code: 'F1', nsfb: 282 },
      { key: 'F12', code: 'F12', nsfb: 293 },
      { key: '0', code: 'Numpad0', location: 3, nsfb: 256 },
      { key: '9', code: 'Numpad9', location: 3, nsfb: 265 },
      { key: '.', code: 'NumpadDecimal', location: 3, nsfb: 266 },
      { key: 'Enter', code: 'NumpadEnter', location: 3, nsfb: 271 },
      { key: '/', code: 'NumpadDivide', location: 3, nsfb: 267 },
      { key: '*', code: 'NumpadMultiply', location: 3, nsfb: 268 },
      { key: '-', code: 'NumpadSubtract', location: 3, nsfb: 269 },
      { key: '+', code: 'NumpadAdd', location: 3, nsfb: 270 },
    ];
    assertSyntheticKeyBatch(
      await dispatchSyntheticKeyBatch(systemFunctionNumpadCoverageEvents),
      systemFunctionNumpadCoverageEvents,
    );
  } finally {
    await closePage(page);
  }
});

async function revealNetSurfWelcomeSearchForm(page, canvasLocator) {
  const beforeSearchScrollDirtyRects = await page.evaluate(() => window.netsurfFramebufferState.dirtyRectsObserved);
  await hoverNetSurfCanvasPixel(canvasLocator, 320, 240);
  await page.mouse.wheel(0, 120);
  await page.mouse.wheel(0, 120);
  const searchFormRevealed = await waitForNetSurfRegionMetrics(
    page,
    {
      searchPanel: {
        region: { x: 65, y: 175, width: 505, height: 140 },
        metrics: { black: 524, nonGrey: 70700, nonWhite: 38390, hash: 3508617674 },
      },
      searchInput: {
        region: { x: 105, y: 188, width: 405, height: 30 },
        metrics: { black: 0, nonGrey: 12150, nonWhite: 2200, hash: 2983707424 },
      },
      searchButton: {
        region: { x: 260, y: 222, width: 110, height: 35 },
        metrics: { black: 396, nonGrey: 3850, nonWhite: 3850, hash: 569062084 },
      },
    },
    beforeSearchScrollDirtyRects,
  );
  assert.ok(searchFormRevealed.dirtyRectsObserved > beforeSearchScrollDirtyRects, `expected wheel scrolling to reveal the about:welcome search form with dirty-rect advancement, got ${JSON.stringify(searchFormRevealed)}`);
  return searchFormRevealed;
}

test('NetSurf about:welcome lower link activation preserves offline content with deterministic rasters', { timeout: 25_000 }, async () => {
  const page = await newAppPage();
  try {
    await page.goto(`${APP_URL}browsers/netsurf/`, { waitUntil: 'domcontentloaded' });
    await page.locator('body[data-netsurf-framebuffer-visible="true"]').waitFor({ state: 'attached' });
    await page.locator('#viewport').waitFor({ state: 'visible' });
    await waitForNetSurfVisibleTextSignatures(page);

    const canvasLocator = page.locator('#viewport');
    const searchFormRevealed = await revealNetSurfWelcomeSearchForm(page, canvasLocator);

    await hoverNetSurfCanvasPixel(canvasLocator, 450, 330);
    const lowerRightLinkHover = await waitForNetSurfRegionMetrics(
      page,
      {
        status: {
          region: { x: 0, y: 462, width: 620, height: 18 },
          metrics: { black: 896, nonGrey: 2200, nonWhite: 11160, hash: 2709257251 },
        },
        targetBand: {
          region: { x: 380, y: 310, width: 200, height: 65 },
          metrics: { black: 64, nonGrey: 13000, nonWhite: 922, hash: 658901800 },
        },
      },
      searchFormRevealed.dirtyRectsObserved,
    );
    assert.equal(lowerRightLinkHover.lastInputEvent.type, 'pointermove');
    assert.deepEqual(lowerRightLinkHover.cursor.hotspot, [4, 0], `expected lower-right about:welcome link hover to expose NetSurf's hand cursor, got ${JSON.stringify(lowerRightLinkHover)}`);
    assert.deepEqual(
      lowerRightLinkHover.metrics.status,
      { black: 896, nonGrey: 2200, nonWhite: 11160, hash: 2709257251 },
      `expected lower-right about:welcome link hover to rasterize a distinct status-bar URL, got ${JSON.stringify(lowerRightLinkHover)}`,
    );
    assert.deepEqual(
      lowerRightLinkHover.metrics.targetBand,
      { black: 64, nonGrey: 13000, nonWhite: 922, hash: 658901800 },
      `expected lower-right about:welcome link hover to preserve its visible link text band, got ${JSON.stringify(lowerRightLinkHover)}`,
    );

    await hoverNetSurfCanvasPixel(canvasLocator, 240, 350);
    const lowerBottomLinkHover = await waitForNetSurfRegionMetrics(
      page,
      {
        status: {
          region: { x: 0, y: 462, width: 620, height: 18 },
          metrics: { black: 980, nonGrey: 2284, nonWhite: 11160, hash: 618852567 },
        },
        linkStripe: {
          region: { x: 20, y: 250, width: 590, height: 130 },
          metrics: { black: 448, nonGrey: 76700, nonWhite: 15625, hash: 1376735688 },
        },
      },
      lowerRightLinkHover.dirtyRectsObserved,
    );
    assert.equal(lowerBottomLinkHover.lastInputEvent.type, 'pointermove');
    assert.deepEqual(lowerBottomLinkHover.cursor.hotspot, [4, 0], `expected lower-bottom about:welcome link hover to expose NetSurf's hand cursor, got ${JSON.stringify(lowerBottomLinkHover)}`);
    assert.notEqual(lowerBottomLinkHover.metrics.status.hash, lowerRightLinkHover.metrics.status.hash, `expected adjacent lower about:welcome links to expose distinct status-bar targets, got ${JSON.stringify({ lowerRightLinkHover, lowerBottomLinkHover })}`);
    assert.deepEqual(
      lowerBottomLinkHover.metrics.status,
      { black: 980, nonGrey: 2284, nonWhite: 11160, hash: 618852567 },
      `expected lower-bottom about:welcome link hover to rasterize another distinct status-bar URL, got ${JSON.stringify(lowerBottomLinkHover)}`,
    );

    await hoverNetSurfCanvasPixel(canvasLocator, 240, 310);
    const lowerLinkHover = await waitForNetSurfRegionMetrics(
      page,
      {
        status: {
          region: { x: 0, y: 462, width: 620, height: 18 },
          metrics: { black: 711, nonGrey: 2015, nonWhite: 11160, hash: 3767898530 },
        },
      },
      lowerBottomLinkHover.dirtyRectsObserved,
    );
    assert.equal(lowerLinkHover.lastInputEvent.type, 'pointermove');
    assert.deepEqual(lowerLinkHover.cursor.hotspot, [4, 0], `expected alternate scroll-revealed about:welcome link hover to expose NetSurf's hand cursor, got ${JSON.stringify(lowerLinkHover)}`);
    assert.equal(lowerLinkHover.cursor.rect[2] - lowerLinkHover.cursor.rect[0], 16, `expected alternate lower-link hand cursor width, got ${JSON.stringify(lowerLinkHover)}`);
    assert.equal(lowerLinkHover.cursor.rect[3] - lowerLinkHover.cursor.rect[1], 22, `expected alternate lower-link hand cursor height, got ${JSON.stringify(lowerLinkHover)}`);
    assert.deepEqual(
      lowerLinkHover.metrics.status,
      { black: 711, nonGrey: 2015, nonWhite: 11160, hash: 3767898530 },
      `expected alternate scroll-revealed about:welcome link hover to rasterize a distinct status-bar URL, got ${JSON.stringify(lowerLinkHover)}`,
    );

    const beforeLowerLinkActivationCount = lowerLinkHover.inputEventsForwarded;
    await clickNetSurfCanvasPixel(canvasLocator, 240, 310);
    const lowerLinkActivation = await waitForNetSurfRegionMetrics(
      page,
      {
        status: {
          region: { x: 0, y: 462, width: 620, height: 18 },
          metrics: { black: 285, nonGrey: 1589, nonWhite: 11160, hash: 1681376340 },
        },
        address: {
          region: { x: 95, y: 3, width: 520, height: 28 },
          metrics: { black: 1503, nonGrey: 12610, nonWhite: 4129, hash: 452212341 },
        },
        content: {
          region: { x: 0, y: 36, width: 640, height: 426 },
          metrics: { black: 844, nonGrey: 268532, nonWhite: 65617, hash: 3824838336 },
        },
        linkStripe: {
          region: { x: 20, y: 250, width: 590, height: 130 },
          metrics: { black: 448, nonGrey: 76700, nonWhite: 15625, hash: 1376735688 },
        },
      },
      lowerLinkHover.dirtyRectsObserved,
    );
    assert.equal(lowerLinkActivation.lastInputEvent.type, 'pointerup-button');
    assert.deepEqual(lowerLinkActivation.lastInputEvent.detail, { button: 0 });
    assert.ok(lowerLinkActivation.inputEventsForwarded >= beforeLowerLinkActivationCount + 3, `expected alternate lower-link activation click forwarding, got ${JSON.stringify(lowerLinkActivation)}`);
    assert.equal(lowerLinkActivation.inputEventsDropped, 0, `expected no dropped input events through alternate lower-link activation, got ${JSON.stringify(lowerLinkActivation)}`);
    assert.deepEqual(
      lowerLinkActivation.metrics,
      {
        status: { black: 285, nonGrey: 1589, nonWhite: 11160, hash: 1681376340 },
        address: { black: 1503, nonGrey: 12610, nonWhite: 4129, hash: 452212341 },
        content: { black: 844, nonGrey: 268532, nonWhite: 65617, hash: 3824838336 },
        linkStripe: { black: 448, nonGrey: 76700, nonWhite: 15625, hash: 1376735688 },
      },
      `expected alternate lower about:welcome link activation to visibly update status/address while preserving offline content bands, got ${JSON.stringify(lowerLinkActivation)}`,
    );
  } finally {
    await closePage(page);
  }
});

test('NetSurf about:welcome top navigation links expose distinct hover targets and offline activation', { timeout: 25_000 }, async () => {
  const page = await newAppPage();
  try {
    await page.goto(`${APP_URL}browsers/netsurf/`, { waitUntil: 'domcontentloaded' });
    await page.locator('body[data-netsurf-framebuffer-visible="true"]').waitFor({ state: 'attached' });
    await page.locator('#viewport').waitFor({ state: 'visible' });
    await waitForNetSurfVisibleTextSignatures(page);

    const canvasLocator = page.locator('#viewport');
    const beforeDocsHoverDirtyRects = await page.evaluate(() => window.netsurfFramebufferState.dirtyRectsObserved);
    await hoverNetSurfCanvasPixel(canvasLocator, 320, 138);
    const docsHover = await waitForNetSurfRegionMetrics(
      page,
      {
        status: {
          region: { x: 0, y: 462, width: 620, height: 18 },
          metrics: { black: 1436, nonGrey: 2740, nonWhite: 11160, hash: 3529665267 },
        },
        topNavigation: {
          region: { x: 0, y: 120, width: 640, height: 42 },
          metrics: { black: 0, nonGrey: 26376, nonWhite: 26258, hash: 1424795764 },
        },
      },
      beforeDocsHoverDirtyRects,
    );
    assert.equal(docsHover.lastInputEvent.type, 'pointermove');
    assert.deepEqual(docsHover.cursor.hotspot, [4, 0], `expected about:welcome documentation link hover to expose NetSurf's hand cursor, got ${JSON.stringify(docsHover)}`);
    assert.equal(docsHover.cursor.rect[2] - docsHover.cursor.rect[0], 16, `expected top navigation documentation hand cursor width, got ${JSON.stringify(docsHover)}`);
    assert.deepEqual(
      docsHover.metrics.status,
      { black: 1436, nonGrey: 2740, nonWhite: 11160, hash: 3529665267 },
      `expected top navigation documentation hover to rasterize a deterministic status-bar URL, got ${JSON.stringify(docsHover)}`,
    );

    await hoverNetSurfCanvasPixel(canvasLocator, 540, 138);
    const downloadsHover = await waitForNetSurfRegionMetrics(
      page,
      {
        status: {
          region: { x: 0, y: 462, width: 620, height: 18 },
          metrics: { black: 1331, nonGrey: 2635, nonWhite: 11160, hash: 782674110 },
        },
        topNavigation: {
          region: { x: 0, y: 120, width: 640, height: 42 },
          metrics: { black: 0, nonGrey: 26376, nonWhite: 26258, hash: 1424795764 },
        },
      },
      docsHover.dirtyRectsObserved,
    );
    assert.equal(downloadsHover.lastInputEvent.type, 'pointermove');
    assert.deepEqual(downloadsHover.cursor.hotspot, [4, 0], `expected about:welcome download link hover to expose NetSurf's hand cursor, got ${JSON.stringify(downloadsHover)}`);
    assert.notEqual(downloadsHover.metrics.status.hash, docsHover.metrics.status.hash, `expected adjacent top navigation links to expose distinct status-bar URLs, got ${JSON.stringify({ docsHover, downloadsHover })}`);
    assert.deepEqual(
      downloadsHover.metrics.topNavigation,
      { black: 0, nonGrey: 26376, nonWhite: 26258, hash: 1424795764 },
      `expected top navigation hover to preserve the visible nslinks raster band, got ${JSON.stringify(downloadsHover)}`,
    );

    const beforeDownloadsActivationCount = downloadsHover.inputEventsForwarded;
    await clickNetSurfCanvasPixel(canvasLocator, 540, 138);
    const downloadsActivation = await waitForNetSurfRegionMetrics(
      page,
      {
        status: {
          region: { x: 0, y: 462, width: 620, height: 18 },
          metrics: { black: 285, nonGrey: 1589, nonWhite: 11160, hash: 1681376340 },
        },
        address: {
          region: { x: 95, y: 3, width: 520, height: 28 },
          metrics: { black: 1503, nonGrey: 12610, nonWhite: 4649, hash: 1458272501 },
        },
        content: {
          region: { x: 0, y: 36, width: 640, height: 426 },
          metrics: { black: 1808, nonGrey: 268532, nonWhite: 135133, hash: 4161839195 },
        },
        topNavigation: {
          region: { x: 0, y: 120, width: 640, height: 42 },
          metrics: { black: 0, nonGrey: 26376, nonWhite: 26258, hash: 1424795764 },
        },
      },
      downloadsHover.dirtyRectsObserved,
    );
    assert.equal(downloadsActivation.lastInputEvent.type, 'pointerup-button');
    assert.deepEqual(downloadsActivation.lastInputEvent.detail, { button: 0 });
    assert.ok(downloadsActivation.inputEventsForwarded >= beforeDownloadsActivationCount + 3, `expected top navigation activation click forwarding, got ${JSON.stringify(downloadsActivation)}`);
    assert.equal(downloadsActivation.inputEventsDropped, 0, `expected no dropped input events through top navigation activation, got ${JSON.stringify(downloadsActivation)}`);
    assert.deepEqual(
      downloadsActivation.metrics,
      {
        status: { black: 285, nonGrey: 1589, nonWhite: 11160, hash: 1681376340 },
        address: { black: 1503, nonGrey: 12610, nonWhite: 4649, hash: 1458272501 },
        content: { black: 1808, nonGrey: 268532, nonWhite: 135133, hash: 4161839195 },
        topNavigation: { black: 0, nonGrey: 26376, nonWhite: 26258, hash: 1424795764 },
      },
      `expected top navigation activation to visibly redraw offline status while preserving address/content/nav rasters, got ${JSON.stringify(downloadsActivation)}`,
    );
  } finally {
    await closePage(page);
  }
});

test('NetSurf about:welcome top visible search button submits an empty form with deterministic offline rasters', { timeout: 25_000 }, async () => {
  const page = await newAppPage();
  try {
    await page.goto(`${APP_URL}browsers/netsurf/`, { waitUntil: 'domcontentloaded' });
    await page.locator('body[data-netsurf-framebuffer-visible="true"]').waitFor({ state: 'attached' });
    await page.locator('#viewport').waitFor({ state: 'visible' });
    await waitForNetSurfVisibleTextSignatures(page);

    const canvasLocator = page.locator('#viewport');
    const beforeTopSearchHoverDirtyRects = await page.evaluate(() => window.netsurfFramebufferState.dirtyRectsObserved);
    await hoverNetSurfCanvasPixel(canvasLocator, 260, 398);
    const topSearchButtonHover = await waitForNetSurfRegionMetrics(
      page,
      {
        status: {
          region: { x: 0, y: 462, width: 620, height: 18 },
          metrics: { black: 981, nonGrey: 2285, nonWhite: 11160, hash: 2912136484 },
        },
        topSearchButtonBand: {
          region: { x: 220, y: 380, width: 150, height: 42 },
          metrics: { black: 396, nonGrey: 6300, nonWhite: 6300, hash: 2087632276 },
        },
      },
      beforeTopSearchHoverDirtyRects,
    );
    assert.equal(topSearchButtonHover.lastInputEvent.type, 'pointermove');
    assert.deepEqual(topSearchButtonHover.cursor.hotspot, [4, 0], `expected top-visible about:welcome search button hover to expose NetSurf's hand cursor, got ${JSON.stringify(topSearchButtonHover)}`);
    assert.equal(topSearchButtonHover.cursor.rect[2] - topSearchButtonHover.cursor.rect[0], 16, `expected top-visible search button hand cursor width, got ${JSON.stringify(topSearchButtonHover)}`);
    assert.deepEqual(
      topSearchButtonHover.metrics.status,
      { black: 981, nonGrey: 2285, nonWhite: 11160, hash: 2912136484 },
      `expected top-visible about:welcome search button hover to rasterize its form action/status URL, got ${JSON.stringify(topSearchButtonHover)}`,
    );

    const beforeTopSearchSubmitCount = topSearchButtonHover.inputEventsForwarded;
    await clickNetSurfCanvasPixel(canvasLocator, 260, 398);
    const topSearchEmptySubmit = await waitForNetSurfRegionMetrics(
      page,
      {
        status: {
          region: { x: 0, y: 462, width: 620, height: 18 },
          metrics: { black: 382, nonGrey: 1686, nonWhite: 11160, hash: 2143802459 },
        },
        address: {
          region: { x: 95, y: 3, width: 520, height: 28 },
          metrics: { black: 1307, nonGrey: 12610, nonWhite: 4453, hash: 4061849669 },
        },
        content: {
          region: { x: 0, y: 36, width: 640, height: 426 },
          metrics: { black: 1778, nonGrey: 267668, nonWhite: 272453, hash: 2132359435 },
        },
        topSearchButtonBand: {
          region: { x: 220, y: 380, width: 150, height: 42 },
          metrics: { black: 0, nonGrey: 6300, nonWhite: 6300, hash: 1091931776 },
        },
        logo: {
          region: { x: 15, y: 118, width: 570, height: 45 },
          metrics: { black: 0, nonGrey: 25650, nonWhite: 25650, hash: 4271475706 },
        },
      },
      topSearchButtonHover.dirtyRectsObserved,
    );
    assert.equal(topSearchEmptySubmit.lastInputEvent.type, 'pointerup-button');
    assert.deepEqual(topSearchEmptySubmit.lastInputEvent.detail, { button: 0 });
    assert.ok(topSearchEmptySubmit.inputEventsForwarded >= beforeTopSearchSubmitCount + 3, `expected top-visible search button activation click forwarding, got ${JSON.stringify(topSearchEmptySubmit)}`);
    assert.equal(topSearchEmptySubmit.inputEventsDropped, 0, `expected no dropped input events through top-visible search button activation, got ${JSON.stringify(topSearchEmptySubmit)}`);
    assert.deepEqual(
      topSearchEmptySubmit.metrics,
      {
        status: { black: 382, nonGrey: 1686, nonWhite: 11160, hash: 2143802459 },
        address: { black: 1307, nonGrey: 12610, nonWhite: 4453, hash: 4061849669 },
        content: { black: 1778, nonGrey: 267668, nonWhite: 272453, hash: 2132359435 },
        topSearchButtonBand: { black: 0, nonGrey: 6300, nonWhite: 6300, hash: 1091931776 },
        logo: { black: 0, nonGrey: 25650, nonWhite: 25650, hash: 4271475706 },
      },
      `expected top-visible empty search submit to visibly update offline status/address/content rasters without hard-coded networking, got ${JSON.stringify(topSearchEmptySubmit)}`,
    );
  } finally {
    await closePage(page);
  }
});

test('NetSurf about:welcome top visible search input focuses, types, and submits via keyboard', { timeout: 25_000 }, async () => {
  const page = await newAppPage();
  try {
    await page.goto(`${APP_URL}browsers/netsurf/`, { waitUntil: 'domcontentloaded' });
    await page.locator('body[data-netsurf-framebuffer-visible="true"]').waitFor({ state: 'attached' });
    await page.locator('#viewport').waitFor({ state: 'visible' });
    await waitForNetSurfVisibleTextSignatures(page);

    const canvasLocator = page.locator('#viewport');
    const beforeTopSearchInputHoverDirtyRects = await page.evaluate(() => window.netsurfFramebufferState.dirtyRectsObserved);
    await hoverNetSurfCanvasPixel(canvasLocator, 180, 365);
    const topSearchInputHover = await waitForNetSurfRegionMetrics(
      page,
      {
        status: {
          region: { x: 0, y: 462, width: 620, height: 18 },
          metrics: { black: 734, nonGrey: 2038, nonWhite: 11160, hash: 2169014071 },
        },
        topSearchInput: {
          region: { x: 105, y: 360, width: 405, height: 30 },
          metrics: { black: 0, nonGrey: 12150, nonWhite: 4588, hash: 853473648 },
        },
      },
      beforeTopSearchInputHoverDirtyRects,
    );
    assert.equal(topSearchInputHover.lastInputEvent.type, 'pointermove');
    assert.deepEqual(topSearchInputHover.cursor.hotspot, [3, 8], `expected top-visible about:welcome search input hover to expose NetSurf's I-beam cursor, got ${JSON.stringify(topSearchInputHover)}`);
    assert.equal(topSearchInputHover.cursor.rect[2] - topSearchInputHover.cursor.rect[0], 7, `expected top-visible search input I-beam cursor width, got ${JSON.stringify(topSearchInputHover)}`);
    assert.deepEqual(
      topSearchInputHover.metrics.status,
      { black: 734, nonGrey: 2038, nonWhite: 11160, hash: 2169014071 },
      `expected top-visible search input hover to rasterize its deterministic status-bar target, got ${JSON.stringify(topSearchInputHover)}`,
    );

    const beforeTopSearchInputFocusCount = topSearchInputHover.inputEventsForwarded;
    await clickNetSurfCanvasPixel(canvasLocator, 180, 365);
    const topSearchInputFocus = await waitForNetSurfRegionMetrics(
      page,
      {
        topSearchInput: {
          region: { x: 105, y: 360, width: 405, height: 30 },
          metrics: { black: 0, nonGrey: 12150, nonWhite: 4604, hash: 2971081840 },
        },
        content: {
          region: { x: 0, y: 36, width: 640, height: 426 },
          metrics: { black: 1808, nonGrey: 268532, nonWhite: 135152, hash: 2124912880 },
        },
      },
      topSearchInputHover.dirtyRectsObserved,
    );
    assert.equal(topSearchInputFocus.lastInputEvent.type, 'pointerup-button');
    assert.deepEqual(topSearchInputFocus.lastInputEvent.detail, { button: 0 });
    assert.ok(topSearchInputFocus.inputEventsForwarded >= beforeTopSearchInputFocusCount + 3, `expected top-visible search input focus click forwarding, got ${JSON.stringify(topSearchInputFocus)}`);
    assert.equal(topSearchInputFocus.activeElementId, 'netsurf-text-input');
    assert.deepEqual(
      topSearchInputFocus.metrics.topSearchInput,
      { black: 0, nonGrey: 12150, nonWhite: 4604, hash: 2971081840 },
      `expected click to visibly focus the top-visible about:welcome search text field, got ${JSON.stringify(topSearchInputFocus)}`,
    );

    const beforeTopSearchTypingCount = topSearchInputFocus.inputEventsForwarded;
    await page.keyboard.type('abc');
    const topSearchTypedText = await waitForNetSurfRegionMetrics(
      page,
      {
        topSearchInput: {
          region: { x: 105, y: 360, width: 405, height: 30 },
          metrics: { black: 129, nonGrey: 12150, nonWhite: 4734, hash: 3489577823 },
        },
        topSearchPanel: {
          region: { x: 65, y: 350, width: 505, height: 100 },
          metrics: { black: 525, nonGrey: 50500, nonWhite: 31339, hash: 4261106188 },
        },
      },
      topSearchInputFocus.dirtyRectsObserved,
    );
    assert.equal(topSearchTypedText.lastInputEvent.type, 'keyup');
    assert.equal(topSearchTypedText.lastInputEvent.detail.key, 'c');
    assert.equal(topSearchTypedText.lastInputEvent.detail.nsfb, 99);
    assert.ok(topSearchTypedText.inputEventsForwarded >= beforeTopSearchTypingCount + 6, `expected top-visible search typing to forward keydown/keyup events, got ${JSON.stringify(topSearchTypedText)}`);
    assert.deepEqual(
      topSearchTypedText.metrics.topSearchInput,
      { black: 129, nonGrey: 12150, nonWhite: 4734, hash: 3489577823 },
      `expected typed text to visibly rasterize in the top-visible about:welcome search field, got ${JSON.stringify(topSearchTypedText)}`,
    );

    await page.keyboard.press('Enter');
    const topSearchSubmitByEnter = await waitForNetSurfRegionMetrics(
      page,
      {
        status: {
          region: { x: 0, y: 462, width: 620, height: 18 },
          metrics: { black: 382, nonGrey: 1686, nonWhite: 11160, hash: 2143802459 },
        },
        address: {
          region: { x: 95, y: 3, width: 520, height: 28 },
          metrics: { black: 1436, nonGrey: 12610, nonWhite: 4582, hash: 1691840722 },
        },
        content: {
          region: { x: 0, y: 36, width: 640, height: 426 },
          metrics: { black: 1278, nonGrey: 267668, nonWhite: 272453, hash: 1306608447 },
        },
        topSearchInput: {
          region: { x: 105, y: 360, width: 405, height: 30 },
          metrics: { black: 0, nonGrey: 12150, nonWhite: 12150, hash: 3156198976 },
        },
        logo: {
          region: { x: 15, y: 118, width: 570, height: 45 },
          metrics: { black: 0, nonGrey: 25650, nonWhite: 25650, hash: 4271475706 },
        },
      },
      topSearchTypedText.dirtyRectsObserved,
    );
    assert.equal(topSearchSubmitByEnter.lastInputEvent.type, 'keyup');
    assert.equal(topSearchSubmitByEnter.lastInputEvent.detail.key, 'Enter');
    assert.equal(topSearchSubmitByEnter.lastInputEvent.detail.nsfb, 13);
    assert.equal(topSearchSubmitByEnter.inputEventsDropped, 0, `expected no dropped input events through top-visible Enter search submit, got ${JSON.stringify(topSearchSubmitByEnter)}`);
    assert.deepEqual(
      topSearchSubmitByEnter.metrics,
      {
        status: { black: 382, nonGrey: 1686, nonWhite: 11160, hash: 2143802459 },
        address: { black: 1436, nonGrey: 12610, nonWhite: 4582, hash: 1691840722 },
        content: { black: 1278, nonGrey: 267668, nonWhite: 272453, hash: 1306608447 },
        topSearchInput: { black: 0, nonGrey: 12150, nonWhite: 12150, hash: 3156198976 },
        logo: { black: 0, nonGrey: 25650, nonWhite: 25650, hash: 4271475706 },
      },
      `expected top-visible Enter search submit to update deterministic offline status/address/content rasters without hard-coded networking, got ${JSON.stringify(topSearchSubmitByEnter)}`,
    );
  } finally {
    await closePage(page);
  }
});

test('NetSurf about:welcome search form exposes deterministic focus, typing, and submit rasters', { timeout: 25_000 }, async () => {
  const page = await newAppPage();
  try {
    await page.goto(`${APP_URL}browsers/netsurf/`, { waitUntil: 'domcontentloaded' });
    await page.locator('body[data-netsurf-framebuffer-visible="true"]').waitFor({ state: 'attached' });
    await page.locator('#viewport').waitFor({ state: 'visible' });
    await waitForNetSurfVisibleTextSignatures(page);

    const canvasLocator = page.locator('#viewport');
    const searchFormRevealed = await revealNetSurfWelcomeSearchForm(page, canvasLocator);
    const searchRevealScrollSignatures = await waitForNetSurfWelcomeScrollSignatures(
      page,
      {
        wholeDarkAfterSearchReveal: { x: 25, y: 120, width: 590, height: 340, predicate: 'darkGlyph', expectedCount: 3967, expectedHash: 3394561166 },
        linkStripeAfterSearchReveal: { x: 20, y: 250, width: 590, height: 130, predicate: 'blueLinkGlyph', expectedCount: 4187, expectedHash: 1319617267 },
        searchBlueLinksAfterSearchReveal: { x: 65, y: 175, width: 505, height: 140, predicate: 'blueLinkGlyph', expectedCount: 1454, expectedHash: 2524311383 },
        scrollbarAfterSearchReveal: { x: 620, y: 38, width: 18, height: 424, predicate: 'scrollbarChrome', expectedCount: 3489, expectedHash: 3888503820 },
      },
      Math.max(0, searchFormRevealed.dirtyRectsObserved - 1),
    );
    assert.deepEqual(
      {
        wholeDarkAfterSearchReveal: {
          count: searchRevealScrollSignatures.signatures.wholeDarkAfterSearchReveal.count,
          hash: searchRevealScrollSignatures.signatures.wholeDarkAfterSearchReveal.hash,
          rowBands: searchRevealScrollSignatures.signatures.wholeDarkAfterSearchReveal.rowBands,
          colBandCount: searchRevealScrollSignatures.signatures.wholeDarkAfterSearchReveal.colBands.length,
        },
        linkStripeAfterSearchReveal: {
          count: searchRevealScrollSignatures.signatures.linkStripeAfterSearchReveal.count,
          hash: searchRevealScrollSignatures.signatures.linkStripeAfterSearchReveal.hash,
          rowBands: searchRevealScrollSignatures.signatures.linkStripeAfterSearchReveal.rowBands,
          colBandCount: searchRevealScrollSignatures.signatures.linkStripeAfterSearchReveal.colBands.length,
        },
        searchBlueLinksAfterSearchReveal: {
          count: searchRevealScrollSignatures.signatures.searchBlueLinksAfterSearchReveal.count,
          hash: searchRevealScrollSignatures.signatures.searchBlueLinksAfterSearchReveal.hash,
          rowBands: searchRevealScrollSignatures.signatures.searchBlueLinksAfterSearchReveal.rowBands,
          colBandCount: searchRevealScrollSignatures.signatures.searchBlueLinksAfterSearchReveal.colBands.length,
        },
        scrollbarAfterSearchReveal: {
          count: searchRevealScrollSignatures.signatures.scrollbarAfterSearchReveal.count,
          hash: searchRevealScrollSignatures.signatures.scrollbarAfterSearchReveal.hash,
          rowBands: searchRevealScrollSignatures.signatures.scrollbarAfterSearchReveal.rowBands,
          colBandCount: searchRevealScrollSignatures.signatures.scrollbarAfterSearchReveal.colBands.length,
        },
      },
      {
        wholeDarkAfterSearchReveal: { count: 3967, hash: 3394561166, rowBands: [[125, 139, 1290, 197], [229, 240, 396, 58], [304, 309, 128, 24], [323, 328, 128, 24], [342, 347, 128, 24], [361, 366, 64, 12], [429, 440, 1833, 263]], colBandCount: 37 },
        linkStripeAfterSearchReveal: { count: 4187, hash: 1319617267, rowBands: [[299, 313, 1454, 196], [318, 332, 1174, 163], [337, 351, 1192, 173], [356, 367, 367, 43]], colBandCount: 41 },
        searchBlueLinksAfterSearchReveal: { count: 1454, hash: 2524311383, rowBands: [[299, 313, 1454, 196]], colBandCount: 34 },
        scrollbarAfterSearchReveal: { count: 3489, hash: 3888503820, rowBands: [[38, 47, 83, 16], [49, 442, 3267, 14], [444, 461, 139, 16]], colBandCount: 1 },
      },
      `expected deterministic intermediate about:welcome content/link bands after the second wheel search-form reveal, got ${JSON.stringify(searchRevealScrollSignatures)}`,
    );

    const beforeInputHoverDirtyRects = searchFormRevealed.dirtyRectsObserved;
    await hoverNetSurfCanvasPixel(canvasLocator, 120, 200);
    const searchInputHover = await waitForNetSurfRegionMetrics(
      page,
      {
        status: {
          region: { x: 0, y: 462, width: 620, height: 18 },
          metrics: { black: 734, nonGrey: 2038, nonWhite: 11160, hash: 2169014071 },
        },
        searchInput: {
          region: { x: 105, y: 188, width: 405, height: 30 },
          metrics: { black: 0, nonGrey: 12150, nonWhite: 2200, hash: 2983707424 },
        },
      },
      beforeInputHoverDirtyRects,
    );
    assert.equal(searchInputHover.lastInputEvent.type, 'pointermove');
    assert.deepEqual(searchInputHover.cursor.hotspot, [3, 8], `expected about:welcome search input hover to expose NetSurf's I-beam cursor, got ${JSON.stringify(searchInputHover)}`);
    assert.equal(searchInputHover.cursor.rect[2] - searchInputHover.cursor.rect[0], 7, `expected search input I-beam cursor width, got ${JSON.stringify(searchInputHover)}`);
    assert.deepEqual(
      searchInputHover.metrics.status,
      { black: 734, nonGrey: 2038, nonWhite: 11160, hash: 2169014071 },
      `expected search input hover to visibly rasterize a deterministic status-bar target, got ${JSON.stringify(searchInputHover)}`,
    );

    const beforeButtonHoverDirtyRects = searchInputHover.dirtyRectsObserved;
    await hoverNetSurfCanvasPixel(canvasLocator, 315, 240);
    const searchButtonHover = await waitForNetSurfRegionMetrics(
      page,
      {
        status: {
          region: { x: 0, y: 462, width: 620, height: 18 },
          metrics: { black: 981, nonGrey: 2285, nonWhite: 11160, hash: 2912136484 },
        },
        searchButton: {
          region: { x: 260, y: 222, width: 110, height: 35 },
          metrics: { black: 396, nonGrey: 3850, nonWhite: 3850, hash: 569062084 },
        },
      },
      beforeButtonHoverDirtyRects,
    );
    assert.equal(searchButtonHover.lastInputEvent.type, 'pointermove');
    assert.deepEqual(searchButtonHover.cursor.hotspot, [4, 0], `expected about:welcome search button hover to expose NetSurf's hand cursor, got ${JSON.stringify(searchButtonHover)}`);
    assert.equal(searchButtonHover.cursor.rect[2] - searchButtonHover.cursor.rect[0], 16, `expected search button hand cursor width, got ${JSON.stringify(searchButtonHover)}`);

    const beforeSearchInputFocusCount = searchButtonHover.inputEventsForwarded;
    const beforeSearchInputFocusDirtyRects = searchButtonHover.dirtyRectsObserved;
    await clickNetSurfCanvasPixel(canvasLocator, 200, 202);
    const searchInputFocus = await waitForNetSurfRegionMetrics(
      page,
      {
        searchInput: {
          region: { x: 105, y: 188, width: 405, height: 30 },
          metrics: { black: 0, nonGrey: 12150, nonWhite: 2219, hash: 2219368695 },
        },
        status: {
          region: { x: 0, y: 462, width: 620, height: 18 },
          metrics: { black: 734, nonGrey: 2038, nonWhite: 11160, hash: 2169014071 },
        },
      },
      beforeSearchInputFocusDirtyRects,
    );
    assert.equal(searchInputFocus.lastInputEvent.type, 'pointerup-button');
    assert.ok(searchInputFocus.inputEventsForwarded >= beforeSearchInputFocusCount + 3, `expected search input focus click forwarding, got ${JSON.stringify(searchInputFocus)}`);
    assert.deepEqual(searchInputFocus.lastInputEvent.detail, { button: 0 });
    assert.deepEqual(
      searchInputFocus.metrics.searchInput,
      { black: 0, nonGrey: 12150, nonWhite: 2219, hash: 2219368695 },
      `expected click to visibly focus the about:welcome search text field, got ${JSON.stringify(searchInputFocus)}`,
    );

    const beforeSearchTypingCount = searchInputFocus.inputEventsForwarded;
    const beforeSearchTypingDirtyRects = searchInputFocus.dirtyRectsObserved;
    await page.keyboard.type('net');
    const searchTypedText = await waitForNetSurfRegionMetrics(
      page,
      {
        searchInput: {
          region: { x: 105, y: 188, width: 405, height: 30 },
          metrics: { black: 117, nonGrey: 12150, nonWhite: 2337, hash: 1988530126 },
        },
        searchPanel: {
          region: { x: 65, y: 175, width: 505, height: 140 },
          metrics: { black: 641, nonGrey: 70700, nonWhite: 38527, hash: 2488143580 },
        },
      },
      beforeSearchTypingDirtyRects,
    );
    assert.equal(searchTypedText.lastInputEvent.type, 'keyup');
    assert.equal(searchTypedText.lastInputEvent.detail.key, 't');
    assert.equal(searchTypedText.lastInputEvent.detail.nsfb, 116);
    assert.ok(searchTypedText.inputEventsForwarded >= beforeSearchTypingCount + 6, `expected typing in about:welcome search field to forward keydown/keyup events, got ${JSON.stringify(searchTypedText)}`);
    assert.deepEqual(
      searchTypedText.metrics.searchInput,
      { black: 117, nonGrey: 12150, nonWhite: 2337, hash: 1988530126 },
      `expected typed search text to visibly rasterize in the about:welcome search field, got ${JSON.stringify(searchTypedText)}`,
    );

    const beforeSearchBackspaceCount = searchTypedText.inputEventsForwarded;
    await page.keyboard.press('Backspace');
    const searchBackspaceEdit = await waitForNetSurfRegionMetrics(
      page,
      {
        searchInput: {
          region: { x: 105, y: 188, width: 405, height: 30 },
          metrics: { black: 82, nonGrey: 12150, nonWhite: 2302, hash: 912445780 },
        },
        searchPanel: {
          region: { x: 65, y: 175, width: 505, height: 140 },
          metrics: { black: 606, nonGrey: 70700, nonWhite: 38492, hash: 1938210838 },
        },
      },
      searchTypedText.dirtyRectsObserved,
    );
    assert.equal(searchBackspaceEdit.lastInputEvent.type, 'keyup');
    assert.equal(searchBackspaceEdit.lastInputEvent.detail.key, 'Backspace');
    assert.equal(searchBackspaceEdit.lastInputEvent.detail.nsfb, 8);
    assert.ok(searchBackspaceEdit.inputEventsForwarded >= beforeSearchBackspaceCount + 2, `expected about:welcome search Backspace editing to forward keydown/keyup events, got ${JSON.stringify(searchBackspaceEdit)}`);
    assert.deepEqual(
      searchBackspaceEdit.metrics.searchInput,
      { black: 82, nonGrey: 12150, nonWhite: 2302, hash: 912445780 },
      `expected Backspace to visibly remove one about:welcome search glyph, got ${JSON.stringify(searchBackspaceEdit)}`,
    );

    await page.keyboard.press('ArrowLeft');
    const searchCaretLeft = await waitForNetSurfRegionMetrics(
      page,
      {
        searchInput: {
          region: { x: 105, y: 188, width: 405, height: 30 },
          metrics: { black: 76, nonGrey: 12150, nonWhite: 2295, hash: 3678718635 },
        },
        searchPanel: {
          region: { x: 65, y: 175, width: 505, height: 140 },
          metrics: { black: 600, nonGrey: 70700, nonWhite: 38485, hash: 437836191 },
        },
      },
      searchBackspaceEdit.dirtyRectsObserved,
    );
    assert.equal(searchCaretLeft.lastInputEvent.type, 'keyup');
    assert.equal(searchCaretLeft.lastInputEvent.detail.key, 'ArrowLeft');
    assert.equal(searchCaretLeft.lastInputEvent.detail.nsfb, 276);
    assert.deepEqual(
      searchCaretLeft.metrics.searchInput,
      { black: 76, nonGrey: 12150, nonWhite: 2295, hash: 3678718635 },
      `expected ArrowLeft to visibly move the about:welcome search caret within the typed text, got ${JSON.stringify(searchCaretLeft)}`,
    );

    await page.keyboard.press('ArrowRight');
    const searchCaretRight = await waitForNetSurfRegionMetrics(
      page,
      {
        searchInput: {
          region: { x: 105, y: 188, width: 405, height: 30 },
          metrics: { black: 82, nonGrey: 12150, nonWhite: 2301, hash: 2625769707 },
        },
        searchPanel: {
          region: { x: 65, y: 175, width: 505, height: 140 },
          metrics: { black: 606, nonGrey: 70700, nonWhite: 38491, hash: 3868158559 },
        },
      },
      searchCaretLeft.dirtyRectsObserved,
    );
    assert.equal(searchCaretRight.lastInputEvent.type, 'keyup');
    assert.equal(searchCaretRight.lastInputEvent.detail.key, 'ArrowRight');
    assert.equal(searchCaretRight.lastInputEvent.detail.nsfb, 275);
    assert.deepEqual(
      searchCaretRight.metrics.searchInput,
      { black: 82, nonGrey: 12150, nonWhite: 2301, hash: 2625769707 },
      `expected ArrowRight to visibly restore the about:welcome search caret to the field end, got ${JSON.stringify(searchCaretRight)}`,
    );

    await page.keyboard.type('t');
    const searchTextRestored = await waitForNetSurfRegionMetrics(
      page,
      {
        searchInput: {
          region: { x: 105, y: 188, width: 405, height: 30 },
          metrics: { black: 117, nonGrey: 12150, nonWhite: 2337, hash: 1988530126 },
        },
        searchPanel: {
          region: { x: 65, y: 175, width: 505, height: 140 },
          metrics: { black: 641, nonGrey: 70700, nonWhite: 38527, hash: 2488143580 },
        },
      },
      searchCaretRight.dirtyRectsObserved,
    );
    assert.equal(searchTextRestored.lastInputEvent.type, 'keyup');
    assert.equal(searchTextRestored.lastInputEvent.detail.key, 't');
    assert.equal(searchTextRestored.lastInputEvent.detail.nsfb, 116);
    assert.deepEqual(
      searchTextRestored.metrics.searchInput,
      { black: 117, nonGrey: 12150, nonWhite: 2337, hash: 1988530126 },
      `expected retyping the final about:welcome search glyph to restore the deterministic field raster before submit, got ${JSON.stringify(searchTextRestored)}`,
    );

    const beforeSearchSubmitDirtyRects = searchTextRestored.dirtyRectsObserved;
    await clickNetSurfCanvasPixel(canvasLocator, 315, 240);
    const searchSubmit = await waitForNetSurfRegionMetrics(
      page,
      {
        status: {
          region: { x: 0, y: 462, width: 620, height: 18 },
          metrics: { black: 382, nonGrey: 1686, nonWhite: 11160, hash: 2143802459 },
        },
        address: {
          region: { x: 95, y: 3, width: 520, height: 28 },
          metrics: { black: 1424, nonGrey: 12610, nonWhite: 4570, hash: 1780460690 },
        },
        content: {
          region: { x: 0, y: 36, width: 640, height: 426 },
          metrics: { black: 1278, nonGrey: 267668, nonWhite: 272453, hash: 1306608447 },
        },
      },
      beforeSearchSubmitDirtyRects,
    );
    assert.equal(searchSubmit.lastInputEvent.type, 'pointerup-button');
    assert.equal(searchSubmit.inputEventsDropped, 0, `expected no dropped input events through search form submit, got ${JSON.stringify(searchSubmit)}`);
    assert.deepEqual(
      searchSubmit.metrics.status,
      { black: 382, nonGrey: 1686, nonWhite: 11160, hash: 2143802459 },
      `expected search form submit to visibly rasterize a deterministic offline status-bar effect, got ${JSON.stringify(searchSubmit)}`,
    );
    assert.deepEqual(
      searchSubmit.metrics.address,
      { black: 1424, nonGrey: 12610, nonWhite: 4570, hash: 1780460690 },
      `expected search form submit to visibly update the toolbar address raster without hard-coded networking, got ${JSON.stringify(searchSubmit)}`,
    );
  } finally {
    await closePage(page);
  }
});

test('NetSurf about:welcome search form also submits via Enter with deterministic rasters', { timeout: 25_000 }, async () => {
  const page = await newAppPage();
  try {
    await page.goto(`${APP_URL}browsers/netsurf/`, { waitUntil: 'domcontentloaded' });
    await page.locator('body[data-netsurf-framebuffer-visible="true"]').waitFor({ state: 'attached' });
    await page.locator('#viewport').waitFor({ state: 'visible' });
    await waitForNetSurfVisibleTextSignatures(page);

    const canvasLocator = page.locator('#viewport');
    const searchFormRevealed = await revealNetSurfWelcomeSearchForm(page, canvasLocator);

    const beforeSearchInputFocusCount = searchFormRevealed.inputEventsForwarded;
    await clickNetSurfCanvasPixel(canvasLocator, 200, 202);
    const searchInputFocus = await waitForNetSurfRegionMetrics(
      page,
      {
        searchInput: {
          region: { x: 105, y: 188, width: 405, height: 30 },
          metrics: { black: 0, nonGrey: 12150, nonWhite: 2219, hash: 2219368695 },
        },
      },
      searchFormRevealed.dirtyRectsObserved,
    );
    assert.equal(searchInputFocus.lastInputEvent.type, 'pointerup-button');
    assert.ok(searchInputFocus.inputEventsForwarded >= beforeSearchInputFocusCount + 3, `expected Enter-submit search input focus click forwarding, got ${JSON.stringify(searchInputFocus)}`);

    const beforeSearchTypingCount = searchInputFocus.inputEventsForwarded;
    await page.keyboard.type('net');
    const searchTypedText = await waitForNetSurfRegionMetrics(
      page,
      {
        searchInput: {
          region: { x: 105, y: 188, width: 405, height: 30 },
          metrics: { black: 117, nonGrey: 12150, nonWhite: 2337, hash: 1988530126 },
        },
      },
      searchInputFocus.dirtyRectsObserved,
    );
    assert.equal(searchTypedText.lastInputEvent.type, 'keyup');
    assert.equal(searchTypedText.lastInputEvent.detail.key, 't');
    assert.ok(searchTypedText.inputEventsForwarded >= beforeSearchTypingCount + 6, `expected Enter-submit search typing to forward keydown/keyup events, got ${JSON.stringify(searchTypedText)}`);

    await page.keyboard.press('Enter');
    const searchSubmitByEnter = await waitForNetSurfRegionMetrics(
      page,
      {
        status: {
          region: { x: 0, y: 462, width: 620, height: 18 },
          metrics: { black: 382, nonGrey: 1686, nonWhite: 11160, hash: 2143802459 },
        },
        address: {
          region: { x: 95, y: 3, width: 520, height: 28 },
          metrics: { black: 1424, nonGrey: 12610, nonWhite: 4570, hash: 1780460690 },
        },
        content: {
          region: { x: 0, y: 36, width: 640, height: 426 },
          metrics: { black: 1278, nonGrey: 267668, nonWhite: 272453, hash: 1306608447 },
        },
      },
      searchTypedText.dirtyRectsObserved,
    );
    assert.equal(searchSubmitByEnter.lastInputEvent.type, 'keyup');
    assert.equal(searchSubmitByEnter.lastInputEvent.detail.key, 'Enter');
    assert.equal(searchSubmitByEnter.lastInputEvent.detail.nsfb, 13);
    assert.equal(searchSubmitByEnter.inputEventsDropped, 0, `expected no dropped input events through Enter search submit, got ${JSON.stringify(searchSubmitByEnter)}`);
    assert.deepEqual(
      searchSubmitByEnter.metrics,
      {
        status: { black: 382, nonGrey: 1686, nonWhite: 11160, hash: 2143802459 },
        address: { black: 1424, nonGrey: 12610, nonWhite: 4570, hash: 1780460690 },
        content: { black: 1278, nonGrey: 267668, nonWhite: 272453, hash: 1306608447 },
      },
      `expected Enter search submit to match deterministic offline status/address/content rasters without hard-coded networking, got ${JSON.stringify(searchSubmitByEnter)}`,
    );
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
