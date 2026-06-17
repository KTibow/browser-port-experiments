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
        content: { x: 0, y: 36, width: 640, height: 426 },
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

test('NetSurf public page paints deterministic dirty-rect framebuffer pixels', { timeout: 35_000 }, async () => {
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
        content: { black: 596, nonGrey: 267611, nonWhite: 266865, hash: 651458069 },
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
        content: { black: 596, nonGrey: 267611, nonWhite: 266865, hash: 651458069 },
      },
      `expected NetSurf toolbar Back action to visibly navigate away from about:welcome chrome/content, got ${JSON.stringify(toolbarBackNavigation)}`,
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
      { text: 'é', inputType: 'insertText', isComposing: false, trusted: true, compositionActive: false, forwardedCharacters: 1 },
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
      { text: 'é', inputType: 'insertCompositionText', isComposing: true, trusted: true, compositionActive: true, forwardedCharacters: 0 },
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
      { text: 'é', inputType: 'insertText', isComposing: false, trusted: true, compositionActive: false, forwardedCharacters: 1 },
      `expected committed trusted IME text metadata, got ${JSON.stringify(trustedImeCommitCoverage)}`,
    );
    const trustedImeByTypeAndCode = new Map(
      trustedImeCommitCoverage.history
        .filter((event) => event.detail && Number.isFinite(event.detail.nsfb))
        .map((event) => [`${event.type}:${event.detail.nsfb}`, event.detail]),
    );
    assert.equal(trustedImeByTypeAndCode.get('beforeinput-keydown:233')?.char, 'é', `expected trusted IME commit keydown mapping, got ${JSON.stringify(trustedImeCommitCoverage)}`);
    assert.equal(trustedImeByTypeAndCode.get('beforeinput-keyup:233')?.source, 'beforeinput', `expected trusted IME commit keyup mapping, got ${JSON.stringify(trustedImeCommitCoverage)}`);

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
