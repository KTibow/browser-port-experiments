import assert from 'node:assert/strict';
import test from 'node:test';
import { browsers, DEFAULT_WISP_URL, plannedPorts } from '../src/registry.js';

test('registry exposes at least one runnable browser', () => {
  assert.ok(browsers.length >= 1);
  for (const browser of browsers) {
    assert.match(browser.id, /^[a-z0-9-]+$/);
    assert.ok(browser.name);
    assert.ok(browser.path.startsWith('#/browser/'));
    assert.ok(browser.summary.length > 20);
    assert.ok(Array.isArray(browser.limitations));
  }
});

test('wisp default points at the requested public endpoint', () => {
  assert.equal(DEFAULT_WISP_URL, 'wss://anura.pro/');
});

test('planned ports are prioritized uniquely', () => {
  const priorities = new Set(plannedPorts.map((port) => port.priority));
  assert.equal(priorities.size, plannedPorts.length);
  assert.deepEqual(
    plannedPorts.map((port) => port.priority),
    [...plannedPorts].sort((a, b) => a.priority - b.priority).map((port) => port.priority),
  );
});
