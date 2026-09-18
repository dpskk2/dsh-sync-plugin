# 同步内容与合并边界

[返回 README](../README.md) · [配置参考](configuration.md)

本文按当前源码的默认行为说明。旧版设计过程见 [合并引擎历史设计](https://github.com/dpskk2/dsh-sync-plugin/blob/main/docs/merge-engine-refactor.md)，不应拿历史草案当作现行功能保证。

## 两类数据

**主数据：**以 DSH 数据目录为根（默认 `~/.dsh`，可由 `DSH_HOME` 指定），除排除项外整体进入主分支，默认 `main`。

**工作区文件：**从工作区登记表获取真实项目目录，使用独立的影子 Git 仓库传输到 `ws/<工作区 ID>` 分支。默认开启，可用 `workspaceSync: false` 关闭。项目自身的 Git 历史不作为同步数据上传；嵌套仓库等排除行为以引擎规则为准。

## 主数据默认范围

| 路径 / 内容 | 行为 |
| --- | --- |
| `sessions/`、`attachments/` | 同步会话与附件 |
| `storages/workspace.json` | 同步工作区登记和会话归属 |
| `storages/session_projcache/` | 目录当前会同步；不要与排除的同名单个 `.json` 文件混淆 |
| `settings.yaml` | 同步模型、界面等配置；支持的配置内容按字段合并 |
| `profiles/web/` 配置与锁文件 | 同步，但排除依赖和插件市场本地状态 |
| `patches/` | 同步用户提供的补丁，应用行为见[补丁管理](configuration.md#补丁管理) |
| `dsh-sync.json`、`.gitignore` | 同步；其中的代理等设置也可能影响另一台机器 |
| `.credentials.yaml` | 排除专用凭据文件 |
| `**/node_modules/`、`.pnpm-store/` | 排除依赖与缓存 |
| `cache/`、`logs/`、`**/*.log`、`profiles/web/.dsh-market/` | 排除可再生状态 |
| `.anonymous-user-id`、`.dshw-size.json`、`.dshw-usage.json` | 排除机器本地标识与窗口 / 用量状态 |
| `.dsh-sync.state.json`、`workspace-repos/` | 排除同步引擎的本地状态与影子仓库 |
| `storages/workspace-local-paths.json` | 排除「换位置」产生的本机路径覆盖 |
| `storages/session_projcache.json` | 排除该单个文件，目录仍同步 |

`.trash/`、`sessions.rar` 等**不在当前内置默认排除表中**，是否同步取决于自己的 `.gitignore`。工作区内的技能可随项目文件同步；位于 DSH 数据目录和工作区之外的全局技能目录不会自动纳入。

## 排除不想上传的内容

- 主数据：首次同步前编辑 `<DSH_HOME>/.gitignore`。`extraIgnore` 只在首次生成这个文件时追加规则，已有文件请直接编辑。
- 工作区：使用项目 `.gitignore` 和 `workspaceExtraIgnore`。自定义 `workspaceExtraIgnore` 会替换默认数组，需保留仍需要的依赖排除项。
- 已经被 Git 跟踪的文件：新增忽略规则本身不等于停止跟踪，更不会清除远端历史；需单独处理 Git 索引及历史。

插件不会识别所有凭据。写在会话、附件、`.env`、URL、普通配置里的密钥仍可能同步。仓库私有也不等于内容经过端到端加密。若曾上传密钥，先撤销或更换密钥，再处理仓库历史。

## 合并与恢复边界

| 数据类型 | 当前处理方式 | 需要理解的边界 |
| --- | --- | --- |
| 支持的会话日志 | 尝试解码、合并记录、重排事件 | 依赖支持的格式和运行时解压能力，不是多人实时协作 |
| 工作区登记表 | 合并登记与会话归属，并执行修复 / 去重 | DSH 内存索引可能需要重启后更新 |
| 支持的 JSON / YAML 配置 | 按字段及版本元数据合并 | 同一字段冲突选出一个值；YAML 解析器仅支持子集 |
| 普通文件与不支持的格式 | Git 合并可处理时合并；未解决冲突通常取本机 | 这是本机优先策略，不能保证双方的内容都出现在当前文件里 |

存在共同历史的分叉合并会尝试创建远端历史备份分支 `backup/<时间戳>`，但备份操作也可能失败。没有共同历史的初始化合并走单独处理路径，不保证产生同样的备份。**是否可恢复，应检查实际同步结果、备份分支和 Git 历史，而非依赖“零丢失”的宣传。**

需要恢复时，先停止自动同步并另存当前文件，在仓库的可用备份分支或历史提交中确认目标文件，再选择性恢复。不熟悉 Git 的情况下，可先提交脱敏的问题描述寻求帮助，避免直接重置整个数据目录。

同步也会传播删除和错误修改，不替代独立备份。重要资料应保留单独副本。

## 实现参考

- [lib/sync.js](../lib/sync.js)：`DEFAULT_CONFIG`、`BUILTIN_IGNORE`、工作区传输与合并编排。
- [lib/merge.js](../lib/merge.js)：日志与字段合并。
- [lib/patches.js](../lib/patches.js)：补丁应用。
