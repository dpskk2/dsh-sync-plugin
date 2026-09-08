# dsh-sync-plugin

> 用你自己的 **GitHub 私有仓库**,在多台电脑之间**双向同步整个 DeepSeek Harness(DSH)**:
> 会话、附件、工作区、设置(字号 / 模型 / 默认模型 / 第三方 API 配置)、**API 密钥**。
> 在这台电脑按一下「⟳ 同步」,另一台电脑打开就是一模一样。

**安装(一行命令):**

```powershell
dsh plugin --profile web add dsh-sync-plugin
```

_English: Two-way sync of DSH sessions, workspace files, settings and API keys between machines via your own private GitHub repo. Installable with `dsh plugin add`._

## 为什么需要它

- 💬 **会话不丢**——换电脑 / 换系统,对话记录、附件全部带过去;
- ⚙️ **设置不丢**——字号、模型列表、默认模型、第三方 API 配置、**API 密钥**一起同步(仓库是你私有的,钥匙只在你手里);
- 📁 **工作区一起走**——每个工作区的真实文件夹内容也同步,目标机缺文件夹自动创建;
- 🛡️ **绝不丢数据**——两台电脑同时改了同一文件时「双边保留」:两边版本都留着,由你决定留哪个;
- 🗂️ **归档会话管理**——设置里可列出全部会话(含已归档 / 幽灵),展开预览、取消归档或彻底删除。

## 安装 / 升级 / 卸载

```powershell
# 安装
dsh plugin --profile web add dsh-sync-plugin

# 升级
dsh plugin --profile web update dsh-sync-plugin

# 卸载
dsh plugin --profile web remove dsh-sync-plugin
```

装完**重启 dsh**:侧栏左下角出现「⟳ 同步」按钮;「设置 → 同步」里有状态、详细结果与「立即同步」。

> 也可以从 GitHub 直接装(包名以 `package.json` 的 `name` 为准):
> `dsh plugin --profile web add github:dpskk2/dsh-sync-plugin`
>
> 前置:装好 [git](https://git-scm.com);推送 GitHub 需要 Git 凭据(`gh auth login` 或 Git Credential Manager)。

## 首次使用(2 分钟)

1. 在 GitHub 建一个**私有**仓库(如 `dsh-sync`);
2. 编辑 `~/.dsh/dsh-sync.json`,填入仓库地址:

   ```json
   { "remote": "https://github.com/你的用户名/dsh-sync.git" }
   ```

3. 点一下「⟳ 同步」——自动初始化本地仓库并全量上传。完成 🎉

> 装好 [gh CLI](https://cli.github.com) 并 `gh auth login` 后,第 1、2 步可跳过:
> 直接点「⟳ 同步」,插件会自动创建/复用私有仓库并把地址写回配置。

## 同步什么

| ✅ 会同步 | ❌ 不会同步(每台机器各自的状态) |
| --- | --- |
| 会话记录与附件(`sessions/`、`attachments/`) | 窗口大小、用量统计、匿名 ID(`.dshw-*.json`、`.anonymous-user-id`) |
| 工作区↔会话对应关系(`storages/workspace.json` + 投影缓存) | 依赖目录(`**/node_modules/`,新电脑 `pnpm install` 恢复) |
| 设置(`settings.yaml`:**字号 / 模型 / 默认模型 / 第三方 API 配置**) | 工作区影子仓库(`workspace-repos/`,引擎内部结构) |
| **API 密钥(`.credentials.yaml`)**——私有仓库,默认一起同步 | 回收站(`.trash/`)、引擎状态(`.dsh-sync.state.json`) |
| 各工作区真实文件夹内容(影子 git 仓库,同步到远端 `ws/<工作区Id>` 分支) | |
| 已装插件与版本(`profiles/web/` 配置与锁文件,不含 node_modules) | |
| node_modules 补丁(`patches/`,如 web_fetch 代理回退修复) | |

> 🔒 **隐私说明**:这是**个人私有仓库**同步工具——设置与 API 密钥默认随仓库同步(仓库私有,钥匙只在你手里)。若某个文件你不想同步,在 `~/.dsh/.gitignore` 里加一行即可(手工改动会被保留)。

## 多台电脑怎么用

- **日常**:哪台电脑用完点一下「⟳ 同步」,另一台开工前点一下,数据就接上了;
- **新电脑**:装好 git + dsh 后(**先别启动 dsh**),克隆仓库到 `~/.dsh` 再启动即可;
- **更省事**:`dsh-sync.json` 里 `mode` 改为 `auto` —— 启动拉取 + 周期同步 + 对话结束后自动提交。

## 冲突怎么办(不用怕)

两台电脑**同时改了同一个文件**时,插件不会偏向任何一方:

- 本机版本保留为活动文件,远端版本另存为 `<文件名>.dsh-conflict-<时间戳>` 拷贝——**两边都不丢**;
- 在 **设置 → 同步 → 冲突** 里可预览两侧内容并裁决:**保留本机 / 采用远端 / 两侧都留**;
- 会话日志会自动按内容合并(两边新增的对话合进同一个会话),只有少数无法安全合并的情况才需要手动裁决;
- 日常想完全避免冲突:错开使用、用完即同步。

## 常用配置(`~/.dsh/dsh-sync.json`)

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `manual` | `auto` = 自动同步(启动拉取 + 周期 + 对话结束后去抖) |
| `remote` | `''` | 私有仓库地址;留空则只做本地快照(免费版本历史) |
| `branch` | `main` | 同步分支 |
| `workspaceBase` | `''` | 所有工作区统一放到该目录下(跨机路径不一致时建议配置) |
| `proxy` | `''` | git 走代理(如 `http://127.0.0.1:7890`),直连 GitHub 慢时用 |

## web_fetch 修复是怎么工作的(补丁管理)

DSH 内置包(`@deepseek-ai/dsh-web-fetch-http`)的 bug 不能直接改 `node_modules`——依赖不随同步走,DSH 升级还会整体覆盖。插件把修复做成**随仓库同步的托管补丁**(存在 `~/.dsh/patches/web-fetch-http/`,天然入库、跨机分发),每次启动 / 同步后自动重新套用:

- web_fetch 直连失败 → 自动回退系统代理;
- 瞬态网络错误 → 自动重试;
- 报错显示真实根因。

套用后**重启 dsh 生效**(幂等,内容一致即跳过)。

## 更多文档

- [同步内容矩阵 / 历史问题成因 / DSH 更新后还能同步什么](docs/sync-content.md)
- [awesome-dsh-plugin 收录投稿(已按官方格式写好)](docs/awesome-dsh-plugin-submission.yml)

## License

[MIT](./LICENSE) © 2026