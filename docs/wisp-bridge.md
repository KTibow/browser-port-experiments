# Shared Wisp browser bridge

This repo defaults browser-port networking to the public Wisp endpoint `wss://anura.pro/`. Ports should not hard-code that URL in engine code; use the shared JavaScript bridge in `src/wisp-bridge.js` so users can override endpoints from the launch UI.

## Browser diagnostic

The app exposes `#/wisp`, a small manual diagnostic page. It:

1. normalizes and stores the Wisp endpoint,
2. opens a WebSocket to the endpoint,
3. opens a TCP stream to `example.com:80` (or a user-supplied host/port), and
4. sends a simple HTTP/1.1 request through that TCP stream.

This intentionally uses plain HTTP over Wisp rather than `fetch()`: it proves the WASM-port path can create raw TCP-like streams from browser JavaScript.

## JavaScript API

`src/main.js` installs the bridge at `window.BrowserPortWisp`. ESM users can also import these functions directly:

```js
import {
  normalizeWispUrl,
  readWispEndpoint,
  writeWispEndpoint,
  connectWisp,
  openWispTcpStream,
  httpOverWisp,
  runWispDiagnostic,
} from './wisp-bridge.js';
```

### Endpoint helpers

```js
const endpoint = BrowserPortWisp.readEndpoint();
BrowserPortWisp.writeEndpoint('wss://anura.pro/');
BrowserPortWisp.normalizeWispUrl('anura.pro'); // => 'wss://anura.pro/'
```

`normalizeWispUrl` accepts `ws://`, `wss://`, `http://`, `https://`, or a bare host. It converts HTTP schemes to WebSocket schemes and ensures the trailing slash required by Wisp.

### Open a TCP stream

```js
const tcp = await BrowserPortWisp.openTcpStream({
  endpoint: BrowserPortWisp.readEndpoint(),
  host: 'example.com',
  port: 80,
});

tcp.stream.onmessage = (chunk) => {
  // chunk is a Uint8Array from the remote TCP socket.
};
tcp.stream.onclose = (reason) => {
  console.log('closed', reason);
};

tcp.send('GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n');
```

`openTcpStream` returns `{ connection, stream, send, close }`. `send` accepts a string, `ArrayBuffer`, `Uint8Array`, or typed-array view.

### HTTP diagnostic helper

```js
const result = await BrowserPortWisp.http({
  host: 'example.com',
  port: 80,
  path: '/',
});
console.log(result.response.statusLine, result.response.body);
```

This helper is for smoke tests and diagnostics, not a replacement for a full HTTP stack. Real browser engines should generally use `openTcpStream` and let the engine/libcurl own HTTP, TLS, redirects, cookies, and caching.

## WASM port integration pattern

For Emscripten ports, keep engine networking asynchronous and delegate socket operations to JS. A minimal shape is:

```js
const sockets = new Map();
let nextSocketId = 1;

Module.wisp_open_tcp = async (hostPtr, port) => {
  const host = UTF8ToString(hostPtr);
  const socketId = nextSocketId++;
  const tcp = await BrowserPortWisp.openTcpStream({ host, port });
  tcp.stream.onmessage = (chunk) => Module.ccall('network_on_data', null, ['number', 'array'], [socketId, chunk]);
  tcp.stream.onclose = (reason) => Module.ccall('network_on_close', null, ['number', 'number'], [socketId, reason]);
  sockets.set(socketId, tcp);
  return socketId;
};

Module.wisp_send = (socketId, ptr, len) => {
  const bytes = HEAPU8.slice(ptr, ptr + len);
  sockets.get(socketId)?.send(bytes);
};

Module.wisp_close = (socketId) => {
  sockets.get(socketId)?.close();
  sockets.delete(socketId);
};
```

The exact C ABI should be port-specific, but keep these properties:

- endpoint comes from `BrowserPortWisp.readEndpoint()` unless the user overrides it;
- bytes cross the JS/WASM boundary as `Uint8Array`/linear-memory slices;
- the WASM side owns DNS names, ports, HTTP/TLS, and socket lifecycle semantics;
- JS reports Wisp close reasons so engines can surface useful errors.

## Implementation dependency

The bridge uses `@mercuryworkshop/wisp-js/client`, the maintained JavaScript client referenced by the Wisp protocol docs. It supports Wisp v2 with v1 fallback and works in browser bundles through Vite.
