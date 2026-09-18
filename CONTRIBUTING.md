# 开发与验证

需要 Node.js（建议 24）和 Git。项目采用原生 ESM，无运行时 npm 依赖，无需构建。

```sh
git clone https://github.com/dpskk2/dsh-sync-plugin.git
cd dsh-sync-plugin
npm test
npm pack --dry-run
```

`npm test` 验证设置偏好的加载 / 保存 / 失败交互，以及补丁应用的内容比对行为。界面测试使用隔离的宿主与 React 钩子替身，不连接真实 DSH、GitHub 或用户数据；它不能替代真实 DSH 的挂载与双机验收。

历史同步引擎回归脚本目前部分位于作者的仓库外工作目录，不包含在普通 clone 中，不能宣称完整引擎测试已在仓库 CI 覆盖。后续应将这些测试移入仓库并移除机器路径依赖。

修改文案或功能时，保持中文 README、英文 README、配置参考与实际默认值一致；变更同步行为需在临时数据目录及本地测试远端验证，显式设置 `autoRepo: false`，避免访问真实同步仓库。

发布前至少在两台测试环境完成：A 上传 → B 取回 → B 新增 → A 取回；同时检查工作区、凭据排除、故障提示和重启后的模式。平台与 DSH 版本只记录实际验证过的组合。
