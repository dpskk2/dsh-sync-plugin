/**
 * dsh-sync-plugin 浏览器端 bundle
 *
 * - 侧栏底部「⟳ 同步」按钮:sidebar.footer.action 槽位原生注入(宽侧栏显示图标+文字,
 *   收起侧栏自动变成纯图标,不悬浮、不遮挡页面);同步进行中实时显示当前阶段
 *   (取远端/提交/推送…)与耗时,按钮上方有常驻进度气泡;
 * - 设置面板「同步 · 会话管理」分节:同步状态卡 + 已归档对话(实时 3s 刷新、标题、
 *   工作区、时间、大小)+ 全部会话(默认折叠)+ 排序(最后活动/创建时间/标题)+ 搜索 + 删除;
 * - 侧栏会话「…」菜单注入「删除…」(在原生「归档会话」下方):先调原生归档接口
 *   (宿主内存登记表同步更新,侧栏立即消失),再把文件移入回收站;不再整页刷新。
 *
 * 挂载方式:声明了 dsh.client 的依赖由 dsh 自动打包进浏览器 bundle,无需手工注入。
 */
window.__ModuleLoader__.load({
  id: 'dsh-sync-plugin',
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
      progress: () => fetch('/dsh-sync/api/progress').then((r) => r.json()),
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

    /* 插件激活时的客户端根上下文(用于按需取原生 uiWorkspace 服务) */
    let clientCtx = null;

    /* 删除会话(两步,顺序不能颠倒):
     * 1) 原生归档 uiWorkspace.archiveSession(id) —— 与原生「归档会话」菜单同一入口。
     *    宿主把会话登记表放在内存里,只改磁盘文件侧栏不会变(旧版“删了还在”的原因);
     *    归档走宿主内存 → 侧栏立即消失;若删的是当前打开的会话,原生策略会自动收起视图。
     * 2) 删除本地文件(移入 ~/.dsh/.trash)并清理 workspace.json。
     * 返回是否完成了原生归档(会话对宿主未知时归档失败,只删文件,侧栏条目重启后消失)。 */
    async function deleteSessionFull(id) {
      let archived = false;
      try {
        const uiw = clientCtx && typeof clientCtx.get === 'function' ? clientCtx.get('uiWorkspace') : null;
        if (uiw && typeof uiw.archiveSession === 'function') {
          await uiw.archiveSession(id);
          archived = true;
        }
      } catch (e) { /* 归档失败不阻塞文件删除 */ }
      const d = await API.del(id);
      if (!d || !d.ok) throw new Error((d && d.error) || '删除失败');
      return archived;
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
      /* 侧栏底部同步按钮(对齐原生设置功能键:hairline 圆角胶囊) */
      '.dss-foot{display:flex;align-items:center}',
      '.dss-foot-btn{display:inline-flex;align-items:center;gap:6px;flex:none;box-sizing:border-box;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.4));border-radius:14px;background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:12px;line-height:20px;cursor:pointer;white-space:nowrap;transition:background .12s,border-color .12s}',
      '.dss-foot-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));border-color:var(--dsw-alias-border-l4,rgba(127,127,127,.55))}',
      '.dss-foot-btn:active{background:var(--dsw-alias-interactive-bg-pressed,rgba(127,127,127,.22))}',
      '.dss-foot-btn:disabled{opacity:.5;cursor:default}',
      '@keyframes dss-spin{to{transform:rotate(360deg)}}',
      /* 结果/进度气泡 */
      '.dss-bubble{position:fixed;z-index:2147483000;max-width:340px;padding:8px 12px;border-radius:10px;',
      'background:var(--dsw-alias-bg-layer-2,rgba(26,26,30,.95));color:var(--dsw-alias-label-primary,#e9e9ee);',
      'border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.3));font-size:12px;line-height:1.55;white-space:pre-wrap;',
      'box-shadow:var(--dsw-elevation-prominent,0 2px 8px rgba(0,0,0,.3));transition:opacity .3s}',
      '.dss-bubble-err{color:var(--dsw-alias-state-error-primary,#f2b8b8)}',
      /* 设置分节:对齐原生设置——无框无底色,组间 hairline 分隔( AppearanceRow 同款 ) */
      '.dss-wrap{display:flex;flex-direction:column;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,inherit)}',
      '.dss-sec{display:flex;flex-direction:column;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22))}',
      '.dss-sec:last-child{border-bottom:none}',
      '.dss-rowline{display:flex;align-items:center;gap:12px}',
      '.dss-rowtext{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}',
      '.dss-h{color:var(--dsw-alias-label-primary,inherit);font-size:14px;font-weight:400;line-height:22px}',
      '.dss-desc{color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.8));font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-all}',
      '.dss-prog{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-tertiary,rgba(127,127,127,.8)));font-size:12px;line-height:18px}',
      /* pill 控件:原生设置同款 hairline 圆角胶囊 */
      '.dss-pill{display:inline-flex;align-items:center;gap:6px;flex:none;box-sizing:border-box;height:32px;padding:0 14px;border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.4));border-radius:18px;background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:13px;line-height:20px;cursor:pointer}',
      '.dss-pill:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
      '.dss-pill:disabled{opacity:.5;cursor:default}',
      '.dss-toolbar{display:flex;gap:8px;align-items:center;margin:0 0 4px}',
      '.dss-input{flex:1;min-width:0;height:32px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.4));border-radius:16px;padding:0 12px;font:inherit;font-size:13px;background:transparent;color:var(--dsw-alias-label-primary,inherit);outline:none}',
      '.dss-input::placeholder{color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.6))}',
      '.dss-input:focus{border-color:var(--dsw-static-neutral-bluish-400,rgba(120,150,220,.7))}',
      '.dss-select{flex:none;height:32px;border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.4));border-radius:16px;padding:0 8px;font:inherit;font-size:13px;background:transparent;color:var(--dsw-alias-label-primary,inherit);cursor:pointer;outline:none}',
      /* 会话列表:无框行 + hover 高亮;分组小标题用 tertiary 小字 */
      '.dss-sub{display:flex;align-items:center;gap:6px;margin:14px 0 2px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.8));font-size:12px;line-height:18px}',
      '.dss-subbtn{border:none;background:transparent;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-tertiary,inherit));font:inherit;font-size:12px;cursor:pointer;padding:2px 8px;border-radius:8px}',
      '.dss-subbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
      '.dss-item{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:10px}',
      '.dss-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}',
      '.dss-main{flex:1;min-width:0}',
      '.dss-title{color:var(--dsw-alias-label-primary,inherit);font-size:14px;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dss-meta{color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.7));font-size:12px;line-height:16px;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dss-badge{flex:none;color:var(--dsw-alias-label-tertiary,inherit);font-size:11px;border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.4));border-radius:6px;padding:1px 6px}',
      '.dss-del{flex:none;display:inline-flex;align-items:center;gap:4px;border:none;background:transparent;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.7));border-radius:8px;padding:4px 8px;font:inherit;font-size:12px;cursor:pointer;opacity:.75}',
      '.dss-del:hover{opacity:1;color:var(--dsw-alias-state-error-primary,#d33);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}',
      '.dss-del:disabled{opacity:.4;cursor:default}',
      '.dss-empty{color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.6));font-size:12px;margin:8px 0}',
      '.dss-err{color:var(--dsw-alias-state-error-primary,#d33);font-size:12px;margin:6px 0}',
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

    /* ---------- 同步状态共享(含实时进度轮询) ---------- */
    const STAGE_SHORT = {
      prepare: '准备', fetch: '取远端', commit: '提交', analyze: '比对',
      pull: '拉取', merge: '合并', push: '推送', gc: '清理', done: '', error: '',
    };
    function fmtElapsed(ms) {
      const s = Math.max(0, Math.round(ms / 100) / 10);
      if (s < 60) return (s % 1 === 0 ? String(s) : s.toFixed(1)) + 's';
      return Math.floor(s / 60) + ' 分 ' + Math.round(s % 60) + ' 秒';
    }
    function useSync() {
      const [busy, setBusy] = useState(false);
      const [status, setStatus] = useState(null);
      const [progress, setProgress] = useState(null);
      const pollRef = useRef(null);
      const stopPoll = useCallback(() => {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      }, []);
      const startPoll = useCallback(() => {
        stopPoll();
        const tick = () => API.progress().then(setProgress).catch(() => {});
        tick();
        pollRef.current = setInterval(tick, 500);
      }, [stopPoll]);
      const refresh = useCallback(() => {
        API.status().then((d) => setStatus(d)).catch(() => {});
      }, []);
      const run = useCallback(async (anchor) => {
        if (busy) return;
        setBusy(true);
        startPoll();
        try {
          const d = await API.run();
          bubble(anchor, (d && d.summary) || (d && d.error) || '同步完成', Boolean(d && d.ok));
        } catch (err) {
          bubble(anchor, err.message || String(err), false);
        } finally {
          stopPoll();
          setBusy(false);
          refresh();
          API.progress().then(setProgress).catch(() => {});
        }
      }, [busy, refresh, startPoll, stopPoll]);
      useEffect(() => {
        refresh();
        return stopPoll; // 卸载时停掉轮询
      }, [refresh, stopPoll]);
      return { busy, status, progress, refresh, run };
    }

    /* 同步进行中的常驻进度气泡:贴在锚点元素上方,实时显示阶段与耗时 */
    function ProgressTip(props) {
      const anchorRef = props.anchorRef;
      const p = props.progress || {};
      const [pos, setPos] = useState(null);
      useEffect(() => {
        const update = () => {
          const el = anchorRef && anchorRef.current;
          if (!(el && el.getBoundingClientRect)) return;
          const r = el.getBoundingClientRect();
          const width = Math.min(320, Math.max(150, String(p.label || '').length * 13 + 80));
          setPos({
            left: Math.max(12, Math.min(r.left, window.innerWidth - width - 12)),
            top: Math.max(12, r.top - 10),
          });
        };
        update();
        window.addEventListener('resize', update);
        return () => window.removeEventListener('resize', update);
      }, [anchorRef, p.stage, p.label]);
      if (!pos) return null;
      const elapsed = p.startedAt ? ' · ' + fmtElapsed(Date.now() - p.startedAt) : '';
      return e('div', {
        className: 'dss-bubble dss-progress',
        style: { left: pos.left + 'px', top: pos.top + 'px', transform: 'translateY(-100%)', transition: 'none' },
      }, '⟳ ' + (p.label || '同步中…') + elapsed);
    }

    /* ---------- 侧栏底部「⟳ 同步」按钮 ---------- */
    function FootSyncButton(props) {
      const wide = props.wide !== false;
      const ref = useRef(null);
      const { busy, status, progress, run, refresh } = useSync();
      const stage = STAGE_SHORT[progress && progress.stage] || '';
      const label = busy ? (stage ? stage + '…' : '同步中…') : '同步';
      const elapsed = busy && progress && progress.startedAt ? ' · 已用时 ' + fmtElapsed(Date.now() - progress.startedAt) : '';
      const title = (status && status.remote
        ? `一键同步 → ${status.branch}\n${status.remote}`
        : '一键同步(本地快照;未配置远端仓库)\n在 ~/.dsh/dsh-sync.json 配置 remote 后启用云同步')
        + (busy ? `\n\n同步中: ${progress ? progress.label : '…'}${elapsed}` : '');
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
          wide ? e('span', null, label) : null),
        busy ? e(ProgressTip, { anchorRef: ref, progress }) : null);
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
          '删除会话「' + title + '」?\n\n' + r.id + '\n\n侧栏立即移除;记录移入本地回收站(可找回);点「同步」后其他电脑上的同一会话也会被删除。',
        );
        if (!okDel) return;
        setBusy(true);
        deleteSessionFull(r.id)
          .then((archived) => {
            bubble(ref.current, archived
              ? '已删除「' + title + '」:侧栏已移除,文件在 ~/.dsh/.trash'
              : '已删除「' + title + '」:文件在 ~/.dsh/.trash;侧栏条目将在重启 dsh 后消失', true);
            if (typeof props.onDeleted === 'function') props.onDeleted(r.id);
            setBusy(false);
          })
          .catch((err) => {
            bubble(ref.current, err.message || String(err), false);
            setBusy(false);
          });
      };
      return e('div', { className: 'dss-item', ref },
        e('div', { className: 'dss-main' },
          e('div', { className: 'dss-title', title: r.id + '\n' + meta }, title),
          e('div', { className: 'dss-meta' }, meta)),
        r.archived ? e('span', { className: 'dss-badge' }, '已归档') : null,
        e('button', { type: 'button', className: 'dss-del', disabled: busy, title: '移入回收站(可找回)', onClick: onDel },
          e(TrashIcon, null), busy ? '删除中…' : '删除'));
    }

    function Section(props) {
      const [rows, setRows] = useState(null);
      const [msg, setMsg] = useState('');
      const [filter, setFilter] = useState(() => localStorage.getItem('dsh-sync.filter') || '');
      const [sortBy, setSortBy] = useState(() => localStorage.getItem('dsh-sync.sort') || 'updated');
      const [showAll, setShowAll] = useState(() => localStorage.getItem('dsh-sync.showAll') === '1');
      const runRef = useRef(null);
      const { busy, status, progress, run, refresh } = useSync();

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
      /* 删除成功后的即时反馈:本地列表立刻去掉该行,并作废缓存让下轮轮询强制重取 */
      const onDeleted = useCallback((id) => {
        sessionsCache.at = 0;
        setRows((rs) => (rs || []).filter((x) => x.id !== id));
      }, []);

      const statusDesc = (() => {
        if (!status) return '正在读取同步状态…';
        if (status.gitMissing) return '未检测到 git,无法同步 —— 请先安装 git。';
        if (!status.remote) {
          return '未配置远端仓库,当前仅本地快照(免费获得版本历史)。\n'
            + '编辑 ~/.dsh/dsh-sync.json 填入 GitHub 私有仓库地址即可启用云同步。';
        }
        return status.remote + '\n'
          + '分支 ' + status.branch + ' · ' + (status.auto ? '自动模式' : '手动模式')
          + (status.workspaceCount ? ' · ' + status.workspaceCount + ' 个工作区' : '')
          + (status.lastOk === false ? ' · 上次失败' : '')
          + (status.lastMessage ? '\n上次:' + status.lastMessage : '');
      })();

      return e('div', { className: 'dss-wrap' },
        e('style', null, STYLE),
        /* —— 同步组:标题 + 状态描述 + 立即同步(pill)—— */
        e('div', { className: 'dss-sec' },
          e('div', { className: 'dss-rowline' },
            e('div', { className: 'dss-rowtext' },
              e('div', { className: 'dss-h' }, '同步'),
              busy
                ? e('div', { className: 'dss-prog' },
                    e(SyncIcon, { spin: true }),
                    (progress && progress.label) || '同步中…',
                    progress && progress.startedAt ? e('span', { className: 'dss-desc' }, '· ' + fmtElapsed(Date.now() - progress.startedAt)) : null)
                : e('div', { className: 'dss-desc' }, statusDesc)),
            e('button', {
              type: 'button', className: 'dss-pill', ref: runRef,
              disabled: busy || Boolean(status && status.gitMissing),
              title: '全量同步:提交本地快照 + 与远端对齐',
              onClick: onRun,
            }, e(SyncIcon, { spin: busy }), busy ? '同步中' : '立即同步'))),
        /* —— 会话管理组 —— */
        e('div', { className: 'dss-sec' },
          e('div', { className: 'dss-toolbar' },
            e('input', {
              type: 'search', className: 'dss-input', placeholder: '搜索标题 / id…', value: filter, onChange: onFilter,
            }),
            e('select', { className: 'dss-select', value: sortBy, onChange: onSort },
              e('option', { value: 'updated' }, '按最后活动'),
              e('option', { value: 'created' }, '按创建时间'),
              e('option', { value: 'title' }, '按标题'))),
          msg ? e('div', { className: 'dss-err' }, msg) : null,
          rows === null
            ? e('div', { className: 'dss-empty' }, '正在读取会话列表…')
            : null,
          rows !== null && listed !== null && listed.length === 0
            ? e('div', { className: 'dss-empty' }, filter ? '没有匹配「' + filter + '」的会话' : '(本机没有会话)')
            : null,
          archivedList.length
            ? e('div', null,
                e('div', { className: 'dss-sub' }, '已归档对话(' + archivedList.length + ') · 每 3 秒自动刷新'),
                archivedList.map((r) => e(SessionRow, { key: r.id, r, onDeleted })))
            : null,
          otherList.length
            ? e('div', null,
                e('div', { className: 'dss-sub' },
                  e('button', { type: 'button', className: 'dss-subbtn', onClick: onToggleAll },
                    showAll ? '▾' : '▸', ' 全部会话(' + otherList.length + ')')),
                showAll ? otherList.map((r) => e(SessionRow, { key: r.id, r, onDeleted })) : null)
            : null));
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
          '删除会话「' + (cand.title || cand.id) + '」?\n\n' + cand.id + '\n\n侧栏立即移除;记录移入本地回收站(可找回);点「同步」后其他电脑也会删除。',
        );
        if (!okDel) return;
        const archived = await deleteSessionFull(cand.id);
        // Escape 关掉菜单;侧栏由原生归档事件驱动自行更新,无需整页刷新
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        if (!archived) {
          window.alert('已删除文件(在 ~/.dsh/.trash,可找回)。\n该会话对宿主不可归档,侧栏条目将在重启 dsh 后消失。');
        }
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
    let stylesInjected = false;
    function injectStyles() {
      if (stylesInjected || typeof document === 'undefined') return;
      stylesInjected = true;
      try {
        const el = document.createElement('style');
        el.setAttribute('data-dsh-sync-plugin', '');
        el.textContent = STYLE;
        document.head.appendChild(el);
      } catch { /* ignore */ }
    }
    function apply(ctx) {
      clientCtx = ctx; // 供 deleteSessionFull 按需取原生 uiWorkspace(归档)服务
      injectStyles(); // 侧栏胶囊按钮等样式全局注入,不再依赖设置分节挂载
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
      name: 'dsh-sync-plugin',
      inject: ['slots'],
      apply,
    };
    return module.exports;
  },
});
