import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';

const artifacts = [
  'ports/netsurf/artifacts/nsfb.js',
  'ports/netsurf/artifacts/nsfb.wasm',
  'ports/netsurf/artifacts/nsfb-canvas-probe.js',
  'ports/netsurf/artifacts/nsfb-canvas-probe.wasm',
  'public/browsers/netsurf/index.html',
  'public/browsers/netsurf/nsfb.js',
  'public/browsers/netsurf/nsfb.wasm',
  'public/browsers/netsurf/nsfb-canvas-probe.js',
  'public/browsers/netsurf/nsfb-canvas-probe.wasm',
];

test('NetSurf framebuffer wasm probe artifacts are present', async () => {
  for (const path of artifacts) {
    const info = await stat(path);
    assert.ok(info.size > 0, `${path} should not be empty`);
  }
});

test('NetSurf wasm probe artifacts have valid wasm magic headers', async () => {
  for (const path of ['ports/netsurf/artifacts/nsfb.wasm', 'ports/netsurf/artifacts/nsfb-canvas-probe.wasm']) {
    const wasm = await readFile(path);
    assert.equal(wasm.subarray(0, 4).toString('binary'), '\0asm', `${path} should be a wasm module`);
  }
});

test('NetSurf public probe page exposes the RAM-surface canvas bridge', async () => {
  const page = await readFile('public/browsers/netsurf/index.html', 'utf8');
  assert.match(page, /RAM/i);
  assert.match(page, /canvas/i);
  assert.match(page, /nsfb-canvas-probe\.js/);
  assert.match(page, /nsfb\.js/);
});
