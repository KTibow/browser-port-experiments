import { client as wisp } from '@mercuryworkshop/wisp-js/client';
import { DEFAULT_WISP_URL } from './registry.js';

export const WISP_STORAGE_KEY = 'browser-port-experiments:wisp-url';
export const DEFAULT_WISP_TIMEOUT_MS = 8000;
export const DEFAULT_DIAGNOSTIC_TARGET = Object.freeze({
  host: 'example.com',
  port: 80,
  path: '/',
});

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function normalizeWispUrl(input = DEFAULT_WISP_URL) {
  const trimmed = String(input || '').trim() || DEFAULT_WISP_URL;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `wss://${trimmed}`;
  const websocketUrl = withScheme.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  const parsed = new URL(websocketUrl);
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new TypeError(`Wisp endpoints must use ws:// or wss://, received ${parsed.protocol}`);
  }
  if (!parsed.pathname.endsWith('/')) {
    parsed.pathname = `${parsed.pathname}/`;
  }
  return parsed.toString();
}

export function readWispEndpoint(storage = globalThis.localStorage) {
  try {
    return normalizeWispUrl(storage?.getItem(WISP_STORAGE_KEY) || DEFAULT_WISP_URL);
  } catch {
    return DEFAULT_WISP_URL;
  }
}

export function writeWispEndpoint(endpoint, storage = globalThis.localStorage) {
  const normalized = normalizeWispUrl(endpoint);
  try {
    storage?.setItem(WISP_STORAGE_KEY, normalized);
  } catch {
    // Storage may be unavailable in sandboxed or private contexts.
  }
  return normalized;
}

function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

export function connectWisp(endpoint = readWispEndpoint(), options = {}) {
  const { timeoutMs = DEFAULT_WISP_TIMEOUT_MS, clientOptions = { wisp_version: 2 } } = options;
  const normalizedEndpoint = normalizeWispUrl(endpoint);
  const connection = new wisp.ClientConnection(normalizedEndpoint, clientOptions);
  const opened = new Promise((resolve, reject) => {
    connection.onopen = () => resolve(connection);
    connection.onerror = () => reject(new Error(`Failed to connect to Wisp endpoint ${normalizedEndpoint}`));
    connection.onclose = () => {
      if (!connection.connected) reject(new Error(`Wisp endpoint ${normalizedEndpoint} closed before opening`));
    };
  });
  return withTimeout(opened, timeoutMs, 'Wisp connection');
}

export async function openWispTcpStream({ endpoint = readWispEndpoint(), host, port, timeoutMs = DEFAULT_WISP_TIMEOUT_MS } = {}) {
  if (!host) throw new TypeError('openWispTcpStream requires a host');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('openWispTcpStream requires a TCP port from 1 to 65535');
  }

  const connection = await connectWisp(endpoint, { timeoutMs });
  const stream = connection.create_stream(host, port, 'tcp');
  return {
    connection,
    stream,
    send(data) {
      stream.send(toUint8Array(data));
    },
    close(reason = 0x02) {
      try {
        stream.close(reason);
      } finally {
        closeWispConnection(connection);
      }
    },
  };
}

export function toUint8Array(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === 'string') return textEncoder.encode(data);
  throw new TypeError('Wisp stream data must be a string, ArrayBuffer, Uint8Array, or typed array');
}

export function buildHttpRequest({ host, port = 80, method = 'GET', path = '/', headers = {}, body = '' } = {}) {
  if (!host) throw new TypeError('buildHttpRequest requires a host');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const bodyBytes = toUint8Array(body);
  const headerPairs = {
    Host: port === 80 ? host : `${host}:${port}`,
    Connection: 'close',
    'User-Agent': 'browser-port-experiments-wisp-diagnostic/0.1',
    ...headers,
  };
  if (bodyBytes.byteLength > 0 && !Object.keys(headerPairs).some((name) => name.toLowerCase() === 'content-length')) {
    headerPairs['Content-Length'] = String(bodyBytes.byteLength);
  }
  const head = `${method.toUpperCase()} ${normalizedPath} HTTP/1.1\r\n${Object.entries(headerPairs)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\r\n')}\r\n\r\n`;
  const headBytes = textEncoder.encode(head);
  const request = new Uint8Array(headBytes.byteLength + bodyBytes.byteLength);
  request.set(headBytes, 0);
  request.set(bodyBytes, headBytes.byteLength);
  return request;
}

export function parseHttpResponse(bytes) {
  const responseText = textDecoder.decode(toUint8Array(bytes));
  const headerEnd = responseText.indexOf('\r\n\r\n');
  const headerText = headerEnd >= 0 ? responseText.slice(0, headerEnd) : responseText;
  const body = headerEnd >= 0 ? responseText.slice(headerEnd + 4) : '';
  const [statusLine = '', ...headerLines] = headerText.split('\r\n');
  const statusMatch = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})\s*(.*)$/i);
  const headers = Object.fromEntries(
    headerLines
      .map((line) => line.match(/^([^:]+):\s*(.*)$/))
      .filter(Boolean)
      .map((match) => [match[1].toLowerCase(), match[2]]),
  );
  return {
    statusLine,
    status: statusMatch ? Number(statusMatch[1]) : null,
    statusText: statusMatch ? statusMatch[2] : '',
    headers,
    body,
  };
}

export async function httpOverWisp({
  endpoint = readWispEndpoint(),
  host,
  port = 80,
  method = 'GET',
  path = '/',
  headers = {},
  body = '',
  timeoutMs = DEFAULT_WISP_TIMEOUT_MS,
} = {}) {
  const startedAt = performance.now();
  const tcp = await openWispTcpStream({ endpoint, host, port, timeoutMs });
  const chunks = [];
  const received = new Promise((resolve, reject) => {
    tcp.stream.onmessage = (chunk) => chunks.push(toUint8Array(chunk));
    tcp.stream.onclose = (reason) => {
      if (reason && reason !== 0x02 && chunks.length === 0) {
        reject(new Error(`Wisp stream closed before data arrived, reason 0x${reason.toString(16)}`));
      } else {
        resolve(reason);
      }
    };
  });

  try {
    tcp.send(buildHttpRequest({ host, port, method, path, headers, body }));
    const closeReason = await withTimeout(received, timeoutMs, 'Wisp HTTP request');
    const bytes = concatUint8Arrays(chunks);
    return {
      endpoint: normalizeWispUrl(endpoint),
      host,
      port,
      path,
      closeReason,
      elapsedMs: Math.round(performance.now() - startedAt),
      bytes,
      response: parseHttpResponse(bytes),
    };
  } finally {
    closeWispConnection(tcp.connection);
  }
}

function closeWispConnection(connection) {
  try {
    connection.close();
  } catch {
    // Ignore close races; this is cleanup after a stream has already completed or failed.
  }
  // The Node `ws` implementation can keep the event loop alive while waiting for a
  // close handshake. Browsers do not expose `terminate`, so this remains a no-op in
  // the public app but lets CLI diagnostics exit promptly.
  if (typeof connection.ws?.terminate === 'function') {
    connection.ws.terminate();
  }
}

export async function runWispDiagnostic(options = {}) {
  const target = { ...DEFAULT_DIAGNOSTIC_TARGET, ...options };
  const startedAt = performance.now();
  try {
    const result = await httpOverWisp(target);
    return {
      ok: Boolean(result.response.status && result.response.status < 500),
      endpoint: result.endpoint,
      target: `${result.host}:${result.port}${result.path}`,
      elapsedMs: result.elapsedMs,
      bytesReceived: result.bytes.byteLength,
      statusLine: result.response.statusLine,
      bodyPreview: result.response.body.slice(0, 240),
    };
  } catch (error) {
    return {
      ok: false,
      endpoint: normalizeWispUrl(target.endpoint || readWispEndpoint()),
      target: `${target.host}:${target.port}${target.path}`,
      elapsedMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function concatUint8Arrays(chunks) {
  const byteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const merged = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

export function installBrowserPortWisp(globalObject = globalThis) {
  const api = {
    defaultEndpoint: DEFAULT_WISP_URL,
    normalizeWispUrl,
    readEndpoint: readWispEndpoint,
    writeEndpoint: writeWispEndpoint,
    connect: connectWisp,
    openTcpStream: openWispTcpStream,
    http: httpOverWisp,
    diagnose: runWispDiagnostic,
  };
  globalObject.BrowserPortWisp = api;
  return api;
}
