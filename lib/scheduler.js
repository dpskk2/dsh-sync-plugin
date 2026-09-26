/** Own automatic-sync timers independently of the host routes and manual sync. */
export function createSyncScheduler({ loadConfig, sync, afterSync, log, clock = globalThis }) {
  let interval = null, activity = null, intervalMs = 0, stopped = false;
  const wanted = () => { const c = loadConfig(); return !stopped && c.mode === 'auto' && c.enabled !== false; };
  const clear = () => {
    if (interval !== null) clock.clearInterval(interval);
    if (activity !== null) clock.clearTimeout(activity);
    interval = activity = null;
    intervalMs = 0;
  };
  const run = (reason) => {
    if (!wanted()) { refresh(); return; }
    Promise.resolve().then(async () => {
      if (!wanted()) return;
      await sync(reason);
      if (!stopped) await afterSync();
    })
      .catch((e) => log('warn', `自动同步失败: ${e?.message || e}`))
      .finally(() => { if (!stopped) refresh(); });
  };
  function refresh({ startup = false } = {}) {
    if (!wanted()) { clear(); return false; }
    const c = loadConfig();
    const seconds = Number(c.intervalSeconds);
    const nextMs = Math.max(30, Number.isFinite(seconds) && seconds > 0 ? seconds : 300) * 1000;
    if (interval === null || intervalMs !== nextMs) {
      clear();
      intervalMs = nextMs;
      interval = clock.setInterval(() => run('interval'), nextMs);
      interval?.unref?.();
    }
    if (startup && c.autoPullOnStart !== false) run('startup');
    return true;
  }
  return {
    refresh,
    get active() { return interval !== null && wanted(); },
    onActivity() {
      if (!wanted()) { refresh(); return; }
      if (activity !== null) return;
      const seconds = Number(loadConfig().eventDebounceSeconds);
      const delay = Math.max(5, Number.isFinite(seconds) && seconds > 0 ? seconds : 15) * 1000;
      activity = clock.setTimeout(() => { activity = null; run('activity'); }, delay);
      activity?.unref?.();
    },
    stop() { stopped = true; clear(); },
  };
}
