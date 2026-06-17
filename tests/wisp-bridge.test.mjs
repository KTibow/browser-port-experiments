import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildHttpRequest,
  normalizeWispUrl,
  parseHttpResponse,
  readWispEndpoint,
  toUint8Array,
  writeWispEndpoint,
} from '../src/wisp-bridge.js';

const decoder = new TextDecoder();

test('normalizes Wisp endpoint URLs for the protocol client', () => {
  assert.equal(normalizeWispUrl('anura.pro'), 'wss://anura.pro/');
  assert.equal(normalizeWispUrl('https://example.test/wisp'), 'wss://example.test/wisp/');
  assert.equal(normalizeWispUrl('ws://localhost:5001/custom/'), 'ws://localhost:5001/custom/');
  assert.throws(() => normalizeWispUrl('ftp://example.test/'), /ws:\/\/ or wss:\/\//);
});

test('endpoint storage helpers fall back safely', () => {
  const storage = new Map();
  const shim = {
    getItem: (key) => storage.get(key),
    setItem: (key, value) => storage.set(key, value),
  };
  assert.equal(readWispEndpoint(shim), 'wss://anura.pro/');
  assert.equal(writeWispEndpoint('https://proxy.example/wisp', shim), 'wss://proxy.example/wisp/');
  assert.equal(readWispEndpoint(shim), 'wss://proxy.example/wisp/');
});

test('builds deterministic HTTP/1.1 diagnostic requests', () => {
  const request = decoder.decode(buildHttpRequest({ host: 'example.com', path: 'hello', headers: { Accept: 'text/plain' } }));
  assert.match(request, /^GET \/hello HTTP\/1\.1\r\n/);
  assert.match(request, /\r\nHost: example\.com\r\n/);
  assert.match(request, /\r\nConnection: close\r\n/);
  assert.match(request, /\r\nAccept: text\/plain\r\n/);
  assert.ok(request.endsWith('\r\n\r\n'));
});

test('converts supported stream data to Uint8Array', () => {
  assert.deepEqual([...toUint8Array('abc')], [97, 98, 99]);
  assert.deepEqual([...toUint8Array(new Uint16Array([0x6261]).subarray(0, 1))], [97, 98]);
  assert.throws(() => toUint8Array({}), /string, ArrayBuffer, Uint8Array/);
});

test('parses basic HTTP response metadata for diagnostics', () => {
  const response = parseHttpResponse(new TextEncoder().encode('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nhello'));
  assert.equal(response.statusLine, 'HTTP/1.1 200 OK');
  assert.equal(response.status, 200);
  assert.equal(response.statusText, 'OK');
  assert.equal(response.headers['content-type'], 'text/plain');
  assert.equal(response.body, 'hello');
});
