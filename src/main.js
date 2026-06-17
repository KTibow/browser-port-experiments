import './styles.css';
import { DEFAULT_WISP_URL, browsers, getBrowser, plannedPorts } from './registry.js';
import { installBrowserPortWisp, normalizeWispUrl, runWispDiagnostic, writeWispEndpoint } from './wisp-bridge.js';

installBrowserPortWisp();

const STORAGE_KEYS = {
  wispUrl: 'browser-port-experiments:wisp-url',
  homeUrl: 'browser-port-experiments:home-url',
};

function readSetting(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function writeSetting(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures in locked-down browsing contexts.
  }
}

function normalizeUrl(input) {
  const trimmed = input.trim();
  if (!trimmed) return 'about:blank';
  if (/^(about:|data:|blob:|https?:\/\/)/i.test(trimmed)) return trimmed;
  if (/^[\w.-]+\.[a-z]{2,}([/:?#].*)?$/i.test(trimmed)) return `https://${trimmed}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function shell() {
  const app = document.querySelector('#app');
  app.innerHTML = '';
  return app;
}

function renderHeader(activeId = '') {
  return `
    <header class="site-header">
      <a class="brand" href="#/">
        <span class="brand-mark">▣</span>
        <span>Browser Port Experiments</span>
      </a>
      <nav aria-label="Browsers">
        <a class="nav-link ${activeId === 'wisp-diagnostic' ? 'active' : ''}" href="#/wisp">Wisp diagnostic</a>
        ${browsers
          .map(
            (browser) =>
              `<a class="nav-link ${browser.id === activeId ? 'active' : ''}" href="${browser.path}">${browser.name}</a>`,
          )
          .join('')}
      </nav>
    </header>`;
}

function renderHome() {
  const app = shell();
  app.innerHTML = `
    ${renderHeader()}
    <main class="container">
      <section class="hero">
        <p class="eyebrow">GitHub Pages target: /browser-port-experiments/</p>
        <h1>Useful browser ports, runnable entirely in the web.</h1>
        <p>
          This repository is an orchestration workspace for bringing independent browsers and engines to WASM/canvas/WebGPU.
          The page below is the public launchpad and test surface for every port as it lands.
        </p>
        <div class="hero-actions">
          <a class="button primary" href="${browsers[0].path}">Open current working browser</a>
          <a class="button" href="#/wisp">Test Wisp networking</a>
          <a class="button" href="https://github.com/KTibow/browser-port-experiments">Repository</a>
        </div>
      </section>

      <section class="panel">
        <div class="panel-heading">
          <h2>Available browsers</h2>
          <p>Only entries with runnable pages are linked here.</p>
        </div>
        <div class="cards">
          ${browsers
            .map(
              (browser) => `
                <article class="card">
                  <div class="status ${browser.status}">${browser.status}</div>
                  <h3>${browser.name}</h3>
                  <p>${browser.summary}</p>
                  <dl>
                    <dt>Engine</dt><dd>${browser.engine}</dd>
                    <dt>Networking</dt><dd>${browser.networking}</dd>
                    <dt>Verified</dt><dd>${browser.tested}</dd>
                  </dl>
                  <a class="button" href="${browser.path}">Launch</a>
                </article>`,
            )
            .join('')}
        </div>
      </section>

      <section class="panel">
        <div class="panel-heading">
          <h2>Orchestrated work queue</h2>
          <p>Next agents should claim one lane, produce a runnable artifact, test it, commit, push, and dispatch a successor.</p>
        </div>
        <ol class="planned-list">
          ${plannedPorts
            .map(
              (port) => `
                <li>
                  <strong>${port.name}</strong>
                  <span>Priority ${port.priority}</span>
                  <p>${port.rationale}</p>
                  ${port.artifactPath ? `<a class="text-link" href="${port.artifactPath}">Open current probe artifact</a>` : ''}
                </li>`,
            )
            .join('')}
        </ol>
      </section>
    </main>`;
}

function renderWispDiagnostic() {
  const app = shell();
  const wispUrl = readSetting(STORAGE_KEYS.wispUrl, DEFAULT_WISP_URL);
  app.innerHTML = `
    ${renderHeader('wisp-diagnostic')}
    <main class="container">
      <section class="panel wisp-panel">
        <div class="panel-heading">
          <h1>Wisp networking diagnostic</h1>
          <p>
            Browser ports can use <code>window.BrowserPortWisp</code> to open TCP streams through a Wisp websocket.
            The default endpoint is <code>${DEFAULT_WISP_URL}</code> and this check performs a plain HTTP request to <code>example.com:80</code>.
          </p>
        </div>
        <form class="diagnostic-form" id="wisp-form">
          <label>
            Wisp endpoint
            <input id="wisp-url" autocomplete="url" spellcheck="false" value="${escapeHtml(wispUrl)}" />
          </label>
          <label>
            Target host
            <input id="wisp-host" value="example.com" />
          </label>
          <label>
            TCP port
            <input id="wisp-port" inputmode="numeric" value="80" />
          </label>
          <label>
            HTTP path
            <input id="wisp-path" value="/" />
          </label>
          <button class="button primary" type="submit">Run diagnostic</button>
        </form>
        <pre class="diagnostic-output" id="wisp-output">Ready. Click “Run diagnostic” to open a Wisp websocket and TCP stream.</pre>
      </section>
    </main>`;

  const form = document.querySelector('#wisp-form');
  const output = document.querySelector('#wisp-output');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const endpointInput = document.querySelector('#wisp-url').value;
    const host = document.querySelector('#wisp-host').value.trim();
    const port = Number(document.querySelector('#wisp-port').value);
    const path = document.querySelector('#wisp-path').value.trim() || '/';
    try {
      const endpoint = writeWispEndpoint(normalizeWispUrl(endpointInput));
      output.textContent = `Connecting to ${endpoint} …`;
      const result = await runWispDiagnostic({ endpoint, host, port, path });
      output.textContent = JSON.stringify(result, null, 2);
    } catch (error) {
      output.textContent = error instanceof Error ? error.stack || error.message : String(error);
    }
  });
}

function renderBrowser(id) {
  const browser = getBrowser(id);
  if (!browser) {
    location.hash = '#/';
    return;
  }
  const app = shell();
  const homeUrl = readSetting(STORAGE_KEYS.homeUrl, 'https://example.com/');
  const wispUrl = readSetting(STORAGE_KEYS.wispUrl, DEFAULT_WISP_URL);
  const escapedHomeUrl = escapeHtml(homeUrl);
  const escapedWispUrl = escapeHtml(wispUrl);
  const escapedFrameUrl = escapeHtml(normalizeUrl(homeUrl));
  app.innerHTML = `
    ${renderHeader(id)}
    <main class="browser-page">
      <section class="browser-toolbar" aria-label="Browser controls">
        <button class="tool-button" id="back" title="Back">←</button>
        <button class="tool-button" id="forward" title="Forward">→</button>
        <button class="tool-button" id="reload" title="Reload">↻</button>
        <button class="tool-button" id="home" title="Home">⌂</button>
        <form class="url-form" id="url-form">
          <label class="sr-only" for="url-input">Address</label>
          <input id="url-input" autocomplete="url" spellcheck="false" value="${escapedHomeUrl}" />
          <button class="button primary" type="submit">Go</button>
        </form>
      </section>
      <section class="engine-layout">
        <aside class="engine-info">
          <h1>${browser.name}</h1>
          <p>${browser.summary}</p>
          <label>
            Wisp endpoint for WASM ports
            <input id="wisp-input" value="${escapedWispUrl}" />
          </label>
          <button class="button" id="save-settings">Save settings</button>
          <h2>Known limitations</h2>
          <ul>${browser.limitations.map((item) => `<li>${item}</li>`).join('')}</ul>
        </aside>
        <div class="viewport-wrap">
          <iframe
            id="browser-frame"
            title="${browser.name} viewport"
            sandbox="allow-forms allow-modals allow-pointer-lock allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
            referrerpolicy="no-referrer"
            src="${escapedFrameUrl}"
          ></iframe>
        </div>
      </section>
    </main>`;

  const frame = document.querySelector('#browser-frame');
  const input = document.querySelector('#url-input');
  const form = document.querySelector('#url-form');
  const setFrameUrl = (value) => {
    const nextUrl = normalizeUrl(value);
    input.value = nextUrl;
    frame.src = nextUrl;
    writeSetting(STORAGE_KEYS.homeUrl, nextUrl);
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    setFrameUrl(input.value);
  });
  document.querySelector('#reload').addEventListener('click', () => {
    try {
      frame.contentWindow.location.reload();
    } catch {
      frame.src = frame.src;
    }
  });
  document.querySelector('#home').addEventListener('click', () => setFrameUrl(readSetting(STORAGE_KEYS.homeUrl, homeUrl)));
  document.querySelector('#back').addEventListener('click', () => {
    try {
      frame.contentWindow.history.back();
    } catch {
      history.back();
    }
  });
  document.querySelector('#forward').addEventListener('click', () => {
    try {
      frame.contentWindow.history.forward();
    } catch {
      history.forward();
    }
  });
  document.querySelector('#save-settings').addEventListener('click', () => {
    writeSetting(STORAGE_KEYS.wispUrl, document.querySelector('#wisp-input').value.trim() || DEFAULT_WISP_URL);
  });
}

function route() {
  const [, page, id] = location.hash.match(/^#\/(browser)?\/?([^/]*)?/) || [];
  if (page === 'browser') renderBrowser(id);
  else if (location.hash === '#/wisp') renderWispDiagnostic();
  else renderHome();
}

window.addEventListener('hashchange', route);
route();
