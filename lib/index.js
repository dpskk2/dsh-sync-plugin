/**
 * dsh-sync-plugin —— DeepSeek Harness 会话同步插件(宿主端主入口)
 *
 * 安装(一行命令):
 *   dsh plugin --profile web add dsh-sync-plugin
 * 装完重启 dsh:
 *   - 侧栏底部出现原生「⟳ 同步」按钮(sidebar.footer.action 槽位,不遮挡页面);
 *   - 设置面板新增「同步」分节(状态 + 上次结果 + 立即同步)。
 *
 * 只做「同步」:把 DSH 会话(含每个会话所属工作区的对应关系)、聚合在
 * storages/workspace.json 的工作区→会话映射、以及各工作区真实文件夹内容,
 * 通过 GitHub 私有仓库在【多台电脑】之间双向同步。没有会话浏览/删除等管理功能
 * —— 那些交给 DSH 原生 UI 即可。
 *
 * 配置:读 DSH home 下的 dsh-sync.json(remote 为 GitHub 私有仓库地址);
 *       mode=manual(默认,纯手动)/ auto(自动同步);改动配置即时生效。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SyncEngine, DEFAULT_CONFIG, decodeGroup, normPath, humanSize, ZSTD_MAGIC, decodeZstdFrames } from './sync.js';
import { applyAllPatches, formatApplyResults } from './patches.js';

// zstd 解码(会话内容预览用):Node ≥22.10 才有;旧版本自动降级(预览返回"不支持")
let zstdDecompressSync = null;
try { ({ zstdDecompressSync } = await import('node:zlib')); } catch { zstdDecompressSync = null; }

const name = 'dsh-sync-plugin';
const inject = ['webServer'];

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
  const upBytes = (r.transfers || []).filter((t) => t.op === 'push').reduce((a, t) => a + (t.size || 0), 0);
  const downBytes = (r.transfers || []).filter((t) => t.op === 'fetch').reduce((a, t) => a + (t.size || 0), 0);
  if (r.committed) parts.push('已提交本地快照');
  if (r.pulled === 'ff') parts.push('已拉取远端新数据' + (downBytes ? `(${humanSize(downBytes)})` : ''));
  if (r.pulled === 'merge') parts.push(r.unrelated ? '已并入远端历史' : '已合并双方数据');
  if (r.pulled === 'reset') parts.push('已整体取回远端');
  if (r.pushed) parts.push('已推送到远端' + (upBytes ? `(${humanSize(upBytes)})` : ''));
  if (r.conflicts && r.conflicts.length) parts.push(r.conflicts.length + ' 个冲突「双边保留」待裁决');
  if (r.backupBranch) parts.push('远端备份: ' + r.backupBranch);
  if (r.skipped) parts.push('跳过(' + r.skipped + ')');
  if (r.error === 'auth') parts.push('凭据缺失: ' + (r.hint || '请先 gh auth login 或配置 PAT,再点同步'));
  else if (r.error) parts.push('错误: ' + r.error);
  if (r.workspaces && r.workspaces.total) {
    const w = r.workspaces;
    const wparts = [];
    if (w.synced) wparts.push(w.synced + ' 个工作区已同步');
    if (w.pushed) wparts.push(w.pushed + ' 个已推送');
    if (w.pulled) wparts.push(w.pulled + ' 个已拉取');
    if (wparts.length) parts.push('工作区: ' + wparts.join(','));
    if (w.errors && w.errors.length) parts.push('工作区失败: ' + w.errors.map((e) => (e.title || e.id || '?')).join(', '));
  }
  if (!parts.length) parts.push('已是最新,无需变更');
  return parts.join(';');
}

/** 从一次同步结果里抽出可供状态接口展示/排障的摘要(不含敏感信息) */
function lastDetail(r) {
  if (!r) return null;
  const w = r.workspaces;
  const conflictCopies = [
    ...(Array.isArray(r.conflictCopies) ? r.conflictCopies : []),
    ...(w && Array.isArray(w.conflictCopies) ? w.conflictCopies : []),
  ];
  return {
    committed: Boolean(r.committed),
    pushed: Boolean(r.pushed),
    pulled: r.pulled || null,
    error: r.error || null,
    skipped: r.skipped || null,
    conflicts: Array.isArray(r.conflicts) ? r.conflicts : [],
    conflictCopies: conflictCopies.map((c) => ({ kind: c.kind, id: c.id || null, path: c.path, copy: c.copy, conflictAt: c.conflictAt })),
    backupBranch: r.backupBranch || null,
    workspaces: w ? {
      total: w.total || 0,
      synced: w.synced || 0,
      pushed: w.pushed || 0,
      pulled: w.pulled || 0,
      skipped: w.skipped || null,
      errors: Array.isArray(w.errors) ? w.errors.map((e) => ({ id: e.id, title: e.title, path: e.path, error: e.error })) : [],
      created: Array.isArray(w.created) ? w.created.map((c) => ({ id: c.id, title: c.title, path: c.path, recorded: c.recorded })) : [],
    } : null,
    durationMs: r.durationMs || null,
    repoSize: r.repoSize || null,
    stages: Array.isArray(r.stages) ? r.stages.map((s) => ({ stage: s.stage, label: s.label, ms: s.ms })) : [],
    transfers: Array.isArray(r.transfers) ? r.transfers.map((t) => ({ op: t.op, label: t.label || null, size: t.size, speed: t.speed, totalObjects: t.totalObjects, reused: t.reused })) : [],
  };
}

/* ================= 会话归档管理 —— 让真实文件与侧边栏对应;可取消归档/彻底删除已归档与幽灵会话 ================= */

/** 读会话投影缓存:标题/创建时间 */
function readProjection(home, id) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(home, 'storages', 'session_projcache', 'sessions', id + '.json'), 'utf8'));
    let title = p?.record?.rows?.title?.val;
    if (title && typeof title === 'object') title = title.title;
    const createdAt = Number(p?.record?.identity?.createdAt) || 0;
    return { title: typeof title === 'string' ? title : '', createdAt };
  } catch { return { title: '', createdAt: 0 }; }
}

/** 读 workspace.json:归档集合 + 工作区→会话/路径 映射 */
function workspaceIndex(home) {
  try {
    const ws = JSON.parse(fs.readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8'));
    const bySession = {};
    const byPath = {};
    const tables = ws?.tables?.workspaces ?? {};
    for (const [wid, w] of Object.entries(tables)) {
      const info = { id: wid, title: typeof w?.title === 'string' ? w.title : '', path: typeof w?.path === 'string' ? w.path : '' };
      byPath[normPath(info.path)] = info;
      for (const sid of Array.isArray(w?.sessionIds) ? w.sessionIds : []) bySession[sid] = info;
    }
    return { bySession, byPath, archived: new Set(ws?.global?.archivedSessionIds ?? []) };
  } catch { return { bySession: {}, byPath: {}, archived: new Set() }; }
}

function findSessionGroup(home, id) {
  const root = path.join(home, 'sessions');
  try {
    for (const g of fs.readdirSync(root)) {
      if (fs.existsSync(path.join(root, g, id))) return g;
    }
  } catch { /* ignore */ }
  return null;
}

/** 写 workspace.json(保留结构) */
function persistWorkspace(home, ws) {
  fs.writeFileSync(path.join(home, 'storages', 'workspace.json'), JSON.stringify(ws, null, 2));
}

/**
 * 列出全部会话:真实文件(sessions/ 扫描)+ 登记表幽灵(有 id 无文件)。
 * 每项含 标题/所属工作区/是否归档/是否幽灵/创建时间/最后活动/大小,供「归档会话管理处」展示与操作。
 */
function sessionRows(home) {
  const { bySession, byPath, archived } = workspaceIndex(home);
  const root = path.join(home, 'sessions');
  const seen = new Set();
  const out = [];
  let groups = [];
  try { groups = fs.readdirSync(root); } catch { return out; }
  for (const group of groups) {
    let ids = [];
    try { ids = fs.readdirSync(path.join(root, group)); } catch { continue; }
    for (const id of ids) {
      if (!/^session-[0-9a-f-]{36}$/i.test(id)) continue;
      seen.add(id);
      const dir = path.join(root, group, id);
      let mtime = 0, size = 0;
      try {
        for (const f of fs.readdirSync(dir)) {
          const st = fs.statSync(path.join(dir, f));
          size += st.size;
          if (st.mtimeMs > mtime) mtime = st.mtimeMs;
        }
      } catch { /* ignore */ }
      const proj = readProjection(home, id);
      const wsi = bySession[id] || byPath[normPath(decodeGroup(group))] || null;
      out.push({
        id, title: proj.title,
        workspace: wsi ? (wsi.title || wsi.path || decodeGroup(group)) : decodeGroup(group),
        workspaceId: wsi ? wsi.id : null,
        archived: archived.has(id), ghost: false,
        createdAt: proj.createdAt, updatedAt: mtime, sizeKB: Math.round(size / 1024),
      });
    }
  }
  // 登记表里的幽灵(有 id 无文件)
  const allRegistered = new Set([...archived, ...Object.keys(bySession)]);
  for (const id of allRegistered) {
    if (seen.has(id)) continue;
    const wsi = bySession[id];
    const proj = readProjection(home, id);
    out.push({
      id, title: proj.title,
      workspace: wsi ? (wsi.title || wsi.path) : (archived.has(id) ? '(未知工作区,已归档)' : '(未登记)'),
      workspaceId: wsi ? wsi.id : null,
      archived: archived.has(id), ghost: true,
      createdAt: proj.createdAt, updatedAt: 0, sizeKB: 0,
    });
  }
  out.sort((a, b) => Number(b.archived) - Number(a.archived) || b.updatedAt - a.updatedAt);
  return out;
}

/** 简易行级 diff(LCS),用于配置文件冲突预览;返回 unified-diff 风格文本 */
function unifiedTextDiff(aText, bText, aLabel = '本机', bLabel = '远端拷贝', maxLines = 400) {
  const a = String(aText || '').split('\n');
  const b = String(bText || '').split('\n');
  const n = a.length, m = b.length;
  if (n * m > 4_000_000) {
    // 大文件:退化为按内容集合的差异摘要(不做位置对齐),避免内存与耗时
    const setB = new Set(b);
    const onlyA = a.filter((x) => !setB.has(x));
    const setA = new Set(a);
    const onlyB = b.filter((x) => !setA.has(x));
    const cap = 100;
    return `--- ${aLabel}\n+++ ${bLabel}\n\n[文件较大(${n} vs ${m} 行),给出差异摘要]\n本机独有 ${onlyA.length} 行:\n${onlyA.slice(0, cap).map((x) => '-' + x).join('\n')}\n\n远端独有 ${onlyB.length} 行:\n${onlyB.slice(0, cap).map((x) => '+' + x).join('\n')}`;
  }
  const stride = m + 1;
  const dp = new Int32Array((n + 1) * stride);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const idx = i * stride + j;
      dp[idx] = a[i] === b[j] ? dp[(i + 1) * stride + j + 1] + 1 : Math.max(dp[(i + 1) * stride + j], dp[i * stride + j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push(' ' + a[i]); i++; j++; }
    else if (dp[(i + 1) * stride + j] >= dp[i * stride + j + 1]) { out.push('-' + a[i]); i++; }
    else { out.push('+' + b[j]); j++; }
  }
  while (i < n) out.push('-' + a[i++]);
  while (j < m) out.push('+' + b[j++]);
  const head = `--- ${aLabel}\n+++ ${bLabel}\n`;
  return out.length > maxLines ? head + out.slice(0, maxLines).join('\n') + `\n…(共 ${out.length} 行差异,已截断)` : head + out.join('\n');
}

/* ================= 会话内容预览 —— 读取会话日志(JSONL,zstd 压缩),抽取可展示的消息 ================= */

/** 把 .jsonl.zstd 的多个 zstd 帧串联解码为 UTF-8 文本(跳过损坏帧);非 zstd 内容原样返回 */
function decodeSessionText(buf, isZstd) {
  // 按魔数识别 zstd(冲突拷贝后缀不是 .zstd,但内容仍是压缩帧)
  const looksZstd = isZstd || (buf.length >= 4 && buf.subarray(0, 4).equals(ZSTD_MAGIC));
  if (!looksZstd) return buf.toString('utf8');
  if (typeof zstdDecompressSync !== 'function') throw new Error('当前 Node 版本不支持 zstd 解码(需 Node ≥ 22.10),无法预览会话内容');
  return decodeZstdFrames(buf) ?? buf.toString('utf8');
}

/** 从消息 content 部分抽取文本(支持数组或字符串) */
function partsToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const p of content) {
    if (p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string') out.push(p.text);
  }
  return out.join('\n');
}

const PREVIEW_MAX_MESSAGES = 60; // 最多返回最近 60 条消息
const PREVIEW_MAX_TEXT = 4000;   // 每条消息文本最多 4000 字符

/**
 * 读取会话日志并抽取出可展示的消息预览(标题 / 消息数 / 最近消息)。
 * 找不到会话文件(幽灵会话)时返回 found:false,messages 为空。
 */
function readSessionPreview(home, id) {
  if (!/^session-[0-9a-f-]{36}$/i.test(id)) throw new Error('非法会话 id: ' + id);
  const root = path.join(home, 'sessions');
  let file = null;
  try {
    for (const g of fs.readdirSync(root)) {
      const dir = path.join(root, g, id);
      for (const name of ['session.jsonl.zstd', 'session.jsonl']) {
        const p = path.join(dir, name);
        if (fs.existsSync(p)) { file = p; break; }
      }
      if (file) break;
    }
  } catch { /* ignore */ }
  if (!file) {
    const proj = readProjection(home, id);
    return { id, found: false, title: proj.title || '', messageCount: 0, truncated: false, messages: [] };
  }
  return readSessionPreviewPath(home, file, id);
}

/** 按文件路径读会话预览(冲突拷贝等非标准路径也用得上) */
function readSessionPreviewPath(home, file, idHint) {
  let text;
  try {
    text = decodeSessionText(fs.readFileSync(file), file.endsWith('.zstd'));
  } catch (e) {
    return { id: idHint || '', found: true, error: String((e && e.message) || e), title: '', messageCount: 0, truncated: false, messages: [] };
  }
  const all = [];
  let title = '';
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || typeof rec !== 'object' || typeof rec.type !== 'string') continue;
    if (rec.type === 'session/title' && rec.data && typeof rec.data.title === 'string' && !title) {
      title = rec.data.title;
      continue;
    }
    if (rec.type === 'user/message') {
      const d = rec.data || {};
      // 只取真实用户输入(跳过系统注入的上下文快照等)
      if (d.source && d.source.kind && d.source.kind !== 'user') continue;
      const t = partsToText(d.content);
      if (t) all.push({ role: 'user', text: t, time: rec.time || 0 });
    } else if (rec.type === 'assistant/message') {
      const m = rec.data && rec.data.message;
      if (!m || !Array.isArray(m.content)) continue;
      const t = partsToText(m.content);
      if (t) all.push({ role: 'assistant', text: t, time: rec.time || 0 });
    }
  }
  const meaningful = all.filter((m) => m.text && m.text.trim());
  const total = meaningful.length;
  const truncated = total > PREVIEW_MAX_MESSAGES || meaningful.some((m) => m.text.length > PREVIEW_MAX_TEXT);
  const msgs = meaningful.slice(-PREVIEW_MAX_MESSAGES).map((m) => ({
    role: m.role,
    time: m.time,
    text: m.text.length > PREVIEW_MAX_TEXT ? m.text.slice(0, PREVIEW_MAX_TEXT) + '\n…(内容过长,已截断)' : m.text,
  }));
  if (!title) {
    const proj = readProjection(home, idHint);
    title = proj.title || '';
  }
  return { id: idHint || '', found: true, title, messageCount: total, truncated, messages: msgs };
}

/** 取消归档:id 移出 archivedSessionIds;若未登记到任何工作区,则按会话 cwd 分组解码登记回对应工作区 */
function unarchiveSession(home, id) {
  if (!/^session-[0-9a-f-]{36}$/i.test(id)) throw new Error('非法会话 id: ' + id);
  const wsPath = path.join(home, 'storages', 'workspace.json');
  const ws = JSON.parse(fs.readFileSync(wsPath, 'utf8'));
  let touched = false;
  if (Array.isArray(ws?.global?.archivedSessionIds) && ws.global.archivedSessionIds.includes(id)) {
    ws.global.archivedSessionIds = ws.global.archivedSessionIds.filter((x) => x !== id);
    touched = true;
  }
  const already = Object.values(ws?.tables?.workspaces ?? {}).some((w) => Array.isArray(w?.sessionIds) && w.sessionIds.includes(id));
  if (!already) {
    const group = findSessionGroup(home, id);
    const decoded = group ? decodeGroup(group) : '';
    const target = decoded ? Object.values(ws?.tables?.workspaces ?? {}).find((w) => w?.path === decoded) : null;
    if (target) {
      if (!Array.isArray(target.sessionIds)) target.sessionIds = [];
      if (!target.sessionIds.includes(id)) { target.sessionIds.push(id); touched = true; }
    }
  }
  if (touched) persistWorkspace(home, ws);
  return { id, ok: touched };
}

/** 彻底删除:移除会话目录/投影缓存 + 从登记表(归档 + 各工作区 sessionIds)移除 */
function deleteSessionPermanent(home, id) {
  if (!/^session-[0-9a-f-]{36}$/i.test(id)) throw new Error('非法会话 id: ' + id);
  const root = path.join(home, 'sessions');
  let found = false;
  try {
    for (const g of fs.readdirSync(root)) {
      const d = path.join(root, g, id);
      if (fs.existsSync(d)) { fs.rmSync(d, { recursive: true, force: true }); found = true; }
    }
  } catch { /* ignore */ }
  const projFile = path.join(home, 'storages', 'session_projcache', 'sessions', id + '.json');
  if (fs.existsSync(projFile)) { fs.rmSync(projFile, { force: true }); found = true; }
  try {
    const wsPath = path.join(home, 'storages', 'workspace.json');
    const ws = JSON.parse(fs.readFileSync(wsPath, 'utf8'));
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
    if (touched) persistWorkspace(home, ws);
  } catch { /* ignore */ }
  return { id, deleted: found };
}

function apply(ctx, config = {}) {
  const home = config.home || (process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  let fileCfg = {};
  try { fileCfg = JSON.parse(fs.readFileSync(path.join(home, 'dsh-sync.json'), 'utf8')) || {}; } catch { fileCfg = {}; }
  const overrides = { ...config };
  delete overrides.home;
  const cfg = { ...DEFAULT_CONFIG, ...fileCfg, ...overrides };
  const log = makeLogger(ctx);

  const engine = new SyncEngine(home, overrides, log);
  const disposers = [];

  // 删除/取消归档等登记表改动后,不逐次提交+推送(每次都会阻塞事件循环等 git 网络往返):
  // 合并为一次延迟刷新(默认 60s 静默期兜底),设置页退出时由客户端显式调
  // /api/session/flush 统一提交+推送(弹阻塞遮罩提示等待)。
  // 否则下次拉取会把旧登记又带回来(删除"复活")。
  let flushTimer = null;
  let pendingOps = 0;
  const scheduleFlush = () => {
    pendingOps += 1;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const n = pendingOps; pendingOps = 0;
      try {
        engine.flushSync();
        log('info', `操作后延迟同步完成(${n} 项会话操作合并为一次提交+推送)`);
      } catch (e) {
        pendingOps += n;
        log('warn', '操作后延迟同步失败(下次手动同步会补上): ' + String((e && e.message) || e));
      }
    }, 60 * 1000);
  };
  const pendingOpCount = () => pendingOps;
  const clearPendingFlush = () => { if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; } };

  /* ================= 补丁管理 —— patches/ 随主仓库跨机同步,启动/同步后自动套用到 node_modules ================= */
  // 应用发生在 dsh 启动之后,当前进程仍是旧代码 → 重启 dsh 生效;幂等(内容一致即跳过)。
  let patchResults = [];
  let patchAppliedAt = 0;
  const runPatches = (reason) => {
    if (cfg.patches === false) return;
    try {
      const t0 = Date.now();
      const r = applyAllPatches(home);
      patchResults = r.results;
      patchAppliedAt = r.appliedAt;
      if (patchResults.length) {
        for (const line of formatApplyResults(patchResults)) log('info', `补丁[${reason}]: ${line}`);
        log('info', `补丁检查完成(${patchResults.length} 个,${Date.now() - t0}ms;套用需重启 dsh 生效)`);
      }
    } catch (e) {
      log('warn', '补丁应用失败: ' + String((e && e.message) || e));
    }
  };
  const patchesSummaryText = () => {
    if (cfg.patches === false || !patchResults.length) return '';
    const lines = formatApplyResults(patchResults);
    return lines.join(';') + (patchAppliedAt ? `(${new Date(patchAppliedAt).toLocaleString()})` : '');
  };
  // 启动即套用一次(DSH 升级覆盖 node_modules 后,重启就能补回;跨机拉到新补丁同样生效)
  runPatches('startup');
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

  // —— API 路由:供浏览器端原生 UI(侧栏按钮 / 设置同步状态卡)调用 ——
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
          runPatches('after-sync');
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
          workspaceCount: typeof engine.workspaces === 'function' ? engine.workspaces().length : 0,
          lastSyncAt: engine.lastSyncAt,
          lastOk: engine.lastOutcome ? !engine.lastOutcome.error : null,
          lastMessage: engine.lastOutcome ? summarize(engine.lastOutcome) : '',
          lastDetail: lastDetail(engine.lastOutcome),
          patches: patchesSummaryText(),
          autoRestartAfterRepair: c.autoRestartAfterRepair === true,
        });
      },
    }));
    // —— 配置读写:保存「同步后自动重启」等开关到 dsh-sync.json(与插件默认值/引擎逐层合并) ——
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-sync/api/config',
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            const c = engine.loadConfig();
            json(res, 200, {
              ok: true,
              config: {
                mode: c.mode || 'manual',
                enabled: c.enabled !== false,
                intervalSeconds: c.intervalSeconds,
                autoPullOnStart: c.autoPullOnStart,
                autoPushOnExit: c.autoPushOnExit,
                workspaceSync: c.workspaceSync !== false,
                autoRestartAfterRepair: c.autoRestartAfterRepair === true,
                proxy: c.proxy || '',
              },
            });
            return;
          }
          if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method not allowed' }); return; }
          const body = JSON.parse((await readBody(req)) || '{}');
          const cfgFile = path.join(home, 'dsh-sync.json');
          let fileCfg = {};
          try { fileCfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')) || {}; } catch { fileCfg = {}; }
          // 只接受白名单字段,避免客户端覆盖 remote/密钥等敏感配置
          const patch = {};
          if (body.autoRestartAfterRepair !== undefined) patch.autoRestartAfterRepair = body.autoRestartAfterRepair === true;
          if (body.workspaceSync !== undefined) patch.workspaceSync = body.workspaceSync !== false;
          if (body.autoPullOnStart !== undefined) patch.autoPullOnStart = body.autoPullOnStart === true;
          if (body.autoPushOnExit !== undefined) patch.autoPushOnExit = body.autoPushOnExit === true;
          if (typeof body.mode === 'string' && ['manual', 'auto'].includes(body.mode)) patch.mode = body.mode;
          if (typeof body.proxy === 'string') patch.proxy = body.proxy.trim();
          const merged = { ...fileCfg, ...patch };
          fs.writeFileSync(cfgFile, JSON.stringify(merged, null, 2) + '\n', 'utf8');
          json(res, 200, { ok: true, saved: patch });
        } catch (e) {
          json(res, 200, { ok: false, error: String((e && e.message) || e) });
        }
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
          transfer: p.transfer || null,
          startedAt: p.startedAt || 0,
          lastSyncAt: engine.lastSyncAt,
          lastOk: engine.lastOutcome ? !engine.lastOutcome.error : null,
          lastMessage: engine.lastOutcome ? summarize(engine.lastOutcome) : '',
        });
      },
    }));
    // —— 补丁管理:patches/ 随主仓库同步,这里查看状态/手动套用(套用后重启 dsh 生效)——
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-sync/api/patches',
      handler: (req, res) => {
        json(res, 200, { ok: true, enabled: cfg.patches !== false, patches: patchResults, summary: patchesSummaryText(), appliedAt: patchAppliedAt });
      },
    }));
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-sync/api/patches/apply',
      handler: async (req, res) => {
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method not allowed' }); return; }
        runPatches('api');
        json(res, 200, { ok: true, patches: patchResults, summary: patchesSummaryText() });
      },
    }));
    // —— 冲突(「双边保留」)列表与裁决 —— 仿 OneNote:把冲突呈现给用户抉择
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-sync/api/conflicts',
      handler: (req, res) => {
        try {
          const list = engine.outstandingConflicts();
          // 会话日志冲突:补上原标题(从投影缓存读),让用户能判断保留哪一侧;投影缓存冲突标记为可再生
          const SESSION_LOG = /^sessions\/[^/]+\/session-([0-9a-f-]{36})\/session\.jsonl(\.zstd)?$/i;
          const CACHE = /^storages\/session_projcache\/sessions\/(session-[0-9a-f-]{36})\.json$/i;
          for (const c of list) {
            const m = SESSION_LOG.exec(c.path || '');
            const cm = m ? null : CACHE.exec(c.path || '');
            if (m) {
              c.sessionId = m[1];
              c.title = readProjection(home, m[1]).title || '(无标题)';
            } else if (cm) {
              c.sessionId = cm[1];
              c.cache = true; // 可再生缓存:保留本机即可,下次同步会自动清理
              c.title = (readProjection(home, cm[1]).title || '(无标题)') + ' · 会话投影缓存(可再生)';
            } else {
              c.title = (c.path || '').split('/').pop() || c.path || '';
            }
          }
          json(res, 200, { ok: true, conflicts: list, count: list.length });
        } catch (e) {
          json(res, 200, { ok: false, error: String((e && e.message) || e) });
        }
      },
    }));
    // 冲突两侧内容预览:本机活动文件 vs 远端版本拷贝(标题 + 最近消息)
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-sync/api/conflict/preview',
      handler: async (req, res) => {
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method not allowed' }); return; }
        try {
          const body = JSON.parse((await readBody(req)) || '{}');
          const p = String(body.path || '');
          const cp = String(body.copy || '');
          const m = /^sessions\/[^/]+\/session-([0-9a-f-]{36})\//i.exec(p);
          const idHint = m ? m[1] : '';
          const localFile = path.join(home, p);
          if (m) {
            // 会话日志冲突:按消息预览
            const local = fs.existsSync(localFile) ? readSessionPreviewPath(home, localFile, idHint) : { id: idHint, found: false, title: '', messageCount: 0, truncated: false, messages: [] };
            let remote = { id: idHint, found: false, title: '', messageCount: 0, truncated: false, messages: [] };
            if (cp) {
              const remoteFile = path.join(home, cp);
              if (fs.existsSync(remoteFile)) remote = readSessionPreviewPath(home, remoteFile, idHint);
            }
            json(res, 200, { ok: true, kind: 'session', sessionId: idHint, local, remote });
          } else {
            // 配置文件冲突:文本 diff(本机 vs 远端拷贝),让用户能真正判断
            const readText = (file) => {
              if (!fs.existsSync(file)) return null;
              const buf = fs.readFileSync(file);
              if (buf.includes(0)) return { binary: true, bytes: buf.length };
              const MAX = 120 * 1024;
              let text = buf.toString('utf8');
              const truncated = text.length > MAX;
              if (truncated) text = text.slice(0, MAX) + '\n…(已截断)';
              return { text, bytes: buf.length, truncated };
            };
            const local = readText(localFile);
            let remote = null;
            if (cp) remote = readText(path.join(home, cp));
            const localText = local && !local.binary ? local.text : '';
            const remoteText = remote && !remote.binary ? remote.text : '';
            const diff = (!localText && !remoteText) ? '' : unifiedTextDiff(localText, remoteText);
            json(res, 200, { ok: true, kind: 'text', sessionId: idHint, local, remote, diff });
          }
        } catch (e) {
          json(res, 200, { ok: false, error: String((e && e.message) || e) });
        }
      },
    }));
    // 工作区路径覆盖:本机专属(不同步);可指定其他文件夹或清空恢复默认
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-sync/api/workspace/path',
      handler: async (req, res) => {
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method not allowed' }); return; }
        try {
          const body = JSON.parse((await readBody(req)) || '{}');
          const id = String(body.workspaceId || '').trim();
          if (!id) throw new Error('缺少 workspaceId');
          const p = String(body.path || '').trim();
          if (p) {
            const abs = path.resolve(p);
            try { fs.mkdirSync(abs, { recursive: true }); } catch (e) { throw new Error('无法创建文件夹 ' + abs + ': ' + (e && e.message)); }
            engine.setLocalWorkspacePath(id, abs);
          } else {
            engine.setLocalWorkspacePath(id, null);
          }
          json(res, 200, { ok: true, workspaceId: id, path: p || null });
        } catch (e) {
          json(res, 200, { ok: false, error: String((e && e.message) || e) });
        }
      },
    }));
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-sync/api/conflict/resolve',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'method not allowed' });
          return;
        }
        try {
          const body = JSON.parse((await readBody(req)) || '{}');
          const conflict = {
            kind: body.kind || 'main',
            id: body.id || null,
            path: String(body.path || ''),
            copy: body.copy || null,
          };
          const resolution = String(body.resolution || '');
          if (!['local', 'remote', 'both'].includes(resolution)) throw new Error('非法裁决,应为 local/remote/both');
          const r = await engine.resolveConflict(conflict, resolution);
          json(res, 200, { ok: true, result: r, summary: '已按「' + resolution + '」裁决冲突 ' + conflict.path });
        } catch (e) {
          json(res, 200, { ok: false, error: String((e && e.message) || e) });
        }
      },
    }));
    // —— 会话归档管理:列出全部会话(含已归档/幽灵),支持取消归档与彻底删除 ——
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-sync/api/sessions',
      handler: (req, res) => {
        try {
          const rows = sessionRows(home);
          json(res, 200, { ok: true, sessions: rows, total: rows.length });
        } catch (e) {
          json(res, 200, { ok: false, error: String((e && e.message) || e) });
        }
      },
    }));
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-sync/api/session/unarchive',
      handler: async (req, res) => {
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method not allowed' }); return; }
        try {
          const body = JSON.parse((await readBody(req)) || '{}');
          const r = unarchiveSession(home, String(body.id || '').trim());
          json(res, 200, { ok: true, ...r });
          scheduleFlush();
        } catch (e) {
          json(res, 200, { ok: false, error: String((e && e.message) || e) });
        }
      },
    }));
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-sync/api/session/delete',
      handler: async (req, res) => {
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method not allowed' }); return; }
        try {
          const body = JSON.parse((await readBody(req)) || '{}');
          const r = deleteSessionPermanent(home, String(body.id || '').trim());
          json(res, 200, { ok: true, ...r });
          scheduleFlush();
        } catch (e) {
          json(res, 200, { ok: false, error: String((e && e.message) || e) });
        }
      },
    }));
    // —— 会话内容预览:读取会话日志(zstd 解码),返回最近消息供设置面板内联展示 ——
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-sync/api/session/preview',
      handler: async (req, res) => {
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method not allowed' }); return; }
        try {
          const body = JSON.parse((await readBody(req)) || '{}');
          const r = readSessionPreview(home, String(body.id || '').trim());
          json(res, 200, { ok: true, ...r });
        } catch (e) {
          json(res, 200, { ok: false, error: String((e && e.message) || e) });
        }
      },
    }));
    // —— 会话操作统一提交:删除/取消归档后由客户端在退出设置页时调用,把积累的改动合并为一次提交+推送 ——
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-sync/api/session/flush',
      handler: async (req, res) => {
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method not allowed' }); return; }
        try {
          clearPendingFlush();
          const n = pendingOpCount();
          if (n === 0) { json(res, 200, { ok: true, pending: 0, summary: '无待同步的会话操作' }); return; }
          engine.flushSync();
          pendingOps = 0;
          json(res, 200, { ok: true, pending: n, summary: `已提交并推送 ${n} 项会话操作(合并为一次同步)` });
        } catch (e) {
          json(res, 200, { ok: false, pending: pendingOpCount(), error: String((e && e.message) || e) });
        }
      },
    }));
  } catch (err) {
    log('warn', 'webServer 不可用,API 未注册(命令行同步仍可用): ' + String((err && err.message) || err));
  }

  // —— 冲突裁决工具:列出双边保留的冲突;按用户选择提交解决并推送 ——
  const toolOut = { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] };
  try {
    disposers.push(ctx.tools.register({
      name: 'sync_conflicts',
      description: '列出本次同步发现、已「双边保留」待裁决的冲突文件(主仓库或某个工作区),含本机版本路径与远端版本拷贝路径(.dsh-conflict-<时间戳>)。用于在冲突后让用户选择保存哪一侧。',
      parameters: {},
      output: toolOut,
      async execute() {
        const list = engine.outstandingConflicts();
        if (!list.length) return '(当前没有待裁决的冲突)';
        return list.map((c, i) =>
          `${i + 1}. ${c.kind === 'ws' ? '工作区[' + (c.id || '?') + ']' : '主仓库'} ${c.path}\n   本机版本: ${c.path}\n   远端版本拷贝: ${c.copy || '(无)'}`,
        ).join('\n');
      },
    }));
    disposers.push(ctx.tools.register({
      name: 'sync_conflict_resolve',
      description: '裁决一个「双边保留」的冲突:resolution = local(保留本机版本,删除远端拷贝) | remote(用远端拷贝覆盖本机版本) | both(两侧都保留)。先 sync_conflicts 拿到 path/copy,并和用户确认后再执行。',
      parameters: {
        path: { type: 'string', required: true, description: '冲突文件路径(来自 sync_conflicts)' },
        copy: { type: 'string', required: false, description: '远端版本拷贝路径(来自 sync_conflicts 的 .dsh-conflict-* 项);采用远端版本时需要' },
        resolution: { type: 'string', required: true, description: 'local | remote | both' },
        kind: { type: 'string', required: false, description: 'main | ws(默认 main)' },
        id: { type: 'string', required: false, description: '工作区 id(kind=ws 时必填)' },
      },
      output: toolOut,
      async execute(args) {
        const conflict = {
          kind: String(args.kind || 'main'),
          id: args.id ? String(args.id) : null,
          path: String(args.path || ''),
          copy: args.copy ? String(args.copy) : null,
        };
        const resolution = String(args.resolution || '');
        if (!['local', 'remote', 'both'].includes(resolution)) throw new Error('非法裁决,应为 local/remote/both');
        const r = await engine.resolveConflict(conflict, resolution);
        return `已裁决冲突 ${conflict.path}:按「${resolution}」处理并已提交/推送。${r.copy ? '远端拷贝: ' + r.copy : ''}`;
      },
    }));
    // —— 会话归档管理工具 ——
    disposers.push(ctx.tools.register({
      name: 'session_list',
      description: '列出本机全部 DSH 会话(含已归档与幽灵会话):标题、id、所属工作区、创建/最后活动时间、大小、是否归档、是否幽灵(有 id 无文件)。用于在取消归档/删除前定位会话。',
      parameters: {},
      output: toolOut,
      async execute() {
        const rows = sessionRows(home);
        if (!rows.length) return '(本机没有会话)';
        return rows.map((r, i) =>
          `${i + 1}. ${r.title || '(无标题)'} | ${r.id}\n   ${r.workspace || '?'} | ${r.archived ? '已归档' : '活动'}${r.ghost ? ' | 幽灵(无文件)' : ''} | ${r.sizeKB}KB | 创建 ${r.createdAt ? new Date(r.createdAt).toLocaleString() : '?'} | 活动 ${r.updatedAt ? new Date(r.updatedAt).toLocaleString() : '?'}`,
        ).join('\n');
      },
    }));
    disposers.push(ctx.tools.register({
      name: 'session_unarchive',
      description: '取消归档指定会话(id 来自 session_list),把它从「已归档」移回其所属工作区,侧边栏即可见。',
      parameters: {
        id: { type: 'string', required: true, description: '会话 id(session- 开头,来自 session_list)' },
      },
      output: toolOut,
      async execute(args) {
        const r = unarchiveSession(home, String(args.id || '').trim());
        return r.ok ? `已取消归档会话 ${args.id}(已回到其工作区,侧边栏可见)` : `会话 ${args.id} 本就不在归档列表(无需操作)`;
      },
    }));
    disposers.push(ctx.tools.register({
      name: 'session_delete',
      description: '彻底删除指定会话(id 来自 session_list):移除其会话文件与投影缓存,并从归档/工作区登记表移除。对已归档或幽灵会话均可。不可恢复,执行前请与用户确认。',
      parameters: {
        id: { type: 'string', required: true, description: '会话 id(session- 开头,来自 session_list)' },
      },
      output: toolOut,
      async execute(args) {
        const r = deleteSessionPermanent(home, String(args.id || '').trim());
        return `已彻底删除会话 ${args.id}(文件+登记项)。`;
      },
    }));
    // —— 补丁管理工具:patches/ 随同步仓库跨机分发,查看/套用本机补丁(web_fetch 代理回退等) ——
    disposers.push(ctx.tools.register({
      name: 'sync_patches',
      description: '查看并应用 dsh-sync-plugin 托管的 node_modules 补丁(如 web_fetch 直连失败回退系统代理)。补丁文件在 .dsh/patches/ 下、随同步仓库跨机分发,每次启动/同步后自动套用;应用后需重启 dsh 生效。无参数执行 = 检查并套用,返回每个补丁的当前状态。',
      parameters: {},
      output: toolOut,
      async execute() {
        runPatches('tool');
        const lines = formatApplyResults(patchResults);
        return lines.length
          ? lines.join('\n') + '\n(套用后重启 dsh 生效;补丁文件与清单位于 .dsh/patches/<名字>/,随同步仓库跨机分发)'
          : '(补丁目录为空 —— 在 .dsh/patches/<名字>/ 放入 patch.json 清单与 payload 文件即可托管补丁,清单字段见插件 README「补丁管理」)';
      },
    }));
  } catch (err) {
    log('warn', '冲突裁决工具注册失败: ' + String((err && err.message) || err));
  }

  // —— 自动模式才有的定时/事件钩子 ——
  const autoWanted = cfg.mode === 'auto' && cfg.enabled !== false;
  if (autoWanted) {
    if (cfg.autoPullOnStart !== false) {
      engine.syncOnce('startup').then(() => runPatches('after-sync')).catch((e) => log('warn', `启动同步失败: ${e?.message || e}`));
    }
    const intervalMs = Math.max(30, Number(cfg.intervalSeconds) || 300) * 1000;
    const timer = setInterval(() => {
      engine.syncOnce('interval').then(() => runPatches('after-sync')).catch((e) => log('warn', `定时同步失败: ${e?.message || e}`));
    }, intervalMs);
    timer.unref?.();
    let debounceTimer = null;
    try {
      disposers.push(ctx.on('session/event', () => {
        if (debounceTimer) return;
        const delayMs = Math.max(5, Number(cfg.eventDebounceSeconds) || 15) * 1000;
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          engine.syncOnce('activity').then(() => runPatches('after-sync')).catch((e) => log('warn', '活动同步失败: ' + (e?.message || e)));
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
  log('info', `dsh-sync-plugin 已启动(mode=${cfg.mode || 'manual'}, home=${home}, 分支=${cfg.branch}, remote=${cfg.remote || '(未配置,仅本地快照)'}, UI=侧栏「⟳ 同步」按钮(实时进度) + 设置「同步」状态卡)`);
}

export { name, inject, apply, sessionRows, unarchiveSession, deleteSessionPermanent, readSessionPreview, readSessionPreviewPath };
