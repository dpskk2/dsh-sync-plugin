# 同步内容矩阵:现在同步什么 / 应该同步什么 / 还能同步什么

> 本文是 dsh-sync-plugin 的「同步内容」说明文档,回答三个问题:
> **现在同步什么、应该同步什么、DSH 更新后还能同步什么**。
> 也解释了 web_fetch 补丁的工作原理与历史上「同步后字号复位 / 技能消失 / API 配置丢失」的成因。

---

## 1. DSH home(`~/.dsh`)里都有什么

插件同步的根目录就是 DSH home(默认 `~/.dsh`,可用 `$DSH_HOME` 覆盖)。先看它由哪些内容组成:

| 路径 | 是什么 | 由谁写入 |
| --- | --- | --- |
| `sessions/` | 全部会话日志(`session.jsonl.zstd`,按工作区分组) | DSH 会话持久化 |
| `attachments/` | 会话附件(按内容寻址) | DSH 附件存储 |
| `storages/workspace.json` | 「工作区 → 会话 id」登记表 + 归档列表 | DSH 工作区/会话控制器 |
| `storages/session_projcache/` | 会话投影缓存(标题 / cwd / 创建时间) | DSH 会话投影缓存 |
| `settings.yaml` | **设置中心**:字号(`ui-theme.fontSize`)、官方模型列表(`llm-deepseek.models`)、第三方 provider 配置(`llm-pi-ai.providers`,含 `apiKeyEnv` 密钥引用)、默认模型(`agent-default-model`)、权限预设(`permission`) | DSH 设置面板 / `dsh-settings-file` |
| `.credentials.yaml` | **API 密钥库**(`CredentialRef` → 密钥 的严格映射,如 `DEEPSEEK_API_KEY`、`DING_API_KEY`) | DSH 模型页 / `dsh-credentials-local` |
| `llm-deepseek/files-v3.json` | 官方 DeepSeek 模型目录缓存 | DSH LLM 扩展 |
| `profiles/web/` | profile 配置:`package.json`(已装插件与版本)、`cordis.yml` / `cordis.patch.yml`(插件树)、`pnpm-lock.yaml` 等 | `dsh plugin` / pnpm |
| `profiles/web/node_modules/` | profile 依赖(安装后的实体) | pnpm install |
| `patches/` | 托管补丁(`web-fetch-http` 等,见 §4) | 本插件 |
| `dsh-sync.json` | 同步配置(remote / mode / branch…) | 本插件 / 用户 |
| `.gitignore` | 同步排除规则 | 本插件(首次生成,手工改动保留) |
| `.dshw-size.json` / `.dshw-usage.json` | 窗口大小 / 用量统计(每台机器各自的状态) | DSH GUI |
| `.anonymous-user-id` | 匿名用户 ID(遥测用) | DSH |
| `.dsh-sync.state.json` | 同步引擎自身状态 | 本插件 |
| `workspace-repos/` | 各工作区的影子 git 仓库(元数据) | 本插件 |
| `.trash/`、`sessions.rar` 等 | 用户手工清理的遗留物 | 用户 |

## 2. 现在同步什么(v0.11 起)

插件的规则很简单:**`~/.dsh` 下除 `.gitignore` 明确排除的条目外,全部同步**。

### ✅ 同步(默认)

- 会话、附件、`storages/`(工作区登记 + 投影缓存);
- `llm-deepseek/`(官方模型目录);
- `profiles/web/` 的**配置与锁文件**(不含 `node_modules`);
- `patches/`(托管补丁,跨机分发);
- `dsh-sync.json`(同步配置本身);
- **`settings.yaml`(v0.10 起)**——字号、模型、默认模型、第三方 provider 配置;冲突时**自动取本机**(远端版本保留在 git 历史),不会被拉取覆盖;
- 各工作区**真实文件夹内容**(经 `workspace-repos/` 影子仓库同步到远端 `ws/<工作区Id>` 分支)。

### ❌ 不同步(默认排除)

| 条目 | 为什么 |
| --- | --- |
| `**/node_modules/` | 依赖,新电脑 `pnpm install` 恢复 |
| **`.pnpm-store/`** | pnpm 依赖缓存(与 `profiles/web/` 锁文件重复),新电脑重新 install 生成 |
| `workspace-repos/` | 影子仓库元数据,引擎内部结构 |
| `.dshw-size.json` / `.dshw-usage.json` | 每台机器各自的窗口大小 / 用量统计,同步无意义 |
| `.anonymous-user-id` | 每台机器各自的匿名 ID |
| `.dsh-sync.state.json` | 引擎自身状态 |
| **`.credentials.yaml`** | **API 密钥不上云**(v0.10 曾放开同步,v0.11 重新排除)——跨机密钥走环境变量 `apiKeyEnv` 或在新机器重新登录 |
| **`storages/workspace-local-paths.json`** | **工作区「换位置」的本机专属覆盖**(v0.11.7 起排除)——否则他机会用你的路径覆盖本机工作区位置 |
| `.trash/`、`sessions.rar` 等 | 用户清理的遗留物(**默认排除见下注**) |
| **`storages/workspace-local-paths.json`** | **工作区「换位置」覆盖(v0.11.7 起排除)——A 机的工作区位置不能决定 B 机** |

> **默认排除的实际位置**:插件生成的 `BUILTIN_IGNORE`(见 `lib/sync.js`)包含机器本地状态、
> `.credentials.yaml`、`**/node_modules/`、`.pnpm-store/`、`.dsh-sync.state.json`、
> `storages/workspace-local-paths.json`、`workspace-repos/`;
> 而 `.trash/`、`sessions.rar`、`.npm-cache/`、`logs/` 的若干本地产物,是在**本机 `~/.dsh/.gitignore`**
> 里追加的(手工或历史迁移留下)。新机器克隆后,这些条目来自仓库里的 `.gitignore` 文件本身
> (`.gitignore` 是被跟踪的,会随仓库带过去),因此跨机行为一致。

> 想额外排除某个文件:在 `~/.dsh/.gitignore` 加一行即可,手工改动会被保留。

### 历史(≤0.9.x / v0.10 / v0.11)的差异

| 条目 | ≤0.9.x | v0.10 | v0.11 |
| --- | --- | --- | --- |
| `settings.yaml` | ❌ 忽略(v0.9.1 起;更早是同步的) | ✅ 同步 | ✅ 同步(冲突自动取本机) |
| `.credentials.yaml` | ❌ 忽略(一直如此) | ✅ 同步 | ❌ 重新排除(密钥不上云) |
| `.pnpm-store/` | — | ✅ 同步(v0.10 无排除) | ❌ 排除(依赖缓存) |

**为什么改(v0.11 定案)**:v0.10 把设置与密钥都放进同步范围,理由是"个人私有仓库,钥匙只在你手里"。实际使用中发现两个问题:**(a)** 两机同时改 `settings.yaml` / `.credentials.yaml` 时走「双边保留」要人工裁决,出现过"拉取覆盖本机设置"的体验问题;**（b)** 密钥跟着仓库走,仓库一旦误配 remote 或泄露,风险最高。v0.11 收敛为:设置**继续同步但冲突自动取本机**(设置随换机带过去,又不会被覆盖);密钥**重新排除不上云**(跨机走环境变量 `apiKeyEnv` 或重新登录,DSH 凭据优先级本来就是「环境变量 > `.credentials.yaml`」);依赖缓存排除。升级自动迁移:补回 `.gitignore` 排除条目(`BUILTIN_IGNORE_ENSURE`),并把已在跟踪的机器本地文件**移出索引**(`git rm --cached`,不删文件),下次同步即生效。

## 3. 还可以同步什么(DSH 演进)

插件的「全同步 + 显式排除」设计意味着:**DSH 新增的任何 home 级配置会自动进入同步范围**,无需改插件。

- **设置类新字段**(比如老版本没有字号设置,后来 `ui-theme.fontSize` 进了 `settings.yaml`)——只要写进 home 文件就自动同步;插件不需要认识每个字段。
- **新目录/新配置**(主题、MCP 配置、新 provider 的凭据等)——只要落在 `~/.dsh` 且不在 `.gitignore`,自动同步。
- **工作区内的技能(`skills/` 文件夹)**:DSH 的技能(skill)放在**工作区/项目文件夹**或 `~/.agents`(不在 `~/.dsh` 下)。工作区文件夹已由影子仓库同步,因此工作区内的技能随工作区走;`~/.agents` 目前不在同步范围(在 home 之外),若需要可作为未来特性:把 `~/.agents` 纳入工作区同步或加一个可选目录。
- **`.env` / 环境变量**:DSH 凭据优先级是「环境变量 > `.credentials.yaml` > `.env`」。`.credentials.yaml` 同步后,`.env` 里的旧密钥可能覆盖不到(优先级低于凭据库),无需处理;`.env` 在 home 之外,默认不随仓库走。

## 4. web_fetch 补丁是怎么工作的(是不是改了 .dsh 里的文件?)

**是的——补丁文件就存在 `~/.dsh` 里,并且随同步仓库跨机分发。** 分三层:

1. **补丁本体在 `.dsh/patches/web-fetch-http/`**:
   - `patch.json`——清单:目标包 `@deepseek-ai/dsh-web-fetch-http`、版本 `0.1.5-rc.2`、目标路径 `lib/index.js`、补丁标记、`enabled`;
   - `lib-index.js`——**完整的目标文件**(修复后的整份代码,含代理回退 / 瞬态重试 / 真实根因报错);
   - `original-index.js`——首次套用时自动备份的原始文件(还原用)。
   因为 `patches/` 不在 `.gitignore`,它随主仓库提交,每台机器拉到后都有同一份补丁。
   > 另有 `patches/session-format-v0-to-v1/` 与 `patches/session-format-v1-to-v2/`,同样按
   > dsh `0.1.5-rc.2` 录制,修复旧会话格式迁移时的 provenance 容错(见「补丁管理」小节)。

2. **套用动作在 `node_modules`(home 之外)**:插件启动时 / 每次同步后 / `sync_patches` 工具,调用 `lib/patches.js`:
   - 找到本机安装的 `@deepseek-ai/dsh-web-fetch-http`(npm 全局根 + profile `node_modules` + 全局 dsh 的嵌套 `node_modules`);
   - 若目标文件与 payload 一致 →「已是最新」;带旧标记 → 覆盖升级;**与 `original-*` 备份内容一致 → 上游基座未变,跨版本照常套用**(v0.11.5 起按内容比对,不锚定版本号);无备份且版本匹配 → 先备份原文件再覆盖;**内容偏离录制原始版 → 不盲写,标记 `needs-refresh`**(需基于新版重录);
   - 应用发生在 dsh 启动**之后**,当前进程加载的还是旧代码 → **重启 dsh 生效**。

3. **修复效果**:web_fetch 直连失败自动回退系统代理;瞬态网络错误自动重试一次;报错显示真实根因(而不是笼统的「连接失败」)。

> 一句话:补丁文件在 `~/.dsh/patches/`(同步),写入目标是 npm 安装目录(不随同步走)。所以「改了 .dsh 里的某个文件」这个印象对一半——补丁**来自** `.dsh` 里的文件,真正被修改的是 `node_modules` 里的内置包,且每次启动都会重新校验/套用。

## 5. 历史问题成因(你遇到过的怪现象)

| 现象 | 成因 |
| --- | --- |
| **按了同步后字号恢复默认** | `settings.yaml`(含 `ui-theme.fontSize`)在 v0.9.1 起被排除同步;目标机 DSH 启动时按默认值重建 `settings.yaml`,字号归零。v0.10 起同步 `settings.yaml`,不再出现;v0.11 起连冲突裁决都不用——设置冲突自动取本机。 |
| **skill 被删 / 技能消失** | 技能不在 `~/.dsh`(旧版本曾在 `.dsh/skills/`,现已被 DSH 移到工作区文件夹与 `~/.agents`)。工作区内的技能随工作区影子仓库同步——历史上的删除多来自旧目录(如 `.dsh/skills弃用`)的人工清理,或工作区影子仓库早期的 `reset` 边界;v0.9.2 起工作区同步只在工作树干净时才 reset,不再有静默覆盖。 |
| **官方 API / 第三方 API / 模型选择被删** | 这些配置都在 `settings.yaml`(被排除)→ 目标机只剩 `llm-deepseek/files-v3.json`(官方模型目录,一直同步),但 provider 配置与默认模型选择(也在 `settings.yaml`)丢失。v0.10 起同步 `settings.yaml`,一并解决;v0.11 起冲突自动取本机。 |
| **第三方 key 被删、模型设置还在** | `.credentials.yaml`(密钥)在 v0.10 之前从未同步 → 目标机密钥丢失;而 `settings.yaml` 在 v0.9.1 **之前**是同步的,所以较早同步的目标机「模型设置还在」但密钥不在。这是「配置同步、密钥不同步」两个版本叠加出来的中间态。v0.11 定案:设置继续同步(冲突取本机),密钥**不上云**——跨机请用环境变量 `apiKeyEnv`(凭据优先级高于 `.credentials.yaml`),或在每台机器上重新登录。 |

**v0.11 之后的目标机行为**:新机器克隆仓库后,设置 / 会话 / 工作区 / 补丁全部还原;API 密钥需在新机器重新登录一次(或配置好环境变量 `apiKeyEnv` 后无需再配)。

## 6. 相关文件

- 默认排除列表定义:`lib/sync.js` → `BUILTIN_IGNORE`(新安装)/ `LEGACY_IGNORE_REMOVALS`(旧安装迁移)/ `BUILTIN_IGNORE_ENSURE`(确保补回的排除条目:`.credentials.yaml` / `.pnpm-store/` / `storages/workspace-local-paths.json`);
- 会话日志候选名(登记自查/幽灵清理/预览/冲突预览共用一份口径):`lib/sync.js` → `SESSION_LOG_NAMES`;
- 补丁引擎:`lib/patches.js`;
- 主入口与 API:`lib/index.js`;
- 同步编排:`lib/sync.js`(`SyncEngine`)。
> 最近更新:2026-09-12(v0.11.7)—— 本文件随 v0.11.x 持续维护;托管补丁均按 dsh `0.1.5-rc.2` 录制(web-fetch-http、session-format-v0-to-v1、session-format-v1-to-v2)。
