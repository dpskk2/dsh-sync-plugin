import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SyncEngine } from '../lib/sync.js';

test('two isolated DSH homes exchange files through a real Git remote', { timeout: 60_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-two-device-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
  const makeDevice = (name) => {
    const home = path.join(root, name);
    fs.mkdirSync(path.join(home, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(home, 'dsh-sync.json'), JSON.stringify({ remote, autoRepo: false, workspaceSync: false }));
    const engine = new SyncEngine(home);
    // The test remote is a local bare Git repository; visibility is tested separately.
    engine.verifyPrivateRemote = async () => ({ ok: true });
    return engine;
  };
  const a = makeDevice('a');
  const b = makeDevice('b');
  fs.writeFileSync(path.join(a.home, 'skills', 'from-a.txt'), 'first device\n');
  const upload = await a.syncOnce('test', { forceCommit: true });
  assert.equal(upload.error, undefined, JSON.stringify(upload));
  assert.equal(upload.pushed, true);
  const download = await b.syncOnce('test', { forceCommit: true });
  assert.equal(download.error, undefined, JSON.stringify(download));
  assert.equal(fs.readFileSync(path.join(b.home, 'skills', 'from-a.txt'), 'utf8'), 'first device\n');
  fs.writeFileSync(path.join(b.home, 'skills', 'from-b.txt'), 'second device\n');
  const back = await b.syncOnce('test', { forceCommit: true });
  assert.equal(back.error, undefined, JSON.stringify(back));
  const final = await a.syncOnce('test', { forceCommit: true });
  assert.equal(final.error, undefined, JSON.stringify(final));
  assert.equal(fs.readFileSync(path.join(a.home, 'skills', 'from-b.txt'), 'utf8'), 'second device\n');
  // Both devices now have the same base and independently add distinct files.
  fs.writeFileSync(path.join(a.home, 'skills', 'parallel-a.txt'), 'A\n');
  fs.writeFileSync(path.join(b.home, 'skills', 'parallel-b.txt'), 'B\n');
  assert.equal((await a.syncOnce('test', { forceCommit: true })).error, undefined);
  const merged = await b.syncOnce('test', { forceCommit: true });
  assert.equal(merged.error, undefined, JSON.stringify(merged));
  assert.equal(fs.readFileSync(path.join(b.home, 'skills', 'parallel-a.txt'), 'utf8'), 'A\n');
  assert.equal((await a.syncOnce('test', { forceCommit: true })).error, undefined);
  assert.equal(fs.readFileSync(path.join(a.home, 'skills', 'parallel-b.txt'), 'utf8'), 'B\n');
  // A local commit must not be reported as a completed cloud sync when push fails.
  fs.writeFileSync(path.join(a.home, 'skills', 'offline.txt'), 'pending\n');
  const retry = a.runWithRetry.bind(a);
  a.runWithRetry = async (operation, ...args) => operation === 'push'
    ? { code: 1, out: '', err: 'simulated network failure' }
    : retry(operation, ...args);
  const failed = await a.syncOnce('test', { forceCommit: true });
  assert.equal(failed.error, 'push');
  assert.equal(a.progress.stage, 'error');
  a.runWithRetry = retry;
  const recovered = await a.syncOnce('test', { forceCommit: true });
  assert.equal(recovered.error, undefined, JSON.stringify(recovered));
  assert.equal((await b.syncOnce('test', { forceCommit: true })).error, undefined);
  assert.equal(fs.readFileSync(path.join(b.home, 'skills', 'offline.txt'), 'utf8'), 'pending\n');
});

test('first sync uploads workspace files and second device restores them under its own base', { timeout: 60_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-workspace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
  const homeA = path.join(root, 'home-a');
  const homeB = path.join(root, 'home-b');
  const projectA = path.join(root, 'projects-a', 'example');
  const projectB = path.join(root, 'projects-b', 'example');
  fs.mkdirSync(path.join(homeA, 'storages'), { recursive: true });
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(homeB, { recursive: true });
  fs.writeFileSync(path.join(projectA, 'note.txt'), 'workspace content\n');
  fs.writeFileSync(path.join(homeA, 'storages', 'workspace.json'), JSON.stringify({ tables: { workspaces: { 'test-workspace': { path: projectA, title: 'example' } } } }));
  const a = new SyncEngine(homeA);
  const b = new SyncEngine(homeB, { remote, autoRepo: false, workspaceBase: path.join(root, 'projects-b') });
  a.verifyPrivateRemote = b.verifyPrivateRemote = async () => ({ ok: true });
  // Simulate the automatic private-repository setup without contacting GitHub.
  a.bootstrapRemote = async () => { a.writeConfig({ remote }); return remote; };
  const sent = await a.syncOnce('test', { forceCommit: true });
  assert.equal(sent.error, undefined, JSON.stringify(sent));
  assert.equal(sent.workspaces.pushed, 1, JSON.stringify(sent.workspaces));
  const received = await b.syncOnce('test', { forceCommit: true });
  assert.equal(received.error, undefined, JSON.stringify(received));
  assert.equal(received.workspaces.errors.length, 0, JSON.stringify(received.workspaces));
  assert.equal(fs.readFileSync(path.join(projectB, 'note.txt'), 'utf8'), 'workspace content\n');
  fs.writeFileSync(path.join(projectA, 'note.txt'), 'edit on A\n');
  fs.writeFileSync(path.join(projectB, 'note.txt'), 'edit on B\n');
  assert.equal((await a.syncOnce('test', { forceCommit: true })).workspaces.errors.length, 0);
  const conflict = await b.syncOnce('test', { forceCommit: true });
  assert.equal(conflict.workspaces.errors.length, 0, JSON.stringify(conflict.workspaces));
  assert.equal(conflict.workspaces.backups.length, 1);
  assert.equal(conflict.workspaces.backups[0].pushed, true);
  assert.equal(fs.readFileSync(path.join(projectB, 'note.txt'), 'utf8'), 'edit on B\n');
  assert.equal((await a.syncOnce('test', { forceCommit: true })).workspaces.errors.length, 0);
  assert.equal(fs.readFileSync(path.join(projectA, 'note.txt'), 'utf8'), 'edit on B\n');
  // A third independent copy must restore the merged workspace.
  fs.mkdirSync(path.join(root, 'home-c'), { recursive: true });
  const c = new SyncEngine(path.join(root, 'home-c'), { remote, autoRepo: false, workspaceBase: path.join(root, 'projects-c') });
  c.verifyPrivateRemote = async () => ({ ok: true });
  const third = await c.syncOnce('test', { forceCommit: true });
  assert.equal(third.error, undefined, JSON.stringify(third));
  assert.equal(third.workspaces.errors.length, 0);
  assert.equal(fs.readFileSync(path.join(root, 'projects-c', 'example', 'note.txt'), 'utf8'), 'edit on B\n');
  // Fetch failure must not masquerade as an empty remote or a successful workspace.
  const retry = b.runWithRetry.bind(b);
  b.runWithRetry = async (operation, label, ...args) => operation === 'fetch' && label.startsWith('工作区 ')
    ? { code: 1, out: '', err: 'simulated workspace outage' }
    : retry(operation, label, ...args);
  const offline = await b.syncOnce('test', { forceCommit: true });
  assert.equal(offline.workspaces.synced, 0);
  assert.equal(offline.workspaces.errors[0].error, 'fetch');
  assert.equal(b.progress.stage, 'error');
  b.runWithRetry = retry;
  assert.equal((await b.syncOnce('test', { forceCommit: true })).workspaces.errors.length, 0);
  // Keep the backup discoverable even when the subsequent workspace push fails.
  fs.writeFileSync(path.join(projectA, 'note.txt'), 'second edit A\n');
  fs.writeFileSync(path.join(projectB, 'note.txt'), 'second edit B\n');
  assert.equal((await a.syncOnce('test', { forceCommit: true })).workspaces.errors.length, 0);
  b.runWithRetry = async (operation, label, ...args) => operation === 'push' && label.startsWith('工作区 ')
    ? { code: 1, out: '', err: 'simulated workspace push failure' }
    : retry(operation, label, ...args);
  const pending = await b.syncOnce('test', { forceCommit: true });
  assert.equal(pending.workspaces.synced, 0);
  assert.equal(pending.workspaces.errors[0].error, 'push');
  assert.equal(pending.workspaces.backups.length, 1);
  assert.equal(pending.workspaces.backups[0].pushed, false);
  const saved = execFileSync('git', ['--git-dir', b.workspaceGitDir('test-workspace'), 'show', pending.workspaces.backups[0].branch + ':note.txt'], { encoding: 'utf8' });
  assert.equal(saved, 'second edit A\n');
  b.runWithRetry = retry;
  assert.equal((await b.syncOnce('test', { forceCommit: true })).workspaces.errors.length, 0);
  assert.equal((await a.syncOnce('test', { forceCommit: true })).workspaces.errors.length, 0);
  assert.equal(fs.readFileSync(path.join(projectA, 'note.txt'), 'utf8'), 'second edit B\n');

});
