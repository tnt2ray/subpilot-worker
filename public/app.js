import { CLIENTS, NAV, LABELS, CLIENT_SECTIONS, RULE_FIELDS, LEGACY_RULE_FIELDS, getPath, setPath, splitRule } from "./app-model.js";
const $ = (selector, root = document) => root.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const state = { config: null, saved: "", page: "status", client: "surge", section: "network", lang: localStorage.getItem("subpilot-language") || "zh", results: {}, invalid: /* @__PURE__ */ new Map(), busy: false, migration: false, migrationData: null, backupDownloaded: false, stats: null, system: null, surgeProfile: "stable" };
const t = (zh, en) => state.lang === "zh" ? zh : en;
const label = (key) => state.lang === "zh" ? LABELS[key] || key : key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
const paths = { grid: "M3 3h6v6H3zm12 0h6v6h-6zM3 15h6v6H3zm12 0h6v6h-6z", source: "M6 3h8l4 4v14H6zM14 3v5h4M9 12h6m-6 4h6", nodes: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M3 12h18M12 3c-5 5-5 13 0 18 5-5 5-13 0-18", settings: "m9 3-1 3-3 1v4l-2 1 2 2v4l3 1 1 2h6l1-2 3-1v-4l2-2-2-1V7l-3-1-1-3zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0", code: "m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18", link: "m10 14 4-4M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 10 5-5a4 4 0 0 0-6-6l-2 2", edit: "m4 15 11-11 5 5-11 11H4zM13 6l5 5", trash: "M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7", up: "m6 15 6-6 6 6", down: "m6 9 6 6 6-6", copy: "M8 8h13v13H8zM16 8V3H3v13h5", plus: "M12 4v16M4 12h16" };
const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.settings}"/></svg>`;
const btn = (text, action2, attrs = "", className = "") => `<button type="button" data-action="${action2}" class="${className}" ${attrs}>${text}</button>`;
const smallButton = (name, action2, attrs = "", title = "") => btn(icon(name), action2, `${attrs} aria-label="${esc(title || name)}" title="${esc(title || name)}"`, "icon-button");
const target = () => CLIENTS[state.client].target;
const basePath = () => `clients.${state.client}`;
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
  $("#preview").disabled = state.busy || invalid > 0;
  $("#save").textContent = t("保存配置", "Save configuration");
  $("#preview").textContent = t("预览输出", "Preview output");
  const result = state.results[state.client];
  const blockers = result?.diagnostics?.filter((item) => item.severity === "error").length || 0;
  if (blockers) $("#save-status").textContent += t(` · ${blockers} 项阻断输出`, ` · ${blockers} output blockers`);
  $("#download").hidden = !["clients", "output"].includes(state.page);
  $("#download").disabled = state.busy || !result?.canDownload;
  $("#download").textContent = t("下载配置", "Download configuration");
}
function changed() {
  state.results = {};
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
  else if (Array.isArray(value) && !["tailscaleNodes", "inbounds", "directRules", "servers", "rule_set", "outputs"].includes(key) && value.every((item) => typeof item === "string")) control = `<textarea ${common} data-kind="lines" rows="${Math.min(8, Math.max(3, value.length))}" spellcheck="false">${esc(value.join("\n"))}</textarea><div class="help">${t("每行一项", "One item per line")}</div>`;
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
function surgePreviewControls() {
  if (state.client !== "surge") return "";
  return `<div class="form-row"><label for="surge-profile">${t("Surge 兼容档位", "Surge compatibility profile")}</label><div class="field"><select id="surge-profile"><option value="stable" ${state.surgeProfile === "stable" ? "selected" : ""}>${t("正式版 · stable", "Stable · stable")}</option><option value="tf" ${state.surgeProfile === "tf" ? "selected" : ""}>TestFlight / Beta · tf</option></select><div class="help">${t("预览与下载按所选档位输出，并保留订阅地址中的 /surge/stable/ 或 /surge/tf/。未带 Tag 的 Surge 订阅使用正式版档位；兼容版本见生成结果。", "Preview and download use the selected profile and retain /surge/stable/ or /surge/tf/ in the subscription URL. Untagged Surge subscriptions use stable; compatible versions appear in the generated result.")}</div></div></div>`;
}
function surgeClientSummary(profile) {
  if (!profile) return "";
  const baseline = (client) => client.version ? `${client.version}+` : `build ${client.build}+`;
  return `${profile.tag === "stable" ? t("正式版", "Stable") : "TestFlight / Beta"} · iOS ${baseline(profile.ios)} · macOS ${baseline(profile.mac)}`;
}
function render() {
  if (!state.config) return;
  document.documentElement.lang = state.lang === "zh" ? "zh-CN" : "en";
  $("#navigation").innerHTML = NAV.map(([id, zh, en, img]) => `<a href="#${id}" class="${state.page === id ? "active" : ""}" ${state.page === id ? 'aria-current="page"' : ""}>${icon(img)}${state.lang === "zh" ? zh : en}</a>`).join("");
  const page = NAV.find((item) => item[0] === state.page) || NAV[0];
  $("#page-title").textContent = state.lang === "zh" ? page[1] : page[2];
  $("#header-actions").innerHTML = state.page === "clients" || state.page === "output" ? `${state.client === "singbox" ? '<span class="muted small">sing-box 1.14.0</span>' : ""}${btn(t("适配详情", "Diagnostics"), "diagnostics")}` : btn(t("导出配置", "Export configuration"), "export");
  $("#language").textContent = state.lang === "zh" ? "中文 / EN" : "EN / 中文";
  $("#logout").textContent = t("退出登录", "Sign out");
  $("#migration-banner").hidden = !state.migration;
  $("#migration-banner").innerHTML = state.migration ? `<div class="notice warning"><h2>${t("配置升级待确认", "Configuration migration required")}</h2><p>${t("Surge 与 mihomo 保留原设置，sing-box 从 Surge 转换。下载旧配置后，确认迁移以移除 Stash 和 Shadowrocket。", "Surge and mihomo retain their settings. sing-box is converted from Surge. Export the old configuration before confirming removal of Stash and Shadowrocket.")}</p><div class="toolbar">${btn(t("下载旧配置", "Export old configuration"), "export")}${btn(t("查看并确认迁移", "Review migration"), "migration")}</div></div>` : "";
  const views = { status: renderStatus, sources: () => renderEntities("sources"), nodes: () => renderEntities("nodes"), groups: renderGroups, clients: renderClient, "rule-sources": () => renderEntities("rule-sources"), output: renderOutput, links: renderLinks, system: renderSystem };
  $("#content").innerHTML = (views[state.page] || renderStatus)();
  updateStatus();
}
function renderStatus() {
  const stats = state.stats;
  return section(t("运行状态", "Service status"), `<div class="status-row"><span>${t("项目版本", "Application version")}</span><strong class="value">${esc(state.system?.app?.version || "2.0.0")}</strong></div><div class="status-row"><span>${t("启用订阅源", "Enabled sources")}</span><span>${state.config.sources.filter((s) => s.enabled).length} / ${state.config.sources.length}</span></div>${Object.entries(CLIENTS).map(([id, client]) => `<div class="status-row"><span>${client.label} · ${t("最近获取", "Last fetched")}</span><span class="muted value">${formatDate(stats?.lastFetched?.[client.target])}</span></div>`).join("")}<div class="toolbar">${btn(t("刷新数据", "Refresh status"), "refresh-status")}${btn(t("刷新订阅缓存", "Refresh subscriptions"), "refresh-sources")}${btn(t("检查更新", "Check updates"), "check-update")}</div>`) + section(t("最近订阅请求", "Recent subscription requests"), stats?.recentUserAgents?.length ? `<div class="table-wrap"><table><thead><tr><th>${t("客户端", "Client")}</th><th>User-Agent</th><th>${t("位置", "Location")}</th><th>${t("时间", "Time")}</th></tr></thead><tbody>${stats.recentUserAgents.slice(0, 30).map((row) => `<tr><td>${esc(row.target)}</td><td class="truncate">${esc(row.userAgent)}</td><td>${esc(row.location?.label || "—")}</td><td>${formatDate(row.fetchedAt)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="empty">${t("尚无订阅请求", "No subscription requests yet")}</p>`) + section(t("订阅缓存", "Subscription cache"), `<pre class="preview-code">${esc(JSON.stringify(stats?.sourceCache || {}, null, 2))}</pre>`);
}
function formatDate(value) {
  if (!value) return "—";
  try {
    return new Intl.DateTimeFormat(state.lang === "zh" ? "zh-CN" : "en", { dateStyle: "short", timeStyle: "medium", timeZone: state.config.settings.displayTimeZone }).format(new Date(value));
  } catch {
    return esc(value);
  }
}
function collection(kind) {
  return state.config[kind === "nodes" ? "proxyNodes" : kind === "rule-sources" ? "ruleSources" : "sources"];
}
function renderEntities(kind) {
  const items = collection(kind);
  const isNode = kind === "nodes";
  return `<p class="muted">${t("共享资源供 Surge、mihomo 和 sing-box 使用。", "Shared by Surge, mihomo and sing-box.")}</p><div class="toolbar">${btn(icon("plus") + t("添加", "Add"), "add-entity", `data-kind="${kind}"`, "primary")}${kind === "sources" ? btn(t("刷新订阅", "Refresh subscriptions"), "refresh-sources") : ""}</div><div class="table-wrap"><table><thead><tr><th>${t("启用", "Enabled")}</th><th>${t("名称", "Name")}</th><th>${isNode ? t("节点配置", "Node configuration") : t("来源", "Source")}</th><th>${isNode ? t("链式出口", "Chain exit") : kind === "sources" ? "User-Agent" : t("格式", "Format")}</th><th>${t("操作", "Actions")}</th></tr></thead><tbody>${items.map((item, index) => `<tr><td><input type="checkbox" class="toggle" aria-label="${t("启用", "Enable")} ${esc(item.name || item.id)}" data-field="${kind === "nodes" ? "proxyNodes" : kind === "rule-sources" ? "ruleSources" : "sources"}.${index}.enabled" ${item.enabled ? "checked" : ""}></td><td>${esc(item.name || item.config?.split(/[=\n]/)[0] || item.id)}</td><td class="truncate">${esc(isNode ? t("编辑查看完整配置", "Edit to view full configuration") : sourceHost(item.url))}</td><td class="truncate">${esc(isNode ? item.chainExit ? t("是", "Yes") : t("否", "No") : kind === "sources" ? item.fetchUserAgent : item.format)}</td><td class="actions">${smallButton("edit", "edit-entity", `data-kind="${kind}" data-index="${index}"`, t("编辑", "Edit"))}${smallButton("trash", "delete-entity", `data-kind="${kind}" data-index="${index}"`, t("删除", "Delete"))}</td></tr>`).join("") || `<tr><td colspan="5" class="empty">${t("还没有添加资源", "No resources yet")}</td></tr>`}</tbody></table></div>`;
}
function sourceHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return "—";
  }
}
function renderGroups() {
  return `<p class="muted">${t("三个客户端共用策略组。可指定适用端，不支持的组类型不会自动替换。", "Policy groups are shared. Select their targets; unsupported group types are never silently substituted.")}</p><div class="toolbar">${btn(icon("plus") + t("添加策略组", "Add group"), "add-group", "", "primary")}</div><div class="table-wrap"><table><thead><tr><th>${t("名称", "Name")}</th><th>${t("组配置", "Group definition")}</th><th>${t("适用端", "Targets")}</th><th>${t("操作", "Actions")}</th></tr></thead><tbody>${Object.entries(state.config.groups).map(([name, spec]) => `<tr><td>${esc(name)}${state.config.disabledGroups.includes(name) ? ` <span class="chip">${t("停用", "Disabled")}</span>` : ""}</td><td class="truncate">${esc(spec)}</td><td>${Object.values(CLIENTS).filter((client) => !state.config.groupTargets[name] || state.config.groupTargets[name].includes(client.target)).map((client) => `<span class="chip">${client.label}</span>`).join("")}</td><td class="actions">${smallButton("edit", "edit-group", `data-name="${esc(name)}"`, t("编辑", "Edit"))}${name !== "Proxy" ? smallButton("trash", "delete-group", `data-name="${esc(name)}"`, t("删除", "Delete")) : ""}</td></tr>`).join("")}</tbody></table></div>`;
}
function renderClient() {
  const client = state.config.clients[state.client];
  const fields = CLIENT_SECTIONS[state.client][state.section] || [];
  const tabs = [["network", "网络与 TUN", "Network & TUN"], ["dns", "DNS", "DNS"], ["rules", "路由规则", "Routing"], ["advanced", "高级设置", "Advanced"]];
  let content = "";
  if (state.section === "rules") content = renderRules();
  else if (state.client === "singbox" && state.section === "dns") content = renderSingboxDns();
  else content = fields.map((key) => section(label(key), typeof client[key] === "object" && !Array.isArray(client[key]) ? Object.entries(client[key]).map(([sub, value]) => field(`${basePath()}.${key}.${sub}`, value)).join("") : field(`${basePath()}.${key}`, client[key]), key === "mitm" ? `<div class="grid-actions">${btn(t("生成 CA", "Generate CA"), "generate-ca")}${btn(t("导入 CA", "Import CA"), "import-ca")}${btn(t("导出 CA", "Export CA"), "export-ca")}</div>` : client[key] && typeof client[key] === "object" ? btn(t("完整 JSON", "Full JSON"), "edit-json", `data-path="${basePath()}.${key}"`) : "")).join("");
  if (state.client === "singbox" && state.section === "advanced") content = `<div class="toolbar">${btn(t("编辑客户端 JSON", "Edit client JSON"), "edit-native-config")}</div>` + content;
  if (!content) content = `<p class="empty">${t("此客户端的设置均在其他分栏中提供。", "All settings for this client are available in the other tabs.")}</p>`;
  return clientTabs() + surgePreviewControls() + `<div class="section-tabs">${tabs.map(([id, zh, en]) => btn(t(zh, en), "section", `data-section="${id}"`, state.section === id ? "selected" : "")).join("")}</div>` + content;
}
function renderSingboxDns() {
  const dns = state.config.clients.singbox.dns;
  return section(t("DNS 解析", "DNS resolution"), `<div class="table-wrap"><table><thead><tr><th>${t("名称", "Tag")}</th><th>${t("类型", "Type")}</th><th>${t("服务器", "Server")}</th><th>${t("操作", "Actions")}</th></tr></thead><tbody>${(Array.isArray(dns.servers) ? dns.servers : []).map((server, index) => `<tr><td>${esc(server?.tag)}</td><td>${esc(server?.type)}</td><td>${esc(server?.server || server?.inet4_range || "—")}</td><td>${smallButton("edit", "edit-dns", `data-index="${index}"`, t("编辑", "Edit"))}${smallButton("trash", "delete-dns", `data-index="${index}"`, t("删除", "Delete"))}</td></tr>`).join("")}</tbody></table></div>${btn(icon("plus") + t("添加解析器", "Add resolver"), "add-dns")}<div class="toolbar"></div>${Object.entries(dns).filter(([key]) => key !== "servers").map(([key, value]) => field(`${basePath()}.dns.${key}`, value)).join("")}`, btn(t("完整 JSON", "Full JSON"), "edit-json", `data-path="${basePath()}.dns"`));
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
  let html = `<div class="rule-mode"><label for="rule-mode">${t("规则来源", "Rule source")}</label><select id="rule-mode" data-field="${basePath()}.ruleSets.mode"><option value="manual" ${!compiled ? "selected" : ""}>${t("本端原生规则", "Native rules")}</option><option value="compiled" ${compiled ? "selected" : ""}>${t("共享来源编排", "Compile shared sources")}</option></select></div>`;
  if (!compiled) {
    html += section(t("路由规则", "Routing rules"), `<div class="toolbar">${btn(t("结构化", "Structured"), "rules-structured", "", "primary")}${btn(native ? "JSON" : t("文本", "Text"), "edit-json", `data-path="${path}" data-lines="${native ? "false" : "true"}"`)}</div><div class="table-wrap"><table class="rule-table"><thead><tr><th>${t("顺序", "Order")}</th><th>${t("匹配类型", "Match")}</th><th>${t("匹配值", "Value")}</th><th>${t("出站策略", "Outbound")}</th><th>${t("操作", "Actions")}</th></tr></thead><tbody>${rules.map((rule, index) => ruleRow(rule, index, path, native)).join("") || `<tr><td colspan="5" class="empty">${t("还没有规则", "No rules")}</td></tr>`}</tbody></table></div>${btn(icon("plus") + t("添加规则", "Add rule"), "add-rule", `data-path="${path}"`)}${native ? `<div class="toolbar"></div>${field(`${basePath()}.route.final`, client.route.final || "", { label: t("默认出站", "Default outbound"), options: [.../* @__PURE__ */ new Set([...Object.keys(state.config.groups), "DIRECT", client.route.final || ""])] })}` : ""}<div class="toolbar"><span>${t("共享策略组：", "Shared groups:")}</span>${Object.keys(state.config.groups).slice(0, 7).map((name) => `<span class="chip">${esc(name)}</span>`).join("")}<a href="#groups">${t("管理策略组", "Manage groups")}</a></div><p class="small">${native ? t("当前规则 JSON", "Current rules JSON") : t("当前规则文本", "Current rule text")}</p>${codePreview(native ? JSON.stringify({ route: { rules: client.route.rules, final: client.route.final } }, null, 2) : rules.join("\n"))}`);
  }
  if (native) html += section(t("其他路由设置", "Other route settings"), Object.entries(client.route).filter(([key]) => !["rules", "final"].includes(key)).map(([key, value]) => field(`${basePath()}.route.${key}`, value)).join(""), btn(t("完整 JSON", "Full JSON"), "edit-json", `data-path="${basePath()}.route"`));
  if (state.client === "mihomo") html += section(t("原生规则提供者", "Native rule providers"), field(`${basePath()}.ruleProviders`, client.ruleProviders, { multiline: true }));
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
  const choices = [...new Set([...Object.keys(state.config.groups), "DIRECT", "REJECT", "REJECT-DROP", ...(native ? ["hijack-dns", "sniff", "reject"] : []), policy])];
  const select = (kind, values, current) => `<select data-rule-field="${kind}" data-path="${path}" data-index="${index}" aria-label="${t("规则", "Rule")} ${index + 1} ${kind}">${values.map((item) => `<option value="${esc(item)}" ${item === current ? "selected" : ""}>${esc(kind === "type" && native ? t(...RULE_FIELDS[item]) : item)}</option>`).join("")}</select>`;
  return `<tr><td>${index + 1}</td><td>${simple ? select("type", types, type) : esc(type)}</td><td class="truncate">${esc(value)}</td><td>${simple ? select("policy", choices, policy) : esc(policy)}</td><td class="actions"><span class="order">${smallButton("up", "move-rule", `data-path="${path}" data-index="${index}" data-direction="-1" ${index === 0 ? "disabled" : ""}`, t("上移", "Move up"))}${smallButton("down", "move-rule", `data-path="${path}" data-index="${index}" data-direction="1" ${index === getPath(state.config, path).length - 1 ? "disabled" : ""}`, t("下移", "Move down"))}</span>${smallButton("edit", simple ? "edit-rule" : "edit-rule-json", `data-path="${path}" data-index="${index}"`, t("编辑", "Edit"))}${smallButton("trash", "delete-rule", `data-path="${path}" data-index="${index}"`, t("删除", "Delete"))}</td></tr>`;
}
function renderRulePlan(plan) {
  const actions = `<div class="toolbar">${btn(t("添加规则集", "Add rule set"), "add-output")}${btn(t("添加单条规则", "Add direct rule"), "add-direct")}${btn(t("刷新编译缓存", "Refresh compiled cache"), "refresh-rules")}</div>`;
  const outputRows = plan.outputs.map((output, index) => `<tr><td>${esc(output.order)}</td><td>${esc(output.name)}</td><td>${esc(output.policy)}</td><td>${output.sourceIds.map((id) => esc(state.config.ruleSources.find((source) => source.id === id)?.name || id)).join(", ") || t("内联规则", "Inline rules")}</td><td>${smallButton("edit", "edit-output", `data-index="${index}"`, t("编辑", "Edit"))}${smallButton("trash", "delete-output", `data-index="${index}"`, t("删除", "Delete"))}</td></tr>`).join("");
  const directRows = plan.directRules.map((rule, index) => `<tr><td>${esc(rule.order)}</td><td>${esc(rule.name)}${!rule.enabled ? `<span class="chip">${t("停用", "Disabled")}</span>` : ""}</td><td class="truncate">${esc(rule.rule)}</td><td>${esc(rule.policy)}</td><td>${smallButton("edit", "edit-direct", `data-index="${index}"`, t("编辑", "Edit"))}${smallButton("trash", "delete-direct", `data-index="${index}"`, t("删除", "Delete"))}</td></tr>`).join("");
  return section(t("规则集编排", "Rule-set plan"), `<p class="help">${t("来源共享；选择、策略和排序仅对当前客户端生效。", "Sources are shared; selection, policy and order belong to this client.")}</p>${field(`${basePath()}.ruleSets.aggregateByPolicy`, plan.aggregateByPolicy)}${actions}<div class="table-wrap"><table><thead><tr><th>${t("顺序", "Order")}</th><th>${t("规则集", "Rule set")}</th><th>${t("策略", "Policy")}</th><th>${t("来源", "Sources")}</th><th>${t("操作", "Actions")}</th></tr></thead><tbody>${outputRows}</tbody></table></div><h3>${t("单条规则", "Direct rules")}</h3><div class="table-wrap"><table><thead><tr><th>${t("顺序", "Order")}</th><th>${t("名称", "Name")}</th><th>${t("规则", "Rule")}</th><th>${t("策略", "Policy")}</th><th>${t("操作", "Actions")}</th></tr></thead><tbody>${directRows}</tbody></table></div><p class="help">${t("按顺序数字合并规则集与单条规则；数字越小越先匹配，兜底规则放在最后。", "Rule sets and direct rules share the same order. Lower numbers match first; put the final rule last.")}</p>`);
}
function editDirect(index) {
  const rules = state.config.clients[state.client].ruleSets.directRules;
  const original = index === null ? { id: crypto.randomUUID(), name: "", rule: "DOMAIN-SUFFIX,example.com", policy: "Proxy", order: rules.length, enabled: true } : rules[index];
  modal(t("编辑单条规则", "Edit direct rule"), Object.entries(original).filter(([key]) => key !== "id").map(([key, value]) => localField(key, value, key === "policy" ? { options: [...new Set([...Object.keys(state.config.groups), "DIRECT", "REJECT", "REJECT-DROP", value])] } : {})).join(""), () => {
    const value = readLocal(original);
    if (!value.rule.trim()) throw Error(t("请填写规则", "Enter a rule"));
    if (index === null) rules.push(value); else rules[index] = value;
    closeModal(); changed(); render();
  });
}

function renderOutput() {
  const result = state.results[state.client];
  return clientTabs() + surgePreviewControls() + `<div class="toolbar">${btn(t("生成当前草稿预览", "Preview current draft"), "run-preview", "", "primary")}${btn(icon("copy") + t("复制", "Copy"), "copy-output", result?.canDownload ? "" : "disabled")}${btn(t("下载配置", "Download configuration"), "download-output", result?.canDownload ? "" : "disabled")}</div>${result ? `<p class="muted small">${esc(surgeClientSummary(result.surgeClient))}</p><p class="${result.canDownload ? "muted" : "danger-text"}">${result.canDownload ? t(`输出包含 ${result.proxyCount} 个代理节点。`, `${result.proxyCount} proxy nodes emitted.`) : t("当前配置存在阻断项，请查看适配详情。", "Output is blocked. Open diagnostics for details.")}</p><pre class="preview-code">${esc(result.content || t("解决阻断项后可生成配置。", "Resolve blocking diagnostics to generate configuration."))}</pre>` : `<p class="empty">${t("生成预览以检查当前客户端配置。", "Generate a preview to inspect this client’s configuration.")}</p>`}`;
}
function renderLinks() {
  return `<p class="muted">${t("请复制对应客户端的独立订阅链接。链接中的 token 授予订阅读取权限。", "Copy the dedicated subscription link for your client. The token grants subscription read access.")}</p><div id="subscription-links"><p class="muted">${t("正在读取…", "Loading…")}</p></div><div class="toolbar">${btn(t("轮换读取 token", "Rotate read token"), "rotate-token", "", "danger")}</div>`;
}
function renderSystem() {
  const hidden = ["userAgentStash", "userAgentShadowrocket", "notificationChannel", "notificationTelegramWebhookSecret"];
  return section(t("系统设置", "System settings"), Object.entries(state.config.settings).filter(([key]) => !hidden.includes(key)).map(([key, value]) => field(`settings.${key}`, value)).join("")) + section("GeoIP MMDB", `<p class="help">${t("上传 MMDB 数据库用于节点地理位置识别。", "Upload an MMDB database for node geolocation.")}</p><input type="file" id="mmdb-upload" accept=".mmdb">`) + section("Telegram", `<div class="toolbar">${btn(t("生成绑定码", "Generate binding code"), "telegram-bind")}${btn(t("解除绑定", "Unbind"), "telegram-unbind", "", "danger")}</div><p class="help">${t("通知凭据保存后生效。", "Save notification credentials before binding.")}</p>`);
}
function modal(title, body, onSave, saveLabel = t("应用更改", "Apply changes")) {
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = body;
  $("#modal-actions").innerHTML = btn(t("取消", "Cancel"), "close-modal") + (onSave ? btn(saveLabel, "modal-save", "", "primary") : "");
  modal.save = onSave;
  $("#modal").showModal();
}
function closeModal() {
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
function editEntity(kind, index) {
  const items = collection(kind);
  const original = index === null ? kind === "nodes" ? { id: crypto.randomUUID(), config: "", chainFilter: [], enabled: true, chainExit: false, includeInGroups: true } : kind === "rule-sources" ? { id: crypto.randomUUID(), name: "", url: "", enabled: true, format: "auto", order: items.length } : { id: crypto.randomUUID(), name: "", url: "", fetchUserAgent: state.config.settings.userAgentSurge, enabled: true } : items[index];
  const body = Object.entries(original).filter(([key]) => !["id", "urlEncrypted"].includes(key)).map(([key, value]) => localField(key, value, key === "config" ? { multiline: true } : key === "format" ? { options: ["auto", "surge-rule-set", "surge-domain-set", "clash-yaml", "plain-domain", "plain-ipcidr", "plain-classical"] } : {})).join("");
  modal(t("编辑共享资源", "Edit shared resource"), body, () => {
    const updated = readLocal(original);
    if (kind !== "nodes" && !updated.name.trim()) throw Error(t("请填写名称", "Enter a name"));
    if (index === null) items.push(updated);
    else items[index] = updated;
    closeModal();
    changed();
    render();
  });
}
function editGroup(name) {
  const original = name ? { name, spec: state.config.groups[name], enabled: !state.config.disabledGroups.includes(name) } : { name: "", spec: "select, {all}", enabled: true };
  const selected = name ? state.config.groupTargets[name] || Object.values(CLIENTS).map((client) => client.target) : Object.values(CLIENTS).map((client) => client.target);
  modal(t("编辑策略组", "Edit policy group"), localField("name", original.name) + localField("spec", original.spec, { label: t("组配置", "Group definition"), multiline: true }) + localField("enabled", original.enabled) + `<div class="form-row"><label>${t("适用端", "Targets")}</label><div class="toolbar">${Object.values(CLIENTS).map((client) => `<label><input type="checkbox" name="group-target" value="${client.target}" ${selected.includes(client.target) ? "checked" : ""}> ${client.label}</label>`).join("")}</div></div><p class="help">${t("select 与 url-test 可由三端适配。其他类型按目标检查；修改名称不会自动重写规则引用。", "select and url-test can be adapted across clients. Other types are checked per target. Renaming does not rewrite rule references.")}</p>`, () => {
    const value = readLocal(original);
    value.name = value.name.trim();
    if (!value.name || /[\r\n,=]/.test(value.name)) throw Error(t("策略组名称无效", "Invalid group name"));
    if (name === "Proxy" && (value.name !== "Proxy" || !value.enabled)) throw Error(t("Proxy 必须保留并启用", "Proxy must remain enabled"));
    if (value.name !== name && value.name in state.config.groups) throw Error(t("策略组名称已存在", "Group name already exists"));
    if (name) {
      delete state.config.groups[name];
      delete state.config.groupTargets[name];
      state.config.disabledGroups = state.config.disabledGroups.filter((item) => item !== name);
    }
    state.config.groups[value.name] = value.spec;
    state.config.groupTargets[value.name] = [...$("#modal-body").querySelectorAll("[name=group-target]:checked")].map((input) => input.value);
    if (!value.enabled) state.config.disabledGroups.push(value.name);
    closeModal();
    changed();
    render();
  });
}
function editJson(path, lines = false) {
  const value = getPath(state.config, path);
  modal(label(path.split(".").at(-1)), `<textarea id="json-editor" class="code code-editor" rows="20" spellcheck="false">${esc(lines ? value.join("\n") : JSON.stringify(value, null, 2))}</textarea><p class="help">${t("文本模式保留原生内容。应用时只检查格式，生成预览时检查目标兼容性。", "Text mode preserves native content. Format is checked on apply; target compatibility is checked during preview.")}</p>`, () => {
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
  const choices = [...Object.keys(state.config.groups), "DIRECT", "REJECT", "REJECT-DROP", ...native ? ["hijack-dns", "sniff", "reject"] : []];
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
  modal(t("编辑规则集编排", "Edit rule-set plan"), Object.entries(original).filter(([key]) => key !== "updatedAt" && key !== "sourceIds" && (key !== "surgeOptions" || state.client === "surge")).map(([key, value]) => localField(key, value)).join("") + `<div class="form-row"><label>${t("规则来源", "Rule sources")}</label><div>${state.config.ruleSources.map((source) => `<p><label><input type="checkbox" name="output-source" value="${esc(source.id)}" ${original.sourceIds.includes(source.id) ? "checked" : ""}> ${esc(source.name)}</label></p>`).join("") || `<a href="#rule-sources">${t("请先添加规则来源", "Add a rule source first")}</a>`}</div></div>`, () => {
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
async function preview() {
  if (state.invalid.size || state.busy) return;
  const client = state.client;
  const sent = JSON.stringify(state.config);
  const surgeProfile = state.surgeProfile;
  state.busy = true;
  updateStatus();
  try {
    const result = await api(`/api/preview?target=${CLIENTS[client].target}${client === "surge" ? `&profile=${surgeProfile}` : ""}`, { method: "POST", body: sent });
    if (JSON.stringify(state.config) !== sent || client === "surge" && surgeProfile !== state.surgeProfile) {
      toast(t("配置已变化，请重新预览", "Configuration changed; preview again"));
      return;
    }
    state.results[client] = result;
    if (state.page === "output") render();
    if (state.client === client && (!result.canDownload || result.diagnostics?.length || result.warnings?.length)) showDiagnostics();
    else toast(t("配置预览已生成", "Configuration preview generated"));
  } finally {
    state.busy = false;
    updateStatus();
  }
}
function showDiagnostics() {
  const result = state.results[state.client];
  const migration = state.config.clients[state.client].migrationIssues || [];
  const diagnostics = result?.diagnostics || migration;
  $("#diagnostics-title").textContent = t("适配详情", "Diagnostics");
  $("#diagnostic-items").innerHTML = `<p class="muted small">${esc(result?.surgeClient ? surgeClientSummary(result.surgeClient) : CLIENTS[state.client].label)}</p>${diagnostics.map((item, index) => `<div class="diagnostic ${esc(item.severity)}"><strong>${esc(item.message)}</strong><span class="help">${esc(item.path)}</span>${btn(t("定位设置", "Locate setting"), "locate", `data-path="${esc(item.path)}"`)}${migration.some((entry) => entry.code === item.code && entry.path === item.path) ? btn(t("已手动处理", "Mark resolved"), "resolve-issue", `data-index="${migration.findIndex((entry) => entry.code === item.code && entry.path === item.path)}"`) : ""}</div>`).join("")}${(result?.warnings || []).map((message) => `<div class="diagnostic warning">${esc(message)}</div>`).join("")}${!diagnostics.length && !result?.warnings?.length ? `<p class="muted">${result ? t("未发现输出阻断项。", "No output blockers found.") : t("生成预览后显示适配结果。", "Generate a preview to inspect compatibility.")}</p>` : ""}`;
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
async function exportConfig() {
  state.migrationData = await api("/api/config/migration");
  const response = await fetch("/api/config/export");
  if (!response.ok) throw Error(t("导出失败", "Export failed"));
  download(await response.text(), "subpilot-config-backup.json");
  state.backupDownloaded = true;
  toast(t("备份下载已开始，请妥善保存", "Backup download started; store it securely"));
}
async function reviewMigration() {
  if (!state.migrationData) state.migrationData = await api("/api/config/migration");
  const issues = state.config.clients.singbox.migrationIssues;
  modal(t("确认配置迁移", "Confirm configuration migration"), `<p>${t("迁移保留 Surge 与 mihomo 设置，sing-box 的转换问题可在迁移后继续修复。确认后旧版配置将进入延迟清理，回退需要导出的备份。", "Migration preserves Surge and mihomo settings. sing-box conversion issues can be resolved afterward. Old configuration is scheduled for cleanup; rollback requires the exported backup.")}</p><p>${t(`sing-box 有 ${issues.filter((item) => item.severity === "error").length} 项待处理。`, `${issues.filter((item) => item.severity === "error").length} sing-box items require attention.`)}</p><label><input id="backup-confirm" type="checkbox" ${state.backupDownloaded ? "checked" : ""}> ${t("已下载并保存旧配置备份", "I downloaded and saved the old configuration backup")}</label>`, async () => {
    if (!state.backupDownloaded || !$("#backup-confirm").checked) throw Error(t("请先使用下载旧配置按钮导出备份", "Use Export old configuration to download the backup first"));
    const config = await api("/api/config/migration", { method: "POST", body: JSON.stringify({ config: state.config, fingerprint: state.migrationData.fingerprint, backupDownloaded: true }) });
    state.config = config;
    state.saved = JSON.stringify(config);
    state.migration = false;
    state.results = {};
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
  const links = [[t("Surge 正式版", "Surge Stable"), `${root}surge/stable/`], ["Surge TF", `${root}surge/tf/`], ["mihomo / Clash", `${root}clash/`], ["sing-box", `${root}sing-box/`]];
  $("#subscription-links").innerHTML = links.map(([name, url]) => `<div class="link-row"><label>${name}</label><input readonly type="password" value="${esc(url)}" aria-label="${esc(name)} URL">${btn(icon("copy"), "copy-link", `data-url="${esc(url)}" aria-label="${t("复制链接", "Copy link")}"`)}</div>`).join("");
}
async function refreshStatus() {
  const values = await Promise.allSettled([api("/api/stats"), api("/api/system/status")]);
  if (values[0].status === "fulfilled") state.stats = values[0].value;
  if (values[1].status === "fulfilled") state.system = values[1].value;
  if (state.page === "status") render();
}
async function action(button) {
  const { action: name, path, kind } = button.dataset;
  const index = button.dataset.index === void 0 ? null : Number(button.dataset.index);
  if (name === "edit-native-config") {
    const { coreVersion, migrationIssues, ruleSets, ...native } = state.config.clients.singbox;
    modal(t("sing-box 客户端 JSON", "sing-box client JSON"), `<textarea id="native-config" class="code code-editor" rows="20">${esc(JSON.stringify(native, null, 2))}</textarea><p class="help">${t("可添加原生顶层设置；出站由共享节点和策略组生成。", "Add native top-level settings here. Shared nodes and groups generate outbounds.")}</p>`, () => {
      const value = JSON.parse($("#native-config").value);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(t("配置必须是 JSON 对象", "Configuration must be a JSON object"));
      for (const key of ["log", "dns", "route", "experimental"]) if (!value[key] || typeof value[key] !== "object" || Array.isArray(value[key])) throw Error(`${key}: ${t("需要对象", "object required")}`);
      if (!Array.isArray(value.inbounds)) throw Error(t("入站需要数组", "inbounds must be an array"));
      validateNativeShape(value);
      state.config.clients.singbox = { ...value, coreVersion, migrationIssues, ruleSets };
      closeModal(); changed(); render();
    });
    return;
  }
  if (name === "add-direct" || name === "edit-direct") { editDirect(index); return; }
  if (name === "delete-direct") { state.config.clients[state.client].ruleSets.directRules.splice(index, 1); changed(); render(); return; }
  if (name === "generate-ca") {
    const mitm = state.config.clients.surge.mitm;
    modal(t("生成 MITM CA", "Generate MITM CA"), localField("passphrase", mitm.caPassphrase, { label: t("CA 密码", "CA passphrase") }), async () => {
      const passphrase = readLocal({ passphrase: "" }).passphrase;
      if (!passphrase) throw Error(t("请填写 CA 密码", "Enter a CA passphrase"));
      const { generateMitmCaP12 } = await import("/mitm-ca.js");
      const result = await generateMitmCaP12({ passphrase });
      mitm.caPassphrase = passphrase;
      mitm.caP12 = result.caP12;
      closeModal();
      changed();
      render();
    });
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
    closeDiagnostics();
    render();
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
  if (name === "run-preview") {
    await preview();
    return;
  }
  if (name === "rules-structured") return;
  if (name === "export") {
    await exportConfig();
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
    confirmDelete(t("删除该共享资源后，引用它的配置可能阻止输出。", "Deleting this shared resource may block configurations that reference it."), () => collection(kind).splice(index, 1));
    return;
  }
  if (name === "add-group" || name === "edit-group") {
    editGroup(button.dataset.name);
    return;
  }
  if (name === "delete-group") {
    const group = button.dataset.name;
    confirmDelete(t(`删除 ${group}？引用它的规则不会被自动替换。`, `Delete ${group}? Referencing rules will not be rewritten.`), () => {
      delete state.config.groups[group];
      delete state.config.groupTargets[group];
      state.config.disabledGroups = state.config.disabledGroups.filter((item) => item !== group);
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
      state.results = {};
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
  if (name === "copy-output") {
    await navigator.clipboard.writeText(state.results[state.client].content);
    toast(t("已复制", "Copied"));
    return;
  }
  if (name === "download-output") {
    const result = state.results[state.client];
    if (result?.canDownload) download(result.content, state.client === "surge" ? "SubPilot.conf" : state.client === "singbox" ? "SubPilot.json" : "SubPilot.yaml", result.contentType);
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
  if (name === "refresh-status") {
    await refreshStatus();
    return;
  }
  if (name === "refresh-sources") {
    const result = await api("/api/cache/source/refresh", { method: "POST" });
    toast(t("订阅缓存刷新已完成", "Subscription refresh completed"));
    state.results = {};
    await refreshStatus();
    if (result.failed) showMessage(t("刷新结果", "Refresh result"), result);
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
  if (name === "check-update") {
    showMessage(t("版本检查", "Version check"), await api("/api/update-check", { method: "POST" }));
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
  if (inline.id === "surge-profile") {
    state.surgeProfile = inline.value;
    delete state.results.surge;
    render();
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
    const file = event.target.files[0];
    if (file) fetch("/api/geoip/mmdb", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file }).then(async (response) => {
      const result = await response.json();
      if (!response.ok) throw Error(result.error || "Upload failed");
      toast(t("MMDB 已上传", "MMDB uploaded"));
    }).catch((error) => toast(error.message));
  }
});
$("#save").addEventListener("click", () => save().catch((error) => toast(error.message)));
$("#preview").addEventListener("click", () => {
  state.page = "output";
  location.hash = "output";
  render();
  preview().catch((error) => toast(error.message));
});
$("#close-diagnostics").addEventListener("click", closeDiagnostics);
$("#close-modal").addEventListener("click", closeModal);
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
  if (state.page === "links") loadLinks().catch((error) => toast(error.message));
});
window.addEventListener("beforeunload", (event) => {
  if (dirty() || state.invalid.size) {
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
  const config = await api("/api/config");
  state.migration = Boolean(config.migrationRequired);
  delete config.migrationRequired;
  state.config = config;
  state.saved = JSON.stringify(config);
  state.page = NAV.some((item) => item[0] === location.hash.slice(1)) ? location.hash.slice(1) : "status";
  render();
  if (state.page === "links") await loadLinks();
  await refreshStatus();
}
load().catch((error) => {
  $("#content").innerHTML = `<div class="notice warning">${esc(error.message)}</div>`;
});
