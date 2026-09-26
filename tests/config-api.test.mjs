import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { apply } from '../lib/index.js';

function host(t, overrides = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-config-api-'));
  const routes = new Map(), cleanup = [];
  t.after(() => { cleanup.reverse().forEach(fn => fn()); fs.rmSync(home, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(home, 'dsh-sync.json'), JSON.stringify({ mode: 'manual', autoRepo: false, autoPullOnStart: false, autoPushOnExit: false }));
  apply({
    webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
    on() { return () => {}; },
    effect(fn) { cleanup.push(fn()); },
    logger: { info() {}, warn() {}, debug() {} },
  }, { home, patches: false, ...overrides });
  return async (endpoint, body) => {
    const req = new EventEmitter(); req.method = body ? 'POST' : 'GET';
    const result = new Promise(resolve => {
      routes.get('/dsh-sync/api/' + endpoint)(req, { writeHead() {}, end(value) { resolve(JSON.parse(value)); } });
    });
    if (body) { req.emit('data', JSON.stringify(body)); req.emit('end'); }
    return result;
  };
}

test('real config route enables and disables the running scheduler without restarting host', async t => {
  const request = host(t);
  assert.equal((await request('status')).auto, false);
  assert.equal((await request('config', { mode: 'auto' })).auto, true);
  assert.equal((await request('status')).auto, true);
  assert.equal((await request('config', { mode: 'manual' })).auto, false);
  assert.equal((await request('status')).auto, false);
});

test('config response reports effective host overrides, not just saved preferences', async t => {
  const request = host(t, { mode: 'manual' });
  const result = await request('config', { mode: 'auto' });
  assert.equal(result.saved.mode, 'auto');
  assert.equal(result.config.mode, 'manual');
  assert.equal(result.auto, false);
});
