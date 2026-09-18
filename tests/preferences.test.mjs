import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
function all(node) {
  if (!node || typeof node !== 'object') return [];
  return [node, ...(node.children || []).flatMap(all)];
}
function text(node) {
  if (node == null || node === false) return '';
  return typeof node === 'object' ? (node.children || []).map(text).join(' ') : String(node);
}

// Load the shipped browser bundle through its normal slot registration contract.
// Only React hooks and HTTP transport are replaced; no user data or Git is accessed.
function harness(fetchImpl) {
  let hooks = [], cursor = 0, effects = [], bundle;
  const slots = new Map();
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial;
      return [hooks[i], (next) => { hooks[i] = typeof next === 'function' ? next(hooks[i]) : next; }];
    },
    useRef(initial) { const [ref] = react.useState({ current: initial }); return ref; },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!hooks[i] || !deps || deps.some((d, n) => d !== hooks[i][n])) effects.push(fn);
      hooks[i] = deps;
    },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  };
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(def) { bundle = def.factory((name) => { assert.equal(name, 'react'); return react; }); } } },
    fetch: fetchImpl,
    setTimeout, clearTimeout, setInterval, clearInterval,
  });
  bundle.apply({ slots: { inject: (_name, cb) => cb(), register: (meta, component) => slots.set(meta.id, component) } });
  const section = slots.get('dsh-sync-manage')({});
  const Preferences = all(section).find((n) => n.type?.name === 'SyncPreferences').type;
  hooks = []; cursor = 0; effects = [];
  return {
    render(props = {}) { cursor = 0; return Preferences({ busy: false, ...props }); },
    async effects() { const pending = effects; effects = []; pending.forEach((fn) => fn()); await tick(); },
  };
}
const response = (data) => Promise.resolve({ json: async () => data });
const initial = { mode: 'manual', workspaceSync: true, enabled: true };

test('load preferences, save the selected mode and scope, and explain restart', async () => {
  const requests = [];
  let refreshed = false;
  const h = harness((url, options) => {
    assert.equal(url, '/dsh-sync/api/config');
    if (!options) return response({ ok: true, config: initial });
    requests.push(JSON.parse(options.body));
    return response({ ok: true });
  });
  let tree = h.render();
  assert.match(text(tree), /正在读取偏好/);
  await h.effects();
  tree = h.render();
  all(tree).find((n) => n.type === 'select').props.onChange({ target: { value: 'auto' } });
  tree = h.render();
  all(tree).find((n) => n.type === 'input').props.onChange({ target: { checked: false } });
  tree = h.render({ onSaved: () => { refreshed = true; } });
  await tree.props.onSubmit({ preventDefault() {} });
  assert.deepEqual(requests, [{ mode: 'auto', workspaceSync: false }]);
  assert.equal(refreshed, true);
  assert.match(text(h.render()), /已保存.*重启 DSH/);
});

test('failed config loading offers a working retry', async () => {
  let calls = 0;
  const h = harness(() => ++calls === 1 ? Promise.reject(new Error('连接失败')) : response({ ok: true, config: initial }));
  h.render(); await h.effects();
  let tree = h.render();
  assert.match(text(tree), /连接失败/);
  all(tree).find((n) => n.type === 'button').props.onClick();
  h.render(); await h.effects();
  tree = h.render();
  assert.ok(all(tree).some((n) => n.type === 'select'));
  assert.equal(calls, 2);
});

test('a malformed success response is a recoverable load error', async () => {
  const h = harness(() => response({ ok: true }));
  h.render(); await h.effects();
  assert.match(text(h.render()), /无法读取同步偏好/);
});

test('save failure preserves the selected values without claiming success', async () => {
  const h = harness((_url, options) => response(options ? { ok: false, error: '磁盘只读' } : { ok: true, config: initial }));
  h.render(); await h.effects();
  let tree = h.render();
  all(tree).find((n) => n.type === 'select').props.onChange({ target: { value: 'auto' } });
  tree = h.render();
  await tree.props.onSubmit({ preventDefault() {} });
  tree = h.render();
  assert.equal(all(tree).find((n) => n.type === 'select').props.value, 'auto');
  assert.match(text(tree), /磁盘只读/);
  assert.doesNotMatch(text(tree), /已保存/);
});

test('syncing blocks config submission and disabled scheduling is visible', async () => {
  let posts = 0;
  const h = harness((_url, options) => {
    if (options) posts++;
    return response({ ok: true, config: { ...initial, enabled: false } });
  });
  h.render(); await h.effects();
  const tree = h.render({ busy: true });
  assert.equal(all(tree).find((n) => n.type === 'fieldset').props.disabled, true);
  await tree.props.onSubmit({ preventDefault() {} });
  assert.equal(posts, 0);
  assert.match(text(tree), /enabled 为 false/);
});

test('pending saves disable controls and cannot be submitted again', async () => {
  let finish, posts = 0;
  const h = harness((_url, options) => {
    if (!options) return response({ ok: true, config: initial });
    posts++;
    return new Promise((resolve) => { finish = () => resolve({ json: async () => ({ ok: true }) }); });
  });
  h.render(); await h.effects();
  const saving = h.render().props.onSubmit({ preventDefault() {} });
  const tree = h.render();
  assert.equal(all(tree).find((n) => n.type === 'fieldset').props.disabled, true);
  await tree.props.onSubmit({ preventDefault() {} });
  assert.equal(posts, 1);
  finish(); await saving;
  assert.equal(all(h.render()).find((n) => n.type === 'fieldset').props.disabled, false);
});
