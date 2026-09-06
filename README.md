# dsh-sync-plugin

DeepSeek Harness 一键同步 + 会话管理插件:侧栏底部原生「⟳ 同步」按钮把你的 DSH 数据(会话、设置、插件、技能)同步到自己的 GitHub 私有仓库,多台电脑互相同步;设置面板「同步 · 会话管理」分节可以实时浏览/搜索会话、查看已归档对话、**删除会话(回收站式)**;侧栏会话「…」菜单内置「删除…」。

> v0.3 起定名 **dsh-sync-plugin**。配置文件 `~/.dsh/dsh-sync.json`、本地 git 仓库与同步历史完全兼容,旧版用户卸旧装新即可无缝升级。

## 安装(一行命令)

全新安装:

```powershell
dsh plugin --profile web add dsh-sync-plugin
```

也可以从 Git 仓库直接装(以包内 package.json 的 `name` 为准,目录/仓库名不影响):

```powershell
dsh plugin --profile web add github:dpskk2/dsh-sync-plugin
```

装完**重启 dsh**,侧栏左下出现「⟳ 同步」按钮(原生嵌入侧栏底栏,不再悬浮遮挡页面)。

> 前置:本机装好 [git](https://git-scm.com);推送/拉取 GitHub 需要 [gh CLI](https://cli.github.com) 登录(`gh auth login`)或 Git Credential Manager 授权。

## 界面在哪

- **侧栏底部「⟳ 同步」**:一键全量同步(提交 + 推送 + 拉取),结果以短暂气泡提示;侧栏收起时自动变成纯图标。
- **同步实时进度(v0.3.1)**:同步进行中,按钮文字实时变为当前阶段(取远端 / 提交 / 比对 / 拉取 / 合并 / 推送…),按钮上方有常驻进度气泡(阶段 + 已耗时),设置面板同步卡下方也有一行进度;阶段由引擎在每次 git 调用前上报,`/dsh-sync/api/progress` 每 0.5s 轮询一次。
- **设置 → 同步 · 会话管理**(视觉与原生设置一致,无框无底色):
  - 同步组:远端地址、分支、模式、上次同步结果,右侧「立即同步」胶囊按钮(点击后原地变为实时进度行);
  - **已归档对话**:标题、所属工作区、最后活动/创建时间、大小,默认按最后活动排序,可切换(创建时间 / 标题),支持搜索;**列表每 3 秒自动刷新**——侧栏刚归档的对话几秒内就会出现在这里;
  - **全部会话**:默认折叠,展开后同样可搜索、排序、删除;
  - 每行「删除」:**先调原生归档接口**(与原生「归档会话」同一入口,宿主内存登记表同步更新,**侧栏立即消失**,若删的是当前打开的会话会自动收起视图),**再把文件移入本地回收站** `~/.dsh/.trash`(可找回);同步后其他电脑同步删除。
- **侧栏会话「…」菜单**:在原生「归档会话」下方注入红色「删除…」,确认后先归档后删文件,侧栏立即更新,不再整页刷新。

## 首次配置(2 分钟)

1. 在 GitHub 建一个**私有**仓库(如 `dsh-sync`);
2. 编辑 `~/.dsh/dsh-sync.json`,填入远端地址:

```json
{ "remote": "https://github.com/你的用户名/dsh-sync.git" }
```

3. 点一下「⟳ 同步」——首次会初始化本地 git 仓库并全量推送。完成。

## 同步什么

| ✅ 同步 | ❌ 不同步 |
| --- | --- |
| 全部会话记录与附件 | **`.credentials.yaml`(API 密钥)——密钥永不上传**,换电脑重新登录即可 |
| `settings.yaml`、profile 插件配置与依赖清单(`package.json`,新电脑 `pnpm install` 装回插件)、技能、工作区状态 | `**/node_modules/`(依赖,`pnpm install` 复原) |
| | 会话投影缓存(可再生)、引擎自身临时状态(`.dsh-sync.state.json`) |

> v0.3 修正:旧版 README 写「同步 API 密钥」,与代码不符——引擎生成的 `~/.dsh/.gitignore` 一直排除 `.credentials.yaml`,**密钥从不上传**。以代码为准;因此仓库不再含密钥(私有仓库仍然推荐,但不再是安全底线)。默认排除列表在 `~/.dsh/.gitignore`(首次同步时生成,手工改动会被保留;`extraIgnore` 配置仅在首次生成时写入)。

## 多台电脑

- **换电脑 / 新电脑**:装好 git + dsh 后(**先别启动 dsh**):

  ```powershell
  git clone https://github.com/你的用户名/dsh-sync.git "$env:USERPROFILE\.dsh"
  cd "$env:USERPROFILE\.dsh\profiles\web"; pnpm install
  ```

  启动 dsh——插件、配置、会话全部就位,按钮直接可用(密钥需重新登录一次)。

- **日常**:哪台电脑用完点一下「⟳ 同步」,另一台开工前点一下,数据就接上了。
- **两台都改过**:不同文件自动合并(两边都保留);同一文件冲突时保留当前电脑版本,对方版本自动备份到远端 `backup/<时间戳>` 分支;无共同历史的新仓库并入远端时,同名文件以远端为准。

## 配置(`~/.dsh/dsh-sync.json`)

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `manual` | `manual` 纯手动(点按钮才同步);`auto` 自动(启动拉取 + 周期 + 对话结束后去抖) |
| `enabled` | `true` | 仅在 `mode=auto` 时作为总开关(手动按钮不受它限制) |
| `remote` | `''` | GitHub 私有仓库地址;留空则只做本地快照(免费版本历史) |
| `branch` | `main` | 同步分支 |
| `commitMessage` | `dsh-sync-plugin: auto snapshot` | 快照提交信息 |
| `intervalSeconds` | `300` | (auto)周期兜底 |
| `eventDebounceSeconds` | `15` | (auto)对话结束后的去抖延迟 |
| `minCommitIntervalSeconds` | `120` | (auto)提交节流;**手动触发(按钮 / 设置面板 / CLI)不受限**,点一下立刻提交 |

> v0.3 修正:旧版 README 写 `enabled` 默认 `false`、`commitMessage` 默认 `dsh-sync: snapshot`,代码实际是 `true` 与 `dsh-sync: auto snapshot`;且旧版的手动按钮其实被提交节流限制——v0.3 起手动触发一律免节流,言行一致。

## 命令行(不打开 dsh 也能同步)

```powershell
node "%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-sync-plugin\lib\cli.mjs"
```

(可选:把桌面快捷方式指向它。)

## 已知边界(如实说明)

- **删除的实现方式**:「删除」按钮 = 原生归档(`uiWorkspace.archiveSession`,宿主内存登记表同步更新,**侧栏立即消失**,与原生「归档会话」完全等效)+ 文件移入本地回收站 `~/.dsh/.trash`(可找回)+ workspace.json 清理。若删除的会话对宿主不可归档(如刚从其他电脑同步来的孤儿数据),归档一步会跳过,侧栏条目要重启 dsh 才消失。
- 会话附件(`attachments/`)是按内容寻址的共享存储,删除会话不回收附件体积。

## License

[MIT](./LICENSE) © 2026
