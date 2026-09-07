/**
 * dsh-sync-plugin 同步引擎 —— 纯 git 编排,不依赖任何 npm 包。
 *
 * 设计:
 *  - 仓库根就是 DSH home(即 .dsh 目录本身),.gitignore 排除密钥/缓存/依赖目录。
 *  - 无 remote 时只做本地快照提交(免费获得 .dsh 的版本历史)。
 *  - 有 remote 时:fetch → 本地变更先提交 → 与远端对齐:
 *      · 远端领先        → 快进拉取(fast-forward)
 *      · 本地领先        → 推送
 *      · 双方都有新提交  → 尝试 merge(不同会话文件自动并集);
 *        仍有冲突的文件保留本地版本,远端版本先备份到 backup/<时间戳> 分支再丢弃。
 *  - 所有 git 调用带超时,异常只记日志,绝不弄脏业务数据。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// zstd 解码(读会话日志头取 cwd 用):Node ≥22.10 才有;旧版本自动降级(回退为分组名还原)
let zstdDecompressSync = null;
try { ({ zstdDecompressSync } = await import('node:zlib')); } catch { zstdDecompressSync = null; }

/** 默认配置(可被 .dsh/dsh-sync.json 与插件 apply 时传入的 config 逐层覆盖) */
export const DEFAULT_CONFIG = {
  mode: 'manual', // 'manual' = 纯手动(按钮/对话触发);'auto' = 自动同步
  enabled: true,
  remote: '',
  branch: 'main',
  intervalSeconds: 300,
  eventDebounceSeconds: 15,
  minCommitIntervalSeconds: 120,
  autoPullOnStart: true,
  autoPushOnExit: true,
  commitMessage: 'dsh-sync-plugin: auto snapshot',
  patches: true, // 是否应用 <home>/patches/ 下的 node_modules 补丁(web_fetch 代理回退等;补丁随主仓库跨机同步)
  gitUserName: 'dsh-sync-plugin',
  gitUserEmail: 'dsh-sync-plugin@localhost',
  extraIgnore: [],
  autoRepo: true,        // 首次同步(remote 为空)时,自动创建/复用 GitHub 私有仓库
  repoName: 'dsh-sync',  // 自动使用的仓库名;remote 已配置时不生效
  repoOwner: '',         // 仓库所属用户名;留空则取 gh 登录账号
  repoDescription: '',   // 自动创建仓库时的描述(可选)
  workspaceSync: true,        // 是否同步工作区文件夹内容(完整备份/恢复;目标机缺文件夹自动创建)
  workspaceBranchPrefix: 'ws',// 工作区分支前缀 → ws/<workspaceId>
  workspaceBase: '',          // 可选:所有工作区统一映射到该目录下(按文件夹名),用于跨机路径不一致
  workspaceExtraIgnore: ['node_modules'], // 工作区内容额外排除(目录名;.git 恒排除);写入影子仓库 info/exclude,不碰真实文件夹
};

/** 内置 .gitignore:密钥与机器本地状态永不同步;可再生缓存不同步 */
export const BUILTIN_IGNORE = [
  '# ===== dsh-sync-plugin 自动生成(手工改动会被保留;删除本文件后下次同步重新生成)=====',
  '',
  '# 密钥与机器本地状态 —— 永不同步',
  '.credentials.yaml',
  '.anonymous-user-id',
  '.dshw-size.json',
  '.dshw-usage.json',
  '',
  '# 会话投影缓存目录会同步(含会话标题 / cwd —— 用于跨机还原「工作区↔会话」对应关系);',
  '# 仅排除单个同级文件(不存在则无影响),目录本身保留,避免第二台电脑丢失会话归属信息',
  'storages/session_projcache.json',
  '',
  '# 依赖目录 —— 不同步(在新电脑的 profiles/web 里执行 pnpm install 恢复)',
  '**/node_modules/',
  '',
  '# 同步引擎自身状态',
  '.dsh-sync.state.json',
  '',
  '# 工作区影子仓库(各工作区独立的 git 仓库,不与主仓库混同)',
  'workspace-repos/',
].join('\n');

/** 会话分组文件夹名 → 原始路径(与 DSH 的 projectKey 编码互逆;编码本身有损,尽力还原) */
export function decodeGroup(group) {
  try {
    let s = String(group).replace(/^--/, '').replace(/--$/, '');
    s = s.replace(/~([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    return s.replace(/-/g, '\\');
  } catch { return String(group); }
}

/** 路径规范化:统一盘符冒号与分隔符、忽略大小写 —— 用于跨机「会话分组 ↔ 工作区路径」比对 */
export function normPath(p) {
  return String(p).replace(/[/\\:]+/g, '\\').replace(/\\+$/, '').toLowerCase();
}

/** 从路径取工作区显示名(新建工作区条目时用) */
function titleFromPath(p) {
  try {
    const base = String(p).replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop();
    return base || String(p);
  } catch { return String(p); }
}

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

export class SyncEngine {
  /**
   * @param home      DSH home(.dsh 绝对路径)
   * @param overrides 插件加载时传入的配置覆盖(可为 {})
   * @param log       (level: 'info'|'warn'|'error', msg: string) => void
   */
  constructor(home, overrides = {}, log = () => {}) {
    this.home = home;
    this.overrides = overrides;
    this.log = log;
    this.inFlight = null;
    this.gitMissing = false;
    this.lastCommitAt = 0;
    this.commitsSinceGc = 0;
    /** 最近一次同步完成时间(epoch ms)与结果对象,供状态接口展示 */
    this.lastSyncAt = 0;
    this.lastOutcome = null;
    /** 实时进度:{ running, stage, label, startedAt },供 /api/progress 轮询展示 */
    this.progress = null;
  }

  configPath() {
    return path.join(this.home, 'dsh-sync.json');
  }

  /** 每次同步都重新读配置文件,改动无需重启 dsh */
  loadConfig() {
    let fileCfg = {};
    try {
      fileCfg = JSON.parse(fs.readFileSync(this.configPath(), 'utf8')) || {};
    } catch { /* 缺失或坏 JSON 都按空配置处理 */ }
    return { ...DEFAULT_CONFIG, ...fileCfg, ...this.overrides };
  }

  /** 更新实时进度(供 /api/progress 轮询;startedAt 在 _syncOnce 入口统一设定) */
  step(stage, label) {
    this.progress = { ...(this.progress || {}), running: true, stage, label, at: Date.now() };
  }

  /** 异步执行一条 git 命令,返回 { code, out, err };git 缺失时 code = -1 */
  git(args, timeoutMs = 120000) {
    return new Promise((resolve) => {
      let out = '';
      let err = '';
      let settled = false;
      let child;
      try {
        child = spawn('git', args, { cwd: this.home, windowsHide: true });
      } catch (e) {
        resolve({ code: -1, out: '', err: String(e) });
        return;
      }
      const timer = setTimeout(() => {
        if (!settled) {
          try { child.kill(); } catch { /* ignore */ }
        }
      }, timeoutMs);
      child.stdout?.on('data', (d) => { out += d; });
      child.stderr?.on('data', (d) => { err += d; });
      child.on('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const msg = String(e?.message || e);
        if (msg.includes('ENOENT')) this.gitMissing = true;
        resolve({ code: -1, out, err: msg });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, out, err });
      });
    });
  }

  /** 字节安全地执行一条 git 命令(用于读取冲突双方二进制内容),stdout 以 Buffer 返回 */
  gitBytes(args, timeoutMs = 60000) {
    return new Promise((resolve) => {
      const chunks = [];
      let err = '';
      let settled = false;
      let child;
      try {
        child = spawn('git', args, { cwd: this.home, windowsHide: true });
      } catch (e) {
        resolve({ code: -1, out: Buffer.alloc(0), err: String(e) });
        return;
      }
      const timer = setTimeout(() => {
        if (!settled) { try { child.kill(); } catch { /* ignore */ } }
      }, timeoutMs);
      child.stdout?.on('data', (d) => { chunks.push(d); });
      child.stderr?.on('data', (d) => { err += d; });
      child.on('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: -1, out: Buffer.alloc(0), err: String(e?.message || e) });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, out: Buffer.concat(chunks), err });
      });
    });
  }

  /** 同步(阻塞)执行一条 git 命令,用于退出冲刷;返回 { code, out, err } */
  gitSync(args, timeoutMs = 15000) {
    try {
      const r = spawnSync('git', args, { cwd: this.home, windowsHide: true, timeout: timeoutMs, encoding: 'utf8' });
      if (r.error) {
        const msg = String(r.error?.message || r.error);
        if (msg.includes('ENOENT')) this.gitMissing = true;
        return { code: -1, out: r.stdout || '', err: msg };
      }
      return { code: r.status ?? 1, out: r.stdout || '', err: r.stderr || '' };
    } catch (e) {
      return { code: -1, out: '', err: String(e) };
    }
  }

  ok(r) {
    return r.code === 0;
  }

  /** 异步执行 gh CLI(用于自动建仓/查询账号);返回 { code, out, err } */
  gh(args, timeoutMs = 60000) {
    return new Promise((resolve) => {
      let out = '';
      let err = '';
      let settled = false;
      let child;
      try {
        child = spawn('gh', args, { windowsHide: true });
      } catch (e) {
        resolve({ code: -1, out: '', err: String(e) });
        return;
      }
      const timer = setTimeout(() => {
        if (!settled) {
          try { child.kill(); } catch { /* ignore */ }
        }
      }, timeoutMs);
      child.stdout?.on('data', (d) => { out += d; });
      child.stderr?.on('data', (d) => { err += d; });
      child.on('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: -1, out, err: String(e?.message || e) });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, out, err });
      });
    });
  }

  /** 当前 gh 登录账号(login);未登录/gh 缺失时返回 null */
  async ghLogin() {
    const r = await this.gh(['api', 'user', '--jq', '.login']);
    return this.ok(r) ? r.out.trim() : null;
  }

  /** 把部分字段写回 dsh-sync.json(保留现有字段) */
  writeConfig(next) {
    const p = this.configPath();
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')) || {}; } catch { /* 缺文件/坏 JSON 都按空处理 */ }
    fs.writeFileSync(p, JSON.stringify({ ...cfg, ...next }, null, 2) + '\n', 'utf8');
  }

  /**
   * 首次同步(remote 为空)时的自动引导:用 gh 判定账号、按 repoName 查找/创建
   * 私有仓库,把 remote 写回配置并返回 URL。任何一步失败都退化为本地快照
   * (返回 null),绝不抛错中断。60 秒内只尝试一次,避免 auto 模式反复调用。
   */
  async bootstrapRemote(cfg) {
    if (cfg.autoRepo === false) return null;
    if (this._bootstrapAt && Date.now() - this._bootstrapAt < 60000) return null;
    this._bootstrapAt = Date.now();
    const owner = (cfg.repoOwner || (await this.ghLogin()));
    if (!owner) {
      this.log('warn', `未配置 remote 且无法通过 gh 取到 GitHub 账号 —— 本次仅本地快照。请先 gh auth login,或手动编辑 ${this.configPath()} 填入 remote`);
      return null;
    }
    const repo = cfg.repoName || 'dsh-sync';
    const remote = `https://github.com/${owner}/${repo}.git`;
    const view = await this.gh(['repo', 'view', `${owner}/${repo}`, '--json', 'visibility']);
    if (this.ok(view)) {
      // 已存在:直接复用;公开仓库给出提醒
      try {
        const parsed = JSON.parse(view.out.trim());
        if (parsed.visibility === 'PUBLIC') {
          this.log('warn', `${owner}/${repo} 是公开仓库(建议用私有,可能含对话数据): ${remote}`);
        }
      } catch { /* 解析失败照常用 */ }
      this.log('info', `已复用远端仓库 ${owner}/${repo} → ${remote}`);
    } else {
      const args = ['repo', 'create', `${owner}/${repo}`, '--private'];
      if (cfg.repoDescription) args.push('--description', cfg.repoDescription);
      const created = await this.gh(args);
      if (!this.ok(created)) {
        this.log('warn', `自动创建私有仓库失败(可手动建仓,或编辑 ${this.configPath()} 填 remote): ${created.err.trim().split('\n')[0] || created.code}`);
        return null;
      }
      this.log('info', `已自动创建私有仓库 https://github.com/${owner}/${repo} → ${remote}`);
    }
    await this.writeConfig({ remote });
    return remote;
  }

  async rev(ref) {
    const r = await this.git(['rev-parse', '--verify', ref]);
    return this.ok(r) ? r.out.trim() : null;
  }

  async isAncestor(a, b) {
    if (!a || !b) return false;
    return this.ok(await this.git(['merge-base', '--is-ancestor', a, b]));
  }

  /** 确保 .git 仓库、身份配置与 .gitignore 就位 */
  async ensureRepo(cfg) {
    const gitDir = path.join(this.home, '.git');
    if (!fs.existsSync(gitDir)) {
      const r = await this.git(['init', '-b', cfg.branch]);
      if (!this.ok(r)) {
        this.log('error', `git init 失败: ${r.err.trim() || r.code}`);
        return false;
      }
      this.log('info', `已在 ${this.home} 初始化本地 git 仓库(分支 ${cfg.branch})`);
    }
    // 确保 origin 指向配置的远端(不存在则添加,URL 变了则更新)
    if (cfg.remote) {
      const cur = await this.git(['remote', 'get-url', 'origin']);
      if (!this.ok(cur)) {
        await this.git(['remote', 'add', 'origin', cfg.remote]);
      } else if (cur.out.trim().replace(/\/+$/, '') !== String(cfg.remote).replace(/\/+$/, '')) {
        await this.git(['remote', 'set-url', 'origin', cfg.remote]);
      }
      // 只取主分支:默认 refspec(+refs/heads/*)会把各工作区 ws/* 分支也拉进主仓库,没必要
      await this.git(['config', 'remote.origin.fetch', '+refs/heads/' + cfg.branch + ':refs/remotes/origin/' + cfg.branch]);
    }
    // 仓库本地配置:身份、换行、签名——保证提交在任何机器上都能成功
    await this.git(['config', 'user.name', cfg.gitUserName]);
    await this.git(['config', 'user.email', cfg.gitUserEmail]);
    await this.git(['config', 'core.autocrlf', 'false']);
    await this.git(['config', 'core.safecrlf', 'false']);
    await this.git(['config', 'commit.gpgsign', 'false']);
    const ignorePath = path.join(this.home, '.gitignore');
    if (!fs.existsSync(ignorePath)) {
      const lines = [...BUILTIN_IGNORE.split('\n'), ...(cfg.extraIgnore || [])];
      fs.writeFileSync(ignorePath, lines.join('\n') + '\n', 'utf8');
      this.log('info', '已生成 .gitignore(排除密钥/缓存/node_modules)');
    }
    // 确保主仓库排除工作区影子仓库目录(避免把各工作区 git 元数据误当普通文件提交)
    try {
      const cur = fs.readFileSync(ignorePath, 'utf8');
      if (!/^workspace\-repos\/$/m.test(cur)) {
        fs.writeFileSync(ignorePath, cur.replace(/\s*$/, '\n') + 'workspace-repos/\n', 'utf8');
      }
    } catch { /* ignore */ }
    return true;
  }

  /**
   * 有变更就 add + commit。受 minCommitIntervalSeconds 节流(force=true 绕过,
   * 用于合并/拉取前强制清空工作树)。返回 'committed' | 'clean' | 'throttled' | 'error'。
   */
  async commitIfDirty(cfg, force = false) {
    const st = await this.git(['status', '--porcelain']);
    if (!this.ok(st)) {
      this.log('error', `git status 失败: ${st.err.trim()}`);
      return 'error';
    }
    if (!st.out.trim()) return 'clean';
    const throttleMs = force ? 0 : Math.max(0, (Number(cfg.minCommitIntervalSeconds) || 0) * 1000);
    if (Date.now() - (this.lastCommitAt || 0) < throttleMs) return 'throttled';
    await this.git(['add', '-A']);
    const cm = await this.git(['commit', '-m', `${cfg.commitMessage} (${ts()})`]);
    if (!this.ok(cm)) {
      this.log('warn', `git commit 失败: ${cm.err.trim() || cm.out.trim()}`);
      return 'error';
    }
    this.lastCommitAt = Date.now();
    this.commitsSinceGc += 1;
    return 'committed';
  }

  /** 提交累计到一定量后做一次 git gc,回收二进制快照的冗余空间(失败静默) */
  async gcIfNeeded() {
    if (this.commitsSinceGc < 20) return;
    this.commitsSinceGc = 0;
    this.step('gc', '回收仓库空间(git gc)…');
    const r = await this.git(['gc', '--quiet'], 600000);
    if (!this.ok(r)) this.log('warn', `git gc 失败(不影响同步): ${r.err.trim().split('\n')[0] || r.code}`);
    else this.log('info', '已执行 git gc 回收仓库空间');
  }

  /** 把远端头备份到 backup/<ts> 分支并推送(丢弃远端版本前的保险) */
  async backupRemoteHead(cfg, remoteHead) {
    const branchName = `backup/${ts()}`;
    const cb = await this.git(['branch', branchName, remoteHead]);
    if (!this.ok(cb)) return null;
    const pb = await this.pushWithRetry(['push', 'origin', branchName]);
    if (!this.ok(pb)) {
      this.log('warn', `备份分支推送失败(本地分支 ${branchName} 已创建): ${pb.err.trim()}`);
      return branchName;
    }
    return branchName;
  }

  /* ================= 工作区内容同步(影子 git 仓库;core.worktree 指向真实文件夹) ================= */

  /** 读取 DSH 工作区登记表,返回 [{ id, path, title }](来自 storages/workspace.json) */
  workspaces() {
    try {
      const ws = JSON.parse(fs.readFileSync(path.join(this.home, 'storages', 'workspace.json'), 'utf8'));
      const tables = ws?.tables?.workspaces ?? {};
      const homeNorm = path.resolve(this.home);
      const out = [];
      for (const [id, w] of Object.entries(tables)) {
        if (!w || typeof w.path !== 'string' || !w.path) continue;
        // 跳过 DSH home 本身(.dsh)——它作为普通文件夹再同步会循环/带上密钥与 node_modules
        if (path.resolve(w.path) === homeNorm) continue;
        out.push({ id, path: w.path, title: typeof w.title === 'string' ? w.title : '' });
      }
      return out;
    } catch { return []; }
  }

  /** 工作区的影子仓库 git 目录(所有 git 元数据都在 .dsh 下,不在真实文件夹里) */
  workspaceGitDir(id) { return path.join(this.home, 'workspace-repos', id + '.git'); }
  workspaceBranchOf(cfg, id) { return (cfg.workspaceBranchPrefix || 'ws') + '/' + id; }

  /**
   * 解析工作区在【本机】应使用的真实文件夹路径。
   * - workspaceBase 配置优先:把工作区统一放到某目录下(按文件夹名)。
   * - 若记录路径在本机已存在 → 直接使用(源机器/已有文件夹)。
   * - 否则跨机重映射:Windows 下 C:\Users\<name>\... → 本机主目录\<相对部分>,换用户名也能对上。
   * - 都失败则返回记录的绝对路径(尽力创建)。
   */
  workspacePathOf(recorded, cfg) {
    if (!recorded) return null;
    const norm = String(recorded).replace(/\//g, path.sep);
    const base = (cfg.workspaceBase || '').trim();
    if (base) return path.join(base, path.basename(norm));
    const home = os.homedir();
    if (path.isAbsolute(norm) && fs.existsSync(norm)) return norm;
    const m = /^([A-Za-z]:\\Users\\[^\\]+)\\(.*)$/i.exec(norm);
    if (m && m[2]) return path.join(home, m[2]);
    return norm;
  }

  /** 在影子仓库上执行 git(工作树即真实文件夹) */
  gitW(gitdir, realPath, args, timeoutMs = 120000) {
    return this.git(['--git-dir=' + gitdir, '--work-tree=' + realPath, ...args], timeoutMs);
  }

  /** fetch 带一次快速重试:代理/网络瞬时抖动(schannel 握手失败)时重试一次常能成功 */
  async fetchWithRetry(args, timeoutMs = 180000) {
    const r1 = await this.git(args, timeoutMs);
    if (this.ok(r1)) return r1;
    await new Promise((res) => setTimeout(res, 1200));
    const r2 = await this.git(args, timeoutMs);
    if (this.ok(r2)) this.log('info', 'git fetch 首次失败(网络抖动)后重试成功');
    return r2;
  }
  /** 工作区版 fetch 重试 */
  async fetchWithRetryW(gitdir, realPath, args, timeoutMs = 180000) {
    const r1 = await this.gitW(gitdir, realPath, args, timeoutMs);
    if (this.ok(r1)) return r1;
    await new Promise((res) => setTimeout(res, 1200));
    const r2 = await this.gitW(gitdir, realPath, args, timeoutMs);
    if (this.ok(r2)) this.log('info', '工作区 git fetch 首次失败(网络抖动)后重试成功');
    return r2;
  }

  /** push 带一次快速重试:网络瞬时抖动时重试一次常能成功(已成功的 push 重试=Everything up-to-date,安全) */
  async pushWithRetry(args, timeoutMs = 180000) {
    const r1 = await this.git(args, timeoutMs);
    if (this.ok(r1)) return r1;
    await new Promise((res) => setTimeout(res, 1200));
    const r2 = await this.git(args, timeoutMs);
    if (this.ok(r2)) this.log('info', 'git push 首次失败(网络抖动)后重试成功');
    return r2;
  }
  /** 工作区版 push 重试 */
  async pushWithRetryW(gitdir, realPath, args, timeoutMs = 180000) {
    const r1 = await this.gitW(gitdir, realPath, args, timeoutMs);
    if (this.ok(r1)) return r1;
    await new Promise((res) => setTimeout(res, 1200));
    const r2 = await this.gitW(gitdir, realPath, args, timeoutMs);
    if (this.ok(r2)) this.log('info', '工作区 git push 首次失败(网络抖动)后重试成功');
    return r2;
  }
  /** 阻塞版 worktree git,用于退出冲刷 */
  gitWSync(gitdir, realPath, args, timeoutMs = 20000) {
    return this.gitSync(['--git-dir=' + gitdir, '--work-tree=' + realPath, ...args], timeoutMs);
  }

  /** 字节安全版 worktree git(用于读取工作区冲突双方二进制内容) */
  gitBytesW(gitdir, realPath, args, timeoutMs = 60000) {
    return this.gitBytes(['--git-dir=' + gitdir, '--work-tree=' + realPath, ...args], timeoutMs);
  }

  /* ================= 冲突「双边保留」 —— 仿 OneNote:不丢任一方,呈现给用户抉择 ================= */

  /**
   * 把一组 git 合并冲突按「双边保留」物化到工作树:
   *  - 本机版本(:2: ours)写回原路径,作为活动文件;
   *  - 远端版本(:3: theirs)另存为可见的 `<path>.dsh-conflict-<ts>` 拷贝;
   *  - 两者一并 add/commit/push,保证断网/换机任一边都不丢,用户之后可在此裁决。
   * @param call   (args)=>Promise<{code,out,err}> — git 执行函数(主仓库或某工作区)
   * @param base   工作树根目录绝对路径(文件写入用)
   * @param conflicts  冲突文件列表(相对 base)
   * @param ts     冲突时间戳
   * @returns [{ kind, id?, path, copy, conflictAt }] 仅记录成功物化的
   */
  async materializeConflicts(call, base, conflicts, ts, kind = 'main', wsId = null) {
    const suffix = '.dsh-conflict-' + ts;
    const records = [];
    for (const f of conflicts) {
      if (!f || f.includes('\0')) continue;
      const localRes = await call(['show', ':2:' + f]);
      const remoteRes = await call(['show', ':3:' + f]);
      const localOk = this.ok(localRes) && localRes.out && localRes.out.length;
      const remoteOk = this.ok(remoteRes) && remoteRes.out && remoteRes.out.length;
      if (localOk) {
        const w = Buffer.isBuffer(localRes.out) ? localRes.out : Buffer.from(localRes.out, 'utf8');
        fs.writeFileSync(path.join(base, f), w);
      }
      let copy = null;
      if (remoteOk) {
        copy = f + suffix;
        const w = Buffer.isBuffer(remoteRes.out) ? remoteRes.out : Buffer.from(remoteRes.out, 'utf8');
        fs.writeFileSync(path.join(base, copy), w);
      }
      if (localOk || remoteOk) records.push({ kind, id: wsId, path: f, copy, conflictAt: ts });
    }
    return records;
  }

  /**
   * 用户对某次冲突的裁决(resolution = 'local' | 'remote' | 'both'),在工作树内裁决后提交并推送。
   * @param call      git 执行函数
   * @param base      工作树根目录
   * @param cfg       配置
   * @param branch    该项要推送的分支
   * @param conflict  { path, copy }(来自 materializeConflicts / outstandingConflicts)
   * @param resolution 裁决
   */
  async _resolveConflict(call, base, cfg, branch, conflict, resolution) {
    const f = conflict.path;
    const copy = conflict.copy;
    const fileAbs = path.join(base, f);
    const copyAbs = copy ? path.join(base, copy) : null;
    if (resolution === 'local') {
      if (copyAbs && fs.existsSync(copyAbs)) fs.unlinkSync(copyAbs);
    } else if (resolution === 'remote') {
      if (copyAbs && fs.existsSync(copyAbs)) {
        fs.copyFileSync(copyAbs, fileAbs);
        fs.unlinkSync(copyAbs);
      } else {
        throw new Error('找不到远端备份拷贝: ' + (copy || '(无)') + ',无法采用远端版本');
      }
    } else if (resolution === 'both') {
      // 保留两者:不删除拷贝,也不改动活动文件(已满足「双边保留」)
    } else {
      throw new Error('未知裁决: ' + resolution);
    }
    let committed = false;
    const st = await call(['status', '--porcelain']);
    if (this.ok(st) && st.out.trim()) {
      const add = await call(['add', '-A']);
      if (!this.ok(add)) throw new Error('git add 失败: ' + (add.err || '').trim());
      const cm = await call(['commit', '-m', `dsh-sync: 冲突裁决(${resolution}) ${f} (${ts()})`]);
      if (!this.ok(cm)) throw new Error('git commit 失败: ' + (cm.err || '').trim());
      committed = true;
    }
    // 「两侧都留 / 无变更」无需提交(双边保留本身已提交),但仍推送,确保裁决状态到达远端
    if (cfg.remote) {
      const p = await call(['push', 'origin', branch]);
      if (!this.ok(p)) throw new Error('同步裁决失败: push 失败: ' + (p.err || '').trim().split('\n')[0]);
    }
    return { path: f, copy: copyAbs, resolution, committed };
  }

  /** 对外裁决入口:根据冲突记录定位主仓库或某工作区,然后裁决并提交推送 */
  async resolveConflict(conflict, resolution) {
    const cfg = this.loadConfig();
    if (conflict.kind === 'ws') {
      const ws = this.workspaces().find((w) => w.id === conflict.id);
      if (!ws) throw new Error('工作区不存在: ' + conflict.id);
      const realPath = this.workspacePathOf(ws.path, cfg);
      if (!realPath) throw new Error('无法解析工作区路径: ' + ws.path);
      return this._resolveConflict(
        (a) => this.gitW(this.workspaceGitDir(conflict.id), realPath, a),
        realPath, cfg, this.workspaceBranchOf(cfg, conflict.id), conflict, resolution,
      );
    }
    return this._resolveConflict((a) => this.git(a), this.home, cfg, cfg.branch, conflict, resolution);
  }

  /** 扫描主仓库 + 各工作区影子仓库,列出尚未裁决的冲突拷贝(.dsh-conflict-<ts>) */
  outstandingConflicts() {
    const cfg = this.loadConfig();
    const out = [];
    const scan = (gitFn, kind, wsId) => {
      const r = gitFn(['ls-files']);
      if (!this.ok(r)) return;
      for (const line of String(r.out).split('\n')) {
        const t = line.trim();
        const m = /^(.*)\.dsh-conflict-(.+)$/.exec(t);
        if (m) out.push({ kind, id: wsId, path: m[1], copy: m[0], conflictAt: m[2] });
      }
    };
    scan((a) => this.gitSync(a), 'main', null);
    if (cfg.workspaceSync !== false) {
      for (const ws of this.workspaces()) {
        const realPath = this.workspacePathOf(ws.path, cfg);
        const gitdir = this.workspaceGitDir(ws.id);
        if (!realPath || !fs.existsSync(gitdir)) continue;
        scan((a) => this.gitWSync(gitdir, realPath, a), 'ws', ws.id);
      }
    }
    return out;
  }

  async revW(gitdir, realPath, ref) {
    const r = await this.gitW(gitdir, realPath, ['rev-parse', '--verify', ref]);
    return this.ok(r) ? r.out.trim() : null;
  }
  async isAncestorW(gitdir, realPath, a, b) {
    if (!a || !b) return false;
    return this.ok(await this.gitW(gitdir, realPath, ['merge-base', '--is-ancestor', a, b]));
  }

  /** 确保工作区影子仓库构造完毕(init bare + core.worktree + 身份 + origin + 忽略规则) */
  async ensureWorkspaceMirror(id, realPath, cfg) {
    const gitdir = this.workspaceGitDir(id);
    const branch = this.workspaceBranchOf(cfg, id);
    if (!fs.existsSync(gitdir)) {
      fs.mkdirSync(path.dirname(gitdir), { recursive: true });
      const init = await this.git(['init', '--bare', gitdir]);
      if (!this.ok(init)) {
        this.log('error', `工作区 ${id} git 初始化失败: ${init.err.trim() || init.code}`);
        return false;
      }
      await this.gitW(gitdir, realPath, ['symbolic-ref', 'HEAD', 'refs/heads/' + branch]);
      await this.gitW(gitdir, realPath, ['config', 'core.autocrlf', 'false']);
      await this.gitW(gitdir, realPath, ['config', 'core.safecrlf', 'false']);
      await this.gitW(gitdir, realPath, ['config', 'commit.gpgsign', 'false']);
      this.log('info', `已初始化工作区影子仓库: ${realPath} -> ${gitdir}`);
    }
    // 始终确保身份/worktree/origin(路径解析可能随机器/配置变化)
    await this.gitW(gitdir, realPath, ['config', 'core.bare', 'false']);
    await this.gitW(gitdir, realPath, ['config', 'core.worktree', realPath]);
    await this.gitW(gitdir, realPath, ['config', 'user.name', cfg.gitUserName]);
    await this.gitW(gitdir, realPath, ['config', 'user.email', cfg.gitUserEmail]);
    if (cfg.remote) {
      const cur = await this.gitW(gitdir, realPath, ['remote', 'get-url', 'origin']);
      if (!this.ok(cur)) {
        await this.gitW(gitdir, realPath, ['remote', 'add', 'origin', cfg.remote]);
      } else if (cur.out.trim().replace(/\/+$/, '') !== String(cfg.remote).replace(/\/+$/, '')) {
        await this.gitW(gitdir, realPath, ['remote', 'set-url', 'origin', cfg.remote]);
      }
    }
    // 忽略规则写入影子仓库的 info/exclude(不落在真实文件夹里),排除 .git/嵌套git仓库 与 node_modules 等
    const excludes = ['.git', 'node_modules', 'node_modules/', ...(cfg.workspaceExtraIgnore || [])];
    const exclPath = path.join(gitdir, 'info', 'exclude');
    try { fs.mkdirSync(path.dirname(exclPath), { recursive: true }); } catch { /* ignore */ }
    try {
      const lines = [...new Set(excludes.map((x) => String(x).replace(/\/+$/, '') + '/'))].join('\n') + '\n';
      fs.writeFileSync(exclPath, lines, 'utf8');
    } catch { /* ignore */ }
    // 只取本工作区自己的分支:不再用默认 refspec 拉取全部远端分支(主仓库 main 的会话历史
    // 每个工作区都拉一遍,既慢又让工作区仓库膨胀到几十 MB)
    if (cfg.remote) {
      await this.gitW(gitdir, realPath, ['config', 'remote.origin.fetch', '+refs/heads/' + branch + ':refs/remotes/origin/' + branch]);
    }
    // 嵌套 git 仓库自动排除(否则父仓库 add 出 gitlink,嵌套仓库工作树一有改动父仓库 commit 必失败;
    // 嵌套仓库内容由各自仓库自行管理/备份)
    try {
      const nested = [];
      let entries = [];
      try { entries = fs.readdirSync(realPath, { withFileTypes: true }); } catch { entries = []; }
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        if (fs.existsSync(path.join(realPath, ent.name, '.git'))) nested.push(ent.name);
      }
      if (nested.length) {
        const excl = path.join(gitdir, 'info', 'exclude');
        const cur = fs.existsSync(excl) ? fs.readFileSync(excl, 'utf8') : '';
        const addLines = nested.map((n) => n.replace(/[\\/]+$/, '') + '/');
        const merged = [...new Set([...cur.split('\n').filter(Boolean), ...addLines])].join('\n') + '\n';
        fs.writeFileSync(excl, merged, 'utf8');
        for (const n of nested) await this.gitW(gitdir, realPath, ['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--', n]);
        this.log('info', `工作区 ${id} 内检测到嵌套 git 仓库(${nested.join(', ')})已自动排除(内容由各自仓库自行管理)`);
      }
    } catch { /* ignore */ }
    return true;
  }

  /** 工作区有未提交变更则 add + commit;返回 'committed'|'clean'|'throttled'|'error' */
  async commitWorkspaceIfDirty(gitdir, realPath, cfg, force = false) {
    const st = await this.gitW(gitdir, realPath, ['status', '--porcelain']);
    if (!this.ok(st)) { this.log('error', `工作区 git status 失败: ${st.err.trim()}`); return 'error'; }
    if (!st.out.trim()) return 'clean';
    const throttleMs = force ? 0 : Math.max(0, (Number(cfg.minCommitIntervalSeconds) || 0) * 1000);
    if (Date.now() - (this.lastCommitAt || 0) < throttleMs) return 'throttled';
    await this.gitW(gitdir, realPath, ['add', '-A']);
    const cm = await this.gitW(gitdir, realPath, ['commit', '-m', `${cfg.commitMessage} [${path.basename(realPath) || realPath}] (${ts()})`]);
    if (!this.ok(cm)) { this.log('warn', `工作区 git commit 失败: ${cm.err.trim() || cm.out.trim()}`); return 'error'; }
    this.lastCommitAt = Date.now();
    this.commitsSinceGc += 1;
    return 'committed';
  }

  /** 备份远端工作区头到 backup/<ts> 分支(合并冲突前的保险) */
  async backupRemoteHeadWs(gitdir, realPath, remoteHead) {
    if (!remoteHead) return null;
    const branchName = `backup/${ts()}`;
    const cb = await this.gitW(gitdir, realPath, ['branch', branchName, remoteHead]);
    if (!this.ok(cb)) return null;
    await this.pushWithRetryW(gitdir, realPath, ['push', 'origin', branchName]);
    return branchName;
  }

  /** 同步单个工作区:确保真实文件夹存在(目标机缺则创建),把真实文件夹内容(以其为工作树)
   *  提交到影子仓库,并与远端 ws/<id> 分支对齐(快进/推送/合并,冲突保留本地并备份远端)。 */
  async syncWorkspace(ws, cfg, reason, opts) {
    const id = ws.id;
    const realPath = this.workspacePathOf(ws.path, cfg);
    if (!realPath) return { id, error: 'no-path' };
    const gitdir = this.workspaceGitDir(id);
    const branch = this.workspaceBranchOf(cfg, id);
    // 目标机缺文件夹 → 自动创建(满足需求)
    try { fs.mkdirSync(realPath, { recursive: true }); }
    catch (e) { this.log('error', `工作区 ${id} 无法创建目录 ${realPath}: ${e?.message || e}`); return { id, error: 'mkdir', path: realPath }; }
    if (!(await this.ensureWorkspaceMirror(id, realPath, cfg))) return { id, error: 'ensure-repo', path: realPath };

    const label = ws.title || path.basename(realPath) || id;
    this.step('ws', `同步工作区 ${label}…`);
    let remoteHead = null;
    if (cfg.remote) {
      const rf = await this.fetchWithRetryW(gitdir, realPath, ['fetch', 'origin', '--prune']);
      if (this.ok(rf)) remoteHead = await this.revW(gitdir, realPath, `refs/remotes/origin/${branch}`);
      else this.log('warn', `工作区 ${id} fetch 失败(远端不可达?仅本地快照): ${rf.err.trim().split('\n')[0] || rf.code}`);
    }
    const commitRes = await this.commitWorkspaceIfDirty(gitdir, realPath, cfg, opts.forceCommit === true);
    let committed = commitRes === 'committed';

    if (!cfg.remote) return { id, committed, pushed: false, pulled: false, path: realPath };

    const localHead = await this.revW(gitdir, realPath, 'HEAD');
    // 远端无该分支 → 首次推送
    if (remoteHead === null) {
      const p = await this.pushWithRetryW(gitdir, realPath, ['push', '-u', 'origin', branch]);
      if (this.ok(p)) return { id, committed, pushed: true, path: realPath };
      this.log('error', `工作区 ${id} push 失败: ${p.err.trim().split('\n')[0] || p.code}`);
      return { id, committed, pushed: false, error: 'push', path: realPath };
    }
    // 本地无提交 → 从远端整体取回(目标机首次)
    if (localHead === null) {
      const rs = await this.gitW(gitdir, realPath, ['reset', '--hard', `origin/${branch}`]);
      if (this.ok(rs)) { this.log('info', `[${reason}] 工作区 ${id} 已从远端取回内容 -> ${realPath}`); return { id, committed, pushed: false, pulled: 'reset', path: realPath }; }
      this.log('error', `工作区 ${id} 从远端取回失败: ${rs.err.trim()}`); return { id, committed, error: 'reset', path: realPath };
    }
    if (localHead === remoteHead) {
      if (committed) {
        const p = await this.pushWithRetryW(gitdir, realPath, ['push', 'origin', branch]);
        if (!this.ok(p)) this.log('error', `工作区 ${id} push 失败: ${p.err.trim().split('\n')[0] || p.code}`);
        return { id, committed, pushed: this.ok(p), path: realPath };
      }
      return { id, committed: false, pushed: false, pulled: false, path: realPath };
    }
    // 节流攒下未提交变更 → 强制提交
    if (commitRes === 'throttled') {
      const forced = await this.commitWorkspaceIfDirty(gitdir, realPath, cfg, true);
      if (forced === 'committed') committed = true;
    }
    // 本地领先远端 → 推送
    if (await this.isAncestorW(gitdir, realPath, remoteHead, localHead)) {
      const p = await this.pushWithRetryW(gitdir, realPath, ['push', 'origin', branch]);
      if (this.ok(p)) return { id, committed, pushed: true, path: realPath };
      this.log('error', `工作区 ${id} push 失败: ${p.err.trim().split('\n')[0] || p.code}`);
      return { id, committed, pushed: false, error: 'push', path: realPath };
    }
    // 远端领先本地 → 快进拉取
    if (await this.isAncestorW(gitdir, realPath, localHead, remoteHead)) {
      this.step('ws', `拉取工作区 ${label}…`);
      const mg = await this.gitW(gitdir, realPath, ['merge', '--ff-only', `origin/${branch}`]);
      if (this.ok(mg)) { this.log('info', `[${reason}] 工作区 ${id} 已快进同步`); return { id, committed, pushed: false, pulled: 'ff', path: realPath }; }
      const stNow = await this.gitW(gitdir, realPath, ['status', '--porcelain']);
      if (!(this.ok(stNow) && !stNow.out.trim())) { this.log('warn', `工作区 ${id} 工作树不干净,跳过 reset`); return { id, committed, pulled: false, path: realPath }; }
      const rs = await this.gitW(gitdir, realPath, ['reset', '--hard', `origin/${branch}`]);
      if (this.ok(rs)) return { id, committed, pulled: 'reset', path: realPath };
      this.log('error', `工作区 ${id} 快进同步失败: ${mg.err.trim()}`); return { id, committed, error: 'pull', path: realPath };
    }
    // 双方都有新提交 → merge;冲突保留本地,远端先备份
    this.step('ws', `合并工作区 ${label}…`);
    let mg = await this.gitW(gitdir, realPath, ['merge', '--no-edit', `origin/${branch}`]);
    let unrelated = false;
    const mergeHeadExists = fs.existsSync(path.join(gitdir, 'MERGE_HEAD'));
    if (!this.ok(mg) && !mergeHeadExists) {
      const cf0 = await this.gitW(gitdir, realPath, ['diff', '--name-only', '--diff-filter=U']);
      const noConflicts = !this.ok(cf0) || !cf0.out.trim();
      if (noConflicts) { unrelated = true; mg = await this.gitW(gitdir, realPath, ['merge', '--no-edit', '--allow-unrelated-histories', `origin/${branch}`]); }
    }
    if (this.ok(mg)) {
      const p = await this.pushWithRetryW(gitdir, realPath, ['push', 'origin', branch]);
      if (!this.ok(p)) this.log('error', `工作区 ${id} 合并后推送失败: ${p.err.trim().split('\n')[0] || p.code}`);
      return { id, committed, pushed: this.ok(p), pulled: 'merge', unrelated, path: realPath };
    }
    const cf = await this.gitW(gitdir, realPath, ['diff', '--name-only', '--diff-filter=U']);
    const conflicts = this.ok(cf) ? cf.out.trim().split('\n').filter(Boolean) : [];
    const conflictTs = ts();
    const backupBranch = unrelated ? null : await this.backupRemoteHeadWs(gitdir, realPath, remoteHead);
    let conflictCopies = [];
    if (unrelated) {
      for (const f of conflicts) await this.gitW(gitdir, realPath, ['checkout', '--theirs', '--', f]);
    } else {
      conflictCopies = await this.materializeConflicts((a) => this.gitBytesW(gitdir, realPath, a), realPath, conflicts, conflictTs, 'ws', id);
    }
    const done = await this.gitW(gitdir, realPath, ['add', '-A']);
    const cm = this.ok(done) ? await this.gitW(gitdir, realPath, ['commit', '--no-edit']) : { code: 1 };
    if (!this.ok(cm)) {
      await this.gitW(gitdir, realPath, ['merge', '--abort']);
      this.log('error', `工作区 ${id} 合并收尾失败,已中止(本地状态未变)`);
      return { id, committed, error: 'merge', path: realPath };
    }
    this.log('warn', `[${reason}] 工作区 ${id} 双方都有新提交,自动合并;${conflictCopies.length} 个冲突文件「双边保留」:本机版本保留,远端版本另存为 .dsh-conflict-<ts> 拷贝` + (backupBranch ? `,远端头备份到 ${backupBranch}` : '') + (conflictCopies.length ? `;冲突: ${conflictCopies.map((c) => c.path).join(', ')}` : conflicts.length ? `;冲突: ${conflicts.join(', ')}` : ''));
    const p = await this.pushWithRetryW(gitdir, realPath, ['push', 'origin', branch]);
    if (!this.ok(p)) this.log('error', `工作区 ${id} 合并后推送失败: ${p.err.trim().split('\n')[0] || p.code}`);
    return {
      id, committed, pushed: this.ok(p), pulled: 'merge',
      conflicts: conflictCopies.length ? conflictCopies.map((c) => c.path) : conflicts,
      conflictCopies, backupBranch, path: realPath,
    };
  }

  /** 同步全部已登记工作区;返回 { total, synced, pushed, pulled, errors } */
  async syncAllWorkspaces(cfg, reason, opts) {
    if (cfg.workspaceSync === false) return { skipped: 'disabled', total: 0, synced: 0, pushed: 0, pulled: 0, errors: [] };
    if (this.gitMissing) return { skipped: 'git-not-found', total: 0, synced: 0, pushed: 0, pulled: 0, errors: [] };
    const list = this.workspaces();
    if (!list.length) return { total: 0, synced: 0, pushed: 0, pulled: 0, errors: [] };
    const errors = [];
    const conflictCopies = [];
    let synced = 0, pushed = 0, pulled = 0;
    // 各工作区是独立影子仓库,可并行同步:网络往返是主要耗时,串行会把每个工作区的
    // fetch+push 延迟加起来(网络抖动时尤甚),并行能显著缩短总时长
    const results = await Promise.all(list.map((ws) => (async () => {
      try { return await this.syncWorkspace(ws, cfg, reason, opts); }
      catch (e) { return { id: ws.id, error: String(e?.message || e) }; }
    })()));
    for (const r of results) {
      if (r.error) errors.push({ id: r.id, title: '', path: '', error: r.error });
      else {
        synced++;
        if (r.pushed) pushed++;
        if (r.pulled) pulled++;
        if (Array.isArray(r.conflictCopies) && r.conflictCopies.length) conflictCopies.push(...r.conflictCopies);
      }
    }
    // 补全错误的标题/路径信息(并行结果里没有原 ws 对象,从登记表补查)
    if (errors.length) {
      const byId = new Map(list.map((ws) => [ws.id, ws]));
      for (const e of errors) {
        const w = byId.get(e.id);
        if (w) { e.title = w.title; e.path = w.path; }
      }
    }
    return { total: list.length, synced, pushed, pulled, errors, conflictCopies };
  }

  /** 主数据同步(会话/settings/插件/技能/工作区元数据);工作区文件夹内容由外层 _syncOnce 追加处理 */
  /** 会话文件的实际 cwd:优先读日志头(只解首帧,快),失败回退为分组名还原 */
  sessionCwdOf(sdir, id, group) {
    try {
      const file = fs.existsSync(path.join(sdir, 'session.jsonl'))
        ? path.join(sdir, 'session.jsonl')
        : path.join(sdir, 'session.jsonl.zstd');
      const fd = fs.openSync(file, 'r');
      let text = '';
      try {
        const head = Buffer.alloc(2 * 1024 * 1024);
        const n = fs.readSync(fd, head, 0, head.length, 0);
        const buf = head.subarray(0, n);
        const magic = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);
        if (buf.subarray(0, 4).equals(magic) && typeof zstdDecompressSync === 'function') {
          const i2 = buf.indexOf(magic, 4);
          const frame = i2 === -1 ? buf : buf.subarray(0, i2);
          text = zstdDecompressSync(frame).toString('utf8');
        } else {
          text = buf.toString('utf8');
        }
      } finally { fs.closeSync(fd); }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          if (rec && typeof rec === 'object' && rec.type === 'session' && typeof rec.data?.cwd === 'string') return rec.data.cwd;
          if (rec && typeof rec === 'object' && typeof rec.cwd === 'string') return rec.cwd;
        } catch { /* 下一行 */ }
      }
    } catch { /* 走分组名还原 */ }
    return decodeGroup(group);
  }

  /**
   * 修复工作区登记表(workspace.json):把真实会话按所属 cwd 补进对应工作区,
   * 缺失的工作区自动补建 —— 让「会话↔工作区」对应关系真正随主仓库跨机同步。
   * 只增不改:不删除、不动已有条目,避免与宿主编排打架;无变化时不写盘(零churn)。
   */
  repairWorkspaceRegistry() {
    try {
      const wsFile = path.join(this.home, 'storages', 'workspace.json');
      if (!fs.existsSync(wsFile)) return { ok: true, repaired: 0, created: 0 };
      let ws;
      try { ws = JSON.parse(fs.readFileSync(wsFile, 'utf8')); } catch (e) { return { ok: false, error: String(e?.message || e) }; }
      if (!ws || typeof ws !== 'object' || !ws.tables || typeof ws.tables !== 'object') return { ok: false, error: 'workspace.json 结构异常' };
      const workspaces = ws.tables.workspaces && typeof ws.tables.workspaces === 'object'
        ? ws.tables.workspaces
        : (ws.tables.workspaces = {});
      const global_ = ws.global && typeof ws.global === 'object' ? ws.global : (ws.global = {});
      const workspaceIds = Array.isArray(global_.workspaceIds) ? global_.workspaceIds : (global_.workspaceIds = []);
      const byPath = new Map();
      for (const [wid, w] of Object.entries(workspaces)) {
        if (w && typeof w.path === 'string') byPath.set(normPath(w.path), wid);
      }
      const root = path.join(this.home, 'sessions');
      let repaired = 0, created = 0;
      if (fs.existsSync(root)) {
        for (const g of fs.readdirSync(root)) {
          const gdir = path.join(root, g);
          let ids = [];
          try { ids = fs.readdirSync(gdir); } catch { continue; }
          for (const id of ids) {
            if (!/^session-[0-9a-f-]{36}$/i.test(id)) continue;
            const sdir = path.join(gdir, id);
            const hasLog = fs.existsSync(path.join(sdir, 'session.jsonl.zstd')) || fs.existsSync(path.join(sdir, 'session.jsonl'));
            if (!hasLog) continue;
            const cwd = this.sessionCwdOf(sdir, id, g);
            if (!cwd) continue;
            const key = normPath(cwd);
            let wid = byPath.get(key);
            if (!wid) {
              wid = randomUUID();
              const now = new Date().toISOString();
              workspaces[wid] = { path: cwd, title: titleFromPath(cwd), sessionIds: [id], createdAt: now, updatedAt: now };
              workspaceIds.push(wid);
              byPath.set(key, wid);
              created++;
              continue;
            }
            const rec = workspaces[wid];
            if (!rec) continue;
            const list = Array.isArray(rec.sessionIds) ? rec.sessionIds : (rec.sessionIds = []);
            if (!list.includes(id)) { list.unshift(id); repaired++; }
          }
        }
      }
      if (repaired || created) {
        fs.writeFileSync(wsFile, JSON.stringify(ws, null, 2));
        this.log('info', `工作区登记表修复:${repaired} 个会话补进对应工作区,新建 ${created} 个工作区条目(随本次快照提交同步)`);
      }
      return { ok: true, repaired, created };
    } catch (e) {
      this.log('warn', '工作区登记表修复失败(不影响同步): ' + String(e?.message || e));
      return { ok: false, error: String(e?.message || e) };
    }
  }

  /** workspace.json 冲突时的并集合并:两台电脑的工作区与会话映射都保留(而不是单边保留) */
  async unionMergeWorkspaceJson() {
    try {
      const f = 'storages/workspace.json';
      const [o, t] = await Promise.all([
        this.git(['show', ':2:' + f]),
        this.git(['show', ':3:' + f]),
      ]);
      const parse = (r) => { try { return r.ok && r.out ? JSON.parse(r.out) : null; } catch { return null; } };
      const ours = parse(o), theirs = parse(t);
      if (!ours || !theirs) return false; // 解析失败 → 走常规单边保留
      if (!ours.global) ours.global = {};
      if (!ours.tables) ours.tables = {};
      if (!ours.tables.workspaces) ours.tables.workspaces = {};
      const oWs = ours.tables.workspaces;
      const tWs = theirs.tables && theirs.tables.workspaces && typeof theirs.tables.workspaces === 'object'
        ? theirs.tables.workspaces
        : {};
      for (const [wid, tw] of Object.entries(tWs)) {
        const ow = oWs[wid];
        if (!ow) {
          oWs[wid] = tw;
          if (Array.isArray(ours.global.workspaceIds) && !ours.global.workspaceIds.includes(wid)) ours.global.workspaceIds.push(wid);
          continue;
        }
        if (tw && Array.isArray(tw.sessionIds)) {
          const list = Array.isArray(ow.sessionIds) ? ow.sessionIds : (ow.sessionIds = []);
          for (const sid of tw.sessionIds) if (!list.includes(sid)) list.push(sid);
        }
        if (tw && typeof tw.path === 'string') { if (!ow.path) ow.path = tw.path; if (!ow.title) ow.title = tw.title; }
      }
      if (theirs.global && Array.isArray(theirs.global.archivedSessionIds)) {
        const a = Array.isArray(ours.global.archivedSessionIds) ? ours.global.archivedSessionIds : (ours.global.archivedSessionIds = []);
        for (const sid of theirs.global.archivedSessionIds) if (!a.includes(sid)) a.push(sid);
      }
      fs.writeFileSync(path.join(this.home, f), JSON.stringify(ours, null, 2));
      this.log('info', 'workspace.json 冲突已做并集合并:两台电脑的工作区与会话映射都保留');
      return true;
    } catch (e) {
      this.log('warn', 'workspace.json 并集合并失败,改用单边保留: ' + String(e?.message || e));
      return false;
    }
  }

  async _mainSync(reason, opts = {}) {
    this.progress = { running: true, stage: 'prepare', label: '准备本地仓库…', startedAt: Date.now() };
    const cfg = this.loadConfig();
    if (this.gitMissing) return { skipped: 'git-not-found' };

    // 首次同步:remote 为空时尝试用 gh 自动建仓/复用,并把 remote 写回配置
    if (!cfg.remote && cfg.autoRepo !== false) {
      this.step('prepare', '检测远端仓库(gh)…');
      const boot = await this.bootstrapRemote(cfg);
      if (boot) cfg.remote = boot;
    }

    if (!(await this.ensureRepo(cfg))) return { error: 'ensure-repo' };

    // 工作区登记表修复:把真实会话按所属 cwd 补进对应工作区(缺失工作区自动补建),
    // 让「会话↔工作区」对应关系随本次快照真正同步到另一台电脑
    try { this.repairWorkspaceRegistry(); } catch (e) { this.log('warn', '工作区登记表修复异常: ' + String(e?.message || e)); }

    const hasRemote = Boolean(cfg.remote);
    let remoteHead = null;

    if (hasRemote) {
      this.step('fetch', '获取远端状态…');
      const rf = await this.fetchWithRetry(['fetch', 'origin', '--prune']);
      if (!this.ok(rf)) {
        this.log('warn', `git fetch 失败(远端不可达?本次只做本地快照): ${rf.err.trim().split('\n')[0] || rf.code}`);
      } else {
        remoteHead = await this.rev(`refs/remotes/origin/${cfg.branch}`);
      }
    }

    // 手动触发(按钮/面板/CLI)传 forceCommit:不受提交节流限制
    this.step('commit', '提交本地快照…');
    const commitRes = await this.commitIfDirty(cfg, opts.forceCommit === true);
    let committed = commitRes === 'committed';

    if (!hasRemote) {
      if (committed) {
        this.log('info', `[${reason}] 已提交本地快照(未配置 remote,仅本地)`);
        this.gcIfNeeded().catch(() => {});
      }
      return { committed, pushed: false, pulled: false };
    }
    if (remoteHead === null) {
      // 远端还没有分支:直接推送本地状态
      this.step('push', '首次推送到远端…');
      const p = await this.pushWithRetry(['push', '-u', 'origin', cfg.branch]);
      if (this.ok(p)) {
        this.log('info', `[${reason}] 首次推送成功 → ${cfg.remote}`);
        return { committed, pushed: true, pulled: false };
      }
      this.log('error', `git push 失败(检查远端地址与凭据): ${p.err.trim().split('\n')[0] || p.code}`);
      return { committed, pushed: false, error: 'push' };
    }

    const localHead = await this.rev('HEAD');
    this.step('analyze', '比对本地与远端…');

    // 情况 1:本地没有任何提交(如新电脑空 .dsh)→ 整体取回远端
    if (localHead === null) {
      this.step('pull', '从远端整体取回…');
      const co = await this.git(['checkout', '-B', cfg.branch, `origin/${cfg.branch}`]);
      if (this.ok(co)) {
        this.log('info', `[${reason}] 本地仓库为空,已从远端整体取回 .dsh`);
        return { committed, pushed: false, pulled: 'reset' };
      }
      this.log('error', `从远端取回失败: ${co.err.trim()}`);
      return { committed, error: 'checkout' };
    }

    if (localHead === remoteHead) {
      if (committed) {
        this.step('push', '推送到远端…');
        const p = await this.pushWithRetry(['push', 'origin', cfg.branch]);
        if (!this.ok(p)) this.log('error', `git push 失败: ${p.err.trim().split('\n')[0] || p.code}`);
        if (this.ok(p)) this.gcIfNeeded().catch(() => {});
        return { committed, pushed: this.ok(p) };
      }
      return { committed: false, pushed: false, pulled: false };
    }

    // 后续快进/合并/重置都需要干净的工作树:节流攒下的未提交变更先强制提交
    if (commitRes === 'throttled') {
      const forced = await this.commitIfDirty(cfg, true);
      if (forced === 'committed') committed = true;
    }

    // 情况 2:本地领先(远端是本地祖先)→ 推送
    if (await this.isAncestor(remoteHead, localHead)) {
      this.step('push', '推送到远端…');
      const p = await this.pushWithRetry(['push', 'origin', cfg.branch]);
      if (this.ok(p)) {
        this.log('info', `[${reason}] 已推送本地变更(${committed ? '含新快照' : '先前提交'})`);
        return { committed, pushed: true };
      }
      this.log('error', `git push 失败: ${p.err.trim().split('\n')[0] || p.code}`);
      return { committed, pushed: false, error: 'push' };
    }

    // 情况 3:远端领先(本地是远端祖先)→ 快进拉取
    if (await this.isAncestor(localHead, remoteHead)) {
      this.step('pull', '拉取远端新数据…');
      const mg = await this.git(['merge', '--ff-only', `origin/${cfg.branch}`]);
      if (this.ok(mg)) {
        this.log('info', `[${reason}] 已从远端快进同步新数据`);
        return { committed, pushed: false, pulled: 'ff' };
      }
      // 理论到不了这里(祖先关系已确认);失败则保守地 hard reset
      const stNow = await this.git(['status', '--porcelain']);
      if (!(this.ok(stNow) && !stNow.out.trim())) {
        this.log('warn', '工作树不干净,跳过 reset,保留未提交变更待下次同步');
        return { committed, pushed: false, pulled: false };
      }
      const rs = await this.git(['reset', '--hard', `origin/${cfg.branch}`]);
      if (this.ok(rs)) {
        this.log('info', `[${reason}] 已从远端同步新数据(reset)`);
        return { committed, pushed: false, pulled: 'reset' };
      }
      this.log('error', `快进同步失败: ${mg.err.trim()}`);
      return { committed, error: 'pull' };
    }

    // 情况 4:双方都有独立提交 → merge;冲突文件保留本地,远端先备份
    this.step('merge', '合并双方数据…');
    let mg = await this.git(['merge', '--no-edit', `origin/${cfg.branch}`]);
    let unrelated = false;
    const mergeHeadExists = fs.existsSync(path.join(this.home, '.git', 'MERGE_HEAD'));
    if (!this.ok(mg) && !mergeHeadExists) {
      const cf0 = await this.git(['diff', '--name-only', '--diff-filter=U']);
      const noConflicts = !this.ok(cf0) || !cf0.out.trim();
      if (noConflicts) {
        // 无冲突却合并失败 → 多半是"无共同历史"(如新电脑首次并入远端):
        // 允许合并不相关历史,同名文件以远端为准,本地独有文件保留
        unrelated = true;
        mg = await this.git(['merge', '--no-edit', '--allow-unrelated-histories', `origin/${cfg.branch}`]);
      }
    }
    if (this.ok(mg)) {
      this.log('info', unrelated
        ? `[${reason}] 本地新仓库已并入远端历史(同名文件以远端为准,本地独有文件保留)`
        : `[${reason}] 两台电脑都有新数据,已自动合并`);
      const p = await this.pushWithRetry(['push', 'origin', cfg.branch]);
      if (!this.ok(p)) this.log('error', `合并后推送失败: ${p.err.trim().split('\n')[0] || p.code}`);
      return { committed, pushed: this.ok(p), pulled: 'merge', unrelated };
    }
    const cf = await this.git(['diff', '--name-only', '--diff-filter=U']);
    let conflicts = this.ok(cf) ? cf.out.trim().split('\n').filter(Boolean) : [];
    const conflictTs = ts();
    const backupBranch = unrelated ? null : await this.backupRemoteHead(cfg, remoteHead);
    let conflictCopies = [];
    if (unrelated) {
      // 无共同历史(新机并入远端):同名文件以远端为准,本地独有文件保留
      for (const f of conflicts) await this.git(['checkout', '--theirs', '--', f]);
    } else {
      // workspace.json 特殊处理:并集合并(双方工作区/会话映射都保留),不参与「双边保留」拷贝
      if (conflicts.includes('storages/workspace.json')) {
        if (await this.unionMergeWorkspaceJson()) {
          await this.git(['add', '--', 'storages/workspace.json']);
          conflicts = conflicts.filter((f) => f !== 'storages/workspace.json');
        }
      }
      // 常规双边冲突:本机版本保留为活动文件;远端版本另存为可见的 .dsh-conflict-<ts> 拷贝,一并提交+推送(不丢任一方)
      conflictCopies = await this.materializeConflicts((a) => this.gitBytes(a), this.home, conflicts, conflictTs, 'main', null);
    }
    const done = await this.git(['add', '-A']);
    const cm = this.ok(done) ? await this.git(['commit', '--no-edit']) : { code: 1 };
    if (!this.ok(cm)) {
      // 极端情况:合并没法收尾 → 中止合并,保留本地,推送交给下次
      await this.git(['merge', '--abort']);
      this.log('error', `合并收尾失败,已中止(本地状态未变): ${cm.err?.trim() || ''}`);
      return { committed, error: 'merge' };
    }
    if (unrelated) {
      this.log('warn', `[${reason}] 本地新仓库已并入远端历史;${conflicts.length} 个同名文件采用了远端版本` +
        (conflicts.length ? `(本地版本见本地提交历史): ${conflicts.join(', ')}` : ''));
    } else {
      this.log(
        'warn',
        `[${reason}] 双方都有新提交,自动合并;${conflictCopies.length} 个冲突文件「双边保留」:本机版本保留为活动文件,远端版本另存为 .dsh-conflict-<ts> 拷贝` +
        (backupBranch ? `,远端头也已备份到 ${backupBranch}` : '') +
        (conflictCopies.length ? `;冲突: ${conflictCopies.map((c) => c.path).join(', ')}` : conflicts.length ? `;冲突: ${conflicts.join(', ')}` : ''),
      );
    }
    const p = await this.pushWithRetry(['push', 'origin', cfg.branch]);
    if (!this.ok(p)) this.log('error', `合并后推送失败: ${p.err.trim().split('\n')[0] || p.code}`);
    return {
      committed, pushed: this.ok(p), pulled: 'merge',
      conflicts: conflictCopies.length ? conflictCopies.map((c) => c.path) : conflicts,
      conflictCopies, backupBranch,
    };
  }

  /** 对外同步总入口:先同步主数据(.dsh 会话/settings/插件/工作区元数据),再同步各工作区文件夹内容 */
  async _syncOnce(reason, opts = {}) {
    const rMain = await this._mainSync(reason, opts);
    const cfg = this.loadConfig();
    let workspaces = { skipped: 'not-run', total: 0, synced: 0, pushed: 0, pulled: 0, errors: [] };
    try {
      workspaces = await this.syncAllWorkspaces(cfg, reason, opts);
    } catch (e) {
      workspaces = { skipped: 'error', total: 0, synced: 0, pushed: 0, pulled: 0, errors: [{ id: '', title: '', path: '', error: String(e?.message || e) }] };
    }
    return { ...rMain, workspaces };
  }

  /** 对外同步入口:同一时刻只允许一个同步在跑;opts.forceCommit=true 时手动触发免提交节流 */
  syncOnce(reason = 'manual', opts = {}) {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this._syncOnce(reason, opts)
      .catch((e) => ({ error: String((e && e.message) || e) }))
      .then((r) => {
        this.lastSyncAt = Date.now();
        this.lastOutcome = r;
        const wsErrs = r && r.workspaces && r.workspaces.errors && r.workspaces.errors.length;
        const hasErr = Boolean(r && r.error) || Boolean(wsErrs);
        this.progress = {
          running: false,
          stage: hasErr ? 'error' : 'done',
          label: (r && r.error) ? '同步失败: ' + r.error
            : (wsErrs ? '同步完成(部分工作区失败)' : '同步完成'),
          startedAt: (this.progress && this.progress.startedAt) || 0,
          endedAt: Date.now(),
        };
        return r;
      })
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  /** 退出冲刷:阻塞版"提交 + 推送",供 dsh 关闭时调用(enabled 只约束自动模式,手动冲刷始终执行) */
  flushSync() {
    const cfg = this.loadConfig();
    if (this.gitMissing) return;
    if (!(fs.existsSync(path.join(this.home, '.git')))) {
      if (!this.ok(this.gitSync(['init', '-b', cfg.branch]))) return;
      this.gitSync(['config', 'user.name', cfg.gitUserName]);
      this.gitSync(['config', 'user.email', cfg.gitUserEmail]);
      this.gitSync(['config', 'core.autocrlf', 'false']);
      this.gitSync(['config', 'commit.gpgsign', 'false']);
    }
    const st = this.gitSync(['status', '--porcelain']);
    if (this.ok(st) && st.out.trim()) {
      this.gitSync(['add', '-A']);
      const cm = this.gitSync(['commit', '-m', `${cfg.commitMessage} (exit flush ${ts()})`]);
      if (!this.ok(cm)) return;
    }
    if (cfg.remote) {
      let pPush = this.gitSync(['push', 'origin', cfg.branch]);
      if (!this.ok(pPush)) pPush = this.gitSync(['push', 'origin', cfg.branch]); // 网络抖动重试一次
    }
    // 退出冲刷:已初始化过影子仓库的工作区,提交 + 推送(不新建仓库,避免退出时重活)
    if (cfg.workspaceSync !== false && !this.gitMissing) {
      for (const ws of this.workspaces()) {
        try {
          const realPath = this.workspacePathOf(ws.path, cfg);
          if (!realPath) continue;
          const gitdir = this.workspaceGitDir(ws.id);
          if (!fs.existsSync(gitdir)) continue;
          const branch = this.workspaceBranchOf(cfg, ws.id);
          this.gitWSync(gitdir, realPath, ['config', 'core.worktree', realPath]);
          const stW = this.gitWSync(gitdir, realPath, ['status', '--porcelain']);
          if (this.ok(stW) && stW.out.trim()) {
            this.gitWSync(gitdir, realPath, ['add', '-A']);
            this.gitWSync(gitdir, realPath, ['commit', '-m', `${cfg.commitMessage} [${path.basename(realPath)}] (exit flush ${ts()})`]);
          }
          if (cfg.remote) {
            let pPush = this.gitWSync(gitdir, realPath, ['push', 'origin', branch]);
            if (!this.ok(pPush)) pPush = this.gitWSync(gitdir, realPath, ['push', 'origin', branch]); // 网络抖动重试一次
          }
        } catch { /* ignore */ }
      }
    }
  }
}
