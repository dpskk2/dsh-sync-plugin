import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SyncEngine } from '../lib/sync.js';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-private-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const engine = new SyncEngine(home);
  engine.ghLogin = async () => 'alice';
  return engine;
}

test('auto setup refuses an existing public repository without saving remote', async (t) => {
  const engine = fixture(t);
  engine.gh = async () => ({ code: 0, out: '{"visibility":"PUBLIC"}', err: '' });
  assert.equal(await engine.bootstrapRemote({ repoName: 'dsh-sync' }), null);
  assert.equal(fs.existsSync(engine.configPath()), false);
  const outcome = await engine.syncOnce('test');
  assert.match(outcome.error, /私有/);
});

test('auto setup refuses an unparseable visibility response', async (t) => {
  const engine = fixture(t);
  engine.gh = async () => ({ code: 0, out: 'bad response', err: '' });
  assert.equal(await engine.bootstrapRemote({ repoName: 'dsh-sync' }), null);
  assert.equal(fs.existsSync(engine.configPath()), false);
});

test('manual remote verification fails closed and accepts private HTTPS or SSH', async (t) => {
  const engine = fixture(t);
  engine.gh = async () => ({ code: 0, out: '{"visibility":"PUBLIC"}', err: '' });
  assert.ok((await engine.verifyPrivateRemote('https://github.com/alice/data.git')).error);
  engine.gh = async () => ({ code: 1, out: '', err: 'offline' });
  assert.ok((await engine.verifyPrivateRemote('git@github.com:alice/data.git')).error);
  engine.gh = async () => ({ code: 0, out: '{"visibility":"PRIVATE"}', err: '' });
  assert.deepEqual(await engine.verifyPrivateRemote('git@github.com:alice/data.git'), { ok: true });
  assert.ok((await engine.verifyPrivateRemote('https://example.com/alice/data')).error);
});

test('sync aborts before initializing git if configured remote is not private', async (t) => {
  const engine = fixture(t);
  fs.writeFileSync(engine.configPath(), JSON.stringify({ remote: 'https://github.com/alice/data.git' }));
  engine.gh = async () => ({ code: 0, out: '{"visibility":"PUBLIC"}', err: '' });
  const outcome = await engine._mainSync('test');
  assert.match(outcome.error, /私有/);
  assert.equal(fs.existsSync(path.join(engine.home, '.git')), false);
});

test('failed main sync never starts workspace syncing', async (t) => {
  const engine = fixture(t);
  fs.writeFileSync(engine.configPath(), JSON.stringify({ remote: 'https://github.com/alice/data.git' }));
  engine.gh = async () => ({ code: 0, out: '{"visibility":"PUBLIC"}', err: '' });
  engine.syncAllWorkspaces = () => { throw new Error('workspace sync must not run'); };
  const outcome = await engine.syncOnce('test');
  assert.match(outcome.error, /私有/);
});

test('remote-head backup reports whether its branch reached the remote', async (t) => {
  const engine = fixture(t);
  engine.git = async () => ({ code: 0, out: '', err: '' });
  engine.runWithRetry = async () => ({ code: 1, out: '', err: 'offline' });
  const local = await engine.backupRemoteHead(null, null, 'abcdef');
  assert.ok(local.branch.startsWith('backup/'));
  assert.equal(local.pushed, false);
  engine.runWithRetry = async () => ({ code: 0, out: '', err: '' });
  assert.equal((await engine.backupRemoteHead(null, null, 'abcdef')).pushed, true);
});

test('two backups within the same second retain separate readable Git branches', async (t) => {
  const engine = fixture(t);
  await engine.git(['init']);
  await engine.git(['config', 'user.name', 'test']);
  await engine.git(['config', 'user.email', 'test@localhost']);
  fs.writeFileSync(path.join(engine.home, 'note.txt'), 'recover this content\n');
  await engine.git(['add', '.']);
  await engine.git(['commit', '-m', 'fixture']);
  const head = (await engine.git(['rev-parse', 'HEAD'])).out.trim();
  engine.runWithRetry = async () => ({ code: 1, out: '', err: 'offline' });
  t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 });
  const first = await engine.backupRemoteHead(null, null, head);
  const second = await engine.backupRemoteHead(null, null, head);
  assert.ok(first?.branch); assert.ok(second?.branch);
  assert.notEqual(first.branch, second.branch);
  for (const backup of [first, second]) {
    assert.equal(backup.pushed, false);
    const content = await engine.git(['show', backup.branch + ':note.txt']);
    assert.equal(content.code, 0);
    assert.equal(content.out, 'recover this content\n');
  }
});
