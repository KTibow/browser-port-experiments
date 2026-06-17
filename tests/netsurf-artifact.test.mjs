import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';

const artifacts = [
  'ports/netsurf/artifacts/nsfb.js',
  'ports/netsurf/artifacts/nsfb.wasm',
  'public/browsers/netsurf/index.html',
  'public/browsers/netsurf/nsfb.js',
  'public/browsers/netsurf/nsfb.wasm',
];

test('NetSurf framebuffer wasm artifacts are present', async () => {
  for (const path of artifacts) {
    const info = await stat(path);
    assert.ok(info.size > 0, `${path} should not be empty`);
  }
});

test('NetSurf wasm artifacts have valid wasm magic headers', async () => {
  for (const path of ['ports/netsurf/artifacts/nsfb.wasm']) {
    const wasm = await readFile(path);
    assert.equal(wasm.subarray(0, 4).toString('binary'), '\0asm', `${path} should be a wasm module`);
  }
});

test('NetSurf public page exposes the full framebuffer bridge', async () => {
  const page = await readFile('public/browsers/netsurf/index.html', 'utf8');
  assert.match(page, /live\s+NetSurf\s+framebuffer/i);
  assert.match(page, /full NetSurf\s+framebuffer frontend/i);
  assert.match(page, /canvas/i);
  assert.match(page, /nsfb\.js/);
  assert.match(page, /createNetSurfFrameBuffer/);
  assert.match(page, /netsurfFramebufferState/);
  assert.match(page, /BrowserPortWisp/);
  assert.match(page, /full-frame-poll/);
  assert.doesNotMatch(page, /nsfb-canvas-probe\.js/);
  assert.doesNotMatch(page, /wss:\/\/anura\.pro/i, 'public NetSurf page should not hard-code the shared Wisp endpoint');
});

test('legacy NetSurf probe page points at the full framebuffer frontend', async () => {
  const page = await readFile('public/browsers/netsurf/probe.html', 'utf8');
  assert.match(page, /superseded by the full NetSurf framebuffer frontend/i);
  assert.match(page, /BrowserPortWisp/);
  assert.doesNotMatch(page, /not a usable browser/i);
});
