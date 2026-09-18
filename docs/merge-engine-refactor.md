# 合并层重构设计:告别「二次判断」,向云文档式收敛

> 状态：历史设计草案（以 v0.11.7 为基线；后续已有实现）。本文保留当时的目标与推演，其中“永不丢数据”“完全一致”等是设计目标，不是当前产品保证。当前行为见 [同步内容与合并边界](sync-content.md)。
> 基线:v0.11.7(仓库 main @ 1f4eac5,安装目录同版本,工作树干净)
> 目标:保留 git 做传输与历史,重写「合并层」,实现**跨机状态完全一致 + 同步过程永不要求人工判断冲突**。

---

## 1. 目标与原则

1. **传输与合并分离**。git 继续负责:远端传输、鉴权(gh/PAT)、版本历史、误删可回溯、跨机分发。合并不再依赖 `git merge` 的三路行级合并作为兜底。
2. **冲突是数据问题,不是流程问题**。每类文件都有一条**确定性、收敛**的合并规则;不存在「停下来问用户」的分支。
3. **绝不在工作树里留下 `<<<<<<<` 标记**(现有 `conflictMarkersRemain` 守卫保留并前移)。
4. **永不丢数据**:被合并算法放弃的一侧,要么进 git 历史、要么进 backup 分支、要么进归档拷贝(不阻塞、可回溯)。
5. **插件保持零运行时依赖**(纯 `node:` 内建 + git 子进程),延续「纯 git 编排」的设计取向。

---

## 2. 现状:为什么会出现「二次判断」

当前 `_syncOnce` 的「情况 4」(双方都有新提交)走 `git merge --no-edit origin/main`,冲突后按文件类型**逐个打补丁**:

| 现有规则 | 位置 | 问题 |
| --- | --- | --- |
| `workspace.json` 并集合并 | `unionMergeWorkspaceJson` | 已有,但只在冲突后补救,且**无字段版本元数据**,靠「并集」而非「LWW」,两端改同一字段时仍不确定 |
| 会话日志并集合并 | `mergeSessionLogConflict` | 只匹配 `session\.jsonl(\.zstd)?`,**漏 `session.v3.jsonl.zstd`** → v3 会话永远掉进兜底 |
| `session_projcache/**` 取本机 | 1901–1907 | 可再生缓存,方向对,但靠「冲突后 checkout」而非「根本不进仓库」 |
| `settings.yaml`/`.credentials.yaml` 取本机 | 1912–1917 | 单边丢弃远端,破坏收敛(设置永不收敛到一致) |
| **其余 → 「双边保留 + 人工裁决」** | `materializeConflicts` + `sync_conflict_resolve` | **「二次判断」的根源** |

外加两个结构性成因:

- **可再生状态被同步上云**(`cache/`、`logs/`、`profiles/web/.dsh-market/` 不在 `BUILTIN_IGNORE`):每台机器每次运行都重写 → 每次合并必冲突(经验库第 69 条实证)。
- **DSH 会在 re-seed 时重写会话末尾 `end-seed` 的 `time`**,让内容相同的日志在字节层变成冲突(经验库第 75 条)。

---

## 3. 新架构总览

```
                        ┌──────────────────────────────────────────────┐
                        │          合并层(本次重写)                    │
  git fetch / push      │   classify(path) → 类型                      │
  (传输 + 历史)  ──────►│   merge(type, base, ours, theirs, vmap)      │
                        │   → 确定性合并结果(或对 opaque 的确定性裁决) │
                        └──────────────────────────────────────────────┘
                                    │
                        写回工作树 → git add → commit → push
```

新增独立模块 `lib/merge.js`(纯函数、可单测),`SyncEngine` 只负责「取冲突三态 blob(`:1:`/`:2:`/`:3:`)→ 调 merge.js → 写回 → add」。所有合并算法与 git 编排解耦。

### 文件分类 `classify(relPath)`

| 类型 | 判定 | 合并策略 |
| --- | --- | --- |
| `session-log` | `sessions/**/session*.jsonl` 或 `.jsonl.zstd`(**含 v3**) | G-Set 并集 CRDT |
| `crdt-json` | `storages/workspace.json`、`profiles/web/package.json` 等 | 字段级 LWW-Map CRDT |
| `crdt-yaml` | `settings.yaml`、`cordis.yml`、`cordis.patch.yml` | 解析为嵌套映射后,同 `crdt-json` |
| `crdt-meta` | `storages/sync-meta/*.vmap.json` | LWW-Map 自身合并 |
| `opaque` | 其余(工作区文件、附件、`.gitignore` 等) | 三方文本合并 + 确定性裁决 |
| `ignored` | 可再生状态(见 §7) | 根本不进仓库 |

> 工作区内容(`workspace-repos/<id>.git` 影子仓库)复用同一套分类与合并,只是把 `crdt-*`/`session-log` 之外的内容都当 `opaque`。

---

## 4. 会话日志:G-Set 并集 CRDT(追加型,天然无冲突)

会话日志是**追加型 JSONL**:两侧都是从共同基线往后追加事件。正确合并是「事件并集 + 按 `time` 排序 + 重排 `seq` + 重映射 `sourceEventSeqs`」。

改造 `mergeSessionLogConflict`:

1. **匹配规则扩到 v3**:`/^sessions\/[^/]+\/session-[0-9a-f-]{36}\/session(\.v3)?\.jsonl(\.zstd)?$/i`。
2. **解码**:`decodeZstdFrames` 已支持多帧;明文 JSONL 直接按行。
3. **去重键从「整行字符串」升级为「事件身份」**:以 `(type, seq, time, 内容哈希)` 判定同事件(而非逐字节行相等),使 `end-seed` 时间戳重写这类「同事件、字节不同」能被识别为同一事件、取其中较新的一侧。
4. **`end-seed` 归一化**:尾部 `session/end-seed` 事件的 `time` 采用两侧较新值(它是元事件,不参与内容顺序)。
5. **安全阀不变**:任何一步无法验证(格式异常 / 引用未知 seq / 无法压缩)返回 `false` 并走 §8 的确定性裁决,**绝不出 DSH 读不了的日志**。

结果:会话日志**永远自动合并**,两个机器各写各的轮次,拉取后完整交织,不需要任何人点选。

---

## 5. JSON / YAML 配置:字段级 LWW-Map CRDT

### 5.1 为什么需要「版本元数据」

「两边各改不同字段」能无脑并集;但「两边改**同一个**字段」要确定谁赢,必须知道每个字段**最后被谁、何时**改过。纯文件不携带这份信息,所以引入**版本图 sidecar**。

### 5.2 版本图格式 `storages/sync-meta/<relpath>.vmap.json`

```jsonc
{
  "format": 1,
  "path": "settings.yaml",
  "fields": {
    "ui-theme.fontSize":      { "t": 12, "actor": "e3f…" },
    "llm-deepseek.models":    { "t": 13, "actor": "e3f…" },
    "agent-default-model":    { "t": 9,  "actor": "7b1…" }
  }
}
```

- 键 = 用 `.` 连接进入嵌套结构的**叶子路径**(数组当作一个整体叶子,如 `llm-deepseek.models`)。
- `t` = Lamport 逻辑时钟;`actor` = 每台机器的稳定 UUID(存于 `.dsh-sync.state.json`,机器本地)。
- 全序:`(t, actor)` 字典序,大者赢 → **确定性、收敛**(所有机器得到同一答案)。

### 5.3 更新时机(提交时)

`commitIfDirty` 里,对每个 `crdt-json`/`crdt-yaml` 文件:

1. 取 `HEAD:<relpath>` 为 base,工作树为 new。
2. 深比较得「变更的叶子路径集合」。
3. `t = max(本机时钟, 已见远端最大 t) + 1`;对每个变更叶子写 `fields[path] = { t, actor }`(未变更叶子保留旧时间戳)。
4. 写回 vmap,再 `git add`(与文件改动进同一个 commit)。

> 关键:**即使 DSH 自己整文件重写 settings.yaml(非插件写),插件在提交时按「工作树 vs HEAD」的叶子差异打时间戳**,照样能识别「哪些字段真变了」。

### 5.4 合并算法(合并时)

对冲突的 `crdt-json`/`crdt-yaml` 文件:

1. 先合并双方 vmap(`:2:`/`:3:`):LWW-Map 并集 —— 同键取 `(t,actor)` 大者,异键并集 → 得到**合并后的版本图**。
2. 以 base、ours、theirs 为输入做**递归三路合并**:
   - **标量叶子**:两侧值相同 → 取该值;不同 → 查 vmap,取 `(t,actor)` 大的一侧;vmap 无记录(双方新增同键)→ 按 `actor` 字典序确定(收敛)。
   - **嵌套映射**:递归合并;一侧独有键 → 直接采用该侧。
   - **数组 → 按元素身份 OR-set(Observed-Remove Set)合并**(本机 settings.yaml 实测:模型/供应商列表是主体内容,整列表 LWW 会让「两机各加一个模型」互相覆盖,违背「跨机一致」):
     - 元素身份:标量元素取自身;map 元素取稳定身份键(依次尝试 `id` → `provider`+`model` → `name` → 内容哈希);取不到稳定身份的列表退化为「整列表 LWW-register」。
     - 合并 = 两侧元素按身份并集;同身份元素再递归字段合并;删除靠 vmap 里 `{t, actor, deleted:true}` 墓碑(带删除时间,防止一端删除被另一端旧值「复活」)。
     - `workspace.json` 的 `sessionIds`/`workspaceIds`/`archivedSessionIds`(字符串数组)身份即字符串本身,与现有并集行为天然一致。
3. 用「赢的一侧的键序」或「排序后的稳定序」序列化,保证同内容产出同字节(减少无谓 diff)。

### 5.5 YAML 的解析约束(零依赖决策)

插件目前**零运行时依赖**,Node 无内建 YAML。首版用**最小 YAML 子集解析/序列化器**(纯手写,~150 行):

- 支持:嵌套 `key: value` 映射、`- item` 序列、标量(字符串/数字/布尔/null)、简单引号字符串。
- 不支持(遇到即**降级为 opaque 三方文本合并**,不报错不阻塞):锚点/别名、flow 集合 `{}`/`[]`、块折叠/字面标量 `|`/`>`、多文档。

> 备选:若 settings.yaml 实际内容超出子集,可评估引入 `yaml` 包(代价是打破「零依赖」)。首版先按零依赖子集实现,并加一个「解析失败 → 降级」的日志告警。

---

## 6. CRDT 元数据文件自身的合并

`crdt-meta` 文件就是 LWW-Map:**同键取 `(t,actor)` 大者,异键并集**。这是它自己的合并规则,先于其对应配置文件合并(§5.4 步骤 1)。

---

## 7. 可再生状态:根本不进仓库

把「每台机器每次运行都重写」的目录加进 `BUILTIN_IGNORE` 并 `git rm -r --cached`(磁盘文件不动):

| 路径 | 原因 |
| --- | --- |
| `cache/` | vision-router 自基准/模型发现缓存 |
| `logs/` | vision-router / restart / plugin-update 等诊断日志 |
| `profiles/web/.dsh-market/` | 市场缓存 + 事件日志 + 停用列表(经验库第 53/69 条) |
| `**/*.log` | 通用日志 |

> 补充:`storages/session_projcache/` 有跨机价值(会话↔工作区归属),**保留同步**;其冲突从「冲突后取本机」改为 `ignored` 之外的**可再生类专门处理**——理想是让 DSH 在读到即重建的前提下可安全合并,首版先保持「取本机」语义但**前置到分类层**(不进「二次判断」路径),避免它再制造 `.dsh-conflict` 拷贝。

---

## 8. opaque 文件:三方文本合并 + 确定性裁决(零人工)

**边界声明**:字符级 CRDT 只对 CRDT 原生存储(日志 / JSON / YAML)有意义。任意二进制/文本(opaque)无法无损 CRDT —— 云文档能做到字符级合并,是因为它把内容存成了 CRDT 原生结构。opaque 文件采用:

1. **三方文本合并**:base/ours/theirs 做标准 3-way(即 git 自身已擅长的行级合并),覆盖「两边改不同区域」的绝大多数情况。
2. **同区域真冲突 → 确定性裁决**:不再「双边保留 + 人工裁决」,改为:
   - **可文本化**:取**本机侧**(ours)为活动文件,远端侧写入 `backup/<时间戳>` 分支 + 保留在 origin 历史(现有 `backupRemoteHead` 机制),提交后**自动收口,不弹窗**。
   - **二进制**:按「本机优先 + 远端入 backup 分支」同规则。
3. 裁决结果记录进 `lastOutcome`(UI 只展示「已自动合并 N 个文件」,不再展示「待裁决」)。

> 数据安全:被「裁决放弃」的一侧永远在 git 历史 / backup 分支里,可从 `git` 找回 —— 与现在 `.dsh-conflict` 拷贝等价,但**不阻塞、不排队等人工**。

---

## 9. 与 git 传输的集成点

只改「情况 4」的冲突兜底段(`sync.js` 1865–1954 与工作区 `_syncWorkspaces` 对应段),**不动** fetch / commit / push / 快进 / 推送逻辑:

1. `git merge --no-edit` 产生冲突后,取 `git diff --name-only --diff-filter=U` 得冲突路径列表。
2. 对每个路径:`classify` → 取 `:1:`/`:2:`/`:3:` blob → `merge.js` 合并 → 写回工作树 → `git add`。
3. 所有路径处理完 → `conflictMarkersRemain` 守卫 → `git commit --no-edit` → push。
4. **删除 `materializeConflicts` 的「双边保留」调用与 `sync_conflict_resolve` 的人工裁决入口**(保留 `sync_conflicts` 只读列出「已自动裁决」清单,便于审计,不用于裁决)。

`resolveConflict`/`_resolveConflict`/`outstandingConflicts` 中「待裁决」语义移除,仅保留「历史归档查询」。

---

## 10. 迁移计划(旧仓库 → 新引擎)

1. **`.dsh-conflict-<ts>` 历史拷贝一次性清理**:现有 `mainConflictCopies()`/`outstandingConflicts()` 扫出的拷贝,归类为「可再生」的直接删;「真实内容」的按 §8 规则归入 backup 分支或保留本机,`git rm` 后提交推送(经验库第 67/69/71 条同款操作)。
2. **vmap 引导**:老仓库无 vmap → 首次合并时两侧 vmap 均为空,规则退化为「不同字段并集 + 同字段按 actor 确定」——首轮即收敛,无需预生成。
3. **gitignore 补写**:`BUILTIN_IGNORE_ENSURE` 增加 §7 条目,对已跟踪的可再生文件 `git rm -r --cached`,下次同步生效(沿用现有 LEGACY 迁移机制)。
4. **兼容开关**:保留 `mode:manual`/`auto` 语义不变;`autoRestartAfterRepair`、工作区影子仓库、patches 分发**全部不动**。

---

## 11. 测试计划(全部临时目录 + `autoRepo:false`,远端用本地 bare 仓库)

沿经验库第 41 条的「真实规模副本」法,新增 `merge-engine-test.mjs`:

| 场景 | 断言 |
| --- | --- |
| 两台机器各追加会话轮次(含 v3 文件) | 合并后两侧事件完整、seq/sourceEventSeqs 有效、DSH 可读 |
| 同会话仅 `end-seed` 时间戳不同 | 自动合并,无冲突拷贝 |
| 两机改 settings.yaml **不同**字段 | 双方字段都保留(收敛) |
| 两机改 settings.yaml **同一**字段 | 按 vmap `(t,actor)` 确定性取一侧,两机结果一致 |
| 两机各新增不同工作区 + 同路径去重 | `workspace.json` 并集 + 去重,会话不落「未分组」 |
| 可再生目录(cache/logs/.dsh-market) | 不进仓库,`git check-ignore -v` 命中 |
| opaque 同区域真冲突 | 自动收口(本机活动 + 远端入 backup),**无待裁决状态** |
| 全程回归 | `outstandingConflicts()` 恒为空;`conflictMarkersRemain` 恒空 |

配套:现有 `verify.mjs` / `ws-integration-test.mjs` 全绿;`node --check` 全部 lib。

---

## 12. 实施阶段

1. **P0 基线**:临时目录集成测试,复现 §2 每类冲突(为后续回归做基准)。
2. **P1 `lib/merge.js`**:`classify` + 会话日志 G-Set 并集(v3 + end-seed 归一化)+ JSON LWW-Map + vmap 读写,纯函数单测。
3. **P2 YAML 子集解析/序列化器** + 降级路径。
4. **P3 接入 `_syncOnce` 与 `_syncWorkspaces`**:替换冲突兜底,删人工裁决入口。
5. **P4 提交时 vmap 更新 + §7 gitignore**。
6. **P5 迁移脚本**:清理 `.dsh-conflict`、gitignore 补写、`git rm --cached`。
7. **P6 端到端双机仿真集成测试**(两临时 home + 本地 bare 远端,并发编辑,断言收敛)。
8. **P7 发布**:版本 bump + 按既定 Trusted Publishing 流程发 npm + 打 tag。

---

## 13. 风险与待确认点

1. **YAML 子集是否够用**:取决于真实 `settings.yaml` 是否只用简单结构。P2 前先抓一份本机 `settings.yaml` 样例核对(见 §5.5 备选)。**→ 已核对本机 settings.yaml(纯嵌套 map + 标量 + map 列表 + 空 `[]`),零依赖子集解析器够用。**
2. **数组合并为 OR-set**:已从「整列表 LWW」升级为按元素身份 OR-set(见 §5.4),因 settings.yaml 主体是模型/供应商列表;首版可先实现标量+映射 LWW、列表 OR-set 作为同阶段第二优先(它决定「两机各加模型」能否收敛)。**→ 已实现列表 OR-set。**
3. **opaque 裁决的「本机优先」是否可接受**:这是唯一仍会「放弃一侧」的地方(但零人工、可回溯)。如你希望更保守,可改为「冲突即入 backup 分支 + 活动文件取更新 mtime 侧」。**→ 已实现「本机活动 + 远端入 backup 分支 + origin 历史」。**
4. **`storages/session_projcache/`**:首版保持「取本机」但前置到分类层,彻底根治需确认 DSH 是否真能做到「读到即重建」。**→ 已前置到分类层(opaque→取本机),不再制造冲突拷贝。**

---

## 14. 实施状态(截至 v0.12.0)

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0 | 临时目录集成测试基线(复用 verify/ws-integration/regression-v0117 等) | ✅ |
| P1 | `lib/merge.js`:classify + 会话日志 G-Set 并集(v3 + end-seed 归一化)+ JSON LWW-Map + vmap 读写 + 列表 OR-set | ✅ |
| P2 | `lib/yaml.js` 零依赖 YAML 子集解析/序列化 + 降级路径 | ✅ |
| P3 | `lib/sync.js` 接入分层合并引擎(主仓库 情况4 dispatch + 工作区 checkout --ours)+ `lib/index.js` 文案 | ✅ |
| P4 | 提交时 vmap 更新(`updateCrdtVmaps` + `actorId`)+ §7 可再生目录 gitignore | ✅ |
| P5 | 迁移:`migrateLegacyConflictCopies` 一次性清理 `.dsh-conflict`;删死代码;删 `sync_conflict_resolve` / `/api/conflict/resolve` 人工裁决入口 | ✅ |
| P6 | 端到端双机仿真:`merge-integration-test`(v3 会话并集 + settings 同字段 + 跨机收敛)+ `opaque-test` + `vmap-test` + `migration-test` | ✅ |
| P7 | 发布:版本 bump + Trusted Publishing 发 npm + 打 tag | ⏳ 待发布 |

**测试矩阵(12 项,全部 exit=0)**:verify / smoke / ws-integration / union-merge / regression-v0117 / guard-dedupe / merge-engine / yaml / merge-integration / vmap / migration / opaque。

**核心不变量(已逐项断言)**:
- `outstandingConflicts()` 恒为空(不再生成 `.dsh-conflict` 拷贝);
- `conflictMarkersRemain()` 恒空(合并绝不残留 `<<<<<<<` 标记);
- 会话日志 v3 zstd 并集:两侧事件完整、`seq`/`sourceEventSeqs` 重映射有效、end-seed 唯一;
- settings.yaml 同字段并发冲突 → `(t,actor)` 确定性取一侧,两机拉取后收敛一致;
- opaque 真冲突 → 本机活动 + 远端 `backup/<ts>` 分支,零人工。
