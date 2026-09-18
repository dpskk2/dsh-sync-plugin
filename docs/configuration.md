# 配置参考

[返回 README](../README.md) · [安装指南](getting-started.md)

设置 → 同步中可调整手动 / 自动模式、是否同步工作区文件，以及自动重启修复。其他选项位于 DSH 数据目录的 `dsh-sync.json`（默认 `~/.dsh/dsh-sync.json`）。**修改自动模式和定时参数后重启 DSH。**

配置按默认值、配置文件、插件加载参数依次覆盖；加载参数优先。此文件也会同步，适合所有机器共用的设置才放在这里。工作区「换位置」产生的路径覆盖另存本机。

## 常用选项

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `remote` | `""` | Git 仓库地址；空值时可能触发自动建仓 |
| `branch` | `"main"` | 主数据分支，两台电脑保持一致 |
| `mode` | `"manual"` | `manual` 手动；`auto` 自动；改动后重启 |
| `enabled` | `true` | 是否启用自动模式调度；不等同于卸载插件 |
| `workspaceSync` | `true` | 同步工作区真实文件；关闭不删除已上传文件 |
| `intervalSeconds` | `300` | 自动同步周期，实际至少 30 秒 |
| `proxy` | `""` | Git 代理，如 `http://127.0.0.1:7890`；不是 DSH 全局网络代理 |
| `autoRepo` | `true` | `remote` 空时尝试通过 `gh` 创建 / 复用仓库；只做本地快照需设为 `false` |
| `autoRestartAfterRepair` | `false` | 补登记会话后尝试自动重启 DSH；依赖本机重启环境，浏览器会短暂断开 |
| `workspaceBase` | `""` | 工作区统一落盘目录；配置会同步，两台机器路径不同时优先用「换位置」 |

只同步会话与设置，不同步项目文件：

```json
{
  "workspaceSync": false
}
```

只做本地快照，不尝试连接仓库（已有远端配置时也需将 `remote` 清空）：

```json
{
  "remote": "",
  "autoRepo": false,
  "mode": "manual"
}
```

示例只列需要改的字段，请合并进已有文件，避免覆盖其他设置。

## 其他选项

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `eventDebounceSeconds` | `15` | 自动模式响应会话事件的延迟，实际至少 5 秒 |
| `minCommitIntervalSeconds` | `120` | 自动提交节流；手动按钮可强制提交 |
| `autoPullOnStart` | `true` | 自动模式启动时触发同步 |
| `autoPushOnExit` | `true` | 自动模式正常退出时尝试提交与推送；强制结束进程不保证执行 |
| `commitMessage` | `"dsh-sync-plugin: auto snapshot"` | 快照提交消息 |
| `gitUserName` | `"dsh-sync-plugin"` | 同步仓库的 Git 提交名 |
| `gitUserEmail` | `"dsh-sync-plugin@localhost"` | Git 提交邮箱，不用于登录 |
| `repoName` | `"dsh-sync"` | 自动建仓 / 复用的仓库名 |
| `repoOwner` | `""` | 自动建仓账号，空值取 `gh` 登录账号 |
| `repoDescription` | `""` | 自动新建仓库时的描述 |
| `workspaceBranchPrefix` | `"ws"` | 工作区分支前缀；已有同步数据时不建议改动 |
| `extraIgnore` | `[]` | 首次生成主数据 `.gitignore` 时追加的规则；已有文件请直接编辑 `.gitignore` |
| `workspaceExtraIgnore` | `["node_modules", ".pnpm-store", ".npm-cache"]` | 工作区额外排除规则；自定义数组会替换默认值，请保留仍需要的条目 |
| `patches` | `true` | 是否应用数据目录 `patches/` 中的托管补丁 |

## 补丁管理

这是高级功能。插件提供补丁应用机制，**安装插件本身不代表附带某个 DSH 修复补丁**。

补丁放在 `<DSH_HOME>/patches/<补丁名>/`，由 `patch.json` 和完整的目标文件内容组成。清单字段包括 `package`（目标包）、`target`（包内相对路径）、`payload`（补丁文件）、`packageVersion`（录制版本）、`marker`（补丁标记）、`enabled`。

引擎在启动及同步后检查内容：已一致则跳过，与原始备份一致时可重新应用；上游文件已经变化时可能提示重新录制。补丁修改本机安装目录，通常重启 DSH 后生效。仅使用自己信任的补丁。

实现见 [lib/patches.js](../lib/patches.js)；隔离验证运行 `node patch-version-agnostic-test.mjs`。
