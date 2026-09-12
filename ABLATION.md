# 消融实验记录 —— 去掉不必要的抽象与设计

> **状态说明(2026-09-12,v0.11.7)**:本文是 **v0.11.1 基准**的历史记录,不是当前代码的度量。
> 之后 v0.11.2~v0.11.6 又加回了「工作区路径覆盖 / 自动重启修复 / 幽灵清理 / 归档会话管理」等
> 功能,行数与结论已变化;v0.11.7 又做了一轮性能消融(见文末「v0.11.7 增补」)。
> 各版本行数对照(v0.11.1 → v0.11.7):`sync.js` 1714 → 2127、`index.js` 818 → 920、
> `client.js` — → 849、`patches.js` 157 → 195。**引用本文数字前请先看文末增补。**

> 目的:对 dsh-sync-plugin(v0.11.1 基准)做系统性消融 —— 逐项识别并移除不必要的抽象、间接层与死代码,每移除一项都以「语法检查 + 冒烟测试 + 临时目录端到端集成测试」验证功能不受影响。
>
> 结果:`lib/` 净删 **163 行**(+109 / −272):`sync.js` 1896→1714 行(−9.6%)、`index.js` 870→818(−6%)、`patches.js` 186→157(−15.6%)。全部行为保持,提交在当时的开发分支上(该分支已随 v0.11.2 之后的工作并入主线,提交号不再单独可查)。

## 方法

1. **基线**:先把工作区 git 仓库同步到实际运行的 0.11.1(提交 `886bd25`),`smoke-test.mjs` 改为直接验证工作区代码,跑通基线(传输解析 / 大小格式化 / 认证错误识别 / 实时传输估算)。
2. **消融**:每移除一项抽象 → 立即验证:`node --check` 全部 lib 文件 + 模块可加载 + `smoke-test.mjs` + 临时 DSH home 端到端(主仓库初始化/登记表修复/本地快照提交 + 工作区影子仓库镜像/提交)。
3. **验证脚本**:`verify.mjs`(语法+加载+冒烟+主仓库集成)、`ws-integration-test.mjs`(工作区影子仓库集成),均以临时目录隔离、`autoRepo:false` 防误连真实仓库。

## 消融项

| # | 移除的抽象/设计 | 理由(为什么是不必要的) | 验证 |
|---|---|---|---|
| A | `fetchWithRetry` / `fetchWithRetryW` / `pushWithRetry` / `pushWithRetryW` 四个方法 → 一个 `runWithRetry(op, label, args, {gitdir, realPath, timeoutMs, onProgress})` | 四者逻辑完全相同(重试一次 + 认证失败秒级放弃),仅 op、标签、主/工作区 runner 不同;W 变体只是换 `gitW` | 14 处调用点全量改写后冒烟+集成全绿 |
| B | `revW` / `isAncestorW` → 折叠进 `rev` / `isAncestor`(可选 `gitdir, realPath` 参数) | 各为 4 行薄包装,只多拼一个 gitdir;基础方法加两个可选参数即覆盖 | 4 处调用点改写后验证通过 |
| B | `backupRemoteHeadWs` → 折叠进 `backupRemoteHead(gitdir, realPath, remoteHead)` | 两方法体几乎相同;且原 `backupRemoteHead(cfg, …)` 的 `cfg` 参数**从未被使用**(死参数);顺带统一了工作区备份推送的失败告警 | 2 处调用点改写后验证通过 |
| B2 | `materializeConflicts(call, …)` / `_resolveConflict(call, …)` 的**函数注入(call)抽象** → 传 `gitdir`,方法内部自选 `gitBytes`/`gitBytesW` 或 `git`/`gitW` | 注入一个 `(args)=>Promise` 是典型的过度抽象:调用方只是换 runner,方法体完全一样;去掉后接口更直白 | 2 处调用点改写后验证通过 |
| C | `git` / `gitBytes` / `gh` 三份几乎相同的 spawn+超时+settle 样板 → 一个 `_spawn(cmd, args, timeoutMs, {binary, onProgress, useGitEnv})` | 三份 Promise 样板仅 cmd、binary、cwd/env 不同;重复约 90 行 | 冒烟+集成(含 gitBytes 字节路径、gh 探测缓存)全绿 |
| D | zstd 多帧解码去重:导出 `ZSTD_MAGIC` + `decodeZstdFrames(buf)`,`sync.js` 的 `decodeLogBytes` 与 `index.js` 的 `decodeSessionText` 共用;`sessionCwdOf` 的魔数也改为共享常量 | 两模块各写了一份多帧 zstd 解码(约 30 行重复) + 三处散落魔数字面量;坏帧处理统一为「跳过损坏帧」(原 sync 版是遇坏帧即断,行为略有收紧,更稳) | zstd 多帧往返测试 + 冒烟全绿 |
| E | 死代码:`restorePatchToTargets`(无任何调用方)及仅它产生的 `restored`/`no-backup` 状态文案;`syncWorkspace` 里声明未用的 `createdHere`;`sessionCwdOf` 的未用参数 `id` | 全是"写多了但没用上"的死设计 | 全仓引用扫描 0 残留,验证全绿 |
| E | `index.js` 单次使用辅助函数 `resolveHome` / `readConfigFile` 内联 | 各只用一次、仅 5-6 行的间接层,内联后 apply() 自明 | 模块加载+验证通过 |
| E | `BUILTIN_IGNORE` / `LEGACY_IGNORE_REMOVALS` / `BUILTIN_IGNORE_ENSURE` / `LEGACY_IGNORE_COMMENT_REWRITES` 去掉多余 `export` | 仅模块内部使用,导出属于多余接口面 | 验证通过 |

## 有意保留(消融中评估过、判定为必要)

- **`LEGACY_IGNORE_*` 迁移逻辑**(≤0.9.x → 0.11 的 .gitignore 升级):是真实升级路径的数据驱动逻辑,不是抽象,删了会破坏老用户升级。
- **`_mainSync` 冲突分类链**(`otherConflicts` → `otherConflicts2` → `otherConflicts3`):已是最扁平的顺序处理;改造成"处理器表"反而新增一层抽象,与消融方向相反。
- **`gitWSync` / `gitBytesW`**:2-3 行的命名适配器,承担 gitdir+worktree 参数拼装,语义清晰。
- **`flushSync`(退出冲刷)**:与 `commitIfDirty` 逻辑相近但**故意**用阻塞版 `spawnSync` 复写(退出时不能 await),合并会破坏退出语义。
- **`client.js` 的 `fmtBytes`**:与宿主端 `humanSize` 同名同义,但浏览器 bundle 无法 import 宿主代码,属于必要的平台复制。
- 全部 `DEFAULT_CONFIG` 键、全部 SyncEngine 方法、全部导出:逐一核对均有真实调用方,无死配置/死导出。

## 附带修复(消融过程中发现)

- **测试误连真实仓库**:集成测试临时 home 未写 `autoRepo:false` 时,引擎默认 `autoRepo:true`,会经 gh 自动探测并把临时目录连到真实 GitHub 同步仓库(曾误推 6 个垃圾提交,经用户同意已 `git push origin 608cc49:main --force` 恢复)。`verify.mjs` / `ws-integration-test.mjs` 已全部显式 `autoRepo:false`。
- 教训已记入 `~/.dsh/memory/lessons.md`。

## 附:v0.11.7 增补消融/性能(2026-09-12,实测)

| 项 | 改动 | 实测收益 |
|---|---|---|
| 登记表自查重复解析 | `repairWorkspaceRegistry` 每轮跑 2 次且解析**全部**会话头取 cwd → 只解析「登记表里没有的」会话,并按 `(文件,size,mtime)` 缓存解析结果 | 真实 22 会话 home:**30.5ms → 2.3ms/次(−92%)**,补登记结果逐字一致 |
| 4 份重复的会话目录扫描 | 新增 `SyncEngine.scanSessions()` / `localSessionIds()`,登记表自查 / 幽灵清理 / 并集合并幽灵剔除共用 | 删掉 3 段重复的 `readdir + 正则` 循环 |
| 会话文件候选名散落 | 新增导出常量 `SESSION_LOG_NAMES`,`sync.js` 与 `index.js` 预览共用 | 根除「预览漏 v3」这类漏项(v0.11.7 修的真实缺陷) |
| 工作区影子仓库配置 | 每轮每工作区 10+ 次 `git config` → 一次 `git config --get-regexp` + 差异写入 + 进程内已应用标记 | 空转轮每工作区 git 调用 **34~40 → 13~17**;整轮 **56 → 32 次** |
| 工作区空转快路径 | 本地头 == 远端头且工作树干净 → 直接返回(不提交/不推送) | 与上一条共同把空转轮从 2.8s 降到 **2.2s** |
| 冲突扫描重复调用 | `outstandingConflicts()` 结果缓存 15s、每轮同步结束失效;`pruneCacheConflicts` 改用只扫主仓库的 `mainConflictCopies()` | 首次 181ms,重复调用 **0ms**;每轮同步少一次全工作区扫描 |
| `git gc` 触发条件 | 原来只在「本进程 ≥20 次提交」后回收 → 增加 loose 体积阈值(≥64MB 或 ≥5000 个 loose 对象) | 真实仓库 loose 曾堆积 **142MB** 长期不回收 |
| 孤儿影子仓库可见性 | 新增 `reportOrphanWorkspaceRepos()`(24h 一次,只提示不自动删) | 真实机器 `workspace-repos/` 156MB 中 **153MB 是孤儿** |
| 轮询频率 | 侧栏按钮 + 设置分节各 500ms 轮询 `/api/progress` → 1s | 同步期间请求数减半(两处组件合计 4 req/s → 2 req/s) |

> 未做(评估后判定收益/风险不划算):`commitIfDirty` 与 `commitWorkspaceIfDirty` 的双份实现合并
> (共用同一个 `lastCommitAt` 节流时钟,改动面大);客户端 `useSync` 提升为模块级共享 store
> (收益是请求数,已用降频达成)。

## 复现验证

```powershell
node verify.mjs                # 语法 + 模块加载 + 冒烟 + 主仓库端到端
node ws-integration-test.mjs   # 工作区影子仓库端到端
node regression-v0117-test.mjs # v0.11.7 四项缺陷回归(隔离临时 home + 本地 bare 远端)
```