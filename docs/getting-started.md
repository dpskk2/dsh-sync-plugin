# 安装、换机与排障

[返回 README](../README.md) · [配置参考](configuration.md)

## 环境准备

插件界面用于 DSH 的 `web` profile。请先确认 DSH Web 能正常打开。包声明 Node.js ≥ 20，但压缩会话的解析和合并还依赖运行时的 Zstandard 支持；建议使用 Node.js 24。其他 DSH 版本和跨操作系统路径组合尚无完整兼容矩阵，不宣称全平台已验证。

安装 [Git](https://git-scm.com/downloads) 和 [GitHub CLI](https://cli.github.com/)。Windows 可使用：

```powershell
winget install --id Git.Git -e
winget install --id GitHub.cli -e
```

安装后重新打开终端，并重启 DSH，让新进程读到更新后的 PATH：

```sh
git --version
gh --version
gh auth login
gh auth status
dsh plugin --profile web add dsh-sync-plugin
```

`gh auth login` 选择 GitHub.com、HTTPS，按提示完成浏览器登录。然后重启 DSH，在设置 → 同步查看状态。

## 第一台电脑

1. 检查要上传的[同步范围](sync-content.md)。只需要会话与设置时，先关闭「同步工作区文件」。
2. 默认自动建仓使用登录账号下的 `dsh-sync`。已有同名仓库时，先确认用途与私有可见性；插件当前会复用已有仓库，不能把“自动建私有仓库”理解为“自动保证已有仓库是私有的”。
3. 点「⟳ 同步」。插件尝试创建或复用仓库，成功后把地址写入配置。
4. 确认设置页显示仓库地址、同步成功，且工作区没有失败。首次上传时间取决于数据量和网络，不保证两分钟内完成。

自动建仓失败时会退回本地快照。**本地快照成功不等于上传成功。**登录或网络问题修复后再试；自动建仓尝试之间至少间隔约 60 秒。

## 手动连接仓库

适用于自定义仓库、SSH、其他 Git 服务，或不安装 `gh` 的情况。请先创建一个私有仓库（新建时可不添加 README、许可证或 `.gitignore`），并配置可用的 Git 凭据。

配置文件是 DSH 数据目录里的 `dsh-sync.json`：

| 环境 | 默认路径 |
| --- | --- |
| Windows | `%USERPROFILE%\.dsh\dsh-sync.json`，通常为 `C:\Users\你的用户名\.dsh\dsh-sync.json` |
| macOS / Linux | `~/.dsh/dsh-sync.json` |
| 自定义数据目录 | `$DSH_HOME/dsh-sync.json` |

文件不存在时创建；已有配置时只合并需要的字段，保留其他设置：

```json
{
  "remote": "https://github.com/你的用户名/dsh-sync.git",
  "autoRepo": false,
  "mode": "manual"
}
```

SSH 地址示例：`git@github.com:你的用户名/dsh-sync.git`。需先自行配置 SSH 密钥与主机信任。不要把访问令牌写进仓库 URL；同步配置本身也在同步范围内。

保存并重启 DSH，再点同步。两台电脑的 `remote` 和 `branch` 必须一致。手工指定地址时，插件不验证仓库是否私有。

## 第二台电脑

1. 安装相同的工具和插件，在该机器上登录 GitHub。登录必须在运行 DSH 的同一系统用户下完成。
2. 第一台使用默认仓库时，同账号可自动复用；使用自定义仓库时，按上节填写完全相同的地址与分支。
3. 点同步并检查结果，完成后重启 DSH。
4. 单独配置 API 密钥。已同步的模型配置只是配置，不代表凭据也已配置。
5. 按需重新安装所需插件及项目依赖。插件同步清单和锁文件，不传输 `node_modules`。
6. 同步结果出现「本机新创建的工作区」时，检查路径，必要时点「换位置」。跨系统、不同盘符等场景尤其需要确认。

已有本地会话的第二台电脑会参与双向合并，并非只下载。重要资料建议先另存副本。

## 常见问题

| 现象 | 下一步 |
| --- | --- |
| 安装后没有按钮 | 确认安装到 `web` profile；重启 DSH 并刷新浏览器；检查启动日志中插件是否加载 |
| 未检测到 Git | 在 DSH 所用的系统用户下运行 `git --version`；安装后重启 DSH，刷新 PATH |
| 显示“本地快照”，没有仓库地址 | 执行 `gh auth status`；检查同名仓库；约 60 秒后重试，或手动填写 `remote` |
| 认证失败 | 在同一系统用户下重新运行 `gh auth login`；自定义 Git / SSH 地址检查对应凭据。插件采用非交互 Git，不会替你弹登录窗口 |
| 网络超时 / 无法连接 GitHub | 检查网络；需要代理时在配置里设置 `proxy`，见[配置参考](configuration.md) |
| A 有会话，B 看不到 | 先 A 同步，再 B 同步；核对仓库与分支；检查工作区错误；重启 B 的 DSH 加载索引 |
| 会话在“未分组”里 | 同步后重启 DSH；自动重启修复是高级选项，依赖本机环境，不能保证所有环境可用 |
| 切换自动模式后没自动同步 | 保存后重启 DSH；定时器按启动时配置注册，默认间隔 300 秒；确认 `enabled` 没设为 `false` |
| 新电脑模型无法使用 / 插件缺失 | 重新配置该机器的 API 密钥，安装插件或项目依赖；配置同步不等于依赖安装 |
| 工作区文件太多 / 不想上传代码 | 首次同步前关闭「同步工作区文件」，或设置工作区排除规则；关闭不会删除远端已有分支 |

仍未解决时，[提交问题](https://github.com/dpskk2/dsh-sync-plugin/issues/new/choose)，附插件版本、DSH / Node.js 版本、系统、复现步骤和脱敏后的错误。不要贴完整会话、凭据、私有仓库内容或带令牌的 URL。
