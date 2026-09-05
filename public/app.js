import { CLIENTS, NAV, LABELS, CLIENT_SECTIONS, RULE_FIELDS, LEGACY_RULE_FIELDS, getPath, setPath, splitRule } from "./app-model.js";
const $ = (selector, root = document) => root.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const state = { config: null, saved: "", page: "status", client: "surge", section: "network", lang: localStorage.getItem("subpilot-language") || "zh", invalid: /* @__PURE__ */ new Map(), busy: false, migration: false, migrationData: null, stats: null, requestPage: 0, refreshingSources: false, system: null };
const mmdb = { status: null, loading: false, statusError: false, file: null, uploading: false, progress: 0, outcome: "", error: "", request: 0 };

const t = (zh, en) => state.lang === "zh" ? zh : en;
const label = (key) => state.lang === "zh" ? LABELS[key] || key : key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
const paths = { grid: "M3 3h6v6H3zm12 0h6v6h-6zM3 15h6v6H3zm12 0h6v6h-6z", source: "M6 3h8l4 4v14H6zM14 3v5h4M9 12h6m-6 4h6", nodes: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M3 12h18M12 3c-5 5-5 13 0 18 5-5 5-13 0-18", settings: "m9 3-1 3-3 1v4l-2 1 2 2v4l3 1 1 2h6l1-2 3-1v-4l2-2-2-1V7l-3-1-1-3zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0", code: "m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18", link: "m10 14 4-4M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 10 5-5a4 4 0 0 0-6-6l-2 2", edit: "m4 15 11-11 5 5-11 11H4zM13 6l5 5", trash: "M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7", up: "m6 15 6-6 6 6", down: "m6 9 6 6 6-6", copy: "M8 8h13v13H8zM16 8V3H3v13h5", plus: "M12 4v16M4 12h16" };
const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.settings}"/></svg>`;
const btn = (text, action2, attrs = "", className = "") => `<button type="button" data-action="${action2}" class="${className}" ${attrs}>${text}</button>`;
const smallButton = (name, action2, attrs = "", title = "") => btn(icon(name) + (name === "edit" ? esc(title || t("编辑", "Edit")) : ""), action2, `${attrs} aria-label="${esc(title || name)}" title="${esc(title || name)}"`, name === "edit" ? "edit-button" : "icon-button");
const target = () => CLIENTS[state.client].target;
const basePath = () => `clients.${state.client}`;
const currentClient = () => state.config.clients[state.client];
const dirty = () => state.config && JSON.stringify(state.config) !== state.saved;
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
function validateNativeShape(value, path = "clients.singbox") {
  const objects = ["clients.singbox", "clients.singbox.dns", "clients.singbox.route", "clients.singbox.log", "clients.singbox.experimental"];
  const arrays = ["clients.singbox.inbounds", "clients.singbox.dns.servers", "clients.singbox.dns.rules", "clients.singbox.route.rules", "clients.singbox.route.rule_set"];
  if (objects.includes(path) && !isObject(value)) throw Error(`${path}: ${t("需要 JSON 对象", "a JSON object is required")}`);
  if (arrays.includes(path) && (!Array.isArray(value) || value.some((item) => !isObject(item)))) throw Error(`${path}: ${t("需要由对象组成的数组", "an array of objects is required")}`);
  if (objects.includes(path)) for (const [key, item] of Object.entries(value)) {
    const child = `${path}.${key}`;
    if (objects.includes(child) || arrays.includes(child)) validateNativeShape(item, child);
  }
}
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("#toast").hidden = true, 4500);
}
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...options.body ? { "content-type": "application/json" } : {}, ...options.headers } });
  if (response.status === 401) {
    location.reload();
    throw Error(t("会话已过期", "Session expired"));
  }
  const data = await response.json();
  if (!response.ok) throw Error(data.error || `${response.status}`);
  return data;
}
function updateStatus() {
  const invalid = state.invalid.size;
  $("#save-status").textContent = state.busy ? t("处理中…", "Working…") : invalid ? t(`${invalid} 项输入格式无效`, `${invalid} invalid fields`) : dirty() ? t("有未保存更改", "Unsaved changes") : t("所有更改已保存", "All changes saved");
  $("#save-status").classList.toggle("dirty", Boolean(dirty() || invalid));
  $("#save").disabled = state.busy || invalid > 0 || state.migration || !dirty();
  $("#save").textContent = t("保存配置", "Save configuration");
  const exportCa = $('[data-action="export-ca"]');
  if (exportCa) exportCa.disabled = !state.config.clients.surge.mitm.caP12;
  const caStatus = $("#ca-status");
  if (caStatus) caStatus.textContent = state.config.clients.surge.mitm.caP12 ? t("已配置 CA 证书", "CA certificate configured") : t("尚未配置 CA 证书", "No CA certificate configured");
}
function changed() {
  updateStatus();
}
function field(path, value, options = {}) {
  const key = path.split(".").at(-1);
  const id = `field-${path.replaceAll(".", "-")}`;
  const title = options.label || label(key);
  let control;
  const common = `id="${id}" data-field="${esc(path)}" ${state.invalid.has(path) ? 'aria-invalid="true"' : ""}`;
  if (typeof value === "boolean") control = `<input class="toggle" type="checkbox" ${common} ${value ? "checked" : ""}>`;
  else if (typeof value === "number") control = `<input type="number" ${common} data-kind="number" value="${esc(value)}">`;
  else if (options.options) control = `<select ${common}>${options.options.map((item) => `<option value="${esc(item)}" ${item === value ? "selected" : ""}>${esc(item)}</option>`).join("")}</select>`;
  else if (Array.isArray(value) && !["tailscaleNodes", "inbounds", "directRules", "servers", "rule_set", "outputs"].includes(key) && value.every((item) => typeof item === "string")) control = `<textarea ${common} data-kind="lines" rows="${Math.min(8, Math.max(3, value.length))}" spellcheck="false">${esc(value.join("\n"))}</textarea><div class="help">${esc(options.help || t("每行一项", "One item per line"))}</div>`;
  else if (value && typeof value === "object") control = `<textarea ${common} data-kind="json" class="code" rows="${Math.min(13, Math.max(4, JSON.stringify(value, null, 2).split("\n").length))}" spellcheck="false">${esc(JSON.stringify(value, null, 2))}</textarea><div class="help">JSON · ${t("保留完整原生字段", "Preserves native fields")}</div>`;
  else if (options.multiline || String(value).includes("\n")) control = `<textarea ${common} data-kind="text" class="code" rows="7" spellcheck="false">${esc(value)}</textarea>`;
  else control = `<input ${common} type="${/token|secret|password|passphrase|authKey/i.test(key) ? "password" : "text"}" value="${esc(value)}" autocomplete="off" spellcheck="false">`;
  if (state.invalid.has(path) && control.includes("<textarea")) control = control.replace(/(<textarea[^>]*>)[\s\S]*?(<\/textarea>)/, (_, open, close) => open + esc(state.invalid.get(path)) + close);
  return `<div class="form-row"><label for="${id}">${esc(title)}</label><div class="field">${control}</div></div>`;
}
function section(title, content, extra = "") {
  return `<section class="section"><div class="section-heading"><h2>${esc(title)}</h2>${extra}</div>${content}</section>`;
}
function clientTabs() {
  return `<div class="client-tabs">${Object.entries(CLIENTS).map(([id, client]) => btn(client.label, "client", `data-client="${id}"`, state.client === id ? "selected" : "")).join("")}<span class="muted">${t("当前配置独立保存，不影响其他客户端。", "Settings are saved independently for each client.")}</span></div>`;
}
function render() {
  if (!state.config) return;
  document.documentElement.lang = state.lang === "zh" ? "zh-CN" : "en";
  $("#navigation").innerHTML = NAV.map(([id, zh, en, img]) => `<a href="#${id}" class="${state.page === id ? "active" : ""}" ${state.page === id ? 'aria-current="page"' : ""}>${icon(img)}${state.lang === "zh" ? zh : en}</a>`).join("");
  const page = NAV.find((item) => item[0] === state.page) || NAV[0];
  $("#page-title").textContent = state.lang === "zh" ? page[1] : page[2];
  $("#header-actions").innerHTML = state.page === "clients" && state.client === "singbox" ? `<span class="muted small">sing-box 1.14.0</span>${btn(t("迁移问题", "Migration issues"), "diagnostics")}` : "";
  $("#language").textContent = state.lang === "zh" ? "中文 / EN" : "EN / 中文";
  $("#logout").textContent = t("退出登录", "Sign out");
  $("#migration-banner").hidden = !state.migration;
  $("#migration-banner").innerHTML = state.migration ? `<div class="notice warning"><h2>${t("配置升级待确认", "Configuration migration required")}</h2><p>${t("Surge 与 clash 保留原设置，sing-box 从 Surge 转换。确认迁移后移除 Stash 和 Shadowrocket。", "Surge and clash retain their settings. sing-box is converted from Surge. Confirm migration to remove Stash and Shadowrocket.")}</p><div class="toolbar">${btn(t("查看并确认迁移", "Review migration"), "migration")}</div></div>` : "";
  const views = { status: renderStatus, sources: () => renderEntities("sources"), nodes: () => renderEntities("nodes"), groups: renderGroups, clients: renderClient, "rule-sources": () => renderEntities("rule-sources"), links: renderLinks, system: renderSystem };
  $("#content").innerHTML = (views[state.page] || renderStatus)();
  updateStatus();
  updateSourceRefreshButtons();
  updateMmdbView();
}
function renderStatus() {
  return section(t("运行状态", "Service status"), `<div class="status-row"><span>${t("项目版本", "Application version")}</span><strong class="value">${esc(state.system?.app?.version || "2.0.0")}</strong></div>`) + section(t("订阅缓存", "Subscription cache"), renderSourceCache(), btn(t("强制刷新", "Force refresh"), "refresh-sources")) + section(t("最近订阅请求", "Recent subscription requests"), renderRecentRequests());
}
function renderSourceCache() {
  const cache = state.stats?.sourceCache;
  if (!cache) return `<p class="empty">${t("暂未读取到缓存状态，请刷新页面后重试。", "Cache status is unavailable. Reload the page to try again.")}</p>`;
  const coverage = cache.expectedCount === 0 ? t("没有启用的订阅源", "No enabled sources") : cache.allSourcesCached ? t("全部已缓存", "All sources cached") : t(`还有 ${cache.expectedCount - cache.cachedSourceCount} 个源未缓存`, `${cache.expectedCount - cache.cachedSourceCount} sources not cached`);
  return `<dl class="cache-summary">
    <div><dt>${t("已缓存订阅源", "Cached sources")}</dt><dd>${esc(cache.cachedSourceCount)} <span class="muted">/ ${esc(cache.expectedCount)}</span></dd><dd class="cache-detail">${esc(coverage)}</dd></div>
    <div><dt>${t("节点总数", "Total nodes")}</dt><dd>${esc(cache.totalNodes)}</dd><dd class="cache-detail">${t("来自已缓存的启用订阅源", "From cached, enabled sources")}</dd></div>
    <div><dt>${t("最近缓存更新", "Last cache update")}</dt><dd class="cache-updated">${formatDate(cache.updatedAt)}</dd><dd class="cache-detail">${t("按系统显示时区", "In the configured display time zone")}</dd></div>
  </dl>
  ${cache.protocolCounts.length ? `<div class="cache-protocols"><span class="muted">${t("协议分布", "Protocols")}</span>${renderCacheProtocols(cache.protocolCounts)}</div>` : ""}
  ${cache.sources.length ? `<div class="table-wrap"><table class="cache-table"><thead><tr><th>${t("订阅源", "Source")}</th><th>${t("缓存状态", "Cache status")}</th><th>${t("节点数", "Nodes")}</th><th>${t("协议分布", "Protocols")}</th><th>${t("更新时间", "Updated")}</th></tr></thead><tbody>${cache.sources.map((source) => `<tr><td class="cache-source-name">${esc(source.sourceName || source.sourceId || t("未命名订阅源", "Unnamed source"))}</td><td><span class="chip ${source.cached ? "cache-ready" : "cache-missing"}">${source.cached ? t("已缓存", "Cached") : t("未缓存", "Not cached")}</span></td><td>${source.cached ? esc(source.nodeCount) : "—"}</td><td>${source.cached ? renderCacheProtocols(source.protocolCounts) : "—"}</td><td class="request-time">${source.cached ? formatDate(source.fetchedAt) : "—"}</td></tr>`).join("")}</tbody></table></div>` : `<p class="empty">${t('还没有启用的订阅源。请先在<a href="#sources">订阅源</a>中添加或启用并保存。', 'No enabled sources yet. Add or enable a source in <a href="#sources">Subscription sources</a>, then save.')}</p>`}
  <p class="help">${t("强制刷新会重新拉取已保存并启用的订阅源；上游获取失败时保留可用的旧缓存。", "Force refresh fetches saved, enabled sources again. Available cached content is retained if an upstream fetch fails.")}</p>`;
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
function collectionPath(kind) {
  return kind === "nodes" ? "proxyNodes" : kind === "rule-sources" ? `${basePath()}.ruleSets.sources` : "sources";
}
function collection(kind) {
  return getPath(state.config, collectionPath(kind));
}
function renderEntities(kind) {
  const items = collection(kind);
  const isNode = kind === "nodes";
  return `${kind === "rule-sources" ? clientTabs() : ""}<p class="muted">${kind === "rule-sources" ? t("规则来源仅用于当前客户端，编辑或删除不会改变其他客户端的来源。", "Rule sources belong to this client. Editing or deleting them does not change other clients.") : t("订阅源和代理节点供三个客户端共用。", "Subscription sources and proxy nodes are shared by all three clients.")}</p><div class="toolbar">${btn(icon("plus") + t("添加", "Add"), "add-entity", `data-kind="${kind}"`, "primary")}${kind === "sources" ? btn(t("刷新订阅", "Refresh subscriptions"), "refresh-sources") : ""}</div><div class="table-wrap"><table class="editable-table"><thead><tr><th>${t("启用", "Enabled")}</th><th>${t("名称", "Name")}</th><th>${isNode ? t("节点配置", "Node configuration") : t("来源", "Source")}</th><th>${isNode ? t("链式出口", "Chain exit") : kind === "sources" ? "User-Agent" : t("格式", "Format")}</th><th class="actions">${t("操作", "Actions")}</th></tr></thead><tbody>${items.map((item, index) => `<tr><td><input type="checkbox" class="toggle" aria-label="${t("启用", "Enable")} ${esc(item.name || item.id)}" data-field="${collectionPath(kind)}.${index}.enabled" ${item.enabled ? "checked" : ""}></td><td class="entity-name">${btn(esc(item.name || item.config?.split(/[=\n]/)[0] || item.id), "edit-entity", `data-kind="${kind}" data-index="${index}"`, "link entity-link")}</td><td class="truncate">${esc(isNode ? t("编辑查看完整配置", "Edit to view full configuration") : sourceHost(item.url))}</td><td class="truncate">${esc(isNode ? item.chainExit ? t("是", "Yes") : t("否", "No") : kind === "sources" ? item.fetchUserAgent : item.format)}</td><td class="actions">${smallButton("edit", "edit-entity", `data-kind="${kind}" data-index="${index}"`, t("编辑", "Edit"))}${smallButton("trash", "delete-entity", `data-kind="${kind}" data-index="${index}"`, t("删除", "Delete"))}</td></tr>`).join("") || `<tr><td colspan="5" class="empty">${t("还没有添加资源", "No resources yet")}</td></tr>`}</tbody></table></div>`;
}
function sourceHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return "—";
  }
}
function renderGroups() {
  const client = currentClient();
  return clientTabs() + `<p class="muted">${t("策略组仅用于当前客户端，同名组可在不同客户端分别配置。", "Policy groups belong to this client. Groups with the same name can have different settings in other clients.")}</p><div class="toolbar">${btn(icon("plus") + t("添加策略组", "Add group"), "add-group", "", "primary")}</div><div class="table-wrap"><table class="editable-table"><thead><tr><th>${t("名称", "Name")}</th><th>${t("组配置", "Group definition")}</th><th class="actions">${t("操作", "Actions")}</th></tr></thead><tbody>${Object.entries(client.groups).map(([name, spec]) => `<tr><td class="entity-name">${btn(esc(name), "edit-group", `data-name="${esc(name)}"`, "link entity-link")}${client.disabledGroups.includes(name) ? ` <span class="chip">${t("停用", "Disabled")}</span>` : ""}</td><td class="truncate">${esc(spec)}</td><td class="actions">${smallButton("edit", "edit-group", `data-name="${esc(name)}"`, t("编辑", "Edit"))}${name !== "Proxy" ? smallButton("trash", "delete-group", `data-name="${esc(name)}"`, t("删除", "Delete")) : ""}</td></tr>`).join("")}</tbody></table></div>`;
}
function renderClient() {
  const client = state.config.clients[state.client];
  const fields = CLIENT_SECTIONS[state.client][state.section] || [];
  const tabs = [["network", "网络与 TUN", "Network & TUN"], ["dns", "DNS", "DNS"], ["rules", "路由规则", "Routing"], ["advanced", "高级设置", "Advanced"], ...state.client === "surge" ? [["mitm", "MITM 证书", "MITM certificates"]] : []];
  let content = "";
  if (state.client === "surge" && state.section === "mitm") content = renderMitm();
  else if (state.section === "rules") content = renderRules();
  else if (state.client === "singbox" && state.section === "dns") content = renderSingboxDns();
  else content = fields.map((key) => section(label(key), typeof client[key] === "object" && !Array.isArray(client[key]) ? Object.entries(client[key]).map(([sub, value]) => field(`${basePath()}.${key}.${sub}`, value)).join("") : field(`${basePath()}.${key}`, client[key]), client[key] && typeof client[key] === "object" ? btn(t("完整 JSON", "Full JSON"), "edit-json", `data-path="${basePath()}.${key}"`) : "")).join("");
  if (state.client === "singbox" && state.section === "advanced") content = `<div class="toolbar">${btn(t("编辑客户端 JSON", "Edit client JSON"), "edit-native-config")}</div>` + content;
  if (!content) content = `<p class="empty">${t("此客户端的设置均在其他分栏中提供。", "All settings for this client are available in the other tabs.")}</p>`;
  return clientTabs() + `<div class="section-tabs">${tabs.map(([id, zh, en]) => btn(t(zh, en), "section", `data-section="${id}"`, state.section === id ? "selected" : "")).join("")}</div>` + content;
}
function renderSingboxDns() {
  const dns = state.config.clients.singbox.dns;
  return section(t("DNS 解析", "DNS resolution"), `<div class="table-wrap"><table><thead><tr><th>${t("名称", "Tag")}</th><th>${t("类型", "Type")}</th><th>${t("服务器", "Server")}</th><th>${t("操作", "Actions")}</th></tr></thead><tbody>${(Array.isArray(dns.servers) ? dns.servers : []).map((server, index) => `<tr><td>${esc(server?.tag)}</td><td>${esc(server?.type)}</td><td>${esc(server?.server || server?.inet4_range || "—")}</td><td>${smallButton("edit", "edit-dns", `data-index="${index}"`, t("编辑", "Edit"))}${smallButton("trash", "delete-dns", `data-index="${index}"`, t("删除", "Delete"))}</td></tr>`).join("")}</tbody></table></div>${btn(icon("plus") + t("添加解析器", "Add resolver"), "add-dns")}<div class="toolbar"></div>${Object.entries(dns).filter(([key]) => key !== "servers").map(([key, value]) => field(`${basePath()}.dns.${key}`, value)).join("")}`, btn(t("完整 JSON", "Full JSON"), "edit-json", `data-path="${basePath()}.dns"`));
}
function renderMitm() {
  const mitm = state.config.clients.surge.mitm;
  const path = "clients.surge.mitm";
  return section(t("MITM 证书管理", "MITM certificate management"), `<p class="muted">${t("生成或导入 Surge 使用的 CA 证书。修改后保存配置，再在客户端更新订阅。", "Generate or import a CA certificate for Surge. Save changes, then update the subscription in your client.")}</p><p id="ca-status" role="status">${mitm.caP12 ? t("已配置 CA 证书", "CA certificate configured") : t("尚未配置 CA 证书", "No CA certificate configured")}</p><div class="toolbar">${btn(t("生成证书", "Generate certificate"), "generate-ca", "", "primary")}${btn(t("导入证书", "Import certificate"), "import-ca")}${btn(t("导出证书", "Export certificate"), "export-ca", mitm.caP12 ? "" : "disabled")}</div>${field(`${path}.caPassphrase`, mitm.caPassphrase)}<details><summary>${t("查看或编辑证书数据", "View or edit certificate data")}</summary>${field(`${path}.caP12`, mitm.caP12)}</details>`) + section(t("MITM 设置", "MITM settings"), Object.entries(mitm).filter(([key]) => !["caPassphrase", "caP12"].includes(key)).map(([key, value]) => field(`${path}.${key}`, value)).join(""));
}
function codePreview(text) {
  return `<div class="numbered-code code">${text.split("\n").map((line, index) => `<div><span class="line-number">${index + 1}</span><code>${esc(line).replace(/(&quot;.*?&quot;)(\s*:)?/g, (_, text2, colon) => `<span class="${colon ? "code-key" : "code-string"}">${text2}</span>${colon || ""}`) || " "}</code></div>`).join("")}</div>`;
}
function renderRules() {
  const client = state.config.clients[state.client];
  const native = state.client === "singbox";
  const path = native ? `${basePath()}.route.rules` : `${basePath()}.rules`;
  const rawRules = getPath(state.config, path);
  const rules = Array.isArray(rawRules) ? rawRules : [];
  const compiled = client.ruleSets.mode === "compiled";
  let html = `<div class="rule-mode"><label for="rule-mode">${t("规则来源", "Rule source")}</label><select id="rule-mode" data-field="${basePath()}.ruleSets.mode"><option value="manual" ${!compiled ? "selected" : ""}>${t("本端原生规则", "Native rules")}</option><option value="compiled" ${compiled ? "selected" : ""}>${t("本端来源编排", "Compile client sources")}</option></select></div>`;
  if (!compiled) {
    html += section(t("路由规则", "Routing rules"), `<div class="toolbar">${btn(t("结构化", "Structured"), "rules-structured", "", "primary")}${btn(native ? "JSON" : t("文本", "Text"), "edit-json", `data-path="${path}" data-lines="${native ? "false" : "true"}"`)}</div><div class="table-wrap"><table class="rule-table"><thead><tr><th>${t("顺序", "Order")}</th><th>${t("匹配类型", "Match")}</th><th>${t("匹配值", "Value")}</th><th>${t("出站策略", "Outbound")}</th><th>${t("操作", "Actions")}</th></tr></thead><tbody>${rules.map((rule, index) => ruleRow(rule, index, path, native)).join("") || `<tr><td colspan="5" class="empty">${t("还没有规则", "No rules")}</td></tr>`}</tbody></table></div>${btn(icon("plus") + t("添加规则", "Add rule"), "add-rule", `data-path="${path}"`)}${native ? `<div class="toolbar"></div>${field(`${basePath()}.route.final`, client.route.final || "", { label: t("默认出站", "Default outbound"), options: [.../* @__PURE__ */ new Set([...Object.keys(currentClient().groups), "DIRECT", client.route.final || ""])] })}` : ""}<div class="toolbar"><span>${t("当前端策略组：", "Client groups:")}</span>${Object.keys(currentClient().groups).slice(0, 7).map((name) => `<span class="chip">${esc(name)}</span>`).join("")}<a href="#groups">${t("管理策略组", "Manage groups")}</a></div><p class="small">${native ? t("当前规则 JSON", "Current rules JSON") : t("当前规则文本", "Current rule text")}</p>${codePreview(native ? JSON.stringify({ route: { rules: client.route.rules, final: client.route.final } }, null, 2) : rules.join("\n"))}`);
  }
  if (native) html += section(t("其他路由设置", "Other route settings"), Object.entries(client.route).filter(([key]) => !["rules", "final"].includes(key)).map(([key, value]) => field(`${basePath()}.route.${key}`, value)).join(""), btn(t("完整 JSON", "Full JSON"), "edit-json", `data-path="${basePath()}.route"`));
  if (state.client === "clash") html += section(t("原生规则提供者", "Native rule providers"), field(`${basePath()}.ruleProviders`, client.ruleProviders, { multiline: true }));
  if (compiled) html += renderRulePlan(client.ruleSets);
  return html;
}
function ruleRow(rule, index, path, native) {
  let type, value, policy;
  let simple = true;
  if (native) {
    const keys = isObject(rule) ? Object.keys(rule).filter((key) => Object.hasOwn(RULE_FIELDS, key)) : [];
    if (!isObject(rule)) rule = { action: "JSON" };
    type = keys[0] || rule.type || rule.action || "JSON";
    value = keys.length === 1 ? Array.isArray(rule[type]) ? rule[type].join(", ") : rule[type] : t("高级规则", "Advanced rule");
    policy = rule.outbound || rule.action || "route";
    simple = keys.length === 1 && ["route", "reject", "hijack-dns", "sniff"].includes(rule.action || "route");
  } else {
    const parts = splitRule(rule);
    type = parts[0];
    const isFinal = type === "FINAL" || type === "MATCH";
    value = isFinal ? "—" : parts[1];
    policy = parts[isFinal ? 1 : 2] || "—";
    simple = LEGACY_RULE_FIELDS.includes(type);
  }
  const types = native ? Object.keys(RULE_FIELDS) : LEGACY_RULE_FIELDS;
  const choices = [...new Set([...Object.keys(currentClient().groups), "DIRECT", "REJECT", "REJECT-DROP", ...(native ? ["hijack-dns", "sniff", "reject"] : []), policy])];
  const select = (kind, values, current) => `<select data-rule-field="${kind}" data-path="${path}" data-index="${index}" aria-label="${t("规则", "Rule")} ${index + 1} ${kind}">${values.map((item) => `<option value="${esc(item)}" ${item === current ? "selected" : ""}>${esc(kind === "type" && native ? t(...RULE_FIELDS[item]) : item)}</option>`).join("")}</select>`;
  return `<tr><td>${index + 1}</td><td>${simple ? select("type", types, type) : esc(type)}</td><td class="truncate">${esc(value)}</td><td>${simple ? select("policy", choices, policy) : esc(policy)}</td><td class="actions"><span class="order">${smallButton("up", "move-rule", `data-path="${path}" data-index="${index}" data-direction="-1" ${index === 0 ? "disabled" : ""}`, t("上移", "Move up"))}${smallButton("down", "move-rule", `data-path="${path}" data-index="${index}" data-direction="1" ${index === getPath(state.config, path).length - 1 ? "disabled" : ""}`, t("下移", "Move down"))}</span>${smallButton("edit", simple ? "edit-rule" : "edit-rule-json", `data-path="${path}" data-index="${index}"`, t("编辑", "Edit"))}${smallButton("trash", "delete-rule", `data-path="${path}" data-index="${index}"`, t("删除", "Delete"))}</td></tr>`;
}
function renderRulePlan(plan) {
  const actions = `<div class="toolbar">${btn(t("添加规则集", "Add rule set"), "add-output")}${btn(t("添加单条规则", "Add direct rule"), "add-direct")}${btn(t("刷新编译缓存", "Refresh compiled cache"), "refresh-rules")}</div>`;
  const outputRows = plan.outputs.map((output, index) => `<tr><td>${esc(output.order)}</td><td>${esc(output.name)}</td><td>${esc(output.policy)}</td><td>${output.sourceIds.map((id) => esc(currentClient().ruleSets.sources.find((source) => source.id === id)?.name || id)).join(", ") || t("内联规则", "Inline rules")}</td><td>${smallButton("edit", "edit-output", `data-index="${index}"`, t("编辑", "Edit"))}${smallButton("trash", "delete-output", `data-index="${index}"`, t("删除", "Delete"))}</td></tr>`).join("");
  const directRows = plan.directRules.map((rule, index) => `<tr><td>${esc(rule.order)}</td><td>${esc(rule.name)}${!rule.enabled ? `<span class="chip">${t("停用", "Disabled")}</span>` : ""}</td><td class="truncate">${esc(rule.rule)}</td><td>${esc(rule.policy)}</td><td>${smallButton("edit", "edit-direct", `data-index="${index}"`, t("编辑", "Edit"))}${smallButton("trash", "delete-direct", `data-index="${index}"`, t("删除", "Delete"))}</td></tr>`).join("");
  return section(t("规则集编排", "Rule-set plan"), `<p class="help">${t("来源、选择、策略和排序均仅对当前客户端生效。", "Sources, selection, policy and order belong to this client.")}</p>${field(`${basePath()}.ruleSets.aggregateByPolicy`, plan.aggregateByPolicy)}${actions}<div class="table-wrap"><table><thead><tr><th>${t("顺序", "Order")}</th><th>${t("规则集", "Rule set")}</th><th>${t("策略", "Policy")}</th><th>${t("来源", "Sources")}</th><th>${t("操作", "Actions")}</th></tr></thead><tbody>${outputRows}</tbody></table></div><h3>${t("单条规则", "Direct rules")}</h3><div class="table-wrap"><table><thead><tr><th>${t("顺序", "Order")}</th><th>${t("名称", "Name")}</th><th>${t("规则", "Rule")}</th><th>${t("策略", "Policy")}</th><th>${t("操作", "Actions")}</th></tr></thead><tbody>${directRows}</tbody></table></div><p class="help">${t("按顺序数字合并规则集与单条规则；数字越小越先匹配，兜底规则放在最后。", "Rule sets and direct rules share the same order. Lower numbers match first; put the final rule last.")}</p>`);
}
function editDirect(index) {
  const rules = state.config.clients[state.client].ruleSets.directRules;
  const original = index === null ? { id: crypto.randomUUID(), name: "", rule: "DOMAIN-SUFFIX,example.com", policy: "Proxy", order: rules.length, enabled: true } : rules[index];
  modal(t("编辑单条规则", "Edit direct rule"), Object.entries(original).filter(([key]) => key !== "id").map(([key, value]) => localField(key, value, key === "policy" ? { options: [...new Set([...Object.keys(currentClient().groups), "DIRECT", "REJECT", "REJECT-DROP", value])] } : {})).join(""), () => {
    const value = readLocal(original);
    if (!value.rule.trim()) throw Error(t("请填写规则", "Enter a rule"));
    if (index === null) rules.push(value); else rules[index] = value;
    closeModal(); changed(); render();
  });
}

function renderLinks() {
  return `<p class="muted">${t("三个客户端使用同一条订阅地址，按 User-Agent 自动识别 Surge、clash或 sing-box。请在客户端中导入；链接中的 token 授予订阅读取权限。", "All three clients use this subscription URL. User-Agent identifies Surge, clash, or sing-box. Import it in your client; the token grants subscription read access.")}</p><div id="subscription-links"><p class="muted">${t("正在读取…", "Loading…")}</p></div><div class="toolbar">${btn(t("轮换读取 token", "Rotate read token"), "rotate-token", "", "danger")}</div>`;
}
function renderSystem() {
  const mmdbPaths = [["Surge macOS", "~/Library/Application Support/com.nssurge.surge-mac/GeoLite2-Country.mmdb"], ["Clash Verge Windows", "%APPDATA%\\io.github.clash-verge-rev.clash-verge-rev\\Country.mmdb"], ["Clash Verge macOS", "~/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/Country.mmdb"]];
  const hidden = ["userAgentStash", "userAgentShadowrocket", "notificationChannel", "notificationTelegramWebhookSecret"];
  return section(t("系统设置", "System settings"), Object.entries(state.config.settings).filter(([key]) => !hidden.includes(key)).map(([key, value]) => field(`settings.${key}`, value)).join("")) + section("GeoIP MMDB", `<p class="help">${t("上传 MMDB 数据库用于节点地理位置识别。", "Upload an MMDB database for node geolocation.")}</p><div id="mmdb-status"></div><div class="mmdb-upload-controls"><label for="mmdb-upload">${t("选择数据库文件", "Choose database file")}</label><input type="file" id="mmdb-upload" accept=".mmdb" ${mmdb.uploading ? "disabled" : ""}>${btn(t("上传", "Upload"), "upload-mmdb", 'id="mmdb-submit" disabled', "primary")}</div><div id="mmdb-transfer" role="status" aria-live="polite"></div><p class="help">${t("最大 25 MiB。选择文件后点击上传，成功后立即生效。", "Up to 25 MiB. Select a file, then click Upload. Changes take effect on success.")}</p><div class="mmdb-path-help help" aria-label="${t("MMDB 文件路径参考", "MMDB file path reference")}"><p>${t("可从本机客户端选择现有文件：", "Select an existing file from a local client:")}</p><ul>${mmdbPaths.map(([client, path]) => `<li><span>${esc(client)}</span><code>${esc(path)}</code></li>`).join("")}</ul></div>`) + section("Telegram", `<div class="toolbar">${btn(t("生成绑定码", "Generate binding code"), "telegram-bind")}${btn(t("解除绑定", "Unbind"), "telegram-unbind", "", "danger")}</div><p class="help">${t("通知凭据保存后生效。", "Save notification credentials before binding.")}</p>`);
}
function mmdbSize(size) {
  return `${(size / 1024 / 1024).toFixed(2)} MiB`;
}
function updateMmdbView() {
  const status = $("#mmdb-status");
  if (!status) return;
  const current = mmdb.status;
  const rows = current?.uploaded ? [
    [t("当前文件", "Current file"), current.fileName || "—"],
    [t("数据库类型", "Database type"), current.databaseType || t("未知", "Unknown")],
    [t("数据库版本（构建时间）", "Database version (build time)"), current.builtAt ? formatDate(current.builtAt) : t("未提供构建时间", "Build time unavailable")],
    [t("上传时间", "Uploaded at"), formatDate(current.updatedAt)],
    [t("文件大小", "File size"), mmdbSize(current.size || 0)]
  ] : [];
  status.innerHTML = rows.map(([name, value]) => `<div class="status-row"><span>${esc(name)}</span><strong class="value">${esc(value)}</strong></div>`).join("") + (current && !current.uploaded ? `<p class="muted">${t("尚未上传 MMDB 数据库。", "No MMDB database uploaded.")}</p>` : "") + (mmdb.loading ? `<p class="muted">${t("正在读取数据库信息…", "Loading database information…")}</p>` : "") + (mmdb.statusError ? `<p class="danger-text">${t("无法读取当前数据库信息，请重试。", "Could not load current database information. Please retry.")}</p>` : "") + btn(t("刷新数据库信息", "Refresh database information"), "refresh-mmdb", mmdb.loading || mmdb.uploading ? "disabled" : "");
  $("#mmdb-upload").disabled = mmdb.uploading;
  $("#mmdb-submit").disabled = !mmdb.file || mmdb.uploading;
  $("#mmdb-submit").textContent = mmdb.uploading ? t("上传中…", "Uploading…") : t("上传", "Upload");
  const selected = mmdb.file ? `<p class="mmdb-file">${t("已选择：", "Selected: ")}${esc(mmdb.file.name)} · ${mmdbSize(mmdb.file.size)}</p>` : "";
  const message = mmdb.uploading ? (mmdb.progress < 100 ? t(`正在上传 ${mmdb.progress}%`, `Uploading ${mmdb.progress}%`) : t("传输完成，正在校验并保存数据库…", "Transfer complete. Validating and saving the database…")) : mmdb.outcome === "success" ? t("上传成功，当前数据库信息已更新。", "Upload succeeded. Current database information updated.") : mmdb.outcome === "invalid" ? t("请选择非空的 .mmdb 文件，大小不能超过 25 MiB。", "Choose a nonempty .mmdb file up to 25 MiB.") : mmdb.outcome === "error" ? t(`上传未完成：${mmdb.error}。可点击上传重试，或刷新数据库信息确认当前状态。`, `Upload did not complete: ${mmdb.error}. Retry the upload or refresh database information to check the current state.`) : mmdb.file ? t("文件已准备好，请点击上传。", "File ready. Click Upload to start.") : "";
  $("#mmdb-transfer").innerHTML = selected + (mmdb.uploading ? `<progress max="100" ${mmdb.progress < 100 ? `value="${mmdb.progress}"` : ""} aria-label="${t("MMDB 上传进度", "MMDB upload progress")}"></progress>` : "") + `<p class="${["error", "invalid"].includes(mmdb.outcome) ? "danger-text" : "muted"}">${esc(message)}</p>`;
  $("#mmdb-transfer").setAttribute("aria-busy", String(mmdb.uploading));
}
async function loadMmdbStatus() {
  if (mmdb.uploading) return;
  const request = ++mmdb.request;
  mmdb.loading = true;
  mmdb.statusError = false;
  updateMmdbView();
  try {
    const status = await api("/api/geoip/mmdb");
    if (request === mmdb.request) mmdb.status = status;
  } catch {
    if (request === mmdb.request) mmdb.statusError = true;
  } finally {
    if (request === mmdb.request) {
      mmdb.loading = false;
      updateMmdbView();
    }
  }
}
async function uploadMmdb() {
  if (!mmdb.file || mmdb.uploading) return;
  const file = mmdb.file;
  ++mmdb.request;
  mmdb.loading = false;
  mmdb.uploading = true;
  mmdb.progress = 0;
  mmdb.outcome = "";
  updateMmdbView();
  try {
    const status = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/geoip/mmdb");
      xhr.timeout = 120000;
      xhr.setRequestHeader("content-type", "application/octet-stream");
      xhr.setRequestHeader("x-subpilot-file-name", encodeURIComponent(file.name));
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) mmdb.progress = Math.min(100, Math.floor(event.loaded / event.total * 100));
        updateMmdbView();
      };
      xhr.upload.onload = () => { mmdb.progress = 100; updateMmdbView(); };
      xhr.onload = () => {
        if (xhr.status === 401) { reject(Error(t("会话已过期，请重新登录", "Session expired. Sign in again"))); return; }
        let result;
        try { result = JSON.parse(xhr.responseText); } catch { reject(Error(t("服务器返回无效响应", "Invalid server response"))); return; }
        if (xhr.status < 200 || xhr.status >= 300 || !result?.uploaded) reject(Error(result?.error || t(`服务器错误 (${xhr.status})`, `Server error (${xhr.status})`)));
        else resolve(result);
      };
      xhr.onerror = () => reject(Error(t("网络连接失败", "Network connection failed")));
      xhr.ontimeout = () => reject(Error(t("请求超时", "Request timed out")));
      xhr.onabort = () => reject(Error(t("上传已中断", "Upload interrupted")));
      xhr.send(file);
    });
    mmdb.status = status;
    mmdb.statusError = false;
    mmdb.file = null;
    mmdb.outcome = "success";
    if ($("#mmdb-upload")) $("#mmdb-upload").value = "";
    toast(t("MMDB 已上传", "MMDB uploaded"));
  } catch (error) {
    mmdb.outcome = "error";
    mmdb.error = error.message;
  } finally {
    mmdb.uploading = false;
    updateMmdbView();
  }
}
function modal(title, body, onSave, saveLabel = t("应用更改", "Apply changes")) {
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = body;
  $("#modal-actions").innerHTML = btn(t("取消", "Cancel"), "close-modal") + (onSave ? btn(saveLabel, "modal-save", "", "primary") : "");
  modal.save = onSave;
  $("#modal").showModal();
}
function closeModal() {
  if (modal.generatingCa) return;
  $("#modal").close();
  modal.save = null;
}
function localField(key, value, options = {}) {
  return field(key, value, options).replaceAll("data-field=", "data-local=");
}
function readLocal(original) {
  const result = structuredClone(original);
  for (const input of $("#modal-body").querySelectorAll("[data-local]")) {
    const key = input.dataset.local;
    let value = input.value;
    if (input.type === "checkbox") value = input.checked;
    else if (input.dataset.kind === "number") {
      value = Number(value);
      if (!Number.isFinite(value)) throw Error(t("请输入有效数字", "Enter a valid number"));
    } else if (input.dataset.kind === "lines") value = value.split("\n").map((line) => line.trim()).filter(Boolean);
    else if (input.dataset.kind === "json") value = JSON.parse(value);
    result[key] = value;
  }
  return result;
}
function updateChainFilterVisibility() {
  const toggle = $('#modal-body [data-local="chainExit"]');
  const row = $('#modal-body [data-local="chainFilter"]')?.closest(".form-row");
  if (row) row.hidden = !toggle?.checked;
}
function editEntity(kind, index) {
  const items = collection(kind);
  const original = index === null ? kind === "nodes" ? { id: crypto.randomUUID(), config: "", chainFilter: [], enabled: true, chainExit: false, includeInGroups: true } : kind === "rule-sources" ? { id: crypto.randomUUID(), name: "", url: "", enabled: true, format: "auto", order: items.length } : { id: crypto.randomUUID(), name: "", url: "", fetchUserAgent: state.config.settings.userAgentSurge, enabled: true } : items[index];
  const entries = Object.entries(original).filter(([key]) => !["id", "urlEncrypted"].includes(key));
  const fields = kind === "nodes" ? entries.filter(([key]) => key !== "chainFilter").flatMap((entry) => entry[0] === "chainExit" ? [entry, ["chainFilter", original.chainFilter || []]] : [entry]) : entries;
  const body = fields.map(([key, value]) => localField(key, value, key === "chainFilter" ? {
    label: t("前置节点筛选", "Upstream node selection"),
    help: t("每行一个关键词。节点名称或标签包含任一关键词即选中，不区分大小写，不支持正则。仅为命中的非出口节点生成链式节点，留空不生成。链路：本机 → 命中节点 → 当前出口节点 → 目标网站。", "One keyword per line. Select nodes whose name or labels contain any keyword, ignoring case; regular expressions are not supported. Only matching non-exit nodes generate chained nodes; leave empty to generate none. Path: device → matching node → current exit node → destination.")
  } : key === "config" ? { multiline: true } : key === "format" ? { options: ["auto", "surge-rule-set", "surge-domain-set", "clash-yaml", "plain-domain", "plain-ipcidr", "plain-classical"] } : {})).join("");
  modal(kind === "rule-sources" ? t(`编辑 ${CLIENTS[state.client].label} 规则来源`, `Edit ${CLIENTS[state.client].label} rule source`) : t("编辑共享资源", "Edit shared resource"), body, () => {
    const updated = readLocal(original);
    if (kind !== "nodes" && !updated.name.trim()) throw Error(t("请填写名称", "Enter a name"));
    if (index === null) items.push(updated);
    else items[index] = updated;
    closeModal();
    changed();
    render();
  });
  if (kind === "nodes") updateChainFilterVisibility();
}
function editGroup(name) {
  const original = name ? { name, spec: currentClient().groups[name], enabled: !currentClient().disabledGroups.includes(name) } : { name: "", spec: "select, {all}", enabled: true };
  modal(t("编辑策略组", "Edit policy group"), localField("name", original.name) + localField("spec", original.spec, { label: t("组配置", "Group definition"), multiline: true }) + localField("enabled", original.enabled) + `<p class="help">${state.client === "surge" ? t("可使用 smart；兼容将 url-test 输出为 smart。smart 成员必须是代理节点，hidden=true 可隐藏组。", "Use smart; url-test is also emitted as smart for compatibility. Smart requires proxy-node members; hidden=true hides a group.") : state.client === "clash" ? t("支持 select、url-test、fallback 和 load-balance；hidden=true 的显示效果需要客户端或面板支持。", "Supports select, url-test, fallback and load-balance. hidden=true requires client or dashboard support.") : t("支持 select 和 url-test，分别输出为 selector 和 urltest；不支持 hidden。", "Supports select and url-test, emitted as selector and urltest. hidden is unsupported.")} ${t("修改名称不会自动重写规则引用。", "Renaming does not rewrite rule references.")}</p>`, () => {
    const value = readLocal(original);
    value.name = value.name.trim();
    if (!value.name || /[\r\n,=]/.test(value.name)) throw Error(t("策略组名称无效", "Invalid group name"));
    if (name === "Proxy" && (value.name !== "Proxy" || !value.enabled)) throw Error(t("Proxy 必须保留并启用", "Proxy must remain enabled"));
    if (value.name !== name && value.name in currentClient().groups) throw Error(t("策略组名称已存在", "Group name already exists"));
    if (name) {
      delete currentClient().groups[name];
      currentClient().disabledGroups = currentClient().disabledGroups.filter((item) => item !== name);
    }
    currentClient().groups[value.name] = value.spec;
    if (!value.enabled) currentClient().disabledGroups.push(value.name);
    closeModal();
    changed();
    render();
  });
}
function editJson(path, lines = false) {
  const value = getPath(state.config, path);
  modal(label(path.split(".").at(-1)), `<textarea id="json-editor" class="code code-editor" rows="20" spellcheck="false">${esc(lines ? value.join("\n") : JSON.stringify(value, null, 2))}</textarea><p class="help">${t("文本模式保留原生内容。应用时只检查格式，生成订阅时检查目标兼容性。", "Text mode preserves native content. Format is checked on apply; target compatibility is checked when generating subscriptions.")}</p>`, () => {
    const text = $("#json-editor").value;
    const next = lines ? text.split("\n").map((line) => line.trim()).filter(Boolean) : JSON.parse(text);
    if (Array.isArray(value) !== Array.isArray(next) || typeof value !== typeof next) throw Error(t("数据类型必须保持一致", "The value must retain its data type"));
    if (path.startsWith("clients.singbox")) validateNativeShape(next, path);
    if (isObject(value) && !isObject(next)) throw Error(t("需要 JSON 对象", "A JSON object is required"));
    setPath(state.config, path, next);
    state.invalid.delete(path);
    closeModal();
    changed();
    render();
  });
}
function editRule(path, index, forceJson = false, selectedType) {
  const rules = getPath(state.config, path);
  const native = state.client === "singbox";
  const original = index === null ? native ? { domain_suffix: [""], action: "route", outbound: "Proxy" } : "DOMAIN-SUFFIX,,Proxy" : rules[index];
  if (forceJson) {
    modal(t("编辑原生规则", "Edit native rule"), `<textarea id="rule-native" class="code code-editor" rows="12">${esc(native ? JSON.stringify(original, null, 2) : original)}</textarea>`, () => {
      const text = $("#rule-native").value;
      const value2 = native ? JSON.parse(text) : text;
      if (native && (!value2 || typeof value2 !== "object" || Array.isArray(value2))) throw Error(t("规则必须是对象", "A rule must be an object"));
      if (index === null) rules.push(value2);
      else rules[index] = value2;
      closeModal();
      changed();
      render();
    });
    return;
  }
  let type, value, policy;
  if (native) {
    type = Object.keys(original).find((key) => Object.hasOwn(RULE_FIELDS, key)) || "domain_suffix";
    value = Array.isArray(original[type]) ? original[type].join("\n") : String(original[type] || "");
    policy = original.outbound || original.action || "Proxy";
  } else {
    const parts = splitRule(original);
    type = parts[0];
    value = ["FINAL", "MATCH"].includes(type) ? "" : parts[1];
    policy = parts[["FINAL", "MATCH"].includes(type) ? 1 : 2] || "Proxy";
  }
  const originalForm = { type: selectedType || type, value, policy };
  const types = native ? Object.keys(RULE_FIELDS) : LEGACY_RULE_FIELDS;
  const choices = [...Object.keys(currentClient().groups), "DIRECT", "REJECT", "REJECT-DROP", ...native ? ["hijack-dns", "sniff", "reject"] : []];
  modal(t("编辑路由规则", "Edit routing rule"), localField("type", selectedType || type, { label: t("匹配类型", "Match type"), options: types }) + localField("value", value, { label: t("匹配值（每行一项）", "Match values (one per line)"), multiline: true }) + localField("policy", policy, { options: [.../* @__PURE__ */ new Set([...choices, policy])] }) + `<p class="help">${t("高级匹配请使用原生文本编辑，原有附加字段会保留。", "Use native editing for advanced matching. Existing additional fields are preserved.")}</p>`, () => {
    const form = readLocal(originalForm);
    let next;
    if (native) {
      next = { ...original };
      delete next[type];
      const values = form.value.split("\n").map((item) => item.trim()).filter(Boolean);
      if (!values.length) throw Error(t("请填写匹配值", "Enter a match value"));
      next[form.type] = form.type === "port" ? values.map(Number) : values;
      if (["hijack-dns", "sniff", "reject"].includes(form.policy)) {
        next.action = form.policy;
        delete next.outbound;
      } else if (form.policy.startsWith("REJECT")) {
        next.action = "reject";
        delete next.outbound;
        if (form.policy === "REJECT-DROP") next.method = "drop";
      } else {
        next.action = "route";
        next.outbound = form.policy;
        delete next.method;
      }
    } else {
      const parts = splitRule(original);
      const final = ["FINAL", "MATCH"].includes(form.type);
      if (!final && !form.value.trim()) throw Error(t("请填写匹配值", "Enter a match value"));
      next = [form.type, ...final ? [] : [form.value.trim()], form.policy, ...parts.slice(["FINAL", "MATCH"].includes(parts[0]) ? 2 : 3)].join(",");
    }
    if (index === null) rules.push(next);
    else rules[index] = next;
    closeModal();
    changed();
    render();
  });
}
function editDns(index) {
  const dns = state.config.clients.singbox.dns;
  dns.servers ??= [];
  const original = index === null ? { type: "udp", tag: `dns-${dns.servers.length + 1}`, server: "" } : dns.servers[index];
  modal(t("编辑 DNS 服务器", "Edit DNS server"), `<p class="help">${t("按 sing-box 1.14 原生结构配置，支持 UDP、TLS、HTTPS、Fake IP 等。", "Use the sing-box 1.14 native structure for UDP, TLS, HTTPS, Fake IP and other server types.")}</p><textarea id="dns-json" class="code code-editor" rows="12">${esc(JSON.stringify(original, null, 2))}</textarea>`, () => {
    const value = JSON.parse($("#dns-json").value);
    if (!value.type || !value.tag) throw Error(t("需要类型和名称", "Type and tag are required"));
    if (index === null) dns.servers.push(value);
    else dns.servers[index] = value;
    closeModal();
    changed();
    render();
  });
}
function editOutput(index) {
  const outputs = state.config.clients[state.client].ruleSets.outputs;
  const original = index === null ? { name: "", enabled: true, policy: "Proxy", sourceIds: [], inlineRules: [], order: outputs.length, surgeOptions: [] } : outputs[index];
  modal(t("编辑规则集编排", "Edit rule-set plan"), Object.entries(original).filter(([key]) => key !== "updatedAt" && key !== "sourceIds" && (key !== "surgeOptions" || state.client === "surge")).map(([key, value]) => localField(key, value)).join("") + `<div class="form-row"><label>${t("规则来源", "Rule sources")}</label><div>${currentClient().ruleSets.sources.map((source) => `<p><label><input type="checkbox" name="output-source" value="${esc(source.id)}" ${original.sourceIds.includes(source.id) ? "checked" : ""}> ${esc(source.name)}</label></p>`).join("") || `<a href="#rule-sources">${t("请先添加规则来源", "Add a rule source first")}</a>`}</div></div>`, () => {
    const value = readLocal(original);
    value.sourceIds = [...$("#modal-body").querySelectorAll("[name=output-source]:checked")].map((input) => input.value);
    if (!value.name.trim()) throw Error(t("请填写名称", "Enter a name"));
    if (outputs.some((item, i) => i !== index && item.name === value.name)) throw Error(t("规则集名称重复", "Duplicate rule-set name"));
    if (index === null) outputs.push(value);
    else outputs[index] = value;
    closeModal();
    changed();
    render();
  });
}
function confirmDelete(message, operation) {
  modal(t("确认删除", "Confirm deletion"), `<p>${esc(message)}</p>`, () => {
    operation();
    closeModal();
    changed();
    render();
  }, t("删除", "Delete"));
}
async function save() {
  if (state.invalid.size || state.busy) return;
  state.busy = true;
  updateStatus();
  try {
    const sent = structuredClone(state.config);
    const saved = await api("/api/config", { method: "PUT", body: JSON.stringify(sent) });
    if (JSON.stringify(state.config) === JSON.stringify(sent)) state.config = saved;
    state.saved = JSON.stringify(saved);
    toast(t("配置已保存", "Configuration saved"));
    render();
  } finally {
    state.busy = false;
    updateStatus();
  }
}
function showDiagnostics() {
  const migration = state.config.clients[state.client].migrationIssues || [];
  $("#diagnostics-title").textContent = t("迁移问题", "Migration issues");
  $("#diagnostic-items").innerHTML = `<p class="muted small">${esc(CLIENTS[state.client].label)}</p>${migration.map((item, index) => `<div class="diagnostic ${esc(item.severity)}"><strong>${esc(item.message)}</strong><span class="help">${esc(item.path)}</span>${btn(t("定位设置", "Locate setting"), "locate", `data-path="${esc(item.path)}"`)}${btn(t("已手动处理", "Mark resolved"), "resolve-issue", `data-index="${index}"`)}</div>`).join("")}${!migration.length ? `<p class="muted">${t("没有待处理的迁移问题。", "No pending migration issues.")}</p>` : ""}`;
  if ($("#diagnostics").hidden) showDiagnostics.previousFocus = document.activeElement;
  $("#diagnostics").hidden = false;
  for (const selector of [".workspace", ".sidebar", ".save-bar"]) $(selector).inert = true;
  document.body.classList.add("drawer-open");
  $("#close-diagnostics").focus();
}
function closeDiagnostics() {
  const wasOpen = !$("#diagnostics").hidden;
  $("#diagnostics").hidden = true;
  for (const selector of [".workspace", ".sidebar", ".save-bar"]) $(selector).inert = false;
  document.body.classList.remove("drawer-open");
  if (wasOpen && showDiagnostics.previousFocus?.isConnected) showDiagnostics.previousFocus.focus();
}
function download(content, name, type = "application/json") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1e3);
}
async function reviewMigration() {
  if (!state.migration) return;
  if (!state.migrationData) throw Error(t("请刷新页面后重新检查迁移。", "Reload the page and review migration again."));
  if (state.invalid.size) throw Error(t("请先修正格式无效的输入。", "Correct invalid inputs first."));
  const issues = state.config.clients.singbox.migrationIssues;
  modal(t("确认配置迁移", "Confirm configuration migration"), `<p>${t("迁移保留 Surge 与 clash 设置，sing-box 的转换问题可在迁移后继续修复。新配置写入并验证成功后，旧版配置将进入延迟清理。", "Migration preserves Surge and clash settings. sing-box conversion issues can be resolved afterward. Old configuration is scheduled for cleanup after the new configuration is written and verified.")}</p><p>${t(`sing-box 有 ${issues.filter((item) => item.severity === "error").length} 项待处理。`, `${issues.filter((item) => item.severity === "error").length} sing-box items require attention.`)}</p>`, async () => {
    const config = await api("/api/config/migration", { method: "POST", body: JSON.stringify({ config: state.config, fingerprint: state.migrationData.fingerprint }) });
    state.config = config;
    state.saved = JSON.stringify(config);
    state.migration = false;
    closeModal();
    render();
    toast(t("配置迁移已完成", "Configuration migration completed"));
  }, t("确认迁移", "Confirm migration"));
}
async function loadLinks() {
  if (state.page !== "links") return;
  const data = await api("/api/read-token");
  if (state.page !== "links") return;
  const base = (state.config.settings.managedBaseUrl || `${location.origin}/sync`).replace(/\/+$/, "");
  const root = `${base}/${encodeURIComponent(data.token)}/`;
  const links = [[t("通用订阅（自动识别）", "Universal (auto-detect)"), root]];
  $("#subscription-links").innerHTML = links.map(([name, url]) => `<div class="link-row"><label>${name}</label><input readonly type="password" value="${esc(url)}" aria-label="${esc(name)} URL">${btn(icon("copy"), "copy-link", `data-url="${esc(url)}" aria-label="${t("复制链接", "Copy link")}"`)}</div>`).join("");
}
async function refreshStatus() {
  const values = await Promise.allSettled([api("/api/stats"), api("/api/system/status")]);
  if (values[0].status === "fulfilled") {
    state.stats = values[0].value;
    state.requestPage = 0;
  }
  if (values[1].status === "fulfilled") state.system = values[1].value;
  if (state.page === "status") render();
}
async function action(button) {
  const { action: name, path, kind } = button.dataset;
  const index = button.dataset.index === void 0 ? null : Number(button.dataset.index);
  if (name === "upload-mmdb") { await uploadMmdb(); return; }
  if (name === "refresh-mmdb") { await loadMmdbStatus(); return; }
  if (name === "edit-native-config") {
    const { coreVersion, migrationIssues, ruleSets, groups, disabledGroups, ...native } = state.config.clients.singbox;
    modal(t("sing-box 客户端 JSON", "sing-box client JSON"), `<textarea id="native-config" class="code code-editor" rows="20">${esc(JSON.stringify(native, null, 2))}</textarea><p class="help">${t("可添加原生顶层设置；出站由共享节点和当前端策略组生成。", "Add native top-level settings here. Shared nodes and this client’s groups generate outbounds.")}</p>`, () => {
      const value = JSON.parse($("#native-config").value);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(t("配置必须是 JSON 对象", "Configuration must be a JSON object"));
      for (const key of ["log", "dns", "route", "experimental"]) if (!value[key] || typeof value[key] !== "object" || Array.isArray(value[key])) throw Error(`${key}: ${t("需要对象", "object required")}`);
      if (!Array.isArray(value.inbounds)) throw Error(t("入站需要数组", "inbounds must be an array"));
      validateNativeShape(value);
      state.config.clients.singbox = { ...value, coreVersion, migrationIssues, ruleSets, groups, disabledGroups };
      closeModal(); changed(); render();
    });
    return;
  }
  if (name === "add-direct" || name === "edit-direct") { editDirect(index); return; }
  if (name === "delete-direct") { state.config.clients[state.client].ruleSets.directRules.splice(index, 1); changed(); render(); return; }
  if (name === "generate-ca") {
    const mitm = state.config.clients.surge.mitm;
    const initialPassphrase = mitm.caPassphrase || crypto.randomUUID().replaceAll("-", "");
    modal(t("生成 MITM CA", "Generate MITM CA"), localField("passphrase", initialPassphrase, { label: t("CA 密码", "CA passphrase") }) + `<p class="help">${t("已填入 CA 密码，可自行修改。证书在当前浏览器生成，完成后填入配置草稿。", "A CA passphrase is filled in and can be changed. The certificate is generated in this browser and added to the configuration draft.")}</p>${mitm.caP12 ? `<p class="help">${t("生成成功后将替换草稿中的现有证书。", "Successful generation replaces the existing certificate in the draft.")}</p>` : ""}<p id="ca-generation-status" role="status" aria-live="polite"></p>`, async () => {
      if (modal.generatingCa) return;
      const passphrase = readLocal({ passphrase: "" }).passphrase.trim();
      if (!passphrase) throw Error(t("请填写 CA 密码", "Enter a CA passphrase"));
      modal.generatingCa = true;
      const controls = [...$("#modal").querySelectorAll("button, input")];
      controls.forEach((control) => control.disabled = true);
      $("#ca-generation-status").textContent = t("正在生成证书，请稍候…", "Generating certificate. Please wait…");
      try {
        const { generateMitmCaP12 } = await import("/mitm-ca.js");
        const result = await generateMitmCaP12({ passphrase });
        mitm.caPassphrase = passphrase;
        mitm.caP12 = result.caP12;
        modal.generatingCa = false;
        closeModal();
        changed();
        render();
        toast(t("证书已生成，请保存配置后更新订阅。", "Certificate generated. Save configuration, then update your subscription."));
      } catch (error) {
        $("#ca-generation-status").textContent = t(`生成失败：${error.message}，请重试。`, `Generation failed: ${error.message}. Please retry.`);
      } finally {
        modal.generatingCa = false;
        controls.forEach((control) => control.disabled = false);
      }
    }, t("生成证书", "Generate certificate"));
    return;
  }
  if (name === "import-ca") {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".p12,.pfx";
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
      state.config.clients.surge.mitm.caP12 = btoa(binary);
      changed();
      render();
    };
    input.click();
    return;
  }
  if (name === "export-ca") {
    const encoded = state.config.clients.surge.mitm.caP12;
    if (!encoded) throw Error(t("尚未配置 CA", "No CA configured"));
    download(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)), "SubPilot-MITM-CA.p12", "application/x-pkcs12");
    return;
  }
  if (name === "client") {
    state.client = button.dataset.client;
    if (!Object.hasOwn(CLIENT_SECTIONS[state.client], state.section)) state.section = "network";
    closeDiagnostics();
    render();
    $("#content").scrollTo(0, 0);
    return;
  }
  if (name === "section") {
    state.section = button.dataset.section;
    render();
    return;
  }
  if (name === "close-modal") {
    closeModal();
    return;
  }
  if (name === "modal-save") {
    await modal.save?.();
    return;
  }
  if (name === "diagnostics") {
    showDiagnostics();
    return;
  }

  if (name === "rules-structured") return;
  if (name === "migration") {
    await reviewMigration();
    return;
  }
  if (name === "add-entity" || name === "edit-entity") {
    editEntity(kind, index);
    return;
  }
  if (name === "delete-entity") {
    confirmDelete(t("删除后，引用该资源的配置可能阻止输出。", "Deleting this resource may block configurations that reference it."), () => collection(kind).splice(index, 1));
    return;
  }
  if (name === "add-group" || name === "edit-group") {
    editGroup(button.dataset.name);
    return;
  }
  if (name === "delete-group") {
    const group = button.dataset.name;
    confirmDelete(t(`删除 ${group}？引用它的规则不会被自动替换。`, `Delete ${group}? Referencing rules will not be rewritten.`), () => {
      delete currentClient().groups[group];
      currentClient().disabledGroups = currentClient().disabledGroups.filter((item) => item !== group);
    });
    return;
  }
  if (name === "edit-json") {
    editJson(path, button.dataset.lines === "true");
    return;
  }
  if (name === "add-rule" || name === "edit-rule" || name === "edit-rule-json") {
    editRule(path, index, name === "edit-rule-json");
    return;
  }
  if (name === "delete-rule") {
    getPath(state.config, path).splice(index, 1);
    changed();
    render();
    return;
  }
  if (name === "move-rule") {
    const rules = getPath(state.config, path), other = index + Number(button.dataset.direction);
    if (other >= 0 && other < rules.length) [rules[index], rules[other]] = [rules[other], rules[index]];
    changed();
    render();
    return;
  }
  if (name === "add-dns" || name === "edit-dns") {
    editDns(index);
    return;
  }
  if (name === "delete-dns") {
    state.config.clients.singbox.dns.servers.splice(index, 1);
    changed();
    render();
    return;
  }
  if (name === "add-output" || name === "edit-output") {
    editOutput(index);
    return;
  }
  if (name === "delete-output") {
    state.config.clients[state.client].ruleSets.outputs.splice(index, 1);
    changed();
    render();
    return;
  }
  if (name === "resolve-issue") {
    const issues = state.config.clients[state.client].migrationIssues;
    const item = issues[index];
    modal(t("确认已处理", "Confirm resolution"), `<p>${esc(item?.message)}</p><p>${t("确认已在当前配置中手动完成转换，或已明确决定不保留该行为。", "Confirm that you converted this behavior manually or deliberately chose to omit it.")}</p>`, () => {
      issues.splice(index, 1);
      closeModal();
      changed();
      showDiagnostics();
    });
    return;
  }
  if (name === "locate") {
    closeDiagnostics();
    if (path.startsWith("groups")) location.hash = "groups";
    else if (path.startsWith("proxyNodes")) location.hash = "nodes";
    else {
      state.section = path.includes(".dns") ? "dns" : path.includes(".route") || path.includes("ruleSets") ? "rules" : "advanced";
      location.hash = "clients";
      render();
    }
    return;
  }


  if (name === "copy-link") {
    await navigator.clipboard.writeText(button.dataset.url);
    toast(t("已复制链接", "Link copied"));
    return;
  }
  if (name === "rotate-token") {
    modal(t("轮换读取 token", "Rotate read token"), `<p>${t("旧订阅链接将失效，需要在客户端更新链接。", "Existing subscription links will stop working. Update your clients afterward.")}</p>`, async () => {
      await api("/api/read-token/rotate", { method: "POST" });
      closeModal();
      await loadLinks();
    }, t("轮换", "Rotate"));
    return;
  }
  if (name === "request-page") {
    const page = Number(button.dataset.page);
    if (!Number.isInteger(page)) return;
    const direction = page > state.requestPage ? 1 : -1;
    state.requestPage = page;
    render();
    const controls = [...document.querySelectorAll('[data-action="request-page"]')];
    const nextFocus = controls.find((item) => !item.disabled && item.dataset.page === String(page + direction)) || controls.find((item) => !item.disabled);
    nextFocus?.focus();
    return;
  }
  if (name === "refresh-sources") {
    if (state.refreshingSources) return;
    state.refreshingSources = true;
    updateSourceRefreshButtons();
    try {
      const result = await api("/api/cache/source/refresh", { method: "POST" });
      await refreshStatus();
      state.stats = { ...state.stats, sourceCache: result.sourceCache };
      if (state.page === "status") render();
      if (result.failed) modal(t("订阅刷新结果", "Subscription refresh results"), renderSourceRefreshResult(result), null);
      else toast(t(`已刷新 ${result.refreshed} 个订阅源。`, `${result.refreshed} subscription sources refreshed.`));
    } finally {
      state.refreshingSources = false;
      updateSourceRefreshButtons();
    }
    return;
  }
  if (name === "refresh-rules") {
    if (dirty()) {
      toast(t("请先保存配置再刷新缓存", "Save the configuration before refreshing caches"));
      return;
    }
    showMessage(t("规则刷新结果", "Rule refresh result"), await api(`/api/rule-sets/refresh?target=${target()}`, { method: "POST" }));
    return;
  }
  if (name === "telegram-bind") {
    if (dirty()) {
      toast(t("请先保存通知设置", "Save notification settings first"));
      return;
    }
    showMessage(t("Telegram 绑定码", "Telegram binding code"), await api("/api/telegram/bind-code", { method: "POST" }));
    return;
  }
  if (name === "telegram-unbind") {
    modal(t("解除绑定", "Unbind Telegram"), `<p>${t("确认解除当前 Telegram 绑定？", "Unbind the current Telegram chat?")}</p>`, async () => {
      await api("/api/telegram/unbind", { method: "POST" });
      closeModal();
      await load();
    });
    return;
  }
}
function showMessage(title, data) {
  modal(title, `<pre class="preview-code">${esc(JSON.stringify(data, null, 2))}</pre>`, null);
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (button && !button.disabled) {
    Promise.resolve(action(button)).catch((error) => toast(error.message));
  }
});
document.addEventListener("input", (event) => {
  const input = event.target;
  if (!input.dataset.field) return;
  const path = input.dataset.field;
  try {
    let value = input.type === "checkbox" ? input.checked : input.value;
    if (input.dataset.kind === "number") {
      value = Number(value);
      if (!Number.isFinite(value)) throw Error();
    } else if (input.dataset.kind === "lines") value = value.split("\n").map((line) => line.trim()).filter(Boolean);
    else if (input.dataset.kind === "json") value = JSON.parse(value);
    if (path.startsWith("clients.singbox")) validateNativeShape(value, path);
    setPath(state.config, path, value);
    state.invalid.delete(path);
    input.removeAttribute("aria-invalid");
    changed();
  } catch {
    state.invalid.set(path, input.value);
    input.setAttribute("aria-invalid", "true");
    updateStatus();
  }
});
document.addEventListener("change", (event) => {
  const inline = event.target;
  if (inline.dataset.local === "chainExit") {
    updateChainFilterVisibility();
    return;
  }
  if (inline.dataset.ruleField) {
    const { path, index, ruleField } = inline.dataset;
    if (ruleField === "type") { const selected = inline.value; render(); editRule(path, Number(index), false, selected); return; }
    const rules = getPath(state.config, path);
    const policy = inline.value;
    if (state.client === "singbox") {
      const next = { ...rules[index] };
      delete next.method;
      if (["hijack-dns", "sniff", "reject", "REJECT", "REJECT-DROP"].includes(policy)) {
        next.action = policy.startsWith("REJECT") ? "reject" : policy; delete next.outbound;
        if (policy === "REJECT-DROP") next.method = "drop";
      } else { next.action = "route"; next.outbound = policy; }
      rules[index] = next;
    } else {
      const parts = splitRule(rules[index]); parts[["FINAL", "MATCH"].includes(parts[0]) ? 1 : 2] = policy; rules[index] = parts.join(",");
    }
    changed(); render(); return;
  }
  if (event.target.dataset.field?.endsWith("ruleSets.mode")) render();
  if (event.target.id === "mmdb-upload") {
    if (mmdb.uploading) return;
    mmdb.file = event.target.files[0] || null;
    mmdb.outcome = "";
    mmdb.error = "";
    if (mmdb.file && (!/\.mmdb$/i.test(mmdb.file.name) || mmdb.file.size <= 0 || mmdb.file.size > 25 * 1024 * 1024)) {
      mmdb.file = null;
      mmdb.outcome = "invalid";
      event.target.value = "";
    }
    updateMmdbView();
  }
});
$("#save").addEventListener("click", () => save().catch((error) => toast(error.message)));

$("#close-diagnostics").addEventListener("click", closeDiagnostics);
$("#close-modal").addEventListener("click", closeModal);
$("#modal").addEventListener("cancel", (event) => { if (modal.generatingCa) event.preventDefault(); });
$("#menu").addEventListener("click", () => document.body.classList.toggle("menu-open"));
$("#language").addEventListener("click", () => {
  state.lang = state.lang === "zh" ? "en" : "zh";
  localStorage.setItem("subpilot-language", state.lang);
  render();
  if (state.page === "links") loadLinks().catch((error) => toast(error.message));
});
$("#logout").addEventListener("click", () => {
  const logout = async () => {
    await api("/api/logout", { method: "POST" });
    location.reload();
  };
  if (dirty()) modal(t("退出登录", "Sign out"), `<p>${t("未保存的更改将丢失。", "Unsaved changes will be lost.")}</p>`, logout, t("退出", "Sign out"));
  else logout().catch((error) => toast(error.message));
});
window.addEventListener("hashchange", () => {
  const page = location.hash.slice(1);
  state.page = NAV.some((item) => item[0] === page) ? page : "status";
  closeDiagnostics();
  document.body.classList.remove("menu-open");
  render();
  $("#content").scrollTo(0, 0);
  if (state.page === "links") loadLinks().catch((error) => toast(error.message));
  if (state.page === "system") loadMmdbStatus();
});
window.addEventListener("beforeunload", (event) => {
  if (dirty() || state.invalid.size || mmdb.uploading || modal.generatingCa) {
    event.preventDefault();
    event.returnValue = "";
  }
});
document.addEventListener("keydown", (event) => {
  if ($("#modal").open) return;
  if (event.key === "Escape") closeDiagnostics();
  if (event.key === "Tab" && !$("#diagnostics").hidden) {
    const controls = [...$("#diagnostics").querySelectorAll("button:not(:disabled), a[href], input, select, textarea")];
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
});
async function load() {
  let config = await api("/api/config");
  state.migration = Boolean(config.migrationRequired);
  delete config.migrationRequired;
  if (state.migration) {
    const migration = await api("/api/config/migration");
    state.migration = migration.required;
    state.migrationData = { fingerprint: migration.fingerprint };
    config = migration.config;
  }
  state.config = config;
  state.saved = JSON.stringify(config);
  state.page = NAV.some((item) => item[0] === location.hash.slice(1)) ? location.hash.slice(1) : "status";
  render();
  if (state.page === "links") await loadLinks();
  await Promise.all([refreshStatus(), state.page === "system" ? loadMmdbStatus() : Promise.resolve()]);
}
load().catch((error) => {
  $("#content").innerHTML = `<div class="notice warning">${esc(error.message)}</div>`;
});
