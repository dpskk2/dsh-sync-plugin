# dsh-sync-plugin

DeepSeek Harness(DSH)会话与配置同步插件:通过你自己的 GitHub 私有仓库,在多台电脑间双向同步 DSH 会话、附件、工作区、设置与补丁。

- 💬 **会话不丢**——换电脑 / 换系统,对话记录、附件全部带过去;
- ⚙️ **设置不丢**——字号、模型列表、默认模型、第三方 API 配置随仓库同步(冲突时**自动保留本机**);**API 密钥不上云**,换电脑重新登录或走环境变量 `apiKeyEnv`;
- 📁 **工作区一起走**——每个工作区的真实文件夹内容也同步,目标机缺文件夹自动创建;
- 🛡️ **绝不丢数据**——两台电脑同时改了同一文件时「双边保留」:两边版本都留着,由你决定留哪个;
- 🗂️ **归档会话管理**——设置里可列出全部会话(含已归档 / 幽灵),展开预览、取消归档或彻底删除。

**安装**
```powershell
dsh plugin --profile web add dsh-sync-plugin
```
**升级**
```powershell
dsh plugin --profile web update dsh-sync-plugin
```
**卸载**
```powershell
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

| ✅ 会同步 | ❌ 不会同步(机器本地状态 / 密钥 / 依赖) |
| --- | --- |
| 会话记录与附件(`sessions/`、`attachments/`) | 窗口大小、用量统计、匿名 ID(`.dshw-*.json`、`.anonymous-user-id`) |
| 工作区↔会话对应关系(`storages/workspace.json` + 投影缓存) | 依赖目录(`**/node_modules/`、**`.pnpm-store/`**,新电脑 `pnpm install` 恢复) |
| 设置(`settings.yaml`:**字号 / 模型 / 默认模型 / 第三方 API 配置**)——冲突时**自动取本机**,不会被远端覆盖 | **API 密钥(`.credentials.yaml`)——密钥不上云**,换电脑重新登录或走 `apiKeyEnv` 环境变量 |
| 各工作区真实文件夹内容(影子 git 仓库,同步到远端 `ws/<工作区Id>` 分支) | 工作区影子仓库(`workspace-repos/`,引擎内部结构) |
| 已装插件与版本(`profiles/web/` 配置与锁文件,不含 node_modules) | 回收站(`.trash/`)、引擎状态(`.dsh-sync.state.json`) |
| node_modules 补丁(`patches/`,如 web_fetch 代理回退修复) | **工作区路径覆盖(`storages/workspace-local-paths.json`)——每台机器各自的工作区位置** |

> 🔒 **隐私说明**:这是**个人私有仓库**同步工具——设置随仓库同步(冲突自动取本机);**API 密钥不上云**(跨机走环境变量 `apiKeyEnv` 或重新登录)。若某个文件你不想同步,在 `~/.dsh/.gitignore` 里加一行即可(手工改动会被保留)。

## 多台电脑怎么用

- **日常**:哪台电脑用完点一下「⟳ 同步」,另一台开工前点一下,数据就接上了;
- **新电脑**:装好 git + dsh 后(**先别启动 dsh**),克隆仓库到 `~/.dsh` 再启动即可;
- **更省事**:`dsh-sync.json` 里 `mode` 改为 `auto` —— 启动拉取 + 周期同步 + 对话结束后自动提交。

## 冲突怎么办(不用怕)

两台电脑**同时改了同一个文件**时,插件按类型自动处理,任一方数据都不丢:

- **会话日志**:按时间自动交错合并(两边新增的对话合进同一个会话),无法安全合并时才「双边保留」;
- **`workspace.json`(工作区登记表)**:自动**并集合并**(双方工作区与会话映射都保留);并集失败时自动取本机,不占用你的裁决;
- **`settings.yaml` / `.credentials.yaml`(设置 / 密钥)**:冲突自动**取本机**——绝不让远端覆盖你的设置或密钥;
- **其余文件**(如 `profiles/web/*` 安装清单):「双边保留」——本机版本保留为活动文件,远端版本另存为 `<文件名>.dsh-conflict-<时间戳>` 拷贝,**两边都不丢**;
- 需要你裁决的冲突出现在 **设置 → 同步 → 冲突**,点「预览两侧」显示**文本 diff**(`--- 本机 / +++ 远端拷贝`),可裁决:**保留本机 / 采用远端 / 两侧都留**;
- 日常想完全避免冲突:错开使用、用完即同步。

## 常用配置(`~/.dsh/dsh-sync.json`)

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `manual` | `auto` = 自动同步(启动拉取 + 周期 + 对话结束后去抖) |
| `enabled` | `true` | `mode=auto` 时总开关;`false` 则完全手动 |
| `remote` | `''` | 私有仓库地址;留空则只做本地快照(免费版本历史) |
| `branch` | `main` | 同步分支 |
| `intervalSeconds` | `300` | 自动模式周期(最小 30) |
| `eventDebounceSeconds` | `15` | 对话活动结束后去抖多久再同步(最小 5) |
| `minCommitIntervalSeconds` | `120` | 自动模式提交节流(手动点同步不受限) |
| `autoPullOnStart` | `true` | 自动模式启动时先拉取 |
| `autoPushOnExit` | `true` | 退出时冲刷提交并推送 |
| `commitMessage` | `dsh-sync-plugin: auto snapshot` | 快照提交信息前缀 |
| `workspaceSync` | `true` | 是否同步各工作区真实文件夹内容 |
| `workspaceBranchPrefix` | `ws` | 工作区远端分支前缀 → `ws/<工作区Id>` |
| `workspaceBase` | `''` | 所有工作区统一放到该目录下(跨机路径不一致时建议配置) |
| `workspaceExtraIgnore` | `["node_modules",".pnpm-store",".npm-cache"]` | 工作区内容额外排除的目录名(`.git` 恒排除) |
| `proxy` | `''` | git 走代理(如 `http://127.0.0.1:7890`),直连 GitHub 慢时用 |
| `patches` | `true` | 是否应用 `.dsh/patches/` 下的 node_modules 补丁 |
| `autoRepo` | `true` | `remote` 为空时用 gh 自动创建/复用私有仓库(测试请设 `false`) |
| `repoName` / `repoOwner` / `repoDescription` | `dsh-sync` / 空 / 空 | 自动建仓参数(`remote` 已配置时不生效) |
| `gitUserName` / `gitUserEmail` | `dsh-sync-plugin` / `dsh-sync-plugin@localhost` | 仓库本地提交身份 |
| `extraIgnore` | `[]` | 追加到新生成 `.gitignore` 的条目 |
| `autoRestartAfterRepair` | `false` | 同步后自查把会话补进登记表(修复「未分组」)时,**自动重启 dsh** 让新实例重建索引并加载修复版(浏览器短暂断开、刷新恢复);也可在 **设置 → 同步** 的开关直接切换 |

## 补丁管理(patches/)

DSH 内置包的本地修复(如 `web_fetch` 直连失败回退系统代理)需要改 `node_modules`,
而 `node_modules` 既不随同步仓库走、DSH 升级还会整体覆盖。插件用「补丁目录随仓库同步
+ 每台机器自动重新套用」解决这个问题。

**目录结构**(`.dsh/patches/<补丁名>/`,随主仓库提交,新机器克隆即得):

| 文件 | 作用 |
| --- | --- |
| `patch.json` | 清单:`package`(目标包名)、`target`(包内相对路径)、`payload`(补丁内容文件名)、`packageVersion`(录制时的基座版本,仅作记录)、`marker`(补丁标记字符串)、`enabled` |
| `<payload>`(如 `lib-index.js`) | **完整的目标文件内容**(修复后的整份代码) |
| `original-<basename>.js` | 首次套用时自动捕获的原始文件(还原/内容比对用) |

**套用规则**(`lib/patches.js`,启动时 / 每次同步后 / `sync_patches` 工具三处触发):

| 本机目标文件状态 | 动作 |
| --- | --- |
| 与 payload 逐字节相同 | `已是最新`,跳过(幂等) |
| 含清单里的 `marker` | 视为旧版补丁 → 覆盖升级(`已更新补丁`) |
| 与 `original-*` 逐字节相同 | 上游基座未变 → **跨版本照常套用**(不锚定版本号,DSH 升级无需重录) |
| 无备份且版本号匹配 | 首次套用:先备份 `original-<basename>.js`,再写入 payload |
| 内容偏离录制原始版 | **不盲写** → `上游已升级,补丁待重录`(需基于新版重录 payload) |

> 套用发生在 dsh 启动之后,当前进程仍加载旧代码 → **重启 dsh 生效**。
> 补丁只写 npm 安装目录(全局根 / `profiles/web/node_modules` / 全局 dsh 的嵌套 `node_modules`),不写 `~/.dsh` 里的业务文件。

## 更新记录

### v0.11.7
- **修复**:同步后自查补登记(修「未分组」)推送时调用了已删除的方法 `pushWithRetry` → 修复只落本地、推不到远端;
- **修复**:归档会话管理预览漏认 `session.v3.jsonl.zstd`(当前格式的主要会话显示「幽灵会话」);
- **修复**:`storages/workspace-local-paths.json`(「换位置」本机覆盖)被误同步上云 → 已排除,并自动把历史误跟踪的移出索引(文件保留);
- **修复**:「换位置」覆盖在冲突列表 / 冲突裁决 / 退出冲刷三处不生效(只在工作区内容同步生效);
- **性能**:登记表自查 30.5ms → 2.3ms(只解析未登记会话 + cwd 缓存);工作区影子仓库配置检查每次同步 10+ 次 git 调用 → 1 次;本地与远端同头且工作树干净时走快路径;待裁决冲突扫描加 15s 缓存;`git gc` 增加 loose 体积阈值(此前 loose 对象长期不回收);
- **新增**:每 24h 提示一次孤儿工作区影子仓库占用(不自动删);
- 文档:补全本 README 的配置字段表与补丁管理小节。

### v0.11.6
- `autoRestartAfterRepair` 开关:同步自查补登记后自动重启 dsh,让新实例重建会话索引(修复「未分组」)。

### v0.11.5
- 补丁引擎改为内容比对、不锚定版本号:DSH 升级但基座文件未变时跨版本自动套用。

## 运行本仓库的测试

```powershell
cd 同步插件
node verify.mjs                    # 语法 + 模块加载 + 冒烟 + 主仓库端到端
node ws-integration-test.mjs       # 工作区影子仓库端到端
node union-merge-test.mjs          # workspace.json 并集合并(远端登记不丢)
node guard-dedupe-test.mjs         # 冲突标记守卫 + 同路径双登记去重
node archive-batch-test.mjs        # 归档/取消归档/彻底删除
node auto-restart-test.mjs         # autoRestartAfterRepair 触发分支
node regression-v0117-test.mjs     # v0.11.7 四项缺陷的回归(隔离临时 home + 本地 bare 远端)
cd dsh-sync-plugin
node patch-version-agnostic-test.mjs   # 补丁引擎版本无关性
```

> 所有测试都在临时目录内运行,并显式 `autoRepo: false` —— 不会连到真实同步仓库。


## Git 凭据(为什么同步不再弹 git-credential-manager 窗口)

同步用 git 与 GitHub 私有仓库,HTTPS 拉取/推送需要凭据。Windows 上 Git for Windows 的默认凭据助手是 **Git Credential Manager**(GCM,即 `git-credential-manager.exe`):本机没有存过 GitHub 凭据时,git 每次 fetch/push 都会启动它弹窗;若浏览器认证后凭据没能写进 Windows 凭据管理器(常见于浏览器拦截 localhost 回调),就会出现「认证完还反复弹、获取远端状态卡住」。

v0.10.1 起插件强制 git **非交互凭据**(`GIT_TERMINAL_PROMPT=0` / `GCM_INTERACTIVE=never`):凭据缺失/过期时同步**秒级失败并给出明确指引,不再弹窗、不再反复等待**。

**推荐配置(一次搞定,之后永不弹窗):**

1. 安装 GitHub CLI:`winget install GitHub.cli`;
2. 登录:`gh auth login`(浏览器或设备码都行,令牌存在 gh 自己的配置里,不依赖 Windows 凭据管理器);
3. `~/.dsh/dsh-sync.json` 里填 `remote`(仓库地址)即可——git 会自动用 gh 的凭据。

> 注意 `.git-credentials` 是明文文件,只在你的私有机器上使用。也可改用 SSH:`remote` 填 `git@github.com:<用户名>/dsh-sync.git` 并配置 SSH 密钥,同样无弹窗。

_English: Two-way sync of DSH sessions, workspace files, settings and patches between machines via your own private GitHub repo. API keys stay machine-local (re-login or `apiKeyEnv` on each machine). Installable with `dsh plugin add`._