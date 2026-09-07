/**
 * dsh-sync-plugin 浏览器端 bundle
 *
 * - 侧栏底部「⟳ 同步」按钮:sidebar.footer.action 槽位原生注入(宽侧栏显示图标+文字,
 *   收起侧栏自动变成纯图标);同步进行中实时显示当前阶段(取远端/提交/推送…)与耗时,
 *   按钮上方有常驻进度气泡;
 * - 设置面板「同步」分节:同步状态卡(远端 / 分支 / 模式 / 工作区数 / 上次结果,含详细
 *   错误信息)+「立即同步」胶囊按钮。
 *
 * 只做「同步」:不提供会话浏览/归档/删除等管理功能,那些由 DSH 原生 UI 承担。
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
    };

    /* 气泡提示:挂在触发元素附近,结果反馈保留较长时间便于排障(8s 后淡出) */
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
        setTimeout(() => { b.style.opacity = '0'; }, 8000);
        setTimeout(() => { b.remove(); }, 8600);
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
      /* 进度气泡(常驻,直到同步结束) */
      '.dss-progress{white-space:nowrap}',
      /* 设置分节:对齐原生设置——无框无底色,组间 hairline 分隔 */
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
      '.dss-err{color:var(--dsw-alias-state-error-primary,#d33);font-size:12px;margin:6px 0;white-space:pre-wrap;word-break:break-all}',
      '.dss-ok{color:var(--dsw-alias-state-success-primary,#9cd29c);font-size:12px;margin:6px 0;white-space:pre-wrap;word-break:break-all}',
      '.dss-empty{color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.6));font-size:12px;margin:8px 0}',
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

    /* ---------- 同步状态共享(含实时进度轮询) ---------- */
    const STAGE_SHORT = {
      prepare: '准备', fetch: '取远端', commit: '提交', analyze: '比对',
      pull: '拉取', merge: '合并', push: '推送', gc: '清理', ws: '工作区', done: '', error: '',
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
          const width = Math.min(360, Math.max(160, String(p.label || '').length * 13 + 80));
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
          'aria-label': '同步 DSH 会话数据',
          title,
          disabled: busy,
          onClick: () => { refresh(); run(ref.current); },
        },
          e(SyncIcon, { spin: busy }),
          wide ? e('span', null, label) : null),
        busy ? e(ProgressTip, { anchorRef: ref, progress }) : null);
    }

    /* ---------- 设置分节:同步状态卡(只读状态 + 立即同步) ---------- */
    /* 把上次结果(含错误明细)渲染成一段可排障的文本 */
    function lastDetailText(lastDetail) {
      if (!lastDetail) return '';
      const lines = [];
      const act = [];
      if (lastDetail.committed) act.push('提交');
      if (lastDetail.pushed) act.push('推送');
      if (lastDetail.pulled && lastDetail.pulled !== 'reset') act.push('拉取(' + lastDetail.pulled + ')');
      if (lastDetail.pulled === 'reset') act.push('整体取回');
      if (act.length) lines.push('本次动作: ' + act.join(' / '));
      if (lastDetail.skipped) lines.push('跳过: ' + lastDetail.skipped);
      if (lastDetail.backupBranch) lines.push('远端备份分支: ' + lastDetail.backupBranch);
      if (lastDetail.error) lines.push('主数据错误: ' + lastDetail.error);
      if (lastDetail.workspaces) {
        const w = lastDetail.workspaces;
        if (w.total) lines.push('工作区: 共 ' + w.total + ',已同步 ' + w.synced + ',推送 ' + w.pushed + ',拉取 ' + w.pulled + (w.skipped ? ',跳过 ' + w.skipped : ''));
        if (w.errors && w.errors.length) {
          lines.push('工作区失败(' + w.errors.length + '):');
          for (const err of w.errors) lines.push('  - ' + (err.title || err.id || '?') + ': ' + (err.error || '未知错误'));
        }
      }
      if (lastDetail.conflicts && lastDetail.conflicts.length) lines.push('冲突文件(保留本机): ' + lastDetail.conflicts.join(', '));
      return lines.join('\n');
    }

    function Section(props) {
      const { busy, status, progress, run, refresh } = useSync();
      const runRef = useRef(null);
      const onRun = () => { refresh(); run(runRef.current); };
      const detail = useMemo(() => (status ? lastDetailText(status.lastDetail) : ''), [status]);

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
              title: '全量同步:提交本地快照 + 与远端对齐(含各工作区文件夹内容)',
              onClick: onRun,
            }, e(SyncIcon, { spin: busy }), busy ? '同步中' : '立即同步')),
          /* 上次结果明细:错误保留很久便于排障 */
          detail
            ? (status && status.lastOk === false
                ? e('div', { className: 'dss-err' }, detail)
                : e('div', { className: 'dss-desc' }, detail))
            : (status && status.lastOk === false && status.lastMessage
                ? e('div', { className: 'dss-err' }, status.lastMessage)
                : null)));
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
      injectStyles(); // 侧栏胶囊按钮等样式全局注入,不依赖设置分节挂载
      // 侧栏底部同步按钮:原生注入不遮挡(收起侧栏自动变纯图标)
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'dsh-sync-sync',
      }, FootSyncButton));
      // 设置面板分节:同步状态卡(只读状态 + 上次结果(含错误) + 立即同步)
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-sync-manage',
        order: 400,
        label: '同步',
      }, Section));
    }

    module.exports = {
      name: 'dsh-sync-plugin',
      inject: ['slots'],
      apply,
    };
    return module.exports;
  },
});
