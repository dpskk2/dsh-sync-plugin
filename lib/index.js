/**
 * dsh-sync-plugin —— DeepSeek Harness 一键同步 + 会话管理插件(宿主端主入口)
 *
 * 安装(一行命令):
 *   dsh plugin --profile web add dsh-sync-plugin
 * 装完重启 dsh:
 *   - 侧栏底部出现原生「⟳ 同步」按钮(sidebar.footer.action 槽位,不再悬浮遮挡页面);
 *   - 设置面板新增「同步 · 会话管理」分节(实时列表 / 标题 / 排序 / 搜索 / 删除);
 *   - 侧栏会话「…」菜单注入「删除…」(由浏览器端 client.js 完成)。
 *
 * 配置:读 DSH home 下的 dsh-sync.json(remote 为 GitHub 私有仓库地址);
 *       mode=manual(默认,纯手动)/ auto(自动同步);改动配置即时生效。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SyncEngine, DEFAULT_CONFIG } from './sync.js';

const name = 'dsh-sync-plugin';
const inject = ['webServer'];

/** 推断 DSH home:环境变量 → 用户主目录下的 .dsh */
function resolveHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  return path.join(os.homedir(), '.dsh');
}

function readConfigFile(home) {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, 'dsh-sync.json'), 'utf8')) || {};
  } catch {
    return {};
  }
}

function makeLogger(ctx) {
  return (level, msg) => {
    const line = `[dsh-sync-plugin] ${msg}`;
    try {
      const l = ctx.logger;
      if (typeof l === 'function') { l(line); return; }
      if (l && typeof l[level] === 'function') { l[level](line); return; }
    } catch { /* 落到 console */ }
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
}

/** 把一次同步结果压成一句话 */
function summarize(r) {
  const parts = [];
  if (r.committed) parts.push('已提交本地快照');
  if (r.pulled === 'ff') parts.push('已拉取远端新数据');
  if (r.pulled === 'merge') parts.push(r.unrelated ? '已并入远端历史' : '已合并双方数据');
  if (r.pulled === 'reset') parts.push('已整体取回远端');
  if (r.pushed) parts.push('已推送到远端');
  if (r.conflicts && r.conflicts.length) parts.push(r.conflicts.length + ' 个冲突保留本机');
  if (r.backupBranch) parts.push('远端备份: ' + r.backupBranch);
  if (r.skipped) parts.push('跳过(' + r.skipped + ')');
  if (r.error) parts.push('错误: ' + r.error);
  if (!parts.length) parts.push('已是最新,无需变更');
  return parts.join(';');
}

/** 会话目录分组名是脱敏后的路径(非 ASCII 变 ~XXXX 十六进制),尽力还原成可读文本 */
function decodeGroup(group) {
  try {
    let s = String(group).replace(/~([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    if (/^-/.test(s)) s = s.replace(/^-+/, '').replace(/-+$/, '').replace(/-{2,}/g, '\\');
    return s;
  } catch { return group; }
}

/** 标题/创建时间:逐会话读投影缓存 storages/session_projcache/sessions/<id>.json */
function readProjection(home, id) {
  try {
    const p = JSON.parse(
      fs.readFileSync(path.join(home, 'storages', 'session_projcache', 'sessions', id + '.json'), 'utf8'),
    );
    const rows = p?.record?.rows ?? {};
    let title = rows?.title?.val;
    if (title && typeof title === 'object') title = title.title;
    const createdAt = Number(p?.record?.identity?.createdAt) || 0;
    return { title: typeof title === 'string' ? title : '', createdAt };
  } catch {
    return { title: '', createdAt: 0 };
  }
}

/** 归档集合 + 会话→工作区映射(来自 workspace.json) */
function workspaceIndex(home) {
  try {
    const ws = JSON.parse(fs.readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8'));
    const bySession = {};
    const tables = ws?.tables?.workspaces ?? {};
    for (const [wid, w] of Object.entries(tables)) {
      const info = {
        id: wid,
        title: typeof w?.title === 'string' ? w.title : '',
        path: typeof w?.path === 'string' ? w.path : '',
      };
      for (const sid of Array.isArray(w?.sessionIds) ? w.sessionIds : []) bySession[sid] = info;
    }
    return { bySession, archived: new Set(ws?.global?.archivedSessionIds ?? []) };
  } catch {
    return { bySession: {}, archived: new Set() };
  }
}

/** 列出本机全部会话(标题来自投影缓存;附带工作区、创建/更新时间、大小、归档标记) */
function sessionRows(home) {
  const out = [];
  const { bySession, archived } = workspaceIndex(home);
  const root = path.join(home, 'sessions');
  let groups = [];
  try { groups = fs.readdirSync(root); } catch { return out; }
  for (const group of groups) {
    let ids = [];
    try { ids = fs.readdirSync(path.join(root, group)); } catch { continue; }
    for (const id of ids) {
      if (!/^session-[0-9a-f-]{36}$/i.test(id)) continue;
      const dir = path.join(root, group, id);
      let mtimeMs = 0;
      let size = 0;
      try {
        for (const f of fs.readdirSync(dir)) {
          const st = fs.statSync(path.join(dir, f));
          size += st.size;
          if (st.mtimeMs > mtimeMs) mtimeMs = st.mtimeMs;
        }
      } catch { continue; }
      const proj = readProjection(home, id);
      const wsInfo = bySession[id];
      out.push({
        id,
        title: proj.title,
        createdAt: proj.createdAt,
        updatedAt: mtimeMs,
        sizeKB: Math.round(size / 1024),
        archived: archived.has(id),
        workspace: wsInfo ? (wsInfo.title || wsInfo.path || decodeGroup(group)) : decodeGroup(group),
      });
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

/** 删除会话:移入本地回收站 .dsh/.trash(可找回);清理归档标记、工作区列表与标题投影缓存 */
function deleteSession(home, id) {
  if (!/^session-[0-9a-f-]{36}$/i.test(id)) throw new Error('非法会话 id: ' + id);
  const root = path.join(home, 'sessions');
  const groups = fs.existsSync(root) ? fs.readdirSync(root) : [];
  const stamp = Date.now();
  const trashBase = path.join(home, '.trash', String(stamp));
  const moved = [];
  for (const group of groups) {
    const dir = path.join(root, group, id);
    if (!fs.existsSync(dir)) continue;
    const dest = path.join(trashBase, group, id);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(dir, dest);
    moved.push(group);
  }
  if (!moved.length) throw new Error('找不到该会话: ' + id);
  // 标题投影缓存一并入回收站,避免残留幽灵数据
  const projFile = path.join(home, 'storages', 'session_projcache', 'sessions', id + '.json');
  if (fs.existsSync(projFile)) {
    const dest = path.join(trashBase, 'projcache', id + '.json');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(projFile, dest);
  }
  // 清理归档标记与工作区 sessionIds(尽力而为;宿主内存态以它自身下次持久化为准)
  const wsFile = path.join(home, 'storages', 'workspace.json');
  try {
    const ws = JSON.parse(fs.readFileSync(wsFile, 'utf8'));
    let touched = false;
    if (Array.isArray(ws?.global?.archivedSessionIds) && ws.global.archivedSessionIds.includes(id)) {
      ws.global.archivedSessionIds = ws.global.archivedSessionIds.filter((x) => x !== id);
      touched = true;
    }
    for (const w of Object.values(ws?.tables?.workspaces ?? {})) {
      if (Array.isArray(w?.sessionIds) && w.sessionIds.includes(id)) {
        w.sessionIds = w.sessionIds.filter((x) => x !== id);
        touched = true;
      }
    }
    if (touched) fs.writeFileSync(wsFile, JSON.stringify(ws, null, 2));
  } catch { /* 尽力而为 */ }
  return { id, groups: moved, trash: trashBase };
}

function apply(ctx, config = {}) {
  const home = config.home || resolveHome();
  const fileCfg = readConfigFile(home);
  const overrides = { ...config };
  delete overrides.home;
  const cfg = { ...DEFAULT_CONFIG, ...fileCfg, ...overrides };
  const log = makeLogger(ctx);

  const engine = new SyncEngine(home, overrides, log);
  const disposers = [];
  const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  const json = (res, code, payload) => {
    res.writeHead(code, jsonHeaders);
    res.end(JSON.stringify(payload));
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (d) => { buf += d; });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });

  // —— API 路由:供浏览器端原生 UI(侧栏按钮 / 设置分节 / 会话菜单删除)调用 ——
  try {
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-sync/api/run',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'method not allowed' });
          return;
        }
        try {
          // 手动触发:免提交节流,点一下立刻提交
          const r = await engine.syncOnce('web-button', { forceCommit: true });
          json(res, 200, { ok: !r.error, summary: summarize(r), detail: r });
        } catch (e) {
          json(res, 200, { ok: false, error: String((e && e.message) || e) });
        }
      },
    }));
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-sync/api/status',
      handler: (req, res) => {
        const c = engine.loadConfig();
        const autoWanted = c.mode === 'auto' && c.enabled !== false;
        json(res, 200, {
          ok: true,
          remote: c.remote || '',
          branch: c.branch,
          mode: c.mode || 'manual',
          auto: autoWanted,
          gitMissing: engine.gitMissing,
          lastSyncAt: engine.lastSyncAt,
          lastOk: engine.lastOutcome ? !engine.lastOutcome.error : null,
          lastMessage: engine.lastOutcome ? summarize(engine.lastOutcome) : '',
        });
      },
    }));
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-sync/api/progress',
      handler: (req, res) => {
        const p = engine.progress || {};
        json(res, 200, {
          ok: true,
          running: Boolean(p.running),
          stage: p.stage || null,
          label: p.label || '',
          startedAt: p.startedAt || 0,
          lastSyncAt: engine.lastSyncAt,
          lastOk: engine.lastOutcome ? !engine.lastOutcome.error : null,
          lastMessage: engine.lastOutcome ? summarize(engine.lastOutcome) : '',
        });
      },
    }));
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-sync/api/sessions',
      handler: (req, res) => {
        json(res, 200, { ok: true, sessions: sessionRows(home) });
      },
    }));
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-sync/api/session/delete',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'method not allowed' });
          return;
        }
        try {
          const body = JSON.parse((await readBody(req)) || '{}');
          const r = deleteSession(home, String(body.id || '').trim());
          json(res, 200, { ok: true, ...r });
        } catch (e) {
          json(res, 200, { ok: false, error: String((e && e.message) || e) });
        }
      },
    }));
  } catch (err) {
    log('warn', 'webServer 不可用,API 未注册(命令行同步仍可用): ' + String((err && err.message) || err));
  }

  // —— 会话管理工具:删除会话(DSH 本身只有归档没有删除)——
  const toolOut = { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] };
  try {
    disposers.push(ctx.tools.register({
      name: 'session_list',
      description: '列出本机全部 DSH 会话(标题、id、所属工作区、创建/最后活动时间、大小、是否已归档),按最后活动排序。用于在删除前定位会话。',
      parameters: {},
      output: toolOut,
      async execute() {
        const rows = sessionRows(home);
        if (!rows.length) return '(本机没有会话)';
        return rows.slice(0, 80).map((r, i) =>
          `${i + 1}. ${r.title || '(无标题)'} | ${r.id} | ${r.workspace || '?'} | 创建 ${r.createdAt ? new Date(r.createdAt).toLocaleString() : '?'} | 活动 ${new Date(r.updatedAt).toLocaleString()} | ${r.sizeKB}KB${r.archived ? ' | 已归档' : ''}`,
        ).join('\n');
      },
    }));
    disposers.push(ctx.tools.register({
      name: 'session_delete',
      description: '删除(移入本地回收站)指定 DSH 会话。数据可在 ~/.dsh/.trash 找回;同步后其他电脑上的同一会话也会被删除。注意:宿主把会话登记表放在内存里,该工具只删文件,侧栏条目要重启 dsh 才消失(设置面板/会话菜单里的删除按钮会先调原生归档接口,侧栏立即消失)。执行前先用 session_list 找到确切的 id,并和用户确认。',
      parameters: {
        id: { type: 'string', required: true, description: '要删除的会话 id(session- 开头,来自 session_list)' },
      },
      output: toolOut,
      async execute(args) {
        const r = deleteSession(home, String(args.id || '').trim());
        return `已删除会话 ${r.id}(所在组: ${r.groups.join(', ')})。回收站: ${r.trash}。下次点「同步」会把删除传播到其他电脑;侧栏条目重启 dsh 后消失。`;
      },
    }));
  } catch (err) {
    log('warn', '会话工具注册失败: ' + String((err && err.message) || err));
  }

  // —— 自动模式才有的定时/事件钩子 ——
  const autoWanted = cfg.mode === 'auto' && cfg.enabled !== false;
  if (autoWanted) {
    if (cfg.autoPullOnStart !== false) {
      engine.syncOnce('startup').catch((e) => log('warn', `启动同步失败: ${e?.message || e}`));
    }
    const intervalMs = Math.max(30, Number(cfg.intervalSeconds) || 300) * 1000;
    const timer = setInterval(() => {
      engine.syncOnce('interval').catch((e) => log('warn', `定时同步失败: ${e?.message || e}`));
    }, intervalMs);
    timer.unref?.();
    let debounceTimer = null;
    try {
      disposers.push(ctx.on('session/event', () => {
        if (debounceTimer) return;
        const delayMs = Math.max(5, Number(cfg.eventDebounceSeconds) || 15) * 1000;
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          engine.syncOnce('activity').catch((e) => log('warn', '活动同步失败: ' + (e?.message || e)));
        }, delayMs);
        debounceTimer.unref?.();
      }));
    } catch {
      log('info', 'ctx.on(session/event) 不可用,仅按周期同步');
    }
    ctx.effect(() => () => {
      clearInterval(timer);
      if (debounceTimer) clearTimeout(debounceTimer);
      for (const d of disposers) {
        try { d(); } catch { /* ignore */ }
      }
      if (cfg.autoPushOnExit !== false) {
        try {
          engine.flushSync();
          log('info', '退出冲刷完成');
        } catch (e) {
          log('warn', `退出冲刷失败: ${e?.message || e}`);
        }
      }
    });
  } else {
    // 手动模式:退出时把 disposers 清掉即可
    ctx.effect(() => () => {
      for (const d of disposers) {
        try { d(); } catch { /* ignore */ }
      }
    });
  }

  if (!cfg.remote) {
    log('info', `未配置 remote —— 同步只做本地快照提交。编辑 ${path.join(home, 'dsh-sync.json')} 填入 GitHub 私有仓库地址后启用云同步`);
  }
  log('info', `dsh-sync-plugin 已启动(mode=${cfg.mode || 'manual'}, home=${home}, 分支=${cfg.branch}, remote=${cfg.remote || '(未配置,仅本地快照)'}, UI=侧栏「⟳ 同步」按钮(实时进度) + 设置「同步 · 会话管理」)`);
}

export { name, inject, apply };
