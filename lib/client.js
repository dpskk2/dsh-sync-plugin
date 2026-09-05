/**
 * dsh-sync 浏览器端 bundle
 *
 * - 侧栏底部「⟳ 同步」按钮:sidebar.footer.action 槽位原生注入(宽侧栏显示图标+文字,
 *   收起侧栏自动变成纯图标,不悬浮、不遮挡页面);
 * - 设置面板「同步 · 会话管理」分节:同步状态卡 + 已归档对话(实时 3s 刷新、标题、
 *   工作区、时间、大小)+ 全部会话(默认折叠)+ 排序(最后活动/创建时间/标题)+ 搜索 + 删除;
 * - 侧栏会话「…」菜单注入「删除…」(在原生「归档会话」下方,Escape 关菜单,删除后自动刷新)。
 *
 * 挂载方式:声明了 dsh.client 的依赖由 dsh 自动打包进浏览器 bundle,无需手工注入。
 */
window.__ModuleLoader__.load({
  id: 'dsh-sync',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const react = require('react');
    const e = react.createElement;
    const { useState, useEffect, useRef, useMemo, useCallback } = react;

    /* ---------- API ---------- */
    const API = {
      run: () => fetch('/dsh-sync/api/run', { method: 'POST' }).then((r) => r.json()),
      status: () => fetch('/dsh-sync/api/status').then((r) => r.json()),
      sessions: () => fetch('/dsh-sync/api/sessions').then((r) => r.json()),
      del: (id) => fetch('/dsh-sync/api/session/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      }).then((r) => r.json()),
    };

    let sessionsCache = { at: 0, rows: [] };
    function loadSessions(force) {
      if (!force && Date.now() - sessionsCache.at < 4000) return Promise.resolve(sessionsCache.rows);
      return API.sessions().then((d) => {
        sessionsCache = { at: Date.now(), rows: d.sessions || [] };
        return sessionsCache.rows;
      });
    }

    function fmtTime(ms) {
      try { return new Date(ms).toLocaleString(); } catch { return String(ms); }
    }
    function fmtAgo(ms) {
      const d = Date.now() - ms;
      if (d < 60000) return '刚刚';
      if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
      if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
      if (d < 604800000) return Math.floor(d / 86400000) + ' 天前';
      try { return new Date(ms).toLocaleDateString(); } catch { return ''; }
    }

    /* 气泡提示:挂在触发元素附近,数秒自动消失(结果反馈,不常驻不遮 UI) */
    function bubble(anchor, text, ok) {
      try {
        const b = document.createElement('div');
        b.className = 'dss-bubble';
        if (!ok) b.classList.add('dss-bubble-err');
        b.textContent = (ok ? '✓ ' : '✗ ') + String(text || '');
        document.body.appendChild(b);
        const r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
        if (r) {
          const left = Math.max(12, Math.min(r.left, window.innerWidth - b.offsetWidth - 12));
          const top = Math.max(12, r.top - b.offsetHeight - 10);
          b.style.left = left + 'px';
          b.style.top = top + 'px';
        } else {
          b.style.left = '16px';
          b.style.bottom = '16px';
        }
        setTimeout(() => { b.style.opacity = '0'; }, 3600);
        setTimeout(() => { b.remove(); }, 4000);
      } catch { /* ignore */ }
    }

    const STYLE = [
      /* 侧栏底部同步按钮 */
      '.dss-foot{display:flex;align-items:center}',
      '.dss-foot-btn{display:flex;align-items:center;gap:6px;border:none;background:transparent;color:inherit;border-radius:10px;padding:7px 10px;font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}',
      '.dss-foot-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
      '.dss-foot-btn:disabled{opacity:.55;cursor:default}',
      '@keyframes dss-spin{to{transform:rotate(360deg)}}',
      /* 结果气泡 */
      '.dss-bubble{position:fixed;z-index:2147483000;max-width:340px;padding:8px 12px;border-radius:10px;',
      'background:var(--dsw-alias-bg-layer-2,rgba(26,26,30,.95));color:var(--dsw-alias-label-primary,#e9e9ee);',
      'border:1px solid rgba(127,127,127,.3);font-size:12px;line-height:1.55;white-space:pre-wrap;',
      'box-shadow:var(--dsw-elevation-prominent,0 2px 8px rgba(0,0,0,.3));transition:opacity .3s}',
      '.dss-bubble-err{color:#f2b8b8;border-color:rgba(220,80,80,.5)}',
      /* 设置分节 */
      '.dss-wrap{padding:4px 2px;font-size:13px;line-height:1.5;color:inherit}',
      '.dss-note{opacity:.65;margin-bottom:10px;font-size:12px}',
      '.dss-card{border:1px solid var(--dsw-alias-separator,rgba(127,127,127,.25));border-radius:12px;',
      'padding:10px 12px;margin-bottom:12px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between}',
      '.dss-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-separator,rgba(127,127,127,.35));',
      'background:transparent;color:inherit;border-radius:10px;padding:6px 12px;font:inherit;font-size:12px;cursor:pointer}',
      '.dss-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
      '.dss-btn:disabled{opacity:.5;cursor:default}',
      '.dss-toolbar{display:flex;gap:8px;align-items:center;margin:6px 0 10px;flex-wrap:wrap}',
      '.dss-search{flex:1;min-width:160px;border:1px solid var(--dsw-alias-separator,rgba(127,127,127,.35));',
      'border-radius:10px;padding:6px 10px;font:inherit;font-size:12px;background:transparent;color:inherit}',
      '.dss-select{border:1px solid var(--dsw-alias-separator,rgba(127,127,127,.35));border-radius:10px;',
      'padding:6px 8px;font:inherit;font-size:12px;background:transparent;color:inherit;cursor:pointer}',
      '.dss-group{margin:16px 0 4px;font-weight:600;font-size:12px;opacity:.8;display:flex;align-items:center;gap:8px}',
      '.dss-empty{opacity:.55;font-size:12px;margin:4px 0 10px}',
      '.dss-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:10px;',
      'border:1px solid var(--dsw-alias-separator,rgba(127,127,127,.18));margin:6px 0}',
      '.dss-main{flex:1;min-width:0}',
      '.dss-title{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dss-meta{font-size:11px;opacity:.65;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dss-badge{flex:none;font-size:10px;border:1px solid rgba(127,127,127,.45);border-radius:6px;padding:1px 6px;opacity:.85}',
      '.dss-del{flex:none;border:1px solid rgba(220,60,60,.55);color:var(--dsw-alias-state-error-primary,#c0392b);',
      'background:transparent;border-radius:8px;padding:4px 12px;font:inherit;font-size:12px;cursor:pointer}',
      '.dss-del:hover{background:rgba(220,60,60,.1)}',
      '.dss-del:disabled{opacity:.45;cursor:default}',
      '.dss-msg{margin:8px 0;padding:6px 10px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));font-size:12px}',
      /* 会话菜单注入 */
      '.dss-menu-sep{height:1px;margin:4px 8px;background:var(--dsw-alias-separator,rgba(127,127,127,.25))}',
      '.dss-menu-danger{color:var(--dsw-alias-state-error-primary,#d33)!important}',
    ].join('\n');

    /* ---------- 同步图标 ---------- */
    function SyncIcon(props) {
      const spin = props.spin
        ? { animation: 'dss-spin .9s linear infinite' }
        : undefined;
      return e('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', style: spin, 'aria-hidden': true },
        e('path', { d: 'M13.6 6.4A6 6 0 1 0 14 8', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
        e('path', { d: 'M13.8 2.6v3.8h-3.8', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }));
    }

    function TrashIcon(props) {
      return e('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        e('path', { d: 'M3 4h10M6.5 4V2.8h3V4M5 4l.7 9h4.6L11 4M6.7 6.5v4.5M9.3 6.5v4.5', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' }));
    }

    /* ---------- 同步状态共享 ---------- */
    function useSync() {
      const [busy, setBusy] = useState(false);
      const [status, setStatus] = useState(null);
      const refresh = useCallback(() => {
        API.status().then((d) => setStatus(d)).catch(() => {});
      }, []);
      const run = useCallback(async (anchor) => {
        if (busy) return;
        setBusy(true);
        try {
          const d = await API.run();
          bubble(anchor, (d && d.summary) || (d && d.error) || '同步完成', Boolean(d && d.ok));
        } catch (err) {
          bubble(anchor, err.message || String(err), false);
        } finally {
          setBusy(false);
          refresh();
        }
      }, [busy, refresh]);
      useEffect(() => { refresh(); }, [refresh]);
      return { busy, status, refresh, run };
    }

    /* ---------- 侧栏底部「⟳ 同步」按钮 ---------- */
    function FootSyncButton(props) {
      const wide = props.wide !== false;
      const ref = useRef(null);
      const { busy, status, run, refresh } = useSync();
      const title = status && status.remote
        ? `一键同步 → ${status.branch}\n${status.remote}`
        : '一键同步(本地快照;未配置远端仓库)\n在 ~/.dsh/dsh-sync.json 配置 remote 后启用云同步';
      return e('div', { className: 'dss-foot', ref },
        e('button', {
          type: 'button',
          className: 'dss-foot-btn',
          'aria-label': '同步 DSH 数据',
          title,
          disabled: busy,
          onClick: () => { refresh(); run(ref.current); },
        },
          e(SyncIcon, { spin: busy }),
          wide ? e('span', null, busy ? '同步中…' : '同步') : null));
    }

    /* ---------- 设置分节:同步 · 会话管理 ---------- */
    function SessionRow(props) {
      const r = props.r;
      const ref = useRef(null);
      const [busy, setBusy] = useState(false);
      const title = r.title || '(无标题)';
      const meta = [
        r.workspace || '?',
        '活动 ' + fmtTime(r.updatedAt) + '(' + fmtAgo(r.updatedAt) + ')',
        r.createdAt ? '创建 ' + fmtTime(r.createdAt) : null,
        r.sizeKB + 'KB',
      ].filter(Boolean).join(' · ');
      const onDel = () => {
        if (busy) return;
        const okDel = window.confirm(
          '删除会话「' + title + '」?\n\n' + r.id + '\n\n记录移入本地回收站(可找回);点「同步」后其他电脑上的同一会话也会被删除。',
        );
        if (!okDel) return;
        setBusy(true);
        API.del(r.id)
          .then((d) => {
            if (d && d.ok) {
              bubble(ref.current, '已删除「' + title + '」,正在刷新页面…', true);
              setTimeout(() => window.location.reload(), 700);
            } else {
              bubble(ref.current, (d && d.error) || '删除失败', false);
              setBusy(false);
            }
          })
          .catch((err) => {
            bubble(ref.current, err.message || String(err), false);
            setBusy(false);
          });
      };
      return e('div', { className: 'dss-row', ref },
        e('div', { className: 'dss-main' },
          e('div', { className: 'dss-title', title: r.id + '\n' + meta }, title),
          e('div', { className: 'dss-meta' }, meta)),
        r.archived ? e('span', { className: 'dss-badge' }, '已归档') : null,
        e('button', { type: 'button', className: 'dss-del', disabled: busy, title: '移入回收站(可找回)', onClick: onDel },
          e(TrashIcon, null), ' 删除'));
    }

    function Section(props) {
      const [rows, setRows] = useState(null);
      const [msg, setMsg] = useState('');
      const [filter, setFilter] = useState(() => localStorage.getItem('dsh-sync.filter') || '');
      const [sortBy, setSortBy] = useState(() => localStorage.getItem('dsh-sync.sort') || 'updated');
      const [showAll, setShowAll] = useState(() => localStorage.getItem('dsh-sync.showAll') === '1');
      const runRef = useRef(null);
      const { busy, status, run, refresh } = useSync();

      const load = useCallback((force) => {
        loadSessions(force)
          .then((rs) => setRows(rs))
          .catch((err) => { setMsg('✗ ' + (err.message || err)); setRows([]); });
      }, []);

      useEffect(() => {
        load(true);
        const timer = setInterval(() => load(false), 3000);
        const onVis = () => { if (document.visibilityState === 'visible') load(true); };
        document.addEventListener('visibilitychange', onVis);
        return () => {
          clearInterval(timer);
          document.removeEventListener('visibilitychange', onVis);
        };
      }, [load]);

      const listed = useMemo(() => {
        if (!rows) return null;
        const f = filter.trim().toLowerCase();
        const matched = f
          ? rows.filter((r) => (r.title || '').toLowerCase().includes(f) || r.id.toLowerCase().includes(f))
          : rows.slice();
        const sorted = matched.sort((a, b) => {
          if (sortBy === 'created') return (b.createdAt || 0) - (a.createdAt || 0) || b.updatedAt - a.updatedAt;
          if (sortBy === 'title') return (a.title || '(无标题)').localeCompare(b.title || '(无标题)', 'zh') || b.updatedAt - a.updatedAt;
          return b.updatedAt - a.updatedAt;
        });
        return sorted;
      }, [rows, filter, sortBy]);

      const archivedList = useMemo(() => (listed || []).filter((r) => r.archived), [listed]);
      const otherList = useMemo(() => (listed || []).filter((r) => !r.archived), [listed]);

      const onFilter = (ev) => {
        const v = ev.target.value;
        setFilter(v);
        localStorage.setItem('dsh-sync.filter', v);
      };
      const onSort = (ev) => {
        const v = ev.target.value;
        setSortBy(v);
        localStorage.setItem('dsh-sync.sort', v);
      };
      const onToggleAll = () => {
        const next = !showAll;
        setShowAll(next);
        localStorage.setItem('dsh-sync.showAll', next ? '1' : '0');
      };
      const onRun = () => { refresh(); run(runRef.current); };

      return e('div', { className: 'dss-wrap' },
        e('style', null, STYLE),
        e('div', { className: 'dss-note' }, '每 3 秒自动刷新。删除 = 移入 ~/.dsh/.trash 回收站(可找回),点「⟳ 同步」会把删除传播到其他电脑;侧栏「归档」仅隐藏会话、不删数据。'),
        status && status.remote
          ? e('div', { className: 'dss-card' },
              e('div', null,
                e('div', { className: 'dss-title' }, '云同步:' + (status.gitMissing ? 'git 未安装' : status.remote)),
                e('div', { className: 'dss-meta' }, '分支 ' + status.branch + ' · ' + (status.auto ? '自动模式' : '手动模式') + (status.lastMessage ? ' · 上次:' + status.lastMessage : ''))),
              e('button', { type: 'button', className: 'dss-btn', disabled: busy || status.gitMissing, ref: runRef, onClick: onRun },
                e(SyncIcon, { spin: busy }), ' 立即同步'))
          : e('div', { className: 'dss-card' },
              e('div', null,
                e('div', { className: 'dss-title' }, '仅本地快照(未配置远端仓库)'),
                e('div', { className: 'dss-meta' }, '编辑 ~/.dsh/dsh-sync.json 填入 GitHub 私有仓库地址后启用云同步' + (status && status.lastMessage ? ' · 上次:' + status.lastMessage : ''))),
              e('button', { type: 'button', className: 'dss-btn', disabled: busy, ref: runRef, onClick: onRun },
                e(SyncIcon, { spin: busy }), ' 立即同步')),
        msg ? e('div', { className: 'dss-msg' }, msg) : null,
        e('div', { className: 'dss-toolbar' },
          e('input', {
            type: 'search', className: 'dss-search', placeholder: '搜索标题 / id…', value: filter, onChange: onFilter,
          }),
          e('select', { className: 'dss-select', value: sortBy, onChange: onSort },
            e('option', { value: 'updated' }, '按最后活动'),
            e('option', { value: 'created' }, '按创建时间'),
            e('option', { value: 'title' }, '按标题'))),
        rows === null
          ? e('div', { className: 'dss-empty' }, '正在读取会话列表…')
          : null,
        rows !== null && listed !== null && listed.length === 0
          ? e('div', { className: 'dss-empty' }, filter ? '没有匹配「' + filter + '」的会话' : '(本机没有会话)')
          : null,
        archivedList.length
          ? e('div', null,
              e('div', { className: 'dss-group' }, '已归档对话(' + archivedList.length + ')'),
              archivedList.map((r) => e(SessionRow, { key: r.id, r })))
          : null,
        otherList.length
          ? e('div', null,
              e('div', { className: 'dss-group' },
                e('button', { type: 'button', className: 'dss-btn', style: { padding: '3px 10px', fontSize: '11px' }, onClick: onToggleAll },
                  showAll ? '▾' : '▸', ' 全部会话(' + otherList.length + ')')),
              showAll ? otherList.map((r) => e(SessionRow, { key: r.id, r })) : null)
          : null);
    }

    /* ---------- 会话「…」菜单注入「删除…」 ---------- */
    const MENU_LABELS = new Set(['归档会话', 'Archive session', '取消归档', 'Unarchive session']);

    function currentMenuSessionRow() {
      const rows = document.querySelectorAll('[role="treeitem"]');
      for (const r of rows) {
        if (typeof r.className === 'string' && r.className.includes('menuOpen')) return r;
      }
      return null;
    }

    function rowTitleText(row) {
      if (!row) return '';
      for (const s of row.querySelectorAll('span')) {
        if (typeof s.className === 'string' && s.className.includes('title')) return (s.textContent || '').trim();
      }
      return (row.textContent || '').trim();
    }

    async function onMenuDelete(itemBtn) {
      try {
        const row = currentMenuSessionRow();
        const title = rowTitleText(row);
        const rows = await loadSessions(true);
        const exact = rows.filter((r) => r.title && r.title === title);
        const cand = (exact.length ? exact : rows.filter((r) => r.title && title && r.title.startsWith(title)))
          .sort((a, b) => b.updatedAt - a.updatedAt)[0];
        if (!cand) {
          window.alert('未能定位该会话(标题匹配失败),请刷新页面后重试。');
          return;
        }
        const okDel = window.confirm(
          '删除会话「' + (cand.title || cand.id) + '」?\n\n' + cand.id + '\n\n记录移入本地回收站(可找回);点「同步」后其他电脑也会删除。',
        );
        if (!okDel) return;
        const d = await API.del(cand.id);
        if (!d || !d.ok) {
          window.alert('删除失败: ' + ((d && d.error) || '未知错误'));
          return;
        }
        // Escape 关掉菜单,随后刷新页面使侧栏/会话视图一致
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        setTimeout(() => window.location.reload(), 600);
      } catch (err) {
        window.alert('删除失败: ' + ((err && err.message) || err));
      }
    }

    const menuInjected = new WeakSet();

    const TRASH_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 4h10M6.5 4V2.8h3V4M5 4l.7 9h4.6L11 4M6.7 6.5v4.5M9.3 6.5v4.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    function augmentMenus() {
      if (!document.querySelector('[role="menu"]')) return;
      for (const menu of document.querySelectorAll('[role="menu"]')) {
        if (!(menu instanceof HTMLElement)) continue;
        if (menu.querySelector('[data-dsh-sync-delete]')) continue; // 已注入(React 重渲染也不重复加)
        let archiveBtn = null;
        for (const btn of menu.querySelectorAll('button[role="menuitem"]')) {
          const label = (btn.textContent || '').trim();
          if (MENU_LABELS.has(label)) { archiveBtn = btn; break; }
        }
        if (!archiveBtn) continue;
        menuInjected.add(menu);
        // 分隔线
        const sep = document.createElement('div');
        sep.setAttribute('role', 'separator');
        sep.className = 'dss-menu-sep';
        // 删除项:克隆原生「归档会话」项保证样式一致,图标换成垃圾桶
        const item = archiveBtn.cloneNode(true);
        item.setAttribute('data-dsh-sync-delete', '1');
        item.classList.add('dss-menu-danger');
        let labelDone = false;
        for (const s of item.querySelectorAll('span')) {
          const cls = typeof s.className === 'string' ? s.className : '';
          if (cls.includes('icon')) { s.innerHTML = TRASH_SVG; continue; }
          if (cls.includes('label')) { s.textContent = '删除…'; labelDone = true; }
        }
        if (!labelDone) {
          const spans = item.querySelectorAll('span');
          if (spans.length) spans[spans.length - 1].textContent = '删除…';
        }
        item.addEventListener('click', (ev) => {
          ev.stopPropagation();
          onMenuDelete(item);
        });
        menu.appendChild(sep);
        menu.appendChild(item);
      }
    }

    function setupMenuDelete() {
      const obs = new MutationObserver(augmentMenus);
      const mount = () => {
        if (document.body) obs.observe(document.body, { childList: true, subtree: true });
        else setTimeout(mount, 200);
      };
      mount();
      augmentMenus();
      return () => obs.disconnect();
    }

    /* ---------- 挂载 ---------- */
    function apply(ctx) {
      // 侧栏底部同步按钮:原生注入不遮挡(收起侧栏自动变纯图标)
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'dsh-sync-sync',
      }, FootSyncButton));
      // 设置面板分节:同步状态卡 + 已归档对话(实时/排序/搜索/删除)
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-sync-manage',
        order: 400,
        label: '同步 · 会话管理',
      }, Section));
      // 侧栏会话「…」菜单注入「删除…」
      if (typeof ctx.effect === 'function') {
        ctx.effect(setupMenuDelete, 'ui-dsh-sync: 会话菜单删除注入');
      } else {
        setupMenuDelete();
      }
    }

    module.exports = {
      name: 'dsh-sync',
      inject: ['slots'],
      apply,
    };
    return module.exports;
  },
});
