// dsh-sync 手动同步入口:双击桌面「同步DSH.cmd」或在对话里让 agent 执行本脚本。
// 不依赖 dsh 是否运行;每次执行 = 提交本地快照 + 推送 + 拉取远端,一次完成(手动触发免提交节流)。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SyncEngine, DEFAULT_CONFIG } from './sync.js';

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
let fileCfg = {};
try {
  fileCfg = JSON.parse(fs.readFileSync(path.join(home, 'dsh-sync.json'), 'utf8')) || {};
} catch { /* 用默认配置 */ }
const cfg = { ...DEFAULT_CONFIG, ...fileCfg };

const log = (level, msg) => {
  const line = `[dsh-sync] ${msg}`;
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
if (r.conflicts?.length) parts.push('冲突文件保留本机版本: ' + r.conflicts.join(', '));
if (r.backupBranch) parts.push('远端旧版本备份在 ' + r.backupBranch);
if (r.error) parts.push('出错: ' + r.error);
if (r.skipped) parts.push('跳过: ' + r.skipped);
console.log(parts.length ? '>> 同步完成: ' + parts.join('；') : '>> 没有需要同步的变更(本地与远端一致)');
