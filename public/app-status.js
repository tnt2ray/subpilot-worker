export function createStatusUi({ state, $, t, esc, section, btn, api, mountHelpTips }) {
  function renderSidebarVersion() {
    const element = $("#sidebar-version");
    if (!element) return;
    const available = state.system?.update?.updateAvailable === true;
    element.textContent = available ? t("有更新", "Update available") : (state.system?.app?.version || "");
    element.classList.toggle("has-update", available);
  }
  function renderStatus() {
    return section(t("订阅缓存", "Subscription cache"), `<div id="source-cache">${renderSourceCache()}</div><p class="help" data-help>${t("强制刷新会重新拉取已保存并启用的订阅源；上游获取失败时保留可用的旧缓存。", "Force refresh fetches saved, enabled sources again. Available cached content is retained if an upstream fetch fails.")}</p>`, btn(t("强制刷新", "Force refresh"), "refresh-sources"))
      + section(t("最近订阅请求", "Recent subscription requests"), `<div id="recent-requests">${renderRecentRequests()}</div>`);
  }
  function renderSourceCache() {
    const cache = state.stats?.sourceCache;
    if (!cache) return `<p class="empty">${t("暂未读取到缓存状态，可点击“强制刷新”重试。", "Cache status is unavailable. Select Force refresh to try again.")}</p>`;
    const coverage = cache.expectedCount === 0 ? t("没有启用的订阅源", "No enabled sources") : cache.allSourcesCached ? t("全部已缓存", "All sources cached") : t(`还有 ${cache.expectedCount - cache.cachedSourceCount} 个源未缓存`, `${cache.expectedCount - cache.cachedSourceCount} sources not cached`);
    return `<dl class="cache-summary">
      <div><dt>${t("已缓存订阅源", "Cached sources")}</dt><dd>${esc(cache.cachedSourceCount)} <span class="muted">/ ${esc(cache.expectedCount)}</span></dd><dd class="cache-detail">${esc(coverage)}</dd></div>
      <div><dt>${t("节点总数", "Total nodes")}</dt><dd>${esc(cache.totalNodes)}</dd><dd class="cache-detail">${t("来自已缓存的启用订阅源", "From cached, enabled sources")}</dd></div>
      <div><dt>${t("最近缓存更新", "Last cache update")}</dt><dd class="cache-updated">${formatDate(cache.updatedAt)}</dd><dd class="cache-detail">${t("按系统显示时区", "In the configured display time zone")}</dd></div>
    </dl>
    ${cache.protocolCounts.length ? `<div class="cache-protocols"><span class="muted">${t("协议分布", "Protocols")}</span>${renderCacheProtocols(cache.protocolCounts)}</div>` : ""}
    ${cache.sources.length ? `<div class="table-wrap"><table class="cache-table"><thead><tr><th>${t("订阅源", "Source")}</th><th>${t("缓存状态", "Cache status")}</th><th>${t("节点数", "Nodes")}</th><th>${t("协议分布", "Protocols")}</th><th>${t("更新时间", "Updated")}</th></tr></thead><tbody>${cache.sources.map((source) => `<tr><td class="cache-source-name">${esc(source.sourceName || source.sourceId || t("未命名订阅源", "Unnamed source"))}</td><td><span class="chip ${source.cached ? "cache-ready" : "cache-missing"}">${source.cached ? t("已缓存", "Cached") : t("未缓存", "Not cached")}</span></td><td>${source.cached ? esc(source.nodeCount) : "—"}</td><td>${source.cached ? renderCacheProtocols(source.protocolCounts) : "—"}</td><td class="request-time">${source.cached ? formatDate(source.fetchedAt) : "—"}</td></tr>`).join("")}</tbody></table></div>` : `<p class="empty">${t('还没有启用的订阅源。请先在<a href="#sources">订阅源</a>中添加或启用并保存。', 'No enabled sources yet. Add or enable a source in <a href="#sources">Subscription sources</a>, then save.')}</p>`}
  `;
  }
  function renderCacheProtocols(protocols) {
    return protocols.length ? protocols.map((item) => `<span class="chip">${esc(item.protocol)} · ${esc(item.count)}</span>`).join("") : `<span class="muted">${t("未解析到节点", "No parsed nodes")}</span>`;
  }
  function updateSourceRefreshButtons() {
    for (const button of document.querySelectorAll('[data-action="refresh-sources"]')) {
      button.dataset.idleLabel ||= button.textContent;
      button.disabled = state.refreshingSources;
      button.textContent = state.refreshingSources ? t("刷新中…", "Refreshing…") : button.dataset.idleLabel;
    }
  }
  function renderSourceRefreshResult(result) {
    return `<p>${t(`成功刷新 ${result.refreshed} 个源，${result.failed} 个失败，${result.cached} 个沿用旧缓存。`, `${result.refreshed} sources refreshed, ${result.failed} failed, ${result.cached} using previous cache.`)}</p>
      <ul class="cache-failures">${(result.failures || []).map((failure) => `<li><strong>${esc(failure.sourceName || failure.sourceId || t("未命名订阅源", "Unnamed source"))}</strong><p>${failure.usedCachedContent ? t("已保留旧缓存", "Previous cache retained") : t("没有可用缓存", "No cache available")}</p><p class="muted">${esc(failure.reason)}</p></li>`).join("")}</ul>`;
  }
  const REQUEST_PAGE_SIZE = 10;
  const MAX_VISIBLE_REQUESTS = 50;
  function renderRecentRequests() {
    const rows = [...(state.stats?.recentUserAgents || [])]
      .sort((a, b) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt))
      .slice(0, MAX_VISIBLE_REQUESTS);
    const pages = Math.max(1, Math.ceil(rows.length / REQUEST_PAGE_SIZE));
    state.requestPage = Math.max(0, Math.min(state.requestPage, pages - 1));
    if (!rows.length) return `<p class="empty">${t("尚无订阅请求", "No subscription requests yet")}</p>`;
    const start = state.requestPage * REQUEST_PAGE_SIZE;
    const visible = rows.slice(start, start + REQUEST_PAGE_SIZE);
    return `<div class="table-wrap"><table class="request-table"><thead><tr><th>${t("请求时间", "Request time")}</th><th>${t("客户端", "Client")}</th><th>User-Agent</th><th>${t("位置", "Location")}</th></tr></thead><tbody>${visible.map((row) => `<tr><td class="request-time">${formatDate(row.fetchedAt)}</td><td>${esc(row.target)}</td><td class="truncate">${esc(row.userAgent)}</td><td>${esc(row.location?.label || "—")}</td></tr>`).join("")}</tbody></table></div>
      <nav class="toolbar request-pagination" aria-label="${t("订阅请求分页", "Subscription request pagination")}">
        <span class="muted">${t(`最近 ${rows.length} 条 · 显示 ${start + 1}–${start + visible.length} 条`, `Latest ${rows.length} requests · Showing ${start + 1}–${start + visible.length}`)}</span>
        <span class="spacer"></span>
        ${btn(t("上一页", "Previous"), "request-page", `data-page="${state.requestPage - 1}" ${state.requestPage === 0 ? "disabled" : ""}`)}
        <span role="status">${t(`第 ${state.requestPage + 1} / ${pages} 页`, `Page ${state.requestPage + 1} of ${pages}`)}</span>
        ${btn(t("下一页", "Next"), "request-page", `data-page="${state.requestPage + 1}" ${state.requestPage === pages - 1 ? "disabled" : ""}`)}
      </nav>`;
  }
  function formatDate(value) {
    if (!value) return "—";
    try {
      return new Intl.DateTimeFormat(state.lang === "zh" ? "zh-CN" : "en", { dateStyle: "short", timeStyle: "medium", timeZone: state.config.settings.displayTimeZone }).format(new Date(value));
    } catch {
      return esc(value);
    }
  }

  function updateStatusSection(selector, renderContent, { preserveFocus = true } = {}) {
    if (state.page !== "status") return;
    const container = $(selector);
    if (!container) return;
    const focused = preserveFocus && container.contains(document.activeElement) ? document.activeElement : null;
    const pageButton = selector === "#recent-requests" && focused?.matches('button[data-action="request-page"]') ? focused : null;
    if (focused && !pageButton) return;
    const direction = pageButton ? Math.sign(Number(pageButton.dataset.page) - state.requestPage) : 0;
    const content = renderContent();
    if (container.innerHTML === content) return;
    const scroll = [...container.querySelectorAll(".table-wrap")].map((element) => ({ left: element.scrollLeft, top: element.scrollTop }));
    container.innerHTML = content;
    [...container.querySelectorAll(".table-wrap")].forEach((element, index) => {
      if (scroll[index]) { element.scrollLeft = scroll[index].left; element.scrollTop = scroll[index].top; }
    });
    mountHelpTips(container, $("#page-title"));
    if (pageButton) {
      const controls = [...container.querySelectorAll('button[data-action="request-page"]')];
      const nextFocus = controls.find((button) => !button.disabled && Number(button.dataset.page) === state.requestPage + direction)
        || controls.find((button) => !button.disabled);
      nextFocus?.focus({ preventScroll: true });
    }
  }
  function updateStatusView(options = {}) {
    updateStatusSection("#source-cache", renderSourceCache, options);
    updateStatusSection("#recent-requests", renderRecentRequests, options);
    updateSourceRefreshButtons();
  }

  let statusRequest = 0, systemRequest = 0, requestsRequest = 0;
  async function refreshRequests({ background = true, signal } = {}) {
    if (signal?.aborted) throw signal.reason || new DOMException("Request aborted", "AbortError");
    const request = ++requestsRequest;
    const result = await api("/api/stats/requests", { background, signal });
    if (signal?.aborted) throw signal.reason || new DOMException("Request aborted", "AbortError");
    if (request !== requestsRequest) return;
    state.stats = { ...state.stats, recentUserAgents: result.recentUserAgents };
    updateStatusSection("#recent-requests", renderRecentRequests);
  }
  async function refreshSystem({ background = true, signal } = {}) {
    if (signal?.aborted) throw signal.reason || new DOMException("Request aborted", "AbortError");
    const request = ++systemRequest;
    const system = await api("/api/system/status", { background, signal });
    if (signal?.aborted) throw signal.reason || new DOMException("Request aborted", "AbortError");
    if (request === systemRequest) {
      state.system = system;
      renderSidebarVersion();
    }
  }
  async function refreshStatus({ background = true, signal } = {}) {
    if (signal?.aborted) throw signal.reason || new DOMException("Request aborted", "AbortError");
    const request = ++statusRequest;
    const recentRequest = ++requestsRequest;
    const values = await Promise.allSettled([
      api("/api/stats", { background, signal }),
      refreshSystem({ background, signal })
    ]);
    if (request === statusRequest && !signal?.aborted) {
      if (values[0].status === "fulfilled") {
        state.stats = recentRequest === requestsRequest ? values[0].value
          : { ...values[0].value, recentUserAgents: state.stats?.recentUserAgents || [] };
      }
      renderSidebarVersion();
      updateStatusView();
    }
    const failures = values.filter((value) => value.status === "rejected");
    const failure = failures.find((value) => value.reason?.status === 401) || failures[0];
    if (failure) throw failure.reason;
    if (signal?.aborted) throw signal.reason || new DOMException("Request aborted", "AbortError");
  }

  return { renderSidebarVersion, renderStatus, renderSourceCache, renderRecentRequests, updateSourceRefreshButtons, renderSourceRefreshResult, formatDate, updateStatusView, refreshStatus, refreshSystem, refreshRequests };
}
