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

## 2. 现在同步什么(v0.10 起)

插件的规则很简单:**`~/.dsh` 下除 `.gitignore` 明确排除的条目外,全部同步**。

### ✅ 同步(默认)

- 会话、附件、`storages/`(工作区登记 + 投影缓存);
- `llm-deepseek/`(官方模型目录);
- `profiles/web/` 的**配置与锁文件**(不含 `node_modules`);
- `patches/`(托管补丁,跨机分发);
- `dsh-sync.json`(同步配置本身);
- **`settings.yaml`(v0.10 起)**——字号、模型、默认模型、第三方 provider 配置;
- **`.credentials.yaml`(v0.10 起)**——API 密钥;
- 各工作区**真实文件夹内容**(经 `workspace-repos/` 影子仓库同步到远端 `ws/<工作区Id>` 分支)。

### ❌ 不同步(默认排除)

| 条目 | 为什么 |
| --- | --- |
| `**/node_modules/` | 依赖,新电脑 `pnpm install` 恢复 |
| `workspace-repos/` | 影子仓库元数据,引擎内部结构 |
| `.dshw-size.json` / `.dshw-usage.json` | 每台机器各自的窗口大小 / 用量统计,同步无意义 |
| `.anonymous-user-id` | 每台机器各自的匿名 ID |
| `.dsh-sync.state.json` | 引擎自身状态 |
| `.trash/`、`sessions.rar` 等 | 用户清理的遗留物 |

> 想额外排除某个文件(比如真的不想同步密钥):在 `~/.dsh/.gitignore` 加一行即可,手工改动会被保留。

### 历史(≤0.9.x)与 v0.10 的差异

| 条目 | ≤0.9.x | v0.10 |
| --- | --- | --- |
| `settings.yaml` | ❌ 忽略(v0.9.1 起;更早是同步的) | ✅ 同步 |
| `.credentials.yaml` | ❌ 忽略(一直如此) | ✅ 同步 |

**为什么改**:这是**个人私有仓库**同步工具——远端仓库由你自己创建、只有你自己能访问。把设置和密钥排除掉,换电脑就得重设字号、重配 provider、重登密钥,还出现过「拉取把本机配置覆盖掉」的体验问题。既然仓库私有,密钥跟着走反而最省事。升级后插件会自动清理旧 `.gitignore` 里这两条(迁移逻辑在 `lib/sync.js` 的 `ensureRepo`),下次点「⟳ 同步」就把设置与密钥带上。

## 3. 还可以同步什么(DSH 演进)

插件的「全同步 + 显式排除」设计意味着:**DSH 新增的任何 home 级配置会自动进入同步范围**,无需改插件。

- **设置类新字段**(比如老版本没有字号设置,后来 `ui-theme.fontSize` 进了 `settings.yaml`)——只要写进 home 文件就自动同步;插件不需要认识每个字段。
- **新目录/新配置**(主题、MCP 配置、新 provider 的凭据等)——只要落在 `~/.dsh` 且不在 `.gitignore`,自动同步。
- **工作区内的技能(`skills/` 文件夹)**:DSH 的技能(skill)放在**工作区/项目文件夹**或 `~/.agents`(不在 `~/.dsh` 下)。工作区文件夹已由影子仓库同步,因此工作区内的技能随工作区走;`~/.agents` 目前不在同步范围(在 home 之外),若需要可作为未来特性:把 `~/.agents` 纳入工作区同步或加一个可选目录。
- **`.env` / 环境变量**:DSH 凭据优先级是「环境变量 > `.credentials.yaml` > `.env`」。`.credentials.yaml` 同步后,`.env` 里的旧密钥可能覆盖不到(优先级低于凭据库),无需处理;`.env` 在 home 之外,默认不随仓库走。

## 4. web_fetch 补丁是怎么工作的(是不是改了 .dsh 里的文件?)

**是的——补丁文件就存在 `~/.dsh` 里,并且随同步仓库跨机分发。** 分三层:

1. **补丁本体在 `.dsh/patches/web-fetch-http/`**:
   - `patch.json`——清单:目标包 `@deepseek-ai/dsh-web-fetch-http`、版本 `0.1.2-rc.1`、目标路径 `lib/index.js`、补丁标记、`enabled`;
   - `lib-index.js`——**完整的目标文件**(修复后的整份代码,含代理回退 / 瞬态重试 / 真实根因报错);
   - `original-index.js`——首次套用时自动备份的原始文件(还原用)。
   因为 `patches/` 不在 `.gitignore`,它随主仓库提交,每台机器拉到后都有同一份补丁。

2. **套用动作在 `node_modules`(home 之外)**:插件启动时 / 每次同步后 / `sync_patches` 工具,调用 `lib/patches.js`:
   - 找到本机安装的 `@deepseek-ai/dsh-web-fetch-http`(npm 全局根 + profile `node_modules`);
   - 若目标文件与 payload 一致 →「已是最新」;带旧标记 → 覆盖升级;是原始版且包版本匹配 → 先备份原文件再覆盖;**包版本不匹配(DSH 升级过)→ 不盲写,标记 `needs-refresh`**;
   - 应用发生在 dsh 启动**之后**,当前进程加载的还是旧代码 → **重启 dsh 生效**。

3. **修复效果**:web_fetch 直连失败自动回退系统代理;瞬态网络错误自动重试一次;报错显示真实根因(而不是笼统的「连接失败」)。

> 一句话:补丁文件在 `~/.dsh/patches/`(同步),写入目标是 npm 安装目录(不随同步走)。所以「改了 .dsh 里的某个文件」这个印象对一半——补丁**来自** `.dsh` 里的文件,真正被修改的是 `node_modules` 里的内置包,且每次启动都会重新校验/套用。

## 5. 历史问题成因(你遇到过的怪现象)

| 现象 | 成因 |
| --- | --- |
| **按了同步后字号恢复默认** | `settings.yaml`(含 `ui-theme.fontSize`)在 v0.9.1 起被排除同步;目标机 DSH 启动时按默认值重建 `settings.yaml`,字号归零。v0.10 起同步 `settings.yaml`,不再出现。 |
| **skill 被删 / 技能消失** | 技能不在 `~/.dsh`(旧版本曾在 `.dsh/skills/`,现已被 DSH 移到工作区文件夹与 `~/.agents`)。工作区内的技能随工作区影子仓库同步——历史上的删除多来自旧目录(如 `.dsh/skills弃用`)的人工清理,或工作区影子仓库早期的 `reset` 边界;v0.9.2 起工作区同步只在工作树干净时才 reset,不再有静默覆盖。 |
| **官方 API / 第三方 API / 模型选择被删** | 这些配置都在 `settings.yaml`(被排除)→ 目标机只剩 `llm-deepseek/files-v3.json`(官方模型目录,一直同步),但 provider 配置与默认模型选择(也在 `settings.yaml`)丢失。v0.10 起同步 `settings.yaml`,一并解决。 |
| **第三方 key 被删、模型设置还在** | `.credentials.yaml`(密钥)从未同步 → 目标机密钥丢失;而 `settings.yaml` 在 v0.9.1 **之前**是同步的,所以较早同步的目标机「模型设置还在」但密钥不在。这是「配置同步、密钥不同步」两个版本叠加出来的中间态。v0.10 起两者都同步。 |

**v0.10 之后的目标机行为**:新机器克隆仓库后,`settings.yaml` 与 `.credentials.yaml` 直接就位,字号 / 模型 / provider / 密钥全部还原,不再需要重新配置。

## 6. 相关文件

- 默认排除列表定义:`lib/sync.js` → `BUILTIN_IGNORE`(新安装)/ `LEGACY_IGNORE_REMOVALS`(旧安装迁移);
- 补丁引擎:`lib/patches.js`;
- 主入口与 API:`lib/index.js`;
- 同步编排:`lib/sync.js`(`SyncEngine`)。