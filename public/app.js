import { splitPolicyGroupSpec, parseGroupOption, validatePolicyPriority } from "./app-policy-group-spec.js";
import { ADDRESS_TOKEN, DOMAIN_TOKEN } from "./config-address-syntax.js";
import "./vendor/codemirror/codemirror.js";
import { newTailscaleNode, tailscaleForm, updateTailscaleForm, readTailscaleForm } from "./tailscale-ui.js";
import { createSingboxForm, createSingboxGroupForm, singboxSections, singboxTitle } from "./singbox-ui.js";
import { createClashRoutingUi } from "./clash-routing-ui.js";
import { validateActionsCompilationSettings } from "./app-validation.js";
import { CLIENTS, NAV, LABELS, CLIENT_SECTIONS, RULE_FIELDS, LEGACY_RULE_FIELDS, getPath, setPath, splitRule } from "./app-model.js";
const $ = (selector, root = document) => root.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const state = { config: null, saved: "", page: "status", client: "surge", section: "network", lang: localStorage.getItem("subpilot-language") || "zh", invalid: /* @__PURE__ */ new Map(), busy: false, migration: false, migrationData: null, stats: null, requestPage: 0, refreshingSources: false, system: null };
const mmdb = { status: null, loading: false, statusError: false, file: null, uploading: false, progress: 0, outcome: "", error: "", request: 0 };
let subscriptionCheck = null;
let singboxSchema = null;
let sharedProxyNames = { signature: "", names: {} };

async function loadSharedProxyNames() {
  const signature = JSON.stringify(state.config);
  if (sharedProxyNames.signature === signature) return;
  const names = await api("/api/config/proxy-names", { method: "POST", body: signature });
  // Do not cache names for a draft that changed while the request was in flight.
  if (JSON.stringify(state.config) === signature) sharedProxyNames = { signature, names };
}

const t = (zh, en) => state.lang === "zh" ? zh : en;
const label = (key) => state.lang === "zh" ? LABELS[key] || key : key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
const paths = { grid: "M3 3h6v6H3zm12 0h6v6h-6zM3 15h6v6H3zm12 0h6v6h-6z", source: "M6 3h8l4 4v14H6zM14 3v5h4M9 12h6m-6 4h6", nodes: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M3 12h18M12 3c-5 5-5 13 0 18 5-5 5-13 0-18", settings: "m9 3-1 3-3 1v4l-2 1 2 2v4l3 1 1 2h6l1-2 3-1v-4l2-2-2-1V7l-3-1-1-3zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0", code: "m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18", link: "m10 14 4-4M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 10 5-5a4 4 0 0 0-6-6l-2 2", edit: "m4 15 11-11 5 5-11 11H4zM13 6l5 5", trash: "M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7", up: "m6 15 6-6 6 6", down: "m6 9 6 6 6-6", copy: "M8 8h13v13H8zM16 8V3H3v13h5", plus: "M12 4v16M4 12h16" };
const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.settings}"/></svg>`;
const btn = (text, action2, attrs = "", className = "") => `<button type="button" data-action="${action2}" class="${className}" ${attrs}>${text}</button>`;
const iconButton = (name, action, attrs = "", title = "") => btn(icon(name), action, `${attrs} aria-label="${esc(title || name)}" title="${esc(title || name)}"`, "icon-button");
const smallButton = (name, action2, attrs = "", title = "") => btn(icon(name) + (name === "edit" ? esc(title || t("编辑", "Edit")) : ""), action2, `${attrs} aria-label="${esc(title || name)}" title="${esc(title || name)}"`, name === "edit" ? "edit-button" : "icon-button");
const target = () => CLIENTS[state.client].target;
const basePath = () => `clients.${state.client}`;
const currentClient = () => state.config.clients[state.client];
const clashRouting = createClashRoutingUi({ state, t, esc, btn, iconButton, field, section, modal, closeModal, localField, readLocal, policyChoices, selectOptions, orderedPlan, isFinalRule, splitRule, appendPlanItem, changed, render, api });
const dirty = () => state.config && JSON.stringify(state.config) !== state.saved;
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
function validateNativeShape(value, path = "clients.singbox") {
  const objects = ["clients.singbox", "clients.singbox.dns", "clients.singbox.route", "clients.singbox.log", "clients.singbox.experimental"];
  const arrays = ["clients.singbox.inbounds", "clients.singbox.endpoints", "clients.singbox.dns.servers", "clients.singbox.dns.rules", "clients.singbox.route.rules", "clients.singbox.route.rule_set"];
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
  if (!response.headers.get("content-type")?.includes("application/json")) throw Error(t(`服务暂时无法完成请求（${response.status}），请稍后重试。`, `The service could not complete this request (${response.status}). Please retry.`));
  const data = await response.json();
  if (!response.ok) {
    const error = Error(data.error || `${response.status}`);
    error.issues = data.issues;
    throw error;
  }
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
  const plan = currentClient()?.ruleSets;
  if (plan?.mode === "compiled") orderedPlan(plan).forEach(({ item }, order) => { item.order = order; });
  updateStatus();
}
function isTextList(key, value) {
  return Array.isArray(value) && !["tailscaleNodes", "inbounds", "directRules", "servers", "rule_set", "outputs"].includes(key) && value.every((item) => typeof item === "string");
}
function displayTimeZoneOptions(current) {
  let zones = ["Asia/Shanghai", "Asia/Hong_Kong", "Asia/Taipei", "Asia/Singapore", "Asia/Tokyo", "Asia/Seoul", "Asia/Kolkata", "Asia/Dubai", "Europe/London", "Europe/Paris", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Australia/Sydney", "Pacific/Auckland"];
  try { if (typeof Intl.supportedValuesOf === "function") zones = Intl.supportedValuesOf("timeZone"); }
  catch { /* Older browsers retain the common time zone choices. */ }
  return [...new Set(["UTC", ...zones, ...(typeof current === "string" && current ? [current] : [])])].sort();
}
function field(path, value, options = {}) {
  const key = path.split(".").at(-1);
  const id = `field-${path.replaceAll(".", "-")}`;
  const title = options.label || label(key);
  if (path === "settings.displayTimeZone") options = { ...options, options: displayTimeZoneOptions(value) };
  if (path === "clients.surge.ipv6Vif") options = { ...options, options: ["off", "auto", "always"] };
  if (path === "clients.clash.mode") options = { ...options, options: ["rule", "global", "direct"] };
  if (path === "clients.clash.tun.stack") options = { ...options, options: ["system", "gvisor", "mixed", "mips"] };
  if (path === "clients.clash.dnsEnhancedMode") options = { ...options, options: ["fake-ip", "redir-host"] };
  const textList = isTextList(key, value);
  if (!options.local && path === "settings.excludeKeywords" && textList) {
    return `<div class="config-preview-field"><div class="section-heading"><span id="${id}-label">${esc(title)}</span>${iconButton("edit", "edit-json", `data-path="${esc(path)}" data-lines="true"`, t("编辑排除关键词", "Edit excluded keywords"))}</div>${value.length ? `<ul class="keyword-tags" aria-labelledby="${id}-label">${value.map((keyword) => `<li class="chip">${esc(keyword)}</li>`).join("")}</ul>` : `<p class="help">${t("未配置", "Not configured")}</p>`}</div>`;
  }
  if (!options.local && path === "settings.featureTagRules" && textList) {
    const rows = value.map((line) => {
      const separator = line.indexOf("=");
      const name = (separator < 0 ? line : line.slice(0, separator)).trim();
      const keywords = (separator < 0 ? line : line.slice(separator + 1)).split(",").map((item) => item.trim()).filter(Boolean);
      return `<div class="feature-tag-row"><dt>${esc(name || t("未命名", "Unnamed"))}</dt><dd>${keywords.length ? `<ul class="keyword-tags">${keywords.map((keyword) => `<li class="chip">${esc(keyword)}</li>`).join("")}</ul>` : `<span class="muted">${t("未配置", "Not configured")}</span>`}</dd></div>`;
    }).join("");
    return `<div class="config-preview-field"><div class="section-heading"><span id="${id}-label">${esc(title)}</span>${iconButton("edit", "edit-json", `data-path="${esc(path)}" data-lines="true"`, t("编辑节点特征标签", "Edit node feature tags"))}</div>${rows ? `<dl class="feature-tag-list" aria-labelledby="${id}-label">${rows}</dl>` : `<p class="help">${t("未配置", "Not configured")}</p>`}</div>`;
  }
  const structured = value && typeof value === "object";
  const multiline = options.multiline || typeof value === "string" && value.includes("\n");
  if (!options.local && !/token|secret|password|passphrase|authKey|caP12/i.test(key) && (textList || structured || multiline)) {
    const text = textList ? value.join("\n") : structured ? JSON.stringify(value, null, 2) : value;
    return `<div class="config-preview-field"><div class="section-heading"><span>${esc(title)}</span>${iconButton("edit", "edit-json", `data-path="${esc(path)}" data-lines="${textList}"`, t("编辑", "Edit"))}</div>${text ? renderConfigLines(text.split("\n")) : `<p class="help">${t("未配置", "Not configured")}</p>`}</div>`;
  }
  let control;
  const common = `id="${id}" data-field="${esc(path)}" ${state.invalid.has(path) ? 'aria-invalid="true"' : ""}`;
  if (typeof value === "boolean") control = `<input class="toggle" type="checkbox" ${common} ${value ? "checked" : ""} ${options.disabled ? "disabled" : ""}>`;
  else if (typeof value === "number") control = `<input type="number" ${common} data-kind="number" value="${esc(value)}">`;
  else if (options.options) control = `<select ${common}>${options.options.map((item) => `<option value="${esc(item)}" ${item === value ? "selected" : ""}>${esc(item)}</option>`).join("")}</select>`;
  else if (isTextList(key, value)) control = `<textarea ${common} data-kind="lines" rows="${Math.min(8, Math.max(3, value.length))}" spellcheck="false">${esc(value.join("\n"))}</textarea><div class="help">${esc(options.help || t("每行一项", "One item per line"))}</div>`;
  else if (value && typeof value === "object") control = `<textarea ${common} data-kind="json" class="code" rows="${Math.min(13, Math.max(4, JSON.stringify(value, null, 2).split("\n").length))}" spellcheck="false">${esc(JSON.stringify(value, null, 2))}</textarea><div class="help">JSON · ${t("保留完整原生字段", "Preserves native fields")}</div>`;
  else if (options.multiline || String(value).includes("\n")) control = `<textarea ${common} data-kind="text" class="code" rows="${options.rows || 7}" spellcheck="false">${esc(value)}</textarea>`;
  else control = `<input ${common} ${options.readonly ? "readonly" : ""} type="${/token|secret|password|passphrase|authKey/i.test(key) ? "password" : "text"}" value="${esc(value)}" autocomplete="off" spellcheck="false">`;
  if (state.invalid.has(path) && control.includes("<textarea")) control = control.replace(/(<textarea[^>]*>)[\s\S]*?(<\/textarea>)/, (_, open, close) => open + esc(state.invalid.get(path)) + close);
  if (options.local && !/token|secret|password|passphrase|authKey|caP12/i.test(key)) control = control.replace(/<textarea([^>]*?)class="code"/, '<textarea$1class="code code-editor"').replace(/<textarea(?![^>]*class=)/, '<textarea class="code-editor"');
  return `<div class="form-row"><label for="${id}">${esc(title)}</label><div class="field">${control}</div></div>`;
}
function section(title, content, extra = "") {
  const heading = title || extra ? `<div class="section-heading">${title ? `<h2>${esc(title)}</h2>` : ""}${extra}</div>` : "";
  return `<section class="section">${heading}${content}</section>`;
}
// Only explicitly marked explanatory content moves into tips; status and validation text stays visible.
function clearHeadingTip(heading) {
  if (heading.parentElement.classList.contains("help-title")) heading.parentElement.replaceWith(heading);
}
function mountHelpTips(root, fallbackHeading) {
  for (const note of root.querySelectorAll("[data-help]")) {
    if (!note.textContent.trim()) { note.remove(); continue; }
    const heading = note.closest("section")?.querySelector(".section-heading h2, .section-heading h3") || fallbackHeading;
    let title = heading.parentElement;
    if (!title.classList.contains("help-title")) {
      title = document.createElement("div");
      title.className = "help-title";
      heading.before(title);
      title.append(heading);
    }
    let tip = title.querySelector(":scope > .settings-help");
    if (!tip) {
      tip = document.createElement("details");
      tip.className = "settings-help";
      tip.innerHTML = `<summary><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.7-2.5 1.8-2.5 3.5M12 16v.1"/></svg></summary><div class="settings-help-content"></div>`;
      $("summary", tip).setAttribute("aria-label", t("查看说明：", "About: ") + heading.textContent);
      title.append(tip);
    }
    note.removeAttribute("data-help");
    $(".settings-help-content", tip).append(note);
  }
}
function positionHelpTip(help) {
  if (!help.open) return;
  const content = help.querySelector(":scope > .settings-help-content, :scope > .mmdb-path-help");
  if (!content) return;
  const anchor = $("summary", help).getBoundingClientRect();
  const gap = 12;
  const width = Math.min(content.classList.contains("mmdb-path-help") ? 620 : 460, window.innerWidth - gap * 2);
  const below = window.innerHeight - anchor.bottom - gap * 2;
  const above = anchor.top - gap * 2;
  const useAbove = below < 220 && above > below;
  content.style.position = "fixed";
  content.style.width = `${width}px`;
  content.style.maxHeight = `${Math.max(80, Math.min(window.innerHeight - gap * 2, useAbove ? above : below))}px`;
  content.style.left = `${Math.max(gap, Math.min(anchor.left, window.innerWidth - width - gap))}px`;
  content.style.right = "auto";
  content.style.top = `${useAbove ? Math.max(gap, anchor.top - content.getBoundingClientRect().height - gap) : anchor.bottom + gap}px`;
}
function clientTabs() {
  return `<div class="client-tabs">${Object.entries(CLIENTS).map(([id, client]) => btn(client.label, "client", `data-client="${id}"`, state.client === id ? "selected" : "")).join("")}</div>`;
}
function render() {
  if (!state.config) return;
  document.documentElement.lang = state.lang === "zh" ? "zh-CN" : "en";
  $("#navigation").innerHTML = NAV.map(([id, zh, en, img]) => `<a href="#${id}" class="${state.page === id ? "active" : ""}" ${state.page === id ? 'aria-current="page"' : ""}>${icon(img)}${state.lang === "zh" ? zh : en}</a>`).join("");
  const page = NAV.find((item) => item[0] === state.page) || NAV[0];
  clearHeadingTip($("#page-title"));
  $("#page-title").textContent = state.lang === "zh" ? page[1] : page[2];
  $("#header-actions").innerHTML = state.page === "clients" && state.client === "singbox" ? `<span class="muted small">sing-box 1.15.0-alpha.8</span>` : state.page === "clients" && state.client === "clash" ? `<span class="muted small">Mihomo v1.19.31</span>` : "";
  $("#language").textContent = state.lang === "zh" ? "中文 / EN" : "EN / 中文";
  $("#logout").textContent = t("退出登录", "Sign out");
  renderSidebarVersion();
  $("#migration-banner").hidden = !state.migration;
  $("#migration-banner").innerHTML = state.migration ? `<div class="notice warning"><h2>${t("配置升级待确认", "Configuration upgrade required")}</h2><p>${t("升级旧版配置格式，保留 Surge 与 Clash 各自的设置；sing-box 使用独立的原生默认配置。确认升级后移除 Stash 和 Shadowrocket。", "Upgrade the legacy configuration format while preserving the separate Surge and Clash settings. sing-box starts with independent native defaults. Confirm the upgrade to remove Stash and Shadowrocket.")}</p><div class="toolbar">${btn(t("查看并确认升级", "Review upgrade"), "migration")}</div></div>` : "";
  const views = { status: renderStatus, sources: () => renderEntities("sources"), nodes: () => renderEntities("nodes"), groups: renderGroups, clients: renderClient, links: renderLinks, system: renderSystem };
  $("#content").innerHTML = (views[state.page] || renderStatus)();
  mountHelpTips($("#content"), $("#page-title"));
  updateStatus();
  updateSourceRefreshButtons();
  updateMmdbView();
  if (state.page === "links") loadLinks().catch((error) => toast(error.message));
}
function renderSidebarVersion() {
  const element = $("#sidebar-version");
  const available = state.system?.update?.updateAvailable === true;
  element.textContent = available ? t("有更新", "Update available") : (state.system?.app?.version || "");
  element.classList.toggle("has-update", available);
}
function renderStatus() {
  return section(t("订阅缓存", "Subscription cache"), renderSourceCache(), btn(t("强制刷新", "Force refresh"), "refresh-sources")) + section(t("最近订阅请求", "Recent subscription requests"), renderRecentRequests());
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
  <p class="help" data-help>${t("强制刷新会重新拉取已保存并启用的订阅源；上游获取失败时保留可用的旧缓存。", "Force refresh fetches saved, enabled sources again. Available cached content is retained if an upstream fetch fails.")}</p>`;
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
  return kind === "nodes" ? "proxyNodes" : "sources";
}
function collection(kind) {
  return getPath(state.config, collectionPath(kind));
}
function renderEntities(kind) {
  const items = collection(kind);
  const isNode = kind === "nodes";
  return `<p class="muted" data-help>${t("订阅源和代理节点供三个客户端共用。", "Subscription sources and proxy nodes are shared by all three clients.")}</p><div class="toolbar">${btn(icon("plus") + t("添加", "Add"), "add-entity", `data-kind="${kind}"`, "primary")}${kind === "sources" ? btn(t("刷新订阅", "Refresh subscriptions"), "refresh-sources") : ""}</div><div class="table-wrap"><table class="editable-table"><thead><tr><th>${t("启用", "Enabled")}</th><th>${t("名称", "Name")}</th><th>${isNode ? t("节点配置", "Node configuration") : t("来源", "Source")}</th><th>${isNode ? t("链式出口", "Chain exit") : "User-Agent"}</th><th class="actions">${t("操作", "Actions")}</th></tr></thead><tbody>${items.map((item, index) => `<tr><td><input type="checkbox" class="toggle" aria-label="${t("启用", "Enable")} ${esc(item.name || item.id)}" data-field="${collectionPath(kind)}.${index}.enabled" ${item.enabled ? "checked" : ""}></td><td class="entity-name">${btn(esc(item.name || item.config?.split(/[=\n]/)[0] || item.id), "edit-entity", `data-kind="${kind}" data-index="${index}"`, "link entity-link")}</td><td class="truncate">${esc(isNode ? t("编辑查看完整配置", "Edit to view full configuration") : sourceHost(item.url))}</td><td class="truncate">${esc(isNode ? item.chainExit ? t("是", "Yes") : t("否", "No") : item.fetchUserAgent)}</td><td class="actions">${smallButton("edit", "edit-entity", `data-kind="${kind}" data-index="${index}"`, t("编辑", "Edit"))}${smallButton("trash", "delete-entity", `data-kind="${kind}" data-index="${index}"`, t("删除", "Delete"))}</td></tr>`).join("") || `<tr><td colspan="5" class="empty">${t("还没有添加资源", "No resources yet")}</td></tr>`}</tbody></table></div>`;
}
function sourceHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return "—";
  }
}
function groupSyntaxHelp() {
  const types = state.client === "surge"
    ? t("select 手动选择；smart 智能选择；url-test 输出时自动转为 smart；fallback 按顺序故障切换；load-balance 负载均衡；subnet 按网络选择。smart 只能包含代理节点，不能直接引用其他组或 DIRECT。", "select: manual selection; smart: adaptive selection; url-test is emitted as smart; fallback: priority failover; load-balance: load balancing; subnet: network-based selection. Smart accepts proxy nodes only, not nested groups or DIRECT.")
    : state.client === "clash"
      ? t("select 手动选择，可用 default-selected 指定默认成员；url-test 自动测速；fallback 按顺序故障切换；load-balance 负载均衡。", "select: manual selection, with default-selected for the default member; url-test: automatic latency testing; fallback: priority failover; load-balance: load balancing.")
      : t("select 手动选择，输出为 selector；url-test 自动测速，输出为 urltest。可用端点的 tag 可以作为显式成员引用。", "select: manual selection, emitted as selector; url-test: automatic latency testing, emitted as urltest. Available endpoint tags can be referenced as explicit members.");
  const options = state.client === "surge"
    ? t("hidden=true 隐藏组。Surge 不使用组级 url；测速 URL 在客户端配置中设置，smart 的 interval 不生效。subnet 使用 条件=策略，例如 subnet, SSID:Home=DIRECT, default=Proxy；default 必填，不能引用自身。", "hidden=true hides the group. Surge ignores group-level url; set the test URL in client settings. Smart ignores interval. subnet uses condition=policy, for example subnet, SSID:Home=DIRECT, default=Proxy; default is required and must not reference the group itself.")
    : state.client === "clash"
      ? t("url 设置测速地址，interval 设置测速间隔（秒）；hidden=true 隐藏组，但需要客户端或面板支持。", "url sets the test URL; interval sets the test interval in seconds. hidden=true hides the group when supported by the client or dashboard.")
      : t("url 设置测速地址，interval 设置测速间隔（秒），tolerance 设置延迟容差（毫秒）。sing-box 不支持 hidden，输出时会省略。", "url sets the test URL; interval sets the test interval in seconds; tolerance sets latency tolerance in milliseconds. sing-box omits unsupported hidden settings.");
  const example = state.client === "surge" ? "smart, {all filter=DMIT exclude=v4}, hidden=true" : "url-test, {all filter=DMIT exclude=v4}, url=https://www.gstatic.com/generate_204, interval=600";
  return `<div class="group-syntax" data-help><p>${t("组配置格式：", "Group definition: ")}<code>${t("类型, 成员或筛选器, 参数=值", "type, member or selector, option=value")}</code>${t("。只填一行，使用英文逗号分隔；名称单独填写，不要加“组名 =”。", ". Use one line and ASCII commas. Enter the name separately; omit the “group name =” prefix.")}</p><details><summary>${t("语法说明与示例", "Syntax guide and examples")}</summary><ul>
    <li><strong>${t("当前客户端类型：", "Types for this client: ")}</strong>${types}</li>
    <li><strong>${t("显式成员：", "Explicit members: ")}</strong>${t("填写已存在的节点名、策略组名或受支持的内置策略，例如 select, Auto, DIRECT（Auto 需已存在）。名称要完全一致；组不能引用自身，也不能形成 A → B → A 的循环。", "Use existing node or group names, or supported built-in policies, e.g. select, Auto, DIRECT (Auto must exist). Names must match exactly. Do not reference the group itself or create a cycle such as A → B → A.")}</li>
    <li><code>{all}</code> ${t("展开当前客户端可用且允许加入策略组的节点，不会选中策略组。fallback 和 subnet 不能使用此筛选器；fallback 请显式列出成员。", "expands nodes available to this client and allowed in groups; it does not select groups. fallback and subnet cannot use this selector; list fallback members explicitly.")}</li>
    <li><code>{all filter=香港,日本 exclude=via,DMIT}</code> ${t("保留命中“香港”或“日本”的节点，再排除命中“via”或“DMIT”的节点。关键字匹配节点名称和匹配标签，不区分大小写，按包含关系匹配，不是正则表达式。", "keeps nodes matching 香港 or 日本, then excludes nodes matching via or DMIT. Keywords match substrings in node names and matching labels, case-insensitively; they are not regular expressions.")}</li>
    <li>${t("filter 可省略，表示不限制包含条件；exclude 可省略，表示不额外排除。多个关键字用英文逗号分隔，filter 和 exclude 之间用空格，filter 写在前。", "Omit filter to allow all candidates; omit exclude to apply no extra exclusions. Separate keywords with ASCII commas. Put filter before exclude, separated by a space.")} <code>{all exclude=via,DMIT}</code> ${t("表示排除命中任意一个关键字的节点。", "excludes nodes matching either keyword.")}</li>
    <li><strong>${t("参数：", "Options: ")}</strong>${options}</li>
    <li><strong>${t("示例：", "Example: ")}</strong><code>${esc(example)}</code><br>${t("选择名称或标签包含 DMIT、且不包含 v4 的节点。被引用的组筛选后为空、成员缺失或循环引用会阻止订阅生成，可在“配置链接 → 订阅检查”查看具体原因。", "Selects nodes whose names or labels contain DMIT but not v4. Referenced groups with no matching nodes, missing members, or cycles block subscription generation; see Configuration links → Subscription check for details.")}</li>
  </ul></details></div>`;
}
function renderGroups() {
  const client = currentClient();
  return clientTabs() + groupSyntaxHelp() + `<p class="muted" data-help>${t("策略组仅用于当前客户端，同名组可在不同客户端分别配置。", "Policy groups belong to this client. Groups with the same name can have different settings in other clients.")}</p><div class="toolbar">${btn(icon("plus") + t("添加策略组", "Add group"), "add-group", "", "primary")}</div><div class="table-wrap"><table class="editable-table"><thead><tr><th>${t("名称", "Name")}</th><th>${t("组配置", "Group definition")}</th><th class="actions">${t("操作", "Actions")}</th></tr></thead><tbody>${Object.entries(client.groups).map(([name, spec]) => `<tr><td class="entity-name">${btn(esc(name), "edit-group", `data-name="${esc(name)}"`, "link entity-link")}${client.disabledGroups.includes(name) ? ` <span class="chip">${t("停用", "Disabled")}</span>` : ""}</td><td class="truncate">${esc(spec)}</td><td class="actions">${smallButton("edit", "edit-group", `data-name="${esc(name)}"`, t("编辑", "Edit"))}${name !== "Proxy" ? smallButton("trash", "delete-group", `data-name="${esc(name)}"`, t("删除", "Delete")) : ""}</td></tr>`).join("")}</tbody></table></div>`;
}
function highlightConfigLine(line) {
  if (/^\s*(?:#|;|\/\/)/.test(line)) return `<span class="config-token-comment">${esc(line)}</span>`;
  // Tokenize only for display. Escape every token before adding trusted markup.
  const tokens = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|https?:\/\/[^\s,]+|\^\S+|[\w-]+(?=\s*=)|\b(?:true|false|auto|reject(?:-\w+)?|DIRECT|REJECT|Proxy|http-request|http-response)\b|\b\d+(?:\.\d+)*(?:\/\d+)?\b/g;
  const combinedTokens = new RegExp(`${ADDRESS_TOKEN.source}|${DOMAIN_TOKEN.source}|${tokens.source}`, "gi");
  let html = "", offset = 0;
  for (const match of line.matchAll(combinedTokens)) {
    const token = match[0];
    html += esc(line.slice(offset, match.index));
    const kind = new RegExp(`^(?:${ADDRESS_TOKEN.source})$`, "i").test(token) ? "number" : new RegExp(`^(?:${DOMAIN_TOKEN.source})$`, "i").test(token) ? "pattern" : /^['"]/.test(token) ? "string" : /^(?:https?:|\^)/.test(token) ? "pattern" : /^\d/.test(token) ? "number" : /^\s*=/.test(line.slice(match.index + token.length)) ? "key" : "keyword";
    html += `<span class="config-token-${kind}">${esc(token)}</span>`;
    offset = match.index + token.length;
  }
  return html + esc(line.slice(offset));
}
function renderConfigLines(lines) {
  return `<div class="client-config-values" role="region" aria-label="${t("配置内容（含行号）", "Configuration with line numbers")}" tabindex="0">${lines.flatMap((line) => line.split("\n")).map((line, index) => `<div class="client-config-line"><span class="config-line-number" aria-hidden="true">${index + 1}</span><code class="client-config-value">${highlightConfigLine(line)}</code></div>`).join("")}</div>`;
}
function renderClient() {
  if (state.client === "singbox" && ["services", "outbounds", "endpoints"].includes(state.section)) state.section = "network";
  if (state.client === "clash" && state.section === "advanced") state.section = "network";
  const client = state.config.clients[state.client];
  const fields = CLIENT_SECTIONS[state.client][state.section] || [];
  const tabs = [["network", "网络与 TUN", "Network & TUN"], ["dns", "DNS", "DNS"], ["rules", "分流规则", "Routing rules"], ...state.client !== "clash" ? [["tailscale", "Tailscale", "Tailscale"]] : [], ...state.client === "singbox" ? [["wireguard", "WireGuard", "WireGuard"], ["openconnect", "OpenConnect", "OpenConnect"], ["openvpn-client", "OpenVPN", "OpenVPN"], ["masque-client", "MASQUE 客户端", "MASQUE Client"], ["masque-server", "MASQUE 服务端", "MASQUE Server"]] : [], ...state.client !== "clash" ? [["advanced", "高级设置", "Advanced"]] : [], ...state.client === "surge" ? [["mitm", "MITM 证书", "MITM certificates"]] : []];
  let content = "";
  if (state.client === "surge" && state.section === "mitm") content = renderMitm();
  else if (state.section === "tailscale") content = renderTailscale();
  else if (state.section === "rules") content = renderRules();
  else if (state.client === "singbox" && state.section === "dns") content = renderSingboxDns() + renderSingboxConnectionSettings("dns");
  else if (state.client === "singbox" && ["wireguard", "openconnect", "openvpn-client", "masque-client", "masque-server"].includes(state.section)) content = renderSingboxVpn(state.section);
  else if (state.client === "singbox" && state.section === "network") content = renderSingboxNetwork() + renderSingboxConnectionSettings("network");
  else if (state.client === "singbox") content = renderSingboxSections(singboxSections[state.section] || []);
  else {
    const simple = fields.filter((key) => !isObject(client[key]) && !Array.isArray(client[key]));
    const complex = fields.filter((key) => !simple.includes(key));
    const basics = simple.length ? `<div class="client-settings-basics">${simple.map((key) => field(`${basePath()}.${key}`, client[key])).join("")}</div>` : "";
    const details = complex.map((key) => {
      const value = client[key], path = `${basePath()}.${key}`, lines = isTextList(key, value);
      const body = lines
        ? (value.length ? renderConfigLines(value) : `<p class="help">${t("未配置", "Not configured")}</p>`)
        : isObject(value) ? `<div class="client-settings-nested">${Object.entries(value).map(([sub, item]) => field(`${path}.${sub}`, item)).join("")}</div>` : field(path, value);
      const editor = iconButton("edit", "edit-json", `data-path="${path}" data-lines="${lines}"`, t("编辑", "Edit"));
      return `<div class="client-settings-block ${isObject(value) ? "client-settings-object" : "client-settings-list"}">${section(label(key), body, editor)}</div>`;
    }).join("");
    content = `<div class="client-settings ${state.section === "advanced" ? "client-settings-advanced" : ""}">${basics}<div class="client-settings-details">${details}</div></div>`;
  }
  if (!content) content = `<p class="empty">${t("此客户端的设置均在其他分栏中提供。", "All settings for this client are available in the other tabs.")}</p>`;
  return `<div class="client-config-page">` + clientTabs() + `<div class="section-tabs">${tabs.map(([id, zh, en]) => btn(t(zh, en), "section", `data-section="${id}"`, state.section === id ? "selected" : "")).join("")}</div>` + content + `</div>`;
}
function renderSingboxDns() {
  const dns = currentClient().dns;
  const servers = dns.servers || [], rules = dns.rules || [];
  const actions = (kind, index) => iconButton("edit", "edit-sb-dns", `data-kind="${kind}" data-index="${index}"`, t("编辑", "Edit")) + iconButton("trash", "delete-sb-dns", `data-kind="${kind}" data-index="${index}"`, t("删除", "Delete"));
  const serverRows = servers.map((server, index) => {
    const address = server.server || server.endpoint || (server.type === "local" ? t("系统 DNS", "System DNS") : "—");
    return `<tr><td><strong>${esc(server.tag || "—")}</strong></td><td>${esc(server.type || "—")}</td><td><code>${esc(address)}${server.server_port ? ` : ${esc(server.server_port)}` : ""}${server.path ? esc(server.path) : ""}</code></td><td>${esc(server.detour || t("默认连接", "Default connection"))}</td><td class="actions">${actions("servers", index)}</td></tr>`;
  }).join("");
  const ruleRows = rules.map((rule, index) => {
    const match = Object.fromEntries(Object.entries(rule).filter(([key]) => !["server", "action", "disable_cache", "rewrite_ttl", "client_subnet"].includes(key)));
    return `<tr><td>${index + 1}</td><td>${Object.keys(match).length ? renderConfigLines(JSON.stringify(match, null, 2).split("\n")) : t("所有请求", "All requests")}</td><td>${esc(rule.server || rule.action || "route")}</td><td class="actions">${iconButton("up", "move-sb-dns", `data-index="${index}" data-direction="-1" ${index === 0 ? "disabled" : ""}`, t("上移", "Move up"))}${iconButton("down", "move-sb-dns", `data-index="${index}" data-direction="1" ${index === rules.length - 1 ? "disabled" : ""}`, t("下移", "Move down"))}${actions("rules", index)}</td></tr>`;
  }).join("");
  const table = (headers, rows) => `<div class="table-wrap"><table><thead><tr>${headers.map((heading) => `<th>${heading}</th>`).join("")}</tr></thead><tbody>${rows || `<tr><td colspan="${headers.length}" class="empty">${t("尚未配置", "Not configured")}</td></tr>`}</tbody></table></div>`;
  return `<div class="sb-dns-page">${section(t("DNS 服务器列表", "DNS server list"), table([t("名称", "Name"), t("协议", "Protocol"), t("服务器地址", "Server address"), t("连接出口", "Connection outbound"), t("操作", "Actions")], serverRows), btn(t("添加服务器", "Add server"), "edit-sb-dns", 'data-kind="servers"', "primary"))}${section(t("DNS 查询兜底服务器", "Fallback DNS server for queries"), field("clients.singbox.dns.final", dns.final || "", { label: t("兜底 DNS 服务器", "Fallback DNS server"), options: [...servers.map((server) => server.tag).filter(Boolean), ""] }) + `<p class="help">${t("收到的 DNS 查询未命中规则集 DNS 或高级 DNS 规则时使用。留空使用 DNS 服务器列表中的第一个服务器。", "Used when an incoming DNS query matches neither rule-set DNS nor advanced DNS rules. Leave empty to use the first server in the DNS server list.")}</p>`)}${section("", `<details><summary>${t("高级 DNS 规则", "Advanced DNS rules")} · ${rules.length}</summary><p class="help">${t("规则集 DNS 请在“分流规则”Tab 配置。此处用于查询类型匹配、拒绝查询等高级设置，在规则集 DNS 规则之后匹配。折叠不影响已配置规则生效。", "Configure rule-set DNS on the Routing rules tab. Use this section for advanced settings such as query-type matching and query rejection. These rules match after rule-set DNS rules; collapsing this section does not disable them.")}</p>${table([t("顺序", "Order"), t("匹配条件", "Match conditions"), t("解析目标 / 动作", "DNS target / action"), t("操作", "Actions")], ruleRows)}<div class="toolbar">${btn(t("添加规则", "Add rule"), "edit-sb-dns", 'data-kind="rules"')}</div></details>`)}<div class="toolbar">${btn(t("缓存与其他设置", "Cache and other settings"), "edit-sb-dns", 'data-kind="options"')}</div></div>`;
}
async function editSingboxDns(kind, index) {
  singboxSchema ||= await api("/api/singbox/schema");
  const raw = singboxSchema.properties.dns;
  const dnsSchema = raw.$ref ? singboxSchema.$defs[raw.$ref.split("/").at(-1)] : raw;
  const dns = currentClient().dns;
  const options = kind === "options";
  const original = options ? Object.fromEntries(Object.entries(dns).filter(([key]) => !["servers", "rules", "final"].includes(key))) : index === null ? (kind === "servers" ? { type: "udp", tag: "", server: "" } : { domain_suffix: [""], action: "route", server: dns.final || dns.servers?.[0]?.tag || "" }) : dns[kind][index];
  const property = options ? { ...dnsSchema, properties: Object.fromEntries(Object.entries(dnsSchema.properties).filter(([key]) => !["servers", "rules", "final"].includes(key))), required: (dnsSchema.required || []).filter((key) => !["servers", "rules", "final"].includes(key)) } : dnsSchema.properties[kind].items;
  let form;
  modal(options ? t("DNS 缓存与其他设置", "DNS cache and other settings") : kind === "servers" ? t("DNS 服务器", "DNS server") : t("DNS 分流规则", "DNS routing rule"), '<div id="singbox-form"></div>', async () => {
    const value = form.read(), next = structuredClone(dns);
    if (options) { for (const key of Object.keys(next)) if (!["servers", "rules", "final"].includes(key)) delete next[key]; Object.assign(next, value); }
    else { next[kind] ||= []; if (index === null) next[kind].push(value); else next[kind][index] = value; }
    const result = await api("/api/singbox/validate", { method: "POST", body: JSON.stringify({ section: "dns", value: next }) });
    if (!result.valid) { form.error(result.errors.join("; ")); return; }
    currentClient().dns = next; closeModal(); changed(); render();
  });
  form = createSingboxForm($("#singbox-form"), { ...singboxSchema, properties: { ...singboxSchema.properties, dns: property } }, "dns", original, { t, esc, references: { dns_server: (dns.servers || []).map((server) => server.tag), outbound: policyChoices(), endpoint: (currentClient().endpoints || []).map((endpoint) => endpoint.tag) }, referenceTypes: { dns_server: Object.fromEntries((dns.servers || []).map((server) => [server.tag, server.type])) } });
}
function renderSingboxNetwork() {
  const inbounds = currentClient().inbounds || [];
  const rows = inbounds.map((item, index) => {
    const tun = item.type === "tun";
    const address = tun ? (Array.isArray(item.address) ? item.address : []) : [item.listen && `${item.listen}${item.listen_port !== undefined ? ` : ${item.listen_port}` : ""}`].filter(Boolean);
    const route = item.auto_route === undefined ? t("未指定", "Not specified") : item.auto_route ? t("开启", "On") : t("关闭", "Off");
    return `<tr><td><strong>${esc(item.tag || t("未命名入站", "Unnamed inbound"))}</strong><div class="help">${esc(item.type || "—")}</div></td><td>${tun ? t("接管设备流量", "Capture device traffic") : ["mixed", "http", "socks"].includes(item.type) ? t("本地代理端口", "Local proxy port") : t("接收入站连接", "Accept inbound connections")}</td><td><div class="help">${tun ? t("虚拟网卡地址", "Virtual interface addresses") : t("监听地址 / 端口", "Listen address / port")}</div>${address.length ? address.map((value) => `<code class="sb-network-address">${esc(value)}</code>`).join("") : "—"}</td><td>${tun ? `<dl><dt>${t("自动路由", "Automatic routing")}</dt><dd>${route}</dd>${item.interface_name ? `<dt>${t("接口", "Interface")}</dt><dd>${esc(item.interface_name)}</dd>` : ""}</dl>` : "—"}</td><td class="actions">${iconButton("edit", "edit-singbox-inbound", `data-index="${index}"`, t("编辑入站", "Edit inbound"))}${iconButton("trash", "delete-singbox-inbound", `data-index="${index}"`, t("删除入站", "Delete inbound"))}</td></tr>`;
  }).join("");
  return `<section class="sb-network"><div class="section-heading"><div><h2>${t("入站管理", "Inbound connections")}</h2><p class="help" data-help>${t("TUN 接管设备流量；HTTP / SOCKS 端口供应用连接代理；Tailcat 通过 DERP 建立点对点隧道。", "TUN captures device traffic; HTTP / SOCKS ports accept proxy connections from apps; Tailcat establishes peer-to-peer tunnels through DERP.")}</p></div>${btn(t("添加入站", "Add inbound"), "edit-singbox-inbound", "", "primary")}</div><div class="table-wrap"><table><thead><tr><th>${t("入站", "Inbound")}</th><th>${t("用途", "Purpose")}</th><th>${t("地址", "Address")}</th><th>${t("网络设置", "Network settings")}</th><th>${t("操作", "Actions")}</th></tr></thead><tbody>${rows || `<tr><td colspan="5" class="empty">${t("尚未配置入站，点击「添加入站」设置流量入口。", "No inbounds configured. Add an inbound to receive traffic.")}</td></tr>`}</tbody></table></div></section>`;
}
function singboxConnectionDnsHelp() {
  return t("用于解析代理节点地址，以及直连时尚未解析的目标域名。连接单独指定 DNS 时优先使用其设置；此处指定的服务器可能绕过 DNS 查询分流规则。", "Resolves proxy server addresses and target domains still unresolved when connecting directly. A connection-specific DNS resolver takes priority; a server selected here may bypass DNS query routing rules.");
}
function renderSingboxConnectionSettings(group) {
  const title = group === "dns" ? t("建立连接时的默认 DNS", "Default DNS for establishing connections") : t("出口连接设置", "Outbound connection settings");
  const route = currentClient().route;
  const keys = group === "dns" ? ["default_domain_resolver"] : ["auto_detect_interface", "default_interface", "default_network_strategy"];
  const names = { default_domain_resolver: t("连接解析服务器", "Connection resolver"), auto_detect_interface: t("自动检测出口网卡", "Detect outbound interface"), default_interface: t("指定出口网卡", "Outbound interface"), default_network_strategy: t("网络选择策略", "Network strategy") };
  const summary = keys.filter((key) => route[key] !== undefined).map((key) => `<div><span class="muted">${names[key]}：</span>${esc(typeof route[key] === "boolean" ? route[key] ? t("开启", "On") : t("关闭", "Off") : typeof route[key] === "object" ? JSON.stringify(route[key]) : route[key])}</div>`).join("");
  return section(title, (summary || `<p class="help">${t("使用默认设置", "Using defaults")}</p>`) + (group === "dns" ? `<p class="help" data-help>${singboxConnectionDnsHelp()}</p>` : ""), btn(t("配置", "Configure"), "edit-singbox-section", `data-key="route" data-route-group="${group}"`));
}
function renderSingboxVpn(type) {
  const title = { wireguard: "WireGuard", openconnect: "OpenConnect", "openvpn-client": "OpenVPN", "masque-client": "MASQUE 客户端", "masque-server": "MASQUE 服务端" }[type];
  const items = (currentClient().endpoints || []).filter((item) => item.type === type);
  const locationLabel = type === "masque-server" ? t("监听地址", "Listen address") : t("服务器 / 地址", "Server / Address");
  const help = type === "masque-client" ? t("通过 MASQUE 连接远端代理，可在策略组和分流规则中选择。", "Connect to a remote proxy with MASQUE and use it in policy groups and routing rules.")
    : type === "masque-server" ? t("配置 MASQUE 服务端 endpoint；监听与证书选项由客户端内核管理。", "Configure a MASQUE server endpoint; the client core manages its listen and certificate options.")
      : t("连接 VPN 服务器，可在策略组和分流规则中选择此连接。", "Connect to a VPN server and use the connection in policy groups and routing rules.");
  return section(title, `<p class="help" data-help>${help}</p><div class="table-wrap"><table><thead><tr><th>${t("名称", "Name")}</th><th>${locationLabel}</th></tr></thead><tbody>${items.map((item) => `<tr><td>${esc(item.tag || "—")}</td><td>${esc(item.server || item.listen || (item.address || []).join(", ") || "—")}</td></tr>`).join("") || `<tr><td colspan="2" class="empty">${t("尚未配置连接", "No connections configured")}</td></tr>`}</tbody></table></div>`, btn(t("配置连接", "Configure connections"), "edit-singbox-section", `data-key="endpoints" data-endpoint-type="${type}"`));
}
function renderSingboxSections(keys) {
  const client = currentClient();
  const notes = {
    inbounds: t("Android / Apple 的 TUN 由系统 VPN 接口管理；接口名、进程匹配等能力受平台权限限制。应用选择、Always On 等客户端自身设置需在客户端中操作。", "Android / Apple TUN uses the system VPN interface. Interface names and process matching depend on platform permissions. App selection overrides and Always On are configured in the client itself."),
    endpoints: t("配置 WireGuard、Tailscale、OpenConnect、OpenVPN 和 MASQUE 端点。", "Configure WireGuard, Tailscale, OpenConnect, OpenVPN and MASQUE endpoints."),
    route: client.ruleSets.mode === "compiled" ? t("来源编排模式下，原生规则先匹配，再匹配编排规则；原生规则集与生成规则集合并，标签不可重复。", "In compiled mode, native rules match before compiled rules. Native and generated rule sets are merged; tags must be unique.") : "",
    outbounds: t("可添加 Tailcat 等本端原生出站，再在策略组和规则中引用。Tailcat 使用公钥和 DERP，不填写服务器地址与端口。", "Add client-native outbounds such as Tailcat, then reference them in groups and rules. Tailcat uses keys and DERP rather than a server address and port."),
    experimental: t("cache_file 中可设置写缓冲大小和定时刷新间隔，留空使用客户端默认值。", "Configure write buffering and periodic flushing under cache_file, or omit them to use client defaults."),
    services: t("DERP 客户端验证可引用 Tailcat 入站或允许的公钥。", "DERP client verification can reference Tailcat inbounds or allowed public keys."),
    http_clients: t("Apple HTTP 引擎仅 Apple 平台可用，支持字段与 Go 引擎不同。", "The Apple HTTP engine is available only on Apple platforms and supports a different set of options from Go.")
  };
  return `<div class="client-settings singbox-settings"><div class="client-settings-details">` + keys.map((key) => {
    const value = client[key];
    const summary = value === undefined ? t("使用默认值", "Using defaults") : Array.isArray(value) ? t(`已配置 ${value.length} 项`, `${value.length} items configured`) : isObject(value) ? Object.keys(value).join(" · ") || t("使用默认值", "Using defaults") : t("已配置", "Configured");
    const purpose = {
      inbounds: t("接管设备流量或开放本地代理端口", "Capture device traffic or expose a local proxy port"),
      dns: t("配置域名解析服务器和解析规则", "Configure DNS servers and resolution rules"),
      route: t("设置流量匹配条件和默认出口", "Configure traffic matching and the default outbound"),
      endpoints: t("配置 VPN 隧道连接", "Configure VPN tunnel connections"),
      log: t("设置日志级别和输出位置", "Set log verbosity and destination")
    };
    const items = Array.isArray(value) ? value : null;
    const overview = items ? (items.length ? `<div class="sb-overview-list">${items.map((item, index) => {
      const type = item.type || "—";
      const role = type === "tun" ? t("设备流量接管", "Device traffic capture") : ["mixed", "http", "socks"].includes(type) ? t("本地代理入口", "Local proxy listener") : type;
      const details = [[t("虚拟网卡地址", "Virtual interface addresses"), (Array.isArray(item.address) ? item.address : []).join(" · ")], [t("接口名称", "Interface name"), item.interface_name], [t("监听地址", "Listen address"), item.listen], [t("监听端口", "Listen port"), item.listen_port]].filter(([, value]) => value !== undefined && value !== "");
      return `<div class="sb-overview-item"><div class="section-heading"><strong>${esc(item.tag || role)}</strong>${key === "inbounds" ? `<div class="toolbar">${iconButton("edit", "edit-singbox-inbound", `data-index="${index}"`, t("编辑入站", "Edit inbound"))}${iconButton("trash", "delete-singbox-inbound", `data-index="${index}"`, t("删除入站", "Delete inbound"))}</div>` : ""}</div><span>${esc(role)} · ${esc(type)}</span><dl class="sb-overview-details">${details.map(([label, value]) => `<dt>${esc(label)}</dt><dd><code>${esc(value)}</code></dd>`).join("")}</dl></div>`;
    }).join("")}</div>` : `<p class="help">${t("尚未配置", "Not configured")}</p>`) : `<p class="sb-summary">${esc(summary)}</p>`;
    const removable = value !== undefined && !["inbounds", "dns", "route", "log", "experimental"].includes(key);
    return section(singboxTitle(key, t), `<p class="help" data-help>${purpose[key] || ""}</p>${overview}${notes[key] ? `<p class="help" data-help>${notes[key]}</p>` : ""}`, `<div class="toolbar">${key === "inbounds" ? btn(t("添加入站", "Add inbound"), "edit-singbox-inbound") : btn(t("配置", "Configure"), "edit-singbox-section", `data-key="${key}"`)}${removable ? btn(t("恢复默认", "Use defaults"), "remove-singbox-section", `data-key="${key}"`) : ""}</div>`);
  }).join("") + `</div></div>`;
}
async function editSingboxSection(key, inboundIndex, endpointType, routeGroup) {
  singboxSchema ||= await api("/api/singbox/schema");
  if (!Object.hasOwn(singboxSchema.properties, key)) throw Error(t("未知配置分类", "Unknown configuration section"));
  const client = state.config.clients.singbox;
  const tags = (items) => (items || []).flatMap((item) => item.tag || []);
  const references = {
    outbound: [...new Set(["DIRECT", ...Object.keys(client.groups).filter((name) => !client.disabledGroups.includes(name)), ...(sharedProxyNames.names.singbox || []), ...tags(client.outbounds), ...tags(client.endpoints)])],
    inbound: tags(client.inbounds), dns_server: tags(client.dns.servers), rule_set: tags(client.route.rule_set),
    http_client: tags(client.http_clients), certificate_provider: tags(client.certificate_providers), network_namespace: tags(client.network_namespaces), endpoint: tags(client.endpoints)
  };
  let viewSchema = singboxSchema;
  let routeKeys;
  if (routeGroup) {
    const node = singboxSchema.$defs.RouteOptions;
    routeKeys = Object.keys(node.properties).filter((name) => routeGroup === "dns" ? name === "default_domain_resolver" : !["rules", "rule_set", "final", "default_domain_resolver"].includes(name));
    viewSchema = { ...singboxSchema, properties: { ...singboxSchema.properties, route: { ...node, properties: Object.fromEntries(routeKeys.map((name) => [name, node.properties[name]])), required: (node.required || []).filter((name) => routeKeys.includes(name)) } } };
  }
  let form;
  modal(endpointType ? { wireguard: "WireGuard", openconnect: "OpenConnect", "openvpn-client": "OpenVPN" }[endpointType] : routeGroup ? (routeGroup === "dns" ? t("建立连接时的默认 DNS", "Default DNS for establishing connections") : t("出口连接设置", "Outbound connection settings")) : singboxTitle(key, t), `<p class="help">${routeGroup === "dns" ? singboxConnectionDnsHelp() : t("先选择类型，再填写常用设置。更多参数在「高级设置」和「添加可选设置」中；应用后请保存配置。", "Choose a type and edit its common settings. Additional parameters are under Advanced settings and Add optional settings. Save configuration after applying.")}</p><div id="singbox-form"></div>`, async () => {
    const edited = form.read();
    let value = inboundIndex === undefined ? edited : [...client.inbounds];
    if (routeKeys) {
      value = { ...client.route };
      for (const name of routeKeys) delete value[name];
      Object.assign(value, edited);
    }
    if (endpointType) {
      if (edited.some((item) => item.type !== endpointType)) throw Error(t("连接类型不匹配", "Connection type mismatch"));
      const remaining = [...edited];
      value = (client.endpoints || []).flatMap((item) => item.type === endpointType ? (remaining.length ? [remaining.shift()] : []) : [item]);
      value.push(...remaining);
    }
    if (inboundIndex !== undefined) {
      if (inboundIndex === null) value.push(edited[0]);
      else value[inboundIndex] = edited[0];
    }
    const root = $("#singbox-form"), saveButton = $('#modal-actions [data-action="modal-save"]');
    root.inert = true; saveButton.disabled = true;
    try {
      const result = await api("/api/singbox/validate", { method: "POST", body: JSON.stringify({ section: key, value }) });
      if (!root.isConnected || !$("#modal").open) return;
      if (!result.valid) { form.error(t("请检查以下字段：", "Check these fields: ") + result.errors.join("; ")); return; }
      client[key] = value;
      for (const path of state.invalid.keys()) if (path === `clients.singbox.${key}` || path.startsWith(`clients.singbox.${key}.`)) state.invalid.delete(path);
      closeModal(); changed(); render();
    } finally { root.inert = false; saveButton.disabled = false; }
  });
  const original = routeKeys ? Object.fromEntries(routeKeys.filter((name) => client.route[name] !== undefined).map((name) => [name, client.route[name]])) : endpointType ? (client.endpoints || []).filter((item) => item.type === endpointType) : inboundIndex === undefined ? client[key] : [inboundIndex === null ? { type: "mixed", tag: "mixed-in", listen: "127.0.0.1", listen_port: 7890 } : client.inbounds[inboundIndex]];
  form = createSingboxForm($("#singbox-form"), viewSchema, key, original, { t, esc, references, referenceTypes: { dns_server: Object.fromEntries((client.dns.servers || []).map((server) => [server.tag, server.type])) }, endpointType, singleItem: inboundIndex !== undefined });
}
function tailscaleCollection() {
  return state.client === "surge" ? currentClient().tailscaleNodes : currentClient().endpoints || [];
}
function renderTailscale() {
  const surge = state.client === "surge";
  const rows = tailscaleCollection().flatMap((node, index) => {
    if (!surge && node.type !== "tailscale") return [];
    const name = surge ? node.name : node.tag;
    const exit = surge ? node.exitNode : node.exit_node;
    return [`<tr><td>${btn(esc(name || t("未命名", "Unnamed")), "edit-tailscale", `data-index="${index}"`, "link")}</td><td>${esc(node.hostname || "—")}</td><td>${esc(exit && exit !== "none" ? exit : t("未指定", "Not selected"))}</td><td>${surge ? node.enabled ? t("启用", "Enabled") : t("停用", "Disabled") : t("已配置", "Configured")}</td><td class="actions">${smallButton("edit", "edit-tailscale", `data-index="${index}"`, t("编辑", "Edit"))}${smallButton("trash", "delete-tailscale", `data-index="${index}"`, t("删除", "Delete"))}</td></tr>`];
  }).join("");
  return section(t("Tailscale 节点", "Tailscale nodes"), `<p class="help" data-help>${surge ? t("节点可在当前端的策略组和分流规则中使用。认证密钥仅在编辑时以密码框显示。", "Use nodes in this client's policy groups and routing rules. Auth keys are masked in the editor.") : t("使用 sing-box 1.15 原生 Tailscale endpoint。认证密钥可留空，通过客户端日志中的登录地址授权；每个实例应使用独立的状态目录。", "Uses native sing-box 1.15 Tailscale endpoints. Leave the auth key empty to sign in through the URL in client logs; use a separate state directory for each instance.")}</p><div class="table-wrap"><table class="editable-table tailscale-table"><thead><tr><th>${t("名称", "Name")}</th><th>${t("设备主机名", "Hostname")}</th><th>${t("出口节点", "Exit node")}</th><th>${t("状态", "Status")}</th><th class="actions">${t("操作", "Actions")}</th></tr></thead><tbody>${rows || `<tr><td colspan="5" class="empty">${t("尚未添加 Tailscale 节点", "No Tailscale nodes yet")}</td></tr>`}</tbody></table></div>`, btn(t("添加节点", "Add node"), "add-tailscale", "", "primary"));
}
function editTailscale(index) {
  const client = state.client, surge = client === "surge";
  const nodes = tailscaleCollection();
  const original = index === null ? newTailscaleNode(client) : nodes[index];
  const name = surge ? original.name : original.tag;
  const candidates = policyChoices().filter((policy) => policy !== name);
  modal(t("编辑 Tailscale 节点", "Edit Tailscale node"), tailscaleForm(client, original, candidates, t, esc) + `<p class="help">${t("改名或删除不会自动重写已有规则引用。应用更改后保存配置。", "Renaming or deleting does not rewrite existing rule references. Apply changes, then save the configuration.")}</p>`, () => {
    const next = readTailscaleForm(client, original, $("#modal-body"), t);
    const name = surge ? next.name : next.tag;
    if (nodes.some((node, i) => i !== index && (surge ? node.name : node.tag) === name) || Object.hasOwn(currentClient().groups, name) || ["DIRECT", "REJECT", "REJECT-DROP"].includes(name.toUpperCase())) throw Error(t("节点名称与已有端点或策略冲突", "Node name conflicts with an endpoint or policy"));
    if (surge && nodes.some((node, i) => i !== index && node.sectionName === next.sectionName)) throw Error(t("配置段名称不能重复", "Section names must be unique"));
    if ((surge ? next.underlyingProxy : next.detour) === name) throw Error(t("前置代理不能引用当前节点自身", "An upstream proxy cannot reference itself"));
    if (index === null) {
      if (surge) currentClient().tailscaleNodes.push(next);
      else (currentClient().endpoints ??= []).push(next);
    } else nodes[index] = next;
    closeModal(); changed(); render();
  });
  updateTailscaleForm($("#modal-body"));
}
function renderMitm() {
  const mitm = state.config.clients.surge.mitm;
  const path = "clients.surge.mitm";
  return section(t("MITM 证书管理", "MITM certificate management"), `<p class="muted" data-help>${t("生成或导入 Surge 使用的 CA 证书。修改后保存配置，再在客户端更新订阅。", "Generate or import a CA certificate for Surge. Save changes, then update the subscription in your client.")}</p><p id="ca-status" role="status">${mitm.caP12 ? t("已配置 CA 证书", "CA certificate configured") : t("尚未配置 CA 证书", "No CA certificate configured")}</p><div class="toolbar">${btn(t("生成证书", "Generate certificate"), "generate-ca", "", "primary")}${btn(t("导入证书", "Import certificate"), "import-ca")}${btn(t("导出证书", "Export certificate"), "export-ca", mitm.caP12 ? "" : "disabled")}</div>${field(`${path}.caPassphrase`, mitm.caPassphrase)}<details><summary>${t("查看或编辑证书数据", "View or edit certificate data")}</summary>${field(`${path}.caP12`, mitm.caP12)}</details>`) + section(t("MITM 设置", "MITM settings"), Object.entries(mitm).filter(([key]) => !["caPassphrase", "caP12"].includes(key)).map(([key, value]) => field(`${path}.${key}`, value)).join(""));
}
function renderRules() {
  if (state.client === "clash") return clashRouting.render();
  const client = state.config.clients[state.client];
  const native = state.client === "singbox";
  const path = native ? `${basePath()}.route.rules` : `${basePath()}.rules`;
  const rawRules = getPath(state.config, path);
  const rules = Array.isArray(rawRules) ? rawRules : [];
  const compiled = client.ruleSets.mode === "compiled";
  let html = "";
  if (native) {
    if (!compiled) return section("", `<p class="help">${t("启用后，已有原生规则仍优先匹配，已保存的编排规则也会启用。", "Existing native rules keep priority. Previously saved rule-plan entries will also become active.")}</p>`, btn(t("使用规则集地址配置", "Use rule-set URLs"), "enable-singbox-rule-plan", "", "primary")) + renderSingboxSections(["route"]);
    return renderSingboxSections(["route"]) + renderRulePlan(client.ruleSets);
  }
  if (!compiled) {
    html += section("", `<div class="toolbar">${btn(native ? "JSON" : t("文本", "Text"), "edit-json", `data-path="${path}" data-lines="${native ? "false" : "true"}"`)}</div><div class="table-wrap"><table class="rule-table"><thead><tr><th>${t("顺序", "Order")}</th><th>${t("匹配类型", "Match")}</th><th>${t("匹配值", "Value")}</th><th>${t("出站策略", "Outbound")}</th><th>${t("操作", "Actions")}</th></tr></thead><tbody>${rules.map((rule, index) => ruleRow(rule, index, path, native)).join("") || `<tr><td colspan="5" class="empty">${t("还没有规则", "No rules")}</td></tr>`}</tbody></table></div>${btn(icon("plus") + t("添加规则", "Add rule"), "add-rule", `data-path="${path}"`)}${native ? `<div class="toolbar"></div>${field(`${basePath()}.route.final`, client.route.final || "", { label: t("默认出站", "Default outbound"), options: policyChoices(client.route.final || "") })}` : ""}<div class="toolbar"><span>${t("当前端策略组：", "Client groups:")}</span>${Object.keys(currentClient().groups).slice(0, 7).map((name) => `<span class="chip">${esc(name)}</span>`).join("")}<a href="#groups">${t("管理策略组", "Manage groups")}</a></div>`);
  }
  if (native) html += section(t("其他路由设置", "Other route settings"), Object.entries(client.route).filter(([key]) => !["rules", "final"].includes(key)).map(([key, value]) => field(`${basePath()}.route.${key}`, value)).join(""), btn(t("完整 JSON", "Full JSON"), "edit-json", `data-path="${basePath()}.route"`));
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
    value = isFinal ? parts.slice(2).join(", ") || "—" : parts[1];
    policy = parts[isFinal ? 1 : 2] || "—";
    simple = (state.client === "surge" ? SURGE_RULE_TYPES : LEGACY_RULE_FIELDS).includes(type);
  }
  const lockedFinal = !native && isFinalRule(rule);
  const types = native ? Object.keys(RULE_FIELDS) : state.client === "surge" ? SURGE_RULE_TYPES : LEGACY_RULE_FIELDS;
  const choices = [...new Set([...policyChoices(policy), ...(native ? ["hijack-dns", "sniff", "reject"] : [])])];
  const select = (kind, values, current) => `<select ${lockedFinal && kind === "type" ? "disabled" : ""} data-rule-field="${kind}" data-path="${path}" data-index="${index}" aria-label="${t("规则", "Rule")} ${index + 1} ${kind}">${values.map((item) => `<option value="${esc(item)}" ${item === current ? "selected" : ""}>${esc(kind === "type" && native ? t(...RULE_FIELDS[item]) : item)}</option>`).join("")}</select>`;
  return `<tr><td>${index + 1}</td><td>${simple && !lockedFinal ? select("type", types, type) : esc(type)}</td><td class="truncate">${esc(value)}</td><td>${simple ? select("policy", choices, policy) : esc(policy)}</td><td class="actions"><span class="order">${smallButton("up", "move-rule", `data-path="${path}" data-index="${index}" data-direction="-1" ${lockedFinal || index === 0 ? "disabled" : ""}`, t("上移", "Move up"))}${smallButton("down", "move-rule", `data-path="${path}" data-index="${index}" data-direction="1" ${lockedFinal || index === getPath(state.config, path).length - 1 || isFinalRule(getPath(state.config, path)[index + 1]) ? "disabled" : ""}`, t("下移", "Move down"))}</span>${iconButton("edit", simple ? "edit-rule" : "edit-rule-json", `data-path="${path}" data-index="${index}"`, t("编辑", "Edit"))}${smallButton("trash", "delete-rule", `data-path="${path}" data-index="${index}" ${lockedFinal ? "disabled" : ""}`, t("删除", "Delete"))}</td></tr>`;
}
function orderedPlan(plan) {
  return [...plan.outputs.map((item, index) => ({ kind: "output", item, index })), ...plan.directRules.map((item, index) => ({ kind: "direct", item, index }))].sort((a, b) => Number(isFinalEntry(a)) - Number(isFinalEntry(b)) || a.item.order - b.item.order);
}
function isFinalEntry(entry) {
  return entry?.kind === "direct" && isFinalRule(entry.item.rule);
}
function isFinalRule(rule) {
  return typeof rule === "string" && ["FINAL", "MATCH"].includes(splitRule(rule)[0]?.toUpperCase());
}
function nextPlanOrder(plan) {
  return Math.max(-1, ...orderedPlan(plan).map(({ item }) => item.order)) + 1;
}
function appendPlanItem(plan, kind, item) {
  const ordered = orderedPlan(plan);
  const final = ordered.findIndex((entry) => entry.kind === "direct" && isFinalRule(entry.item.rule));
  ordered.splice(final < 0 || (kind === "direct" && isFinalRule(item.rule)) ? ordered.length : final, 0, { kind, item });
  plan[kind === "output" ? "outputs" : "directRules"].push(item);
  ordered.forEach((entry, order) => entry.item.order = order);
}
function outputSourceUrls(output) {
  return output.sourceIds.map((id) => currentClient().ruleSets.sources.find((source) => source.id === id)?.url).filter(Boolean).join("\n");
}
function pruneUnusedRuleSources(plan) {
  const used = new Set(plan.outputs.flatMap((output) => output.sourceIds));
  plan.sources = plan.sources.filter((source) => used.has(source.id));
}
function sourcesForUrls(plan, text, preferredIds = []) {
  const urls = [...new Set(text.split("\n").map((url) => url.trim()).filter(Boolean))];
  for (const url of urls) {
    let parsed;
    try { parsed = new URL(url); } catch { throw Error(t("规则来源需要完整的 HTTP(S) 地址。", "Rule sources require full HTTP(S) URLs.")); }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw Error(t("规则来源需要不含登录凭据的 HTTP(S) 地址。", "Use HTTP(S) URLs without login credentials."));
  }
  const sources = structuredClone(plan.sources);
  const ids = urls.map((url) => {
    let source = sources.find((entry) => entry.url === url && preferredIds.includes(entry.id)) || sources.find((entry) => entry.url === url);
    if (!source) {
      const parsed = new URL(url);
      source = { id: crypto.randomUUID(), name: parsed.pathname.split("/").filter(Boolean).at(-1) || parsed.hostname, url, enabled: true, format: "auto", order: Math.max(-1, ...sources.map((entry) => entry.order)) + 1 };
      sources.push(source);
    }
    return source.id;
  });
  return { sources, ids };
}
function policyChoices(selected = "") {
  const client = currentClient();
  const builtins = state.client === "surge" ? ["DIRECT", "CELLULAR", "CELLULAR-ONLY", "HYBRID", "NO-HYBRID", "REJECT", "REJECT-DROP", "REJECT-NO-DROP", "REJECT-TINYGIF"] : state.client === "clash" ? ["DIRECT", "REJECT", "REJECT-DROP", "PASS", "PASS-RULE", "COMPATIBLE", "GLOBAL"] : ["DIRECT", "REJECT", "REJECT-DROP"];
  return [...new Set([...Object.keys(client.groups).filter((name) => !client.disabledGroups.includes(name)), ...builtins, ...(sharedProxyNames.names[state.client] || []), ...(state.client === "surge" ? (client.tailscaleNodes || []).filter((node) => node.enabled).map((node) => node.name) : state.client === "singbox" ? [...(client.endpoints || []), ...(client.outbounds || [])].map((node) => node.tag) : []), selected].filter(Boolean))];
}
function selectOptions(choices, selected) {
  return [...new Set([...choices, selected])].map((value) => `<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(value || t("无", "None"))}</option>`).join("");
}
const SURGE_RULE_TYPES = ["DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "IP-CIDR", "IP-CIDR6", "GEOIP", "IP-ASN", "PROCESS-NAME", "USER-AGENT", "URL-REGEX", "SCRIPT", "SUBNET", "SRC-IP", "IN-PORT", "DEST-PORT", "PROTOCOL", "DEVICE-NAME", "CELLULAR-RADIO", "WIFI-SSID", "RULE-SET", "DOMAIN-SET", "AND", "OR", "NOT", "FINAL"];
const SURGE_RULE_SET_TYPES = ["RULE-SET", "DOMAIN-SET"];
const SURGE_DIRECT_RULE_TYPES = SURGE_RULE_TYPES.filter((type) => !SURGE_RULE_SET_TYPES.includes(type));
function surgeOptionChoices(type) {
  if (type === "RULE-SET") return ["", "no-resolve", "extended-matching", "no-resolve,extended-matching"];
  if (["IP-CIDR", "IP-CIDR6", "GEOIP", "IP-ASN"].includes(type)) return ["", "no-resolve"];
  if (["DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "URL-REGEX", "DOMAIN-SET"].includes(type)) return ["", "extended-matching"];
  return type === "FINAL" ? ["", "dns-failed"] : [""];
}
function directMatchText(rule) {
  const parts = splitRule(rule);
  if (isFinalRule(rule)) return [parts[0], ...compiledFinalOptions(parts)].join(",");
  const options = ["no-resolve", "src", "extended-matching"].includes(parts[2]?.toLowerCase()) ? parts.slice(2) : parts.slice(3);
  return [parts[0], parts[1], ...options].join(",");
}
function compiledFinalOptions(parts) {
  // Compiled plans store the policy separately, so FINAL,dns-failed is valid.
  const second = parts[1]?.toLowerCase() || "";
  const option = ["dns-failed", "no-resolve", "src", "extended-matching"].includes(second) || second.includes("=");
  return parts.slice(option ? 1 : 2);
}
function renderRulePlan(plan) {
  const surge = state.client === "surge";
  const ordered = orderedPlan(plan);
  let rows = ordered.map(({ kind, item, index }, position) => {
    const output = kind === "output";
    const lockedFinal = !output && isFinalRule(item.rule);
    const attrs = `data-plan-kind="${kind}" data-index="${index}"`;
    const control = (field, tag, content, extra = "") => `<${tag} data-plan-field="${field}" ${attrs} ${extra}>${content}</${tag}>`;
    const urls = output ? state.invalid.get(`plan.${state.client}.output.${index}.sourceUrls`) ?? outputSourceUrls(item) : "";
    const content = output ? urls.split("\n").filter(Boolean).map((url) => `<div class="routing-url">${esc(url)}</div>`).join("") + (item.inlineRules.length ? `<span class="small muted">${t(`保留 ${item.inlineRules.length} 条已有规则`, `${item.inlineRules.length} existing rules retained`)}</span>` : "") : `<code>${esc(directMatchText(item.rule))}</code>`;
    const kindLabel = output ? (surge ? item.surgeType || t("规则集（自动类型）", "Rule set (automatic type)") : t("规则集", "Rule set")) : t("单条规则", "Direct rule");
    const policy = control("policy", "select", selectOptions(policyChoices(item.policy), item.policy), `aria-label="${t("出口策略", "Outbound policy")}"`);
    const options = output && surge ? `<label class="small">${t("Surge 选项", "Surge options")}${control("surgeOptions", "select", selectOptions(surgeOptionChoices(item.surgeType || "RULE-SET"), item.surgeOptions.join(",")))}</label>` : "";
    return `<tr><td>${position + 1}</td><td class="routing-content"><span class="small muted">${esc(kindLabel)}</span>${content}${output ? `<p class="small muted">DNS: ${esc(item.dnsServer || t("继承全局", "Inherit global"))}</p>` : ""}</td><td>${policy}${options}</td><td><label class="routing-enabled"><input type="checkbox" data-plan-field="enabled" ${attrs} ${item.enabled ? "checked" : ""} ${lockedFinal ? "disabled" : ""}>${t("启用", "Enabled")}</label></td><td class="actions"><span class="routing-actions"><span class="order">${iconButton("up", "move-plan", `data-position="${position}" data-direction="-1" ${lockedFinal || position === 0 ? "disabled" : ""}`, t("上移", "Move up"))}${iconButton("down", "move-plan", `data-position="${position}" data-direction="1" ${lockedFinal || position === ordered.length - 1 || isFinalEntry(ordered[position + 1]) ? "disabled" : ""}`, t("下移", "Move down"))}</span>${iconButton("edit", `edit-${kind}`, `data-index="${index}"`, t("编辑", "Edit"))}${iconButton("trash", `delete-${kind}`, `data-index="${index}" ${lockedFinal ? "disabled" : ""}`, t("删除", "Delete"))}</span></td></tr>`;
  }).join("");
  if (state.client === "singbox" && !plan.directRules.some((item) => item.enabled && isFinalRule(item.rule))) {
    const selected = currentClient().route.final || "";
    const choices = policyChoices(selected).filter((name) => !["REJECT", "REJECT-DROP"].includes(name));
    const options = `${selected ? "" : `<option value="">${t("内核默认（第一个出站）", "Core default (first outbound)")}</option>`}${selectOptions(choices, selected)}`;
    rows += `<tr><td>${ordered.length + 1}</td><td class="routing-content"><span class="small muted">${t("兜底规则", "Final rule")}</span><code>FINAL</code><div class="small muted">${t("未命中以上规则时使用", "Used when no preceding rule matches")}</div></td><td><select data-field="clients.singbox.route.final" aria-label="${t("兜底出口策略", "Final outbound policy")}">${options}</select></td><td><label class="routing-enabled"><input type="checkbox" checked disabled>${t("启用", "Enabled")}</label></td><td class="actions">${iconButton("trash", "delete-direct", "disabled", t("兜底规则不能删除", "The final rule cannot be deleted"))}</td></tr>`;
  }
  return section("", `${state.client === "surge" ? `${field(`${basePath()}.ruleSets.aggregateByPolicy`, plan.aggregateByPolicy)}<p class="help">${t("按策略聚合会在该策略首次出现的位置合并规则集，可能改变跨策略的匹配顺序。", "Same-policy aggregation merges rule sets at the policy's first occurrence and may change precedence across policies.")}</p>` : ""}<div class="toolbar">${btn(t("添加规则集", "Add rule set"), "add-output")}${btn(t("添加单条规则", "Add direct rule"), "add-direct")}</div><div class="table-wrap"><table class="routing-table surge-routing-table"><thead><tr><th>${t("匹配顺序", "Match order")}</th><th>${t("规则集地址 / 单条规则", "Rule-set URL / Direct rule")}</th><th>${t("出口策略", "Outbound policy")}</th><th>${t("状态", "Status")}</th><th class="actions">${t("操作", "Actions")}</th></tr></thead><tbody>${rows || `<tr><td colspan="5" class="empty">${t("还没有规则", "No rules")}</td></tr>`}</tbody></table></div>`);
}
function editDirect(index) {
  if (state.client === "surge") { editSurgeRule(null, index, true); return; }
  if (state.client === "singbox") { editSingboxDirect(index); return; }
  const rules = state.config.clients[state.client].ruleSets.directRules;
  const original = index === null ? { id: crypto.randomUUID(), rule: "DOMAIN-SUFFIX,example.com", policy: "Proxy", order: nextPlanOrder(currentClient().ruleSets), enabled: true } : rules[index];
  modal(t("编辑单条规则", "Edit direct rule"), Object.entries(original).filter(([key]) => !["id", "order", "name"].includes(key)).map(([key, value]) => localField(key, value, key === "policy" ? { options: policyChoices(value) } : {})).join(""), () => {
    const value = readLocal(original);
    if (!value.rule.trim()) throw Error(t("请填写规则", "Enter a rule"));
    if (index === null) appendPlanItem(currentClient().ruleSets, "direct", value); else rules[index] = value;
    closeModal(); changed(); render();
  });
}
function editSingboxDirect(index) {
  const plan = currentClient().ruleSets, original = index === null ? null : plan.directRules[index];
  const parts = splitRule(original?.rule || "DOMAIN-SUFFIX,example.com");
  const types = ["DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "DOMAIN-REGEX", "IP-CIDR", "IP-CIDR6", "SRC-IP", "SRC-IP-CIDR", "PROCESS-NAME", "PROCESS-PATH", "PROCESS-PATH-REGEX", "DST-PORT", "DEST-PORT", "SRC-PORT", "NETWORK", "PROTOCOL", "FINAL", "MATCH"];
  const form = { matchType: parts[0].toUpperCase(), matchValue: ["FINAL", "MATCH"].includes(parts[0].toUpperCase()) ? "" : parts[1] || "", policy: original?.policy || "Proxy", enabled: original?.enabled ?? true };
  modal(t("编辑 sing-box 单条规则", "Edit sing-box direct rule"), localField("matchType", form.matchType, { label: t("匹配类型", "Match type"), options: isFinalRule(original?.rule) ? [form.matchType] : types.filter((type) => !isFinalRule(type) || !plan.directRules.some((item) => isFinalRule(item.rule))) }) + localField("matchValue", form.matchValue, { label: t("匹配值（FINAL / MATCH 留空）", "Match value (empty for FINAL / MATCH)") }) + localField("policy", form.policy, { options: policyChoices(form.policy) }) + localField("enabled", form.enabled, { disabled: isFinalRule(original?.rule) }) + `<p class="help">${t("每条编排规则填写一个匹配值；复杂逻辑和原生动作可在上方“路由与规则集”表单中配置。", "Use one match value per compiled rule. Configure complex logic and native actions in the Routing & rule sets form above.")}</p>`, () => {
    const value = readLocal(form), final = ["FINAL", "MATCH"].includes(value.matchType);
    if (isFinalRule(original?.rule) && (!final || !value.enabled)) throw Error(t("兜底规则必须保留并启用", "The final rule must remain enabled"));
    if (final && plan.directRules.some((item) => item !== original && isFinalRule(item.rule))) throw Error(t("已有兜底规则", "A final rule already exists"));
    if (!types.includes(value.matchType)) throw Error(t("此编排类型无法等价转换，请使用原生路由表单", "This compiled type cannot be converted; use the native routing form"));
    if (!final && (!value.matchValue.trim() || /[,\r\n]/.test(value.matchValue))) throw Error(t("请填写单个有效匹配值", "Enter one valid match value"));
    const originalFinal = ["FINAL", "MATCH"].includes(parts[0].toUpperCase());
    const hasOptions = parts.length > (originalFinal ? 2 : 3)
      || parts.slice(originalFinal ? 1 : 2).some((part) => ["no-resolve", "src", "extended-matching", "dns-failed"].includes(part.toLowerCase()));
    if (hasOptions) throw Error(t("此旧规则含附加选项，请通过原生路由表单改写后删除旧规则", "This legacy rule has extra options; rewrite it in the native routing form, then delete the old rule"));
    const rule = final ? value.matchType : `${value.matchType},${value.matchValue.trim()},${value.policy}`;
    const next = { ...(original || { id: crypto.randomUUID(), order: nextPlanOrder(plan) }), rule, policy: value.policy, enabled: value.enabled };
    if (index === null) appendPlanItem(plan, "direct", next); else plan.directRules[index] = next;
    closeModal(); changed(); render();
  });
}

function renderLinks() {
  return `<p class="muted" data-help>${t("三个客户端使用同一条订阅地址，按 User-Agent 自动识别 Surge、clash或 sing-box。请在客户端中导入；链接中的 token 授予订阅读取权限。", "All three clients use this subscription URL. User-Agent identifies Surge, clash, or sing-box. Import it in your client; the token grants subscription read access.")}</p><div id="subscription-links"><p class="muted">${t("正在读取…", "Loading…")}</p></div><div class="toolbar">${btn(t("轮换读取 token", "Rotate read token"), "rotate-token", "", "danger")}</div>` + section(t("订阅检查", "Subscription check"), `<p class="help" data-help>${t("检查服务器已保存的配置。订阅更新失败时，可在这里查看具体原因；规则未就绪时，检查会启动后台准备；启用 Actions 后可在编译进度中查看三个客户端的状态。", "Check the configuration saved on the server to find out why a subscription update failed. If rules are not ready, the check starts background preparation. With Actions enabled, view all three clients in compilation progress.")}</p><div class="toolbar">${Object.entries(CLIENTS).map(([id, client]) => btn(`${t("检查", "Check")} ${esc(client.label)}`, "check-subscription", `data-client="${id}"`)).join("")}</div><div id="subscription-check-result">${renderSubscriptionCheck()}</div>`);
}
function renderActionsCompilationSettings() {
  const options = state.config.settings.actionsCompilation || { enabled: false, repository: "", ref: "main" };
  const path = "settings.actionsCompilation";
  return `<section class="section"><div class="section-heading"><div class="help-title">
      <h2>${t("Actions 规则编译（选配）", "Actions rule compilation (optional)")}</h2>
      <details class="settings-help">
        <summary aria-label="${t("了解 Actions 规则编译", "About Actions rule compilation")}"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.7-2.5 1.8-2.5 3.5M12 16v.1"/></svg></summary>
        <div class="settings-help-content">
          <p>${t("将规则编译交给 GitHub Actions，减轻 Worker 处理大规则集时的超时压力。", "Offload rule compilation to GitHub Actions to reduce Worker timeouts when processing large rule sets.")}</p>
          <p>${t("支持 Surge 文本规则、Clash YAML 和 sing-box SRS。未启用或产物未就绪时，由 Worker 处理并提供规则。", "Supports Surge text rules, Clash YAML and sing-box SRS. The Worker processes and serves rules when Actions is disabled or artifacts are not ready.")}</p>
          <p>${t("编译结果保存在公开 GitHub 仓库，规则内容会公开。", "Compiled rules are stored in a public GitHub repository, so their contents are public.")}</p>
          <p>${t("GitHub Token 仅选择目标仓库，授予 Actions、Contents、Workflows、Secrets 读写权限。同一个 Token 用于安装与日常编译，加密保存在 KV；启用期间请勿撤销。", "Limit the GitHub token to the target repository and grant Actions, Contents, Workflows and Secrets read/write access. The same token is used for installation and ongoing compilation, stored encrypted in KV; keep it valid while Actions compilation is enabled.")}</p>
          <p>${t("按顺序完成检查、安装和启用。仓库文件公开；凭据仅保存为加密数据或 GitHub Secrets。不会保存其他页面的草稿。", "Check, install and enable in order. Repository files are public; credentials remain encrypted or in GitHub Secrets. Other page drafts are not saved.")}</p>
          <p class="help">${t("自动填入上次成功安装时使用的地址。建议填写本部署的 workers.dev 地址，避免自定义域名的人机验证；首次升级后如果地址为空，请重新填写一次。仅检查地址格式，不检查连通性；请确认地址属于本部署。实际连接由 GitHub Action 执行。", "Uses the address from the last successful installation. Prefer this deployment's workers.dev address to avoid custom-domain bot challenges. If the field is empty after upgrading, enter it once. Only address format is checked, not connectivity; ensure it belongs to your deployment. GitHub Actions makes the actual connection.")}</p>
          <p class="help">${t("向导会安装或更新通用工作流与编译器。产物固定使用 rules 分支，按三个客户端分目录保存。", "The wizard installs or updates the shared workflow and compiler. Artifacts use the fixed rules branch with a directory for each client.")}</p>
        </div>
      </details>
    </div></div>`
    + field(`${path}.enabled`, options.enabled, { label: t("启用 Actions 规则编译", "Enable Actions rule compilation") })
    + `<div id="actions-compiler-settings" ${options.enabled ? "" : "hidden"}>`
    + field(`${path}.repository`, options.repository, { label: t("公开 GitHub 仓库（owner/repo）", "Public GitHub repository (owner/repo)") })
    + field(`${path}.ref`, options.ref, { label: t("工作流分支（仓库默认分支）", "Workflow branch (repository default)") })
    + `<div class="toolbar">${btn(t("配置向导", "Setup wizard"), "actions-setup", "", "primary")}${btn(t("查看编译进度", "View compilation progress"), "actions-progress")}</div>`
    + `</div></section>`;
}
function actionsDispatchFailure(code) {
  const hints = {
    401: t("GitHub Token 无效或已过期，请通过配置向导更新。", "The GitHub token is invalid or expired. Update it through the setup wizard."),
    403: t("请检查 GitHub Token 的 Actions 读写权限、组织审批状态及 API 调用限制。", "Check the GitHub token's Actions read/write permission, organization approval and API rate limits."),
    404: t("请检查仓库及 GitHub Token 的访问权限，并通过配置向导重新安装工作流。", "Check the repository and the GitHub token's access, then reinstall the workflow through the setup wizard."),
    422: t("请检查工作流分支是否存在、工作流是否支持手动触发（workflow_dispatch），以及输入参数是否正确。", "Check that the workflow branch exists, the workflow supports manual dispatch (workflow_dispatch), and its inputs are valid.")
  };
  return code ? `${hints[code] || t("请检查 GitHub 仓库和 Actions 设置后重试。", "Check the GitHub repository and Actions settings, then retry.")} (HTTP ${code})`
    : t("网络异常或请求超时，暂时无法确认 GitHub 是否收到请求。请先查看仓库 Actions，再决定是否重试。", "A network error or timeout prevented confirmation that GitHub received the request. Check repository Actions before retrying.");
}
function actionsProgressStage(output) {
  const stages = {
    workflow_update_required: [t("需更新工作流", "Workflow update required"), "warning", t("请返回系统设置，运行配置向导以更新工作流和编译脚本。", "Return to System settings and run the setup wizard to update the workflow and compiler script.")],
    pending: [t("等待提交", "Waiting to submit"), "pending", t("尚未提交编译请求，等待后台处理。", "The compilation request has not been submitted yet. Waiting for background processing.")],
    awaiting: [t("等待请求结果", "Awaiting request result"), "pending", t("已尝试提交请求，尚未确认 GitHub 是否接收。请稍后刷新。", "A submission was attempted, but receipt by GitHub is still unconfirmed. Refresh shortly.")],
    accepted: [t("等待编译结果", "Awaiting compilation result"), "pending", t("GitHub 已接收请求，尚未确认编译完成。排队情况和执行进度请查看仓库 Actions。", "GitHub accepted the request; completion is not yet confirmed. Check repository Actions for queue status and execution progress.")],
    dispatch_failed: [output.httpStatus ? t("提交失败", "Submission failed") : t("请求结果未确认", "Request not confirmed"), "warning", actionsDispatchFailure(output.httpStatus)],
    retrying: [t("等待重试", "Awaiting retry"), "warning", t("上次提交已超过 60 分钟，仍未确认完成。后台会再次尝试，也可手动重新提交。", "The last submission was over 60 minutes ago and completion is still unconfirmed. The background process will retry, or you can resubmit manually.")],
    complete: [t("已就绪", "Ready"), "ready", ""]
  };
  const [label, tone, description] = stages[output.state] || [t("状态待确认", "Status unknown"), "pending", t("请刷新状态，或前往仓库 Actions 查看运行情况。", "Refresh the status or check repository Actions for execution details.")];
  return { label, tone, description };
}
async function showActionsProgress() {
  const status = await api("/api/actions-compilation/status");
  const hasOutputs = status.enabled && status.total > 0;
  const allReady = hasOutputs && status.completed === status.total;
  const retryable = status.outputs.find((output) => ["pending", "awaiting", "accepted", "dispatch_failed", "retrying"].includes(output.state));
  const heading = !status.enabled ? t("尚未启用 Actions 编译", "Actions compilation is not enabled")
    : !hasOutputs ? t("暂无需要编译的规则集", "No rule sets need compilation")
    : allReady ? t("Actions 产物全部就绪", "All Actions artifacts are ready") : t("Actions 编译进度", "Actions compilation progress");
  const description = !status.enabled ? t("当前由 Worker 处理规则。可在系统设置中通过配置向导启用 Actions 规则编译。", "Rules are currently processed by the Worker. Enable Actions rule compilation through the setup wizard in System settings.")
    : !hasOutputs ? t("当前已保存配置中，没有需要合并或转换的规则集。请检查各客户端的规则来源编排。", "The saved configuration has no rule sets requiring merging or conversion. Check the rule plans for each client.")
    : allReady ? t("在对应客户端中更新订阅，即可使用已发布的规则集。", "Update the subscription in each client to use the published rule sets.")
    : t("Actions 正在后台处理或确认结果。未就绪的规则由 Worker 处理，更新订阅无需等待 Actions 完成。", "Actions processing or publication confirmation is pending. The Worker handles unready rule sets, so subscription updates do not need to wait for Actions.");
  const renderRow = (output) => {
    const stage = actionsProgressStage(output);
    return `<li class="actions-progress-item"><div class="actions-progress-item-heading"><strong>${esc(output.name)}</strong><span class="actions-progress-state ${stage.tone}">${esc(stage.label)}</span></div>
      ${stage.description ? `<p class="actions-progress-description">${esc(stage.description)}</p>` : ""}
      ${output.hasPublishedVersion && output.state !== "complete" ? `<p class="help">${t("刷新期间可继续使用已发布的规则。", "Previously published rules remain available during refresh.")}</p>` : ""}
      ${!output.hasPublishedVersion ? `<p class="help">${output.workerFallbackReady ? t("当前由 Worker 缓存提供规则，订阅可继续使用。", "Worker-cached rules are available for subscriptions.") : t("Worker 将按需准备规则，无需等待 Actions 产物。", "The Worker prepares rules on demand without waiting for Actions artifacts.")}</p>` : ""}
      ${output.lastAttemptAt ? `<p class="help actions-progress-attempt">${t("最近提交尝试", "Last submission attempt")}: ${esc(formatDate(output.lastAttemptAt))}</p>` : ""}</li>`;
  };
  const rows = ["surge", "clash", "sing-box"].map((target) => {
    const outputs = status.outputs.filter((output) => output.target === target);
    const label = { surge: "Surge", clash: "Clash", "sing-box": "sing-box" }[target];
    return outputs.length ? `<section class="actions-progress-client"><h3>${label}<span class="small muted">${outputs.filter((output) => output.state === "complete").length} / ${outputs.length} ${t("已就绪", "ready")}</span></h3><ul class="actions-progress-list" aria-label="${label}">${outputs.map(renderRow).join("")}</ul></section>` : "";
  }).join("");
  modal(t("Actions 编译进度", "Actions compilation progress"),
    `<div class="actions-progress">
      <div class="actions-progress-overview" role="status"><div class="actions-progress-heading"><h3>${heading}</h3>${hasOutputs ? `<p class="actions-progress-count"><strong>${status.completed} / ${status.total}</strong><span>${t("Actions 产物已就绪", "Actions artifacts ready")}</span></p>` : ""}</div><p>${description}</p></div>
      ${hasOutputs ? rows : ""}
      ${retryable ? `<div class="actions-progress-retry">${btn(t("重新提交编译", "Resubmit compilation"), "actions-force-retry", `data-output="${esc(retryable.name)}" data-target="${esc(retryable.target)}" aria-describedby="actions-retry-help"`)}<p class="help" id="actions-retry-help">${t("重新提交后，GitHub 将检查全部规则集，跳过已就绪且未变化的规则集。无需等待 60 分钟重试间隔，但可能新增一个排队批次。", "After resubmission, GitHub checks all rule sets and skips unchanged ready ones. This bypasses the 60-minute retry interval, but may queue an extra batch.")}</p></div>` : ""}
      <p class="help actions-progress-note">${t("显示已保存配置的状态，更新可能略有延迟。点击“刷新状态”获取最新结果。", "Shows the saved configuration; updates may be slightly delayed. Select Refresh status for the latest result.")}</p>
    </div>`, showActionsProgress, t("刷新状态", "Refresh status"));
  $('#modal-actions [data-action="close-modal"]').textContent = t("关闭", "Close");
}
function applyActionsSettings(settings) {
  state.config.settings.actionsCompilation = settings;
  if (state.saved) {
    const baseline = JSON.parse(state.saved);
    baseline.settings.actionsCompilation = settings;
    state.saved = JSON.stringify(baseline);
  }
  const section = $("#actions-compiler-settings")?.closest("section");
  if (section) section.outerHTML = renderActionsCompilationSettings();
  updateStatus();
}
async function skipActionsUpgrade() {
  if (modal.installingActions || modal.skippingActionsUpgrade) return;
  modal.skippingActionsUpgrade = true;
  const controls = [...$("#modal").querySelectorAll("input, button")];
  controls.forEach((control) => { control.disabled = true; });
  try {
    const current = await api("/api/config");
    const settings = { ...current.settings.actionsCompilation, enabled: false };
    const updated = await api("/api/config", { method: "PATCH", body: JSON.stringify({ version: 3, settings: { actionsCompilation: settings } }) });
    applyActionsSettings(updated.settings.actionsCompilation);
    modal.actionsUpgradeRequired = false;
    modal.skippingActionsUpgrade = false;
    closeModal();
    toast(t("已关闭 Actions 规则编译，继续由 Worker 提供规则。", "Actions rule compilation is disabled. The Worker continues serving rules."));
  } catch (error) {
    toast(t("关闭未保存，请重试：", "Disabling was not saved. Please retry: ") + error.message);
  } finally {
    modal.skippingActionsUpgrade = false;
    controls.forEach((control) => { control.disabled = false; });
  }
}
async function checkActionsUpgrade() {
  if (state.migration || !state.config.settings.actionsCompilation?.enabled) return;
  try {
    const status = await api("/api/actions-compilation/status");
    if (!status.enabled || status.workflowReady !== false) return;
    modal.actionsUpgradeRequired = true;
    await showActionsSetup({ automatic: true });
  } catch (error) {
    modal(t("暂时无法检查 Actions 工作流", "Unable to check the Actions workflow"),
      `<p>${esc(error.message)}</p>`, checkActionsUpgrade, t("重新检查", "Retry check"));
    if (modal.actionsUpgradeRequired) $('#modal-actions [data-action="close-modal"]').textContent = t("跳过并关闭 Actions 编译", "Skip and disable Actions compilation");
  }
}
async function showActionsSetup({ automatic = false } = {}) {
  const status = await api("/api/actions-compilation/install/status");
  const settings = state.config.settings.actionsCompilation || {};
  const tokenMask = "********";
  const tokenHelp = () => status.dispatchTokenConfigured
    ? t("已配置。保留掩码沿用，输入新 Token 后保存即可替换。", "Configured. Keep the mask to reuse the token, or enter a new token and save to replace it.")
    : t("请填写仅授权目标仓库的 Token。", "Enter a token with access to the target repository only.");
  const callbackOrigin = status.callbackOrigin || (/^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(location.hostname) ? location.origin : "");
  modal(t("Actions 规则编译配置向导", "Actions rule compilation setup wizard"),
    `<div class="actions-setup-form">
    ${automatic ? `<p class="actions-setup-notice" role="status">${t("检测到 Actions 工作流需要更新，正在使用已保存的配置自动安装。安装失败时可修正后重试；选择跳过将关闭 Actions 规则编译，继续由 Worker 提供规则。", "The Actions workflow needs updating. Installing automatically with your saved settings. If installation fails, correct the settings and retry, or skip to disable Actions compilation and keep the Worker serving rules.")}</p>` : ""}
    <div class="actions-setup-row">
      <label for="actions-setup-repo">${t("公开仓库", "Public repository")}</label>
      <div class="actions-setup-field">
        <input id="actions-setup-repo" value="${esc(settings.repository || "")}" placeholder="owner/repo" spellcheck="false" autocapitalize="none" aria-describedby="actions-setup-repo-help">
        <div class="actions-setup-note">
          <p id="actions-setup-repo-help">${t("格式：owner/repo", "Format: owner/repo")}</p>
          <a href="https://github.com/new" target="_blank" rel="noopener noreferrer">${t("创建仓库（添加 README）", "Create repository (include README)")}</a>
        </div>
      </div>
    </div>
    <div class="actions-setup-row">
      <label for="actions-setup-origin">${t("工作流访问地址", "Workflow callback address")}</label>
      <div class="actions-setup-field">
        <input id="actions-setup-origin" type="url" value="${esc(callbackOrigin)}" spellcheck="false" autocapitalize="none" required>
      </div>
    </div>
    <div class="actions-setup-row">
      <label for="actions-setup-token">GitHub Token</label>
      <div class="actions-setup-field">
        <input id="actions-setup-token" type="password" autocomplete="new-password" value="${status.dispatchTokenConfigured ? tokenMask : ""}" aria-describedby="actions-setup-token-help actions-setup-token-scope">
        <div class="actions-setup-note">
          <p id="actions-setup-token-help">${tokenHelp()}</p>
          <a href="https://github.com/settings/personal-access-tokens/new?name=SubPilot&amp;expires_in=none&amp;actions=write&amp;contents=write&amp;workflows=write&amp;secrets=write" target="_blank" rel="noopener noreferrer">${t("申请 Token（预选权限）", "Create token (preset permissions)")}</a>
        </div>
        <p class="actions-setup-note" id="actions-setup-token-scope">${t("请在 GitHub 选择仓库所有者，并仅授权目标仓库。", "On GitHub, choose the repository owner and grant access only to the target repository.")}</p>
      </div>
    </div>
    <details class="actions-setup-advanced"><summary>${t("高级设置", "Advanced settings")}</summary>
      <div class="actions-setup-row">
        <label for="actions-setup-ref">${t("工作流分支", "Workflow branch")}</label>
        <div class="actions-setup-field">
          <input id="actions-setup-ref" value="${esc(settings.ref || "main")}" spellcheck="false" autocapitalize="none" aria-describedby="actions-setup-ref-help">
          <p class="actions-setup-note" id="actions-setup-ref-help">${t("使用仓库默认分支。", "Use the repository's default branch.")}</p>
        </div>
      </div>
    </details></div>
    <ol id="actions-setup-results" role="status" aria-live="polite"></ol>`, async () => {
      if (modal.installingActions) return;
      const next = { enabled: true, repository: $("#actions-setup-repo").value.trim(), ref: $("#actions-setup-ref").value.trim() };
      const invalid = validateActionsCompilationSettings(next, state.lang);
      if (invalid) throw Error(invalid);
      let token = $("#actions-setup-token").value.trim();
      if (status.dispatchTokenConfigured && token === tokenMask) token = "";
      $("#actions-setup-token").value = status.dispatchTokenConfigured ? tokenMask : "";
      if (!token && !status.dispatchTokenConfigured) throw Error(t("请填写所需 Token", "Enter the required tokens"));
      const callbackOrigin = $("#actions-setup-origin").value.trim();
      const replaceExisting = true;
      const controls = [...$("#modal").querySelectorAll("input, button")];
      const results = $("#actions-setup-results"); results.replaceChildren();
      const report = (message) => { const li = document.createElement("li"); li.textContent = message; results.append(li); };
      modal.installingActions = true; controls.forEach((control) => { control.disabled = true; });
      try {
        const saved = await api("/api/config");
        if (!Object.values(saved.clients || {}).some((client) => client.ruleSets?.mode === "compiled")) throw Error(t("请先为至少一个客户端启用规则来源编排并保存配置。", "Enable and save a rule plan for at least one client first."));
        if (token) {
          await api("/api/actions-compilation/credentials", { method: "PUT", body: JSON.stringify({ token }) });
          status.dispatchTokenConfigured = true;
        }
        report(t("编译凭据已配置", "Compilation credentials configured"));
        report(t("正在检查访问地址和仓库，然后安装工作流…", "Checking callback and repository, then installing workflow…"));
        const installed = await api("/api/actions-compilation/install", { method: "POST", body: JSON.stringify({ settings: next, token, callbackOrigin, replaceExisting }) });
        for (const step of installed.completed) {
          const [zh, en] = step.split(" / ");
          report(t(zh, en === "configured" ? `${zh.split(" ")[0]} configured` : en || zh));
        }
        const updated = await api("/api/config", { method: "PATCH", body: JSON.stringify({ version: 3, settings: { actionsCompilation: next } }) });
        applyActionsSettings(updated.settings.actionsCompilation);
        modal.actionsUpgradeRequired = false;
        status.dispatchTokenConfigured = true;
        report(t("已启用并保存。后台将向 Actions 提交规则处理任务；关闭窗口后可查看各客户端进度。", "Enabled and saved. Rule processing will be submitted to Actions; close this dialog to view progress for each client."));
        const countdown = document.createElement("p");
        countdown.setAttribute("role", "status");
        results.after(countdown);
        const expiresAt = Date.now() + 5000;
        const updateCountdown = () => {
          const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
          countdown.textContent = t(`配置成功，${seconds} 秒后自动关闭`, `Setup complete. Closing in ${seconds} seconds.`);
          if (!seconds) closeModal();
        };
        updateCountdown();
        modal.autoCloseTimer = setInterval(updateCountdown, 250);
        modal.save = null;
        $("#modal-actions").innerHTML = btn(t("关闭", "Close"), "close-modal");
      } catch (error) { report(error.message); }
      finally {
        token = "";
        $("#actions-setup-token").value = status.dispatchTokenConfigured ? tokenMask : "";
        $("#actions-setup-token-help").textContent = tokenHelp();
        modal.installingActions = false;
        controls.forEach((control) => { control.disabled = false; });
      }
    }, t("检查、安装并启用", "Check, install and enable"));
  $("#modal").classList.add("actions-setup-dialog");
  if (modal.actionsUpgradeRequired) {
    $('#modal-actions [data-action="close-modal"]').textContent = t("跳过并关闭 Actions 编译", "Skip and disable Actions compilation");
  }
  if (automatic) {
    try { await modal.save?.(); }
    catch (error) {
      const item = document.createElement("li");
      item.textContent = error.message;
      $("#actions-setup-results").append(item);
    }
  }
}
function renderSystemOverview() {
  const settings = state.config.settings;
  const setting = (key, title) => field(`settings.${key}`, settings[key], title ? { label: title } : {});
  return `<div class="system-overview">`
    + section(t("界面偏好", "Preferences"), `<div class="system-preference-fields">`
      + setting("displayTimeZone", t("显示时区", "Display time zone"))
      + setting("updateCheckEnabled", t("检查版本更新", "Check for updates")) + `</div>`)
    + section(t("节点处理", "Node processing"), `<div class="system-node-settings">`
      + setting("excludeKeywords", t("排除关键词", "Excluded keywords"))
      + setting("featureTagRules", t("节点特征标签", "Node feature tags"))
      + setting("geoipRenameEnabled", t("GeoIP 节点重命名", "GeoIP node renaming")) + `</div>`)
    + section(t("订阅与抓取", "Subscription and fetching"), ["managedBaseUrl", "userAgentSurge", "userAgentClash"].map((key) => setting(key)).join(""))
    + `</div>`;
}
function renderMmdbSettings() {
  const mmdbPaths = [["Surge macOS", "~/Library/Application Support/com.nssurge.surge-mac/GeoLite2-Country.mmdb"], ["Clash Verge Windows", "%APPDATA%\\io.github.clash-verge-rev.clash-verge-rev\\Country.mmdb"], ["Clash Verge macOS", "~/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/Country.mmdb"]];
  return `<section class="section mmdb-panel" aria-labelledby="mmdb-heading">
    <div class="section-heading"><h2 id="mmdb-heading">GeoIP MMDB</h2>${btn(t("刷新数据库信息", "Refresh database information"), "refresh-mmdb", `id="mmdb-refresh" ${mmdb.loading || mmdb.uploading ? "disabled" : ""}`, "quiet")}</div>
    <p class="help mmdb-description" data-help>${t("上传 MMDB 数据库用于节点地理位置识别。", "Upload an MMDB database for node geolocation.")}</p>
    <div class="mmdb-layout">
      <div id="mmdb-status" role="status" aria-live="polite"></div>
      <div class="mmdb-upload-panel" aria-labelledby="mmdb-upload-heading">
        <div class="help-title mmdb-upload-heading">
          <h3 id="mmdb-upload-heading">${t("上传数据库", "Upload database")}</h3>
          <details class="settings-help mmdb-help">
            <summary aria-label="${t("查看数据库文件路径提示", "Show database file path tips")}"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.7-2.5 1.8-2.5 3.5M12 16v.1"/></svg></summary>
    <div class="mmdb-path-help" aria-label="${t("MMDB 文件路径参考", "MMDB file path reference")}">
      <p class="help">${t("可从本机客户端选择现有文件：", "Select an existing file from a local client:")}</p>
      <dl>${mmdbPaths.map(([client, path]) => `<div class="mmdb-path-row"><dt>${esc(client)}</dt><dd><code>${esc(path)}</code></dd></div>`).join("")}</dl>
    </div>
          </details>
        </div>
        <div class="mmdb-upload-controls">
          <label for="mmdb-upload">${t("选择数据库文件", "Choose database file")}</label>
          <input type="file" id="mmdb-upload" accept=".mmdb" aria-describedby="mmdb-upload-help" ${mmdb.uploading ? "disabled" : ""}>
          ${btn(t("上传", "Upload"), "upload-mmdb", 'id="mmdb-submit" disabled', "primary")}
        </div>
        <p class="help" id="mmdb-upload-help">${t("最大 25 MiB。选择文件后点击上传，成功后立即生效。", "Up to 25 MiB. Select a file, then click Upload. Changes take effect on success.")}</p>
        <div id="mmdb-transfer" role="status" aria-live="polite"></div>
      </div>
    </div>

  </section>`;
}
function renderSystem() {
  return renderSystemOverview() + renderActionsCompilationSettings() + renderMmdbSettings() + section("Telegram", field("settings.notificationTelegramBotToken", state.config.settings.notificationTelegramBotToken) + `<div id="telegram-settings" ${state.config.settings.notificationTelegramBotToken?.trim() ? "" : "hidden"}>` + field("settings.notificationTelegramChatId", state.config.settings.notificationTelegramChatId) + `<div class="toolbar">${btn(t("生成绑定码", "Generate binding code"), "telegram-bind")}${btn(t("解除绑定", "Unbind"), "telegram-unbind", "", "danger")}</div><p class="help">${t("通知凭据保存后生效。", "Save notification credentials before binding.")}</p></div>`);
}
function updateSystemSettingsVisibility() {
  const actions = $("#actions-compiler-settings");
  if (actions) actions.hidden = !state.config.settings.actionsCompilation?.enabled;
  const telegram = $("#telegram-settings");
  if (telegram) telegram.hidden = !state.config.settings.notificationTelegramBotToken?.trim();
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
    [t("文件大小", "File size"), mmdbSize(current.size || 0)],
    [t("数据库版本（构建时间）", "Database version (build time)"), current.builtAt ? formatDate(current.builtAt) : t("未提供构建时间", "Build time unavailable")],
    [t("上传时间", "Uploaded at"), formatDate(current.updatedAt)]
  ] : [];
  status.innerHTML = (rows.length ? `<dl class="mmdb-metadata">${rows.map(([name, value], index) => `<div${index === 0 ? ' class="mmdb-current-file"' : ""}><dt>${esc(name)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl>` : "")
    + (current && !current.uploaded ? `<p class="muted mmdb-empty">${t("尚未上传 MMDB 数据库。", "No MMDB database uploaded.")}</p>` : "")
    + (mmdb.loading ? `<p class="muted">${t("正在读取数据库信息…", "Loading database information…")}</p>` : "")
    + (mmdb.statusError ? `<p class="danger-text">${t("无法读取当前数据库信息，请重试。", "Could not load current database information. Please retry.")}</p>` : "");
  status.setAttribute("aria-busy", String(mmdb.loading));
  $("#mmdb-refresh").disabled = mmdb.loading || mmdb.uploading;
  $("#mmdb-upload").disabled = mmdb.uploading;
  $("#mmdb-submit").disabled = !mmdb.file || mmdb.uploading;
  $("#mmdb-submit").textContent = mmdb.uploading ? t("上传中…", "Uploading…") : t("上传", "Upload");
  const selected = mmdb.file ? `<p class="mmdb-file">${t("已选择：", "Selected: ")}${esc(mmdb.file.name)} · ${mmdbSize(mmdb.file.size)}</p>` : "";
  const message = mmdb.uploading ? (mmdb.progress < 100 ? t(`正在上传 ${mmdb.progress}%`, `Uploading ${mmdb.progress}%`) : t("传输完成，正在校验并保存数据库…", "Transfer complete. Validating and saving the database…")) : mmdb.outcome === "success" ? t("上传成功，当前数据库信息已更新。", "Upload succeeded. Current database information updated.") : mmdb.outcome === "invalid" ? t("请选择非空的 .mmdb 文件，大小不能超过 25 MiB。", "Choose a nonempty .mmdb file up to 25 MiB.") : mmdb.outcome === "error" ? t(`上传未完成：${mmdb.error}。可点击上传重试，或刷新数据库信息确认当前状态。`, `Upload did not complete: ${mmdb.error}. Retry the upload or refresh database information to check the current state.`) : mmdb.file ? t("文件已准备好，请点击上传。", "File ready. Click Upload to start.") : "";
  $("#mmdb-transfer").innerHTML = selected + (mmdb.uploading ? `<progress max="100" ${mmdb.progress < 100 ? `value="${mmdb.progress}"` : ""} aria-label="${t("MMDB 上传进度", "MMDB upload progress")}"></progress>` : "") + (message ? `<p class="${["error", "invalid"].includes(mmdb.outcome) ? "danger-text" : "muted"}">${esc(message)}</p>` : "");
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
function destroyModalEditors() {
  for (const editor of modal.editors || []) editor.destroy();
  modal.editors = [];
}
function modal(title, body, onSave, saveLabel = t("应用更改", "Apply changes")) {
  clearInterval(modal.autoCloseTimer);
  destroyModalEditors();
  $("#modal").classList.remove("routing-order-dialog", "actions-setup-dialog");
  clearHeadingTip($("#modal-title"));
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = body;
  mountHelpTips($("#modal-body"), $("#modal-title"));
  $("#modal-actions").innerHTML = btn(t("取消", "Cancel"), "close-modal") + (onSave ? btn(saveLabel, "modal-save", "", "primary") : "");
  modal.save = onSave;
  $("#modal").showModal();
  modal.editors = [...$("#modal-body").querySelectorAll("textarea.code-editor")].map((textarea) => {
    const editor = window.SubPilotCodeMirror.fromTextArea(textarea, { mode: "proxy-config", lineWrapping: true, indentUnit: 2, policyTokens: policyChoices });
    editor.on("change", () => editor.save());
    editor.view.contentDOM.setAttribute("aria-label", title);
    return editor;
  });
}
function closeModal() {
  if (modal.generatingCa || modal.installingActions || modal.retryingActions || modal.skippingActionsUpgrade) return;
  if (modal.actionsUpgradeRequired) { void skipActionsUpgrade(); return; }
  for (const input of document.querySelectorAll("#actions-setup-token")) input.value = "";
  destroyModalEditors();
  clearInterval(modal.autoCloseTimer);
  $("#modal").close();
  modal.save = null;
}
function localField(key, value, options = {}) {
  return field(key, value, { ...options, local: true }).replaceAll("data-field=", "data-local=");
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
  const original = index === null ? kind === "nodes" ? { id: crypto.randomUUID(), config: "", chainFilter: [], enabled: true, chainExit: false, includeInGroups: true } : { id: crypto.randomUUID(), name: "", url: "", fetchUserAgent: state.config.settings.userAgentSurge, enabled: true } : items[index];
  const entries = Object.entries(original).filter(([key]) => !["id", "urlEncrypted"].includes(key));
  const fields = kind === "nodes" ? entries.filter(([key]) => key !== "chainFilter").flatMap((entry) => entry[0] === "chainExit" ? [entry, ["chainFilter", original.chainFilter || []]] : [entry]) : entries;
  const body = fields.map(([key, value]) => localField(key, value, key === "chainFilter" ? {
    label: t("前置节点筛选", "Upstream node selection"),
    help: t("每行一个关键词。节点名称或标签包含任一关键词即选中，不区分大小写，不支持正则。仅为命中的非出口节点生成链式节点，留空不生成。链路：本机 → 命中节点 → 当前出口节点 → 目标网站。", "One keyword per line. Select nodes whose name or labels contain any keyword, ignoring case; regular expressions are not supported. Only matching non-exit nodes generate chained nodes; leave empty to generate none. Path: device → matching node → current exit node → destination.")
  } : key === "config" ? { multiline: true } : {})).join("");
  modal(t("编辑共享资源", "Edit shared resource"), body, () => {
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
  if (state.client === "singbox") { editSingboxGroup(name); return; }
  const original = name ? { name, spec: currentClient().groups[name], enabled: !currentClient().disabledGroups.includes(name) } : { name: "", spec: "select, {all}", enabled: true };
  const surge = state.client === "surge";
  const clash = state.client === "clash";
  if (clash) {
    const parts = splitPolicyGroupSpec(original.spec);
    original.defaultSelected = parts.slice(1).map(parseGroupOption).find((option) => option?.key === "default-selected")?.value || "";
    original.spec = parts.filter((part, index) => !index || parseGroupOption(part)?.key !== "default-selected").join(", ");
  }
  if (surge) {
    const parts = splitPolicyGroupSpec(original.spec);
    const options = parts.slice(1).map(parseGroupOption).filter(Boolean);
    original.category = options.find((option) => option.key.toLowerCase() === "category")?.value || "";
    const priority = options.find((option) => option.key.toLowerCase() === "policy-priority")?.value || "";
    original.priority = priority.startsWith('"') && priority.endsWith('"') ? priority.slice(1, -1).split(";").join("\n") : priority;
    original.spec = parts.filter((part, index) => !index || !["category", "policy-priority"].includes(parseGroupOption(part)?.key.toLowerCase())).join(", ");
  }
  const surgeOptions = surge ? localField("category", original.category, { label: t("分类（可选）", "Category (optional)") })
    + localField("priority", original.priority, { label: t("Smart 策略优先级（每行 regex:factor）", "Smart policy priority (one regex:factor per line)"), multiline: true, rows: 3 })
    + `<p class="help">${t("例如 Premium:0.9。权重必须大于 0；小于 1 更优先，大于 1 降低优先级，首个匹配项生效。仅用于 smart 或输出为 smart 的 url-test。分类与 HTTPS 测速需要支持这些参数的 Surge Beta。", "Example: Premium:0.9. Factors must be positive; below 1 increases preference, above 1 reduces it. The first match wins. Applies to smart or url-test emitted as smart. Category and HTTPS testing require a Surge Beta with support for these features.")}</p>` : "";
  const clashOptions = clash ? localField("defaultSelected", original.defaultSelected, { label: t("默认成员（仅 select，可选）", "Default member (select only, optional)") }) + `<p class="help">${t("填写输出中的完整成员名称；已保存的客户端选择可能覆盖此默认值。", "Enter the complete emitted member name; a saved client selection may override this default.")}</p>` : "";
  modal(t("编辑策略组", "Edit policy group"), localField("name", original.name, { readonly: name === "Proxy" }) + localField("spec", original.spec, { label: t("组配置", "Group definition"), multiline: true }) + surgeOptions + clashOptions + localField("enabled", original.enabled) + `<p class="help">${state.client === "surge" ? t("可使用 smart；兼容将 url-test 输出为 smart。smart 成员必须是代理节点，hidden=true 可隐藏组。", "Use smart; url-test is also emitted as smart for compatibility. Smart requires proxy-node members; hidden=true hides a group.") : state.client === "clash" ? t("支持 select、url-test、fallback 和 load-balance；hidden=true 的显示效果需要客户端或面板支持。", "Supports select, url-test, fallback and load-balance. hidden=true requires client or dashboard support.") : t("支持 select 和 url-test，分别输出为 selector 和 urltest；不支持 hidden。", "Supports select and url-test, emitted as selector and urltest. hidden is unsupported.")} ${t("修改名称不会自动重写规则引用。", "Renaming does not rewrite rule references.")}</p>`, () => {
    const value = readLocal(original);
    if (clash && value.defaultSelected.trim()) {
      const parts = splitPolicyGroupSpec(value.spec);
      const selected = value.defaultSelected.trim();
      if (parts[0]?.toLowerCase() !== "select") throw Error(t("默认成员仅适用于 select", "Default member only applies to select"));
      if (/[,={}\r\n\u0000-\u001f\u007f]/.test(selected)) throw Error(t("默认成员名称无效", "Invalid default member name"));
      if (parts.slice(1).some((part) => parseGroupOption(part)?.key === "default-selected")) throw Error(t("请勿重复填写默认成员", "Do not specify the default member twice"));
      parts.push(`default-selected=${selected}`);
      value.spec = parts.join(", ");
    }
    if (surge) {
      const parts = splitPolicyGroupSpec(value.spec);
      const category = value.category.trim();
      const priority = value.priority.split("\n").map((line) => line.trim()).filter(Boolean).join(";");
      if (category && /[,{}";#\r\n\u0000-\u001f\u007f]/.test(category)) throw Error(t("分类包含无效字符", "Category contains invalid characters"));
      const inlineKeys = parts.slice(1).map((part) => parseGroupOption(part)?.key.toLowerCase());
      if (category && inlineKeys.includes("category") || priority && inlineKeys.includes("policy-priority")) throw Error(t("请勿在组配置和独立字段中重复填写分类或优先级", "Do not duplicate category or priority in the group definition and separate fields"));
      if (priority) {
        if (!["smart", "url-test"].includes(parts[0]?.toLowerCase())) throw Error(t("策略优先级仅适用于 Smart", "Policy priority only applies to Smart"));
        const error = validatePolicyPriority(`"${priority}"`);
        if (error) throw Error(t(error, "Use valid regex:factor entries with finite positive factors"));
        parts.push(`policy-priority="${priority}"`);
      }
      if (category) parts.push(`category=${category}`);
      value.spec = parts.join(", ");
    }
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
function editSingboxGroup(name) {
  const client = currentClient();
  const original = { name: name || "", enabled: !client.disabledGroups.includes(name) };
  let form;
  modal(t("编辑 sing-box 策略组", "Edit sing-box group"), localField("name", original.name, { readonly: name === "Proxy" }) + localField("enabled", original.enabled) + '<div id="singbox-group-form" class="sb-form"></div>', () => {
    const value = readLocal(original), spec = form.read();
    value.name = value.name.trim();
    if (!value.name || /[\r\n,=]/.test(value.name)) throw Error(t("策略组名称无效", "Invalid group name"));
    if (name === "Proxy" && (value.name !== "Proxy" || !value.enabled)) throw Error(t("Proxy 必须保留并启用", "Proxy must remain enabled"));
    if (value.name !== name && (Object.hasOwn(client.groups, value.name) || [...client.outbounds || [], ...client.endpoints || []].some((item) => item.tag === value.name) || ["DIRECT", "REJECT", "REJECT-DROP"].includes(value.name.toUpperCase()))) throw Error(t("名称与已有策略或节点冲突", "Name conflicts with an existing policy or node"));
    if (name) { delete client.groups[name]; client.disabledGroups = client.disabledGroups.filter((item) => item !== name); }
    client.groups[value.name] = spec;
    if (!value.enabled) client.disabledGroups.push(value.name);
    closeModal(); changed(); render();
  });
  form = createSingboxGroupForm($("#singbox-group-form"), name ? client.groups[name] : "select, {all}", policyChoices().filter((choice) => choice !== name), { t, esc });
}
function editJson(path, lines = false) {
  const value = getPath(state.config, path);
  modal(label(path.split(".").at(-1)), `<textarea id="json-editor" class="code code-editor" rows="20" spellcheck="false">${esc(lines ? value.join("\n") : typeof value === "string" ? value : JSON.stringify(value, null, 2))}</textarea><p class="help">${t("应用更改后，请点击页面底部的「保存配置」。", "After applying changes, click Save configuration at the bottom of the page.")}</p>`, () => {
    const text = $("#json-editor").value;
    const next = lines ? text.split("\n").map((line) => line.trim()).filter(Boolean) : typeof value === "string" ? text : JSON.parse(text);
    if (Array.isArray(value) !== Array.isArray(next) || typeof value !== typeof next) throw Error(t("数据类型必须保持一致", "The value must retain its data type"));
    if (path.startsWith("clients.singbox")) validateNativeShape(next, path);
    if (isObject(value) && !isObject(next)) throw Error(t("需要 JSON 对象", "A JSON object is required"));
    if (path === "clients.surge.rules") validateSurgeFinal(next);
    setPath(state.config, path, next);
    state.invalid.delete(path);
    closeModal();
    changed();
    render();
  });
}
function validateSurgeFinal(rules) {
  const effective = rules.filter((line) => line.trim() && !line.trim().startsWith("#"));
  if (effective.filter(isFinalRule).length !== 1 || splitRule(effective.at(-1) || "")[0].toUpperCase() !== "FINAL") throw Error(t("必须保留唯一的 FINAL 兜底规则，并放在最后。", "Keep exactly one FINAL rule at the end."));
}
function updateSurgeRuleForm() {
  const type = $('#modal-body [data-local="type"]');
  if (!type || !$('#modal-body [data-surge-options]')) return;
  const option = $('#modal-body [data-local="options"]');
  const previous = option.value;
  const choices = surgeOptionChoices(type.value);
  option.innerHTML = selectOptions(choices, choices.includes(previous) ? previous : "");
  const value = $('#modal-body [data-local="value"]');
  value.disabled = type.value === "FINAL";
}
function editSurgeRule(path, index, compiled = false, selectedType) {
  const plan = currentClient().ruleSets;
  const rules = compiled ? plan.directRules : getPath(state.config, path);
  const original = index === null ? null : rules[index];
  const parts = splitRule(compiled ? original?.rule || "DOMAIN-SUFFIX,,Proxy" : original || "DOMAIN-SUFFIX,,Proxy");
  const type = parts[0].toUpperCase() === "MATCH" && compiled ? "FINAL" : parts[0].toUpperCase();
  const final = type === "FINAL";
  const optionStart = final ? 2 : compiled && ["no-resolve", "src", "extended-matching"].includes(parts[2]?.toLowerCase()) ? 2 : 3;
  const options = final && compiled ? compiledFinalOptions(parts) : parts.slice(optionStart);
  const form = { type: selectedType || type, value: final ? "" : parts[1] || "", policy: compiled ? original?.policy || "Proxy" : parts[final ? 1 : 2] || "Proxy", options: options.join(","), ...(compiled ? { enabled: original?.enabled ?? true } : {}) };
  if (selectedType && selectedType !== type && !surgeOptionChoices(selectedType).includes(form.options)) form.options = "";
  const hasFinal = rules.some((rule, i) => i !== index && isFinalRule(compiled ? rule.rule : rule));
  const legacyRuleSet = compiled && original && SURGE_RULE_SET_TYPES.includes(type);
  const direct = compiled && !legacyRuleSet;
  const types = direct ? SURGE_DIRECT_RULE_TYPES : legacyRuleSet ? SURGE_RULE_SET_TYPES : SURGE_RULE_TYPES;
  const choices = types.filter((entry) => entry !== "FINAL" || !hasFinal);
  const title = direct ? t("编辑 Surge 单条规则", "Edit Surge direct rule") : legacyRuleSet ? t("编辑 Surge 规则集引用", "Edit Surge rule-set reference") : t("编辑 Surge 规则", "Edit Surge rule");
  const help = direct ? t("一条规则填写一个匹配值。逻辑规则可填写括号表达式。FINAL 在末尾匹配剩余请求。", "Use one match value per rule or a parenthesized logical expression. FINAL matches remaining requests at the end.") : legacyRuleSet ? t("此条目是已有的规则集引用。新增规则集请使用“添加规则集”。", "This entry is an existing rule-set reference. Use Add rule set for new rule sets.") : t("一条规则填写一个匹配值；RULE-SET / DOMAIN-SET 填写地址。逻辑规则可填写括号表达式。FINAL 在末尾匹配剩余请求。", "Use one match value per rule, a URL for RULE-SET / DOMAIN-SET, or a parenthesized logical expression. FINAL matches remaining requests at the end.");
  modal(title, localField("type", form.type, { label: t("匹配类型", "Match type"), options: final ? ["FINAL"] : [...new Set([...choices, form.type])] }) + localField("value", form.value, { label: direct ? t("匹配值", "Match value") : legacyRuleSet ? t("规则集地址", "Rule-set URL") : t("匹配值 / 规则集地址", "Match value / Rule-set URL"), multiline: true }) + localField("policy", form.policy, { options: policyChoices(form.policy) }) + `<div data-surge-options>${localField("options", form.options, { label: t("附加选项", "Options"), options: [...new Set([...surgeOptionChoices(form.type), form.options])] })}</div>` + (compiled ? localField("enabled", form.enabled, { disabled: final }) : "") + `<p class="help">${help}</p>`, () => {
    const value = readLocal(form);
    if (final && (value.type !== "FINAL" || compiled && !value.enabled)) throw Error(t("兜底规则必须保留并启用", "The final rule must remain enabled"));
    if (direct && SURGE_RULE_SET_TYPES.includes(value.type)) throw Error(t("规则集请使用“添加规则集”。", "Use Add rule set for rule sets."));
    if (!value.value.trim() && value.type !== "FINAL") throw Error(t("请填写匹配值", "Enter a match value"));
    if (/[\r\n]/.test(value.value.trim())) throw Error(t("每条规则只能填写一个匹配值，请分别添加多条规则。", "Use one match value per rule; add separate rules for multiple values."));
    if (value.type === "FINAL" && hasFinal) throw Error(t("已有 FINAL 兜底规则。", "A FINAL rule already exists."));
    const line = [value.type, ...(value.type === "FINAL" ? [] : [value.value.trim()]), value.policy, ...value.options.split(",").filter(Boolean)].join(",");
    if (compiled) {
      const next = { ...(original || { id: crypto.randomUUID(), order: nextPlanOrder(plan) }), enabled: value.enabled, policy: value.policy, rule: line };
      if (index === null) appendPlanItem(plan, "direct", next); else rules[index] = next;
    } else {
      const next = [...rules];
      if (index === null) {
        const finalIndex = next.findIndex(isFinalRule);
        next.splice(value.type !== "FINAL" && finalIndex >= 0 ? finalIndex : next.length, 0, line);
      } else next[index] = line;
      validateSurgeFinal(next);
      setPath(state.config, path, next);
    }
    closeModal(); changed(); render();
  });
  $('#modal-body [data-local="value"]').disabled = form.type === "FINAL";
  if (final) $('#modal-body [data-local="type"]').disabled = true;
}
function editRule(path, index, forceJson = false, selectedType) {
  if (state.client === "surge" && !forceJson) { editSurgeRule(path, index, false, selectedType); return; }
  const rules = getPath(state.config, path);
  const native = state.client === "singbox";
  const original = index === null ? native ? { domain_suffix: [""], action: "route", outbound: "Proxy" } : "DOMAIN-SUFFIX,,Proxy" : rules[index];
  if (forceJson) {
    modal(t("编辑原生规则", "Edit native rule"), `<textarea id="rule-native" class="code code-editor" rows="12">${esc(native ? JSON.stringify(original, null, 2) : original)}</textarea>`, () => {
      const text = $("#rule-native").value;
      const value2 = native ? JSON.parse(text) : text;
      if (isFinalRule(original) && !isFinalRule(value2)) throw Error(t("不能修改兜底规则类型", "Cannot change the final rule type"));
      if (native && (!value2 || typeof value2 !== "object" || Array.isArray(value2))) throw Error(t("规则必须是对象", "A rule must be an object"));
      if (state.client === "surge") validateSurgeFinal(rules.map((rule, i) => i === index ? value2 : rule));
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
  const types = native ? Object.keys(RULE_FIELDS) : state.client === "surge" ? SURGE_RULE_TYPES : LEGACY_RULE_FIELDS;
  const choices = [...policyChoices(policy), ...native ? ["hijack-dns", "sniff", "reject"] : []];
  modal(t("编辑分流规则", "Edit routing rule"), localField("type", selectedType || type, { label: t("匹配类型", "Match type"), options: isFinalRule(original) ? [type] : types }) + localField("value", value, { label: t("匹配值（每行一项）", "Match values (one per line)"), multiline: true }) + localField("policy", policy, { options: [.../* @__PURE__ */ new Set([...choices, policy])] }) + `<p class="help">${t("高级匹配请使用原生文本编辑，原有附加字段会保留。", "Use native editing for advanced matching. Existing additional fields are preserved.")}</p>`, () => {
    const form = readLocal(originalForm);
    if (isFinalRule(original) && form.type !== type) throw Error(t("不能修改兜底规则类型", "Cannot change the final rule type"));
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
    if (index === null) { const finalIndex = rules.findIndex(isFinalRule); rules.splice(!native && !isFinalRule(next) && finalIndex >= 0 ? finalIndex : rules.length, 0, next); }
    else rules[index] = next;
    closeModal();
    changed();
    render();
  });
}
function ruleSetDownloadName(plan, urls) {
  const first = urls.split("\n").map((url) => url.trim()).find(Boolean);
  let base = "rules";
  if (first) {
    const url = new URL(first);
    const filename = url.pathname.split("/").filter(Boolean).at(-1) || url.hostname;
    let decoded = filename;
    try { decoded = decodeURIComponent(filename); } catch { /* Keep the encoded filename. */ }
    base = decoded.replace(/\.(?:ya?ml|list|txt|json|srs|mrs)$/i, "").replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "rules";
  }
  const names = new Set(plan.outputs.map((output) => output.name));
  let name = base;
  for (let suffix = 2; [name, `${name}-domain`, `${name}-ipcidr`, `${name}-dns`].some((value) => names.has(value)) || names.has(name.replace(/-(domain|ipcidr|dns)$/, "")); suffix += 1) name = `${base}-${suffix}`;
  return name;
}
function editOutput(index) {
  const plan = currentClient().ruleSets;
  const surge = state.client === "surge";
  const singbox = state.client === "singbox";
  const clash = state.client === "clash";
  const original = index === null ? { name: "", enabled: true, policy: "Proxy", sourceIds: [], inlineRules: [], order: nextPlanOrder(plan), surgeOptions: [] } : plan.outputs[index];
  const initialUrls = outputSourceUrls(original);
  const displayedUrls = state.invalid.get(`plan.${state.client}.output.${index}.sourceUrls`) ?? initialUrls;
  const domainSources = original.sourceIds.length > 0 && original.sourceIds.every((id) => ["surge-domain-set", "plain-domain"].includes(plan.sources.find((source) => source.id === id)?.format));
  const sourceFormats = [...new Set(original.sourceIds.map((id) => plan.sources.find((source) => source.id === id)?.format || "auto"))];
  const form = { ...original, dnsServer: original.dnsServer || "", sourceUrls: initialUrls, sourceFormat: sourceFormats.length > 1 ? "existing" : sourceFormats[0] || "auto", surgeType: original.surgeType || (domainSources ? "DOMAIN-SET" : "RULE-SET"), surgeOptions: original.surgeOptions.join(","), behavior: original.provider?.behavior || (index === null ? "classical" : "auto"), interval: original.provider?.interval ?? 86400 };
  const formats = [["auto", t("自动识别", "Automatic")], ["sing-box-binary", t("sing-box SRS（独立直连）", "sing-box SRS (direct download)")], ["surge-rule-set", "Surge RULE-SET"], ["surge-domain-set", "Surge DOMAIN-SET"], ["clash-yaml", "Clash YAML"], ["plain-domain", t("域名文本", "Domain text")], ["plain-ipcidr", t("IP-CIDR 文本", "IP-CIDR text")], ["plain-classical", t("规则文本（classical）", "Rule text (classical)")]].filter(([format]) => !clash || ["auto", "clash-yaml", "plain-domain", "plain-ipcidr", "plain-classical"].includes(format));
  if (form.sourceFormat === "existing") formats.unshift(["existing", t("保留各地址已有格式", "Keep each URL’s existing format")]);
  const simple = clash || singbox;
  const sourceSettings = singbox || clash ? `<div class="form-row"><label for="output-source-format">${t("来源格式", "Source format")}</label><select id="output-source-format" data-local="sourceFormat">${formats.map(([value, label]) => `<option value="${esc(value)}" ${value === form.sourceFormat ? "selected" : ""}>${esc(label)}</option>`).join("")}</select></div><p class="help">${singbox ? t("自动识别时，.srs 地址各自独立输出，由 sing-box 下载，不参与合并或转换；其他文本来源合并去重后转换。无 .srs 后缀的二进制地址请选择 SRS 格式。明确选择的格式适用于本行所有地址。", "Automatic mode outputs each .srs URL independently for sing-box to download; text sources are merged, deduplicated and converted. Choose SRS for binary URLs without a .srs extension. An explicit format applies to all URLs in this row.") : t("自动识别按下载内容判断格式并生成规则集，不依赖 URL 后缀。明确指定格式后，兼容的单个来源可由 Clash 直接下载；文本格式应与 behavior 一致。所选格式用于本行所有地址。", "Automatic mode detects downloaded content and generates a rule set without relying on URL extensions. An explicit format allows a single compatible source to be downloaded directly by Clash; text format must match behavior. The selected format applies to all URLs in this row.")}</p>` : "";
  const providerSettings = clash ? localField("behavior", form.behavior, { label: "behavior", options: [...(form.behavior === "auto" ? ["auto"] : []), "domain", "ipcidr", "classical"] }) + localField("interval", form.interval, { label: t("interval（秒）", "interval (seconds)") }) + `<p class="help">${t("多个 URL 由系统合并去重。interval 为客户端下载间隔；自动识别来源的更新由系统规则缓存刷新控制。", "Multiple URLs are merged and deduplicated. interval controls client downloads; automatic sources update through system rule-cache refreshes.")}</p>` : "";
  const dnsTags = singbox ? (currentClient().dns.servers || []).map((server) => server.tag).filter(Boolean) : [];
  const dnsSettings = localField("dnsServer", form.dnsServer, {
    label: t("DNS 解析服务器（留空继承全局）", "DNS resolver (empty inherits global settings)"),
    ...(singbox ? { options: [...new Set(["", ...dnsTags, form.dnsServer])] } : { placeholder: "223.5.5.5 / https://dns.example.com/dns-query" })
  }) + `<p class="help">${singbox ? t("在 DNS 页添加解析服务器后可在此选择。文本来源仅提取独立域名规则；SRS 直接引用原规则集，请使用适合 DNS 匹配的 SRS。按本页顺序匹配，优先于 DNS 页规则。", "Add resolvers on the DNS tab, then select one here. Text sources contribute standalone domain rules; SRS sets are referenced as provided and must be suitable for DNS matching. Entries match in routing order, before DNS-tab rules.") : surge ? t("仅作用于规则集内的域名；已有 Host 映射优先。需要 Surge Mac 5.10+ / iOS 5.14.3+。代理请求的远端解析不受此设置保证。", "Applies to domains in the set; existing Host mappings take priority. Requires Surge Mac 5.10+ / iOS 5.14.3+. Remote resolution by a proxy is not guaranteed to use this resolver.") : t("Clash 指 Clash Verge 的 Mihomo 内核。需要启用 DNS；只对域名匹配生效，纯 IP 规则集不可指定。", "Clash means Clash Verge with the Mihomo core. DNS must be enabled; only domain matches apply, and IP-only sets cannot specify a resolver.")}</p>`;
  const advancedSettings = simple ? `<details><summary>${t("规则集其他设置", "Other rule-set settings")}</summary>${localField("enabled", form.enabled, { label: t("启用此规则集", "Enable this rule set") })}${clash ? localField("surgeOptions", form.surgeOptions, { label: t("解析 IP 前不查询 DNS", "Do not resolve IP matches"), options: ["", "no-resolve"] }) : ""}</details>` : "";
  const intro = surge ? t("选择规则集类型并填写下载地址。多个地址合并去重，共用一个出口策略。RULE-SET 包含规则类型和匹配值；DOMAIN-SET 每行填写域名，以点开头表示包含子域名。", "Choose the set type and enter download URLs. Multiple URLs are merged and deduplicated under one outbound policy. RULE-SET contains typed rules; DOMAIN-SET lists domains, with a leading dot to include subdomains.") : singbox ? t("填写规则下载地址并选择出口策略。SRS 各自独立输出；文本来源合并去重，使用同一个出口策略。", "Enter rule download URLs and choose an outbound policy. Each SRS is output independently; text sources are merged and deduplicated under the same policy.") : t("填写规则下载地址并选择出口策略。多个地址的规则合并去重，使用同一个出口策略。", "Enter rule download URLs and choose an outbound policy. Rules from multiple URLs are merged and deduplicated under one outbound policy.");
  const surgeSettings = surge ? localField("surgeType", form.surgeType, { label: t("规则集类型", "Rule-set type"), options: SURGE_RULE_SET_TYPES }) : "";
  const legacyInline = form.inlineRules.length ? `<p class="help">${t(`保留已有的 ${form.inlineRules.length} 条手填规则。新增独立规则请使用“添加单条规则”。`, `The ${form.inlineRules.length} existing manual rules are retained. Use Add direct rule for new individual rules.`)}</p>` : "";
  const title = surge ? t("编辑 Surge 规则集", "Edit Surge rule set") : clash ? t("编辑 Clash 规则集", "Edit Clash rule set") : t("编辑 sing-box 规则集", "Edit sing-box rule set");
  modal(title, `<p class="help">${intro}</p>` + surgeSettings + sourceSettings + localField("sourceUrls", displayedUrls, { label: t("规则下载地址（每行一个）", "Rule download URLs (one per line)"), multiline: true, rows: 5 }) + providerSettings + legacyInline + dnsSettings + (clash ? clashRouting.policyField(form.policy) : localField("policy", form.policy, { label: t("出口策略（作用于全部规则）", "Outbound policy (for all rules)"), options: policyChoices(form.policy) })) + (surge ? localField("surgeOptions", form.surgeOptions, { options: [...new Set([...surgeOptionChoices(form.surgeType), form.surgeOptions])] }) : "") + (simple ? "" : localField("enabled", form.enabled, { label: t("启用此规则集", "Enable this rule set") })) + advancedSettings, () => {
    const value = readLocal(form);
    value.dnsServer = value.dnsServer.trim();
    if (singbox && value.dnsServer && !dnsTags.includes(value.dnsServer)) throw Error(t("DNS 服务器不存在，请重新选择。", "DNS server is missing; choose another server."));
    if (clash && value.dnsServer && (value.behavior === "ipcidr" || !currentClient().dnsEnabled)) throw Error(t("指定 DNS 需要启用 Clash DNS，且 behavior 不能为 ipcidr。", "Enable Clash DNS and use domain or classical behavior to assign a resolver."));
    if (clash) value.policy = clashRouting.checkPolicy(value.policy);
    if (!value.sourceUrls.trim() && !value.inlineRules.length) throw Error(t("请填写规则下载地址。", "Enter a rule download URL."));
    const linked = value.sourceUrls === initialUrls ? null : sourcesForUrls(plan, value.sourceUrls, original.sourceIds);
    const next = { ...original, dnsServer: value.dnsServer, name: original.name || ruleSetDownloadName(plan, value.sourceUrls), policy: value.policy, enabled: value.enabled, inlineRules: value.inlineRules, surgeOptions: value.surgeOptions.split(",").filter(Boolean), sourceIds: linked ? linked.ids : original.sourceIds };
    if (surge) {
      if (!SURGE_RULE_SET_TYPES.includes(value.surgeType)) throw Error(t("请选择 RULE-SET 或 DOMAIN-SET。", "Choose RULE-SET or DOMAIN-SET."));
      if (!surgeOptionChoices(value.surgeType).includes(value.surgeOptions)) throw Error(t("附加选项与规则集类型不兼容，请重新选择。", "Select options compatible with the rule-set type."));
      next.surgeType = value.surgeType;
    }
    if (clash) {
      if (!Number.isSafeInteger(value.interval) || value.interval <= 0) throw Error(t("interval 必须为正整数秒数。", "interval must be a positive integer in seconds."));
      if (value.behavior === "auto") {
        if (original.provider || value.interval !== 86400) throw Error(t("请先选择 domain、ipcidr 或 classical。", "Choose domain, ipcidr or classical first."));
      } else {
        if (!["domain", "ipcidr", "classical"].includes(value.behavior)) throw Error(t("behavior 无效。", "Invalid behavior."));
        next.provider = { behavior: value.behavior, interval: value.interval };
      }
    }
    const sources = linked ? linked.sources : structuredClone(plan.sources);
    if (singbox || clash) {
      if (!formats.some(([format]) => format === value.sourceFormat)) throw Error(t("来源格式无效", "Invalid source format"));
      if (value.sourceFormat !== "existing") {
        const sharedIds = new Set(plan.outputs.filter((_, i) => i !== index).flatMap((output) => output.sourceIds));
        next.sourceIds = next.sourceIds.map((id) => {
          const source = sources.find((item) => item.id === id);
          if (!source || source.format === value.sourceFormat) return id;
          if (!sharedIds.has(id)) { source.format = value.sourceFormat; return id; }
          const copy = { ...source, id: crypto.randomUUID(), format: value.sourceFormat, order: Math.max(-1, ...sources.map((item) => item.order)) + 1 };
          sources.push(copy);
          return copy.id;
        });
      }
    }
    plan.sources = sources;
    state.invalid.delete(`plan.${state.client}.output.${index}.sourceUrls`);
    if (index === null) appendPlanItem(plan, "output", next); else plan.outputs[index] = next;
    pruneUnusedRuleSources(plan);
    closeModal(); changed(); render();
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
  const actionsError = validateActionsCompilationSettings(state.config.settings.actionsCompilation, state.lang);
  if (actionsError) throw Error(actionsError);
  state.busy = true;
  updateStatus();
  try {
    const sent = structuredClone(state.config);
    const saved = await api("/api/config", { method: "PUT", body: JSON.stringify(sent) });
    if (JSON.stringify(state.config) === JSON.stringify(sent)) state.config = saved;
    state.saved = JSON.stringify(saved);
    toast(t("配置已保存", "Configuration saved"));
    render();
  } catch (error) {
    if (error.issues?.length) modal(t("分流规则尚未保存", "Routing rules not saved"), `<p>${esc(error.message)}</p><ul>${error.issues.map((issue) => `<li>${esc(typeof issue === "string" ? issue : `${issue.outputName}: ${issue.reason}`)}</li>`).join("")}</ul>`, null);
    else throw error;
  } finally {
    state.busy = false;
    updateStatus();
  }
}
function renderSubscriptionCheck() {
  if (!subscriptionCheck) return "";
  const { client, result, checkedAt, error } = subscriptionCheck;
  if (!result && !error) return `<p role="status">${t("正在检查", "Checking")} ${esc(CLIENTS[client].label)}…</p>`;
  const items = result?.diagnostics || [];
  const retryAfter = Number(result?.retryAfterSeconds) || 0;
  const log = [
    `${t("客户端", "Client")}: ${CLIENTS[client].label}`,
    `${t("检查时间", "Checked at")}: ${formatDate(checkedAt)}`,
    `${t("结果", "Result")}: ${error ? t("检查未完成", "Check incomplete") : result.canDownload ? t("通过，已保存配置可生成订阅", "PASS — the saved configuration can generate a subscription") : retryAfter > 0 ? t("规则缓存暂未就绪，订阅请求将返回 HTTP 503", "Rules are not ready; subscription requests will return HTTP 503") : t("阻断，订阅请求将返回 HTTP 422", "BLOCKED — subscription requests will return HTTP 422")}`,
    ...(!error && retryAfter > 0 ? [t(`请在 ${retryAfter} 秒后重新检查或更新订阅。`, `Check again or update the subscription in ${retryAfter} seconds.`)] : []),
    "",
    ...(error ? [`[ERROR] ${error}`] : items.map((item) => `[${item.severity.toUpperCase()}] ${item.path} (${item.code}): ${item.message}`)),
    ...(!error && !items.length ? [t("无校验问题。", "No validation issues.")] : [])
  ].join("\n");
  return `<div class="section-heading"><h3>${t("订阅检查日志", "Subscription check log")}</h3>${btn(t("复制日志", "Copy log"), "copy-check-log")}</div><textarea id="subscription-check-log" class="code" rows="${Math.min(18, Math.max(8, log.split("\n").length + 1))}" readonly spellcheck="false" aria-label="${t("订阅检查日志", "Subscription check log")}">${esc(log)}</textarea>`;
}
function updateSubscriptionCheck() {
  const container = $("#subscription-check-result");
  if (container) container.innerHTML = renderSubscriptionCheck();
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
  if (!state.migrationData) throw Error(t("请刷新页面后重新检查升级。", "Reload the page and review the upgrade again."));
  if (state.invalid.size) throw Error(t("请先修正格式无效的输入。", "Correct invalid inputs first."));
  modal(t("确认配置升级", "Confirm configuration upgrade"), `<p>${t("升级旧版配置格式，保留 Surge 与 Clash 各自的设置。sing-box 使用独立的原生默认配置，DNS、策略组、分流规则和 Tailscale 均在 sing-box 中单独设置。新配置写入并验证成功后，旧版配置将进入延迟清理。", "Upgrade the legacy configuration format while preserving the separate Surge and Clash settings. sing-box starts with independent native defaults; configure its DNS, groups, routing rules and Tailscale separately. Old configuration is scheduled for cleanup after the new configuration is written and verified.")}</p>`, async () => {
    const config = await api("/api/config/migration", { method: "POST", body: JSON.stringify({ config: state.config, fingerprint: state.migrationData.fingerprint }) });
    state.config = config;
    state.saved = JSON.stringify(config);
    state.migration = false;
    closeModal();
    render();
    toast(t("配置升级已完成", "Configuration upgrade completed"));
    await checkActionsUpgrade();
  }, t("确认升级", "Confirm upgrade"));
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
  renderSidebarVersion();
  if (state.page === "status") render();
}
async function action(button) {
  if (["client", "section", "add-rule", "edit-rule", "add-direct", "edit-direct", "add-output", "edit-output", "add-group", "edit-group", "add-tailscale", "edit-tailscale", "edit-singbox-section"].includes(button.dataset.action)) await loadSharedProxyNames().catch((error) => toast(error.message));
  if (button.dataset.action.startsWith("clash-")) {
    if (["clash-add-direct", "clash-edit-direct"].includes(button.dataset.action)) await loadSharedProxyNames().catch((error) => toast(error.message));
    await clashRouting.action(button);
    return;
  }
  if (button.dataset.action === "edit-sb-dns") { await editSingboxDns(button.dataset.kind, button.dataset.index === undefined ? null : Number(button.dataset.index)); return; }
  if (button.dataset.action === "delete-sb-dns") {
    const { kind, index } = button.dataset, dns = currentClient().dns;
    if (kind === "servers") {
      const tag = dns.servers[Number(index)]?.tag;
      const environmentReferenced = (rules) => Array.isArray(rules) && rules.some((rule) => rule && typeof rule === "object" && (["dns_server_address", "dns_search_domain"].some((key) => rule[key] && typeof rule[key] === "object" && Object.hasOwn(rule[key], tag)) || environmentReferenced(rule.rules)));
      const referenced = (value) => value && typeof value === "object" && Object.entries(value).some(([key, item]) => (["server", "final", "domain_resolver", "default_domain_resolver"].includes(key) && item === tag) || (key === "preferred_by" && (item === tag || Array.isArray(item) && item.includes(tag))) || referenced(item));
      if (tag && (environmentReferenced(dns.rules) || environmentReferenced(currentClient().route.rules) || referenced({ ...currentClient(), dns: { ...dns, servers: dns.servers.filter((_, i) => i !== Number(index)) } }))) throw Error(t("此 DNS 服务器仍被引用，请先修改默认解析或关联设置。", "This DNS server is referenced. Update the default resolver or related settings first."));
    }
    confirmDelete(t("删除此 DNS 配置？", "Delete this DNS entry?"), () => dns[kind].splice(Number(index), 1)); return;
  }
  if (button.dataset.action === "move-sb-dns") { const rules = currentClient().dns.rules, index = Number(button.dataset.index), other = index + Number(button.dataset.direction); if (other >= 0 && other < rules.length) { [rules[index], rules[other]] = [rules[other], rules[index]]; changed(); render(); } return; }
  if (button.dataset.action === "edit-singbox-inbound") { await editSingboxSection("inbounds", button.dataset.index === undefined ? null : Number(button.dataset.index)); return; }
  if (button.dataset.action === "delete-singbox-inbound") { const index = Number(button.dataset.index); confirmDelete(t("删除此入站？", "Delete this inbound?"), () => currentClient().inbounds.splice(index, 1)); return; }
  if (button.dataset.action === "edit-singbox-section") { await editSingboxSection(button.dataset.key, undefined, button.dataset.endpointType, button.dataset.routeGroup); return; }
  if (button.dataset.action === "remove-singbox-section") {
    confirmDelete(t("恢复默认会移除此分类的配置；已有引用需要手动调整。", "Restoring defaults removes this section; update any references manually."), () => { delete currentClient()[button.dataset.key]; }); return;
  }
  const { action: name, path, kind } = button.dataset;
  const index = button.dataset.index === void 0 ? null : Number(button.dataset.index);
  if (name === "check-subscription") {
    if (state.busy) return;
    if (dirty() || state.invalid.size) throw Error(t("请先保存配置，再检查订阅。", "Save your changes before checking the subscription."));
    const client = button.dataset.client;
    subscriptionCheck = { client, result: null, checkedAt: Date.now(), error: "" };
    updateSubscriptionCheck();
    state.busy = true;
    updateStatus();
    const title = button.textContent;
    button.disabled = true;
    button.textContent = t("检查中…", "Checking…");
    try {
      const result = await api(`/api/config/check?target=${encodeURIComponent(CLIENTS[client].target)}`, { method: "POST" });
      subscriptionCheck = { client, result, checkedAt: Date.now(), error: "" };
    } catch (error) {
      subscriptionCheck = { client, result: null, checkedAt: Date.now(), error: error.message };
    } finally {
      updateSubscriptionCheck();
      state.busy = false;
      button.disabled = false;
      button.textContent = title;
      updateStatus();
    }
    return;
  }
  if (name === "upload-mmdb") { await uploadMmdb(); return; }
  if (name === "refresh-mmdb") { await loadMmdbStatus(); return; }
  if (name === "add-direct" || name === "edit-direct") { editDirect(index); return; }
  if (name === "delete-direct") { if (isFinalRule(currentClient().ruleSets.directRules[index]?.rule)) return; state.config.clients[state.client].ruleSets.directRules.splice(index, 1); changed(); render(); return; }
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
  if (name === "actions-force-retry") {
    if (modal.retryingActions) return;
    modal.retryingActions = true;
    const buttons = [...$("#modal").querySelectorAll("button")];
    buttons.forEach((button) => { button.disabled = true; });
    try {
      await api("/api/actions-compilation/retry", { method: "POST", body: JSON.stringify({ name: button.dataset.output, target: button.dataset.target }) });
      toast(t("重试请求已处理，正在更新状态…", "Retry request processed. Updating status…"));
    } finally {
      modal.retryingActions = false;
      buttons.forEach((button) => { button.disabled = false; });
    }
    await showActionsProgress();
    return;
  }
  if (name === "actions-progress") {
    await showActionsProgress();
    return;
  }
  if (name === "actions-setup") {
    await showActionsSetup();
    return;
  }
  if (name === "modal-save") {
    await modal.save?.();
    return;
  }
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
    if (group === "Proxy") throw Error(t("Proxy 不能删除", "Proxy cannot be deleted"));
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
    if (isFinalRule(getPath(state.config, path)[index])) return;
    getPath(state.config, path).splice(index, 1);
    changed();
    render();
    return;
  }
  if (name === "move-rule") {
    const rules = getPath(state.config, path), other = index + Number(button.dataset.direction);
    if (isFinalRule(rules[index]) || isFinalRule(rules[other])) return;
    if (other >= 0 && other < rules.length) [rules[index], rules[other]] = [rules[other], rules[index]];
    changed();
    render();
    return;
  }
  if (name === "add-tailscale" || name === "edit-tailscale") { editTailscale(index); return; }
  if (name === "delete-tailscale") {
    confirmDelete(t("删除此 Tailscale 节点？已有策略和规则引用需要手动调整。", "Delete this Tailscale node? Update existing policy and rule references manually."), () => tailscaleCollection().splice(index, 1));
    return;
  }
  if (name === "move-plan") {
    const entries = orderedPlan(currentClient().ruleSets);
    const position = Number(button.dataset.position), other = position + Number(button.dataset.direction);
    if (other < 0 || other >= entries.length || isFinalEntry(entries[position]) || isFinalEntry(entries[other])) return;
    [entries[position], entries[other]] = [entries[other], entries[position]];
    entries.forEach(({ item }, order) => item.order = order);
    changed(); render(); return;
  }
  if (name === "enable-singbox-rule-plan" && state.client === "singbox") {
    currentClient().ruleSets.mode = "compiled";
    changed(); render(); return;
  }
  if (name === "add-output" || name === "edit-output") {
    editOutput(index);
    return;
  }
  if (name === "delete-output") {
    state.config.clients[state.client].ruleSets.outputs.splice(index, 1);
    pruneUnusedRuleSources(currentClient().ruleSets);
    const prefix = `plan.${state.client}.output.`;
    for (const [key, value] of [...state.invalid]) {
      if (!key.startsWith(prefix)) continue;
      const entryIndex = Number(key.slice(prefix.length).split(".")[0]);
      if (entryIndex >= index) state.invalid.delete(key);
      if (entryIndex > index) state.invalid.set(`${prefix}${entryIndex - 1}.sourceUrls`, value);
    }
    changed();
    render();
    return;
  }
  if (name === "copy-link") {
    await navigator.clipboard.writeText(button.dataset.url);
    toast(t("已复制链接", "Link copied"));
    return;
  }
  if (name === "copy-check-log") {
    const log = $("#subscription-check-log");
    try {
      await navigator.clipboard.writeText(log.value);
      toast(t("日志已复制", "Log copied"));
    } catch {
      log.focus();
      log.select();
      toast(t("无法自动复制，已选中日志，请手动复制。", "Automatic copy failed. The log is selected; copy it manually."));
    }
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
  if (name === "telegram-bind") {
    if (dirty()) {
      toast(t("请先保存通知设置", "Save notification settings first"));
      return;
    }
    showMessage(t("Telegram 绑定码", "Telegram binding code"), await api("/api/telegram/bind-code", { method: "POST" }));
    return;
  }
  if (name === "telegram-unbind") {
    const unbind = async () => {
      if (state.busy) return;
      state.busy = true;
      updateStatus();
      const chatId = state.config.settings.notificationTelegramChatId;
      try {
        const saved = await api("/api/telegram/unbind", { method: "POST" });
        if (state.config.settings.notificationTelegramChatId === chatId) {
          state.config.settings.notificationTelegramChatId = saved.settings.notificationTelegramChatId;
        }
        state.config.updatedAt = saved.updatedAt;
        if (state.saved) {
          const previous = JSON.parse(state.saved);
          previous.settings.notificationTelegramChatId = saved.settings.notificationTelegramChatId;
          previous.updatedAt = saved.updatedAt;
          state.saved = JSON.stringify(previous);
        }
        if (modal.save === unbind) closeModal();
        render();
        toast(t("Telegram 已解除绑定", "Telegram unbound"));
      } finally {
        state.busy = false;
        updateStatus();
      }
    };
    modal(t("解除绑定", "Unbind Telegram"), `<p>${t("确认解除当前 Telegram 绑定？", "Unbind the current Telegram chat?")}</p>`, unbind);
    return;
  }
}
function showMessage(title, data) {
  modal(title, `<pre class="preview-code">${esc(JSON.stringify(data, null, 2))}</pre>`, null);
}
document.addEventListener("toggle", (event) => {
  const help = event.target.closest?.(".settings-help");
  if (help) positionHelpTip(help);
}, true);
window.addEventListener("resize", () => {
  for (const help of document.querySelectorAll(".settings-help[open]")) positionHelpTip(help);
});
for (const area of [$("#content"), $("#modal-body")]) {
  area.addEventListener("scroll", () => {
    for (const help of document.querySelectorAll(".settings-help[open]")) help.open = false;
  });
}
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  for (const help of document.querySelectorAll(".settings-help[open]")) {
    const restoreFocus = help.contains(document.activeElement);
    help.open = false;
    if (restoreFocus) $("summary", help).focus();
  }
});
document.addEventListener("click", (event) => {
  for (const help of document.querySelectorAll(".settings-help[open]")) {
    if (!help.contains(event.target)) help.open = false;
  }
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
    if (path.startsWith("settings.actionsCompilation.") && !isObject(state.config.settings.actionsCompilation)) {
      state.config.settings.actionsCompilation = { enabled: false, repository: "", ref: "main" };
    }
    setPath(state.config, path, value);
    state.invalid.delete(path);
    input.removeAttribute("aria-invalid");
    changed();
    if (["settings.actionsCompilation.enabled", "settings.notificationTelegramBotToken"].includes(path)) updateSystemSettingsVisibility();
  } catch {
    state.invalid.set(path, input.value);
    input.setAttribute("aria-invalid", "true");
    updateStatus();
  }
});
document.addEventListener("change", (event) => {
  const inline = event.target;
  if (inline.dataset.clashField) {
    try { clashRouting.change(inline); } catch (error) { toast(error.message); render(); }
    return;
  }
  if (inline.dataset.tsField) { updateTailscaleForm($("#modal-body")); return; }
  if (inline.dataset.local === "surgeType") {
    const options = $('#modal-body [data-local="surgeOptions"]');
    const choices = surgeOptionChoices(inline.value);
    options.innerHTML = selectOptions(choices, choices.includes(options.value) ? options.value : "");
    return;
  }
  if (inline.dataset.local === "type" && $('#modal-body [data-surge-options]')) { updateSurgeRuleForm(); return; }
  if (inline.dataset.planField) {
    const { planField, planKind, index } = inline.dataset;
    const plan = currentClient().ruleSets;
    const item = plan[planKind === "output" ? "outputs" : "directRules"][Number(index)];
    if (planKind === "direct" && isFinalRule(item.rule) && planField === "enabled") { inline.checked = true; return; }
    const invalidKey = `plan.${state.client}.${planKind}.${index}.${planField}`;
    try {
      if (planField === "sourceUrls") {
        const linked = sourcesForUrls(plan, inline.value, item.sourceIds);
        plan.sources = linked.sources; item.sourceIds = linked.ids;
        pruneUnusedRuleSources(plan);
      } else item[planField] = planField === "enabled" ? inline.checked : planField === "surgeOptions" ? inline.value.split(",").filter(Boolean) : inline.value;
      state.invalid.delete(invalidKey); inline.removeAttribute("aria-invalid"); changed();
    } catch (error) {
      state.invalid.set(invalidKey, inline.value); inline.setAttribute("aria-invalid", "true"); updateStatus(); toast(error.message);
    }
    return;
  }
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

$("#modal").addEventListener("close", () => {
  clearInterval(modal.autoCloseTimer);
  for (const input of document.querySelectorAll("#actions-setup-token")) input.value = "";
});
$("#modal").addEventListener("cancel", destroyModalEditors);
$("#close-modal").addEventListener("click", closeModal);
$("#modal").addEventListener("cancel", (event) => { if (modal.generatingCa || modal.installingActions || modal.retryingActions || modal.skippingActionsUpgrade || modal.actionsUpgradeRequired) event.preventDefault(); });
$("#menu").addEventListener("click", () => document.body.classList.toggle("menu-open"));
$("#language").addEventListener("click", () => {
  state.lang = state.lang === "zh" ? "en" : "zh";
  localStorage.setItem("subpilot-language", state.lang);
  render();
});
$("#logout").addEventListener("click", () => {
  const logout = async () => {
    await api("/api/logout", { method: "POST" });
    location.reload();
  };
  if (dirty()) modal(t("退出登录", "Sign out"), `<p>${t("未保存的更改将丢失。", "Unsaved changes will be lost.")}</p>`, logout, t("退出", "Sign out"));
  else logout().catch((error) => toast(error.message));
});
function navigationPage() {
  let page = location.hash.slice(1);
  if (page === "rule-sources") {
    page = "clients";
    state.section = "rules";
    history.replaceState(null, "", "#clients");
  }
  return NAV.some((item) => item[0] === page) ? page : "status";
}
window.addEventListener("hashchange", async () => {
  state.page = navigationPage();
  document.body.classList.remove("menu-open");
  if (["clients", "groups"].includes(state.page)) await loadSharedProxyNames().catch((error) => toast(error.message));
  render();
  $("#content").scrollTo(0, 0);
  if (state.page === "system") loadMmdbStatus();
});
window.addEventListener("beforeunload", (event) => {
  if (dirty() || state.invalid.size || mmdb.uploading || modal.generatingCa || modal.installingActions || modal.skippingActionsUpgrade) {
    event.preventDefault();
    event.returnValue = "";
  }
});
async function load() {
  let config = await api("/api/config");
  const ruleNamesPendingSave = Boolean(config.ruleNamesPendingSave);
  delete config.ruleNamesPendingSave;
  state.migration = Boolean(config.migrationRequired);
  delete config.migrationRequired;
  if (state.migration) {
    const migration = await api("/api/config/migration");
    state.migration = migration.required;
    state.migrationData = { fingerprint: migration.fingerprint };
    config = migration.config;
  }
  state.config = config;
  state.saved = ruleNamesPendingSave ? "" : JSON.stringify(config);
  await loadSharedProxyNames().catch((error) => toast(error.message));
  state.page = navigationPage();
  render();
  await checkActionsUpgrade();
  await Promise.all([refreshStatus(), state.page === "system" ? loadMmdbStatus() : Promise.resolve()]);
}
load().catch((error) => {
  $("#content").innerHTML = `<div class="notice warning">${esc(error.message)}</div>`;
});
