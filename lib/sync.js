/**
 * dsh-sync-plugin 同步引擎 —— 纯 git 编排,不依赖任何 npm 包。
 *
 * 设计:
 *  - 仓库根就是 DSH home(即 .dsh 目录本身),.gitignore 只排除机器本地状态/依赖目录,
 *    设置与密钥(settings.yaml / .credentials.yaml)随个人私有仓库一起同步。
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

/* ================= 传输统计 —— 解析 git --progress 的 stderr(推/拉的对象数、字节、速度) ================= */

/** 把 "1.5 MiB" / "234 KiB" / "900 B" 换算成字节 */
function parseBytes(n, unit) {
  const u = String(unit || '').toLowerCase().replace(/i/g, '');
  const mult = u.startsWith('k') ? 1024 : u.startsWith('m') ? 1024 ** 2 : u.startsWith('g') ? 1024 ** 3 : 1;
  return Math.round(parseFloat(n) * mult);
}

/** 字节数 → 可读文本(自动选单位) */
export function humanSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  const abs = Math.abs(bytes);
  if (abs >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GiB';
  if (abs >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(2) + ' MiB';
  if (abs >= 1024) return (bytes / 1024).toFixed(1) + ' KiB';
  return bytes + ' B';
}

/**
 * 从 git --progress 的 stderr 文本里提取传输信息:
 *   Writing objects:  45% (123/456), 1.24 MiB | 1.52 MiB/s   (push)
 *   Receiving objects: 72% (201/280), 2.30 MiB | 3.10 MiB/s  (fetch)
 *   Total 456 (delta 89), reused 12 (delta 0), pack-reused 400
 * 返回 { op, pct, done, total, size, speed, totalObjects, reused, packReused }
 * (size/speed 为字节;op = 'push' | 'fetch';无传输时字段为 null)
 */
export function parseTransfer(errText) {
  const out = { op: null, pct: null, done: null, total: null, size: null, speed: null, totalObjects: null, reused: null, packReused: null };
  for (const line of String(errText || '').split('\n')) {
    let m = /(Writing|Receiving) objects:.*?(\d+)%\s*\((\d+)\/(\d+)\)/.exec(line);
    if (m) { out.op = m[1] === 'Writing' ? 'push' : 'fetch'; out.pct = +m[2]; out.done = +m[3]; out.total = +m[4]; }
    m = /(\d+(?:\.\d+)?)\s*([KMGT]?i?B)(?:\s*\|\s*(\d+(?:\.\d+)?)\s*([KMGT]?i?B)\/s)?/.exec(line);
    if (m && (line.includes(' objects:') || line.startsWith('Receiving') || line.startsWith('Writing'))) { out.size = parseBytes(m[1], m[2]); out.speed = m[3] ? parseBytes(m[3], m[4]) : null; }
    m = /Total (\d+) \(delta \d+\), reused (\d+) \(delta \d+\), pack-reused (\d+)/.exec(line);
    if (m) { out.totalObjects = +m[1]; out.reused = +m[2]; out.packReused = +m[3]; }
  }
  return out;
}

/** 把传输统计压成一行可读文本,如 "上传 0.11 MiB(12 对象,复用 8)平均 0.9 MiB/s";无传输返回空串 */
export function formatTransfer(st) {
  if (!st || (!st.size && !st.totalObjects)) return '';
  const dir = st.op === 'push' ? '上传' : '下载';
  const parts = [];
  if (st.size != null) parts.push(humanSize(st.size));
  if (st.totalObjects != null) parts.push(st.totalObjects + ' 个对象' + (st.reused ? `(复用 ${st.reused})` : ''));
  if (st.speed != null) parts.push('平均 ' + (st.speed / 1024 / 1024).toFixed(2) + ' MiB/s');
  return dir + ' ' + parts.join(',');
}

// zstd 解码/编码(读会话头 + 会话日志合并用):Node ≥22.10 才有;旧版本自动降级
let zstdDecompressSync = null;
let zstdCompressSync = null;
try { ({ zstdDecompressSync, zstdCompressSync } = await import('node:zlib')); } catch { zstdDecompressSync = null; zstdCompressSync = null; }

/** zstd 帧魔数(小端 0x184D2A57) */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);

/** 解码 zstd 多帧串联为 UTF-8 文本(跳过损坏/不完整帧);非 zstd 或无 zstd 支持时返回 null,由调用方回退 */
export function decodeZstdFrames(buf) {
  if (!(buf.length >= 4 && buf.subarray(0, 4).equals(ZSTD_MAGIC)) || typeof zstdDecompressSync !== 'function') return null;
  let out = Buffer.alloc(0);
  let i = 0;
  while (i <= buf.length - 4) {
    const idx = buf.indexOf(ZSTD_MAGIC, i);
    if (idx === -1) break;
    const i2 = buf.indexOf(ZSTD_MAGIC, idx + 4);
    const frame = i2 === -1 ? buf.subarray(idx) : buf.subarray(idx, i2);
    try { out = Buffer.concat([out, zstdDecompressSync(frame)]); } catch { /* 跳过损坏帧 */ }
    i = i2 === -1 ? buf.length : i2;
    if (i >= buf.length) break;
  }
  return out.toString('utf8');
}

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
  proxy: '',     // 可选:git 走代理(如 "http://127.0.0.1:7890"),直连 GitHub 慢/握手失败时建议配置
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

/**
 * 内置 .gitignore:只排除「每台机器各自的状态 / 可再生依赖 / 密钥」,其余全部同步。
 *
 * 设计取向(v0.11 起):本插件是「个人私有仓库」同步工具,settings.yaml
 * (字号/模型/默认模型/第三方 provider 配置/权限默认)随仓库同步,换电脑后
 * 设置直接带过去;但 .credentials.yaml(API 密钥 / 浏览器授权 secret)是机器
 * 本地机密,不同步 —— 跨机密钥走 apiKeyEnv 环境变量。settings.yaml 冲突时
 * 自动取本机(见 merge 流程),避免拉取覆盖本机设置。
 * 仓库是私有的,钥匙只在你手里;若你确实不想同步某个文件,在 ~/.dsh/.gitignore
 * 里加一行即可(手工改动会被保留)。
 */
const BUILTIN_IGNORE = [
  '# ===== dsh-sync-plugin 自动生成(手工改动会被保留;删除本文件后下次同步重新生成)=====',
  '',
  '# 机器本地状态 —— 不同步(窗口大小 / 用量统计 / 匿名 ID,每台机器各自的值)',
  '.anonymous-user-id',
  '.dshw-size.json',
  '.dshw-usage.json',
  '',
  '# 密钥 —— 不同步(API 密钥 / 浏览器授权 secret 是机器本地机密;跨机密钥走 apiKeyEnv 环境变量)',
  '.credentials.yaml',
  '',
  '# 会话投影缓存目录会同步(含会话标题 / cwd —— 用于跨机还原「工作区↔会话」对应关系);',
  '# 仅排除单个同级文件(不存在则无影响),目录本身保留,避免第二台电脑丢失会话归属信息',
  'storages/session_projcache.json',
  '',
  '# 依赖目录 / pnpm 存储 —— 不同步(在新电脑的 profiles/web 里执行 pnpm install 恢复)',
  '**/node_modules/',
  '.pnpm-store/',
  '',
  '# 同步引擎自身状态',
  '.dsh-sync.state.json',
  '',
  '# 工作区影子仓库(各工作区独立的 git 仓库,不与主仓库混同)',
  'workspace-repos/',
].join('\n');

/**
 * 旧版插件(≤0.9.x)生成的「配置忽略」条目:settings.yaml 自 v0.10 起随私有
 * 仓库同步(冲突自动取本机),旧 .gitignore 里的 settings.yaml 残留条目删除;
 * .credentials.yaml 在 v0.10 曾被放开同步,v0.11 起重新排除(密钥不上云),
 * 旧条目保留并由 BUILTIN_IGNORE_ENSURE 确保补回。
 */
const LEGACY_IGNORE_REMOVALS = ['settings.yaml'];

/**
 * 需要确保出现在 .gitignore 里的条目(密钥排除 + 依赖存储排除);对已存在的
 * .gitignore 由 ensureRepo 补写,对旧版本被移除的条目自动恢复。
 */
const BUILTIN_IGNORE_ENSURE = ['.credentials.yaml', '.pnpm-store/'];
/** 与上述条目相伴的旧版注释行(按新措辞重写,不整行删除,避免破坏用户阅读) */
const LEGACY_IGNORE_COMMENT_REWRITES = {
  '# 密钥与机器本地状态 —— 永不同步': '# 机器本地状态 —— 不同步(窗口大小 / 用量统计 / 匿名 ID)',
  '# 机器本地设置(含 provider 密钥引用)—— 不同步,避免拉取覆盖本机 apikey/配置': '# 机器本地状态 —— 不同步(窗口大小 / 用量统计 / 匿名 ID)',
  '# 机器本地设置(含第三方 provider 配置与密钥引用,如 settings.yaml 的 apiKeyEnv)—— 不同步,避免拉取覆盖本机设置': '# 机器本地状态 —— 不同步(窗口大小 / 用量统计 / 匿名 ID)',
};

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

/* ---- 会话日志(sourceEventSeqs 区间编码)合并工具 ---- */
/** 解码 sourceEventSeqs 存储形式([N] 或 [[start,end],...])为 seq 数组 */
function decodeSeqRangesLocal(value) {
  const decoded = [];
  for (const entry of value) {
    if (typeof entry === 'number') {
      if (!Number.isSafeInteger(entry) || entry < 0) throw new Error('bad seq');
      decoded.push(entry);
      continue;
    }
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error('bad range');
    const s = entry[0], e = entry[1];
    if (!Number.isSafeInteger(s) || !Number.isSafeInteger(e) || s < 0 || e < 0 || e < s) throw new Error('bad range');
    for (let q = s; q <= e; q++) decoded.push(q);
  }
  return decoded;
}
/** 重新编码 seq 数组:连续 ≥3 段压缩为 [start,end] 对(与 DSH 同款) */
function encodeSeqRangesLocal(values) {
  if (!values.every((v, i) => i === 0 || v > values[i - 1])) return [...values];
  const encoded = [];
  for (let start = 0; start < values.length;) {
    let end = start;
    while (end + 1 < values.length && values[end + 1] === values[end] + 1) end += 1;
    if (end - start >= 2) encoded.push([values[start], values[end]]);
    else for (let i = start; i <= end; i += 1) encoded.push(values[i]);
    start = end + 1;
  }
  return encoded;
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
    /** 本次同步的阶段时间线(step() 自动记录,供明细展示) */
    this._stages = [];
    /** 本次同步各仓库的传输统计(fetch/push 的字节、速度),供明细展示 */
    this._transfers = [];
    /** 正在进行的传输的实时统计({ op,label,pct,done,total,size,speed,at }),供 /api/progress 轮询展示 */
    this._liveTransfer = null;
    /** gh CLI 可用性探测缓存(避免每次同步都探测) */
    this._ghChecked = undefined;
    /** git 子进程环境变量(代理/凭据策略注入用;一次配置整轮生效) */
    this._gitEnv = { ...process.env };
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
    this._stages.push({ stage, label, at: Date.now() });
  }

  /** 按 cfg.proxy(如 "http://127.0.0.1:7890")注入 git 子进程代理环境;未配置则清除注入值。
   *  同时强制「凭据非交互」:远端需要凭据而本机没有/过期时,git 立即失败并给出明确报错,
   *  而不是弹 GCM(Git Credential Manager)窗口反复等待 —— 这正是之前「一点同步就弹
   *  git-credential-manager.exe、认证完又弹、获取远端状态卡死」的根因之一。 */
  applyProxyEnv(cfg) {
    const p = String(cfg.proxy || '').trim();
    const env = this._gitEnv;
    for (const k of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete env[k];
    if (p) {
      env.HTTP_PROXY = p; env.http_proxy = p; env.HTTPS_PROXY = p; env.https_proxy = p; env.ALL_PROXY = p; env.all_proxy = p;
      env.NO_PROXY = env.NO_PROXY || '127.0.0.1,localhost';
    }
    env.GIT_TERMINAL_PROMPT = '0';                 // git 不在终端询问账号/密码
    env.GIT_CREDENTIAL_NONINTERACTIVE = '1';       // GCM 等助手不再弹交互界面
    env.GCM_INTERACTIVE = 'never';                 // 显式禁用 GCM 的 GUI/浏览器交互
  }

  /** 判断一条 git 报错是否属于「凭据缺失/认证失败」(重试无意义,应秒级放弃并给出指引) */
  isAuthError(errText) {
    return /could not read Username|terminal prompts disabled|authentication failed|could not read password|not logged in|failed to execute prompt/i.test(String(errText || ''));
  }

  /** 主仓库 pack 体积(字节);失败返回 null */
  repoSizeBytes() {
    try {
      const r = spawnSync('git', ['count-objects', '-vH'], { cwd: this.home, windowsHide: true, encoding: 'utf8', timeout: 15000 });
      const m = /size-pack:\s*([\d.]+)\s*(\S+)/.exec(r.stdout || '');
      if (!m) return null;
      return parseBytes(m[1], m[2]);
    } catch { return null; }
  }

  /** 异步执行一条外部命令(git/gh),返回 { code, out, err };命令缺失时 code = -1。
   *  binary=true 时 stdout 以 Buffer 返回(用于读取冲突双方二进制内容);
   *  onProgress 可选:每收到一段 stderr 就回调(用于 --progress 的实时进度展示);
   *  useGitEnv=true 时在 DSH home 目录下、用代理/凭据环境变量执行(git 用;gh 不需要)。 */
  _spawn(cmd, args, timeoutMs, { binary = false, onProgress = null, useGitEnv = false } = {}) {
    return new Promise((resolve) => {
      const chunks = [];
      let err = '';
      let settled = false;
      let child;
      try {
        const opts = { windowsHide: true };
        if (useGitEnv) { opts.cwd = this.home; opts.env = this._gitEnv; }
        child = spawn(cmd, args, opts);
      } catch (e) {
        resolve({ code: -1, out: binary ? Buffer.alloc(0) : '', err: String(e) });
        return;
      }
      const timer = setTimeout(() => {
        if (!settled) { try { child.kill(); } catch { /* ignore */ } }
      }, timeoutMs);
      child.stdout?.on('data', (d) => { chunks.push(d); });
      child.stderr?.on('data', (d) => { err += d; if (onProgress) onProgress(d); });
      child.on('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const msg = String(e?.message || e);
        if (cmd === 'git' && msg.includes('ENOENT')) this.gitMissing = true;
        resolve({ code: -1, out: binary ? Buffer.alloc(0) : chunks.map(String).join(''), err: msg });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, out: binary ? Buffer.concat(chunks) : chunks.map(String).join(''), err });
      });
    });
  }

  /** 异步执行一条 git 命令(git 缺失时 code = -1) */
  git(args, timeoutMs = 120000, onProgress = null) {
    return this._spawn('git', args, timeoutMs, { onProgress, useGitEnv: true });
  }

  /** 字节安全地执行一条 git 命令(用于读取冲突双方二进制内容),stdout 以 Buffer 返回 */
  gitBytes(args, timeoutMs = 60000) {
    return this._spawn('git', args, timeoutMs, { binary: true, useGitEnv: true });
  }

  /** 同步(阻塞)执行一条 git 命令,用于退出冲刷;返回 { code, out, err } */
  gitSync(args, timeoutMs = 15000) {
    try {
      const r = spawnSync('git', args, { cwd: this.home, windowsHide: true, timeout: timeoutMs, encoding: 'utf8', env: this._gitEnv });
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
    return this._spawn('gh', args, timeoutMs);
  }

  /** 当前 gh 登录账号(login);未登录/gh 缺失时返回 null */
  async ghLogin() {
    const r = await this.gh(['api', 'user', '--jq', '.login']);
    return this.ok(r) ? r.out.trim() : null;
  }

  /** gh CLI 是否可用(缓存探测结果;用于决定凭据助手与自动建仓路径) */
  async ghAvailable() {
    if (this._ghChecked === undefined) this._ghChecked = this.ok(await this.gh(['--version']));
    return this._ghChecked;
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

  async rev(ref, gitdir = null, realPath = null) {
    const r = gitdir ? await this.gitW(gitdir, realPath, ['rev-parse', '--verify', ref]) : await this.git(['rev-parse', '--verify', ref]);
    return this.ok(r) ? r.out.trim() : null;
  }

  async isAncestor(a, b, gitdir = null, realPath = null) {
    if (!a || !b) return false;
    const r = gitdir ? await this.gitW(gitdir, realPath, ['merge-base', '--is-ancestor', a, b]) : await this.git(['merge-base', '--is-ancestor', a, b]);
    return this.ok(r);
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
      // 凭据助手(仓库级,不影响其他 git 项目):
      //  - gh 可用 → 用 gh 的凭据助手(令牌存 gh 自身配置,无 GUI 弹窗、跨机器稳定);
      //  - gh 不可用 → 维持 Git for Windows 默认 manager(GCM),但子进程已强制非交互,
      //    凭据缺失时秒级失败并给指引,不再弹 GCM 窗口反复认证。
      if (await this.ghAvailable()) {
        await this.git(['config', 'credential.helper', '!gh auth git-credential']);
      } else {
        await this.git(['config', 'credential.helper', 'manager']);
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
      this.log('info', '已生成 .gitignore(仅排除机器本地状态/node_modules;设置与密钥随仓库同步)');
    } else {
      // 迁移:settings.yaml 随私有仓库同步(冲突自动取本机),旧 .gitignore 里的
      // settings.yaml 条目删除;.credentials.yaml / .pnpm-store/ 自 v0.11 起排除
      // (密钥与依赖存储不上云),旧条目保留并确保补回(用户手工加的其他条目保留)。
      try {
        let cur = fs.readFileSync(ignorePath, 'utf8');
        const changed = [];
        const out = cur.split(/\r?\n/).filter((line) => {
          const t = line.trim();
          if (LEGACY_IGNORE_REMOVALS.includes(t)) { changed.push(t); return false; }
          return true;
        });
        // 注释行重写(单独一遍,避免 filter 回调里引用 out 的时序问题)
        for (let i = 0; i < out.length; i++) {
          const t = out[i].trim();
          if (LEGACY_IGNORE_COMMENT_REWRITES[t]) out[i] = LEGACY_IGNORE_COMMENT_REWRITES[t];
        }
        let base = out.join('\n');
        // 确保密钥/依赖存储排除条目在场
        const ensured = BUILTIN_IGNORE_ENSURE.filter((t) => !new RegExp(`^${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(base));
        if (ensured.length) {
          base = base.replace(/\s*$/, '\n') + '\n# 密钥与依赖存储 —— 不同步(dsh-sync-plugin 自动维护)\n' + ensured.join('\n') + '\n';
        }
        if (base !== cur) {
          fs.writeFileSync(ignorePath, base, 'utf8');
          const notes = [];
          if (changed.length) notes.push('移除旧条目 ' + changed.join(' / '));
          if (ensured.length) notes.push('补回排除条目 ' + ensured.join(' / '));
          this.log('info', `已迁移 .gitignore:${notes.join(';')}`);
        }
      } catch { /* ignore */ }
    }
    // 确保主仓库排除工作区影子仓库目录(避免把各工作区 git 元数据误当普通文件提交)
    try {
      const cur = fs.readFileSync(ignorePath, 'utf8');
      if (!/^workspace\-repos\/$/m.test(cur)) {
        fs.writeFileSync(ignorePath, cur.replace(/\s*$/, '\n') + 'workspace-repos/\n', 'utf8');
      }
    } catch { /* ignore */ }
    // 机器本地文件已在仓库跟踪中的,移出索引(不删文件;.gitignore 已排除,下次 add 不会加回)
    try {
      const targets = ['.credentials.yaml', '.dshw-usage.json', '.dshw-size.json', '.anonymous-user-id', '.pnpm-store'];
      const ls = await this.git(['ls-files', '--', ...targets]);
      if (this.ok(ls) && ls.out.trim()) {
        const r = await this.git(['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--', ...targets]);
        if (this.ok(r)) this.log('info', '机器本地文件已移出同步跟踪(文件保留,不同步): ' + ls.out.trim().split('\n').join(', '));
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

  /** 把远端头备份到 backup/<ts> 分支并推送(丢弃远端版本前的保险);gitdir/realPath 给定时为工作区影子仓库 */
  async backupRemoteHead(gitdir, realPath, remoteHead) {
    if (!remoteHead) return null;
    const branchName = `backup/${ts()}`;
    const cb = gitdir ? await this.gitW(gitdir, realPath, ['branch', branchName, remoteHead]) : await this.git(['branch', branchName, remoteHead]);
    if (!this.ok(cb)) return null;
    const pb = await this.runWithRetry('push', gitdir ? '工作区 ' + path.basename(realPath || '') : '主仓库', ['push', 'origin', branchName], { gitdir, realPath });
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

  /** 本机专属的工作区路径覆盖(不随主仓库同步;跨机路径不一致时用) */
  localWorkspacePathOverride(id) {
    try {
      const p = path.join(this.home, 'storages', 'workspace-local-paths.json');
      if (!fs.existsSync(p)) return null;
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const v = j && j.overrides && j.overrides[id];
      return typeof v === 'string' && v ? v : null;
    } catch { return null; }
  }
  setLocalWorkspacePath(id, p) {
    const file = path.join(this.home, 'storages', 'workspace-local-paths.json');
    let j = {};
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { j = {}; }
    if (!j.overrides || typeof j.overrides !== 'object') j.overrides = {};
    if (p) { j.overrides[id] = String(p); }
    else { delete j.overrides[id]; }
    fs.writeFileSync(file, JSON.stringify(j, null, 2));
    return p;
  }

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
  gitW(gitdir, realPath, args, timeoutMs = 120000, onProgress = null) {
    return this.git(['--git-dir=' + gitdir, '--work-tree=' + realPath, ...args], timeoutMs, onProgress);
  }

  /** 记录并(有传输时)日志输出一次 fetch/push 的传输统计;无传输(Everything up-to-date)不打扰 */
  recordTransfer(op, r, label) {
    try {
      const st = parseTransfer(r.err || '');
      if (!st.op) st.op = op; // 未输出进度行(无传输)时按调用意图补上方向
      if (st.size != null || st.totalObjects != null) {
        st.label = label;
        this._transfers.push(st);
        const line = formatTransfer(st);
        if (line) this.log('info', `${label}:${line}`);
      }
      return st;
    } catch { return { op }; }
  }

  /** 实时传输统计:解析 git --progress 每段 stderr,更新 this._liveTransfer 并挂到
   *  this.progress(供 /api/progress 轮询 → 侧栏气泡/设置卡实时展示上传下载字节与速度)。
   *  无传输信息(握手/计数行)时不动现有进度。 */
  liveTransfer(op, label, chunk) {
    try {
      const st = parseTransfer(String(chunk));
      if (st.op == null && st.size == null && st.totalObjects == null) return;
      st.op = st.op || op;
      st.label = label;
      const prev = this._liveTransfer;
      // git 未输出速度时,用字节增量/时间自行估算(滚动)
      if (st.speed == null && st.size != null && prev && prev.size != null && prev.at) {
        const dt = Date.now() - prev.at;
        if (dt > 0) st.speed = Math.max(0, Math.round(((st.size - prev.size) * 1000) / dt));
      }
      st.at = Date.now();
      this._liveTransfer = st;
      this.progress = { ...(this.progress || {}), running: true, transfer: st, at: Date.now() };
    } catch { /* 解析失败忽略 */ }
  }

  /** fetch/push 带一次快速重试:网络瞬时抖动时重试一次常能成功(已成功的 push 重试=Everything up-to-date,安全);
   *  但「凭据缺失/认证失败」直接秒级放弃(重试只会再弹一次窗、再等一个超时)。
   *  op='fetch'|'push';gitdir/realPath 给定时走工作区影子仓库,否则为主仓库。 */
  async runWithRetry(op, label, args, { gitdir = null, realPath = null, timeoutMs = 180000, onProgress = null } = {}) {
    const run = (a, t, p) => (gitdir ? this.gitW(gitdir, realPath, a, t, p) : this.git(a, t, p));
    const withProg = [...args, '--progress'];
    const r1 = await run(withProg, timeoutMs, onProgress);
    this.recordTransfer(op, r1, label);
    if (this.ok(r1)) return r1;
    if (this.isAuthError(r1.err)) {
      this.log('warn', `${label} git ${op} 需要凭据但当前不可用(已禁用交互弹窗)。请先 gh auth login 或配置 PAT(见 README「凭据」),再点同步。${String(r1.err).trim().split('\n')[0]}`);
      return r1;
    }
    await new Promise((res) => setTimeout(res, 1200));
    const r2 = await run(withProg, timeoutMs, onProgress);
    this.recordTransfer(op, r2, label);
    if (this.ok(r2)) this.log('info', `${label} git ${op} 首次失败(网络抖动)后重试成功`);
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
   * @param gitdir   工作区影子仓库 git 目录;null = 主仓库(gitBytes 走之)
   * @param base   工作树根目录绝对路径(文件写入用)
   * @param conflicts  冲突文件列表(相对 base)
   * @param ts     冲突时间戳
   * @returns [{ kind, id?, path, copy, conflictAt }] 仅记录成功物化的
   */
  async materializeConflicts(gitdir, base, conflicts, ts, kind = 'main', wsId = null) {
    const call = (a) => (gitdir ? this.gitBytesW(gitdir, base, a) : this.gitBytes(a));
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
   * 冲突标记守卫:检查一组冲突文件是否仍残留 git 冲突标记(<<<<<<< / ======= / >>>>>>>)。
   * 任何残留都意味着「双边保留」物化失败——此时绝不能 add/commit,否则把标记当内容
   * 提交进仓库,浏览器/编辑器打开就是乱码或空白(曾导致 赶时间-初版.html 页面空白)。
   * @param base   工作树根目录绝对路径
   * @param files  待检查的相对路径列表
   * @returns 仍残留标记的文件相对路径数组(空 = 全部干净)
   */
  conflictMarkersRemain(base, files) {
    const bad = [];
    for (const f of files) {
      if (!f || f.includes('\0')) continue;
      try {
        const text = fs.readFileSync(path.join(base, f), 'utf8');
        if (/^<<<<<<< |^>>>>>>> |^=======$/m.test(text)) bad.push(f);
      } catch (e) {
        // 文件不存在(modify/delete 冲突且本机删除):无内容可残留标记,不算风险;
        // 其它读取失败(物化写入失败等)视为有风险,宁可中止合并
        if (e && e.code !== 'ENOENT') bad.push(f);
      }
    }
    return bad;
  }

  /**
   * 用户对某次冲突的裁决(resolution = 'local' | 'remote' | 'both'),在工作树内裁决后提交并推送。
   * @param gitdir    工作区影子仓库 git 目录;null = 主仓库(git 走之)
   * @param base      工作树根目录
   * @param cfg       配置
   * @param branch    该项要推送的分支
   * @param conflict  { path, copy }(来自 materializeConflicts / outstandingConflicts)
   * @param resolution 裁决
   */
  async _resolveConflict(gitdir, base, cfg, branch, conflict, resolution) {
    const call = (a) => (gitdir ? this.gitW(gitdir, base, a) : this.git(a));
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
    let gitdir = null;
    let base = this.home;
    let branch = cfg.branch;
    if (conflict.kind === 'ws') {
      const ws = this.workspaces().find((w) => w.id === conflict.id);
      if (!ws) throw new Error('工作区不存在: ' + conflict.id);
      const realPath = this.workspacePathOf(ws.path, cfg);
      if (!realPath) throw new Error('无法解析工作区路径: ' + ws.path);
      gitdir = this.workspaceGitDir(conflict.id);
      base = realPath;
      branch = this.workspaceBranchOf(cfg, conflict.id);
    }
    return this._resolveConflict(gitdir, base, cfg, branch, conflict, resolution);
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

  /** 工作区在本机的实际路径(本机覆盖 > 记录路径/主目录重映射) */
  workspaceRealPathOf(ws, cfg) {
    return this.localWorkspacePathOverride(ws.id) || this.workspacePathOf(ws.path, cfg);
  }

  /** 同步单个工作区:确保真实文件夹存在(目标机缺则创建),把真实文件夹内容(以其为工作树)
   *  提交到影子仓库,并与远端 ws/<id> 分支对齐(快进/推送/合并,冲突保留本地并备份远端)。 */
  async syncWorkspace(ws, cfg, reason, opts) {
    const id = ws.id;
    // 本机路径覆盖优先(用户手动指定);否则按记录路径/主目录重映射解析
    const realPath = this.workspaceRealPathOf(ws, cfg);
    if (!realPath) return { id, error: 'no-path' };
    const gitdir = this.workspaceGitDir(id);
    const branch = this.workspaceBranchOf(cfg, id);
    // 目标机缺文件夹 → 自动创建(满足需求;路径按本机主目录重映射,换用户名也能对上)
    try { fs.mkdirSync(realPath, { recursive: true }); }
    catch (e) { this.log('error', `工作区 ${id} 无法创建目录 ${realPath}: ${e?.message || e}`); return { id, error: 'mkdir', path: realPath }; }
    if (!(await this.ensureWorkspaceMirror(id, realPath, cfg))) return { id, error: 'ensure-repo', path: realPath };

    const label = ws.title || path.basename(realPath) || id;
    this.step('ws', `同步工作区 ${label}…`);
    let remoteHead = null;
    if (cfg.remote) {
      const rf = await this.runWithRetry('fetch', '工作区 ' + (label || id), ['fetch', 'origin', '--prune'], { gitdir, realPath, timeoutMs: 180000, onProgress: (d) => this.liveTransfer('fetch', '工作区 ' + (label || id), d) });
      if (this.ok(rf)) remoteHead = await this.rev('refs/remotes/origin/' + branch, gitdir, realPath);
      else this.log('warn', `工作区 ${id} fetch 失败(远端不可达?仅本地快照): ${rf.err.trim().split('\n')[0] || rf.code}`);
    }
    const commitRes = await this.commitWorkspaceIfDirty(gitdir, realPath, cfg, opts.forceCommit === true);
    let committed = commitRes === 'committed';

    if (!cfg.remote) return { id, committed, pushed: false, pulled: false, path: realPath };

    const localHead = await this.rev('HEAD', gitdir, realPath);
    // 远端无该分支 → 首次推送
    if (remoteHead === null) {
      // 空工作区(没有可提交内容):跳过推送,不算失败 —— 目标机会自动创建该文件夹,DSH 归组校验需要它存在
      if (localHead === null) {
        this.log('info', `[${reason}] 工作区 ${id} 内容为空,跳过推送(目标机会自动创建该文件夹)`);
        return { id, committed, pushed: false, pulled: false, empty: true, path: realPath };
      }
      const p = await this.runWithRetry('push', '工作区 ' + (label || id), ['push', '-u', 'origin', branch], { gitdir, realPath, timeoutMs: 180000, onProgress: (d) => this.liveTransfer('push', '工作区 ' + (label || id), d) });
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
        const p = await this.runWithRetry('push', '工作区 ' + (label || id), ['push', 'origin', branch], { gitdir, realPath, timeoutMs: 180000, onProgress: (d) => this.liveTransfer('push', '工作区 ' + (label || id), d) });
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
    if (await this.isAncestor(remoteHead, localHead, gitdir, realPath)) {
      const p = await this.runWithRetry('push', '工作区 ' + (label || id), ['push', 'origin', branch], { gitdir, realPath, timeoutMs: 180000, onProgress: (d) => this.liveTransfer('push', '工作区 ' + (label || id), d) });
      if (this.ok(p)) return { id, committed, pushed: true, path: realPath };
      this.log('error', `工作区 ${id} push 失败: ${p.err.trim().split('\n')[0] || p.code}`);
      return { id, committed, pushed: false, error: 'push', path: realPath };
    }
    // 远端领先本地 → 快进拉取
    if (await this.isAncestor(localHead, remoteHead, gitdir, realPath)) {
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
      const p = await this.runWithRetry('push', '工作区 ' + (label || id), ['push', 'origin', branch], { gitdir, realPath, timeoutMs: 180000, onProgress: (d) => this.liveTransfer('push', '工作区 ' + (label || id), d) });
      if (!this.ok(p)) this.log('error', `工作区 ${id} 合并后推送失败: ${p.err.trim().split('\n')[0] || p.code}`);
      return { id, committed, pushed: this.ok(p), pulled: 'merge', unrelated, path: realPath };
    }
    const cf = await this.gitW(gitdir, realPath, ['diff', '--name-only', '--diff-filter=U']);
    const conflicts = this.ok(cf) ? cf.out.trim().split('\n').filter(Boolean) : [];
    const conflictTs = ts();
    const backupBranch = unrelated ? null : await this.backupRemoteHead(gitdir, realPath, remoteHead);
    let conflictCopies = [];
    if (unrelated) {
      for (const f of conflicts) await this.gitW(gitdir, realPath, ['checkout', '--theirs', '--', f]);
    } else {
      conflictCopies = await this.materializeConflicts(gitdir, realPath, conflicts, conflictTs, 'ws', id);
    }
    // 守卫:任何冲突文件仍残留合并标记 → 中止合并,绝不把标记提交/推送(标记会让页面/文档打开为空白或乱码)
    const stillMarked = this.conflictMarkersRemain(realPath, conflicts);
    if (stillMarked.length) {
      await this.gitW(gitdir, realPath, ['merge', '--abort']);
      this.log('error', `工作区 ${id} 合并冲突无法安全物化(文件仍含冲突标记: ${stillMarked.join(', ')}),已中止合并,本地状态未变;请手工解决后重新同步`);
      return { id, committed, error: 'merge-markers', path: realPath };
    }
    const done = await this.gitW(gitdir, realPath, ['add', '-A']);
    const cm = this.ok(done) ? await this.gitW(gitdir, realPath, ['commit', '--no-edit']) : { code: 1 };
    if (!this.ok(cm)) {
      await this.gitW(gitdir, realPath, ['merge', '--abort']);
      this.log('error', `工作区 ${id} 合并收尾失败,已中止(本地状态未变)`);
      return { id, committed, error: 'merge', path: realPath };
    }
    this.log('warn', `[${reason}] 工作区 ${id} 双方都有新提交,自动合并;${conflictCopies.length} 个冲突文件「双边保留」:本机版本保留,远端版本另存为 .dsh-conflict-<ts> 拷贝` + (backupBranch ? `,远端头备份到 ${backupBranch}` : '') + (conflictCopies.length ? `;冲突: ${conflictCopies.map((c) => c.path).join(', ')}` : conflicts.length ? `;冲突: ${conflicts.join(', ')}` : ''));
    const p = await this.runWithRetry('push', '工作区 ' + (label || id), ['push', 'origin', branch], { gitdir, realPath, timeoutMs: 180000, onProgress: (d) => this.liveTransfer('push', '工作区 ' + (label || id), d) });
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
    const created = [];
    let synced = 0, pushed = 0, pulled = 0;
    // 各工作区是独立影子仓库,可并行同步:网络往返是主要耗时,串行会把每个工作区的
    // fetch+push 延迟加起来(网络抖动时尤甚),并行能显著缩短总时长
    const existedBefore = new Map(list.map((ws) => [ws.id, (() => { try { return fs.existsSync(this.workspaceRealPathOf(ws, cfg)); } catch { return true; } })()]));
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
        // 目标机原本没有该文件夹、本次同步后出现了 → 记入"本机新创建"(客户端可提示换位置)
        if (!(existedBefore.get(r.id) === true) && r.path && fs.existsSync(r.path)) {
          const w = list.find((x) => x.id === r.id);
          created.push({ id: r.id, title: (w && w.title) || path.basename(r.path) || r.id, path: r.path, recorded: w && w.path });
        }
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
    return { total: list.length, synced, pushed, pulled, errors, conflictCopies, created };
  }

  /** 主数据同步(会话/settings/插件/技能/工作区元数据);工作区文件夹内容由外层 _syncOnce 追加处理 */
  /** 会话文件的实际 cwd:优先读日志头(只解首帧,快),失败回退为分组名还原 */
  sessionCwdOf(sdir, group) {
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
        const magic = ZSTD_MAGIC;
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
      if (!fs.existsSync(wsFile)) return { ok: true, repaired: 0, created: 0, deduped: 0 };
      let ws;
      try { ws = JSON.parse(fs.readFileSync(wsFile, 'utf8')); } catch (e) { return { ok: false, error: String(e?.message || e) }; }
      if (!ws || typeof ws !== 'object' || !ws.tables || typeof ws.tables !== 'object') return { ok: false, error: 'workspace.json 结构异常' };
      const workspaces = ws.tables.workspaces && typeof ws.tables.workspaces === 'object'
        ? ws.tables.workspaces
        : (ws.tables.workspaces = {});
      const global_ = ws.global && typeof ws.global === 'object' ? ws.global : (ws.global = {});
      const workspaceIds = Array.isArray(global_.workspaceIds) ? global_.workspaceIds : (global_.workspaceIds = []);
      const byPath = new Map();
      let deduped = 0;
      // 路径去重:同一路径被多个工作区 id 登记(两台电脑各自建过同目录工作区)时,
      // 只保留一个:会话最多者优先,其次最新更新者;被丢弃记录的会话并入保留记录。
      const pathIds = new Map();
      for (const [wid, w] of Object.entries(workspaces)) {
        if (!w || typeof w.path !== 'string') continue;
        const key = normPath(w.path);
        const arr = pathIds.get(key);
        if (arr) arr.push(wid); else pathIds.set(key, [wid]);
      }
      for (const [key, ids] of pathIds) {
        if (ids.length < 2) continue;
        ids.sort((a, b) => {
          const wa = workspaces[a], wb = workspaces[b];
          const sa = (Array.isArray(wa.sessionIds) ? wa.sessionIds.length : 0);
          const sb = (Array.isArray(wb.sessionIds) ? wb.sessionIds.length : 0);
          if (sa !== sb) return sb - sa;
          return String(wb.updatedAt || '').localeCompare(String(wa.updatedAt || ''));
        });
        const keep = ids[0];
        const keepRec = workspaces[keep];
        for (const drop of ids.slice(1)) {
          const rec = workspaces[drop];
          if (rec && Array.isArray(rec.sessionIds)) {
            const klist = Array.isArray(keepRec.sessionIds) ? keepRec.sessionIds : (keepRec.sessionIds = []);
            for (const sid of rec.sessionIds) if (!klist.includes(sid)) klist.push(sid);
          }
          delete workspaces[drop];
          const idx = workspaceIds.indexOf(drop);
          if (idx >= 0) workspaceIds.splice(idx, 1);
          this.log('info', `工作区路径去重:${rec && rec.path} 被 ${drop}(并入) 与 ${keep}(保留) 同时登记,已合并会话并移除重复登记`);
          deduped++;
        }
      }
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
            const cwd = this.sessionCwdOf(sdir, g);
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
      if (repaired || created || deduped) {
        fs.writeFileSync(wsFile, JSON.stringify(ws, null, 2));
        this.log('info', `工作区登记表修复:${repaired} 个会话补进对应工作区,新建 ${created} 个工作区条目,去重 ${deduped} 个重复工作区(随本次快照提交同步;若侧栏会话仍在「未分组」,请重启 dsh 以重新加载登记表)`);
      }
      return { ok: true, repaired, created, deduped };
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
          // 路径去重:若远端这条工作区记录的路径已被本机某条记录占用,不新增重复工作区
          // (同一文件夹被两台电脑登记成两个 id,是工作区内容合并冲突标记、会话归属错乱的根源)
          const claimed = tw && typeof tw.path === 'string'
            ? Object.entries(oWs).find(([_, w]) => w && typeof w.path === 'string' && normPath(w.path) === normPath(tw.path))
            : undefined;
          if (claimed) {
            const [localId, localW] = claimed;
            if (tw && Array.isArray(tw.sessionIds)) {
              const list = Array.isArray(localW.sessionIds) ? localW.sessionIds : (localW.sessionIds = []);
              for (const sid of tw.sessionIds) if (!list.includes(sid)) list.push(sid);
            }
            if (tw && typeof tw.title === 'string' && !localW.title) localW.title = tw.title;
            this.log('info', `workspace.json 并集合并:远端工作区 ${wid}(${tw.title || tw.path}) 与本地 ${localId} 同路径,已合并其会话,不新增重复登记`);
            continue;
          }
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
      // 并集后剔除幽灵:本机与云端(origin/<branch> 当前树)都没有文件的会话登记不保留(删除的会话不再"复活")
      try {
        const cfg = this.loadConfig();
        const localFiles = new Set();
        const root = path.join(this.home, 'sessions');
        if (fs.existsSync(root)) {
          for (const g of fs.readdirSync(root)) {
            let ids = [];
            try { ids = fs.readdirSync(path.join(root, g)); } catch { continue; }
            for (const id of ids) if (/^session-[0-9a-f-]{36}$/i.test(id)) localFiles.add(id);
          }
        }
        const remoteFiles = await this.remoteSessionIds(cfg.branch);
        const alive = (id) => localFiles.has(id) || remoteFiles.has(id);
        if (Array.isArray(ours.global.archivedSessionIds)) ours.global.archivedSessionIds = ours.global.archivedSessionIds.filter(alive);
        for (const w of Object.values(oWs)) if (Array.isArray(w.sessionIds)) w.sessionIds = w.sessionIds.filter(alive);
      } catch { /* 幽灵清理失败不阻断合并 */ }
      fs.writeFileSync(path.join(this.home, f), JSON.stringify(ours, null, 2));
      this.log('info', 'workspace.json 冲突已做并集合并:两台电脑的工作区与会话映射都保留');
      return true;
    } catch (e) {
      this.log('warn', 'workspace.json 并集合并失败,改用单边保留: ' + String(e?.message || e));
      return false;
    }
  }

  /** 远端(origin/<branch> 当前树)上存在的会话 id 集合 */
  async remoteSessionIds(branch) {
    try {
      const r = await this.git(['ls-tree', '-r', '--name-only', `origin/${branch}`, '--', 'sessions/']);
      if (!this.ok(r) || !r.out) return new Set();
      const set = new Set();
      for (const line of r.out.split('\n')) {
        const m = line.match(/sessions\/[^/]+\/(session-[0-9a-f-]{36})\//i);
        if (m) set.add(m[1]);
      }
      return set;
    } catch { return new Set(); }
  }

  /**
   * 幽灵登记清理:剔除 archivedSessionIds 与各工作区 sessionIds 里
   * 「本机与云端(origin/<branch> 当前树)都没有会话文件」的 id。
   * 这样删除的会话不会因为另一台电脑的登记表还留着而"删不掉";
   * 云端还活着的会话(id 有文件)则保留登记,保证对应关系跨机还原。
   */
  async pruneGhostRegistrations() {
    try {
      const cfg = this.loadConfig();
      const wsFile = path.join(this.home, 'storages', 'workspace.json');
      if (!fs.existsSync(wsFile)) return { ok: true, pruned: 0 };
      let ws;
      try { ws = JSON.parse(fs.readFileSync(wsFile, 'utf8')); } catch { return { ok: false, pruned: 0 }; }
      const localFiles = new Set();
      const root = path.join(this.home, 'sessions');
      if (fs.existsSync(root)) {
        for (const g of fs.readdirSync(root)) {
          let ids = [];
          try { ids = fs.readdirSync(path.join(root, g)); } catch { continue; }
          for (const id of ids) if (/^session-[0-9a-f-]{36}$/i.test(id)) localFiles.add(id);
        }
      }
      const remoteFiles = await this.remoteSessionIds(cfg.branch);
      const alive = (id) => localFiles.has(id) || remoteFiles.has(id);
      let pruned = 0;
      if (Array.isArray(ws.global?.archivedSessionIds)) {
        const before = ws.global.archivedSessionIds.length;
        ws.global.archivedSessionIds = ws.global.archivedSessionIds.filter(alive);
        pruned += before - ws.global.archivedSessionIds.length;
      }
      for (const w of Object.values(ws.tables?.workspaces ?? {})) {
        if (Array.isArray(w.sessionIds)) {
          const before = w.sessionIds.length;
          w.sessionIds = w.sessionIds.filter(alive);
          pruned += before - w.sessionIds.length;
        }
      }
      if (pruned) {
        fs.writeFileSync(wsFile, JSON.stringify(ws, null, 2));
        this.log('info', `登记表幽灵清理:剔除 ${pruned} 个本机与云端都没有文件的会话登记(删除后不再"复活")`);
      }
      return { ok: true, pruned };
    } catch (e) {
      this.log('warn', '登记表幽灵清理失败(不影响同步): ' + String(e?.message || e));
      return { ok: false, pruned: 0 };
    }
  }

  /** 会话投影缓存冲突拷贝清理:session_projcache/** 是可再生缓存,冲突拷贝直接删除并推送(取本机版本即可) */
  async pruneCacheConflicts() {
    try {
      const cfg = this.loadConfig();
      const list = this.outstandingConflicts().filter((c) => c.kind !== 'ws' && /^storages\/session_projcache\//i.test(c.path || ''));
      if (!list.length) return { ok: true, pruned: 0 };
      for (const c of list) {
        try {
          const copyAbs = path.join(this.home, c.copy);
          if (fs.existsSync(copyAbs)) fs.rmSync(copyAbs, { force: true });
        } catch { /* ignore */ }
      }
      const st = await this.git(['status', '--porcelain']);
      if (this.ok(st) && String(st.out).trim()) {
        const added = await this.git(['add', '-A']);
        if (this.ok(added)) {
          const cm = await this.git(['commit', '-m', 'dsh-sync-plugin: 清理会话投影缓存冲突拷贝(可再生缓存,自动取本机)']);
          if (this.ok(cm)) {
            if (cfg.remote) await this.git(['push', 'origin', cfg.branch]); // 推送失败不阻塞,下次同步再推
            return { ok: true, pruned: list.length, committed: true };
          }
        }
      }
      return { ok: true, pruned: list.length };
    } catch (e) {
      this.log('warn', '缓存冲突拷贝清理失败(不影响同步): ' + String(e?.message || e));
      return { ok: false, pruned: 0 };
    }
  }

  /** 解码会话日志字节(支持 zstd 多帧串联与明文 JSONL) */
  decodeLogBytes(buf) {
    return decodeZstdFrames(buf) ?? buf.toString('utf8');
  }

  /**
   * 会话日志冲突合并:两侧都是"在共同基础上追加事件"时,按 time 合并双方事件、
   * 重编号 seq、重映射 sourceEventSeqs 引用。任何一步无法验证(格式异常/引用未知
   * seq/无法压缩)就返回 false,由外层退回「双边保留」(本机版本保留 + 远端备份拷贝),
   * 绝不产出 DSH 读不了的日志。
   */
  async mergeSessionLogConflict(f) {
    try {
      const [oursRes, theirsRes] = await Promise.all([
        this.gitBytes(['show', ':2:' + f]),
        this.gitBytes(['show', ':3:' + f]),
      ]);
      const oursBuf = oursRes && oursRes.out ? oursRes.out : null;
      const theirsBuf = theirsRes && theirsRes.out ? theirsRes.out : null;
      if (!oursBuf || !theirsBuf) return false;
      const oursText = this.decodeLogBytes(oursBuf);
      const theirsText = this.decodeLogBytes(theirsBuf);
      const oursLines = oursText.split('\n').map((l) => l.trim()).filter(Boolean);
      const theirsLines = theirsText.split('\n').map((l) => l.trim()).filter(Boolean);
      if (!oursLines.length || !theirsLines.length) return false;
      // 完全相同行 = 共同基线;一侧没有新增 → 直接采用另一侧(seq 天然有效,字节级保留)
      const theirsSet = new Set(theirsLines);
      const oursOnly = oursLines.filter((l) => !theirsSet.has(l));
      if (!oursOnly.length) { this.writeLogBytes(f, oursBuf); return true; }
      const oursSet = new Set(oursLines);
      const theirsOnly = theirsLines.filter((l) => !oursSet.has(l));
      if (!theirsOnly.length) { this.writeLogBytes(f, theirsBuf); return true; }
      // 两侧都有新增 → 合并
      const parse = (l) => { try { return JSON.parse(l); } catch { return null; } };
      const all = [];
      for (const l of oursLines) all.push({ line: l, rec: parse(l) });
      for (const l of theirsOnly) all.push({ line: l, rec: parse(l) });
      // 头部记录(type session)必须唯一且在最前
      const headers = all.filter((r) => r.rec && r.rec.type === 'session');
      if (headers.length !== 1 || !headers[0].rec) return false;
      const events = all.filter((r) => !(r.rec && r.rec.type === 'session'));
      // 每条事件必须可解析且有数值 time,否则无法安全排序
      for (const r of events) {
        if (!r.rec || typeof r.rec.time !== 'number' || !Number.isFinite(r.rec.time)) return false;
      }
      events.sort((a, b) => a.rec.time - b.rec.time || 0); // 稳定排序,同 time 保持原序
      const ordered = [headers[0], ...events];
      // seq 重编号 + sourceEventSeqs 重映射
      const seqMap = new Map();
      let nextSeq = 0;
      const merged = [];
      for (const r of ordered) {
        const rec = JSON.parse(r.line);
        if (typeof rec.seq === 'number') {
          if (!Number.isSafeInteger(rec.seq) || rec.seq < 0) return false;
          seqMap.set(rec.seq, nextSeq);
          rec.seq = nextSeq;
          nextSeq++;
        }
        const d = rec.data;
        if (d && Array.isArray(d.sourceEventSeqs)) {
          try {
            const decoded = decodeSeqRangesLocal(d.sourceEventSeqs);
            const remapped = decoded.map((s) => seqMap.get(s));
            if (remapped.some((x) => x === undefined)) return false; // 引用了合并集外的 seq
            d.sourceEventSeqs = encodeSeqRangesLocal(remapped);
          } catch { return false; }
        }
        merged.push(JSON.stringify(rec));
      }
      if (typeof zstdCompressSync !== 'function') return false;
      const text = merged.join('\n') + '\n';
      const out = zstdCompressSync(Buffer.from(text, 'utf8'));
      this.writeLogBytes(f, out);
      return true;
    } catch { return false; }
  }

  /** 写回冲突文件(工作树路径) */
  writeLogBytes(f, buf) {
    const target = path.join(this.home, f);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buf);
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
    let authFailed = false;

    if (hasRemote) {
      this.step('fetch', '获取远端状态…');
      const rf = await this.runWithRetry('fetch', '主仓库', ['fetch', 'origin', '--prune'], { timeoutMs: 180000, onProgress: (d) => this.liveTransfer('fetch', '主仓库', d) });
      if (!this.ok(rf)) {
        authFailed = this.isAuthError(rf.err);
        this.log('warn', `git fetch 失败(${authFailed ? '凭据缺失/认证失败' : '远端不可达?'}本次只做本地快照): ${rf.err.trim().split('\n')[0] || rf.code}`);
      } else {
        remoteHead = await this.rev(`refs/remotes/origin/${cfg.branch}`);
      }
    }

    // 幽灵登记清理:fetch 成功(云端快照可用)后,剔除本机与云端都没有文件的会话登记 —— 删除的会话不再"复活"
    if (remoteHead !== null) {
      try { await this.pruneGhostRegistrations(); } catch (e) { this.log('warn', '幽灵登记清理异常: ' + String(e?.message || e)); }
      // 会话投影缓存冲突拷贝清理:可再生缓存,自动删掉拷贝并推送(不占用用户裁决)
      try { await this.pruneCacheConflicts(); } catch (e) { this.log('warn', '缓存冲突拷贝清理异常: ' + String(e?.message || e)); }
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
      // 凭据缺失/认证失败:跳过推送尝试(否则会再弹一次 GCM/再失败一次),给出明确指引
      if (authFailed) {
        return { committed, pushed: false, error: 'auth', hint: '远端需要凭据但当前不可用。请先 gh auth login 或配置 PAT(见 README「凭据」),再点同步。' };
      }
      // 远端还没有分支:直接推送本地状态
      this.step('push', '首次推送到远端…');
      const p = await this.runWithRetry('push', '主仓库', ['push', '-u', 'origin', cfg.branch], { timeoutMs: 180000, onProgress: (d) => this.liveTransfer('push', '主仓库', d) });
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
        const p = await this.runWithRetry('push', '主仓库', ['push', 'origin', cfg.branch], { timeoutMs: 180000, onProgress: (d) => this.liveTransfer('push', '主仓库', d) });
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
      const p = await this.runWithRetry('push', '主仓库', ['push', 'origin', cfg.branch], { timeoutMs: 180000, onProgress: (d) => this.liveTransfer('push', '主仓库', d) });
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
      const p = await this.runWithRetry('push', '主仓库', ['push', 'origin', cfg.branch], { timeoutMs: 180000, onProgress: (d) => this.liveTransfer('push', '主仓库', d) });
      if (!this.ok(p)) this.log('error', `合并后推送失败: ${p.err.trim().split('\n')[0] || p.code}`);
      return { committed, pushed: this.ok(p), pulled: 'merge', unrelated };
    }
    const cf = await this.git(['diff', '--name-only', '--diff-filter=U']);
    let conflicts = this.ok(cf) ? cf.out.trim().split('\n').filter(Boolean) : [];
    const conflictTs = ts();
    const backupBranch = unrelated ? null : await this.backupRemoteHead(null, null, remoteHead);
    let conflictCopies = [];
    if (unrelated) {
      // 无共同历史(新机并入远端):同名文件以远端为准,本地独有文件保留
      for (const f of conflicts) await this.git(['checkout', '--theirs', '--', f]);
    } else {
      // workspace.json 特殊处理:并集合并(双方工作区/会话映射都保留);并集失败时
      // 自动取本机(远端登记保留在 origin/<branch> 历史中),绝不占用用户裁决
      if (conflicts.includes('storages/workspace.json')) {
        if (await this.unionMergeWorkspaceJson()) {
          await this.git(['add', '--', 'storages/workspace.json']);
          conflicts = conflicts.filter((f) => f !== 'storages/workspace.json');
        } else {
          await this.git(['checkout', '--ours', '--', 'storages/workspace.json']);
          conflicts = conflicts.filter((f) => f !== 'storages/workspace.json');
          this.log('warn', `[${reason}] workspace.json 并集合并失败,已自动取本机(远端登记见 origin/${cfg.branch} 历史,可从 git 找回)`);
        }
      }
      // 会话日志(zstd JSONL)冲突:两侧都是"在共同基础上追加"时按时间自动合并(新增内容直接可见),
      // 而不是单边保留;无法安全合并的文件退回「双边保留」
      const logFiles = conflicts.filter((f) => /^sessions\/[^/]+\/session-[0-9a-f-]{36}\/session\.jsonl(\.zstd)?$/i.test(f));
      const otherConflicts = conflicts.filter((f) => !logFiles.includes(f));
      for (const f of logFiles) {
        if (await this.mergeSessionLogConflict(f)) {
          this.log('info', `[${reason}] 会话日志冲突已自动合并: ${f}(双方新增内容按时间交错,直接可见)`);
          await this.git(['add', '--', f]);
        } else {
          this.log('warn', `[${reason}] 会话日志无法安全合并,保留本机版本: ${f}(远端版本会另存为冲突拷贝)`);
        }
      }
      conflicts = otherConflicts;
      // 会话投影缓存(session_projcache/**)冲突:可再生缓存,DSH 读会话时会自动重建,
      // 直接取本机版本,不占用用户裁决
      const cacheFiles = conflicts.filter((f) => /^storages\/session_projcache\//i.test(f));
      const otherConflicts2 = conflicts.filter((f) => !cacheFiles.includes(f));
      for (const f of cacheFiles) {
        await this.git(['checkout', '--ours', '--', f]);
        await this.git(['add', '--', f]);
        this.log('info', `[${reason}] 会话投影缓存冲突自动取本机(可再生,无需裁决): ${f}`);
      }
      conflicts = otherConflicts2;
      // 机器本地设置文件冲突:settings.yaml(默认模型/权限/provider 配置)与
      // .credentials.yaml(密钥,不同步)冲突时自动取本机 —— 避免拉取覆盖本机设置/密钥;
      // 远端内容保留在 origin/<branch> 历史中(checkout --ours 已把本机版本落回工作树与索引)
      const machineLocalFiles = conflicts.filter((f) => f === 'settings.yaml' || f === '.credentials.yaml');
      const otherConflicts3 = conflicts.filter((f) => !machineLocalFiles.includes(f));
      for (const f of machineLocalFiles) {
        await this.git(['checkout', '--ours', '--', f]);
        this.log('info', `[${reason}] 机器本地文件冲突自动取本机(设置/密钥不被远端覆盖): ${f}`);
      }
      conflicts = otherConflicts3;
      // 常规双边冲突:本机版本保留为活动文件;远端版本另存为可见的 .dsh-conflict-<ts> 拷贝,一并提交+推送(不丢任一方)
      conflictCopies = await this.materializeConflicts(null, this.home, conflicts, conflictTs, 'main', null);
    }
    // 守卫:任何冲突文件仍残留合并标记 → 中止合并,绝不把标记提交/推送(标记会让页面/文档打开为空白或乱码)
    const stillMarked = this.conflictMarkersRemain(this.home, conflicts);
    if (stillMarked.length) {
      await this.git(['merge', '--abort']);
      this.log('error', `主仓库合并冲突无法安全物化(文件仍含冲突标记: ${stillMarked.join(', ')}),已中止,本地状态未变;请手工解决后重新同步`);
      return { committed, error: 'merge-markers' };
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
    const p = await this.runWithRetry('push', '主仓库', ['push', 'origin', cfg.branch], { timeoutMs: 180000, onProgress: (d) => this.liveTransfer('push', '主仓库', d) });
    if (!this.ok(p)) this.log('error', `合并后推送失败: ${p.err.trim().split('\n')[0] || p.code}`);
    return {
      committed, pushed: this.ok(p), pulled: 'merge',
      conflicts: conflictCopies.length ? conflictCopies.map((c) => c.path) : conflicts,
      conflictCopies, backupBranch,
    };
  }

  /** 对外同步总入口:先同步主数据(.dsh 会话/settings/插件/工作区元数据),再同步各工作区文件夹内容 */
  async _syncOnce(reason, opts = {}) {
    const t0 = Date.now();
    this._stages = [{ stage: 'start', label: '开始同步', at: t0 }];
    this._transfers = [];
    const cfg = this.loadConfig();
    this.applyProxyEnv(cfg);
    const rMain = await this._mainSync(reason, opts);
    let workspaces = { skipped: 'not-run', total: 0, synced: 0, pushed: 0, pulled: 0, errors: [] };
    try {
      workspaces = await this.syncAllWorkspaces(cfg, reason, opts);
    } catch (e) {
      workspaces = { skipped: 'error', total: 0, synced: 0, pushed: 0, pulled: 0, errors: [{ id: '', title: '', path: '', error: String(e?.message || e) }] };
    }
    // 阶段时间线(每段的毫秒数)与传输明细、仓库体积,随结果返回供 CLI/状态卡/API 展示
    const stages = [];
    for (let i = 0; i < this._stages.length; i++) {
      const cur = this._stages[i];
      const next = this._stages[i + 1];
      stages.push({ stage: cur.stage, label: cur.label, ms: next ? next.at - cur.at : Date.now() - cur.at });
    }
    const repoSize = this.repoSizeBytes();
    return {
      ...rMain, workspaces,
      durationMs: Date.now() - t0,
      stages,
      transfers: this._transfers,
      repoSize,
    };
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
          transfer: null,
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
