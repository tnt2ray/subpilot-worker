export function createLiveSync({ refreshRequests, refreshActions, hasRequestsView, hasActionsProgress, onError }) {
  const intervals = { requests: 15_000, actions: 5_000 };
  const due = { requests: 0, actions: 0 }, errors = { requests: "", actions: "" };
  let started = false, timer = null, controller = null, flight = null;
  let scope = "", paused = false, forceQueued = false;
  const visibleScope = () => document.visibilityState === "hidden" || navigator.onLine === false ? ""
    : [hasRequestsView() && "requests", hasActionsProgress() && "actions"].filter(Boolean).join(",");
  function clearTimer() { clearTimeout(timer); timer = null; }
  function schedule() {
    clearTimer();
    if (!started || paused || !scope) return;
    timer = setTimeout(() => { void refresh(); }, Math.max(0, Math.min(...scope.split(",").map((key) => due[key])) - Date.now()));
  }
  async function refresh({ force = false } = {}) {
    if (!started) return;
    clearTimer();
    const nextScope = visibleScope();
    if (nextScope !== scope) {
      controller?.abort();
      scope = nextScope;
      for (const key of scope.split(",").filter(Boolean)) due[key] = Date.now() + intervals[key];
    }
    if (force) paused = false;
    if (!scope || paused) return;
    if (flight) { forceQueued ||= force; return flight; }
    const keys = scope.split(",").filter((key) => force || Date.now() >= due[key]);
    if (!keys.length) { schedule(); return; }
    const active = new AbortController();
    controller = active;
    const options = { background: true, signal: active.signal };
    flight = Promise.allSettled(keys.map((key) => Promise.resolve().then(() =>
      key === "requests" ? refreshRequests(options) : refreshActions(options)
    ))).then((results) => {
      if (active.signal.aborted) return;
      const failures = [];
      results.forEach((result, index) => {
        const key = keys[index];
        due[key] = Date.now() + intervals[key];
        if (result.status === "fulfilled") { errors[key] = ""; return; }
        const error = result.reason;
        if (error?.name === "AbortError") return;
        if (error?.status === 401) paused = true;
        const signature = (error?.status || "") + ":" + (error?.message || "Request failed");
        if (errors[key] !== signature) { errors[key] = signature; failures.push(error); }
      });
      if (failures.length) onError?.(failures.find((error) => error?.status === 401) || failures[0]);
    });
    try { await flight; }
    finally {
      flight = null;
      if (controller === active) controller = null;
      const forceNext = forceQueued;
      forceQueued = false;
      if (started) void refresh({ force: forceNext });
    }
  }
  function wake() { void refresh({ force: true }); }
  function visibilityChanged() { void refresh(); }
  function start() {
    if (started) return;
    started = true;
    document.addEventListener("visibilitychange", visibilityChanged);
    window.addEventListener("online", wake);
    window.addEventListener("offline", visibilityChanged);
    window.addEventListener("focus", wake);
    void refresh();
  }
  function stop() {
    started = false;
    forceQueued = false;
    scope = "";
    controller?.abort();
    clearTimer();
    document.removeEventListener("visibilitychange", visibilityChanged);
    window.removeEventListener("online", wake);
    window.removeEventListener("offline", visibilityChanged);
    window.removeEventListener("focus", wake);
  }
  return { start, stop, refresh };
}
