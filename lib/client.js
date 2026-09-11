/**
 * dsh-sync-plugin 浏览器端 bundle
 *
 * - 侧栏底部「⟳ 同步」按钮:sidebar.footer.action 槽位原生注入(宽侧栏显示图标+文字,
 *   收起侧栏自动变成纯图标);同步进行中实时显示当前阶段(取远端/提交/推送…)与耗时,
 *   按钮上方有常驻进度气泡;
 * - 设置面板「同步」分节:同步状态卡(远端 / 分支 / 模式 / 工作区数 / 上次结果,含详细
 *   错误信息)+「立即同步」胶囊按钮;
 * - 设置面板「归档会话」分节:列出全部会话(含已归档/幽灵),点击任一行即可展开预览
 *   对话内容,可「取消归档」回到侧边栏或「彻底删除」(乐观更新,删除即时反映)。
 *
 * 挂载方式:声明了 dsh.client 的依赖由 dsh 自动打包进浏览器 bundle,无需手工注入。
 */
// dsh-sync-plugin patch: progress elapsed 1s ticker (已用时独立 1s 走秒,消除 500ms 轮询闪动)
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
      config: () => fetch('/dsh-sync/api/config').then((r) => r.json()),
      saveConfig: (patch) => fetch('/dsh-sync/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }).then((r) => r.json()),
      conflicts: () => fetch('/dsh-sync/api/conflicts').then((r) => r.json()),
      resolve: (c) => fetch('/dsh-sync/api/conflict/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(c),
      }).then((r) => r.json()),
      conflictPreview: (c) => fetch('/dsh-sync/api/conflict/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: c.path, copy: c.copy }),
      }).then((r) => r.json()),
      workspacePath: (workspaceId, path) => fetch('/dsh-sync/api/workspace/path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, path }),
      }).then((r) => r.json()),
      sessions: () => fetch('/dsh-sync/api/sessions').then((r) => r.json()),
      preview: (id) => fetch('/dsh-sync/api/session/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      }).then((r) => r.json()),
      unarchive: (id) => fetch('/dsh-sync/api/session/unarchive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      }).then((r) => r.json()),
      delSession: (id) => fetch('/dsh-sync/api/session/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      }).then((r) => r.json()),
      flush: () => fetch('/dsh-sync/api/session/flush', { method: 'POST' }).then((r) => r.json()),
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

    /* 退出设置页的统一提交:删除/取消归档结果合并为一次提交+推送。阻塞遮罩 + beforeunload
       防用户中途关闭页面/结束进程(服务端另有 60s 静默期兜底刷新)。 */
    function flushPendingOps() {
      let overlay = null;
      try {
        overlay = document.createElement('div');
        overlay.className = 'dss-flush-mask';
        const card = document.createElement('div');
        card.className = 'dss-flush-card';
        const spin = document.createElement('div');
        spin.className = 'dss-flush-spin';
        const title = document.createElement('div');
        title.className = 'dss-flush-title';
        title.textContent = '正在同步会话操作结果…';
        const desc = document.createElement('div');
        desc.className = 'dss-flush-desc';
        desc.textContent = '删除 / 取消归档会在退出设置页时统一提交+推送。\n请勿关闭本页或结束 dsh 进程,完成后自动关闭。';
        card.appendChild(spin); card.appendChild(title); card.appendChild(desc);
        overlay.appendChild(card);
        document.body.appendChild(overlay);
      } catch { /* 遮罩失败仍尝试同步 */ }
      const onBeforeUnload = (ev) => { try { ev.preventDefault(); ev.returnValue = ''; } catch { /* ignore */ } };
      window.addEventListener('beforeunload', onBeforeUnload);
      return API.flush().catch(() => null).finally(() => {
        window.removeEventListener('beforeunload', onBeforeUnload);
        if (overlay) { try { overlay.remove(); } catch { /* ignore */ } }
      });
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
      /* 退出设置页统一提交的阻塞遮罩(防用户中途结束进程) */
      '.dss-flush-mask{position:fixed;inset:0;z-index:2147483100;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}',
      '.dss-flush-card{max-width:360px;padding:18px 22px;border-radius:14px;background:var(--dsw-alias-bg-layer-2,rgba(26,26,30,.97));color:var(--dsw-alias-label-primary,#e9e9ee);border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.3));box-shadow:var(--dsw-elevation-prominent,0 2px 8px rgba(0,0,0,.3));text-align:center}',
      '.dss-flush-spin{width:22px;height:22px;margin:0 auto 10px;border:2px solid rgba(127,127,127,.3);border-top-color:var(--dsw-alias-accent-color,rgba(110,168,254,.9));border-radius:50%;animation:dss-spin 1s linear infinite}',
      '.dss-flush-title{font-size:14px;font-weight:500;line-height:22px}',
      '.dss-flush-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.8));margin-top:6px;white-space:pre-wrap}',
      /* 实时传输行 + 百分比进度条(上传/下载字节与速度) */
      '.dss-tx{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.78));margin-top:4px;white-space:nowrap}',
      '.dss-bar{height:3px;border-radius:2px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.22));overflow:hidden;margin-top:4px;min-width:150px}',
      '.dss-bar-in{height:100%;background:var(--dsw-alias-accent-color,rgba(110,168,254,.85));transition:width .25s}',
      /* 设置分节:对齐原生设置——无框无底色,组间 hairline 分隔 */
      '.dss-wrap{display:flex;flex-direction:column;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,inherit)}',
      '.dss-sec{display:flex;flex-direction:column;padding:20px 0;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22))}',
      '.dss-sec:last-child{border-bottom:none}',
      '.dss-rowline{display:flex;align-items:center;gap:12px}',
      '.dss-rowtext{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}',
      '.dss-h{color:var(--dsw-alias-label-primary,inherit);font-size:14px;font-weight:400;line-height:22px}',
      '.dss-desc{color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.8));font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-all}',
      '.dss-prog{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-tertiary,rgba(127,127,127,.8)));font-size:12px;line-height:18px}',
      /* pill 控件:原生设置同款 hairline 圆角胶囊 */
      '.dss-pill{display:inline-flex;align-items:center;gap:6px;flex:none;box-sizing:border-box;height:32px;padding:0 14px;border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.4));border-radius:18px;background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:13px;line-height:20px;cursor:pointer}',
      '.dss-pill:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
      '.dss-pill:disabled{opacity:.5;cursor:default}',
      '.dss-restartrow{padding-top:10px;margin-top:2px}',
      /* switch 开关:对齐原生设置(胶囊轨道 + 滑动圆钮) */
      '.dss-switch{position:relative;flex:none;box-sizing:border-box;width:36px;height:20px;border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.45));border-radius:11px;background:rgba(127,127,127,.12);cursor:pointer;transition:background .15s,border-color .15s;padding:0}',
      '.dss-switch-on{background:var(--dsw-alias-interactive-bg-active,rgba(90,160,255,.35));border-color:rgba(90,160,255,.55)}',
      '.dss-switch-knob{position:absolute;top:2.5px;left:2.5px;width:13px;height:13px;border-radius:50%;background:var(--dsw-alias-label-secondary,rgba(127,127,127,.85));transition:left .15s,background .15s}',
      '.dss-switch-on .dss-switch-knob{left:18.5px;background:var(--dsw-alias-label-primary,#fff)}',
      '.dss-err{color:var(--dsw-alias-state-error-primary,#d33);font-size:12px;margin:6px 0;white-space:pre-wrap;word-break:break-all}',
      '.dss-ok{color:var(--dsw-alias-state-success-primary,#9cd29c);font-size:12px;margin:6px 0;white-space:pre-wrap;word-break:break-all}',
      /* 冲突(「双边保留」)行 */
      '.dss-confrow{display:flex;flex-direction:column;gap:4px;padding:8px 0}',
      '.dss-confpath{color:var(--dsw-alias-label-primary,inherit);font-size:12px;word-break:break-all}',
      '.dss-confmeta{color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.7));font-size:11px;word-break:break-all}',
      '.dss-cachehint{color:var(--dsw-alias-state-warn-label,#e6b455)}',
      '.dss-confbtns{display:flex;gap:6px;flex-wrap:wrap}',
      '.dss-confbtn{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.4));border-radius:12px;background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:12px;line-height:18px;cursor:pointer}',
      '.dss-confbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
      '.dss-confbtn:disabled{opacity:.5;cursor:default}',
      '.dss-confprev{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2));padding-top:8px}',
      '.dss-confprev .dss-pv{max-height:320px;overflow:auto;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2));border-radius:10px;padding:10px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05))}',
      '.dss-prevhead{font-size:11px;font-weight:500;line-height:16px;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.85));margin-bottom:6px}',
      '.dss-wsbanner{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-top:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2))}',
      '.dss-wsbanner:first-of-type{border-top:none}',
      '.dss-wsbanner-text{flex:1;min-width:0}',
      '.dss-wsbanner-title{font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-primary,inherit)}',
      '.dss-empty{color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.6));font-size:12px;margin:8px 0}',
      /* —— 归档会话管理处:分组标题 / 统计行 —— */
      '.dss-sub{display:flex;align-items:center;gap:8px;margin:18px 0 6px;font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.8))}',
      '.dss-sub:first-child{margin-top:10px}',
      '.dss-count{margin:14px 0 4px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.75));font-size:12px;line-height:18px}',
      /* —— 会话行:卡片式,可点击展开预览 —— */
      '.dss-item{display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2));border-radius:12px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05));margin:8px 0;overflow:hidden;transition:border-color .15s,background .15s}',
      '.dss-item:hover{border-color:var(--dsw-alias-border-l4,rgba(127,127,127,.42))}',
      '.dss-item-open{border-color:var(--dsw-alias-border-l4,rgba(127,127,127,.55))}',
      '.dss-item-row{display:flex;align-items:center;gap:12px;padding:12px 14px}',
      '.dss-item-main{display:flex;align-items:flex-start;gap:9px;flex:1;min-width:0;padding:0;border:none;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer}',
      '.dss-item-main:hover .dss-title{color:var(--dsw-alias-label-primary,inherit)}',
      '.dss-chev{flex:none;width:14px;height:14px;margin-top:2px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.7));transition:transform .15s}',
      '.dss-chev-open{transform:rotate(90deg)}',
      '.dss-item-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}',
      '.dss-title{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,inherit);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dss-meta{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.75));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dss-badge{flex:none;align-self:flex-start;margin-top:2px;font-size:10px;line-height:16px;padding:0 7px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.4));color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.8));white-space:nowrap}',
      '.dss-badge-arch{color:var(--dsw-alias-state-warn-label,#e6b455);border-color:rgba(230,170,60,.45)}',
      /* —— 操作按钮:中性「取消归档」+ 危险「彻底删除」 —— */
      '.dss-item-acts{flex:none;display:flex;align-items:center;gap:8px}',
      '.dss-btn{display:inline-flex;align-items:center;gap:5px;flex:none;box-sizing:border-box;height:28px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.4));border-radius:14px;background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap;transition:background .12s,border-color .12s,color .12s}',
      '.dss-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
      '.dss-btn:disabled{opacity:.45;cursor:default;background:transparent}',
      '.dss-btn-restore:hover{border-color:var(--dsw-alias-border-l4,rgba(127,127,127,.6))}',
      '.dss-btn-del{color:var(--dsw-alias-state-error-primary,#f2b8b8);border-color:rgba(244,120,120,.35)}',
      '.dss-btn-del:hover{background:var(--dsw-alias-interactive-bg-hover-danger,rgba(240,90,90,.16));border-color:rgba(244,120,120,.55)}',
      /* —— 预览面板:消息气泡 —— */
      '.dss-item-pv{border-top:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2));padding:12px 14px;background:var(--dsw-alias-bg-layer-2,rgba(26,26,30,.35));max-height:460px;overflow:auto}',
      '.dss-pv{display:flex;flex-direction:column;gap:12px}',
      '.dss-pv-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}',
      '.dss-pv-title{font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-primary,inherit);max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dss-pv-count{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.75))}',
      '.dss-pv-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.8));padding:2px 0}',
      '.dss-pv-list{display:flex;flex-direction:column;gap:12px}',
      '.dss-msg{display:flex;flex-direction:column;gap:3px}',
      '.dss-msg-role{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.7))}',
      '.dss-msg-text{font-size:12px;line-height:20px;white-space:pre-wrap;word-break:break-word;border-radius:10px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2))}',
      '.dss-msg-user .dss-msg-text{border-color:rgba(110,168,254,.32)}',
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

    /* ---------- 归档会话管理图标 ---------- */
    function ChevIcon(props) {
      return e('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', className: props.className, style: props.style, 'aria-hidden': true },
        e('path', { d: 'M6 3.5l5 4.5-5 4.5', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }));
    }
    function RestoreIcon() {
      return e('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        e('path', { d: 'M8 3.5a4.5 4.5 0 1 1-4.2 6', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
        e('path', { d: 'M2.5 6.5v-4h4', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }));
    }
    function TrashIcon() {
      return e('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        e('path', { d: 'M2.5 4.5h11', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
        e('path', { d: 'M6.5 2.5h3', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
        e('path', { d: 'M4 4.5l.7 9h6.6l.7-9', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        e('path', { d: 'M6.5 7v4M9.5 7v4', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }));
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
    function fmtSpeed(bps) {
      if (!bps && bps !== 0) return '';
      const m = bps / 1048576;
      if (m >= 1) return m.toFixed(2) + ' MiB/s';
      return (bps / 1024).toFixed(1) + ' KiB/s';
    }
    /* 已用时:独立 1s 走秒(整秒),避免 500ms 轮询重渲染时数字逐帧变化 → 视觉闪动 */
    function ElapsedText(props) {
      const startedAt = props.startedAt;
      const [now, setNow] = useState(Date.now());
      useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
      }, []);
      if (!startedAt) return null;
      return e('span', { className: props.className || null },
        (props.prefix || '') + fmtElapsed(Math.floor((now - startedAt) / 1000) * 1000));
    }

    /* 实时传输行:仓库 + 方向 + 字节 + 速度 + 百分比进度条(数据来自 /api/progress 的 transfer,
       由宿主端解析 git --progress 的 stderr 得到) */
    function TransferLine(props) {
      const t = props.t;
      if (!t) return null;
      const dir = t.op === 'push' ? '上传' : '下载';
      const parts = [];
      if (t.label) parts.push(t.label + ':');
      if (t.size != null) parts.push(dir + ' ' + fmtBytes(t.size));
      if (t.speed != null) parts.push(fmtSpeed(t.speed));
      if (t.pct != null) parts.push(t.pct + '%');
      const bar = (t.pct != null && t.total != null)
        ? e('div', { className: 'dss-bar' }, e('div', { className: 'dss-bar-in', style: { width: Math.max(0, Math.min(100, t.pct)) + '%' } }))
        : null;
      return e('div', { className: 'dss-tx' }, parts.join(' · '), bar);
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
      return e('div', {
        className: 'dss-bubble dss-progress',
        style: { left: pos.left + 'px', top: pos.top + 'px', transform: 'translateY(-100%)', transition: 'none' },
      }, e('span', null, '⟳ ' + (p.label || '同步中…')),
        p.startedAt ? e(ElapsedText, { startedAt: p.startedAt, prefix: ' · ' }) : null,
        p.transfer ? e(TransferLine, { t: p.transfer }) : null);
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
    /* 字节数 → 可读文本(与宿主端 humanSize 同规则) */
    function fmtBytes(b) {
      if (!b && b !== 0) return '';
      const abs = Math.abs(b);
      if (abs >= 1024 ** 3) return (b / 1024 ** 3).toFixed(2) + ' GiB';
      if (abs >= 1024 ** 2) return (b / 1024 ** 2).toFixed(2) + ' MiB';
      if (abs >= 1024) return (b / 1024).toFixed(1) + ' KiB';
      return b + ' B';
    }
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
      if (lastDetail.durationMs != null) lines.push('耗时: ' + (lastDetail.durationMs / 1000).toFixed(1) + 's');
      if (lastDetail.transfers && lastDetail.transfers.length) {
        lines.push('传输:');
        for (const t of lastDetail.transfers) {
          const dir = t.op === 'push' ? '上传' : '下载';
          lines.push('  - ' + (t.label || t.op) + ': ' + dir + ' ' + fmtBytes(t.size)
            + (t.speed != null ? ' @ ' + (t.speed / 1024 / 1024).toFixed(2) + ' MiB/s' : '')
            + (t.totalObjects != null ? ' (' + t.totalObjects + ' 对象' + (t.reused ? ',复用 ' + t.reused : '') + ')' : ''));
        }
      }
      if (lastDetail.repoSize != null) lines.push('仓库体积: ' + fmtBytes(lastDetail.repoSize));
      if (lastDetail.stages && lastDetail.stages.length) {
        const st = lastDetail.stages.filter((s) => s.ms >= 50);
        if (st.length) {
          lines.push('阶段耗时:');
          for (const s of st) lines.push('  - ' + s.stage + ': ' + (s.ms / 1000).toFixed(1) + 's');
        }
      }
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
      if (lastDetail.conflictCopies && lastDetail.conflictCopies.length) {
        lines.push('冲突「双边保留」(' + lastDetail.conflictCopies.length + ') 待裁决:');
        for (const c of lastDetail.conflictCopies) {
          lines.push('  - ' + (c.kind === 'ws' ? '[工作区' + (c.id || '?') + '] ' : '') + c.path + (c.copy ? '\n      远端版本: ' + c.copy : ''));
        }
      }
      return lines.join('\n');
    }

    /* ---------- 冲突行:「双边保留」的冲突,给用户抉择保留哪一侧 ---------- */
    const RESOLUTIONS = [
      ['local', '保留本机'],
      ['remote', '采用远端'],
      ['both', '两侧都留'],
    ];
    function ConflictRow(props) {
      const c = props.conflict;
      const [busy, setBusy] = useState(false);
      const [preview, setPreview] = useState(null); // null | 'loading' | {local, remote}
      const [showPrev, setShowPrev] = useState(false);
      const label = (c.kind === 'ws' ? '[工作区' + (c.id || '?') + '] ' : '') + (c.title || c.path);
      const onResolve = (res) => {
        if (busy) return;
        const msg = '裁决冲突「' + label + '」?\n\n'
          + '保留本机: 删除远端版本拷贝,保留本机版本为活动文件\n'
          + '采用远端: 用远端版本拷贝覆盖本机版本\n'
          + '两侧都留: 两者都保留(不删除远端拷贝)\n\n'
          + (c.copy ? '远端版本拷贝: ' + c.copy : '(无远端版本拷贝)');
        if (!window.confirm(msg)) return;
        setBusy(true);
        API.resolve({ kind: c.kind, id: c.id, path: c.path, copy: c.copy, resolution: res })
          .then((d) => {
            if (d && d.ok) { bubble(null, d.summary || '已裁决', true); if (typeof props.onResolved === 'function') props.onResolved(); }
            else { bubble(null, (d && d.error) || '裁决失败', false); }
          })
          .catch((err) => bubble(null, err.message || String(err), false))
          .finally(() => setBusy(false));
      };
      const onPreview = () => {
        if (showPrev) { setShowPrev(false); return; }
        setShowPrev(true);
        if (preview) return;
        setPreview('loading');
        API.conflictPreview(c)
          .then((d) => { setPreview(d && d.ok ? d : null); if (!(d && d.ok)) bubble(null, (d && d.error) || '预览失败', false); })
          .catch((err) => { setPreview(null); bubble(null, err.message || String(err), false); });
      };
      const renderMsgs = (p) => {
        if (!p || p.found === false) return e('div', { className: 'dss-pv-hint' }, p && p.found === false ? '本侧没有文件(可能已被删除)' : '无内容');
        if (p.error) return e('div', { className: 'dss-pv-hint' }, '读取失败: ' + p.error);
        if (p.binary) return e('div', { className: 'dss-pv-hint' }, '二进制文件,无法预览(大小 ' + p.bytes + 'B)');
        if (p.kind === 'text' || (p.text !== undefined && p.messages === undefined)) return e('div', { className: 'dss-pv-diff' },
          e('pre', { className: 'dss-pv-pre', style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0, fontSize: '12px', lineHeight: 1.5 } }, p.text || '(空文件)'));
        return e('div', { className: 'dss-pv-list' }, p.messages.map((m, i) => e('div', { key: i, className: 'dss-msg' + (m.role === 'user' ? ' dss-msg-user' : '') },
          e('div', { className: 'dss-msg-role' }, m.role === 'user' ? '你' : '助手'),
          e('div', { className: 'dss-msg-text' }, m.text))));
      };
      return e('div', { className: 'dss-confrow' },
        e('div', { className: 'dss-confpath', title: c.path }, label),
        e('div', { className: 'dss-confmeta' }, c.copy ? ('远端版本拷贝: ' + c.copy) : '无远端版本拷贝'),
        c.cache ? e('div', { className: 'dss-confmeta dss-cachehint' }, '会话投影缓存(可再生):保留本机即可,下次同步会自动清理') : null,
        e('div', { className: 'dss-confbtns' },
          e('button', {
            key: 'prev', type: 'button', className: 'dss-confbtn', disabled: busy,
            onClick: onPreview,
          }, showPrev ? '收起预览' : '预览两侧'),
          RESOLUTIONS.map(([val, txt]) => e('button', {
            key: val, type: 'button', className: 'dss-confbtn', disabled: busy,
            onClick: () => onResolve(val),
          }, busy ? '处理中…' : txt))),
        showPrev ? e('div', { className: 'dss-confprev' },
          preview === 'loading' ? e('div', { className: 'dss-pv-hint' }, '正在读取预览…')
            : preview ? (preview.kind === 'text'
              ? e('div', { key: 'd', className: 'dss-pv' }, [
                e('div', { className: 'dss-prevhead' }, '文本差异(本机 vs 远端拷贝,' + (preview.local && preview.local.bytes ? preview.local.bytes + 'B' : '?') + ' vs ' + (preview.remote && preview.remote.bytes ? preview.remote.bytes + 'B' : '?') + ')'),
                e('pre', { className: 'dss-pv-pre', style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0, fontSize: '12px', lineHeight: 1.5 } }, preview.diff || '(无差异或无内容)'),
              ])
              : [
                e('div', { key: 'l', className: 'dss-pv' },
                  e('div', { className: 'dss-prevhead' }, '本机版本' + (preview.local ? ' · ' + preview.local.messageCount + ' 条消息' : '')),
                  renderMsgs(preview.local)),
                e('div', { key: 'r', className: 'dss-pv' },
                  e('div', { className: 'dss-prevhead' }, '远端版本' + (preview.remote ? ' · ' + preview.remote.messageCount + ' 条消息' : '')),
                  renderMsgs(preview.remote)),
              ]) : null) : null);
    }

    function Section(props) {
      const { busy, status, progress, run, refresh } = useSync();
      const runRef = useRef(null);
      const [conflicts, setConflicts] = useState(null);
      const [autoRestart, setAutoRestart] = useState(null); // null=加载中
      const loadConflicts = useCallback(() => {
        API.conflicts().then((d) => setConflicts((d && d.conflicts) || [])).catch(() => {});
      }, []);
      useEffect(() => { loadConflicts(); }, [loadConflicts]);
      /* 读取/切换「同步后自动重启修复」开关 */
      useEffect(() => {
        let alive = true;
        API.config().then((d) => { if (alive && d && d.ok) setAutoRestart(d.config && d.config.autoRestartAfterRepair === true); }).catch(() => {});
        return () => { alive = false; };
      }, []);
      const toggleAutoRestart = () => {
        const next = !(autoRestart === true);
        setAutoRestart(next);
        API.saveConfig({ autoRestartAfterRepair: next })
          .then((d) => {
            if (d && d.ok) bubble(null, next ? '已开启:同步后自动重启 dsh 修复「未分组」' : '已关闭:同步后不自动重启', true);
            else { setAutoRestart(!next); bubble(null, (d && d.error) || '设置失败', false); }
          })
          .catch((err) => { setAutoRestart(!next); bubble(null, err.message || String(err), false); });
      };
      const onRun = () => { refresh(); run(runRef.current).then(() => loadConflicts()); };
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
          + (status.patches ? '\n补丁:' + status.patches : '')
          + (status.lastMessage ? '\n上次:' + status.lastMessage : '');
      })();

      return e('div', { className: 'dss-wrap' },
        e('style', null, STYLE),
        /* —— 同步组:状态 + 立即同步 —— */
        e('div', { className: 'dss-sec' },
          e('div', { className: 'dss-rowline' },
            e('div', { className: 'dss-rowtext' },
              e('div', { className: 'dss-h' }, '同步'),
              busy
                ? [
                    e('div', { className: 'dss-prog' },
                      e(SyncIcon, { spin: true }),
                      (progress && progress.label) || '同步中…',
                      progress && progress.startedAt ? e(ElapsedText, { className: 'dss-desc', startedAt: progress.startedAt, prefix: '· ' }) : null),
                    progress && progress.transfer ? e(TransferLine, { t: progress.transfer }) : null,
                  ]
                : e('div', { className: 'dss-desc' }, statusDesc)),
            e('button', {
              type: 'button', className: 'dss-pill', ref: runRef,
              disabled: busy || Boolean(status && status.gitMissing),
              title: '全量同步:提交本地快照 + 与远端对齐(含各工作区文件夹内容)',
              onClick: onRun,
            }, e(SyncIcon, { spin: busy }), busy ? '同步中' : '立即同步')),
          /* 「同步后自动重启修复」开关:同步补登记会话后自动重启 dsh,让新实例重建索引(修复「未分组」) */
          e('div', { className: 'dss-rowline dss-restartrow' },
            e('div', { className: 'dss-rowtext' },
              e('div', { className: 'dss-h' }, '同步后自动重启修复「未分组」'),
              e('div', { className: 'dss-desc' }, '同步若把会话补进登记表,自动重启 dsh 让新实例重建索引并加载修复版(浏览器会短暂断开、刷新恢复)。'),
            ),
            autoRestart === null
              ? e('span', { className: 'dss-desc' }, '…')
              : e('button', {
                  type: 'button', className: 'dss-switch' + (autoRestart ? ' dss-switch-on' : ''),
                  role: 'switch', 'aria-checked': autoRestart,
                  title: autoRestart ? '已开启:同步补登记后自动重启 dsh' : '已关闭:同步补登记后仅提示,需手动重启/跑 fix-ungrouped-oneshot',
                  onClick: toggleAutoRestart,
                }, e('span', { className: 'dss-switch-knob' }))),
          /* 上次结果明细:错误保留很久便于排障 */
          detail
            ? (status && status.lastOk === false
                ? e('div', { className: 'dss-err' }, detail)
                : e('div', { className: 'dss-desc' }, detail))
            : (status && status.lastOk === false && status.lastMessage
                ? e('div', { className: 'dss-err' }, status.lastMessage)
                : null)),
        /* —— 本机新创建的工作区:路径已按本机主目录重映射,可换位置 —— */
        (() => {
          const created = status && status.lastDetail && status.lastDetail.workspaces && status.lastDetail.workspaces.created;
          if (!Array.isArray(created) || !created.length) return null;
          return e('div', { className: 'dss-sec' },
            e('div', { className: 'dss-h' }, '本机新创建的工作区'),
            created.map((w) => e('div', { key: w.id, className: 'dss-wsbanner' },
              e('div', { className: 'dss-wsbanner-text' },
                e('div', { className: 'dss-wsbanner-title' }, '工作区「' + (w.title || w.id) + '」已在本机创建'),
                e('div', { className: 'dss-confmeta' }, '路径: ' + w.path),
                w.recorded && String(w.recorded).toLowerCase() !== String(w.path).toLowerCase()
                  ? e('div', { className: 'dss-confmeta' }, '记录路径: ' + w.recorded + '(按本机主目录自动重映射)')
                  : null),
              e('div', { className: 'dss-confbtns' },
                e('button', {
                  type: 'button', className: 'dss-btn',
                  onClick: () => {
                    const p = window.prompt('为工作区「' + (w.title || w.id) + '」选择本机文件夹(留空则恢复按记录路径):', w.path);
                    if (p === null) return;
                    API.workspacePath(w.id, p.trim())
                      .then((d) => { if (d && d.ok) { bubble(null, d.path ? '已换位置: ' + d.path : '已恢复默认', true); refresh(); run(runRef.current); } else bubble(null, (d && d.error) || '设置失败', false); })
                      .catch((err) => bubble(null, err.message || String(err), false));
                  },
                }, '换位置'),
                e('button', {
                  type: 'button', className: 'dss-btn',
                  onClick: () => {
                    API.workspacePath(w.id, '')
                      .then((d) => { if (d && d.ok) { bubble(null, '已恢复按记录路径', true); refresh(); } else bubble(null, (d && d.error) || '设置失败', false); })
                      .catch((err) => bubble(null, err.message || String(err), false));
                  },
                }, '恢复默认')))));
        })(),
        /* —— 冲突(「双边保留」)裁决组:呈现给用户抉择 —— */
        e('div', { className: 'dss-sec' },
          e('div', { className: 'dss-h' }, '冲突'),
          conflicts === null
            ? e('div', { className: 'dss-empty' }, '正在读取冲突…')
            : null,
          conflicts !== null && conflicts.length === 0
            ? e('div', { className: 'dss-desc' }, '当前没有待裁决的冲突。同步时若两台电脑同时改同一文件,会「双边保留」并把冲突呈现在这里,由你抉择。')
            : null,
          conflicts !== null
            ? conflicts.map((c) => e(ConflictRow, {
                key: (c.kind || 'main') + ':' + c.path + ':' + (c.conflictAt || '0'),
                conflict: c, onResolved: loadConflicts,
              }))
            : null));
    }

    /* ---------- 归档会话管理处:列出全部会话(含已归档/幽灵);点击行展开预览;取消归档/彻底删除 ---------- */
    function fmtDT(ms) {
      try { return new Date(ms).toLocaleString(); } catch { return ''; }
    }

    /* 预览面板:请求会话内容并渲染为对话气泡 */
    function PreviewPanel(props) {
      const id = props.id;
      const [st, setSt] = useState(null); // null=加载中
      useEffect(() => {
        let alive = true;
        setSt(null);
        API.preview(id).then((d) => {
          if (!alive) return;
          if (d && d.ok) setSt({ data: d });
          else setSt({ err: (d && d.error) || '读取失败' });
        }).catch((e) => { if (alive) setSt({ err: e.message || String(e) }); });
        return () => { alive = false; };
      }, [id]);
      if (!st) return e('div', { className: 'dss-pv-hint' }, '正在读取会话内容…');
      if (st.err) return e('div', { className: 'dss-err' }, st.err);
      const d = st.data;
      if (!d.found) return e('div', { className: 'dss-pv-hint' }, '该会话没有本地文件(幽灵会话),无内容可预览。');
      const msgs = d.messages || [];
      return e('div', { className: 'dss-pv' },
        e('div', { className: 'dss-pv-head' },
          d.title ? e('span', { className: 'dss-pv-title', title: d.title }, d.title) : null,
          e('span', { className: 'dss-pv-count' },
            '共 ' + d.messageCount + ' 条消息'
            + (d.truncated ? '(仅显示最近 ' + msgs.length + ' 条)' : '')
            + (d.messageCount === 0 ? ' · 无内容' : ''))),
        msgs.length === 0
          ? e('div', { className: 'dss-pv-hint' }, '该会话没有可展示的消息。')
          : e('div', { className: 'dss-pv-list' },
              msgs.map((m, i) => e('div', { className: 'dss-msg dss-msg-' + m.role, key: i },
                e('div', { className: 'dss-msg-role' }, (m.role === 'user' ? '你' : '助手') + (m.time ? ' · ' + fmtDT(m.time) : '')),
                e('div', { className: 'dss-msg-text' }, m.text)))));
    }

    function ArchiveSection() {
      const [rows, setRows] = useState(null);
      const [msg, setMsg] = useState('');
      const [busyId, setBusyId] = useState(null);
      const [busyKind, setBusyKind] = useState('');
      const [openId, setOpenId] = useState(null);
      const pendingRef = useRef(0);
      const load = useCallback(() => {
        API.sessions().then((d) => {
          if (d && d.ok) { setRows(d.sessions || []); setMsg(''); } else setMsg((d && d.error) || '读取失败');
        }).catch((e) => setMsg(e.message || String(e)));
      }, []);
      useEffect(() => { load(); }, [load]);
      // 退出设置页(本分节卸载)时,若还有未提交的删除/取消归档,统一提交+推送一次(阻塞遮罩)
      useEffect(() => () => {
        if (pendingRef.current > 0) {
          pendingRef.current = 0;
          flushPendingOps();
        }
      }, []);
      const act = (id, kind) => {
        const row = (rows || []).find((r) => r.id === id) || {};
        const title = row.title || id;
        if (kind === 'delete' && !window.confirm('彻底删除会话「' + title + '」?\n' + id + '\n\n将移除会话文件与登记项,不可恢复。')) return;
        setBusyId(id);
        setBusyKind(kind);
        // —— 乐观更新:立即反映到界面,不等网络往返;删除不再逐次提交+推送,退出设置页统一同步 ——
        if (kind === 'delete') {
          setRows((prev) => (prev || []).filter((r) => r.id !== id));
          setOpenId((cur) => (cur === id ? null : cur));
        } else {
          setRows((prev) => (prev || []).map((r) => (r.id === id ? { ...r, archived: false } : r)));
        }
        const p = kind === 'unarchive' ? API.unarchive(id) : API.delSession(id);
        p.then((d) => {
          if (d && d.ok) {
            pendingRef.current += 1;
            bubble(null, kind === 'unarchive' ? '已取消归档「' + title + '」→ 已回到侧边栏' : '已彻底删除「' + title + '」', true);
          } else {
            bubble(null, (d && d.error) || '操作失败', false);
            load(); // 失败回滚:重新读取真实列表
          }
        }).catch((e) => {
          bubble(null, e.message || String(e), false);
          load();
        }).finally(() => { setBusyId(null); setBusyKind(''); });
      };
      const archived = (rows || []).filter((r) => r.archived);
      const ghosts = (rows || []).filter((r) => r.ghost);
      const rest = (rows || []).filter((r) => !r.archived && !r.ghost);
      const archGhosts = [...archived];
      for (const g of ghosts) if (!archived.some((a) => a.id === g.id)) archGhosts.push(g);
      const renderRow = (r) => {
        const open = openId === r.id;
        const busy = busyId === r.id;
        return e('div', { className: 'dss-item' + (open ? ' dss-item-open' : ''), key: r.id },
          e('div', { className: 'dss-item-row' },
            e('button', {
              type: 'button', className: 'dss-item-main',
              title: r.ghost ? '该会话没有本地文件,无内容可预览' : (open ? '收起预览' : '点击预览会话内容'),
              onClick: () => setOpenId(open ? null : r.id),
            },
              e(ChevIcon, { className: 'dss-chev' + (open ? ' dss-chev-open' : '') }),
              e('span', { className: 'dss-item-text' },
                e('span', { className: 'dss-title', title: r.id + '\n' + r.workspace }, r.title || '(无标题)'),
                e('span', { className: 'dss-meta' },
                  (r.workspace || '?') + ' · ' + (r.archived ? '已归档' : '活动') + (r.ghost ? ' · 幽灵(无文件)' : '')
                  + ' · ' + r.sizeKB + 'KB' + (r.createdAt ? ' · 创建 ' + fmtDT(r.createdAt) : '') + (r.updatedAt ? ' · 活动 ' + fmtDT(r.updatedAt) : ''))),
              r.ghost ? e('span', { className: 'dss-badge' }, '幽灵') : null,
              r.archived ? e('span', { className: 'dss-badge dss-badge-arch' }, '已归档') : null),
            e('div', { className: 'dss-item-acts' },
              e('button', {
                type: 'button', className: 'dss-btn dss-btn-restore',
                disabled: busy || r.ghost,
                title: r.ghost ? '幽灵会话没有文件,无法取消归档' : '取消归档,让会话回到侧边栏',
                onClick: (ev) => { ev.stopPropagation(); act(r.id, 'unarchive'); },
              }, e(RestoreIcon, null), busy && busyKind === 'unarchive' ? '处理中…' : '取消归档'),
              e('button', {
                type: 'button', className: 'dss-btn dss-btn-del',
                disabled: busyId !== null,
                title: '彻底删除该会话(文件 + 登记项,不可恢复)',
                onClick: (ev) => { ev.stopPropagation(); act(r.id, 'delete'); },
              }, e(TrashIcon, null), busy && busyKind === 'delete' ? '处理中…' : '彻底删除'))),
          open ? e('div', { className: 'dss-item-pv' }, e(PreviewPanel, { id: r.id })) : null);
      };
      return e('div', { className: 'dss-wrap' },
        e('div', { className: 'dss-sec' },
          e('div', { className: 'dss-h' }, '归档会话'),
          e('div', { className: 'dss-desc' }, '列出本机全部 DSH 会话(真实文件 + 登记表幽灵)。点击任一会话即可展开预览对话内容;已归档/幽灵会话可「取消归档」回到侧边栏,或「彻底删除」。'),
          msg ? e('div', { className: 'dss-err' }, msg) : null,
          rows === null ? e('div', { className: 'dss-empty' }, '正在读取会话…') : null,
          e('div', { className: 'dss-count' }, '共 ' + ((rows || []).length) + ' 个会话 · 已归档 ' + archived.length + ' · 幽灵 ' + ghosts.length + ' · 活动 ' + rest.length),
          (archived.length || ghosts.length
            ? e('div', null, e('div', { className: 'dss-sub' }, '已归档 / 幽灵(' + (archived.length + ghosts.length) + ')'), archGhosts.map(renderRow))
            : null),
          (rest.length
            ? e('div', null, e('div', { className: 'dss-sub' }, '活动(' + rest.length + ')'), rest.map(renderRow))
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
      // 设置面板分节:归档会话管理处(列出全部会话;点击预览/取消归档/彻底删除)
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-sync-archive',
        order: 410,
        label: '归档会话',
      }, ArchiveSection));
    }

    module.exports = {
      name: 'dsh-sync-plugin',
      inject: ['slots'],
      apply,
    };
    return module.exports;
  },
});