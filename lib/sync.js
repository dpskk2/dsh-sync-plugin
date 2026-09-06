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
import path from 'node:path';

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
  gitUserName: 'dsh-sync-plugin',
  gitUserEmail: 'dsh-sync-plugin@localhost',
  extraIgnore: [],
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
  '# 可再生缓存 —— 不同步',
  'storages/session_projcache.json',
  '',
  '# 依赖目录 —— 不同步(在新电脑的 profiles/web 里执行 pnpm install 恢复)',
  '**/node_modules/',
  '',
  '# 同步引擎自身状态',
  '.dsh-sync.state.json',
].join('\n');

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
    const pb = await this.git(['push', 'origin', branchName]);
    if (!this.ok(pb)) {
      this.log('warn', `备份分支推送失败(本地分支 ${branchName} 已创建): ${pb.err.trim()}`);
      return branchName;
    }
    return branchName;
  }

  async _syncOnce(reason, opts = {}) {
    this.progress = { running: true, stage: 'prepare', label: '准备本地仓库…', startedAt: Date.now() };
    const cfg = this.loadConfig();
    if (this.gitMissing) return { skipped: 'git-not-found' };

    if (!(await this.ensureRepo(cfg))) return { error: 'ensure-repo' };

    const hasRemote = Boolean(cfg.remote);
    let remoteHead = null;

    if (hasRemote) {
      this.step('fetch', '获取远端状态…');
      const rf = await this.git(['fetch', 'origin', '--prune'], 180000);
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
      const p = await this.git(['push', '-u', 'origin', cfg.branch], 180000);
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
        const p = await this.git(['push', 'origin', cfg.branch], 180000);
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
      const p = await this.git(['push', 'origin', cfg.branch], 180000);
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
      const p = await this.git(['push', 'origin', cfg.branch], 180000);
      if (!this.ok(p)) this.log('error', `合并后推送失败: ${p.err.trim().split('\n')[0] || p.code}`);
      return { committed, pushed: this.ok(p), pulled: 'merge', unrelated };
    }
    const cf = await this.git(['diff', '--name-only', '--diff-filter=U']);
    const conflicts = this.ok(cf) ? cf.out.trim().split('\n').filter(Boolean) : [];
    const backupBranch = unrelated ? null : await this.backupRemoteHead(cfg, remoteHead);
    for (const f of conflicts) {
      await this.git(['checkout', unrelated ? '--theirs' : '--ours', '--', f]);
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
        `[${reason}] 双方都有新提交,自动合并完成;${conflicts.length} 个冲突文件保留本机版本` +
        (backupBranch ? `,远端版本已备份到分支 ${backupBranch}` : '') +
        (conflicts.length ? `;冲突: ${conflicts.join(', ')}` : ''),
      );
    }
    const p = await this.git(['push', 'origin', cfg.branch], 180000);
    if (!this.ok(p)) this.log('error', `合并后推送失败: ${p.err.trim().split('\n')[0] || p.code}`);
    return { committed, pushed: this.ok(p), pulled: 'merge', conflicts, backupBranch };
  }

  /** 对外同步入口:同一时刻只允许一个同步在跑;opts.forceCommit=true 时手动触发免提交节流 */
  syncOnce(reason = 'manual', opts = {}) {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this._syncOnce(reason, opts)
      .catch((e) => ({ error: String((e && e.message) || e) }))
      .then((r) => {
        this.lastSyncAt = Date.now();
        this.lastOutcome = r;
        this.progress = {
          running: false,
          stage: r && r.error ? 'error' : 'done',
          label: r && r.error ? '同步失败: ' + r.error : '同步完成',
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
    if (cfg.remote) this.gitSync(['push', 'origin', cfg.branch]);
  }
}
