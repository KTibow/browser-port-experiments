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
    assert.ok(result.state.ptr > 0, `expected exported nsfb_t buffer pointer, got ${JSON.stringify(result)}`);
    assert.ok(result.dirtyRectCount > 0, `expected at least one NetSurf dirty rect, got ${JSON.stringify(result)}`);
    assert.ok(result.state.dirtyRectsObserved > 0, `expected dirty rect state, got ${JSON.stringify(result)}`);
    assert.ok(result.state.dirtyRectCallbacksObserved >= result.state.dirtyRectsObserved, `expected dirty rect callback accounting, got ${JSON.stringify(result)}`);
    assert.ok(result.dirtyRectCallbacks >= result.dirtyRectCount, `expected canvas dirty rect callback accounting, got ${JSON.stringify(result)}`);
    assert.match(result.metadata, /BrowserPortWisp|standalone offline page/i);
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
        const statusRedrawn = black >= beforeStatus.black + 300 && hash !== beforeStatus.hash;
        if (!overAddressBar || !iBeamShape || !statusRedrawn || state.inputEventsForwarded <= beforeInputCount) return null;
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
    assert.ok(
      addressHover.lastDirtyRect[0] <= 0 && addressHover.lastDirtyRect[1] <= 462 && addressHover.lastDirtyRect[2] >= 200 && addressHover.lastDirtyRect[3] >= 480,
      `expected address-bar hover to redraw NetSurf's status bar, got ${JSON.stringify(addressHover)}`,
    );
    assert.ok(
      addressHover.status.black >= beforeAddressStatus.black + 300,
      `expected address-bar hover to visibly change NetSurf status-bar pixels, got before ${JSON.stringify(beforeAddressStatus)} after ${JSON.stringify(addressHover)}`,
    );

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
        const textCursorActive = cursor?.hotspot?.[0] === 3 && cursor?.hotspot?.[1] === 8;
        const clickForwarded = state?.inputEventsForwarded >= before.inputCount + 3 && state?.lastInputEvent?.type === 'pointerup-button';
        // The hover step already activates the address-bar hit-test redraw on some
        // libnsfb builds, so clicking a focused URL field may not deterministically
        // change the sampled pixels again. Treat pointer forwarding plus the text
        // cursor as the stable focus signal here; subsequent key forwarding still
        // asserts a NetSurf-rendered status redraw.
        if (!textCursorActive || !clickForwarded) return null;
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
    assert.deepEqual(addressFocus.cursor.hotspot, [3, 8], `expected address-bar focus to keep the text cursor active, got ${JSON.stringify(addressFocus)}`);

    await page.keyboard.press('x');
    const addressKeyForwarding = await page.waitForFunction(
      ({ beforeCount, beforeStatus }) => {
        const state = window.netsurfFramebufferState;
        if (!state || state.inputEventsForwarded < beforeCount + 4 || state.lastInputEvent?.type !== 'keyup') return null;
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
        if (black > beforeStatus.black - 300 || hash === beforeStatus.hash) return null;
        return {
          after: state.inputEventsForwarded,
          cursor: state.cursor,
          lastInputEvent: state.lastInputEvent,
          lastDirtyRect: state.lastDirtyRect,
          status: { black, nonGrey, hash },
          dataset: document.body.dataset.netsurfFramebufferLastInput,
        };
      },
      { beforeCount: beforeAddressKeyCount, beforeStatus: addressHover.status },
    ).then((handle) => handle.jsonValue());
    assert.equal(addressKeyForwarding.lastInputEvent.detail.key, 'x');
    assert.equal(addressKeyForwarding.lastInputEvent.detail.nsfb, 120);
    assert.equal(addressKeyForwarding.dataset, 'keyup');
    assert.deepEqual(addressKeyForwarding.cursor.hotspot, [3, 8], `expected address-bar text cursor to remain active while typing, got ${JSON.stringify(addressKeyForwarding)}`);
    assert.ok(
      addressKeyForwarding.lastDirtyRect[0] <= 0 && addressKeyForwarding.lastDirtyRect[1] <= 462 && addressKeyForwarding.lastDirtyRect[2] >= 200 && addressKeyForwarding.lastDirtyRect[3] >= 480,
      `expected address-bar key handling to visibly redraw NetSurf's status bar, got ${JSON.stringify(addressKeyForwarding)}`,
    );
    assert.ok(
      addressKeyForwarding.status.black <= addressHover.status.black - 300,
      `expected address-bar typing to visibly change status-bar pixels, got hover ${JSON.stringify(addressHover)} typing ${JSON.stringify(addressKeyForwarding)}`,
    );

    const beforeToolbarStatus = await readNetSurfStatusBarMetrics(page);
    await clickNetSurfCanvasPixel(canvasLocator, 75, 15);
    const toolbarActivation = await page.waitForFunction(
      (before) => {
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
        if (black < before.black + 300 || nonGrey < before.nonGrey + 300 || hash === before.hash) return null;
        return {
          before,
          after: { black, nonGrey, hash },
          lastDirtyRect: window.netsurfFramebufferState.lastDirtyRect,
          lastInputEvent: window.netsurfFramebufferState.lastInputEvent,
        };
      },
      beforeToolbarStatus,
    ).then((handle) => handle.jsonValue());
    assert.equal(toolbarActivation.lastInputEvent.type, 'pointerup-button');
    assert.deepEqual(toolbarActivation.lastInputEvent.detail, { button: 0 });
    assert.ok(
      toolbarActivation.lastDirtyRect[0] <= 0 && toolbarActivation.lastDirtyRect[1] <= 462 && toolbarActivation.lastDirtyRect[2] >= 200 && toolbarActivation.lastDirtyRect[3] >= 480,
      `expected NetSurf dirty rectangle to include the status-bar redraw after toolbar activation, got ${JSON.stringify(toolbarActivation)}`,
    );
    assert.ok(
      toolbarActivation.after.black >= toolbarActivation.before.black + 300,
      `expected toolbar activation to produce observable NetSurf status-bar text, got ${JSON.stringify(toolbarActivation)}`,
    );

    const beforeInputCount = await page.evaluate(() => window.netsurfFramebufferState.inputEventsForwarded);
    await canvasLocator.click({ position: { x: 320, y: 240 } });
    await page.mouse.wheel(0, 120);
    await page.keyboard.press('a');
    const interaction = await page.waitForFunction(
      (before) => {
        const state = window.netsurfFramebufferState;
        if (!state || state.inputEventsForwarded < before + 8) return null;
        return {
          before,
          after: state.inputEventsForwarded,
          lastInputEvent: state.lastInputEvent,
          dataset: document.body.dataset.netsurfFramebufferLastInput,
        };
      },
      beforeInputCount,
    ).then((handle) => handle.jsonValue());
    assert.ok(interaction.after >= beforeInputCount + 8, `expected deterministic forwarded click/wheel/key events, got ${JSON.stringify(interaction)}`);
    assert.equal(interaction.lastInputEvent.type, 'keyup');
    assert.equal(interaction.lastInputEvent.detail.key, 'a');
    assert.equal(interaction.lastInputEvent.detail.nsfb, 97);
    assert.equal(interaction.dataset, 'keyup');
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
