# dsh-sync-plugin

给 DeepSeek Harness 带来变成「云文档」的同步体验

---

## 安装

```powershell
dsh plugin --profile web add dsh-sync-plugin
```

装完**重启 dsh**：侧栏左下角出现「⟳ 同步」按钮；「设置 → 同步」里有状态、详细结果与「立即同步」。

升级 / 卸载：

```powershell
dsh plugin --profile web update dsh-sync-plugin   # 升级
```
```powershell
dsh plugin --profile web remove dsh-sync-plugin   # 卸载
```

> 前置：装好 [git](https://git-scm.com)；推送 GitHub 需要凭据（推荐 [gh CLI](https://cli.github.com) 登录，永不弹窗，见文末「Git 凭据」）。

## 首次使用（2 分钟）

1. 在 GitHub 建一个**私有**仓库（如 `dsh-sync`）；
2. 编辑 `~/.dsh/dsh-sync.json`：

   ```json
   { "remote": "https://github.com/你的用户名/dsh-sync.git" }
   ```

3. 点「⟳ 同步」— 自动初始化本地仓库并全量上传。完成 🎉

> 装好 gh 并 `gh auth login` 后，第 1、2 步可跳过：直接点同步，插件自动创建/复用私有仓库并写回配置。

## 同步什么

| ✅ 会同步 | ❌ 不会同步 |
| --- | --- |
| 会话记录与附件（`sessions/`、`attachments/`） | 窗口大小、用量统计、匿名 ID |
| 工作区 ↔ 会话对应关系（`workspace.json`） | 依赖目录（`node_modules/`、`.pnpm-store/`） |
| 设置（`settings.yaml`：字号 / 模型 / 默认模型 / 第三方 API） | **API 密钥（`.credentials.yaml`）— 不上云** |
| 各工作区真实文件夹内容（→ 远端 `ws/<工作区Id>` 分支） | 回收站、引擎本地状态、**工作区路径覆盖** |
| 已装插件清单、node_modules 补丁（`patches/`） | 各机器各自的工作区位置 |

> 🔒 **隐私**：纯个人私有仓库；不想同步的文件在 `~/.dsh/.gitignore` 加一行即可。

## 冲突自动合并，零人工裁决

两台电脑**同时改了同一处**也不怕 —— 按文件类型分层自动合并，任何一方的数据都不丢，也**不会残留冲突标记**：

| 文件类型 | 合并方式 |
| --- | --- |
| 会话日志 | **CRDT 并集**：两边新增的消息合进同一会话，按时间序排好 |
| `workspace.json`（工作区登记表） | **并集合并 + 同路径去重**：双方工作区与会话映射都保留 |
| `settings.yaml` / JSON 配置 | **字段级 CRDT**：两边改不同字段都保留；改同一字段按时钟决出确定性赢家 |
| 补丁元数据（`.vmap.json`） | **并集合并** |
| 其余文件（opaque） | **确定性取本机**，远端版本另存 `backup/<时间戳>` 分支（不丢） |
| 可再生文件（cache/logs） | 不追踪、不同步 |
| `.credentials.yaml`（API 密钥） | **永不合并、永远本机**（且根本不上云） |

**无需「保留本机 / 采用远端 / 两侧都留」这类人工裁决** —— 合并由引擎自动完成，冲突列表只作只读审计展示。

## 实现方式

- **传输层**：纯 git。你自己的私有仓库做主数据（会话/设置/登记表），各工作区内容推到 `ws/<工作区Id>` 分支；凭据强制非交互（不弹 GCM 窗口），有 gh 时自动用 gh 凭据。
- **合并层**：内置分层合并引擎（`lib/merge.js`），先按文件类型分类，再走对应合并器——会话日志用 G-Set 并集，配置用 **LWW-Map + vmap 边车**（`storages/sync-meta/<文件>.vmap.json` 记录每个字段的 Lamport 时钟 `{t, actor}` 做字段级三路合并）。
- **一致性**：靠「并集/字段级合并 + 确定性裁决」让两台机器**收敛到同一结果**，而不是「后提交覆盖先提交」。
- **自愈**：同步后自动把新会话补进工作区登记表（修「未分组」），并可配置**自动重启 dsh 重建索引**让侧栏立即归位。
- **零依赖**：纯 ESM，无运行时依赖；自带一个手写 YAML 子集解析器做字段级合并。

> 想深入看合并引擎的取舍与边界：见 [docs/merge-engine-refactor.md](docs/merge-engine-refactor.md)。

## 常用配置（`~/.dsh/dsh-sync.json`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `manual` | `auto` = 启动拉取 + 周期同步 + 对话结束后去抖提交 |
| `remote` | `''` | 私有仓库地址；留空则只做本地快照 |
| `workspaceSync` | `true` | 是否同步各工作区真实文件夹内容 |
| `autoRestartAfterRepair` | `false` | 同步补登记会话后**自动重启 dsh**（消除「未分组」，浏览器短暂断开） |
| `intervalSeconds` | `300` | 自动模式周期 |
| `proxy` | `''` | git 走代理（如 `http://127.0.0.1:7890`） |
| `workspaceBase` | `''` | 所有工作区统一放到该目录下（跨机路径不一致时建议配置） |
| `patches` | `true` | 是否套用 `.dsh/patches/` 下的 node_modules 补丁 |
| `extraIgnore` | `[]` | 追加到 `.gitignore` 的条目 |

> 这里只列常用项；其余字段（提交身份、自动建仓参数等）默认即可。同步内容的完整矩阵见 [docs/sync-content.md](docs/sync-content.md)。

## 补丁管理（patches/）

DSH 内置包（如 `web_fetch`）的本地修复需要改 `node_modules`，但它不随仓库走、DSH 升级还会覆盖。插件把补丁目录随仓库同步，并在每台机器上**按内容比对自动重新套用**（不锚定版本号，DSH 升级但基座文件未变时跨版本照常套用；基座已变则不盲写，提示重录）。

## Git 凭据（为什么不弹窗）

插件强制 git 非交互凭据（`GIT_TERMINAL_PROMPT=0`），凭据缺失时秒级失败并给指引，绝不卡在弹窗。**一次配置、永不再弹：**

```powershell
winget install GitHub.cli
gh auth login            # 令牌存 gh 配置里，不依赖 Windows 凭据管理器
```

也可用 SSH：`remote` 填 `git@github.com:<用户名>/dsh-sync.git`。

## 更新记录

- **v0.12.2**：重建索引触发覆盖「同步前补登记」的场景 —— 新会话归位后必然重启，彻底消除「同步后出现未分组」。
- **v0.12.1**：根治「未分组」——修复登记表三处缺陷（归档会话不再被塞回工作区、清理历史双登记、拉取到新会话即触发重建索引）。
- **v0.12.0**：**分层合并引擎替换 git 冲突兜底** —— 会话日志 CRDT 并集、配置字段级 CRDT、opaque 确定性取本机 + 备份分支，**零人工裁决、跨机收敛**。

## 测试

```powershell
cd 同步插件
node verify.mjs                  # 语法 + 模块加载 + 冒烟 + 主仓库端到端
node merge-engine-test.mjs       # 分层合并引擎
node merge-integration-test.mjs  # 双机收敛
node ungrouped-fix-test.mjs      # 未分组修复回归
# …其余 13 项测试，见仓库根目录 *.test.mjs / *-test.mjs
```

> 所有测试都在临时目录内运行并显式 `autoRepo: false` —— 不会连到真实同步仓库。

---

_English: Two-way sync of DSH sessions, workspace files, settings and patches between machines via your own private GitHub repo — with automatic conflict merging (CRDT) and cross-machine convergence. API keys stay machine-local._
