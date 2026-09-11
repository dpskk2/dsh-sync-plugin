/**
 * patches.js 版本无关性测试:补丁引擎以「内容比对」为准,不锚定版本号。
 *
 * 场景1:安装版本与清单 packageVersion 不符,但目标文件与录制原始版(历史命名
 *        original-lib-index.js)逐字节一致 → 应套用(applied),不再 needs-refresh。
 * 场景2:版本不符且内容偏离录制原始版(上游文件真的变了)→ needs-refresh,不盲写。
 * 场景3:目标已是当前 payload → 幂等 already。
 * 场景4:目标带旧补丁 marker → 补丁自身升级 updated,覆盖为最新 payload。
 * 场景5:无备份 + 版本匹配 → 首次套用:自动捕获规范名备份 original-index.js,再打补丁;
 *        随后把安装版本改成不符且内容仍等于该备份 → 仍按「已应用」套用(规范名同样生效)。
 *
 * 运行:node patch-version-agnostic-test.mjs
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyPatchToTargets, formatApplyResults } from "./lib/patches.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "patch-test-"));
let passed = 0;
try {
  const name = "fake-patch";
  const patchDir = path.join(home, "patches", name);
  const pkgDir = path.join(home, "profiles", "web", "node_modules", "@fake", "test-pkg");
  fs.mkdirSync(path.join(patchDir), { recursive: true });
  fs.mkdirSync(path.join(pkgDir, "lib"), { recursive: true });
  fs.writeFileSync(path.join(patchDir, "payload.js"), "PATCHED-CONTENT", "utf8");
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "@fake/test-pkg", version: "1.0.0" }), "utf8");
  const manifest = {
    name, dir: patchDir, package: "@fake/test-pkg",
    packageVersion: "9.9.9", // 故意与安装版本(1.0.0)不符
    target: "lib/index.js", payload: "payload.js",
    marker: "fake patch marker", enabled: true,
  };
  const targetFile = path.join(pkgDir, "lib", "index.js");

  // 场景1:版本不符 + 内容与录制原始版一致(历史命名 original-lib-index.js)→ 照常套用
  fs.writeFileSync(path.join(patchDir, "original-lib-index.js"), "ORIGINAL-CONTENT", "utf8");
  fs.writeFileSync(targetFile, "ORIGINAL-CONTENT", "utf8");
  const r1 = applyPatchToTargets(home, manifest);
  assert.strictEqual(r1.targets[0].status, "applied", "版本不符但内容一致时应套用,实际=" + r1.targets[0].status);
  assert.strictEqual(fs.readFileSync(targetFile, "utf8"), "PATCHED-CONTENT");
  passed++;
  console.log("场景1 通过:版本不符 + 内容一致(历史备份名)→", formatApplyResults([r1])[0]);

  // 场景2:版本不符 + 内容偏离录制原始版 → needs-refresh,不盲写
  fs.writeFileSync(targetFile, "UPSTREAM-CHANGED-CONTENT", "utf8");
  const r2 = applyPatchToTargets(home, manifest);
  assert.strictEqual(r2.targets[0].status, "needs-refresh", "内容真变时应待重录,实际=" + r2.targets[0].status);
  assert.strictEqual(fs.readFileSync(targetFile, "utf8"), "UPSTREAM-CHANGED-CONTENT", "needs-refresh 时不得覆盖目标文件");
  passed++;
  console.log("场景2 通过:内容真变 →", formatApplyResults([r2])[0]);

  // 场景3:目标已是当前 payload → 幂等 already
  fs.writeFileSync(targetFile, "PATCHED-CONTENT", "utf8");
  const r3 = applyPatchToTargets(home, manifest);
  assert.strictEqual(r3.targets[0].status, "already", "内容===payload 时应幂等跳过,实际=" + r3.targets[0].status);
  passed++;
  console.log("场景3 通过:幂等 →", formatApplyResults([r3])[0]);

  // 场景4:目标带旧补丁 marker → 补丁自身升级 updated
  fs.writeFileSync(targetFile, "OLD PATCH fake patch marker V1", "utf8");
  const r4 = applyPatchToTargets(home, manifest);
  assert.strictEqual(r4.targets[0].status, "updated", "带 marker 旧补丁应覆盖升级,实际=" + r4.targets[0].status);
  assert.strictEqual(fs.readFileSync(targetFile, "utf8"), "PATCHED-CONTENT");
  passed++;
  console.log("场景4 通过:旧补丁升级 →", formatApplyResults([r4])[0]);

  // 场景5:无备份 + 版本匹配 → 首次套用(自动捕获规范名备份 original-index.js);
  //       之后版本不符但内容仍等于该备份 → 依然套用(规范名路径的版本无关也生效)
  const m2 = { ...manifest, packageVersion: "1.0.0" }; // 与安装版本一致
  fs.rmSync(path.join(patchDir, "original-lib-index.js"), { force: true });
  fs.writeFileSync(targetFile, "ORIGINAL-CONTENT", "utf8");
  const r5a = applyPatchToTargets(home, m2);
  assert.strictEqual(r5a.targets[0].status, "applied", "首次套用应成功,实际=" + r5a.targets[0].status);
  assert.ok(fs.existsSync(path.join(patchDir, "original-index.js")), "首次套用应自动捕获规范名备份");
  passed++;
  fs.writeFileSync(targetFile, "ORIGINAL-CONTENT", "utf8"); // 还原成原始版(模拟 dsh 重装还原)
  const r5b = applyPatchToTargets(home, { ...manifest, packageVersion: "9.9.9" }); // 版本又不符
  assert.strictEqual(r5b.targets[0].status, "applied", "规范名备份下版本不符也应套用,实际=" + r5b.targets[0].status);
  assert.strictEqual(fs.readFileSync(targetFile, "utf8"), "PATCHED-CONTENT");
  passed++;
  console.log("场景5 通过:首次套用 + 规范名备份版本无关 →", formatApplyResults([r5b])[0]);

  console.log(`\n${passed} 个断言全部通过 ✓`);
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}