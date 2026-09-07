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
  return {
    committed: Boolean(r.committed),
    pushed: Boolean(r.pushed),
    pulled: r.pulled || null,
    error: r.error || null,
    skipped: r.skipped || null,
    conflicts: Array.isArray(r.conflicts) ? r.conflicts : [],
    backupBranch: r.backupBranch || null,
    workspaces: w ? {
      total: w.total || 0,
      synced: w.synced || 0,
      pushed: w.pushed || 0,
      pulled: w.pulled || 0,
      skipped: w.skipped || null,
      errors: Array.isArray(w.errors) ? w.errors.map((e) => ({ id: e.id, title: e.title, path: e.path, error: e.error })) : [],
    } : null,
  };
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
  } catch (err) {
    log('warn', 'webServer 不可用,API 未注册(命令行同步仍可用): ' + String((err && err.message) || err));
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
  log('info', `dsh-sync-plugin 已启动(mode=${cfg.mode || 'manual'}, home=${home}, 分支=${cfg.branch}, remote=${cfg.remote || '(未配置,仅本地快照)'}, UI=侧栏「⟳ 同步」按钮(实时进度) + 设置「同步」状态卡)`);
}

export { name, inject, apply };
