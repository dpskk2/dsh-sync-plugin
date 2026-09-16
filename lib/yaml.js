/**
 * 零依赖 YAML 子集解析/序列化器 —— 供 dsh-sync-plugin 的 crdt-yaml 合并使用。
 *
 * 支持(覆盖 DSH settings.yaml / cordis.yml / cordis.patch.yml 的真实结构):
 *   - 嵌套 `key: value` 映射(任意一致的空格缩进)
 *   - `- item` 序列(标量序列 / map 序列,map 项 `- key: value` 后续键更深缩进)
 *   - 标量:字符串 / 整数 / 浮点 / 布尔 / null / 空流 `[]` `{}`
 *   - 单引号/双引号简单字符串(不含转义)
 *
 * 不支持(遇到即 parse 失败,由调用方降级为 opaque 三方文本合并,绝不静默错解析):
 *   锚点/别名、flow 集合(非空的 `{...}`/`[...]`)、块标量 `|`/`>`、多文档、转义引号。
 *
 * 序列化输出:map 键按字典序排序(跨机确定性字节,避免合并方向不同产生无谓 diff);
 * 序列项保持原顺序。需要引号的字符串保守加双引号。
 */

const isPlainObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 切分 `key: value`(第一个 ':' 之前为 key;无 ':' 视为整行为 key、value 为空) */
function splitKeyValue(text) {
  const idx = text.indexOf(':');
  if (idx === -1) return { key: text.trim(), value: '' };
  return { key: text.slice(0, idx).trim(), value: text.slice(idx + 1).trim() };
}

/** 标量解析:空流 / 布尔 / null / 整数 / 浮点 / 引号字符串 / 其余按原样字符串。
 *  非空 flow 集合({...} / [...])超出子集,抛错由 parseYaml 捕获返回 ok:false(降级 opaque)。 */
function parseScalar(s) {
  if (s === '[]') return [];
  if (s === '{}') return {};
  if (s === 'true' || s === 'True' || s === 'TRUE') return true;
  if (s === 'false' || s === 'False' || s === 'FALSE') return false;
  if (s === 'null' || s === 'Null' || s === 'NULL' || s === '~') return null;
  if ((s.startsWith('"') && s.endsWith('"') && s.length >= 2) || (s.startsWith("'") && s.endsWith("'") && s.length >= 2)) {
    return s.slice(1, -1);
  }
  if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
    throw new Error('unsupported-flow-collection');
  }
  if (/^[-+]?\d+$/.test(s)) { const n = Number(s); return Number.isSafeInteger(n) ? n : s; }
  if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) { const n = Number(s); return Number.isFinite(n) ? n : s; }
  return s;
}

/**
 * 解析 YAML 子集为 JS 对象。返回 { ok:true, value } 或 { ok:false, reason }。
 */
export function parseYaml(text) {
  try {
    const tokens = [];
    for (const raw of String(text).split('\n')) {
      const line = raw.replace(/\r$/, '');
      if (!line.trim()) continue;               // 空行
      if (/^\s*#/.test(line)) continue;         // 整行注释
      const indent = line.match(/^[ ]*/)[0].length;
      const content = line.trim();
      // 行内注释:subset 数据无;仅对「值里疑似带注释」保持原样(不剥离,交给标量)
      tokens.push({ indent, text: content });
    }
    if (!tokens.length) return { ok: true, value: null };
    let i = 0;

    const peek = () => (i < tokens.length ? tokens[i] : null);

    function parseNode() {
      const t = peek();
      if (!t) return null;
      if (t.text === '-' || t.text.startsWith('- ')) return parseSequence(t.indent);
      return parseMapping(t.indent);
    }

    function parseSequence(indent) {
      const arr = [];
      while (peek() && peek().indent === indent && (peek().text === '-' || peek().text.startsWith('- '))) {
        const rest = peek().text.slice(1).trim();
        i += 1;
        if (rest === '') {
          // `- ` 单独一行 → 嵌套块
          arr.push(parseNode());
        } else if (rest.includes(':')) {
          // map 项:`- key: value` + 更深缩进的续行键
          const map = {};
          const { key, value } = splitKeyValue(rest);
          if (value === '') map[key] = parseNode();
          else map[key] = parseScalar(value);
          const contIndent = peek() ? peek().indent : null;
          while (peek() && contIndent !== null && peek().indent === contIndent && contIndent > indent
            && peek().text !== '-' && !peek().text.startsWith('- ')) {
            const { key: k2, value: v2 } = splitKeyValue(peek().text);
            i += 1;
            if (v2 === '') map[k2] = parseNode();
            else map[k2] = parseScalar(v2);
          }
          arr.push(map);
        } else {
          arr.push(parseScalar(rest));
        }
      }
      return arr;
    }

    function parseMapping(indent) {
      const map = {};
      while (peek() && peek().indent === indent && peek().text !== '-' && !peek().text.startsWith('- ')) {
        const { key, value } = splitKeyValue(peek().text);
        i += 1;
        if (value === '') map[key] = parseNode();
        else map[key] = parseScalar(value);
      }
      return map;
    }

    const value = parseNode();
    if (i < tokens.length) return { ok: false, reason: 'trailing-tokens' };
    return { ok: true, value };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
}

/** 判断字符串是否需要加引号(空/像数字布尔 null/含 YAML 指示符/首尾空白/含 ': ' 或 '#') */
function needsQuote(s) {
  if (s === '') return true;
  if (/^(true|false|null|~|True|False|Null|TRUE|FALSE|NULL)$/.test(s)) return true;
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return true;
  if (/^[\s\-?:,\[\]{}#&*!|>'"%@`]/.test(s)) return true;
  if (/[\s]$/.test(s)) return true;
  if (s.includes(': ') || s.includes(' #')) return true;
  if (/[\r\n]/.test(s)) return true;
  return false;
}

function scalar(v) {
  if (v === null) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return needsQuote(v) ? JSON.stringify(v) : v;
  return JSON.stringify(v);
}

/** 序列化 JS 对象为 YAML 子集文本(map 键按字典序排序) */
export function emitYaml(value) {
  const lines = [];

  const emitMap = (obj, indent) => {
    const keys = Object.keys(obj).sort();
    for (const k of keys) {
      const v = obj[k];
      if (isPlainObj(v)) {
        if (Object.keys(v).length === 0) lines.push(' '.repeat(indent) + k + ': {}');
        else { lines.push(' '.repeat(indent) + k + ':'); emitMap(v, indent + 2); }
      } else if (Array.isArray(v)) {
        if (v.length === 0) lines.push(' '.repeat(indent) + k + ': []');
        else { lines.push(' '.repeat(indent) + k + ':'); emitSeq(v, indent + 2); }
      } else {
        lines.push(' '.repeat(indent) + k + ': ' + scalar(v));
      }
    }
  };

  const emitSeq = (arr, indent) => {
    for (const item of arr) {
      if (isPlainObj(item)) {
        const entries = Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        if (entries.length === 0) { lines.push(' '.repeat(indent) + '- {}'); continue; }
        // 首键写在同一 `- ` 行
        const [k0, v0] = entries[0];
        if (isPlainObj(v0) && Object.keys(v0).length) { lines.push(' '.repeat(indent) + '- ' + k0 + ':'); emitMap(v0, indent + 4); }
        else if (Array.isArray(v0) && v0.length) { lines.push(' '.repeat(indent) + '- ' + k0 + ':'); emitSeq(v0, indent + 4); }
        else lines.push(' '.repeat(indent) + '- ' + k0 + ': ' + scalar(v0));
        // 续行键
        for (let j = 1; j < entries.length; j += 1) {
          const [k, v] = entries[j];
          if (isPlainObj(v) && Object.keys(v).length) { lines.push(' '.repeat(indent + 2) + k + ':'); emitMap(v, indent + 4); }
          else if (Array.isArray(v) && v.length) { lines.push(' '.repeat(indent + 2) + k + ':'); emitSeq(v, indent + 4); }
          else lines.push(' '.repeat(indent + 2) + k + ': ' + scalar(v));
        }
      } else if (Array.isArray(item)) {
        lines.push(' '.repeat(indent) + '- ');
        emitSeq(item, indent + 2);
      } else {
        lines.push(' '.repeat(indent) + '- ' + scalar(item));
      }
    }
  };

  if (isPlainObj(value)) emitMap(value, 0);
  else if (Array.isArray(value)) emitSeq(value, 0);
  else lines.push(scalar(value));
  return lines.join('\n') + '\n';
}

/** 往返自检:parse(emit(x)) 深等于 x(用于测试断言) */
export function roundTrip(value) {
  const r = parseYaml(emitYaml(value));
  return r.ok ? r.value : null;
}