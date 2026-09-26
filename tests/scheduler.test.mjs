import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncScheduler } from '../lib/scheduler.js';

function setup(initial = {}) {
  const config = { mode: 'manual', ...initial };
  const intervals = new Map(), timeouts = new Map(), calls = [], errors = [];
  let id = 0;
  const clock = {
    setInterval(fn, ms) { intervals.set(++id, { fn, ms }); return id; },
    clearInterval(key) { intervals.delete(key); },
    setTimeout(fn, ms) { timeouts.set(++id, { fn, ms }); return id; },
    clearTimeout(key) { timeouts.delete(key); },
  };
  const scheduler = createSyncScheduler({ loadConfig: () => config, clock,
    sync: async reason => { calls.push(reason); }, afterSync: () => {}, log: (...args) => errors.push(args) });
  return { config, intervals, timeouts, calls, scheduler };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('switch modes repeatedly without duplicate timers or startup uploads', async () => {
  const h = setup();
  h.scheduler.refresh({ startup: true });
  assert.equal(h.intervals.size, 0);
  h.config.mode = 'auto';
  h.scheduler.refresh(); h.scheduler.refresh();
  assert.equal(h.intervals.size, 1);
  assert.equal(h.scheduler.active, true);
  assert.deepEqual(h.calls, []);
  h.scheduler.onActivity(); h.scheduler.onActivity();
  assert.equal(h.timeouts.size, 1);
  h.config.mode = 'manual'; h.scheduler.refresh();
  assert.equal(h.intervals.size, 0); assert.equal(h.timeouts.size, 0);
  assert.equal(h.scheduler.active, false);
  h.config.mode = 'auto'; h.scheduler.refresh();
  h.intervals.values().next().value.fn(); await settle();
  assert.deepEqual(h.calls, ['interval']);
  h.scheduler.stop(); assert.equal(h.intervals.size, 0);
});

test('disabled config and disposal prevent queued activity and interval execution', async () => {
  const h = setup({ mode: 'auto', autoPullOnStart: false });
  h.scheduler.refresh({ startup: true });
  h.scheduler.onActivity();
  const pending = h.timeouts.values().next().value.fn;
  h.config.enabled = false;
  pending(); await settle();
  assert.deepEqual(h.calls, []); assert.equal(h.intervals.size, 0);
  h.config.enabled = true; h.scheduler.refresh();
  const oldInterval = h.intervals.values().next().value.fn;
  h.scheduler.stop(); oldInterval(); h.scheduler.refresh();
  await settle(); assert.deepEqual(h.calls, []); assert.equal(h.intervals.size, 0);
});

test('startup sync, changed interval and minimum interval are respected', async () => {
  const h = setup({ mode: 'auto', intervalSeconds: 60 });
  h.scheduler.refresh({ startup: true }); await settle();
  assert.deepEqual(h.calls, ['startup']);
  assert.equal(h.intervals.values().next().value.ms, 60000);
  h.config.intervalSeconds = 1; h.scheduler.refresh();
  assert.equal(h.intervals.size, 1);
  assert.equal(h.intervals.values().next().value.ms, 30000);
  h.scheduler.stop();
});
