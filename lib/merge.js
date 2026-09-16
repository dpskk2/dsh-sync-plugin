/**
 * dsh-sync-plugin 合并层 —— 纯函数,不依赖 git / SyncEngine / 任何 npm 包。
 *
 * 设计(见 docs/merge-engine-refactor.md):把「合并」从 git merge 的三路行级合并里
 * 拆出来,按文件类型给一条确定性、收敛的规则;不存在「停下来问用户」的分支。
 *
 *  - classifyFile(relPath)              → 文件类型
 *  - mergeSessionLog(ours, theirs)      → 会话日志 G-Set 并集 CRDT(含 v3 / end-seed 归一化)
 *  - mergeVmap / updateVmap / diffLeafPaths / mergeJsonByVmap → 字段级 LWW-Map CRDT
 *
 * 所有函数都是纯的(输入 Buffer/对象,返回新值),便于脱离 git 直接单测。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml, emitYaml } from './yaml.js';

/* ---- zstd:Node ≥22.10 才有,旧版本自动降级(退回明文/不可合并) ---- */
let zstdDecompressSync = null;
let zstdCompressSync = null;
try { ({ zstdDecompressSync, zstdCompressSync } = await import('node:zlib')); } catch { /* 降级 */ }

/** zstd 帧魔数(小端 0x184D2A57) */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);

/** 解码 zstd 多帧串联为 UTF-8 文本(跳过损坏/不完整帧);非 zstd 或无 zstd 支持返回 null */
export function decodeZstdFrames(buf) {
  if (!(buf.length >= 4 && buf.subarray(0, 4).equals(ZSTD_MAGIC)) || typeof zstdDecompressSync !== 'function') return null;
  const out = [];
  let i = 0;
  while (i <= buf.length - 4) {
    const idx = buf.indexOf(ZSTD_MAGIC, i);
    if (idx === -1) break;
    const i2 = buf.indexOf(ZSTD_MAGIC, idx + 4);
    const frame = i2 === -1 ? buf.subarray(idx) : buf.subarray(idx, i2);
    try { out.push(zstdDecompressSync(frame)); } catch { /* 跳过损坏帧 */ }
    i = i2 === -1 ? buf.length : i2;
  }
  return Buffer.concat(out).toString('utf8');
}

/* ================= 文件分类 ================= */

/**
 * 按相对路径分类,决定走哪条合并策略。
 * @returns 'session-log' | 'crdt-json' | 'crdt-yaml' | 'crdt-meta' | 'opaque'
 */
export function classifyFile(relPath) {
  const p = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (/^sessions\/[^/]+\/session-[0-9a-f-]{36}\/session(\.v\d+)?\.jsonl(\.zstd)?$/i.test(p)) return 'session-log';
  if (/^storages\/sync-meta\/.*\.vmap\.json$/i.test(p)) return 'crdt-meta';
  if (p === 'storages/workspace.json') return 'crdt-json';
  if (p === 'profiles/web/package.json') return 'crdt-json';
  if (/\.ya?ml$/i.test(p)) return 'crdt-yaml';
  return 'opaque';
}

/* ================= 会话日志:G-Set 并集 CRDT ================= */

/** 解码 sourceEventSeqs 存储形式([N] 或 [[start,end],...])为 seq 数组 */
function decodeSeqRanges(value) {
  const out = [];
  for (const entry of value) {
    if (typeof entry === 'number') {
      if (!Number.isSafeInteger(entry) || entry < 0) throw new Error('bad seq');
      out.push(entry);
      continue;
    }
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error('bad range');
    const [s, e] = entry;
    if (!Number.isSafeInteger(s) || !Number.isSafeInteger(e) || s < 0 || e < 0 || e < s) throw new Error('bad range');
    for (let q = s; q <= e; q += 1) out.push(q);
  }
  return out;
}

/** 重新编码 seq 数组:连续 ≥3 段压缩为 [start,end] 对(与 DSH 同款) */
function encodeSeqRanges(values) {
  if (!values.every((v, i) => i === 0 || v > values[i - 1])) return [...values];
  const out = [];
  for (let start = 0; start < values.length;) {
    let end = start;
    while (end + 1 < values.length && values[end + 1] === values[end] + 1) end += 1;
    if (end - start >= 2) out.push([values[start], values[end]]);
    else for (let i = start; i <= end; i += 1) out.push(values[i]);
    start = end + 1;
  }
  return out;
}

/** 把日志 Buffer 解码成 { text, isZstd }(失败返回 null) */
function decodeLog(buf) {
  if (buf.length >= 4 && buf.subarray(0, 4).equals(ZSTD_MAGIC)) {
    const text = decodeZstdFrames(buf);
    if (text === null) return null;
    return { text, isZstd: true };
  }
  return { text: buf.toString('utf8'), isZstd: false };
}

function parseLine(l) {
  try { return JSON.parse(l); } catch { return null; }
}

/**
 * 会话日志合并:两侧都是「在共同基础上追加事件」时按事件并集合并(新增内容直接可见),
 * 而不是单边保留。返回 { ok, value(Buffer), reason? }。
 *
 * 相比旧 mergeSessionLogConflict 的改进:
 *  1. 不依赖文件路径(由调用方按 classifyFile 判定,天然覆盖 v3 文件名)。
 *  2. end-seed 归一化:两侧各一条 session/end-seed 且仅 time 不同 → 视作同一条,取较新 time,
 *     不再产生重复 end-seed / 字节级假冲突(re-seed 重写时间戳的根因)。
 *  3. 任何一步无法验证 → { ok:false },由调用方降级,绝不产出 DSH 读不了的日志。
 */
export function mergeSessionLog(oursBuf, theirsBuf) {
  try {
    const od = decodeLog(oursBuf);
    const td = decodeLog(theirsBuf);
    if (!od || !td) return { ok: false, reason: 'decode' };
    const oursLines = od.text.split('\n').map((l) => l.trim()).filter(Boolean);
    const theirsLines = td.text.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!oursLines.length || !theirsLines.length) return { ok: false, reason: 'empty' };

    const isHeader = (r) => r && r.type === 'session';
    const isEndSeed = (r) => r && r.type === 'session/end-seed';

    // 把两侧拆成 header / end-seed / events
    const split = (lines) => {
      let header = null; let endSeed = null; const events = [];
      for (const l of lines) {
        const r = parseLine(l);
        if (r === null) return null;                 // 存在解析失败 → 无法安全合并
        if (isHeader(r)) { if (header !== null) return null; header = r; }
        else if (isEndSeed(r)) { if (endSeed === null || r.time > endSeed.time) endSeed = r; }
        else events.push(r);
      }
      return { header, endSeed, events };
    };
    const O = split(oursLines);
    const T = split(theirsLines);
    if (!O || !T) return { ok: false, reason: 'malformed' };
    if (!O.header || !T.header) return { ok: false, reason: 'no-header' };
    // 两侧 header 必须一致(会话 id / 版本);不一致 = 不是同一会话,拒绝合并
    if (JSON.stringify(O.header) !== JSON.stringify(T.header)) return { ok: false, reason: 'header-mismatch' };

    // 事件去重(按整行序列化一致 = 同一事件;append-only 下共同前缀天然一致)
    const key = (r) => JSON.stringify(r);
    const oursSet = new Set(O.events.map(key));
    const theirsSet = new Set(T.events.map(key));
    const oursOnly = O.events.filter((r) => !theirsSet.has(key(r)));
    const theirsOnly = T.events.filter((r) => !oursSet.has(key(r)));

    const endSeed = (O.endSeed && T.endSeed)
      ? (O.endSeed.time >= T.endSeed.time ? O.endSeed : T.endSeed)
      : (O.endSeed || T.endSeed);

    // 无任何新增事件(仅可能 end-seed 时间不同)→ 取较新一侧,字节级保留,避免无谓重压缩
    if (!oursOnly.length && !theirsOnly.length) {
      const pick = (O.endSeed && (!T.endSeed || O.endSeed.time >= T.endSeed.time)) ? oursBuf : theirsBuf;
      return { ok: true, value: pick };
    }

    // 两侧都有新增 → 并集 + 按 time 稳定排序 + 重编号 seq + 重映射 sourceEventSeqs
    const all = [...O.events, ...theirsOnly];
    for (const r of all) {
      if (typeof r.time !== 'number' || !Number.isFinite(r.time)) return { ok: false, reason: 'bad-time' };
    }
    all.sort((a, b) => a.time - b.time || 0);

    // 第一趟:按 time 排序后统一重编号 seq,并建立「旧 seq → 新 seq」映射
    const seqMap = new Map();
    let nextSeq = 0;
    for (const rec of all) {
      if (typeof rec.seq === 'number') {
        if (!Number.isSafeInteger(rec.seq) || rec.seq < 0) return { ok: false, reason: 'bad-seq' };
        seqMap.set(rec.seq, nextSeq);
        rec.seq = nextSeq;
        nextSeq += 1;
      }
    }
    // 第二趟:用完整 seqMap 重映射 sourceEventSeqs(支持引用「重排后位于后方」的事件)
    const merged = [O.header];
    for (const rec of all) {
      const d = rec.data;
      if (d && Array.isArray(d.sourceEventSeqs)) {
        try {
          const decoded = decodeSeqRanges(d.sourceEventSeqs);
          const remapped = decoded.map((s) => seqMap.get(s));
          if (remapped.some((x) => x === undefined)) return { ok: false, reason: 'dangling-seq-ref' };
          d.sourceEventSeqs = encodeSeqRanges(remapped);
        } catch { return { ok: false, reason: 'bad-seq-ref' }; }
      }
      merged.push(rec);
    }
    if (endSeed) {
      if (typeof endSeed.seq === 'number') {
        seqMap.set(endSeed.seq, nextSeq);
        endSeed.seq = nextSeq;
      }
      merged.push(endSeed);
    }

    const text = merged.map((r) => JSON.stringify(r)).join('\n') + '\n';
    const out = (od.isZstd || td.isZstd)
      ? (typeof zstdCompressSync === 'function' ? zstdCompressSync(Buffer.from(text, 'utf8')) : null)
      : Buffer.from(text, 'utf8');
    if (out === null) return { ok: false, reason: 'no-zstd-encode' };
    return { ok: true, value: out };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
}

/* ================= 字段级 LWW-Map CRDT(JSON 配置) ================= */

/** 时钟比较:返回 >0 表示 a 比 b 新;相等时按 actor 字典序决定全序 */
export function cmpClock(a, b) {
  const A = (a && typeof a === 'object') ? a : { t: 0, actor: '' };
  const B = (b && typeof b === 'object') ? b : { t: 0, actor: '' };
  if (A.t !== B.t) return A.t - B.t;
  if (A.actor === B.actor) return 0;
  return String(A.actor) > String(B.actor) ? 1 : -1;
}

/**
 * vmap(LWW-Map)自身合并:同键取 (t,actor) 大者,异键并集。
 * vmap 形如 { format:1, path:'settings.yaml', fields:{ '<leaf.path>': {t,actor} } }
 */
export function mergeVmap(a, b) {
  const A = (a && typeof a === 'object') ? a : { fields: {} };
  const B = (b && typeof b === 'object') ? b : { fields: {} };
  const fields = {};
  const keys = new Set([...Object.keys(A.fields || {}), ...Object.keys(B.fields || {})]);
  for (const k of keys) {
    const ca = (A.fields && A.fields[k]) || null;
    const cb = (B.fields && B.fields[k]) || null;
    if (ca && cb) fields[k] = cmpClock(ca, cb) >= 0 ? ca : cb;
    else fields[k] = ca || cb;
  }
  return { format: 1, path: A.path || B.path || '', fields };
}

const isScalar = (v) => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
const isPlainObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 顺序不敏感深比较:map 忽略键序、数组保留项序(避免 key 重排导致假「已变更」) */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a); const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k])) return false;
    return true;
  }
  return false;
}

/** 列出对象所有「叶子路径」(标量或数组节点)的 dot-path */
export function leafPaths(obj) {
  const out = [];
  const walk = (v, p) => {
    if (isScalar(v) || Array.isArray(v)) { out.push(p); return; }
    for (const k of Object.keys(v || {})) walk(v[k], p ? `${p}.${k}` : k);
  };
  walk(obj, '');
  return out;
}

/** 深比较 base vs next,返回「值发生变化」的叶子路径集合(供提交时 bump vmap 用) */
export function diffLeafPaths(base, next) {
  const out = new Set();
  const walk = (b, n, p) => {
    if (isScalar(n) || isScalar(b) || Array.isArray(n) || Array.isArray(b)) {
      if (!deepEqual(b, n)) out.add(p);
      return;
    }
    const keys = new Set([...Object.keys(b || {}), ...Object.keys(n || {})]);
    for (const k of keys) walk((b && b[k]) ?? undefined, (n && n[k]) ?? undefined, p ? `${p}.${k}` : k);
  };
  walk(base, next, '');
  return out;
}

/** 提交时更新 vmap:changedPaths 打上新时钟 {t,actor},未变叶子保留旧时钟 */
export function updateVmap(vmap, changedPaths, t, actor) {
  const base = (vmap && typeof vmap === 'object') ? vmap : { format: 1, path: '', fields: {} };
  const fields = { ...(base.fields || {}) };
  for (const p of changedPaths) fields[p] = { t, actor };
  return { format: 1, path: base.path || '', fields };
}

/** 列表元素身份:标量取自身;map 依次尝试 id → provider+model → name → 内容哈希 */
export function listIdentity(item) {
  if (isScalar(item)) return item;
  if (Array.isArray(item)) return JSON.stringify(item);
  if (isPlainObj(item)) {
    if ('id' in item) return 'id:' + item.id;
    if ('provider' in item && 'model' in item) return `pm:${item.provider}:${item.model}`;
    if ('name' in item) return 'name:' + item.name;
    return 'h:' + JSON.stringify(item);
  }
  return JSON.stringify(item);
}

/** 列表合并:按元素身份 OR-set(并集);同身份元素递归合并(首版无墓碑,删除可能复活,见设计 §5.4) */
function mergeList(ours, theirs, oursVmap, theirsVmap, pathKey) {
  const idOf = (item) => JSON.stringify(listIdentity(item));
  const oursById = new Map(ours.map((it) => [idOf(it), it]));
  const theirsById = new Map(theirs.map((it) => [idOf(it), it]));
  const order = []; const seen = new Set();
  for (const it of ours) { const id = idOf(it); if (!seen.has(id)) { seen.add(id); order.push(id); } }
  for (const it of theirs) { const id = idOf(it); if (!seen.has(id)) { seen.add(id); order.push(id); } }
  const out = [];
  for (const id of order) {
    const o = oursById.get(id); const t = theirsById.get(id);
    if (o !== undefined && t !== undefined) {
      out.push(deepEqual(o, t) ? o : mergeJsonByVmap(undefined, o, t, oursVmap, theirsVmap, pathKey));
    } else if (o !== undefined) out.push(o);
    else out.push(t);
  }
  return out;
}

/**
 * 三路 JSON 合并(base/ours/theirs + 两侧 vmap)。
 * 标量 → LWW(比较两侧 vmap 该叶子的时钟);映射 → 递归并集;数组 → 按元素身份并集。
 * 返回合并后的值(纯对象)。
 *
 * 注意:这里接收「两侧各自的 vmap」而非合并后的 vmap —— 因为判断某叶子「谁更新」
 * 必须比较 ours 侧时钟 vs theirs 侧时钟;合并后的单一时钟只知道胜者、不知道方向。
 */
export function mergeJsonByVmap(base, ours, theirs, oursVmap, theirsVmap, pathKey = '') {
  const fieldOf = (m) => (m && m.fields && m.fields[pathKey]) || null;
  // 标量叶子(含两侧类型不一致 → 退化 LWW)
  if (isScalar(ours) || isScalar(theirs) || Array.isArray(ours) !== Array.isArray(theirs)) {
    if (deepEqual(ours, theirs)) return ours;
    const cO = fieldOf(oursVmap); const cT = fieldOf(theirsVmap);
    if (cO && cT) return cmpClock(cO, cT) >= 0 ? ours : theirs;
    if (cO) return ours;                       // 仅本侧改过(有版本图)
    if (cT) return theirs;                     // 仅远侧改过(有版本图)
    // 无版本图(引导期)→ base 感知三路:谁改了取谁;都改了取本侧(确定性)
    if (base !== undefined) {
      const oChanged = !deepEqual(ours, base);
      const tChanged = !deepEqual(theirs, base);
      if (oChanged && !tChanged) return ours;
      if (!oChanged && tChanged) return theirs;
    }
    return ours;
  }
  if (Array.isArray(ours) && Array.isArray(theirs)) return mergeList(ours, theirs, oursVmap, theirsVmap, pathKey);
  // 两侧都是普通对象 → 递归
  const out = {};
  const keys = new Set([...Object.keys(ours), ...Object.keys(theirs)]);
  for (const k of keys) {
    const hasO = Object.prototype.hasOwnProperty.call(ours, k);
    const hasT = Object.prototype.hasOwnProperty.call(theirs, k);
    const childKey = pathKey ? `${pathKey}.${k}` : k;
    if (hasO && hasT) {
      out[k] = mergeJsonByVmap(base ? base[k] : undefined, ours[k], theirs[k], oursVmap, theirsVmap, childKey);
    } else if (hasO) out[k] = ours[k];
    else out[k] = theirs[k];
  }
  return out;
}

/** 便捷:把合并结果写回磁盘(工作树路径),目录自动创建 */
export function writeMerged(relPath, buf, rootDir) {
  const target = path.join(rootDir, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buf);
}

/**
 * YAML 配置合并:两侧解析为对象 → mergeJsonByVmap(字段级 LWW-Map) → 序列化回 YAML。
 * 任一侧解析失败(超出子集)→ { ok:false },由调用方降级为 opaque 三方文本合并。
 * 返回 { ok, value(string) }。
 */
export function mergeYamlByVmap(baseText, oursText, theirsText, oursVmap, theirsVmap) {
  const pb = baseText != null && baseText !== '' ? parseYaml(baseText) : { ok: true, value: undefined };
  const po = parseYaml(oursText);
  const pt = parseYaml(theirsText);
  if (!po.ok || !pt.ok || !pb.ok) return { ok: false, reason: 'yaml-parse' };
  const merged = mergeJsonByVmap(pb.value, po.value, pt.value, oursVmap, theirsVmap, '');
  return { ok: true, value: emitYaml(merged) };
}