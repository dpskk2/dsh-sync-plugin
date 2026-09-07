// dsh-sync-plugin 手动同步入口:双击桌面「同步DSH.cmd」或在对话里让 agent 执行本脚本。
// 不依赖 dsh 是否运行;每次执行 = 提交本地快照 + 推送 + 拉取远端,一次完成(手动触发免提交节流)。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SyncEngine, DEFAULT_CONFIG } from './sync.js';
import { applyAllPatches, formatApplyResults } from './patches.js';

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
let fileCfg = {};
try {
  fileCfg = JSON.parse(fs.readFileSync(path.join(home, 'dsh-sync.json'), 'utf8')) || {};
} catch { /* 用默认配置 */ }
const cfg = { ...DEFAULT_CONFIG, ...fileCfg };

const log = (level, msg) => {
  const line = `[dsh-sync-plugin] ${msg}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

if (!cfg.remote) {
  log('warn', '尚未配置 remote —— 编辑 ' + path.join(home, 'dsh-sync.json') + ' 填入 GitHub 私有仓库地址;本次只做本地快照。');
}

// 手动触发:免提交节流
const engine = new SyncEngine(home, { minCommitIntervalSeconds: 0 }, log);
const r = await engine.syncOnce('manual-cli', { forceCommit: true }).catch((e) => ({ error: String(e?.message || e) }));

const parts = [];
if (r.committed) parts.push('已提交本地快照');
if (r.pulled) parts.push(`已拉取远端(${r.pulled})`);
if (r.pushed) parts.push('已推送远端');
if (r.conflicts?.length) parts.push(r.conflicts.length + ' 个冲突「双边保留」待裁决');
if (r.backupBranch) parts.push('远端旧版本备份在 ' + r.backupBranch);
if (r.error) parts.push('出错: ' + r.error);
if (r.skipped) parts.push('跳过: ' + r.skipped);
console.log(parts.length ? '>> 同步完成: ' + parts.join('；') : '>> 没有需要同步的变更(本地与远端一致)');

// 补丁管理:patches/ 随主仓库同步,同步后把最新补丁套用到本机 node_modules(重启 dsh 生效)
if (cfg.patches !== false) {
  try {
    const pr = applyAllPatches(home);
    if (pr.results.length) {
      for (const line of formatApplyResults(pr.results)) console.log('>> 补丁: ' + line + '(套用后重启 dsh 生效)');
    }
  } catch (e) { console.log('>> 补丁应用失败: ' + String((e && e.message) || e)); }
}
// 详细排障:逐个列出冲突(两边版本位置)、工作区同步结果与失败原因(保留在终端,退出后可翻看)
const conflictCopies = [
  ...(Array.isArray(r.conflictCopies) ? r.conflictCopies : []),
  ...(r.workspaces && Array.isArray(r.workspaces.conflictCopies) ? r.workspaces.conflictCopies : []),
];
if (conflictCopies.length) {
  console.log('-- 冲突(双边保留,可用 sync_conflicts / sync_conflict_resolve 裁决):');
  for (const c of conflictCopies) {
    console.log(`   • ${c.kind === 'ws' ? '[工作区' + (c.id || '?') + '] ' : ''}${c.path}${c.copy ? '\n     远端版本拷贝: ' + c.copy : ''}`);
  }
}
if (r.workspaces && (r.workspaces.total || (r.workspaces.errors && r.workspaces.errors.length))) {
  const w = r.workspaces;
  console.log(`-- 工作区: 共 ${w.total || 0},已同步 ${w.synced || 0},推送 ${w.pushed || 0},拉取 ${w.pulled || 0}` + (w.skipped ? `,跳过 ${w.skipped}` : ''));
  if (w.errors && w.errors.length) {
    for (const e of w.errors) console.log(`   ✗ ${e.title || e.id || '?'}: ${e.error || '未知错误'}${e.path ? ' (' + e.path + ')' : ''}`);
  }
}
if (r.error) process.exitCode = 1;
