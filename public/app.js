import "./vendor/codemirror/codemirror.js";
import { updateTailscaleForm } from "./tailscale-ui.js";
import { createClashRoutingUi } from "./clash-routing-ui.js";
import { validateActionsCompilationSettings } from "./app-validation.js";
import { CLIENTS, NAV, CLIENT_SECTIONS, getPath, setPath, splitRule } from "./app-model.js";
import { createUi } from "./app-ui.js";
import { createApi } from "./app-api.js";
import { createConfigState } from "./app-config.js";
import { createStatusUi } from "./app-status.js";
import { createGeoipUi } from "./app-geoip.js";
import { createClientUi } from "./app-clients.js";
import { createEditorsUi } from "./app-editors.js";
import { createActionsUi } from "./app-actions.js";
import { createLiveSync } from "./app-sync.js";
const state = { config: null, saved: "", page: "status", client: "surge", section: "network", lang: localStorage.getItem("subpilot-language") || "zh", invalid: /* @__PURE__ */ new Map(), busy: false, stats: null, requestPage: 0, refreshingSources: false, system: null };

let subscriptionCheck = null;
let sharedProxyNames = { signature: "", names: {} };

async function loadSharedProxyNames() {
  const signature = JSON.stringify(state.config);
  if (sharedProxyNames.signature === signature) return;
  const names = await api("/api/config/proxy-names", { method: "POST", body: signature });
  // Do not cache names for a draft that changed while the request was in flight.
  if (JSON.stringify(state.config) === signature) sharedProxyNames = { signature, names };
}

const target = () => CLIENTS[state.client].target;
const basePath = () => `clients.${state.client}`;
const currentClient = () => state.config.clients[state.client];

const dirty = () => state.config && JSON.stringify(state.config) !== state.saved;

const { $, esc, t, label, icon, btn, iconButton, smallButton, isObject, toast, isTextList, field, section, clearHeadingTip, mountHelpTips, positionHelpTip, renderConfigLines, localField, readLocal } = createUi(state);
const api = createApi({ t });
const { acceptSavedConfig } = createConfigState(state);
const { renderSidebarVersion, renderStatus, updateSourceRefreshButtons, renderSourceRefreshResult, formatDate, updateStatusView, refreshStatus, refreshSystem, refreshRequests } = createStatusUi({ state, $, t, esc, section, btn, api, mountHelpTips });
const { mmdb, render: renderMmdbSettings, load: loadMmdbStatus, update: updateMmdbView, upload: uploadMmdb } = createGeoipUi({ $, t, esc, btn, formatDate, api, toast });
const { validateNativeShape, renderGroups, renderClient, renderSingboxDns, editSingboxDns, renderSingboxNetwork, renderSingboxConnectionSettings, renderSingboxVpn, renderSingboxSections, editSingboxSection, tailscaleCollection, renderTailscale, editTailscale, renderMitm, renderRules, orderedPlan, isFinalRule, nextPlanOrder, appendPlanItem, outputSourceUrls, pruneUnusedRuleSources, sourcesForUrls, policyChoices, selectOptions, SURGE_RULE_TYPES, SURGE_RULE_SET_TYPES, SURGE_DIRECT_RULE_TYPES, surgeOptionChoices, compiledFinalOptions, renderRulePlan, isFinalEntry } = createClientUi({ state, $, t, esc, label, btn, icon, iconButton, smallButton, isObject, isTextList, field, section, renderConfigLines, clientTabs, currentClient, basePath, target, modal, closeModal, changed, render, api, getProxyNames: () => sharedProxyNames, getClashRouting: () => clashRouting });
const clashRouting = createClashRoutingUi({ state, t, esc, btn, iconButton, field, section, modal, closeModal, localField, readLocal, policyChoices, selectOptions, orderedPlan, isFinalRule, splitRule, appendPlanItem, changed, render, api });
const { updateChainFilterVisibility, editEntity, editGroup, editJson, updateSurgeRuleForm, editSurgeRule, editSurgeRuleText, editOutput, confirmDelete, editDirect } = createEditorsUi({ state, $, t, esc, label, collection, currentClient, localField, readLocal, modal, closeModal, changed, render, policyChoices, validateNativeShape, isObject, isFinalRule, selectOptions, surgeOptionChoices, compiledFinalOptions, SURGE_RULE_TYPES, SURGE_RULE_SET_TYPES, SURGE_DIRECT_RULE_TYPES, nextPlanOrder, appendPlanItem, outputSourceUrls, sourcesForUrls, pruneUnusedRuleSources, clashPolicyField: (...args) => clashRouting.policyField(...args), checkClashPolicy: (...args) => clashRouting.checkPolicy(...args) });
const { renderActionsCompilationSettings, showActionsProgress, skipActionsUpgrade, checkActionsUpgrade, showActionsSetup, refreshVisibleProgress, hasPendingProgress } = createActionsUi({ state, $, t, esc, btn, field, formatDate, api, modal, closeModal, updateStatus, toast, acceptSavedConfig });

const liveSync = createLiveSync({
  refreshRequests, refreshActions: refreshVisibleProgress,
  hasRequestsView: () => state.page === "status" && !$("#modal").open,
  hasActionsProgress: hasPendingProgress,
  onError: (error) => toast(error.status === 401 ? error.message : t("暂时无法更新状态，稍后自动重试。", "Status updates are temporarily unavailable. Retrying shortly."))
});

function updateStatus() {
  const invalid = state.invalid.size;
  $("#save-status").textContent = state.busy ? t("处理中…", "Working…") : invalid ? t(`${invalid} 项输入格式无效`, `${invalid} invalid fields`) : dirty() ? t("有未保存更改", "Unsaved changes") : t("所有更改已保存", "All changes saved");
  $("#save-status").classList.toggle("dirty", Boolean(dirty() || invalid));
  $("#save").disabled = state.busy || invalid > 0 || !dirty();
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
  const views = { status: renderStatus, sources: () => renderEntities("sources"), nodes: () => renderEntities("nodes"), groups: renderGroups, clients: renderClient, links: renderLinks, system: renderSystem };
  $("#content").innerHTML = (views[state.page] || renderStatus)();
  mountHelpTips($("#content"), $("#page-title"));
  updateStatus();
  updateSourceRefreshButtons();
  updateMmdbView();
  if (state.page === "links") loadLinks().catch((error) => toast(error.message));
}

const MAX_VISIBLE_REQUESTS = 50;

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

function renderLinks() {
  return `<p class="muted" data-help>${t("三个客户端使用同一条订阅地址，按 User-Agent 自动识别 Surge、clash或 sing-box。请在客户端中导入；链接中的 token 授予订阅读取权限。", "All three clients use this subscription URL. User-Agent identifies Surge, clash, or sing-box. Import it in your client; the token grants subscription read access.")}</p><div id="subscription-links"><p class="muted">${t("正在读取…", "Loading…")}</p></div><div class="toolbar">${btn(t("轮换读取 token", "Rotate read token"), "rotate-token", "", "danger")}</div>` + section(t("订阅检查", "Subscription check"), `<p class="help" data-help>${t("检查服务器已保存的配置。订阅更新失败时，可在这里查看具体原因；规则未就绪时，检查会启动后台准备；启用 Actions 后可在编译进度中查看三个客户端的状态。", "Check the configuration saved on the server to find out why a subscription update failed. If rules are not ready, the check starts background preparation. With Actions enabled, view all three clients in compilation progress.")}</p><div class="toolbar">${Object.entries(CLIENTS).map(([id, client]) => btn(`${t("检查", "Check")} ${esc(client.label)}`, "check-subscription", `data-client="${id}"`)).join("")}</div><div id="subscription-check-result">${renderSubscriptionCheck()}</div>`);
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

function renderSystem() {
  return renderSystemOverview() + renderActionsCompilationSettings() + renderMmdbSettings() + section("Telegram", field("settings.notificationTelegramBotToken", state.config.settings.notificationTelegramBotToken) + `<div id="telegram-settings" ${state.config.settings.notificationTelegramBotToken?.trim() ? "" : "hidden"}>` + field("settings.notificationTelegramChatId", state.config.settings.notificationTelegramChatId) + `<div class="toolbar">${btn(t("生成绑定码", "Generate binding code"), "telegram-bind")}${btn(t("解除绑定", "Unbind"), "telegram-unbind", "", "danger")}</div><p class="help">${t("通知凭据保存后生效。", "Save notification credentials before binding.")}</p></div>`);
}
function updateSystemSettingsVisibility() {
  const actions = $("#actions-compiler-settings");
  if (actions) actions.hidden = !state.config.settings.actionsCompilation?.enabled;
  const telegram = $("#telegram-settings");
  if (telegram) telegram.hidden = !state.config.settings.notificationTelegramBotToken?.trim();
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
  void liveSync.refresh();
  modal.editors = [...$("#modal-body").querySelectorAll("textarea.code-editor")].map((textarea) => window.createConfigCodeEditor(textarea, { policyTokens: policyChoices, label: title }));
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

async function save() {
  if (state.invalid.size || state.busy) return;
  const actionsError = validateActionsCompilationSettings(state.config.settings.actionsCompilation, state.lang);
  if (actionsError) throw Error(actionsError);
  state.busy = true;
  updateStatus();
  try {
    const sent = structuredClone(state.config);
    const saved = await api("/api/config", { method: "PUT", body: JSON.stringify(sent) });
    acceptSavedConfig(saved, { base: sent });
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
async function loadLinks() {
  if (state.page !== "links") return;
  const data = await api("/api/read-token");
  if (state.page !== "links") return;
  const base = (state.config.settings.managedBaseUrl || `${location.origin}/sync`).replace(/\/+$/, "");
  const root = `${base}/${encodeURIComponent(data.token)}/`;
  const links = [[t("通用订阅（自动识别）", "Universal (auto-detect)"), root]];
  $("#subscription-links").innerHTML = links.map(([name, url]) => `<div class="link-row"><label>${name}</label><input readonly type="password" value="${esc(url)}" aria-label="${esc(name)} URL">${btn(icon("copy"), "copy-link", `data-url="${esc(url)}" aria-label="${t("复制链接", "Copy link")}"`)}</div>`).join("");
}

async function action(button) {
  if ((state.busy || api.writing) && button.dataset.action !== "close-modal") return;
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
    void liveSync.refresh();
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
  if (name === "add-rule" || name === "edit-rule" || name === "edit-rule-text") {
    if (name === "edit-rule-text") editSurgeRuleText(path, index);
    else editSurgeRule(path, index);
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
    updateStatusView({ preserveFocus: false });
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
      await refreshStatus().catch(() => {});
      state.stats = { ...state.stats, sourceCache: result.sourceCache };
      updateStatusView();
      if (result.failed) modal(t("订阅刷新结果", "Subscription refresh results"), renderSourceRefreshResult(result), null);
      else toast(t(`已刷新 ${result.refreshed} 个订阅源。`, `${result.refreshed} subscription sources refreshed.`));
    } finally {
      state.refreshingSources = false;
      updateSourceRefreshButtons();
    }
    return;
  }
  if (name === "telegram-bind") {
    if (state.busy) return;
    if (dirty()) {
      toast(t("请先保存通知设置", "Save notification settings first"));
      return;
    }
    state.busy = true;
    updateStatus();
    try {
      const { config, ...result } = await api("/api/telegram/bind-code", { method: "POST" });
      acceptSavedConfig(config, { appliedPaths: ["settings.notificationChannel", "settings.notificationTelegramWebhookSecret"] });
      render();
      showMessage(t("Telegram 绑定码", "Telegram binding code"), result);
    } finally { state.busy = false; updateStatus(); }
    return;
  }
  if (name === "telegram-unbind") {
    const unbind = async () => {
      if (state.busy) return;
      state.busy = true;
      updateStatus();
      try {
        const saved = await api("/api/telegram/unbind", { method: "POST" });
        acceptSavedConfig(saved, { appliedPaths: ["settings.notificationTelegramChatId"] });
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
    if (ruleField === "type") { const selected = inline.value; render(); editSurgeRule(path, Number(index), false, selected); return; }
    const rules = getPath(state.config, path);
    const policy = inline.value;
    const parts = splitRule(rules[index]); parts[["FINAL", "MATCH"].includes(parts[0]) ? 1 : 2] = policy; rules[index] = parts.join(",");
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
  void liveSync.refresh();
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
    liveSync.stop();
    location.reload();
  };
  if (dirty()) modal(t("退出登录", "Sign out"), `<p>${t("未保存的更改将丢失。", "Unsaved changes will be lost.")}</p>`, logout, t("退出", "Sign out"));
  else logout().catch((error) => toast(error.message));
});
function navigationPage() {
  const page = location.hash.slice(1);
  return NAV.some((item) => item[0] === page) ? page : "status";
}
window.addEventListener("hashchange", async () => {
  state.page = navigationPage();
  document.body.classList.remove("menu-open");
  if (["clients", "groups"].includes(state.page)) await loadSharedProxyNames().catch((error) => toast(error.message));
  render();
  $("#content").scrollTo(0, 0);
  void liveSync.refresh();
  if (state.page === "status") void refreshStatus().catch((error) => toast(error.message));
  if (state.page === "system") void loadMmdbStatus().catch((error) => toast(error.message));
});
window.addEventListener("beforeunload", (event) => {
  if (dirty() || state.invalid.size || mmdb.uploading || modal.generatingCa || modal.installingActions || modal.skippingActionsUpgrade) {
    event.preventDefault();
    event.returnValue = "";
  }
});
async function load() {
  const config = await api("/api/config");
  state.config = config;
  state.saved = JSON.stringify(config);
  await loadSharedProxyNames().catch((error) => toast(error.message));
  state.page = navigationPage();
  render();
  await checkActionsUpgrade();
  await (state.page === "status" ? refreshStatus() : refreshSystem()).catch((error) => toast(error.message));
  if (state.page === "system") void loadMmdbStatus().catch((error) => toast(error.message));
  liveSync.start();
}
load().catch((error) => {
  $("#content").innerHTML = `<div class="notice warning">${esc(error.message)}</div>`;
});
