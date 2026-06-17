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

test('NetSurf framebuffer wasm probe artifacts are present', async () => {
  for (const path of artifacts) {
    const info = await stat(path);
    assert.ok(info.size > 0, `${path} should not be empty`);
  }
});

test('NetSurf wasm probe has a valid wasm magic header', async () => {
  const wasm = await readFile('ports/netsurf/artifacts/nsfb.wasm');
  assert.equal(wasm.subarray(0, 4).toString('binary'), '\0asm');
});

test('NetSurf public probe page documents current RAM-surface limitation', async () => {
  const page = await readFile('public/browsers/netsurf/index.html', 'utf8');
  assert.match(page, /RAM/i);
  assert.match(page, /nsfb\.js/);
});
