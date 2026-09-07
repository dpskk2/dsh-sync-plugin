/**
 * dsh-sync-plugin 补丁管理 —— 把 <home>/patches/<补丁名>/ 下的 node_modules 补丁
 * 应用到本机 DSH 安装。
 *
 * 动机:web_fetch 的代理回退补丁直接改在 DSH 内置包
 * (@deepseek-ai/dsh-web-fetch-http)里,而 node_modules 不随同步仓库走
 * (.gitignore 排除 node_modules 目录),DSH 升级还会整体覆盖 —— 补丁会丢。
 * 本模块让补丁文件本身随主仓库同步(patches/ 在 .dsh 下,天然入库),
 * 每台机器启动/同步后自动重新套用:
 *
 *  - 目标内容 === payload            → 跳过(幂等,已是当前补丁);
 *  - 目标带补丁标记(marker)         → 视为旧版补丁,用当前 payload 覆盖(补丁升级);
 *  - 目标是原始版且包版本匹配        → 首次套用前先原样备份到补丁目录
 *                                      (original-*.js,还原用),再打补丁;
 *  - 目标包版本与补丁声明版本不符    → 不盲写,标记 needs-refresh(上游升级了,
 *                                      需要基于新版重新录制 payload)。
 *
 * 应用发生在 dsh 启动之后,当前进程加载的仍是旧代码 → 重启 dsh 生效。
 *
 * 补丁目录约定:
 *   patches/<name>/patch.json            清单(字段见 README「补丁管理」)
 *   patches/<name>/<payload>             补丁内容(payload,完整目标文件)
 *   patches/<name>/original-<basename>   首次套用时自动捕获的原始文件(还原用)
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const NPM_ROOT_TTL_MS = 5 * 60 * 1000;
let npmRootCache = { at: 0, value: null };

/** 状态的可读文本(日志/状态卡/工具输出共用)。 */
export const PATCH_STATUS_TEXT = {
  already: "已是最新",
  updated: "已更新补丁(重启 dsh 生效)",
  applied: "已应用(重启 dsh 生效)",
  restored: "已还原原始版(重启 dsh 生效)",
  "needs-refresh": "上游已升级,补丁待重录",
  "not-installed": "本机未安装",
  "no-backup": "无原始备份,未还原",
  error: "失败",
};

/** npm 全局根目录(npm root -g);失败返回 null。结果缓存 5 分钟。 */
export function npmRoot() {
  if (npmRootCache.value !== null && Date.now() - npmRootCache.at < NPM_ROOT_TTL_MS) return npmRootCache.value;
  let value = null;
  try {
    // shell: true 规避 Windows 上 spawn .cmd 的 EINVAL;命令为静态字符串,无注入面。
    const r = spawnSync("npm root -g", { shell: true, encoding: "utf8", timeout: 8000, windowsHide: true });
    const out = String(r.stdout || "").trim();
    if (r.status === 0 && out && fs.existsSync(out)) value = out;
  } catch { /* npm 不可用时走其他候选根 */ }
  npmRootCache = { at: Date.now(), value };
  return value;
}

/** 本机可能安装了某包的目录列表(存在才返回,去重)。 */
export function findPackageDirs(home, packageName) {
  const parts = packageName.split("/");
  const bases = [];
  const appData = process.env.APPDATA;
  if (appData) bases.push(path.join(appData, "npm", "node_modules"));
  const nr = npmRoot();
  if (nr) bases.push(nr);
  if (process.platform !== "win32") {
    // node 在 <prefix>/bin/node → 全局根常是 <prefix>/lib/node_modules
    bases.push(path.join(path.dirname(process.execPath), "..", "lib", "node_modules"));
  }
  bases.push(path.join(home, "profiles", "web", "node_modules"));
  const out = [];
  for (const base of bases) {
    for (const candidate of [
      path.join(base, ...parts),
      path.join(base, "@deepseek-ai", "dsh", "node_modules", ...parts),
    ]) {
      if (fs.existsSync(path.join(candidate, "package.json")) && !out.includes(candidate)) out.push(candidate);
    }
  }
  return out;
}

/** 读取 patches/ 下全部补丁清单(enabled=false 的跳过)。 */
export function loadPatchManifests(home) {
  const dir = path.join(home, "patches");
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => {
      try { return fs.statSync(path.join(dir, n)).isDirectory(); } catch { return false; }
    });
  } catch { return []; }
  const out = [];
  for (const name of names) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, name, "patch.json"), "utf8"));
      if (!m || !m.package || !m.target || m.enabled === false) continue;
      out.push({ name, dir: path.join(dir, name), ...m });
    } catch { /* 坏清单忽略 */ }
  }
  return out;
}

/** 补丁目录里原始版备份的路径。 */
function originalBackupPath(patchDir, target) {
  const base = path.basename(target).replace(/[\\/]/g, "_");
  return path.join(patchDir, "original-" + base);
}

/** 把单个补丁应用到本机全部安装位置;返回 { name, targets: [{path,status,...}] }。 */
export function applyPatchToTargets(home, manifest) {
  const result = { name: manifest.name, targets: [] };
  const patchDir = manifest.dir || path.join(home, "patches", manifest.name);
  let payload;
  try {
    payload = fs.readFileSync(path.join(patchDir, manifest.payload || "payload.js"), "utf8");
  } catch (e) {
    result.targets.push({ path: path.join(patchDir, manifest.payload || "payload.js"), status: "error", error: String(e?.message || e) });
    return result;
  }
  const dirs = findPackageDirs(home, manifest.package);
  if (!dirs.length) {
    result.targets.push({ path: "(未找到安装目录)", status: "not-installed", package: manifest.package });
    return result;
  }
  for (const dir of dirs) {
    const targetPath = path.join(dir, manifest.target);
    const t = { path: targetPath, status: "unknown" };
    try {
      const installedVersion = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version;
      const current = fs.readFileSync(targetPath, "utf8");
      if (current === payload) {
        t.status = "already";
      } else if (manifest.marker && current.includes(manifest.marker)) {
        // 已是本补丁的旧版本 → 补丁自身升级,安全覆盖
        fs.writeFileSync(targetPath, payload);
        t.status = "updated";
      } else if (manifest.packageVersion && installedVersion !== manifest.packageVersion) {
        // 上游升级过 → 不盲写,payload 需要基于新版重录
        t.status = "needs-refresh";
        t.installedVersion = installedVersion;
        t.expectedVersion = manifest.packageVersion;
      } else {
        // 原始版 → 首次套用前原样备份一次(还原用),再打补丁
        const backup = originalBackupPath(patchDir, manifest.target);
        if (!fs.existsSync(backup)) fs.writeFileSync(backup, current);
        fs.writeFileSync(targetPath, payload);
        t.status = "applied";
        t.backup = backup;
      }
    } catch (e) {
      t.status = "error";
      t.error = String(e?.message || e);
    }
    result.targets.push(t);
  }
  return result;
}

/** 还原单个补丁(用 original-* 备份覆盖目标);用于回退。 */
export function restorePatchToTargets(home, manifest) {
  const result = { name: manifest.name, targets: [] };
  const patchDir = manifest.dir || path.join(home, "patches", manifest.name);
  const backup = originalBackupPath(patchDir, manifest.target);
  if (!fs.existsSync(backup)) {
    result.targets.push({ path: backup, status: "no-backup" });
    return result;
  }
  const pristine = fs.readFileSync(backup, "utf8");
  for (const dir of findPackageDirs(home, manifest.package)) {
    const targetPath = path.join(dir, manifest.target);
    const t = { path: targetPath, status: "restored" };
    try { fs.writeFileSync(targetPath, pristine); } catch (e) { t.status = "error"; t.error = String(e?.message || e); }
    result.targets.push(t);
  }
  return result;
}

/** 应用 patches/ 下全部补丁;返回 { results, appliedAt }。 */
export function applyAllPatches(home) {
  const results = [];
  const list = loadPatchManifests(home);
  for (const m of list) {
    try { results.push(applyPatchToTargets(home, m)); } catch (e) {
      results.push({ name: m.name, targets: [{ path: "(补丁目录)", status: "error", error: String(e?.message || e) }] });
    }
  }
  return { results, appliedAt: list.length ? Date.now() : 0 };
}

/** 把应用结果压成可读句子数组,如 ["web-fetch-http: 已是最新"]。 */
export function formatApplyResults(results) {
  return (results || []).map((r) => {
    const states = (r.targets || []).map((t) => PATCH_STATUS_TEXT[t.status] || t.status);
    return `${r.name}: ${states.join(", ")}`;
  });
}