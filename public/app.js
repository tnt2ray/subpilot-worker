import {
  CODE_EDITOR_PAGES,
  DEFAULT_CLASH_LOG_LEVEL,
  DEFAULT_CLASH_MODE,
  DEFAULT_DISPLAY_TIME_ZONE,
  EDITABLE_PAGES,
  FETCH_RECORDS_PAGE_SIZE,
  PAGES,
  PROXY_NODE_PROTOCOLS,
} from "./app-constants.js";
import { I18N } from "./app-i18n.js";
import { parseAllSelector, parseGroupOption, splitPolicyGroupSpec } from "./app-policy-group-spec.js";
import { parseProxyNodeConfigDraft } from "./app-proxy-node-drafts.js";
import { groupPreviewWarnings, simplifyPreviewRuleSetNames } from "./app-preview-warnings.js";
import {
  splitSurgeHostLine,
  splitSurgeUrlRewriteLine,
  validateStashScriptLines,
  validateSurgeHostLines,
  validateSurgeUrlRewriteLines
} from "./app-validation.js";
import {
  parseYamlPair,
  quoteYamlKey,
  quoteYamlListItem,
  quoteYamlScalar,
  stripYamlComment,
  unquoteYamlScalar,
  yamlIndent
} from "./app-yaml.js";

let state = null;
let lastSavedState = null;
let fetchStats = null;
let systemStatus = null;
let ruleSetStatus = null;
let statusStatsRefreshPromise = null;
let statusStatsRefreshVersion = 0;
let fetchRecordsPage = 1;
let geoIpMmdbStatus = { uploaded: false };
let currentReadToken = "";
let currentPreviewTarget = "";
let currentPreviewContent = "";
let previewLoadingTarget = "";
let surgeValidationRunning = false;
let saveStatusResetTimer = 0;
let telegramBindPollTimer = 0;
let codeMirrorLoadPromise = null;
let activeUnifiedConfigTab = "general";
let unifiedCommonDraft = null;

const UNIFIED_CONFIG_TABS = ["general", "dns", "rules"];

let activePage = getPageFromHash();
const renderedPages = new Set();

const $ = (id) => document.getElementById(id);
const refs = {
  pageTitle: $("pageTitle"),
  pageDescription: $("pageDescription"),
  pageHead: $("pageHead"),
  mainMenu: $("mainMenu"),
  loginPanel: $("loginPanel"),
  workspace: $("workspace"),
  adminToken: $("adminToken"),
  loginBtn: $("loginBtn"),
  saveBtn: $("saveBtn"),
  groupsBody: $("groupsBody"),
  addGroupBtn: $("addGroupBtn"),
  sourcesBody: $("sourcesBody"),
  addSourceBtn: $("addSourceBtn"),
  proxyNodesBody: $("proxyNodesBody"),
  addProxyNodeBtn: $("addProxyNodeBtn"),
  ruleSetModeManual: $("ruleSetModeManual"),
  ruleSetModeCompiled: $("ruleSetModeCompiled"),
  ruleSetRulesBody: $("ruleSetRulesBody"),
  addRuleSetOutputBtn: $("addRuleSetOutputBtn"),
  refreshRuleSetsBtn: $("refreshRuleSetsBtn"),
  ruleSetStatusSummary: $("ruleSetStatusSummary"),
  ruleSetAggregateByPolicy: $("ruleSetAggregateByPolicy"),
  addRuleSetDirectRuleBtn: $("addRuleSetDirectRuleBtn"),
  unifiedIpv6: $("unifiedIpv6"),
  unifiedIpv6State: $("unifiedIpv6State"),
  unifiedIpv6Mixed: $("unifiedIpv6Mixed"),
  unifiedLanAccess: $("unifiedLanAccess"),
  unifiedLanAccessState: $("unifiedLanAccessState"),
  unifiedLanAccessMixed: $("unifiedLanAccessMixed"),
  unifiedBasicDnsServers: $("unifiedBasicDnsServers"),
  unifiedBasicDnsServersMixed: $("unifiedBasicDnsServersMixed"),
  unifiedEncryptedDnsServers: $("unifiedEncryptedDnsServers"),
  unifiedEncryptedDnsServersMixed: $("unifiedEncryptedDnsServersMixed"),
  unifiedRealIpDomains: $("unifiedRealIpDomains"),
  unifiedRealIpDomainsMixed: $("unifiedRealIpDomainsMixed"),
  unifiedRealIpDomainsInvalid: $("unifiedRealIpDomainsInvalid"),
  managedBaseUrl: $("managedBaseUrl"),
  userAgentSurge: $("userAgentSurge"),
  userAgentClash: $("userAgentClash"),
  userAgentStash: $("userAgentStash"),
  userAgentShadowrocket: $("userAgentShadowrocket"),
  excludeKeywords: $("excludeKeywords"),
  featureTagRules: $("featureTagRules"),
  displayTimeZone: $("displayTimeZone"),
  geoIpMmdbFile: $("geoIpMmdbFile"),
  uploadGeoIpMmdbBtn: $("uploadGeoIpMmdbBtn"),
  geoIpMmdbStatus: $("geoIpMmdbStatus"),
  geoIpMmdbMissingNotice: $("geoIpMmdbMissingNotice"),
  notificationTelegramBotToken: $("notificationTelegramBotToken"),
  updateCheckEnabled: $("updateCheckEnabled"),
  telegramBindStatus: $("telegramBindStatus"),
  telegramBindCodeBtn: $("telegramBindCodeBtn"),
  surgeSkipProxy: $("surgeSkipProxy"),
  surgeDnsServer: $("surgeDnsServer"),
  surgeAlwaysRealIp: $("surgeAlwaysRealIp"),
  surgeInternetTestUrl: $("surgeInternetTestUrl"),
  surgeProxyTestUrl: $("surgeProxyTestUrl"),
  surgeManagedConfigIntervalSeconds: $("surgeManagedConfigIntervalSeconds"),
  surgeShowErrorPageForReject: $("surgeShowErrorPageForReject"),
  surgeIpv6: $("surgeIpv6"),
  surgeIpv6VifRow: $("surgeIpv6VifRow"),
  surgeIpv6Vif: $("surgeIpv6Vif"),
  surgeAllowWifiAccess: $("surgeAllowWifiAccess"),
  surgeTunExcludedRoutes: $("surgeTunExcludedRoutes"),
  surgeEncryptedDnsServer: $("surgeEncryptedDnsServer"),
  surgeWifiAssist: $("surgeWifiAssist"),
  surgeExcludeSimpleHostnames: $("surgeExcludeSimpleHostnames"),
  surgeEncryptedDnsFollowOutboundModeRow: $("surgeEncryptedDnsFollowOutboundModeRow"),
  surgeEncryptedDnsFollowOutboundMode: $("surgeEncryptedDnsFollowOutboundMode"),
  surgePonteDeviceNames: $("surgePonteDeviceNames"),
  surgeHostAdvancedMode: $("surgeHostAdvancedMode"),
  surgeHostStructuredEditor: $("surgeHostStructuredEditor"),
  addSurgeHostBtn: $("addSurgeHostBtn"),
  surgeHostRows: $("surgeHostRows"),
  surgeHostValidation: $("surgeHostValidation"),
  surgeHosts: $("surgeHosts"),
  surgeHostsLabel: document.querySelector('label[for="surgeHosts"]'),
  surgeUrlRewriteAdvancedMode: $("surgeUrlRewriteAdvancedMode"),
  surgeUrlRewriteStructuredEditor: $("surgeUrlRewriteStructuredEditor"),
  addSurgeUrlRewriteBtn: $("addSurgeUrlRewriteBtn"),
  surgeUrlRewriteRows: $("surgeUrlRewriteRows"),
  surgeUrlRewriteValidation: $("surgeUrlRewriteValidation"),
  surgeUrlRewrite: $("surgeUrlRewrite"),
  surgeUrlRewriteLabel: document.querySelector('label[for="surgeUrlRewrite"]'),
  surgeScripts: $("surgeScripts"),
  surgeScriptValidation: $("surgeScriptValidation"),
  surgeMitmSkipServerCertVerify: $("surgeMitmSkipServerCertVerify"),
  surgeMitmH2: $("surgeMitmH2"),
  surgeMitmHostname: $("surgeMitmHostname"),
  generateSurgeMitmCaBtn: $("generateSurgeMitmCaBtn"),
  generateSurgeMitmCaPassphraseBtn: $("generateSurgeMitmCaPassphraseBtn"),
  surgeMitmCaP12File: $("surgeMitmCaP12File"),
  surgeMitmCaGenerationStatus: $("surgeMitmCaGenerationStatus"),
  surgeMitmCaPassphrase: $("surgeMitmCaPassphrase"),
  surgeMitmCaP12: $("surgeMitmCaP12"),
  surgeRuleAdvancedMode: $("surgeRuleAdvancedMode"),
  surgeRuleStructuredEditor: $("surgeRuleStructuredEditor"),
  surgeRuleStructuredActions: $("surgeRuleStructuredActions"),
  addSurgeRuleBtn: $("addSurgeRuleBtn"),
  addSurgeRuleSetBtn: $("addSurgeRuleSetBtn"),
  surgeRuleRows: $("surgeRuleRows"),
  surgeRuleValidation: $("surgeRuleValidation"),
  surgeRules: $("surgeRules"),
  surgeRulesLabel: document.querySelector('label[for="surgeRules"]'),
  clashPort: $("clashPort"),
  clashSocksPort: $("clashSocksPort"),
  clashMixedPort: $("clashMixedPort"),
  clashAllowLan: $("clashAllowLan"),
  clashMode: $("clashMode"),
  clashLogLevel: $("clashLogLevel"),
  clashIpv6: $("clashIpv6"),
  clashUnifiedDelay: $("clashUnifiedDelay"),
  clashTcpConcurrent: $("clashTcpConcurrent"),
  clashExternalController: $("clashExternalController"),
  clashTunEnable: $("clashTunEnable"),
  clashTunStack: $("clashTunStack"),
  clashTunAutoRoute: $("clashTunAutoRoute"),
  clashTunAutoDetectInterface: $("clashTunAutoDetectInterface"),
  clashTunSkipProxy: $("clashTunSkipProxy"),
  clashDnsEnabled: $("clashDnsEnabled"),
  clashDnsListen: $("clashDnsListen"),
  clashDnsIpv6: $("clashDnsIpv6"),
  clashDnsEnhancedMode: $("clashDnsEnhancedMode"),
  clashDnsFakeIpRange: $("clashDnsFakeIpRange"),
  clashDefaultNameservers: $("clashDefaultNameservers"),
  clashNameservers: $("clashNameservers"),
  clashFallbackNameservers: $("clashFallbackNameservers"),
  clashFallbackFilterGeoip: $("clashFallbackFilterGeoip"),
  clashFallbackFilterIpcidr: $("clashFallbackFilterIpcidr"),
  clashFakeIpFilter: $("clashFakeIpFilter"),
  clashRuleProviderAdvancedMode: $("clashRuleProviderAdvancedMode"),
  addClashRuleProviderBtn: $("addClashRuleProviderBtn"),
  clashRuleProviderStructuredEditor: $("clashRuleProviderStructuredEditor"),
  clashRuleProviderRows: $("clashRuleProviderRows"),
  clashRuleProviderValidation: $("clashRuleProviderValidation"),
  clashRuleProviders: $("clashRuleProviders"),
  clashRuleAdvancedMode: $("clashRuleAdvancedMode"),
  clashRuleStructuredEditor: $("clashRuleStructuredEditor"),
  clashRuleStructuredActions: $("clashRuleStructuredActions"),
  addClashRuleBtn: $("addClashRuleBtn"),
  addClashRuleSetBtn: $("addClashRuleSetBtn"),
  clashRuleRows: $("clashRuleRows"),
  clashRuleValidation: $("clashRuleValidation"),
  clashRules: $("clashRules"),
  stashPort: $("stashPort"),
  stashSocksPort: $("stashSocksPort"),
  stashMixedPort: $("stashMixedPort"),
  stashAllowLan: $("stashAllowLan"),
  stashMode: $("stashMode"),
  stashLogLevel: $("stashLogLevel"),
  stashIpv6: $("stashIpv6"),
  stashUnifiedDelay: $("stashUnifiedDelay"),
  stashTcpConcurrent: $("stashTcpConcurrent"),
  stashExternalController: $("stashExternalController"),
  stashTunEnable: $("stashTunEnable"),
  stashTunStack: $("stashTunStack"),
  stashTunAutoRoute: $("stashTunAutoRoute"),
  stashTunAutoDetectInterface: $("stashTunAutoDetectInterface"),
  stashTunSkipProxy: $("stashTunSkipProxy"),
  stashDnsEnabled: $("stashDnsEnabled"),
  stashDnsListen: $("stashDnsListen"),
  stashDnsIpv6: $("stashDnsIpv6"),
  stashDnsEnhancedMode: $("stashDnsEnhancedMode"),
  stashDnsFakeIpRange: $("stashDnsFakeIpRange"),
  stashDefaultNameservers: $("stashDefaultNameservers"),
  stashNameservers: $("stashNameservers"),
  stashFallbackNameservers: $("stashFallbackNameservers"),
  stashFallbackFilterGeoip: $("stashFallbackFilterGeoip"),
  stashFallbackFilterIpcidr: $("stashFallbackFilterIpcidr"),
  stashFakeIpFilter: $("stashFakeIpFilter"),
  stashHosts: $("stashHosts"),
  stashHostValidation: $("stashHostValidation"),
  stashUrlRewrite: $("stashUrlRewrite"),
  stashUrlRewriteValidation: $("stashUrlRewriteValidation"),
  stashScripts: $("stashScripts"),
  stashScriptValidation: $("stashScriptValidation"),
  stashMitmHostname: $("stashMitmHostname"),
  stashRuleProviders: $("stashRuleProviders"),
  stashRuleProviderValidation: $("stashRuleProviderValidation"),
  stashRules: $("stashRules"),
  stashRuleValidation: $("stashRuleValidation"),
  rotateTokenBtn: $("rotateTokenBtn"),
  links: $("links"),
  previewOutput: $("previewOutput"),
  previewSurgeBtn: $("previewSurgeBtn"),
  previewClashBtn: $("previewClashBtn"),
  previewStashBtn: $("previewStashBtn"),
  validateSurgeOnlineBtn: $("validateSurgeOnlineBtn"),
  surgeOnlineValidation: $("surgeOnlineValidation"),
  summarySources: $("summarySources"),
  summaryGroups: $("summaryGroups"),
  summarySourceCache: $("summarySourceCache"),
  refreshSourceCacheBtn: $("refreshSourceCacheBtn"),
  summaryRuleSetCache: $("summaryRuleSetCache"),
  refreshRuleSetCacheBtn: $("refreshRuleSetCacheBtn"),
  systemCurrentVersion: $("systemCurrentVersion"),
  systemUpdateStatus: $("systemUpdateStatus"),
  checkUpdateBtn: $("checkUpdateBtn"),
  fetchRecordsTableBody: $("fetchRecordsTableBody"),
  fetchRecordsPagination: $("fetchRecordsPagination"),
  fetchRecordsPageInfo: $("fetchRecordsPageInfo"),
  fetchRecordsPrevBtn: $("fetchRecordsPrevBtn"),
  fetchRecordsNextBtn: $("fetchRecordsNextBtn")
};

const configCodeEditorRefs = [
  "unifiedBasicDnsServers",
  "unifiedEncryptedDnsServers",
  "unifiedRealIpDomains",
  "surgeHosts",
  "surgeUrlRewrite",
  "surgeScripts",
  "surgeMitmHostname",
  "surgeMitmCaP12",
  "surgeRules",
  "clashTunSkipProxy",
  "clashDefaultNameservers",
  "clashNameservers",
  "clashFallbackNameservers",
  "clashFallbackFilterIpcidr",
  "clashFakeIpFilter",
  "clashRuleProviders",
  "clashRules",
  "stashTunSkipProxy",
  "stashDefaultNameservers",
  "stashNameservers",
  "stashFallbackNameservers",
  "stashFallbackFilterIpcidr",
  "stashFakeIpFilter",
  "stashHosts",
  "stashUrlRewrite",
  "stashScripts",
  "stashMitmHostname",
  "stashRuleProviders",
  "stashRules"
];
const configCodeEditors = new Map();
const CONFIG_POLICY_HIGHLIGHT_BUILT_INS = [
  "Proxy",
  "DIRECT",
  "REJECT",
  "REJECT-DROP",
  "REJECT-NO-DROP",
  "REJECT-TINYGIF",
  "PASS",
  "GLOBAL"
];

const PREVIEW_TARGETS = ["surge", "clash", "stash"];
const PREVIEW_TARGET_LABELS = {
  surge: "Surge",
  clash: "Clash",
  stash: "Stash"
};

function isModeTogglePressed(button) {
  return button.getAttribute("aria-pressed") === "true";
}

function setModeTogglePressed(button, pressed) {
  button.setAttribute("aria-pressed", pressed ? "true" : "false");
}

function syncTextModeLabels(button, outputLabel, advanced) {
  button.textContent = t(advanced ? "structuredEditMode" : "textEditMode");
  if (outputLabel) {
    outputLabel.textContent = t(advanced ? "textConfigContent" : "generatedOutput");
  }
}

function configCodeEditorMaxRows(textarea) {
  const value = Number(textarea?.dataset?.codeEditorMaxRows || textarea?.getAttribute("rows") || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function configCodeEditorRows(textarea) {
  const value = Number(textarea?.dataset?.codeEditorRows || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function configCodeEditorLineHeight(editor) {
  const line = editor.getWrapperElement().querySelector(".cm-line");
  const computed = window.getComputedStyle(line || editor.getWrapperElement());
  return Number.parseFloat(computed.lineHeight) || 20;
}

function configCodeEditorMode(textarea) {
  return textarea?.dataset?.codeEditorMode === "plain" ? null : "proxy-config";
}

function configPolicyHighlightCandidates() {
  const candidates = new Set(CONFIG_POLICY_HIGHLIGHT_BUILT_INS);
  Object.keys(state?.groups || {}).forEach((name) => {
    const trimmed = String(name || "").trim();
    if (trimmed) candidates.add(trimmed);
  });
  (state?.surge?.ponteDeviceNames || []).forEach((name) => {
    const trimmed = String(name || "").trim();
    if (trimmed) candidates.add(`DEVICE:${trimmed}`);
  });
  return [...candidates].sort((a, b) => b.length - a.length);
}

function resizeConfigCodeEditor(textarea, editor) {
  const maxRows = configCodeEditorMaxRows(textarea);
  const rows = configCodeEditorRows(textarea);
  if (!maxRows && !rows) return;
  const lineHeight = configCodeEditorLineHeight(editor);
  const documentHeight = rows
    ? rows * lineHeight
    : Math.min(Math.max(lineHeight, editor.heightAtLine(editor.lastLine() + 1, "local", true)), maxRows * lineHeight);
  const height = Math.ceil(documentHeight + 18);
  editor.setSize(null, height);
}

function loadStylesheet(href) {
  if (document.querySelector(`link[href="${href}"]`)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.addEventListener("load", () => resolve(), { once: true });
    link.addEventListener("error", () => reject(new Error(`Failed to load ${href}`)), { once: true });
    document.head.append(link);
  });
}

function loadScript(src) {
  if (document.querySelector(`script[src="${src}"]`)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)), { once: true });
    document.body.append(script);
  });
}

async function ensureConfigCodeEditors() {
  if (window.SubPilotCodeMirror) {
    initConfigCodeEditors();
    refreshConfigCodeEditors();
    return true;
  }
  if (!codeMirrorLoadPromise) {
    codeMirrorLoadPromise = Promise.all([
      loadStylesheet("/vendor/codemirror/codemirror.css"),
      loadScript("/vendor/codemirror/codemirror.js")
    ]).then(() => {
      initConfigCodeEditors();
      refreshConfigCodeEditors();
      return true;
    }).catch((error) => {
      codeMirrorLoadPromise = null;
      console.warn(error);
      return false;
    });
  }
  return codeMirrorLoadPromise;
}

function ensureConfigCodeEditorsForPage(page = activePage) {
  if (!CODE_EDITOR_PAGES.has(page)) return;
  void ensureConfigCodeEditors();
}

function syncConfigCodeEditor(textarea) {
  const editor = configCodeEditors.get(textarea);
  if (!editor) return;
  const value = textarea.value || "";
  if (editor.getValue() !== value) {
    editor.subpilotSyncing = true;
    editor.setValue(value);
    editor.subpilotSyncing = false;
  }
  const readOnly = textarea.readOnly;
  if (editor.getOption("readOnly") !== readOnly) {
    editor.setOption("readOnly", readOnly);
  }
  if (editor.getOption("mode") !== configCodeEditorMode(textarea)) {
    editor.setOption("mode", configCodeEditorMode(textarea));
  }
  resizeConfigCodeEditor(textarea, editor);
  requestAnimationFrame(() => {
    editor.refresh();
    resizeConfigCodeEditor(textarea, editor);
  });
}

function pruneConfigCodeEditors() {
  for (const textarea of configCodeEditors.keys()) {
    if (!textarea.isConnected) {
      configCodeEditors.get(textarea)?.destroy?.();
      configCodeEditors.delete(textarea);
    }
  }
}

function configCodeTextareas() {
  pruneConfigCodeEditors();
  return [...new Set([
    ...configCodeEditorRefs.map((name) => refs[name]).filter(Boolean),
    ...document.querySelectorAll("textarea.config-code-textarea")
  ])];
}

function syncConfigCodeEditors() {
  for (const textarea of configCodeTextareas()) {
    syncConfigCodeEditor(textarea);
  }
}

function refreshConfigCodeEditors() {
  pruneConfigCodeEditors();
  requestAnimationFrame(() => {
    pruneConfigCodeEditors();
    for (const [textarea, editor] of configCodeEditors.entries()) {
      editor.setOption("mode", configCodeEditorMode(textarea));
      editor.refresh();
      resizeConfigCodeEditor(textarea, editor);
    }
  });
}

function initConfigCodeEditors() {
  const CodeMirror = window.SubPilotCodeMirror;
  if (!CodeMirror) return;
  for (const textarea of configCodeTextareas()) {
    if (!textarea || configCodeEditors.has(textarea)) continue;
    const editor = CodeMirror.fromTextArea(textarea, {
      mode: configCodeEditorMode(textarea),
      lineNumbers: true,
      lineWrapping: true,
      tabSize: 2,
      indentUnit: 2,
      viewportMargin: 90,
      readOnly: textarea.readOnly,
      autoHeight: Boolean(configCodeEditorMaxRows(textarea) || configCodeEditorRows(textarea)),
      policyTokens: configPolicyHighlightCandidates
    });
    editor.on("change", () => {
      if (editor.subpilotSyncing) return;
      editor.save();
      resizeConfigCodeEditor(textarea, editor);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    configCodeEditors.set(textarea, editor);
    syncConfigCodeEditor(textarea);
  }
}

function setPreviewOutput(value, empty = !value) {
  refs.previewOutput.value = value;
  refs.previewOutput.dataset.empty = empty ? "true" : "false";
  syncConfigCodeEditor(refs.previewOutput);
}

function t(key) {
  return I18N[key] ?? key;
}

function formatMessage(key, values = {}) {
  return t(key).replace(/\{(\w+)\}/g, (_, name) => values[name] ?? "");
}

function getPageFromHash() {
  const page = location.hash.replace(/^#/, "");
  if (page === "preview") return "tokens";
  return PAGES.includes(page) ? page : "status";
}

function applyLanguage() {
  document.documentElement.lang = "zh-CN";
  document.title = t("title");
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
    element.setAttribute("placeholder", t(element.dataset.i18nPlaceholder));
  });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
    element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
  });
  setSaveStatus(refs.saveBtn.dataset.state || "idle");
  if (!currentPreviewContent) {
    setPreviewOutput(t("previewEmpty"), true);
  }
  updatePageHeading();
  if (state) {
    renderCurrentPage({ force: true });
  }
}

function setSaveStatus(status) {
  refs.saveBtn.dataset.state = status;
  refs.saveBtn.textContent = t(status);
  refs.saveBtn.disabled = isSaveButtonDisabled(refs.saveBtn, status);
}

function isSaveButtonDisabled(button, status = button?.dataset?.state || "idle") {
  if (!state) return true;
  if (status === "saving" || status === "saved") return true;
  return !hasUnsavedChanges(activePage);
}

function updateSaveAvailability() {
  let status = refs.saveBtn.dataset.state || "idle";
  if (status === "saved" && hasUnsavedChanges(activePage)) {
    if (saveStatusResetTimer) window.clearTimeout(saveStatusResetTimer);
    status = "idle";
  }
  setSaveStatus(status);
}

function updatePageHeading() {
  const key = pageI18nKey(activePage);
  refs.pageTitle.textContent = t(`page${key}Title`);
  refs.pageDescription.textContent = t(`page${key}Description`);
  refs.saveBtn.closest(".apply-bar")?.classList.toggle("hidden", !EDITABLE_PAGES.has(activePage));
}

function pageI18nKey(page) {
  return page
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function isPageAvailable(page) {
  return PAGES.includes(page) && Boolean(document.querySelector(`.page-view[data-page="${page}"]`));
}

function normalizedActivePage(page) {
  return isPageAvailable(page) ? page : "status";
}

function showPage(page, pushHash = false) {
  activePage = normalizedActivePage(page);
  syncConfigModeLayout();
  syncTargetRuleSectionsVisibility();
  renderCurrentPage();
  document.querySelectorAll(".page-view").forEach((view) => {
    view.classList.toggle("hidden", view.dataset.page !== activePage);
  });
  document.querySelectorAll(".luci-menu a[data-page]").forEach((link) => {
    link.classList.toggle("active", link.dataset.page === activePage);
  });
  scrollActiveNavIntoView();
  updatePageHeading();
  if (pushHash && location.hash !== `#${activePage}`) {
    history.pushState(null, "", `#${activePage}`);
  } else if (!pushHash && page !== activePage && location.hash === `#${page}`) {
    history.replaceState(null, "", `#${activePage}`);
  }
  ensureConfigCodeEditorsForPage(activePage);
  updateSaveAvailability();
  refreshStatusStatsIfVisible();
}

function normalizedUnifiedConfigTab(tab) {
  return UNIFIED_CONFIG_TABS.includes(tab) ? tab : "general";
}

function syncUnifiedConfigTabs() {
  if (!state) return;
  activeUnifiedConfigTab = normalizedUnifiedConfigTab(activeUnifiedConfigTab);
  const compiled = isRuleSetModeEnabled();
  if (!compiled && activeUnifiedConfigTab === "rules") activeUnifiedConfigTab = "general";
  document.querySelectorAll("[data-unified-config-tab]").forEach((button) => {
    const tab = button.dataset.unifiedConfigTab;
    const available = tab !== "rules" || compiled;
    const active = available && tab === activeUnifiedConfigTab;
    button.classList.toggle("hidden", !available);
    button.classList.toggle("active", active);
    button.setAttribute("aria-hidden", available ? "false" : "true");
    button.setAttribute("aria-selected", active ? "true" : "false");
    button.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll("[data-unified-config-panel]").forEach((panel) => {
    const available = panel.dataset.unifiedConfigPanel !== "rules" || compiled;
    panel.classList.toggle("hidden", !available || panel.dataset.unifiedConfigPanel !== activeUnifiedConfigTab);
  });
}

function showUnifiedConfigTab(tab) {
  activeUnifiedConfigTab = normalizedUnifiedConfigTab(tab);
  syncUnifiedConfigTabs();
  refreshConfigCodeEditors();
  updateSaveAvailability();
}

function handleUnifiedConfigTabKeydown(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = Array.from(document.querySelectorAll("[data-unified-config-tab]")).filter((button) => !button.classList.contains("hidden"));
  const currentIndex = tabs.indexOf(event.currentTarget);
  if (currentIndex < 0 || tabs.length === 0) return;
  let nextIndex = currentIndex;
  if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = tabs.length - 1;
  event.preventDefault();
  const nextTab = tabs[nextIndex];
  showUnifiedConfigTab(nextTab.dataset.unifiedConfigTab);
  nextTab.focus();
}

function showSurgeTab(tab) {
  const requestedTab = ["general", "host", "urlRewrite", "script", "mitm", "ponte", "rule"].includes(tab) ? tab : "general";
  const nextTab = isRuleSetModeEnabled() && requestedTab === "rule" ? "general" : requestedTab;
  document.querySelectorAll("[data-surge-tab]").forEach((button) => {
    const active = button.dataset.surgeTab === nextTab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll("[data-surge-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.surgePanel !== nextTab);
  });
  ensureConfigCodeEditorsForPage("surge");
}

function showClashTab(tab) {
  const requestedTab = ["general", "dns", "providers", "rules"].includes(tab) ? tab : "general";
  const nextTab = isRuleSetModeEnabled() && ["providers", "rules"].includes(requestedTab) ? "general" : requestedTab;
  document.querySelectorAll("[data-clash-tab]").forEach((button) => {
    const active = button.dataset.clashTab === nextTab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll("[data-clash-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.clashPanel !== nextTab);
  });
  if (state && nextTab === "rules") reconcileClashRulesWithProviders();
  ensureConfigCodeEditorsForPage("clash");
}

function showStashTab(tab) {
  const requestedTab = ["general", "host", "urlRewrite", "script", "mitm", "rule"].includes(tab) ? tab : "general";
  const nextTab = isRuleSetModeEnabled() && requestedTab === "rule" ? "general" : requestedTab;
  document.querySelectorAll("[data-stash-tab]").forEach((button) => {
    const active = button.dataset.stashTab === nextTab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll("[data-stash-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.stashPanel !== nextTab);
  });
  ensureConfigCodeEditorsForPage("stash");
}

function scrollActiveNavIntoView() {
  const activeLink = document.querySelector(".luci-menu a.active");
  if (!activeLink || !window.matchMedia("(max-width: 820px)").matches) return;
  activeLink.scrollIntoView({ block: "nearest", inline: "nearest" });
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return response.json();
}

async function boot() {
  try {
    const session = await request("/api/session");
    if (!session.ok) throw new Error("No active session");
    await loadConfig();
    showWorkspace();
  } catch {
    showLogin();
  }
}

function showLogin() {
  refs.mainMenu.classList.add("hidden");
  refs.pageHead.classList.add("hidden");
  refs.loginPanel.classList.remove("hidden");
  refs.workspace.classList.add("hidden");
  updateSaveAvailability();
}

function showWorkspace() {
  refs.mainMenu.classList.remove("hidden");
  refs.pageHead.classList.remove("hidden");
  refs.loginPanel.classList.add("hidden");
  refs.workspace.classList.remove("hidden");
  showPage(activePage);
}

async function login() {
  await request("/api/login", {
    method: "POST",
    body: JSON.stringify({ token: refs.adminToken.value })
  });
  await loadConfig();
  showWorkspace();
}

async function loadConfig() {
  const [config, readToken, stats, mmdbStatus, system, rules] = await Promise.all([
    request("/api/config"),
    request("/api/read-token"),
    request("/api/stats"),
    request("/api/geoip/mmdb"),
    request("/api/system/status"),
    request("/api/rule-sets/status")
  ]);
  state = config;
  lastSavedState = cloneConfig(config);
  fetchStats = stats;
  geoIpMmdbStatus = mmdbStatus;
  systemStatus = system;
  ruleSetStatus = rules;
  currentReadToken = readToken.token;
  render();
}

function render(options = {}) {
  if (!options.preserveUnifiedCommonDraft) unifiedCommonDraft = null;
  renderedPages.clear();
  showPage(activePage);
  updateSaveAvailability();
}

function renderCurrentPage(options = {}) {
  renderPage(activePage, options);
}

function renderPage(page, options = {}) {
  if (!state) return;
  if (!options.force && renderedPages.has(page)) return;
  switch (page) {
    case "status":
      renderStatus();
      break;
    case "settings":
      renderSettings();
      break;
    case "sources":
      renderSources();
      break;
    case "proxy-nodes":
      renderProxyNodes();
      break;
    case "groups":
      renderGroups();
      break;
    case "unified-config":
      renderUnifiedConfig();
      break;
    case "surge":
      renderSurge();
      break;
    case "clash":
      renderClash();
      break;
    case "stash":
      renderStash();
      break;
    case "tokens":
      renderLinks();
      break;
    default:
      return;
  }
  renderedPages.add(page);
}

function renderStatus() {
  renderSummary();
  renderSystemStatus();
  renderFetchStats();
}

function renderUnifiedConfig() {
  renderRuleSets();
  renderUnifiedCommonConfig();
  syncUnifiedConfigTabs();
}

function unifiedCommonState(config) {
  const clashEncryptedDnsServers = splitUnifiedDnsServers(config.clash.nameservers || []).encrypted;
  const stashEncryptedDnsServers = splitUnifiedDnsServers(config.stash.dns?.nameservers || []).encrypted;
  return {
    ipv6: [config.surge.ipv6, config.clash.ipv6, config.stash.ipv6],
    lanAccess: [config.surge.allowWifiAccess, config.clash.allowLan, config.stash.allowLan],
    basicDnsServers: [
      [...(config.surge.dnsServer || [])],
      [...(config.clash.defaultNameservers || [])],
      [...(config.stash.dns?.defaultNameservers || [])]
    ],
    encryptedDnsServers: [
      [...(config.surge.encryptedDnsServer || [])],
      clashEncryptedDnsServers,
      stashEncryptedDnsServers
    ],
    realIpDomains: [
      [...(config.surge.alwaysRealIp || [])],
      [...(config.clash.fakeIpFilter || [])],
      [...(config.stash.dns?.fakeIpFilter || [])]
    ]
  };
}

function splitUnifiedDnsServers(servers) {
  const basic = [];
  const encrypted = [];
  for (const value of servers) {
    const server = String(value || "").trim();
    if (!server) continue;
    if (/^(?:https|tls|dot|quic|doq|h3|http3|doh|doh3):\/\//i.test(server)) encrypted.push(server);
    else basic.push(server);
  }
  return { basic, encrypted };
}

function effectiveUnifiedNameservers(basic, encrypted) {
  const servers = encrypted.length > 0 ? encrypted : basic;
  return [...new Set(servers.map((value) => String(value || "").trim()).filter(Boolean))];
}

function unifiedBooleanControlState(values) {
  const mixed = values.some((value) => value !== values[0]);
  return { checked: mixed ? false : values[0], mixed };
}

function unifiedListControlState(values) {
  const serialized = values.map((value) => JSON.stringify(value));
  const mixed = serialized.some((value) => value !== serialized[0]);
  return { value: mixed ? "" : (values[0] || []).join("\n"), mixed };
}

function isUnifiedRealIpDomain(value) {
  const entry = String(value || "").trim();
  if (!entry || entry.length > 253) return false;
  return entry.split(".").every((label) => label === "*" || /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

function invalidUnifiedRealIpDomains(domains) {
  return [...new Set(domains
    .map((domain) => String(domain || "").trim())
    .filter((domain) => domain && !isUnifiedRealIpDomain(domain)))];
}

function ensureUnifiedCommonDraft() {
  if (!unifiedCommonDraft) unifiedCommonDraft = cloneConfig(unifiedCommonState(state));
  return unifiedCommonDraft;
}

function renderUnifiedBoolean(control, stateLabel, mixedNotice, values) {
  const { checked, mixed } = unifiedBooleanControlState(values);
  control.checked = checked;
  control.indeterminate = mixed;
  control.setAttribute("aria-checked", mixed ? "mixed" : String(control.checked));
  stateLabel.textContent = t(mixed ? "unifiedCommonValueMixed" : "enabled");
  mixedNotice.classList.toggle("hidden", !mixed);
}

function renderUnifiedCommonConfig() {
  const common = ensureUnifiedCommonDraft();
  renderUnifiedBoolean(refs.unifiedIpv6, refs.unifiedIpv6State, refs.unifiedIpv6Mixed, common.ipv6);
  renderUnifiedBoolean(refs.unifiedLanAccess, refs.unifiedLanAccessState, refs.unifiedLanAccessMixed, common.lanAccess);
  const basicDnsServers = unifiedListControlState(common.basicDnsServers);
  refs.unifiedBasicDnsServers.value = basicDnsServers.value;
  refs.unifiedBasicDnsServers.placeholder = basicDnsServers.mixed ? t("unifiedBasicDnsServersMixedPlaceholder") : "";
  refs.unifiedBasicDnsServers.dataset.mixed = String(basicDnsServers.mixed);
  refs.unifiedBasicDnsServersMixed.classList.toggle("hidden", !basicDnsServers.mixed);
  const dnsServers = unifiedListControlState(common.encryptedDnsServers);
  refs.unifiedEncryptedDnsServers.value = dnsServers.value;
  refs.unifiedEncryptedDnsServers.placeholder = dnsServers.mixed ? t("unifiedEncryptedDnsServersMixedPlaceholder") : "";
  refs.unifiedEncryptedDnsServers.dataset.mixed = String(dnsServers.mixed);
  refs.unifiedEncryptedDnsServersMixed.classList.toggle("hidden", !dnsServers.mixed);
  const realIpDomains = unifiedListControlState(common.realIpDomains);
  refs.unifiedRealIpDomains.value = realIpDomains.value;
  refs.unifiedRealIpDomains.placeholder = realIpDomains.mixed ? t("unifiedRealIpDomainsMixedPlaceholder") : "";
  refs.unifiedRealIpDomains.dataset.mixed = String(realIpDomains.mixed);
  refs.unifiedRealIpDomainsMixed.classList.toggle("hidden", !realIpDomains.mixed);
  const baselineRealIpDomains = lastSavedState ? unifiedCommonState(lastSavedState).realIpDomains : common.realIpDomains;
  const realIpDomainsChanged = JSON.stringify(common.realIpDomains) !== JSON.stringify(baselineRealIpDomains);
  const invalidRealIpDomains = realIpDomainsChanged ? invalidUnifiedRealIpDomains(common.realIpDomains.flat()) : [];
  refs.unifiedRealIpDomains.setCustomValidity(invalidRealIpDomains.length > 0 ? t("unifiedRealIpDomainsInvalid") : "");
  refs.unifiedRealIpDomainsInvalid.classList.toggle("hidden", invalidRealIpDomains.length === 0);
  syncConfigCodeEditors();
}

function setUnifiedCommonBoolean(field, enabled) {
  const common = ensureUnifiedCommonDraft();
  if (field === "ipv6") common.ipv6 = [enabled, enabled, enabled];
  if (field === "lanAccess") common.lanAccess = [enabled, enabled, enabled];
  renderUnifiedCommonConfig();
  updateSaveAvailability();
}

function setUnifiedDnsServers(field, value) {
  const common = ensureUnifiedCommonDraft();
  const servers = textToLines(value);
  common[field] = [servers.slice(), servers.slice(), servers.slice()];
  const control = field === "basicDnsServers" ? refs.unifiedBasicDnsServers : refs.unifiedEncryptedDnsServers;
  const mixedNotice = field === "basicDnsServers" ? refs.unifiedBasicDnsServersMixed : refs.unifiedEncryptedDnsServersMixed;
  control.dataset.mixed = "false";
  mixedNotice.classList.add("hidden");
  updateSaveAvailability();
}

function setUnifiedRealIpDomains(value) {
  const common = ensureUnifiedCommonDraft();
  const domains = textToLines(value);
  common.realIpDomains = [domains.slice(), domains.slice(), domains.slice()];
  const invalid = invalidUnifiedRealIpDomains(domains);
  refs.unifiedRealIpDomains.dataset.mixed = "false";
  refs.unifiedRealIpDomainsMixed.classList.add("hidden");
  refs.unifiedRealIpDomains.setCustomValidity(invalid.length > 0 ? t("unifiedRealIpDomainsInvalid") : "");
  refs.unifiedRealIpDomainsInvalid.classList.toggle("hidden", invalid.length === 0);
  updateSaveAvailability();
}

function buildUnifiedCommonPatch(common, ruleSets) {
  return {
    ruleSets,
    surge: {
      ipv6: common.ipv6[0],
      allowWifiAccess: common.lanAccess[0],
      dnsServer: common.basicDnsServers[0].slice(),
      encryptedDnsServer: common.encryptedDnsServers[0].slice(),
      alwaysRealIp: common.realIpDomains[0].slice()
    },
    clash: {
      ipv6: common.ipv6[1],
      allowLan: common.lanAccess[1],
      defaultNameservers: common.basicDnsServers[1].slice(),
      nameservers: effectiveUnifiedNameservers(common.basicDnsServers[1], common.encryptedDnsServers[1]),
      fakeIpFilter: common.realIpDomains[1].slice()
    },
    stash: {
      ipv6: common.ipv6[2],
      allowLan: common.lanAccess[2],
      dns: {
        defaultNameservers: common.basicDnsServers[2].slice(),
        nameservers: effectiveUnifiedNameservers(common.basicDnsServers[2], common.encryptedDnsServers[2]),
        fakeIpFilter: common.realIpDomains[2].slice()
      }
    }
  };
}

function syncConfigModeLayout() {
  if (!state) return;
  const unifiedLink = refs.mainMenu.querySelector('a[data-page="unified-config"]');
  unifiedLink?.classList.remove("hidden");
  unifiedLink?.setAttribute("aria-hidden", "false");
  if (unifiedLink) unifiedLink.tabIndex = 0;
  for (const target of ["surge", "clash", "stash"]) {
    const link = refs.mainMenu.querySelector(`a[data-page="${target}"]`);
    link?.classList.remove("hidden");
    link?.setAttribute("aria-hidden", "false");
    if (link) link.tabIndex = 0;
  }
  document.querySelectorAll("[data-unified-common-target-control]").forEach((control) => {
    control.classList.add("hidden");
  });
  document.querySelectorAll("[data-unified-common-target-group]").forEach((group) => {
    group.classList.add("unified-common-targets-hidden");
  });
  renderUnifiedCommonConfig();
}

function renderSettings() {
  refs.managedBaseUrl.value = state.settings.managedBaseUrl;
  renderRuleSetMode();
  refs.userAgentSurge.value = state.settings.userAgentSurge;
  refs.userAgentClash.value = state.settings.userAgentClash;
  refs.userAgentStash.value = state.settings.userAgentStash;
  refs.userAgentShadowrocket.value = state.settings.userAgentShadowrocket;
  refs.excludeKeywords.value = state.settings.excludeKeywords.join(", ");
  refs.featureTagRules.value = linesToText(state.settings.featureTagRules || []);
  setDisplayTimeZoneValue(state.settings.displayTimeZone);
  refs.notificationTelegramBotToken.value = state.settings.notificationTelegramBotToken || "";
  refs.updateCheckEnabled.checked = state.settings.updateCheckEnabled === true;
  renderTelegramBindStatus();
  renderGeoIpMmdbStatus();
}

function renderSurge() {
  const advancedHostMode = isModeTogglePressed(refs.surgeHostAdvancedMode);
  const advancedUrlRewriteMode = isModeTogglePressed(refs.surgeUrlRewriteAdvancedMode);
  const advancedRuleMode = isModeTogglePressed(refs.surgeRuleAdvancedMode);
  refs.surgeSkipProxy.value = state.surge.skipProxy.join(", ");
  refs.surgeDnsServer.value = state.surge.dnsServer.join(", ");
  refs.surgeAlwaysRealIp.value = state.surge.alwaysRealIp.join(", ");
  refs.surgeInternetTestUrl.value = state.surge.internetTestUrl;
  refs.surgeProxyTestUrl.value = state.surge.proxyTestUrl;
  refs.surgeManagedConfigIntervalSeconds.value = state.surge.managedConfigIntervalSeconds;
  refs.surgeShowErrorPageForReject.checked = state.surge.showErrorPageForReject;
  refs.surgeIpv6.checked = state.surge.ipv6;
  refs.surgeIpv6Vif.value = state.surge.ipv6Vif;
  syncSurgeIpv6VifVisibility();
  refs.surgeAllowWifiAccess.checked = state.surge.allowWifiAccess;
  refs.surgeTunExcludedRoutes.value = state.surge.tunExcludedRoutes.join(", ");
  refs.surgeEncryptedDnsServer.value = state.surge.encryptedDnsServer.join(", ");
  refs.surgeWifiAssist.checked = state.surge.wifiAssist;
  refs.surgeExcludeSimpleHostnames.checked = state.surge.excludeSimpleHostnames;
  refs.surgeEncryptedDnsFollowOutboundMode.checked = state.surge.encryptedDnsFollowOutboundMode;
  syncSurgeEncryptedDnsFollowOutboundModeVisibility();
  refs.surgePonteDeviceNames.value = normalizePonteDeviceNames(state.surge.ponteDeviceNames || []).join(", ");
  renderSurgeHostRows(state.surge.hosts || []);
  if (advancedHostMode) {
    refs.surgeHosts.value = linesToText(state.surge.hosts || []);
  }
  setModeTogglePressed(refs.surgeHostAdvancedMode, advancedHostMode);
  syncSurgeHostMode();
  renderSurgeUrlRewriteRows(state.surge.urlRewrite || []);
  if (advancedUrlRewriteMode) {
    refs.surgeUrlRewrite.value = linesToText(state.surge.urlRewrite || []);
  }
  setModeTogglePressed(refs.surgeUrlRewriteAdvancedMode, advancedUrlRewriteMode);
  syncSurgeUrlRewriteMode();
  refs.surgeScripts.value = linesToText(state.surge.scripts || []);
  refs.surgeMitmSkipServerCertVerify.checked = state.surge.mitm?.skipServerCertVerify !== false;
  refs.surgeMitmH2.checked = state.surge.mitm?.h2 !== false;
  refs.surgeMitmHostname.value = linesToText(state.surge.mitm?.hostname || []);
  refs.surgeMitmCaPassphrase.value = state.surge.mitm?.caPassphrase || "";
  refs.surgeMitmCaP12.value = state.surge.mitm?.caP12 || "";
  validateCurrentSurgeScripts();
  renderSurgeRuleRows(state.surge.rules);
  if (advancedRuleMode) {
    refs.surgeRules.value = linesToText(state.surge.rules);
  }
  setModeTogglePressed(refs.surgeRuleAdvancedMode, advancedRuleMode);
  syncSurgeRuleMode();
  syncConfigCodeEditors();
}

function renderClash() {
  refs.clashPort.value = String(state.clash.port);
  refs.clashSocksPort.value = String(state.clash.socksPort);
  refs.clashMixedPort.value = String(state.clash.mixedPort);
  refs.clashAllowLan.checked = state.clash.allowLan;
  refs.clashMode.value = DEFAULT_CLASH_MODE;
  refs.clashLogLevel.value = DEFAULT_CLASH_LOG_LEVEL;
  refs.clashIpv6.checked = state.clash.ipv6;
  refs.clashUnifiedDelay.checked = state.clash.unifiedDelay;
  refs.clashTcpConcurrent.checked = state.clash.tcpConcurrent;
  refs.clashExternalController.value = state.clash.externalController || "";
  refs.clashTunEnable.checked = state.clash.tun?.enable !== false;
  refs.clashTunStack.value = state.clash.tun?.stack || "system";
  refs.clashTunAutoRoute.checked = state.clash.tun?.autoRoute !== false;
  refs.clashTunAutoDetectInterface.checked = state.clash.tun?.autoDetectInterface !== false;
  refs.clashTunSkipProxy.value = linesToText(state.clash.tun?.skipProxy || []);
  syncClashTunVisibility();
  refs.clashDnsEnabled.checked = state.clash.dnsEnabled;
  refs.clashDnsListen.value = state.clash.dnsListen || "";
  refs.clashDnsIpv6.checked = state.clash.dnsIpv6;
  refs.clashDnsEnhancedMode.value = state.clash.dnsEnhancedMode;
  refs.clashDnsFakeIpRange.value = state.clash.dnsFakeIpRange || "";
  syncClashFakeIpVisibility();
  refs.clashDefaultNameservers.value = linesToText(state.clash.defaultNameservers || []);
  refs.clashNameservers.value = linesToText(state.clash.nameservers);
  refs.clashFallbackNameservers.value = linesToText(state.clash.fallbackNameservers || []);
  refs.clashFallbackFilterGeoip.checked = state.clash.fallbackFilterGeoip !== false;
  refs.clashFallbackFilterIpcidr.value = linesToText(state.clash.fallbackFilterIpcidr || []);
  refs.clashFakeIpFilter.value = linesToText(state.clash.fakeIpFilter || []);
  refs.clashRuleProviders.value = state.clash.ruleProviders || "";
  renderClashRuleProviderRowsFromYaml(refs.clashRuleProviders.value);
  syncClashRuleProviderMode();
  const advancedRuleMode = isModeTogglePressed(refs.clashRuleAdvancedMode);
  refs.clashRules.value = buildClashRulesYaml(state.clash.rules);
  renderClashRuleRowsFromYaml(refs.clashRules.value);
  if (advancedRuleMode) {
    refs.clashRules.value = buildClashRulesYaml(state.clash.rules);
  }
  setModeTogglePressed(refs.clashRuleAdvancedMode, advancedRuleMode);
  syncClashRuleMode();
  reconcileClashRulesWithProviders();
  syncConfigCodeEditors();
}

function renderStash() {
  const stash = state.stash || {};
  const dns = stash.dns || {};
  refs.stashPort.value = String(stash.port);
  refs.stashSocksPort.value = String(stash.socksPort);
  refs.stashMixedPort.value = String(stash.mixedPort);
  refs.stashAllowLan.checked = stash.allowLan === true;
  refs.stashMode.value = stash.mode || DEFAULT_CLASH_MODE;
  refs.stashLogLevel.value = stash.logLevel || DEFAULT_CLASH_LOG_LEVEL;
  refs.stashIpv6.checked = stash.ipv6 !== false;
  refs.stashUnifiedDelay.checked = stash.unifiedDelay !== false;
  refs.stashTcpConcurrent.checked = stash.tcpConcurrent !== false;
  refs.stashExternalController.value = stash.externalController || "";
  refs.stashTunEnable.checked = stash.tun?.enable !== false;
  refs.stashTunStack.value = stash.tun?.stack || "system";
  refs.stashTunAutoRoute.checked = stash.tun?.autoRoute !== false;
  refs.stashTunAutoDetectInterface.checked = stash.tun?.autoDetectInterface !== false;
  refs.stashTunSkipProxy.value = linesToText(stash.tun?.skipProxy || []);
  syncStashTunVisibility();
  refs.stashDnsEnabled.checked = dns.enable !== false;
  refs.stashDnsListen.value = dns.listen || "";
  refs.stashDnsIpv6.checked = dns.ipv6 !== false;
  refs.stashDnsEnhancedMode.value = dns.enhancedMode || "fake-ip";
  refs.stashDnsFakeIpRange.value = dns.fakeIpRange || "";
  syncStashFakeIpVisibility();
  refs.stashDefaultNameservers.value = linesToText(dns.defaultNameservers || []);
  refs.stashNameservers.value = linesToText(dns.nameservers || []);
  refs.stashFallbackNameservers.value = linesToText(dns.fallbackNameservers || []);
  refs.stashFallbackFilterGeoip.checked = dns.fallbackFilterGeoip !== false;
  refs.stashFallbackFilterIpcidr.value = linesToText(dns.fallbackFilterIpcidr || []);
  refs.stashFakeIpFilter.value = linesToText(dns.fakeIpFilter || []);
  refs.stashHosts.value = linesToText(stash.hosts || []);
  refs.stashUrlRewrite.value = linesToText(stash.urlRewrite || []);
  refs.stashScripts.value = linesToText(stash.scripts || []);
  refs.stashMitmHostname.value = linesToText(stash.mitm?.hostname || []);
  refs.stashRuleProviders.value = stash.ruleProviders || "";
  refs.stashRules.value = buildClashRulesYaml(stash.rules || []);
  validateCurrentStashHosts();
  validateCurrentStashUrlRewrite();
  validateCurrentStashScripts();
  validateCurrentStashRuleProviders();
  validateCurrentStashRules();
  syncConfigCodeEditors();
}

const CLASH_RULE_PROVIDER_TYPES = ["http", "file"];
const CLASH_RULE_PROVIDER_BEHAVIORS = ["classical", "domain", "ipcidr"];

function defaultClashRuleProvider() {
  return {
    name: "",
    type: "http",
    behavior: "classical",
    url: "",
    interval: "86400"
  };
}

function clashRuleProviderDefaultPath(name) {
  const slug = String(name || "")
    .trim()
    .replace(/[\\/:*?"<>|#\s]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `./rules/${slug || "provider"}.yaml`;
}

function parseClashRuleProvidersYaml(value) {
  const text = String(value || "").replace(/\r\n?/g, "\n").trimEnd();
  if (!text.trim()) return { providers: [], errors: [] };
  const lines = text.split("\n");
  const errors = [];
  const providers = [];
  const firstContentIndex = lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith("#");
  });
  if (firstContentIndex < 0) return { providers, errors };

  let startIndex = firstContentIndex;
  let baseIndent = -2;
  const firstPair = parseYamlPair(lines[firstContentIndex].trim());
  if (firstPair?.key === "rule-providers" && stripYamlComment(firstPair.value) === "") {
    baseIndent = yamlIndent(lines[firstContentIndex]);
    startIndex = firstContentIndex + 1;
  }

  let current = null;
  let currentIndent = -1;
  for (let index = startIndex; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = yamlIndent(rawLine);
    if (indent <= baseIndent) {
      errors.push(`第 ${index + 1} 行只能包含 rule-providers 配置块。`);
      current = null;
      continue;
    }
    const pair = parseYamlPair(trimmed);
    if (!pair || !pair.key) {
      errors.push(`第 ${index + 1} 行不是有效的 YAML 键值。`);
      continue;
    }
    const value = stripYamlComment(pair.value);
    if (value === "" && (current === null || indent <= currentIndent)) {
      current = { ...defaultClashRuleProvider(), name: pair.key };
      currentIndent = indent;
      providers.push(current);
      continue;
    }
    if (!current || indent <= currentIndent) {
      errors.push(`第 ${index + 1} 行规则集字段必须写在规则集名称下面。`);
      continue;
    }
    if (["type", "behavior", "url", "path", "interval"].includes(pair.key)) {
      current[pair.key] = unquoteYamlScalar(pair.value);
    }
  }
  return { providers, errors };
}

function buildClashRuleProvidersYaml(providers) {
  const rows = (providers || [])
    .map((provider) => ({
      name: String(provider.name || "").trim(),
      type: String(provider.type || "http").trim() || "http",
      behavior: String(provider.behavior || "classical").trim() || "classical",
      url: String(provider.url || "").trim(),
      interval: String(provider.interval || "").trim()
    }))
    .filter((provider) => provider.name);
  if (!rows.length) return "";
  const lines = ["rule-providers:"];
  for (const provider of rows) {
    lines.push(`  ${quoteYamlKey(provider.name)}:`);
    lines.push(`    type: ${quoteYamlScalar(provider.type)}`);
    lines.push(`    behavior: ${quoteYamlScalar(provider.behavior)}`);
    if (provider.url) lines.push(`    url: ${quoteYamlScalar(provider.url)}`);
    lines.push(`    path: ${quoteYamlScalar(clashRuleProviderDefaultPath(provider.name))}`);
    if (provider.interval) lines.push(`    interval: ${quoteYamlScalar(provider.interval)}`);
  }
  return lines.join("\n");
}

function renderClashRuleProviderTypeOptions(selected) {
  return CLASH_RULE_PROVIDER_TYPES
    .map((type) => `<option value="${type}"${type === selected ? " selected" : ""}>${type}</option>`)
    .join("");
}

function renderClashRuleProviderBehaviorOptions(selected) {
  return CLASH_RULE_PROVIDER_BEHAVIORS
    .map((behavior) => `<option value="${behavior}"${behavior === selected ? " selected" : ""}>${behavior}</option>`)
    .join("");
}

function renderClashRuleProviderRow(provider) {
  const normalized = { ...defaultClashRuleProvider(), ...(provider || {}) };
  return `
    <div class="clash-rule-provider-row" data-clash-rule-provider>
      <label>
        <span>${escapeHtml(t("clashRuleProviderName"))}</span>
        ${inputWithTitle('data-clash-rule-provider-part="name"', normalized.name)}
      </label>
      <label>
        <span>${escapeHtml(t("clashRuleProviderType"))}</span>
        <select data-clash-rule-provider-part="type">${renderClashRuleProviderTypeOptions(normalized.type)}</select>
      </label>
      <label>
        <span>${escapeHtml(t("clashRuleProviderBehavior"))}</span>
        <select data-clash-rule-provider-part="behavior">${renderClashRuleProviderBehaviorOptions(normalized.behavior)}</select>
      </label>
      <label>
        <span>${escapeHtml(t("clashRuleProviderUrl"))}</span>
        ${inputWithTitle('data-clash-rule-provider-part="url" dir="rtl"', normalized.url)}
      </label>
      <label>
        <span>${escapeHtml(t("clashRuleProviderInterval"))}</span>
        <input data-clash-rule-provider-part="interval" inputmode="numeric" value="${escapeHtml(normalized.interval)}">
      </label>
      <div class="clash-rule-provider-actions">
        <button class="danger" data-clash-rule-provider-remove type="button">${escapeHtml(t("remove"))}</button>
      </div>
    </div>
  `;
}

function renderClashRuleProviderEmpty() {
  return `<div class="clash-rule-provider-empty">${escapeHtml(t("clashRuleProviderNoRows"))}</div>`;
}

function readClashRuleProviderRow(row) {
  return {
    name: row.querySelector('[data-clash-rule-provider-part="name"]')?.value.trim() || "",
    type: row.querySelector('[data-clash-rule-provider-part="type"]')?.value || "http",
    behavior: row.querySelector('[data-clash-rule-provider-part="behavior"]')?.value || "classical",
    url: row.querySelector('[data-clash-rule-provider-part="url"]')?.value.trim() || "",
    interval: row.querySelector('[data-clash-rule-provider-part="interval"]')?.value.trim() || ""
  };
}

function readClashRuleProviderRows() {
  return Array.from(refs.clashRuleProviderRows.querySelectorAll("[data-clash-rule-provider]")).map(readClashRuleProviderRow);
}

function renderClashRuleProviderRowsFromYaml(value, options = {}) {
  const { providers } = parseClashRuleProvidersYaml(value);
  refs.clashRuleProviderRows.innerHTML = providers.length > 0
    ? providers.map(renderClashRuleProviderRow).join("")
    : renderClashRuleProviderEmpty();
  if (options.updateOutput) {
    updateClashRuleProviderOutput();
  } else {
    validateCurrentClashRuleProviders();
  }
}

function validateClashRuleProviderRows(providers, errors = []) {
  const validation = { errors: [...errors], warnings: [] };
  const names = new Set();
  providers.forEach((provider, index) => {
    const rowNumber = index + 1;
    if (!provider.name) {
      validation.errors.push(`第 ${rowNumber} 个规则集缺少名称。`);
    } else if (names.has(provider.name)) {
      validation.errors.push(`规则集名称 ${provider.name} 重复。`);
    }
    names.add(provider.name);
    if (!CLASH_RULE_PROVIDER_TYPES.includes(provider.type)) {
      validation.errors.push(`${provider.name || `第 ${rowNumber} 个规则集`} 的 type 只能是 http 或 file。`);
    }
    if (!CLASH_RULE_PROVIDER_BEHAVIORS.includes(provider.behavior)) {
      validation.errors.push(`${provider.name || `第 ${rowNumber} 个规则集`} 的 behavior 只能是 classical、domain 或 ipcidr。`);
    }
    if (provider.type === "http" && !provider.url) {
      validation.errors.push(`${provider.name || `第 ${rowNumber} 个规则集`} 的 http 类型必须填写 URL。`);
    }
    if (provider.interval && (!/^\d+$/.test(provider.interval) || Number(provider.interval) <= 0)) {
      validation.errors.push(`${provider.name || `第 ${rowNumber} 个规则集`} 的更新间隔必须是正整数。`);
    }
  });
  return validation;
}

function renderClashRuleProviderValidation(validation) {
  const messages = [
    ...(validation?.errors || []).map((message) => ({ type: "error", message })),
    ...(validation?.warnings || []).map((message) => ({ type: "warning", message }))
  ];
  refs.clashRuleProviderValidation.classList.toggle("hidden", messages.length === 0);
  refs.clashRuleProviderValidation.innerHTML = messages
    .map(({ type, message }) => `<div class="${type}">${escapeHtml(message)}</div>`)
    .join("");
}

function validateCurrentClashRuleProviders() {
  const parsed = parseClashRuleProvidersYaml(refs.clashRuleProviders.value);
  const validation = validateClashRuleProviderRows(parsed.providers, parsed.errors);
  renderClashRuleProviderValidation(validation);
  return validation;
}

function updateClashRuleProviderOutput() {
  if (!isModeTogglePressed(refs.clashRuleProviderAdvancedMode)) {
    refs.clashRuleProviders.value = buildClashRuleProvidersYaml(readClashRuleProviderRows());
  }
  syncConfigCodeEditor(refs.clashRuleProviders);
  validateCurrentClashRuleProviders();
  reconcileClashRulesWithProviders();
}

function handleClashRuleProvidersInput() {
  validateCurrentClashRuleProviders();
  reconcileClashRulesWithProviders();
}

function removeClashRuleProviderByName(name) {
  const target = String(name || "").trim();
  if (!target) return false;
  const providers = parseClashRuleProvidersYaml(refs.clashRuleProviders.value).providers;
  const nextProviders = providers.filter((provider) => provider.name !== target);
  if (nextProviders.length === providers.length) return false;
  refs.clashRuleProviderRows.innerHTML = nextProviders.length > 0
    ? nextProviders.map(renderClashRuleProviderRow).join("")
    : renderClashRuleProviderEmpty();
  refs.clashRuleProviders.value = buildClashRuleProvidersYaml(nextProviders);
  syncConfigCodeEditor(refs.clashRuleProviders);
  validateCurrentClashRuleProviders();
  return true;
}

function syncClashRuleProviderMode() {
  const advanced = isModeTogglePressed(refs.clashRuleProviderAdvancedMode);
  refs.clashRuleProviderStructuredEditor.classList.toggle("hidden", advanced);
  refs.clashRuleProviders.readOnly = !advanced;
  refs.clashRuleProviders.classList.toggle("generated-code", !advanced);
  syncTextModeLabels(refs.clashRuleProviderAdvancedMode, null, advanced);
  syncConfigCodeEditor(refs.clashRuleProviders);
}

function toggleClashRuleProviderAdvancedMode() {
  const advanced = !isModeTogglePressed(refs.clashRuleProviderAdvancedMode);
  if (!advanced) {
    const validation = validateCurrentClashRuleProviders();
    if (validation.errors.length > 0) {
      window.alert(t("clashRuleProviderValidationError"));
      return;
    }
  }
  setModeTogglePressed(refs.clashRuleProviderAdvancedMode, advanced);
  if (!advanced) {
    renderClashRuleProviderRowsFromYaml(refs.clashRuleProviders.value, { updateOutput: true });
  }
  syncClashRuleProviderMode();
  validateCurrentClashRuleProviders();
}

function addClashRuleProvider() {
  refs.clashRuleProviderRows.querySelector(".clash-rule-provider-empty")?.remove();
  refs.clashRuleProviderRows.insertAdjacentHTML("beforeend", renderClashRuleProviderRow(defaultClashRuleProvider()));
  updateClashRuleProviderOutput();
}

function ensureClashRuleProviderEmptyState() {
  if (refs.clashRuleProviderRows.querySelector("[data-clash-rule-provider]")) return;
  refs.clashRuleProviderRows.innerHTML = renderClashRuleProviderEmpty();
}

function handleClashRuleProviderListClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  const row = target?.closest("[data-clash-rule-provider]");
  if (!row) return;
  if (target.closest("[data-clash-rule-provider-remove]")) {
    row.remove();
    ensureClashRuleProviderEmptyState();
    updateClashRuleProviderOutput();
  }
}

function handleClashRuleProviderListChange(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target?.closest("[data-clash-rule-provider]")) return;
  updateClashRuleProviderOutput();
}

const CLASH_BUILT_IN_POLICIES = ["Proxy", "DIRECT", "REJECT", "REJECT-DROP", "PASS", "GLOBAL"];
const CLASH_RULE_TYPES = [
  "DOMAIN",
  "DOMAIN-SUFFIX",
  "DOMAIN-KEYWORD",
  "DOMAIN-REGEX",
  "GEOSITE",
  "GEOIP",
  "IP-CIDR",
  "IP-CIDR6",
  "IP-ASN",
  "SRC-IP-CIDR",
  "SRC-PORT",
  "DST-PORT",
  "PROCESS-NAME",
  "PROCESS-PATH",
  "MATCH",
  "FINAL"
];
const CLASH_VALUELESS_RULE_TYPES = new Set(["MATCH", "FINAL"]);
const CLASH_RULE_OPTION_ORDER = ["no-resolve"];
const CLASH_NO_RESOLVE_RULE_TYPES = new Set(["RULE-SET", "GEOIP", "IP-CIDR", "IP-CIDR6", "IP-ASN"]);

function parseClashRulesYaml(value) {
  const text = String(value || "").replace(/\r\n?/g, "\n").trimEnd();
  if (!text.trim()) return { rules: [], errors: [] };
  const lines = text.split("\n");
  const errors = [];
  const rules = [];
  const firstContentIndex = lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith("#");
  });
  if (firstContentIndex < 0) return { rules, errors };

  const firstPair = parseYamlPair(lines[firstContentIndex].trim());
  if (firstPair?.key !== "rules") {
    errors.push(`第 ${firstContentIndex + 1} 行必须以 rules: 开始。`);
    return { rules, errors };
  }

  const baseIndent = yamlIndent(lines[firstContentIndex]);
  const inlineValue = stripYamlComment(firstPair.value);
  if (inlineValue && inlineValue !== "[]") {
    errors.push(`第 ${firstContentIndex + 1} 行 rules 必须使用 YAML 列表形式。`);
  }

  for (let index = firstContentIndex + 1; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = yamlIndent(rawLine);
    if (indent <= baseIndent) {
      errors.push(`第 ${index + 1} 行只能包含 rules 配置块。`);
      continue;
    }
    if (!trimmed.startsWith("-")) {
      errors.push(`第 ${index + 1} 行必须是 YAML 列表项。`);
      continue;
    }
    const item = trimmed.slice(1).trim();
    if (!item) {
      errors.push(`第 ${index + 1} 行规则不能为空。`);
      continue;
    }
    rules.push(unquoteYamlScalar(item));
  }
  return { rules, errors };
}

function buildClashRulesYaml(lines) {
  const rules = (lines || []).map((line) => String(line || "").trim()).filter(Boolean);
  if (!rules.length) return "";
  return ["rules:", ...rules.map((line) => `  - ${quoteYamlListItem(line)}`)].join("\n");
}

function clashRuleProviderNames() {
  return parseClashRuleProvidersYaml(refs.clashRuleProviders.value).providers
    .map((provider) => provider.name)
    .filter(Boolean);
}

function clashPolicyCandidates() {
  return [...new Set([...groupEntries().map(([name]) => name), ...CLASH_BUILT_IN_POLICIES])];
}

function normalizeClashRulePolicy(policy) {
  const trimmed = String(policy || "").trim();
  return isValidClashPolicy(trimmed) ? trimmed : "Proxy";
}

function isKnownClashPolicy(policy) {
  return clashPolicyCandidates().includes(String(policy || "").trim());
}

function isValidClashPolicy(policy) {
  const trimmed = String(policy || "").trim();
  return Boolean(trimmed) && !/[\r\n,[\]]/.test(trimmed);
}

function renderClashPolicyOptions(selected) {
  const selectedPolicy = normalizeClashRulePolicy(selected);
  const candidates = clashPolicyCandidates();
  if (selectedPolicy && !candidates.includes(selectedPolicy)) {
    candidates.push(selectedPolicy);
  }
  return candidates
    .map((policy) => `<option value="${escapeHtml(policy)}"${policy === selectedPolicy ? " selected" : ""}>${escapeHtml(renderPolicyLabel(policy))}</option>`)
    .join("");
}

function renderClashRuleProviderNameOptions(selected) {
  const normalized = String(selected || "").trim();
  const names = clashRuleProviderNames();
  if (normalized && !names.includes(normalized)) names.unshift(normalized);
  if (!names.length) return `<option value="">${escapeHtml(t("clashRuleProviderNoRows"))}</option>`;
  return names
    .map((name) => `<option value="${escapeHtml(name)}"${name === normalized ? " selected" : ""}>${escapeHtml(name)}</option>`)
    .join("");
}

function allowedClashRuleOptions(kind, ruleType) {
  const type = kind === "rule-set" ? "RULE-SET" : String(ruleType || "").trim().toUpperCase();
  return CLASH_NO_RESOLVE_RULE_TYPES.has(type) ? new Set(["no-resolve"]) : new Set();
}

function normalizeRuleOptions(value, allowed, optionOrder) {
  const requested = String(value || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  const output = [];
  for (const option of optionOrder) {
    if (requested.includes(option) && allowed.has(option)) output.push(option);
  }
  return output.join(",");
}

function validateRuleOptions(options, allowed, optionOrder) {
  const values = (options || []).map((option) => option.trim().toLowerCase()).filter(Boolean);
  const uniqueValues = new Set(values);
  if (uniqueValues.size !== values.length) return "附加参数不能重复";
  const invalid = values.filter((option) => !allowed.has(option) || !optionOrder.includes(option));
  if (invalid.length === 0) return "";
  const allowedText = [...allowed].join(", ") || t("surgeRuleOptionNone");
  return `${t("surgeRuleOptionInvalid")} 可用参数：${allowedText}。`;
}

function normalizeClashRuleOptions(value, kind, ruleType) {
  return normalizeRuleOptions(value, allowedClashRuleOptions(kind, ruleType), CLASH_RULE_OPTION_ORDER);
}

function validateClashRuleOptions(options, kind, ruleType) {
  return validateRuleOptions(options, allowedClashRuleOptions(kind, ruleType), CLASH_RULE_OPTION_ORDER);
}

function renderClashRuleOptionChoices(kind, ruleType, selected) {
  const selectedValue = normalizeClashRuleOptions(selected, kind, ruleType);
  const choices = [["", t("surgeRuleOptionNone")]];
  for (const option of CLASH_RULE_OPTION_ORDER) {
    if (allowedClashRuleOptions(kind, ruleType).has(option)) choices.push([option, option]);
  }
  return choices
    .map(([value, label]) => `<option value="${escapeHtml(value)}"${value === selectedValue ? " selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
}

function validateClashRuleLine(line, lineNumber) {
  const trimmed = String(line || "").trim();
  const result = { errors: [], warnings: [] };
  if (!trimmed || trimmed.startsWith("#")) return result;
  const parts = splitSurgeRuleLine(trimmed);
  const type = (parts[0] || "").trim().toUpperCase();
  if (!type) {
    result.errors.push(`第 ${lineNumber} 行缺少规则类型`);
    return result;
  }
  if (parts.some((part) => !part.trim())) {
    result.errors.push(`第 ${lineNumber} 行存在空参数`);
    return result;
  }

  let policy = "";
  if (type === "RULE-SET") {
    if (parts.length < 3) {
      result.errors.push(`第 ${lineNumber} 行规则集语法应为 RULE-SET,规则集名称,策略`);
      return result;
    }
    const providerName = parts[1] || "";
    if (!clashRuleProviderNames().includes(providerName)) {
      result.errors.push(`第 ${lineNumber} 行${t("clashRuleUnknownProvider")}`);
    }
    policy = parts[2] || "";
    const optionError = validateClashRuleOptions(parts.slice(3), "rule-set", "RULE-SET");
    if (optionError) result.errors.push(`第 ${lineNumber} 行${optionError}`);
  } else if (CLASH_VALUELESS_RULE_TYPES.has(type)) {
    if (parts.length < 2) {
      result.errors.push(`第 ${lineNumber} 行 ${type} 规则缺少策略出口`);
      return result;
    }
    policy = parts[1] || "";
    const optionError = validateClashRuleOptions(parts.slice(2), "single", type);
    if (optionError) result.errors.push(`第 ${lineNumber} 行${optionError}`);
  } else {
    if (!CLASH_RULE_TYPES.includes(type)) {
      result.errors.push(`第 ${lineNumber} 行规则类型 ${type} 不受支持`);
      return result;
    }
    if (parts.length < 3) {
      result.errors.push(`第 ${lineNumber} 行语法应为 类型,匹配值,策略`);
      return result;
    }
    policy = parts[2] || "";
    const optionError = validateClashRuleOptions(parts.slice(3), "single", type);
    if (optionError) result.errors.push(`第 ${lineNumber} 行${optionError}`);
  }

  if (!isValidClashPolicy(policy)) {
    result.errors.push(`第 ${lineNumber} 行策略出口格式无效`);
  } else if (!isKnownClashPolicy(policy)) {
    result.errors.push(`第 ${lineNumber} 行${t("clashRuleUnknownPolicy")}`);
  }
  return result;
}

function effectiveClashRuleEntries(lines) {
  return (lines || []).map((line, index) => {
    const trimmed = String(line || "").trim();
    if (!trimmed || trimmed.startsWith("#")) return null;
    return {
      lineNumber: index + 1,
      type: (splitSurgeRuleLine(trimmed)[0] || "").trim().toUpperCase()
    };
  }).filter(Boolean);
}

function validateClashRuleLines(lines, errors = []) {
  const validation = { errors: [...errors], warnings: [] };
  (lines || []).forEach((line, index) => {
    const result = validateClashRuleLine(line, index + 1);
    validation.errors.push(...result.errors);
    validation.warnings.push(...result.warnings);
  });
  const effectiveRules = effectiveClashRuleEntries(lines);
  const fallbackRules = effectiveRules.filter((rule) => CLASH_VALUELESS_RULE_TYPES.has(rule.type));
  if (fallbackRules.length === 0) {
    validation.errors.push(t("clashRuleMatchMissing"));
  } else if (fallbackRules.length > 1) {
    validation.errors.push(t("clashRuleMatchDuplicate"));
  } else if (!CLASH_VALUELESS_RULE_TYPES.has(effectiveRules[effectiveRules.length - 1]?.type || "")) {
    validation.errors.push(t("clashRuleMatchNotLast"));
  }
  return validation;
}

function renderClashRuleValidation(validation) {
  const messages = [
    ...(validation?.errors || []).map((message) => ({ type: "error", message })),
    ...(validation?.warnings || []).map((message) => ({ type: "warning", message }))
  ];
  refs.clashRuleValidation.classList.toggle("hidden", messages.length === 0);
  refs.clashRuleValidation.innerHTML = messages
    .map(({ type, message }) => `<div class="${type}">${escapeHtml(message)}</div>`)
    .join("");
}

function currentClashRuleLines() {
  return isModeTogglePressed(refs.clashRuleAdvancedMode)
    ? parseClashRulesYaml(refs.clashRules.value).rules
    : buildClashRuleLines(readClashRuleRows());
}

function validateCurrentClashRules() {
  const parsed = parseClashRulesYaml(refs.clashRules.value);
  const lines = isModeTogglePressed(refs.clashRuleAdvancedMode) ? parsed.rules : buildClashRuleLines(readClashRuleRows());
  const validation = validateClashRuleLines(lines, isModeTogglePressed(refs.clashRuleAdvancedMode) ? parsed.errors : []);
  renderClashRuleValidation(validation);
  return validation;
}

function renderValidationMessages(container, validation) {
  const messages = [
    ...(validation?.errors || []).map((message) => ({ type: "error", message })),
    ...(validation?.warnings || []).map((message) => ({ type: "warning", message }))
  ];
  container.classList.toggle("hidden", messages.length === 0);
  container.innerHTML = messages
    .map(({ type, message }) => `<div class="${type}">${escapeHtml(message)}</div>`)
    .join("");
}

function validateCurrentStashHosts() {
  const validation = validateSurgeHostLines(textToLines(refs.stashHosts.value));
  renderValidationMessages(refs.stashHostValidation, validation);
  return validation;
}

function validateCurrentStashUrlRewrite() {
  const validation = validateSurgeUrlRewriteLines(textToLines(refs.stashUrlRewrite.value));
  renderValidationMessages(refs.stashUrlRewriteValidation, validation);
  return validation;
}

function validateCurrentStashScripts() {
  const validation = validateStashScriptLines(textToLines(refs.stashScripts.value));
  renderValidationMessages(refs.stashScriptValidation, validation);
  return validation;
}

function validateCurrentStashRuleProviders() {
  const parsed = parseClashRuleProvidersYaml(refs.stashRuleProviders.value);
  const validation = validateClashRuleProviderRows(parsed.providers, parsed.errors);
  renderValidationMessages(refs.stashRuleProviderValidation, validation);
  return validation;
}

function stashRuleProviderNames() {
  return parseClashRuleProvidersYaml(refs.stashRuleProviders.value).providers
    .map((provider) => provider.name)
    .filter(Boolean);
}

function validateCurrentStashRules() {
  const parsed = parseClashRulesYaml(refs.stashRules.value);
  const validation = { errors: [...parsed.errors], warnings: [] };
  const providerNames = new Set(stashRuleProviderNames());
  const policies = new Set([...groupEntries().map(([name]) => name), ...CLASH_BUILT_IN_POLICIES]);
  const effectiveRules = effectiveClashRuleEntries(parsed.rules);
  parsed.rules.forEach((line, index) => {
    const parts = splitSurgeRuleLine(line);
    const type = (parts[0] || "").trim().toUpperCase();
    if (!type || type.startsWith("#")) return;
    if (type === "RULE-SET") {
      const provider = (parts[1] || "").trim();
      const policy = (parts[2] || "").trim();
      if (!provider || !providerNames.has(provider)) {
        validation.errors.push(`第 ${index + 1} 行${t("clashRuleUnknownProvider")}`);
      }
      if (!policy || !policies.has(policy)) {
        validation.errors.push(`第 ${index + 1} 行${t("clashRuleUnknownPolicy")}`);
      }
      return;
    }
    const targetIndex = CLASH_VALUELESS_RULE_TYPES.has(type) ? 1 : 2;
    const policy = (parts[targetIndex] || "").trim();
    if (!policy || !policies.has(policy)) {
      validation.errors.push(`第 ${index + 1} 行${t("clashRuleUnknownPolicy")}`);
    }
  });
  const fallbackRules = effectiveRules.filter((rule) => CLASH_VALUELESS_RULE_TYPES.has(rule.type));
  if (fallbackRules.length === 0) {
    validation.errors.push(t("clashRuleMatchMissing"));
  } else if (fallbackRules.length > 1) {
    validation.errors.push(t("clashRuleMatchDuplicate"));
  } else if (!CLASH_VALUELESS_RULE_TYPES.has(effectiveRules[effectiveRules.length - 1]?.type || "")) {
    validation.errors.push(t("clashRuleMatchNotLast"));
  }
  renderValidationMessages(refs.stashRuleValidation, validation);
  return validation;
}

function parseClashRuleLine(line) {
  const parts = splitSurgeRuleLine(line);
  const type = (parts[0] || "").trim().toUpperCase();
  if (!type) return null;
  if (type === "RULE-SET") {
    return {
      kind: "rule-set",
      setName: parts[1] || "",
      policy: normalizeClashRulePolicy(parts[2] || ""),
      options: parts.slice(3).join(", ")
    };
  }
  const valueless = CLASH_VALUELESS_RULE_TYPES.has(type);
  const policyIndex = valueless ? 1 : 2;
  return {
    kind: "single",
    ruleType: type,
    value: valueless ? "" : parts[1] || "",
    policy: normalizeClashRulePolicy(parts[policyIndex] || ""),
    options: parts.slice(policyIndex + 1).join(", ")
  };
}

function fallbackClashRule() {
  return { kind: "single", ruleType: "MATCH", value: "", policy: normalizeClashRulePolicy("Proxy"), options: "" };
}

function isFallbackClashRule(rule) {
  return CLASH_VALUELESS_RULE_TYPES.has(String(rule?.ruleType || "").trim().toUpperCase());
}

function normalizeClashRuleRows(rules) {
  const list = Array.isArray(rules) ? rules : [];
  const fallbackRule = list.find(isFallbackClashRule) || fallbackClashRule();
  return [
    ...list.filter((rule) => !isFallbackClashRule(rule)),
    { ...fallbackRule, kind: "single", value: "" }
  ];
}

function defaultClashRule(kind = "single") {
  const policy = normalizeClashRulePolicy("Proxy");
  return kind === "rule-set"
    ? { kind: "rule-set", setName: clashRuleProviderNames()[0] || "", policy, options: "" }
    : { kind: "single", ruleType: "DOMAIN-SUFFIX", value: "", policy, options: "" };
}

function renderClashRuleKindOptions(selected) {
  return [
    ["single", t("clashRuleKindSingle")],
    ["rule-set", t("clashRuleKindRuleSet")]
  ].map(([value, label]) => `<option value="${value}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");
}

function renderClashRuleTypeOptions(selected, lockedFallback = false) {
  if (lockedFallback) return `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)}</option>`;
  const editableTypes = CLASH_RULE_TYPES.filter((type) => !CLASH_VALUELESS_RULE_TYPES.has(type));
  const types = editableTypes.includes(selected) ? editableTypes : [selected, ...editableTypes].filter(Boolean);
  return types.map((type) => `<option value="${escapeHtml(type)}"${type === selected ? " selected" : ""}>${escapeHtml(type)}</option>`).join("");
}

function renderClashRuleRow(rule) {
  const normalized = rule || defaultClashRule();
  const kind = normalized.kind === "rule-set" ? "rule-set" : "single";
  const ruleType = normalized.ruleType || "DOMAIN-SUFFIX";
  const lockedFallback = kind === "single" && CLASH_VALUELESS_RULE_TYPES.has(ruleType);
  const valueless = CLASH_VALUELESS_RULE_TYPES.has(ruleType);
  const disabledAttr = lockedFallback ? " disabled" : "";
  const mainField = kind === "rule-set"
    ? `<label>
        <span>${escapeHtml(t("clashRuleSetName"))}</span>
        <select data-clash-rule-part="setName">${renderClashRuleProviderNameOptions(normalized.setName || "")}</select>
      </label>`
    : `<label>
        <span>${escapeHtml(t("clashRuleType"))}</span>
        <select data-clash-rule-part="ruleType"${disabledAttr}>${renderClashRuleTypeOptions(ruleType, lockedFallback)}</select>
        ${lockedFallback ? `<small>${escapeHtml(t("clashRuleMatchLocked"))}</small>` : ""}
      </label>
      <label>
        <span>${escapeHtml(t("clashRuleValue"))}</span>
        ${inputWithTitle(`data-clash-rule-part="value"${valueless ? " disabled" : ""}`, normalized.value || "")}
      </label>`;
  return `
    <div class="clash-rule-row ${kind === "rule-set" ? "rule-set" : "single"}" data-clash-rule${lockedFallback ? " data-clash-rule-fallback" : ""}>
      <label>
        <span>${escapeHtml(t("clashRuleKind"))}</span>
        <select data-clash-rule-part="kind"${disabledAttr}>${renderClashRuleKindOptions(kind)}</select>
      </label>
      ${mainField}
      <label>
        <span>${escapeHtml(t("clashRulePolicy"))}</span>
        <select data-clash-rule-part="policy">${renderClashPolicyOptions(normalized.policy)}</select>
      </label>
      <label>
        <span>${escapeHtml(t("clashRuleOptions"))}</span>
        <select data-clash-rule-part="options">${renderClashRuleOptionChoices(kind, ruleType, normalized.options || "")}</select>
      </label>
      <div class="clash-rule-actions">
        <button class="btn" data-clash-rule-move="up" type="button"${disabledAttr}>${escapeHtml(t("moveUp"))}</button>
        <button class="btn" data-clash-rule-move="down" type="button"${disabledAttr}>${escapeHtml(t("moveDown"))}</button>
        <button class="danger" data-clash-rule-remove type="button"${disabledAttr}>${escapeHtml(t("remove"))}</button>
      </div>
    </div>
  `;
}

function renderClashRuleEmpty() {
  return `<div class="clash-rule-empty">${escapeHtml(t("clashRuleNoRows"))}</div>`;
}

function renderClashRuleRowsFromYaml(value, options = {}) {
  const parsed = parseClashRulesYaml(value);
  const rules = normalizeClashRuleRows(parsed.rules.map(parseClashRuleLine).filter(Boolean));
  refs.clashRuleRows.innerHTML = rules.length > 0
    ? rules.map(renderClashRuleRow).join("")
    : renderClashRuleEmpty();
  if (options.updateOutput) {
    updateClashRuleOutput();
  } else {
    validateCurrentClashRules();
  }
}

function readClashRuleRow(row) {
  const kind = row.querySelector('[data-clash-rule-part="kind"]')?.value || "single";
  const policy = normalizeClashRulePolicy(row.querySelector('[data-clash-rule-part="policy"]')?.value || "");
  const options = row.querySelector('[data-clash-rule-part="options"]')?.value.trim() || "";
  if (kind === "rule-set") {
    return {
      kind,
      setName: row.querySelector('[data-clash-rule-part="setName"]')?.value.trim() || "",
      policy,
      options: normalizeClashRuleOptions(options, kind, "RULE-SET")
    };
  }
  const ruleType = (row.querySelector('[data-clash-rule-part="ruleType"]')?.value || "DOMAIN-SUFFIX").trim().toUpperCase();
  return {
    kind: "single",
    ruleType,
    value: row.querySelector('[data-clash-rule-part="value"]')?.value.trim() || "",
    policy,
    options: normalizeClashRuleOptions(options, kind, ruleType)
  };
}

function readClashRuleRows() {
  return Array.from(refs.clashRuleRows.querySelectorAll("[data-clash-rule]")).map(readClashRuleRow);
}

function buildClashRuleLine(rule) {
  if (rule.kind === "rule-set") {
    const name = String(rule.setName || "").trim();
    const options = normalizeClashRuleOptions(rule.options, "rule-set", "RULE-SET");
    const suffix = options ? `,${options}` : "";
    return `RULE-SET,${name},${normalizeClashRulePolicy(rule.policy)}${suffix}`;
  }
  const type = String(rule.ruleType || "").trim().toUpperCase();
  const policy = normalizeClashRulePolicy(rule.policy);
  const options = normalizeClashRuleOptions(rule.options, "single", type);
  const suffix = options ? `,${options}` : "";
  if (!type) return "";
  if (CLASH_VALUELESS_RULE_TYPES.has(type)) {
    return `${type},${policy}${suffix}`;
  }
  const value = String(rule.value || "").trim();
  return `${type},${value},${policy}${suffix}`;
}

function buildClashRuleLines(rules) {
  return normalizeClashRuleRows(rules).map(buildClashRuleLine).filter(Boolean);
}

function sameLines(left, right) {
  if (left.length !== right.length) return false;
  return left.every((line, index) => line === right[index]);
}

function currentClashRuleRows() {
  return isModeTogglePressed(refs.clashRuleAdvancedMode)
    ? parseClashRulesYaml(refs.clashRules.value).rules.map(parseClashRuleLine).filter(Boolean)
    : readClashRuleRows();
}

function reconcileClashRulesWithProviders() {
  const providerNames = clashRuleProviderNames();
  const providerSet = new Set(providerNames);
  const currentRows = normalizeClashRuleRows(currentClashRuleRows());
  const retainedRows = currentRows.filter((rule) => rule.kind !== "rule-set" || providerSet.has(String(rule.setName || "").trim()));
  const configured = new Set(retainedRows
    .filter((rule) => rule.kind === "rule-set")
    .map((rule) => String(rule.setName || "").trim())
    .filter(Boolean));
  const missingRows = providerNames
    .filter((name) => !configured.has(name))
    .map((name) => ({ kind: "rule-set", setName: name, policy: "Proxy", options: "" }));
  const fallbackRows = retainedRows.filter(isFallbackClashRule);
  const reconciledRows = normalizeClashRuleRows([
    ...retainedRows.filter((rule) => !isFallbackClashRule(rule)),
    ...missingRows,
    ...fallbackRows
  ]);
  const beforeLines = buildClashRuleLines(currentRows);
  const afterLines = buildClashRuleLines(reconciledRows);
  if (sameLines(beforeLines, afterLines)) return false;
  refs.clashRuleRows.innerHTML = reconciledRows.map(renderClashRuleRow).join("");
  refs.clashRules.value = buildClashRulesYaml(afterLines);
  syncConfigCodeEditor(refs.clashRules);
  validateCurrentClashRules();
  return true;
}

function updateClashRuleOutput() {
  if (!isModeTogglePressed(refs.clashRuleAdvancedMode)) {
    refs.clashRules.value = buildClashRulesYaml(buildClashRuleLines(readClashRuleRows()));
  }
  syncConfigCodeEditor(refs.clashRules);
  validateCurrentClashRules();
  reconcileClashRulesWithProviders();
}

function syncClashRuleMode() {
  const advanced = isModeTogglePressed(refs.clashRuleAdvancedMode);
  refs.clashRuleStructuredEditor.classList.toggle("hidden", advanced);
  refs.clashRuleStructuredActions.classList.toggle("hidden", advanced);
  refs.clashRules.readOnly = !advanced;
  refs.clashRules.classList.toggle("generated-code", !advanced);
  syncTextModeLabels(refs.clashRuleAdvancedMode, null, advanced);
  syncConfigCodeEditor(refs.clashRules);
  validateCurrentClashRules();
}

function toggleClashRuleAdvancedMode() {
  const advanced = !isModeTogglePressed(refs.clashRuleAdvancedMode);
  if (!advanced) {
    const validation = validateCurrentClashRules();
    if (validation.errors.length > 0) {
      window.alert(t("clashRuleValidationError"));
      return;
    }
  }
  setModeTogglePressed(refs.clashRuleAdvancedMode, advanced);
  if (!advanced) {
    renderClashRuleRowsFromYaml(refs.clashRules.value, { updateOutput: true });
  }
  syncClashRuleMode();
  validateCurrentClashRules();
}

function addClashRule(kind) {
  refs.clashRuleRows.querySelector(".clash-rule-empty")?.remove();
  const fallbackRow = refs.clashRuleRows.querySelector("[data-clash-rule-fallback]");
  const html = renderClashRuleRow(defaultClashRule(kind));
  if (fallbackRow) {
    fallbackRow.insertAdjacentHTML("beforebegin", html);
  } else {
    refs.clashRuleRows.insertAdjacentHTML("beforeend", html);
  }
  updateClashRuleOutput();
}

function ensureClashRuleEmptyState() {
  if (refs.clashRuleRows.querySelector("[data-clash-rule]")) return;
  refs.clashRuleRows.innerHTML = renderClashRuleEmpty();
}

function rerenderClashRuleRow(row) {
  const rule = readClashRuleRow(row);
  row.outerHTML = renderClashRuleRow(rule);
  updateClashRuleOutput();
}

function handleClashRuleListClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  const row = target?.closest("[data-clash-rule]");
  if (!row) return;
  if (row.matches("[data-clash-rule-fallback]")) return;
  if (target.closest("[data-clash-rule-remove]")) {
    const rule = readClashRuleRow(row);
    const setName = rule.kind === "rule-set" ? String(rule.setName || "").trim() : "";
    if (setName && clashRuleProviderNames().includes(setName)) {
      if (!window.confirm(formatMessage("clashRuleSetDeleteProviderConfirm", { name: setName }))) return;
      removeClashRuleProviderByName(setName);
    }
    row.remove();
    ensureClashRuleEmptyState();
    updateClashRuleOutput();
    return;
  }
  const move = target.closest("[data-clash-rule-move]")?.dataset.clashRuleMove;
  if (move === "up") {
    const previous = row.previousElementSibling?.matches("[data-clash-rule]") ? row.previousElementSibling : null;
    if (previous) refs.clashRuleRows.insertBefore(row, previous);
    updateClashRuleOutput();
    return;
  }
  if (move === "down") {
    const next = row.nextElementSibling?.matches("[data-clash-rule]") ? row.nextElementSibling : null;
    if (next?.matches("[data-clash-rule-fallback]")) return;
    if (next) refs.clashRuleRows.insertBefore(next, row);
    updateClashRuleOutput();
  }
}

function handleClashRuleListChange(event) {
  const target = event.target instanceof Element ? event.target : null;
  const row = target?.closest("[data-clash-rule]");
  if (!row) return;
  if (target.matches('[data-clash-rule-part="kind"], [data-clash-rule-part="ruleType"]')) {
    rerenderClashRuleRow(row);
    return;
  }
  updateClashRuleOutput();
}

function groupEntries() {
  return Object.entries(state.groups || {});
}

function setGroupEntries(entries) {
  state.groups = Object.fromEntries(entries);
}

const GROUP_TYPES = ["select", "url-test", "fallback", "load-balance", "subnet"];
const GROUP_OPTION_FIELDS = new Set(["url", "interval"]);
const NAME_LOCKED_GROUP_NAMES = new Set(["Proxy"]);
const SUBNET_PARAMETERS = ["SSID", "BSSID", "ROUTER", "TYPE"];
const SUBNET_NETWORK_TYPES = ["WIFI", "WIRED", "CELLULAR"];
const SUBNET_BUILT_IN_POLICIES = ["Proxy", "DIRECT", "REJECT", "REJECT-DROP", "REJECT-NO-DROP", "REJECT-TINYGIF"];
const SURGE_BUILT_IN_POLICY_LABELS = {
  DIRECT: "直连 (DIRECT)",
  REJECT: "拒绝请求 (REJECT)",
  "REJECT-DROP": "静默丢弃 (REJECT-DROP)",
  "REJECT-NO-DROP": "拒绝但不自动静默丢弃 (REJECT-NO-DROP)",
  "REJECT-TINYGIF": "返回 1px 透明图 (REJECT-TINYGIF)"
};
const SURGE_RULE_TYPES = [
  "DOMAIN",
  "DOMAIN-SUFFIX",
  "DOMAIN-KEYWORD",
  "IP-CIDR",
  "IP-CIDR6",
  "GEOIP",
  "PROCESS-NAME",
  "USER-AGENT",
  "URL-REGEX",
  "SCRIPT",
  "SUBNET",
  "AND",
  "OR",
  "NOT",
  "FINAL"
];
const SURGE_VALUELESS_RULE_TYPES = new Set(["FINAL", "MATCH"]);
const SURGE_RULE_SET_TYPES = new Set(["RULE-SET", "DOMAIN-SET"]);
const SURGE_RULE_OPTION_ORDER = ["no-resolve", "extended-matching", "dns-failed"];
const SURGE_RULE_SET_OPTIONS = new Set(["no-resolve", "extended-matching"]);
const SURGE_DOMAIN_SET_OPTIONS = new Set(["extended-matching"]);
const SURGE_IP_RULE_OPTIONS = new Set(["no-resolve"]);
const SURGE_EXTENDED_MATCHING_RULE_TYPES = new Set(["DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "URL-REGEX"]);
const SURGE_FINAL_RULE_OPTIONS = new Set(["dns-failed"]);
const SURGE_VALUE_RULE_TYPES = new Set([
  "DOMAIN",
  "DOMAIN-SUFFIX",
  "DOMAIN-KEYWORD",
  "IP-CIDR",
  "IP-CIDR6",
  "GEOIP",
  "PROCESS-NAME",
  "USER-AGENT",
  "URL-REGEX",
  "SCRIPT",
  "SUBNET",
  "SRC-IP",
  "IN-PORT",
  "DEST-PORT",
  "PROTOCOL",
  "DEVICE-NAME",
  "CELLULAR-RADIO",
  "WIFI-SSID",
  "AND",
  "OR",
  "NOT"
]);
function isBuiltInGroupName(name) {
  return NAME_LOCKED_GROUP_NAMES.has(String(name || "").trim());
}

function isRemovalLockedGroupName(name) {
  return String(name || "").trim() === "Proxy";
}

function isDisableToggleAllowed(name) {
  return !isRemovalLockedGroupName(name);
}

function isGroupDisabled(name) {
  return new Set(state.disabledGroups || []).has(String(name || "").trim());
}

function setGroupDisabled(name, disabled) {
  const target = String(name || "").trim();
  const disabledGroups = new Set(state.disabledGroups || []);
  if (disabled) {
    disabledGroups.add(target);
  } else {
    disabledGroups.delete(target);
  }
  disabledGroups.delete("Proxy");
  state.disabledGroups = Array.from(disabledGroups).filter((item) => Object.prototype.hasOwnProperty.call(state.groups, item));
}

function renderSurgeHostValidation(validation) {
  const messages = [
    ...(validation?.errors || []).map((message) => ({ type: "error", message })),
    ...(validation?.warnings || []).map((message) => ({ type: "warning", message }))
  ];
  refs.surgeHostValidation.classList.toggle("hidden", messages.length === 0);
  refs.surgeHostValidation.innerHTML = messages
    .map(({ type, message }) => `<div class="${type}">${escapeHtml(message)}</div>`)
    .join("");
}

function currentSurgeHostLines() {
  return isModeTogglePressed(refs.surgeHostAdvancedMode)
    ? textToLines(refs.surgeHosts.value)
    : buildSurgeHostLines(readSurgeHostRows());
}

function validateCurrentSurgeHosts() {
  const validation = validateSurgeHostLines(currentSurgeHostLines());
  renderSurgeHostValidation(validation);
  return validation;
}

function parseSurgeHostLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";") || /^\[[^\]]+\]$/.test(trimmed)) return null;
  const { host, value } = splitSurgeHostLine(trimmed);
  return host || value ? { host, value } : null;
}

function defaultSurgeHost() {
  return { host: "", value: "" };
}

function renderSurgeHostRow(host) {
  const normalized = host || defaultSurgeHost();
  return `
    <div class="surge-host-row" data-surge-host>
      <label>
        <span>${escapeHtml(t("surgeHostName"))}</span>
        ${inputWithTitle('data-surge-host-part="host" placeholder="example.com"', normalized.host || "")}
        <small>${escapeHtml(t("surgeHostHelpName"))}</small>
      </label>
      <label>
        <span>${escapeHtml(t("surgeHostValue"))}</span>
        ${inputWithTitle('data-surge-host-part="value" placeholder="1.2.3.4"', normalized.value || "")}
        <small>${escapeHtml(t("surgeHostHelpValue"))}</small>
      </label>
      <div class="surge-host-actions">
        <button class="danger" data-surge-host-remove type="button">${escapeHtml(t("remove"))}</button>
      </div>
    </div>
  `;
}

function renderSurgeHostEmpty() {
  return `<div class="surge-host-empty">${escapeHtml(t("surgeHostNoRows"))}</div>`;
}

function renderSurgeHostRows(lines) {
  const hosts = (lines || []).map(parseSurgeHostLine).filter(Boolean);
  refs.surgeHostRows.innerHTML = hosts.length > 0
    ? hosts.map(renderSurgeHostRow).join("")
    : renderSurgeHostEmpty();
  updateSurgeHostOutput();
}

function readSurgeHostRow(row) {
  return {
    host: row.querySelector('[data-surge-host-part="host"]')?.value.trim() || "",
    value: row.querySelector('[data-surge-host-part="value"]')?.value.trim() || ""
  };
}

function readSurgeHostRows() {
  return Array.from(refs.surgeHostRows.querySelectorAll("[data-surge-host]")).map(readSurgeHostRow);
}

function buildSurgeHostLine(host) {
  const name = String(host.host || "").trim();
  const value = String(host.value || "").trim();
  return name || value ? `${name} = ${value}` : "";
}

function buildSurgeHostLines(hosts) {
  return (hosts || []).map(buildSurgeHostLine).filter(Boolean);
}

function updateSurgeHostOutput() {
  if (!isModeTogglePressed(refs.surgeHostAdvancedMode)) {
    refs.surgeHosts.value = buildSurgeHostLines(readSurgeHostRows()).join("\n");
  }
  syncConfigCodeEditor(refs.surgeHosts);
  validateCurrentSurgeHosts();
}

function syncSurgeHostMode() {
  const advanced = isModeTogglePressed(refs.surgeHostAdvancedMode);
  refs.surgeHostStructuredEditor.classList.toggle("hidden", advanced);
  refs.surgeHosts.readOnly = !advanced;
  refs.surgeHosts.classList.toggle("advanced", advanced);
  syncTextModeLabels(refs.surgeHostAdvancedMode, refs.surgeHostsLabel, advanced);
  syncConfigCodeEditor(refs.surgeHosts);
  validateCurrentSurgeHosts();
}

function toggleSurgeHostAdvancedMode() {
  const advanced = !isModeTogglePressed(refs.surgeHostAdvancedMode);
  setModeTogglePressed(refs.surgeHostAdvancedMode, advanced);
  if (!advanced) {
    renderSurgeHostRows(textToLines(refs.surgeHosts.value));
  }
  syncSurgeHostMode();
}

function addSurgeHost() {
  refs.surgeHostRows.querySelector(".surge-host-empty")?.remove();
  refs.surgeHostRows.insertAdjacentHTML("beforeend", renderSurgeHostRow(defaultSurgeHost()));
  updateSurgeHostOutput();
}

function ensureSurgeHostEmptyState() {
  if (refs.surgeHostRows.querySelector("[data-surge-host]")) return;
  refs.surgeHostRows.innerHTML = renderSurgeHostEmpty();
}

function handleSurgeHostListClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  const row = target?.closest("[data-surge-host]");
  if (!row || !target.closest("[data-surge-host-remove]")) return;
  row.remove();
  ensureSurgeHostEmptyState();
  updateSurgeHostOutput();
}

function renderSurgeUrlRewriteValidation(validation) {
  const messages = [
    ...(validation?.errors || []).map((message) => ({ type: "error", message })),
    ...(validation?.warnings || []).map((message) => ({ type: "warning", message }))
  ];
  refs.surgeUrlRewriteValidation.classList.toggle("hidden", messages.length === 0);
  refs.surgeUrlRewriteValidation.innerHTML = messages
    .map(({ type, message }) => `<div class="${type}">${escapeHtml(message)}</div>`)
    .join("");
}

function currentSurgeUrlRewriteLines() {
  return isModeTogglePressed(refs.surgeUrlRewriteAdvancedMode)
    ? textToLines(refs.surgeUrlRewrite.value)
    : buildSurgeUrlRewriteLines(readSurgeUrlRewriteRows());
}

function validateCurrentSurgeUrlRewrite() {
  const validation = validateSurgeUrlRewriteLines(currentSurgeUrlRewriteLines());
  renderSurgeUrlRewriteValidation(validation);
  return validation;
}

function parseSurgeUrlRewriteLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";") || /^\[[^\]]+\]$/.test(trimmed)) return null;
  const parsed = splitSurgeUrlRewriteLine(trimmed);
  return parsed.pattern || parsed.replacement || parsed.type ? parsed : null;
}

function defaultSurgeUrlRewrite() {
  return { pattern: "", replacement: "-", type: "reject" };
}

function renderSurgeUrlRewriteTypeOptions(selected) {
  return ["reject", "302", "header"]
    .map((type) => `<option value="${type}"${type === selected ? " selected" : ""}>${type}</option>`)
    .join("");
}

function renderSurgeUrlRewriteRow(rule) {
  const normalized = rule || defaultSurgeUrlRewrite();
  const type = ["reject", "302", "header"].includes(normalized.type) ? normalized.type : "reject";
  return `
    <div class="surge-url-rewrite-row" data-surge-url-rewrite>
      <label>
        <span>${escapeHtml(t("surgeUrlRewritePattern"))}</span>
        ${inputWithTitle(`data-surge-url-rewrite-part="pattern" placeholder="^https?:\\/\\/example\\.com\\/ad"`, normalized.pattern || "")}
      </label>
      <label>
        <span>${escapeHtml(t("surgeUrlRewriteReplacement"))}</span>
        ${inputWithTitle('data-surge-url-rewrite-part="replacement" placeholder="-"', normalized.replacement || "")}
        <small>${escapeHtml(t("surgeUrlRewriteReplacementHelp"))}</small>
      </label>
      <label>
        <span>${escapeHtml(t("surgeUrlRewriteType"))}</span>
        <select data-surge-url-rewrite-part="type">${renderSurgeUrlRewriteTypeOptions(type)}</select>
      </label>
      <div class="surge-url-rewrite-actions">
        <button class="btn" data-surge-url-rewrite-move="up" type="button">${escapeHtml(t("moveUp"))}</button>
        <button class="btn" data-surge-url-rewrite-move="down" type="button">${escapeHtml(t("moveDown"))}</button>
        <button class="danger" data-surge-url-rewrite-remove type="button">${escapeHtml(t("remove"))}</button>
      </div>
    </div>
  `;
}

function renderSurgeUrlRewriteEmpty() {
  return `<div class="surge-url-rewrite-empty">${escapeHtml(t("surgeUrlRewriteNoRows"))}</div>`;
}

function renderSurgeUrlRewriteRows(lines) {
  const rules = (lines || []).map(parseSurgeUrlRewriteLine).filter(Boolean);
  refs.surgeUrlRewriteRows.innerHTML = rules.length > 0
    ? rules.map(renderSurgeUrlRewriteRow).join("")
    : renderSurgeUrlRewriteEmpty();
  updateSurgeUrlRewriteOutput();
}

function readSurgeUrlRewriteRow(row) {
  const type = (row.querySelector('[data-surge-url-rewrite-part="type"]')?.value || "reject").trim().toLowerCase();
  return {
    pattern: row.querySelector('[data-surge-url-rewrite-part="pattern"]')?.value.trim() || "",
    replacement: row.querySelector('[data-surge-url-rewrite-part="replacement"]')?.value.trim() || (type === "reject" ? "-" : ""),
    type
  };
}

function readSurgeUrlRewriteRows() {
  return Array.from(refs.surgeUrlRewriteRows.querySelectorAll("[data-surge-url-rewrite]")).map(readSurgeUrlRewriteRow);
}

function buildSurgeUrlRewriteLine(rule) {
  const pattern = String(rule.pattern || "").trim();
  const replacement = String(rule.replacement || "").trim() || (rule.type === "reject" ? "-" : "");
  const type = String(rule.type || "").trim().toLowerCase();
  return pattern || replacement || type ? `${pattern} ${replacement} ${type}` : "";
}

function buildSurgeUrlRewriteLines(rules) {
  return (rules || []).map(buildSurgeUrlRewriteLine).filter(Boolean);
}

function updateSurgeUrlRewriteOutput() {
  if (!isModeTogglePressed(refs.surgeUrlRewriteAdvancedMode)) {
    refs.surgeUrlRewrite.value = buildSurgeUrlRewriteLines(readSurgeUrlRewriteRows()).join("\n");
  }
  syncConfigCodeEditor(refs.surgeUrlRewrite);
  validateCurrentSurgeUrlRewrite();
}

function syncSurgeUrlRewriteMode() {
  const advanced = isModeTogglePressed(refs.surgeUrlRewriteAdvancedMode);
  refs.surgeUrlRewriteStructuredEditor.classList.toggle("hidden", advanced);
  refs.surgeUrlRewrite.readOnly = !advanced;
  refs.surgeUrlRewrite.classList.toggle("advanced", advanced);
  syncTextModeLabels(refs.surgeUrlRewriteAdvancedMode, refs.surgeUrlRewriteLabel, advanced);
  syncConfigCodeEditor(refs.surgeUrlRewrite);
  validateCurrentSurgeUrlRewrite();
}

function toggleSurgeUrlRewriteAdvancedMode() {
  const advanced = !isModeTogglePressed(refs.surgeUrlRewriteAdvancedMode);
  setModeTogglePressed(refs.surgeUrlRewriteAdvancedMode, advanced);
  if (!advanced) {
    renderSurgeUrlRewriteRows(textToLines(refs.surgeUrlRewrite.value));
  }
  syncSurgeUrlRewriteMode();
}

function addSurgeUrlRewrite() {
  refs.surgeUrlRewriteRows.querySelector(".surge-url-rewrite-empty")?.remove();
  refs.surgeUrlRewriteRows.insertAdjacentHTML("beforeend", renderSurgeUrlRewriteRow(defaultSurgeUrlRewrite()));
  updateSurgeUrlRewriteOutput();
}

function ensureSurgeUrlRewriteEmptyState() {
  if (refs.surgeUrlRewriteRows.querySelector("[data-surge-url-rewrite]")) return;
  refs.surgeUrlRewriteRows.innerHTML = renderSurgeUrlRewriteEmpty();
}

function handleSurgeUrlRewriteListClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  const row = target?.closest("[data-surge-url-rewrite]");
  if (!row) return;
  if (target.closest("[data-surge-url-rewrite-remove]")) {
    row.remove();
    ensureSurgeUrlRewriteEmptyState();
    updateSurgeUrlRewriteOutput();
    return;
  }
  const move = target.closest("[data-surge-url-rewrite-move]")?.dataset.surgeUrlRewriteMove;
  if (move === "up") {
    const previous = row.previousElementSibling?.matches("[data-surge-url-rewrite]") ? row.previousElementSibling : null;
    if (previous) refs.surgeUrlRewriteRows.insertBefore(row, previous);
    updateSurgeUrlRewriteOutput();
    return;
  }
  if (move === "down") {
    const next = row.nextElementSibling?.matches("[data-surge-url-rewrite]") ? row.nextElementSibling : null;
    if (next) refs.surgeUrlRewriteRows.insertBefore(next, row);
    updateSurgeUrlRewriteOutput();
  }
}

function handleSurgeUrlRewriteListChange(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target?.closest("[data-surge-url-rewrite]")) return;
  updateSurgeUrlRewriteOutput();
}

function splitSurgeRuleLine(line) {
  const parts = [];
  let current = "";
  let depth = 0;
  for (const char of String(line || "")) {
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim() || parts.length > 0) parts.push(current.trim());
  return parts;
}

function surgePolicyCandidates() {
  const groups = groupEntries().map(([name]) => name);
  const ponteDevices = normalizePonteDeviceNames(state?.surge?.ponteDeviceNames || [])
    .map((name) => `DEVICE:${name}`);
  return [...new Set([...groups, ...SUBNET_BUILT_IN_POLICIES, ...ponteDevices])];
}

function normalizeSurgeRulePolicy(policy) {
  const trimmed = String(policy || "").trim();
  const candidates = surgePolicyCandidates();
  return candidates.includes(trimmed) ? trimmed : candidates[0] || "Proxy";
}

function isKnownSurgePolicy(policy) {
  const trimmed = String(policy || "").trim();
  return surgePolicyCandidates().includes(trimmed) || isSurgeDevicePolicy(trimmed);
}

function isValidSurgePolicy(policy) {
  const trimmed = String(policy || "").trim();
  return Boolean(trimmed) && !/[\r\n,[\]]/.test(trimmed);
}

function isSurgeDevicePolicy(policy) {
  return /^DEVICE:[^,\r\n[\]]+$/i.test(String(policy || "").trim());
}

function renderPolicyLabel(policy) {
  return SURGE_BUILT_IN_POLICY_LABELS[policy] || policy;
}

function normalizePonteDeviceNames(value) {
  const items = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(items
    .map((item) => String(item).trim().replace(/^DEVICE:/i, "").trim())
    .filter((item) => item && !/[,\r\n[\]]/.test(item)))];
}

function validateSurgeRuleLine(line, lineNumber) {
  const trimmed = String(line || "").trim();
  const result = { errors: [], warnings: [] };
  if (!trimmed || trimmed.startsWith("#")) return result;
  if (/^\[[^\]]+\]$/.test(trimmed)) {
    result.errors.push(`第 ${lineNumber} 行不能包含配置段标题`);
    return result;
  }

  const parts = splitSurgeRuleLine(trimmed);
  const type = (parts[0] || "").trim().toUpperCase();
  if (!type) {
    result.errors.push(`第 ${lineNumber} 行缺少规则类型`);
    return result;
  }
  if (parts.some((part) => !part.trim())) {
    result.errors.push(`第 ${lineNumber} 行存在空参数`);
    return result;
  }

  let policy = "";
  if (SURGE_RULE_SET_TYPES.has(type)) {
    if (parts.length < 3) {
      result.errors.push(`第 ${lineNumber} 行规则集语法应为 ${type},名称,策略`);
      return result;
    }
    policy = parts[2] || "";
    const optionError = validateSurgeRuleOptions(parts.slice(3), "rule-set", type, "");
    if (optionError) result.errors.push(`第 ${lineNumber} 行${optionError}`);
  } else if (SURGE_VALUELESS_RULE_TYPES.has(type)) {
    if (parts.length < 2) {
      result.errors.push(`第 ${lineNumber} 行 ${type} 规则缺少策略出口`);
      return result;
    }
    policy = parts[1] || "";
    const optionError = validateSurgeRuleOptions(parts.slice(2), "single", "", type);
    if (optionError) result.errors.push(`第 ${lineNumber} 行${optionError}`);
  } else {
    if (!SURGE_VALUE_RULE_TYPES.has(type)) {
      result.errors.push(`第 ${lineNumber} 行规则类型 ${type} 不受支持`);
      return result;
    }
    if (parts.length < 3) {
      result.errors.push(`第 ${lineNumber} 行语法应为 类型,匹配值,策略`);
      return result;
    }
    policy = parts[2] || "";
    const optionError = validateSurgeRuleOptions(parts.slice(3), "single", "", type);
    if (optionError) result.errors.push(`第 ${lineNumber} 行${optionError}`);
  }

  if (!isValidSurgePolicy(policy)) {
    result.errors.push(`第 ${lineNumber} 行策略出口格式无效`);
  } else if (!isKnownSurgePolicy(policy)) {
    result.errors.push(`第 ${lineNumber} 行${t("surgeRuleUnknownPolicy")}`);
  }
  return result;
}

function validateSurgeRuleOptions(options, kind, setType, ruleType) {
  return validateRuleOptions(options, allowedSurgeRuleOptions(kind, setType, ruleType), SURGE_RULE_OPTION_ORDER);
}

function effectiveSurgeRuleEntries(lines) {
  return (lines || []).map((line, index) => {
    const trimmed = String(line || "").trim();
    if (!trimmed || trimmed.startsWith("#")) return null;
    return {
      lineNumber: index + 1,
      type: (splitSurgeRuleLine(trimmed)[0] || "").trim().toUpperCase()
    };
  }).filter(Boolean);
}

function validateSurgeRuleLines(lines) {
  const validation = { errors: [], warnings: [] };
  (lines || []).forEach((line, index) => {
    const result = validateSurgeRuleLine(line, index + 1);
    validation.errors.push(...result.errors);
    validation.warnings.push(...result.warnings);
  });
  const effectiveRules = effectiveSurgeRuleEntries(lines);
  const finalRules = effectiveRules.filter((rule) => rule.type === "FINAL");
  if (finalRules.length === 0) {
    validation.errors.push(t("surgeRuleFinalMissing"));
  } else if (finalRules.length > 1) {
    validation.errors.push(t("surgeRuleFinalDuplicate"));
  } else if (effectiveRules[effectiveRules.length - 1]?.type !== "FINAL") {
    validation.errors.push(t("surgeRuleFinalNotLast"));
  }
  return validation;
}

function renderSurgeRuleValidation(validation) {
  const messages = [
    ...(validation?.errors || []).map((message) => ({ type: "error", message })),
    ...(validation?.warnings || []).map((message) => ({ type: "warning", message }))
  ];
  refs.surgeRuleValidation.classList.toggle("hidden", messages.length === 0);
  refs.surgeRuleValidation.innerHTML = messages
    .map(({ type, message }) => `<div class="${type}">${escapeHtml(message)}</div>`)
    .join("");
}

function currentSurgeRuleLines() {
  return isModeTogglePressed(refs.surgeRuleAdvancedMode)
    ? textToLines(refs.surgeRules.value)
    : buildSurgeRuleLines(readSurgeRuleRows());
}

function validateCurrentSurgeRules() {
  const validation = validateSurgeRuleLines(currentSurgeRuleLines());
  renderSurgeRuleValidation(validation);
  return validation;
}

function parseSurgeRuleLine(line) {
  const parts = splitSurgeRuleLine(line);
  const type = (parts[0] || "").trim().toUpperCase();
  if (!type) return null;
  if (SURGE_RULE_SET_TYPES.has(type)) {
    return {
      kind: "rule-set",
      setType: type,
      setName: parts[1] || "",
      policy: normalizeSurgeRulePolicy(parts[2] || ""),
      options: parts.slice(3).join(", ")
    };
  }
  const valueless = SURGE_VALUELESS_RULE_TYPES.has(type);
  const policyIndex = valueless ? 1 : 2;
  return {
    kind: "single",
    ruleType: type,
    value: valueless ? "" : parts[1] || "",
    policy: normalizeSurgeRulePolicy(parts[policyIndex] || ""),
    options: parts.slice(policyIndex + 1).join(", ")
  };
}

function finalSurgeRule() {
  return { kind: "single", ruleType: "FINAL", value: "", policy: normalizeSurgeRulePolicy("Proxy"), options: "" };
}

function isFinalSurgeRule(rule) {
  return String(rule?.ruleType || "").trim().toUpperCase() === "FINAL";
}

function normalizeSurgeRuleRows(rules) {
  const list = Array.isArray(rules) ? rules : [];
  const finalRule = list.find(isFinalSurgeRule) || finalSurgeRule();
  return [
    ...list.filter((rule) => !isFinalSurgeRule(rule)),
    { ...finalRule, kind: "single", ruleType: "FINAL", value: "" }
  ];
}

function defaultSurgeRule(kind = "single") {
  const policy = normalizeSurgeRulePolicy("Proxy");
  return kind === "rule-set"
    ? { kind: "rule-set", setType: "RULE-SET", setName: "", policy, options: "" }
    : { kind: "single", ruleType: "DOMAIN-SUFFIX", value: "", policy, options: "" };
}

function renderSurgeRuleKindOptions(selected) {
  return [
    ["single", t("surgeRuleKindSingle")],
    ["rule-set", t("surgeRuleKindRuleSet")]
  ].map(([value, label]) => `<option value="${value}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");
}

function renderSurgeRuleTypeOptions(selected, lockedFinal = false) {
  if (lockedFinal) return '<option value="FINAL" selected>FINAL</option>';
  const editableTypes = SURGE_RULE_TYPES.filter((type) => type !== "FINAL");
  const types = editableTypes.includes(selected) ? editableTypes : [selected, ...editableTypes].filter(Boolean);
  return types.map((type) => `<option value="${escapeHtml(type)}"${type === selected ? " selected" : ""}>${escapeHtml(type)}</option>`).join("");
}

function renderSurgeRuleSetTypeOptions(selected) {
  const normalized = SURGE_RULE_SET_TYPES.has(selected) ? selected : "RULE-SET";
  return [...SURGE_RULE_SET_TYPES]
    .map((type) => `<option value="${escapeHtml(type)}"${type === normalized ? " selected" : ""}>${escapeHtml(type)}</option>`)
    .join("");
}

function renderSurgePolicyOptions(selected) {
  const selectedPolicy = normalizeSurgeRulePolicy(selected);
  return surgePolicyCandidates()
    .map((policy) => `<option value="${escapeHtml(policy)}"${policy === selectedPolicy ? " selected" : ""}>${escapeHtml(renderPolicyLabel(policy))}</option>`)
    .join("");
}

function allowedSurgeRuleOptions(kind, setType, ruleType) {
  if (kind === "rule-set") {
    return setType === "DOMAIN-SET" ? SURGE_DOMAIN_SET_OPTIONS : SURGE_RULE_SET_OPTIONS;
  }
  const type = String(ruleType || "").trim().toUpperCase();
  if (["IP-CIDR", "IP-CIDR6", "GEOIP"].includes(type)) return SURGE_IP_RULE_OPTIONS;
  if (SURGE_EXTENDED_MATCHING_RULE_TYPES.has(type)) return SURGE_DOMAIN_SET_OPTIONS;
  if (type === "FINAL") return SURGE_FINAL_RULE_OPTIONS;
  return new Set();
}

function normalizeSurgeRuleOptions(value, kind, setType, ruleType) {
  return normalizeRuleOptions(value, allowedSurgeRuleOptions(kind, setType, ruleType), SURGE_RULE_OPTION_ORDER);
}

function renderSurgeRuleOptionChoices(kind, setType, ruleType, selected) {
  const allowed = allowedSurgeRuleOptions(kind, setType, ruleType);
  const selectedValue = normalizeSurgeRuleOptions(selected, kind, setType, ruleType);
  const choices = [["", t("surgeRuleOptionNone")]];
  for (const option of SURGE_RULE_OPTION_ORDER) {
    if (allowed.has(option)) choices.push([option, option]);
  }
  if (allowed.has("no-resolve") && allowed.has("extended-matching")) {
    choices.push(["no-resolve,extended-matching", "no-resolve + extended-matching"]);
  }
  return choices
    .map(([value, label]) => `<option value="${escapeHtml(value)}"${value === selectedValue ? " selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
}

function renderSurgeRuleRow(rule) {
  const normalized = rule || defaultSurgeRule();
  const kind = normalized.kind === "rule-set" ? "rule-set" : "single";
  const setType = SURGE_RULE_SET_TYPES.has(normalized.setType) ? normalized.setType : "RULE-SET";
  const ruleType = normalized.ruleType || "DOMAIN-SUFFIX";
  const lockedFinal = kind === "single" && ruleType === "FINAL";
  const valueless = SURGE_VALUELESS_RULE_TYPES.has(ruleType);
  const disabledAttr = lockedFinal ? " disabled" : "";
  const mainField = kind === "rule-set"
    ? `<label>
        <span>${escapeHtml(t("surgeRuleSetType"))}</span>
        <select data-surge-rule-part="setType">${renderSurgeRuleSetTypeOptions(setType)}</select>
      </label>
      <label>
        <span>${escapeHtml(t("surgeRuleSetName"))}</span>
        ${inputWithTitle('class="surge-rule-set-address" data-surge-rule-part="setName" dir="rtl"', normalized.setName || "")}
      </label>`
    : `<label>
        <span>${escapeHtml(t("surgeRuleType"))}</span>
        <select data-surge-rule-part="ruleType"${disabledAttr}>${renderSurgeRuleTypeOptions(ruleType, lockedFinal)}</select>
        ${lockedFinal ? `<small>${escapeHtml(t("surgeRuleFinalLocked"))}</small>` : ""}
      </label>
      <label>
        <span>${escapeHtml(t("surgeRuleValue"))}</span>
        ${inputWithTitle(`data-surge-rule-part="value"${valueless ? " disabled" : ""}`, normalized.value || "")}
      </label>`;
  return `
    <div class="surge-rule-row ${kind === "rule-set" ? "rule-set" : "single"}" data-surge-rule${lockedFinal ? " data-surge-rule-final" : ""}>
      <label>
        <span>${escapeHtml(t("surgeRuleKind"))}</span>
        <select data-surge-rule-part="kind"${disabledAttr}>${renderSurgeRuleKindOptions(kind)}</select>
      </label>
      ${mainField}
      <label>
        <span>${escapeHtml(t("surgeRulePolicy"))}</span>
        <select data-surge-rule-part="policy">${renderSurgePolicyOptions(normalized.policy)}</select>
      </label>
      <label>
        <span>${escapeHtml(t("surgeRuleOptions"))}</span>
        <select data-surge-rule-part="options">${renderSurgeRuleOptionChoices(kind, setType, ruleType, normalized.options || "")}</select>
      </label>
      <div class="surge-rule-actions">
        <button class="btn" data-surge-rule-move="up" type="button"${disabledAttr}>${escapeHtml(t("moveUp"))}</button>
        <button class="btn" data-surge-rule-move="down" type="button"${disabledAttr}>${escapeHtml(t("moveDown"))}</button>
        <button class="danger" data-surge-rule-remove type="button"${disabledAttr}>${escapeHtml(t("remove"))}</button>
      </div>
    </div>
  `;
}

function renderSurgeRuleEmpty() {
  return `<div class="surge-rule-empty">${escapeHtml(t("surgeRuleNoRows"))}</div>`;
}

function renderSurgeRuleRows(lines) {
  const rules = normalizeSurgeRuleRows((lines || []).map(parseSurgeRuleLine).filter(Boolean));
  refs.surgeRuleRows.innerHTML = rules.length > 0
    ? rules.map(renderSurgeRuleRow).join("")
    : renderSurgeRuleEmpty();
  updateSurgeRuleOutput();
}

function readSurgeRuleRow(row) {
  const kind = row.querySelector('[data-surge-rule-part="kind"]')?.value || "single";
  const policy = normalizeSurgeRulePolicy(row.querySelector('[data-surge-rule-part="policy"]')?.value || "");
  const options = row.querySelector('[data-surge-rule-part="options"]')?.value.trim() || "";
  if (kind === "rule-set") {
    const setType = (row.querySelector('[data-surge-rule-part="setType"]')?.value || "RULE-SET").trim().toUpperCase();
    return {
      kind,
      setType,
      setName: row.querySelector('[data-surge-rule-part="setName"]')?.value.trim() || "",
      policy,
      options: normalizeSurgeRuleOptions(options, kind, setType, "")
    };
  }
  const ruleType = (row.querySelector('[data-surge-rule-part="ruleType"]')?.value || "DOMAIN-SUFFIX").trim().toUpperCase();
  return {
    kind: "single",
    ruleType,
    value: row.querySelector('[data-surge-rule-part="value"]')?.value.trim() || "",
    policy,
    options: normalizeSurgeRuleOptions(options, kind, "", ruleType)
  };
}

function readSurgeRuleRows() {
  return Array.from(refs.surgeRuleRows.querySelectorAll("[data-surge-rule]")).map(readSurgeRuleRow);
}

function buildSurgeRuleLine(rule) {
  if (rule.kind === "rule-set") {
    const type = SURGE_RULE_SET_TYPES.has(rule.setType) ? rule.setType : "RULE-SET";
    const name = String(rule.setName || "").trim();
    const options = normalizeSurgeRuleOptions(rule.options, "rule-set", type, "");
    const suffix = options ? `,${options}` : "";
    return `${type},${name},${normalizeSurgeRulePolicy(rule.policy)}${suffix}`;
  }
  const type = String(rule.ruleType || "").trim().toUpperCase();
  const policy = normalizeSurgeRulePolicy(rule.policy);
  const options = normalizeSurgeRuleOptions(rule.options, "single", "", type);
  const suffix = options ? `,${options}` : "";
  if (!type) return "";
  if (SURGE_VALUELESS_RULE_TYPES.has(type)) {
    return `${type},${policy}${suffix}`;
  }
  const value = String(rule.value || "").trim();
  return `${type},${value},${policy}${suffix}`;
}

function buildSurgeRuleLines(rules) {
  return normalizeSurgeRuleRows(rules).map(buildSurgeRuleLine).filter(Boolean);
}

function updateSurgeRuleOutput() {
  if (!isModeTogglePressed(refs.surgeRuleAdvancedMode)) {
    refs.surgeRules.value = buildSurgeRuleLines(readSurgeRuleRows()).join("\n");
  }
  syncConfigCodeEditor(refs.surgeRules);
  validateCurrentSurgeRules();
}

function syncSurgeRuleMode() {
  const advanced = isModeTogglePressed(refs.surgeRuleAdvancedMode);
  refs.surgeRuleStructuredEditor.classList.toggle("hidden", advanced);
  refs.surgeRuleStructuredActions.classList.toggle("hidden", advanced);
  refs.surgeRules.readOnly = !advanced;
  refs.surgeRules.classList.toggle("advanced", advanced);
  syncTextModeLabels(refs.surgeRuleAdvancedMode, refs.surgeRulesLabel, advanced);
  syncConfigCodeEditor(refs.surgeRules);
  validateCurrentSurgeRules();
}

function syncSurgePonteDeviceNames() {
  state.surge.ponteDeviceNames = normalizePonteDeviceNames(refs.surgePonteDeviceNames.value);
  if (isModeTogglePressed(refs.surgeRuleAdvancedMode)) {
    validateCurrentSurgeRules();
    return;
  }
  const lines = buildSurgeRuleLines(readSurgeRuleRows());
  renderSurgeRuleRows(lines);
}

function toggleSurgeRuleAdvancedMode() {
  const advanced = !isModeTogglePressed(refs.surgeRuleAdvancedMode);
  setModeTogglePressed(refs.surgeRuleAdvancedMode, advanced);
  if (!advanced) {
    renderSurgeRuleRows(textToLines(refs.surgeRules.value));
  }
  syncSurgeRuleMode();
}

function addSurgeRule(kind) {
  refs.surgeRuleRows.querySelector(".surge-rule-empty")?.remove();
  const finalRow = refs.surgeRuleRows.querySelector("[data-surge-rule-final]");
  const html = renderSurgeRuleRow(defaultSurgeRule(kind));
  if (finalRow) {
    finalRow.insertAdjacentHTML("beforebegin", html);
  } else {
    refs.surgeRuleRows.insertAdjacentHTML("beforeend", html);
  }
  updateSurgeRuleOutput();
}

function ensureSurgeRuleEmptyState() {
  if (refs.surgeRuleRows.querySelector("[data-surge-rule]")) return;
  refs.surgeRuleRows.innerHTML = renderSurgeRuleEmpty();
}

function rerenderSurgeRuleRow(row) {
  const rule = readSurgeRuleRow(row);
  row.outerHTML = renderSurgeRuleRow(rule);
  updateSurgeRuleOutput();
}

function handleSurgeRuleListClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  const row = target?.closest("[data-surge-rule]");
  if (!row) return;
  if (row.matches("[data-surge-rule-final]")) return;
  if (target.closest("[data-surge-rule-remove]")) {
    row.remove();
    ensureSurgeRuleEmptyState();
    updateSurgeRuleOutput();
    return;
  }
  const move = target.closest("[data-surge-rule-move]")?.dataset.surgeRuleMove;
  if (move === "up") {
    const previous = row.previousElementSibling?.matches("[data-surge-rule]") ? row.previousElementSibling : null;
    if (previous) refs.surgeRuleRows.insertBefore(row, previous);
    updateSurgeRuleOutput();
    return;
  }
  if (move === "down") {
    const next = row.nextElementSibling?.matches("[data-surge-rule]") ? row.nextElementSibling : null;
    if (next?.matches("[data-surge-rule-final]")) return;
    if (next) refs.surgeRuleRows.insertBefore(next, row);
    updateSurgeRuleOutput();
  }
}

function handleSurgeRuleListChange(event) {
  const target = event.target instanceof Element ? event.target : null;
  const row = target?.closest("[data-surge-rule]");
  if (!row) return;
  if (target.matches('[data-surge-rule-part="kind"], [data-surge-rule-part="setType"], [data-surge-rule-part="ruleType"]')) {
    rerenderSurgeRuleRow(row);
    return;
  }
  updateSurgeRuleOutput();
}

function parseGroupSpec(name, spec) {
  const [type = "select", ...items] = splitPolicyGroupSpec(spec);
  const isSubnetSpec = type === "subnet";
  const editor = {
    type,
    choices: [],
    includeAll: false,
    surgeHidden: false,
    filter: "",
    exclude: "",
    subnetDefault: "",
    subnetRules: [],
    url: "",
    interval: "",
    advancedOptions: []
  };

  for (const item of items) {
    const allSelector = parseAllSelector(item);
    if (allSelector) {
      editor.includeAll = true;
      editor.filter = allSelector.filter;
      editor.exclude = allSelector.exclude;
      continue;
    }
    const option = parseGroupOption(item);
    if (isSubnetSpec && option && option.key.toLowerCase() === "default") {
      editor.subnetDefault = option.value;
      continue;
    }
    if (isSubnetSpec && option && isSubnetConditionKey(option.key)) {
      editor.subnetRules.push({
        ...parseSubnetConditionKey(option.key),
        policy: option.value
      });
      continue;
    }
    if (option?.key.toLowerCase() === "hidden") {
      editor.surgeHidden = option.value.toLowerCase() === "true" || option.value === "1";
      continue;
    }
    if (option && GROUP_OPTION_FIELDS.has(option.key)) {
      editor[option.key] = option.value;
      continue;
    }
    if (option) {
      editor.advancedOptions.push(item);
      continue;
    }
    editor.choices.push(item);
  }
  return editor;
}

function formatGroupOption(key, value) {
  return `${key.trim()}=${String(value).trim()}`;
}

function isSubnetConditionKey(key) {
  return Boolean(parseSubnetConditionKey(key));
}

function parseSubnetConditionKey(key) {
  const match = String(key || "").match(/^(SSID|BSSID|ROUTER|TYPE):(.+)$/i);
  if (!match) return null;
  const parameter = match[1].toUpperCase();
  const query = match[2].trim();
  if (!SUBNET_PARAMETERS.includes(parameter) || !query) return null;
  if (parameter === "TYPE" && !SUBNET_NETWORK_TYPES.includes(query.toUpperCase())) return null;
  return {
    parameter,
    query: parameter === "TYPE" ? query.toUpperCase() : query
  };
}

function makeAllSelector(filter, exclude) {
  const parts = ["{all"];
  if (filter.trim()) parts.push(`filter=${filter.trim()}`);
  if (exclude.trim()) parts.push(`exclude=${exclude.trim()}`);
  return `${parts.join(" ")}}`;
}

function commaList(value) {
  return splitPolicyGroupSpec(value).map((item) => item.trim()).filter(Boolean);
}

function choiceList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return commaList(value);
}

function groupList(value, currentName, groupNames = Object.keys(state.groups || {})) {
  const groups = new Set(groupNames.filter((name) => name !== currentName && name !== "Proxy"));
  const choices = choiceList(value);
  return choices.filter((item, index) => groups.has(item) && choices.indexOf(item) === index);
}

function subnetPolicyValue(value, currentName) {
  const policy = String(value || "").trim();
  if (!policy || policy === currentName) return "";
  return policy;
}

function subnetRuleList(value, currentName) {
  const output = [];
  const rules = Array.isArray(value) ? value : [];
  for (const rule of rules) {
    const normalized = normalizeSubnetRule(rule);
    if (!normalized) continue;
    const policy = subnetPolicyValue(normalized.policy, currentName);
    if (!policy) continue;
    const item = formatGroupOption(subnetConditionKey(normalized.parameter, normalized.query), policy);
    output.push(item);
  }
  return output;
}

function normalizeSubnetRule(rule) {
  if (typeof rule === "string") {
    const option = parseGroupOption(rule);
    if (!option) return null;
    const condition = parseSubnetConditionKey(option.key);
    return condition ? { ...condition, policy: option.value } : null;
  }
  const parameter = String(rule?.parameter || "").trim().toUpperCase();
  const rawQuery = String(rule?.query || "").trim();
  const query = parameter === "TYPE" ? rawQuery.toUpperCase() : rawQuery;
  const policy = String(rule?.policy || "").trim();
  if (!SUBNET_PARAMETERS.includes(parameter) || !query || !policy) return null;
  if (parameter === "TYPE" && !SUBNET_NETWORK_TYPES.includes(query)) return null;
  return { parameter, query, policy };
}

function subnetConditionKey(parameter, query) {
  return `${parameter}:${query}`;
}

function serializeGroupEditor(editor, groupNames) {
  const type = editor.type.trim() || "select";
  const parts = [type];
  if (type === "subnet") {
    parts.push(`default=${subnetPolicyValue(editor.subnetDefault, editor.name) || "Proxy"}`);
    parts.push(...subnetRuleList(editor.subnetRules, editor.name));
    if (editor.surgeHidden) parts.push("hidden=true");
    return parts.join(", ");
  }
  parts.push(...groupList(editor.choices, editor.name, groupNames));
  if (editor.includeAll) {
    parts.push(makeAllSelector(editor.filter, editor.exclude));
  }
  if (editor.surgeHidden) parts.push("hidden=true");
  if (type !== "select") {
    if (editor.url.trim()) parts.push(`url=${editor.url.trim()}`);
    if (editor.interval.trim()) parts.push(`interval=${editor.interval.trim()}`);
    if (type !== "url-test") {
      parts.push(...commaList(editor.advancedOptions));
    }
  }
  return parts.join(", ");
}

function normalizeGroupSpec(name, spec, groupNames) {
  const editor = parseGroupSpec(name, spec);
  return serializeGroupEditor({
    ...editor,
    name,
    advancedOptions: editor.advancedOptions.join(", ")
  }, groupNames);
}

function normalizeGroupEntries(entries) {
  const groupNames = entries.map(([name]) => name);
  return entries.map(([name, spec]) => [name, normalizeGroupSpec(name, spec, groupNames)]);
}

function renameFixedGroupChoices(entries, previousName, nextName) {
  if (!previousName || !nextName || previousName === nextName) return entries;
  const groupNames = entries.map(([name]) => name);
  return entries.map(([name, spec]) => {
    const editor = parseGroupSpec(name, spec);
    const choices = editor.choices.map((choice) => choice === previousName ? nextName : choice);
    const subnetDefault = editor.subnetDefault === previousName ? nextName : editor.subnetDefault;
    const subnetRules = editor.subnetRules.map((rule) => rule.policy === previousName ? { ...rule, policy: nextName } : rule);
    return [name, serializeGroupEditor({
      ...editor,
      name,
      choices,
      subnetDefault,
      subnetRules,
      advancedOptions: editor.advancedOptions.join(", ")
    }, groupNames)];
  });
}

function readGroupEditor(row) {
  const type = row.querySelector('[data-group-part="type"]').value;
  const usesSubscriptionNodes = type !== "fallback" && type !== "subnet";
  const includeAll = usesSubscriptionNodes && row.querySelector('[data-group-part="includeAll"]').checked;
  return {
    type,
    name: row.dataset.groupName || "",
    choices: Array.from(row.querySelectorAll('[data-group-part="choices"]:checked')).map((input) => input.value),
    includeAll,
    surgeHidden: row.querySelector('[data-group-part="surgeHidden"]').checked,
    filter: includeAll ? row.querySelector('[data-group-part="filter"]').value : "",
    exclude: includeAll ? row.querySelector('[data-group-part="exclude"]').value : "",
    subnetDefault: row.querySelector('[data-group-part="subnetDefault"]').value,
    subnetRules: readSubnetRules(row),
    url: row.querySelector('[data-group-part="url"]').value,
    interval: row.querySelector('[data-group-part="interval"]').value,
    advancedOptions: row.querySelector('[data-group-part="advancedOptions"]').value
  };
}

function renderGroupTypeOptions(type) {
  const types = GROUP_TYPES.includes(type) ? GROUP_TYPES : [type, ...GROUP_TYPES];
  return types.map((item) => `<option value="${escapeHtml(item)}"${item === type ? " selected" : ""}>${escapeHtml(groupTypeLabel(item))}</option>`).join("");
}

function groupTypeLabel(type) {
  return {
    select: t("groupTypeLabelSelect"),
    "url-test": t("groupTypeLabelAuto"),
    fallback: t("groupTypeLabelFallback"),
    "load-balance": t("groupTypeLabelLoadBalance"),
    subnet: t("groupTypeLabelSubnet")
  }[type] || type;
}

function renderGroupChoiceInputs(currentName, choices) {
  const candidates = groupEntries().map(([name]) => name).filter((name) => name !== currentName && name !== "Proxy");
  if (candidates.length === 0) {
    return `<div class="group-choice-empty">${escapeHtml(t("noGroupChoices"))}</div>`;
  }
  const selected = new Set(groupList(choices, currentName));
  return candidates.map((name) => `
    <label class="group-choice-item">
      <input data-group-part="choices" type="checkbox" value="${escapeHtml(name)}"${selected.has(name) ? " checked" : ""}>
      <span>${escapeHtml(name)}</span>
    </label>
  `).join("");
}

function subnetPolicyCandidates(currentName) {
  const groups = groupEntries().map(([name]) => name).filter((name) => name !== currentName);
  return [...new Set([...groups, ...SUBNET_BUILT_IN_POLICIES])];
}

function renderSubnetPolicyOptions(currentName, selected) {
  const selectedPolicy = subnetPolicyValue(selected, currentName) || "Proxy";
  const candidates = subnetPolicyCandidates(currentName);
  if (!candidates.includes(selectedPolicy) && selectedPolicy !== currentName) {
    candidates.push(selectedPolicy);
  }
  return candidates
    .filter((item) => item !== currentName)
    .map((item) => `<option value="${escapeHtml(item)}"${item === selectedPolicy ? " selected" : ""}>${escapeHtml(renderPolicyLabel(item))}</option>`)
    .join("");
}

function renderSubnetParameterOptions(selected) {
  const labels = {
    SSID: t("groupSubnetParamSsid"),
    BSSID: t("groupSubnetParamBssid"),
    ROUTER: t("groupSubnetParamRouter"),
    TYPE: t("groupSubnetParamType")
  };
  return SUBNET_PARAMETERS
    .map((item) => `<option value="${item}"${item === selected ? " selected" : ""}>${escapeHtml(labels[item])}</option>`)
    .join("");
}

function renderSubnetNetworkTypeOptions(selected) {
  const labels = {
    WIFI: t("groupSubnetTypeWifi"),
    WIRED: t("groupSubnetTypeWired"),
    CELLULAR: t("groupSubnetTypeCellular")
  };
  return SUBNET_NETWORK_TYPES
    .map((item) => `<option value="${item}"${item === selected ? " selected" : ""}>${escapeHtml(labels[item])}</option>`)
    .join("");
}

function renderSubnetRuleRow(currentName, rule = {}) {
  const normalized = normalizeSubnetRule(rule) || { parameter: "TYPE", query: "WIFI", policy: "Proxy" };
  return `
    <div class="subnet-rule-row" data-subnet-rule>
      <label>
        <span>${escapeHtml(t("groupSubnetParameter"))}</span>
        <select data-subnet-rule-part="parameter">${renderSubnetParameterOptions(normalized.parameter)}</select>
      </label>
      <label class="subnet-query-text-field">
        <span>${escapeHtml(t("groupSubnetQuery"))}</span>
        <input data-subnet-rule-part="queryText" value="${escapeHtml(normalized.parameter === "TYPE" ? "" : normalized.query)}">
      </label>
      <label class="subnet-query-type-field">
        <span>${escapeHtml(t("groupSubnetQuery"))}</span>
        <select data-subnet-rule-part="queryType">${renderSubnetNetworkTypeOptions(normalized.parameter === "TYPE" ? normalized.query : "WIFI")}</select>
      </label>
      <label>
        <span>${escapeHtml(t("groupSubnetPolicy"))}</span>
        <select data-subnet-rule-part="policy">${renderSubnetPolicyOptions(currentName, normalized.policy)}</select>
      </label>
      <button class="danger subnet-rule-remove" data-subnet-remove type="button">${escapeHtml(t("remove"))}</button>
    </div>
  `;
}

function renderSubnetRules(currentName, rules) {
  const rows = rules.map((rule) => renderSubnetRuleRow(currentName, rule)).join("");
  return `
    <div class="subnet-rule-list" data-subnet-rule-list>
      ${rows || renderSubnetRuleEmpty()}
    </div>
  `;
}

function renderSubnetRuleEmpty() {
  return `<div class="subnet-rule-empty">${escapeHtml(t("groupSubnetNoRules"))}</div>`;
}

function readSubnetRules(row) {
  return Array.from(row.querySelectorAll("[data-subnet-rule]")).map((ruleRow) => {
    const parameter = ruleRow.querySelector('[data-subnet-rule-part="parameter"]')?.value || "TYPE";
    const query = parameter === "TYPE"
      ? ruleRow.querySelector('[data-subnet-rule-part="queryType"]')?.value
      : ruleRow.querySelector('[data-subnet-rule-part="queryText"]')?.value;
    const policy = ruleRow.querySelector('[data-subnet-rule-part="policy"]')?.value || "";
    return { parameter, query, policy };
  });
}

function groupTypeHelp(type) {
  const key = {
    select: "groupTypeHelpSelect",
    "url-test": "groupTypeHelpUrlTest",
    fallback: "groupTypeHelpFallback",
    "load-balance": "groupTypeHelpLoadBalance",
    subnet: "groupTypeHelpSubnet"
  }[type];
  return key ? t(key) : "";
}

function renderGroups() {
  refs.groupsBody.innerHTML = "";
  const entries = groupEntries();
  entries.forEach(([name, spec], index) => {
    const builtIn = isBuiltInGroupName(name);
    const removalLocked = isRemovalLockedGroupName(name);
    const canToggleEnabled = isDisableToggleAllowed(name);
    const enabled = !isGroupDisabled(name);
    const editor = parseGroupSpec(name, spec);
    const displaySpec = normalizeGroupSpec(name, spec);
    const usesNodeOptions = editor.type !== "fallback" && editor.type !== "subnet";
    const isSubnetGroup = editor.type === "subnet";
    const row = document.createElement("tr");
    row.innerHTML = `
      <td class="group-name-cell" data-label="Name">
        <div class="group-card-kicker">
          <span>#${index + 1}</span>
          <span class="group-state-pill${enabled ? "" : " off"}">${escapeHtml(enabled ? t("enabled") : t("disabled"))}</span>
        </div>
        ${inputWithTitle(`class="group-name-input" data-field="name"${builtIn ? " disabled" : ""}`, name)}
        ${builtIn ? `<small class="cell-help locked-note">${escapeHtml(t("builtInGroupHelp"))}</small>` : ""}
        <label class="group-type-field group-meta-field">
          <span>${escapeHtml(t("groupType"))}</span>
          <select data-group-part="type">${renderGroupTypeOptions(editor.type)}</select>
          <small data-group-type-help>${escapeHtml(groupTypeHelp(editor.type))}</small>
        </label>
        ${canToggleEnabled ? `
          <label class="check group-enable">
            <input data-group-enabled type="checkbox"${enabled ? " checked" : ""}>
            <span>${escapeHtml(t("groupEnabled"))}</span>
          </label>
        ` : ""}
        <label class="check group-surge-hidden">
          <input data-group-part="surgeHidden" type="checkbox"${editor.surgeHidden ? " checked" : ""}>
          <span>${escapeHtml(t("groupSurgeHidden"))}</span>
        </label>
        <label class="group-check group-subscription-toggle group-node-option${usesNodeOptions ? "" : " hidden"}">
          <input data-group-part="includeAll" type="checkbox"${editor.includeAll ? " checked" : ""}>
          <span>${escapeHtml(t("groupIncludeAll"))}</span>
        </label>
        ${removalLocked ? "" : `
          <div class="group-card-actions">
            <button class="danger" data-remove type="button">${escapeHtml(t("remove"))}</button>
          </div>
        `}
      </td>
      <td class="group-definition-cell" data-label="Definition">
        <div class="group-editor">
          <div class="group-editor-grid">
            <div class="group-choice-field group-fixed-option${isSubnetGroup ? " hidden" : ""}">
              <span>${escapeHtml(t("groupFixedChoices"))}</span>
              <div class="group-choice-list">${renderGroupChoiceInputs(name, editor.choices)}</div>
              <small>${escapeHtml(t("groupFixedChoicesHelp"))}</small>
            </div>
            <label class="group-subnet-default-field group-subnet-option${isSubnetGroup ? "" : " hidden"}">
              <span>${escapeHtml(t("groupSubnetDefault"))}</span>
              <select data-group-part="subnetDefault">${renderSubnetPolicyOptions(name, editor.subnetDefault)}</select>
              <small>${escapeHtml(t("groupSubnetDefaultHelp"))}</small>
            </label>
            <div class="group-subnet-rules-field group-subnet-option${isSubnetGroup ? "" : " hidden"}">
              <div class="group-subnet-heading">
                <span>${escapeHtml(t("groupSubnetRules"))}</span>
                <button class="btn" data-subnet-add type="button">${escapeHtml(t("groupSubnetAddRule"))}</button>
              </div>
              ${renderSubnetRules(name, editor.subnetRules)}
              <small>${escapeHtml(t("groupSubnetRulesHelp"))}</small>
            </div>
            <label class="group-filter-field group-node-option${usesNodeOptions ? "" : " hidden"}">
              <span>${escapeHtml(t("groupFilterKeywords"))}</span>
              ${inputWithTitle('data-group-part="filter"', editor.filter)}
            </label>
            <label class="group-exclude-field group-node-option${usesNodeOptions ? "" : " hidden"}">
              <span>${escapeHtml(t("groupExcludeKeywords"))}</span>
              ${inputWithTitle('data-group-part="exclude"', editor.exclude)}
            </label>
            <small class="group-rule-help group-node-option${usesNodeOptions ? "" : " hidden"}">${escapeHtml(t("groupNodeRuleHelp"))}</small>
            <label class="group-url-field group-standard-option${isSubnetGroup ? " hidden" : ""}">
              <span>${escapeHtml(t("groupUrl"))}</span>
              ${inputWithTitle('data-group-part="url"', editor.url)}
            </label>
            <label class="group-interval-field group-standard-option${isSubnetGroup ? " hidden" : ""}">
              <span>${escapeHtml(t("groupInterval"))}</span>
              ${inputWithTitle('data-group-part="interval" inputmode="numeric"', editor.interval)}
            </label>
            <label class="group-advanced-field group-standard-option group-non-auto-option${isSubnetGroup ? " hidden" : ""}">
              <span>${escapeHtml(t("groupAdvancedOptions"))}</span>
              ${inputWithTitle('data-group-part="advancedOptions"', editor.advancedOptions.join(", "))}
              <small>${escapeHtml(t("groupAdvancedOptionsHelp"))}</small>
            </label>
          </div>
          <div class="group-generated">
            <span>${escapeHtml(t("groupGeneratedDefinition"))}</span>
            <code>${escapeHtml(displaySpec)}</code>
          </div>
        </div>
      </td>
    `;
    row.dataset.groupName = name;
    row.dataset.groupType = editor.type;
    row.querySelectorAll("td").forEach((cell) => {
      const labelKey = {
        Name: "tableName",
        Definition: "tableDefinition"
      }[cell.dataset.label];
      if (labelKey) cell.dataset.label = t(labelKey);
    });
    const nameInput = row.querySelector('[data-field="name"]');
    nameInput.addEventListener("input", (event) => updateGroupName(index, event.currentTarget));
    nameInput.addEventListener("change", () => renderGroups());
    row.querySelector("[data-group-enabled]")?.addEventListener("change", (event) => {
      setGroupDisabled(name, !event.currentTarget.checked);
      renderSummary();
    });
    row.querySelectorAll("[data-group-part]").forEach((input) => {
      const eventName = input.type === "checkbox" || input.tagName === "SELECT" ? "change" : "input";
      input.addEventListener(eventName, () => {
        syncGroupVisibility(row);
        updateGroupSpec(index, row);
      });
    });
    row.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const addButton = target?.closest("[data-subnet-add]");
      if (addButton) {
        addSubnetRuleRow(row);
        updateGroupSpec(index, row);
        return;
      }
      const removeButton = target?.closest("[data-subnet-remove]");
      if (removeButton) {
        removeButton.closest("[data-subnet-rule]")?.remove();
        ensureSubnetRuleEmptyState(row);
        updateGroupSpec(index, row);
      }
    });
    row.addEventListener("change", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.matches("[data-subnet-rule-part]")) return;
      syncSubnetRuleRows(row);
      updateGroupSpec(index, row);
    });
    row.addEventListener("input", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.matches('[data-subnet-rule-part="queryText"]')) return;
      updateGroupSpec(index, row);
    });
    row.querySelector("[data-remove]")?.addEventListener("click", () => {
      if (isRemovalLockedGroupName(name)) return;
      const next = groupEntries();
      next.splice(index, 1);
      setGroupEntries(normalizeGroupEntries(next));
      renderGroups();
      refreshConfigCodeEditors();
      renderSummary();
    });
    syncGroupVisibility(row);
    refs.groupsBody.append(row);
  });
}

function addSubnetRuleRow(row) {
  const list = row.querySelector("[data-subnet-rule-list]");
  if (!list) return;
  list.querySelector(".subnet-rule-empty")?.remove();
  list.insertAdjacentHTML("beforeend", renderSubnetRuleRow(row.dataset.groupName || "", { parameter: "TYPE", query: "WIFI", policy: "Proxy" }));
  syncSubnetRuleRows(row);
}

function ensureSubnetRuleEmptyState(row) {
  const list = row.querySelector("[data-subnet-rule-list]");
  if (list && !list.querySelector("[data-subnet-rule]")) {
    list.innerHTML = renderSubnetRuleEmpty();
  }
}

function syncSubnetRuleRows(row) {
  row.querySelectorAll("[data-subnet-rule]").forEach((ruleRow) => {
    const parameter = ruleRow.querySelector('[data-subnet-rule-part="parameter"]')?.value || "TYPE";
    const textField = ruleRow.querySelector(".subnet-query-text-field");
    const typeField = ruleRow.querySelector(".subnet-query-type-field");
    const isType = parameter === "TYPE";
    textField?.classList.toggle("hidden", isType);
    typeField?.classList.toggle("hidden", !isType);
  });
}

function syncGroupVisibility(row) {
  const type = row.querySelector('[data-group-part="type"]')?.value;
  row.dataset.groupType = type || "select";
  const help = row.querySelector("[data-group-type-help]");
  if (help) help.textContent = groupTypeHelp(type);
  const usesNodeOptions = type !== "fallback" && type !== "subnet";
  const isSubnetGroup = type === "subnet";
  const isAutoGroup = type === "url-test";
  const usesStandardOptions = type !== "select" && type !== "subnet";
  row.querySelectorAll(".group-node-option").forEach((element) => {
    element.classList.toggle("hidden", !usesNodeOptions);
  });
  row.querySelectorAll(".group-fixed-option").forEach((element) => {
    element.classList.toggle("hidden", isSubnetGroup);
  });
  row.querySelectorAll(".group-standard-option").forEach((element) => {
    element.classList.toggle("hidden", !usesStandardOptions);
  });
  row.querySelectorAll(".group-non-auto-option").forEach((element) => {
    element.classList.toggle("hidden", !usesStandardOptions || isAutoGroup);
  });
  row.querySelectorAll(".group-subnet-option").forEach((element) => {
    element.classList.toggle("hidden", !isSubnetGroup);
  });
  syncSubnetRuleRows(row);
  syncGroupNodeControls(row);
}

function syncGroupNodeControls(row) {
  const type = row.querySelector('[data-group-part="type"]')?.value;
  const includeAll = row.querySelector('[data-group-part="includeAll"]');
  const filter = row.querySelector('[data-group-part="filter"]');
  const exclude = row.querySelector('[data-group-part="exclude"]');
  const usesSubscriptionNodes = type !== "fallback" && type !== "subnet";
  const subscriptionNodesEnabled = usesSubscriptionNodes && Boolean(includeAll?.checked);
  if (includeAll) includeAll.disabled = !usesSubscriptionNodes;
  if (filter) filter.disabled = !subscriptionNodesEnabled;
  if (exclude) exclude.disabled = !subscriptionNodesEnabled;
}

function updateGroupName(index, input) {
  const entries = groupEntries();
  if (!entries[index]) return;
  const previousName = entries[index][0];
  const nextName = input.value.trim();
  if (isBuiltInGroupName(previousName)) {
    input.value = previousName;
    return;
  }
  if (isBuiltInGroupName(nextName)) {
    input.value = previousName;
    return;
  }
  if (entries.some(([name], entryIndex) => entryIndex !== index && name === nextName)) {
    input.value = previousName;
    return;
  }
  entries[index][0] = input.value;
  const renamedEntries = renameFixedGroupChoices(entries, previousName, input.value);
  setGroupEntries(renamedEntries);
  rowDatasetName(input, input.value);
  state.disabledGroups = (state.disabledGroups || []).map((name) => name === previousName ? input.value : name);
  refreshConfigCodeEditors();
  renderSummary();
}

function rowDatasetName(input, name) {
  const row = input.closest("tr");
  if (row) row.dataset.groupName = name;
}

function updateGroupSpec(index, row) {
  const entries = groupEntries();
  if (!entries[index]) return;
  const spec = serializeGroupEditor(readGroupEditor(row));
  entries[index][1] = spec;
  setGroupEntries(entries);
  row.querySelector(".group-generated code").textContent = spec;
  renderSummary();
}

function addGroup() {
  const entries = groupEntries();
  let name = t("newGroup");
  let suffix = 2;
  while (Object.prototype.hasOwnProperty.call(state.groups, name)) {
    name = `${t("newGroup")} ${suffix}`;
    suffix += 1;
  }
  entries.push([name, "select, {all}"]);
  setGroupEntries(entries);
  renderGroups();
  refreshConfigCodeEditors();
  renderSummary();
}

function renderSources() {
  refs.sourcesBody.innerHTML = "";
  for (const source of state.sources) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td data-label="Name">
        ${inputWithTitle('data-field="name"', source.name)}
        <small class="cell-help">${escapeHtml(t("sourceNameHelp"))}</small>
      </td>
      <td data-label="FetchUA">
        <select data-field="fetchUserAgent">
          <option value="surge">${escapeHtml(t("fetchUserAgentSurge"))}</option>
          <option value="clash">${escapeHtml(t("fetchUserAgentClash"))}</option>
          <option value="stash">${escapeHtml(t("fetchUserAgentStash"))}</option>
          <option value="shadowrocket">${escapeHtml(t("fetchUserAgentShadowrocket"))}</option>
        </select>
        <small class="cell-help">${escapeHtml(t("sourceFetchUserAgentHelp"))}</small>
      </td>
      <td class="source-enabled-cell" data-label="Enabled">
        <label class="source-enabled-toggle">
          <input data-field="enabled" type="checkbox">
        </label>
      </td>
      <td data-label="URL">
        ${inputWithTitle('class="url" data-field="url"', source.url || "")}
        <small class="cell-help">${escapeHtml(t("sourceUrlHelp"))}</small>
      </td>
      <td data-label="Action"><button class="danger" data-remove type="button">${escapeHtml(t("remove"))}</button></td>
    `;
    row.querySelectorAll("td").forEach((cell) => {
      const labelKey = {
        Name: "tableName",
        FetchUA: "tableFetchUserAgent",
        Enabled: "tableEnabled",
        URL: "tableUrl",
        Action: "tableAction"
      }[cell.dataset.label];
      if (labelKey) cell.dataset.label = t(labelKey);
    });
    row.querySelector('[data-field="fetchUserAgent"]').value = normalizedSourceFetchUserAgent(source.fetchUserAgent);
    row.querySelector('[data-field="enabled"]').checked = source.enabled;
    row.querySelectorAll("[data-field]").forEach((input) => {
      input.addEventListener("input", () => updateSource(source.id, input));
      input.addEventListener("change", () => updateSource(source.id, input));
    });
    row.querySelector("[data-remove]").addEventListener("click", () => {
      state.sources = state.sources.filter((item) => item.id !== source.id);
      renderSources();
      renderSummary();
    });
    refs.sourcesBody.append(row);
  }
}

function normalizedSourceFetchUserAgent(value) {
  return ["surge", "clash", "stash", "shadowrocket"].includes(value) ? value : "surge";
}

function updateSource(id, input) {
  const source = state.sources.find((item) => item.id === id);
  if (!source) return;
  const field = input.dataset.field;
  source[field] = input.type === "checkbox" ? input.checked : input.value;
  renderSummary();
}

function addSource() {
  state.sources.push({
    id: crypto.randomUUID(),
    name: t("newSource"),
    url: "",
    fetchUserAgent: "surge",
    enabled: true
  });
  renderSources();
  renderSummary();
}

function renderRuleSets() {
  const ruleSets = ensureRuleSets();
  refs.ruleSetAggregateByPolicy.checked = ruleSets.aggregateByPolicy === true;
  renderRuleSetRuleRows();
  renderRuleSetStatus();
}

function normalizeRuleSetMode(mode) {
  return mode === "compiled" ? "compiled" : "manual";
}

function ensureRuleSets() {
  state.ruleSets = state.ruleSets && typeof state.ruleSets === "object" ? state.ruleSets : {};
  state.ruleSets.mode = normalizeRuleSetMode(state.ruleSets.mode);
  state.ruleSets.aggregateByPolicy = state.ruleSets.aggregateByPolicy === true;
  state.ruleSets.sources = Array.isArray(state.ruleSets.sources) ? state.ruleSets.sources : [];
  state.ruleSets.outputs = Array.isArray(state.ruleSets.outputs) ? state.ruleSets.outputs : [];
  state.ruleSets.directRules = Array.isArray(state.ruleSets.directRules) ? state.ruleSets.directRules : [];
  return state.ruleSets;
}

function isRuleSetModeEnabled() {
  return ensureRuleSets().mode === "compiled";
}

function renderRuleSetMode() {
  const mode = ensureRuleSets().mode;
  refs.ruleSetModeManual.checked = mode !== "compiled";
  refs.ruleSetModeCompiled.checked = mode === "compiled";
  syncRuleSetModeTabs();
  syncConfigModeLayout();
  syncUnifiedConfigTabs();
  syncTargetRuleSectionsVisibility();
}

function syncRuleSetModeTabs() {
  refs.ruleSetModeManual.closest(".tab")?.classList.toggle("active", refs.ruleSetModeManual.checked);
  refs.ruleSetModeCompiled.closest(".tab")?.classList.toggle("active", refs.ruleSetModeCompiled.checked);
}

function syncTargetRuleSectionsVisibility() {
  if (!state) return;
  const compiled = isRuleSetModeEnabled();
  document.querySelectorAll("[data-manual-rule-tab]").forEach((tab) => {
    tab.classList.toggle("hidden", compiled);
    tab.setAttribute("aria-hidden", compiled ? "true" : "false");
    tab.tabIndex = compiled ? -1 : 0;
  });
  if (!compiled) return;
  document.querySelectorAll("[data-manual-rule-panel]").forEach((panel) => panel.classList.add("hidden"));
  if (document.querySelector('[data-surge-tab="rule"].active')) showSurgeTab("general");
  if (document.querySelector('[data-clash-tab="providers"].active, [data-clash-tab="rules"].active')) showClashTab("general");
  if (document.querySelector('[data-stash-tab="rule"].active')) showStashTab("general");
}

function updateRuleSetMode(mode) {
  ensureRuleSets().mode = normalizeRuleSetMode(mode);
  renderRuleSetMode();
  updateSaveAvailability();
}

function orderedRuleSetItems() {
  const ruleSets = ensureRuleSets();
  return [
    ...ruleSets.outputs.map((item, itemIndex) => ({ kind: "output", item, itemIndex, stableOrder: itemIndex })),
    ...ruleSets.directRules.map((item, itemIndex) => ({ kind: "direct", item, itemIndex, stableOrder: ruleSets.outputs.length + itemIndex }))
  ].sort((left, right) => {
    const orderDifference = (Number(left.item.order) || 0) - (Number(right.item.order) || 0);
    return orderDifference || left.stableOrder - right.stableOrder;
  });
}

function renderRuleSetRuleRows() {
  const items = orderedRuleSetItems();
  refs.ruleSetRulesBody.innerHTML = items.length
    ? items.map((entry, index) => renderRuleSetRuleRow(entry, index, items.length)).join("")
    : `<div class="rule-set-rule-empty">${escapeHtml(t("ruleSetRulesEmpty"))}</div>`;
}

function renderRuleSetRuleRow(entry, index, total) {
  return entry.kind === "output"
    ? renderRuleSetOutputRow(entry.item, entry.itemIndex, index, total)
    : renderRuleSetDirectRow(entry.item, entry.itemIndex, index, total);
}

function renderRuleSetKindOptions(kind) {
  return [
    ["single", t("ruleSetRuleKindSingle")],
    ["rule-set", t("ruleSetRuleKindOutput")]
  ].map(([value, label]) => `<option value="${value}"${value === kind ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");
}

function renderRuleSetRowActions(index, total) {
  return `
    <button class="btn" data-rule-set-move="up" type="button"${index === 0 ? " disabled" : ""}>${escapeHtml(t("moveUp"))}</button>
    <button class="btn" data-rule-set-move="down" type="button"${index === total - 1 ? " disabled" : ""}>${escapeHtml(t("moveDown"))}</button>
    <button class="danger" data-rule-set-remove type="button">${escapeHtml(t("remove"))}</button>
  `;
}

function renderRuleSetOutputRow(output, itemIndex, index, total) {
  return `
    <article class="rule-set-rule-row rule-set" data-rule-set-item data-rule-set-item-kind="output" data-rule-set-item-index="${itemIndex}">
      <label>
        <span>${escapeHtml(t("ruleSetRuleKind"))}</span>
        <select data-rule-set-kind>${renderRuleSetKindOptions("rule-set")}</select>
      </label>
      <label>
        <span>${escapeHtml(t("ruleSetOutputName"))}</span>
        ${inputWithTitle('data-rule-set-output-field="name"', output.name)}
      </label>
      <label>
        <span>${escapeHtml(t("ruleSetRuleType"))}</span>
        <input value="${escapeHtml(t("ruleSetAutoType"))}" disabled>
      </label>
      <label class="rule-set-source-urls">
        <span>${escapeHtml(t("ruleSetSourceUrls"))}</span>
        <textarea class="line-editor compact-editor" rows="3" wrap="off" data-rule-set-output-field="sourceUrls" spellcheck="false">${escapeHtml(ruleSetOutputSourceUrls(output))}</textarea>
      </label>
      <label>
        <span>${escapeHtml(t("ruleSetPolicy"))}</span>
        <select data-rule-set-output-field="policy">${renderRuleSetPolicyOptions(output.policy)}</select>
      </label>
      <label>
        <span>${escapeHtml(t("ruleSetSurgeOptions"))}</span>
        <select data-rule-set-output-field="surgeOptions">${renderRuleSetOutputSurgeOptionChoices(output.surgeOptions)}</select>
      </label>
      <label class="rule-set-rule-enabled">
        <span>${escapeHtml(t("ruleSetOutputEnabled"))}</span>
        <span class="check"><input data-rule-set-output-field="enabled" type="checkbox"${output.enabled !== false ? " checked" : ""}></span>
      </label>
      <div class="rule-set-rule-actions">${renderRuleSetRowActions(index, total)}</div>
    </article>
  `;
}

function renderRuleSetOutputSurgeOptionChoices(options) {
  const requested = normalizeRuleSetOptionList(options);
  const selected = ["no-resolve", "extended-matching"].filter((option) => requested.includes(option));
  const selectedValue = selected.join(",");
  return [
    ["", t("ruleSetOptionNone")],
    ["no-resolve", "no-resolve"],
    ["extended-matching", "extended-matching"],
    ["no-resolve,extended-matching", "no-resolve + extended-matching"]
  ].map(([value, label]) => `<option value="${value}"${value === selectedValue ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");
}

function normalizeRuleSetOptionList(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(values.map((option) => String(option || "").trim().toLowerCase()).filter(Boolean))];
}

function parseRuleSetDirectRule(rule) {
  const parts = splitSurgeRuleLine(String(rule.rule || ""));
  const parsedType = (parts[0] || "DOMAIN-SUFFIX").trim().toUpperCase();
  const ruleType = parsedType === "MATCH" ? "FINAL" : parsedType;
  const valueless = ruleType === "FINAL";
  const third = (parts[2] || "").trim().toLowerCase();
  return {
    ruleType,
    value: valueless ? "" : parts[1] || "",
    options: (valueless ? parts.slice(2) : (third === "no-resolve" || third === "src" ? parts.slice(2) : parts.slice(3))).join(", ")
  };
}

function renderRuleSetDirectTypeOptions(selected) {
  const supported = ["DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "IP-CIDR", "IP-CIDR6", "IP-ASN", "GEOIP", "PROCESS-NAME", "USER-AGENT", "URL-REGEX", "FINAL"];
  const types = supported.includes(selected) ? supported : [selected, ...supported].filter(Boolean);
  return types.map((type) => `<option value="${escapeHtml(type)}"${type === selected ? " selected" : ""}>${escapeHtml(type)}</option>`).join("");
}

function renderRuleSetDirectOptionChoices(ruleType, selected) {
  const choices = [["", t("ruleSetOptionNone")]];
  if (["IP-CIDR", "IP-CIDR6", "GEOIP", "IP-ASN"].includes(ruleType)) {
    choices.push(
      ["no-resolve", "no-resolve (Surge / Clash / Stash)"],
      ["src", "src (Clash)"],
      ["no-resolve,src", "no-resolve + src (Clash)"]
    );
  }
  if (["DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "URL-REGEX"].includes(ruleType)) {
    choices.push(["extended-matching", "extended-matching (Surge)"]);
  }
  if (ruleType === "FINAL") choices.push(["dns-failed", "dns-failed (Surge)"]);
  if (selected && !choices.some(([value]) => value === selected)) choices.push([selected, selected]);
  return choices.map(([value, label]) => `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");
}

function allowedUnifiedDirectRuleOptions(ruleType) {
  if (["IP-CIDR", "IP-CIDR6", "GEOIP", "IP-ASN"].includes(ruleType)) return new Set(["no-resolve", "src"]);
  if (["DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "URL-REGEX"].includes(ruleType)) return new Set(["extended-matching"]);
  if (ruleType === "FINAL") return new Set(["dns-failed"]);
  return new Set();
}

function renderRuleSetDirectRow(rule, itemIndex, index, total) {
  const parsed = parseRuleSetDirectRule(rule);
  const valueless = parsed.ruleType === "FINAL";
  return `
    <article class="rule-set-rule-row single" data-rule-set-item data-rule-set-item-kind="direct" data-rule-set-item-index="${itemIndex}">
      <label>
        <span>${escapeHtml(t("ruleSetRuleKind"))}</span>
        <select data-rule-set-kind>${renderRuleSetKindOptions("single")}</select>
      </label>
      <label>
        <span>${escapeHtml(t("ruleSetRuleType"))}</span>
        <select data-rule-set-direct-field="ruleType">${renderRuleSetDirectTypeOptions(parsed.ruleType)}</select>
      </label>
      <label>
        <span>${escapeHtml(t("ruleSetRuleValue"))}</span>
        ${inputWithTitle(`data-rule-set-direct-field="value"${valueless ? " disabled" : ""}`, parsed.value)}
      </label>
      <label>
        <span>${escapeHtml(t("ruleSetPolicy"))}</span>
        <select data-rule-set-direct-field="policy">${renderRuleSetPolicyOptions(rule.policy)}</select>
      </label>
      <label>
        <span>${escapeHtml(t("ruleSetOptions"))}</span>
        <select data-rule-set-direct-field="options">${renderRuleSetDirectOptionChoices(parsed.ruleType, parsed.options)}</select>
      </label>
      <label class="rule-set-rule-enabled">
        <span>${escapeHtml(t("ruleSetOutputEnabled"))}</span>
        <span class="check"><input data-rule-set-direct-field="enabled" type="checkbox"${rule.enabled !== false ? " checked" : ""}></span>
      </label>
      <div class="rule-set-rule-actions">${renderRuleSetRowActions(index, total)}</div>
    </article>
  `;
}

function renderRuleSetStatus() {
  if (!refs.ruleSetStatusSummary) return;
  const outputs = Array.isArray(ruleSetStatus?.outputs) ? ruleSetStatus.outputs : [];
  const cached = outputs.filter((output) => output.cached).length;
  refs.ruleSetStatusSummary.innerHTML = `<div class="${cached > 0 ? "success" : "warning"}">${escapeHtml(cached > 0 ? t("ruleSetStatusReady").replace("{count}", String(cached)) : t("ruleSetStatusEmpty"))}</div>`;
}

function renderRuleSetPolicyOptions(selected) {
  const selectedPolicy = String(selected || "Proxy").trim() || "Proxy";
  const candidates = clashPolicyCandidates();
  if (!candidates.includes(selectedPolicy)) candidates.push(selectedPolicy);
  return candidates.map((policy) => `<option value="${escapeHtml(policy)}"${policy === selectedPolicy ? " selected" : ""}>${escapeHtml(renderPolicyLabel(policy))}</option>`).join("");
}

function updateRuleSetOutput(index, input) {
  const output = ensureRuleSets().outputs[index];
  if (!output) return;
  const field = input.dataset.ruleSetOutputField;
  if (field === "sourceUrls") {
    syncRuleSetOutputSourceUrls(ensureRuleSets(), output, input.value);
  } else if (field === "surgeOptions") {
    output.surgeOptions = normalizeRuleSetOptionList(input.value);
  } else {
    output[field] = input.type === "checkbox" ? input.checked : input.value;
  }
}

function ruleSetOutputSourceUrls(output) {
  const sourcesById = new Map(ensureRuleSets().sources.map((source) => [source.id, source]));
  return (output.sourceIds || [])
    .map((id) => sourcesById.get(id)?.url || "")
    .filter(Boolean)
    .join("\n");
}

function syncRuleSetOutputSourceUrls(ruleSets, output, value) {
  const urls = [...new Set(textToLines(value))];
  output.sourceIds = urls.map((url) => {
    const existing = ruleSets.sources.find((source) => source.url === url);
    if (existing) {
      existing.enabled = true;
      return existing.id;
    }
    const source = {
      id: crypto.randomUUID(),
      name: ruleSetSourceName(url),
      url,
      enabled: true,
      format: "auto",
      order: nextRuleSetOrder(ruleSets.sources)
    };
    ruleSets.sources.push(source);
    return source.id;
  });
  pruneUnusedRuleSetSources(ruleSets);
}

function ruleSetSourceName(url) {
  try {
    const parsed = new URL(url);
    const filename = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).at(-1) || "");
    return filename || parsed.hostname || "规则来源";
  } catch {
    return "规则来源";
  }
}

function pruneUnusedRuleSetSources(ruleSets) {
  const usedIds = new Set(ruleSets.outputs.flatMap((output) => output.sourceIds || []));
  ruleSets.sources = ruleSets.sources.filter((source) => usedIds.has(source.id));
}

function buildRuleSetDirectRuleLine(ruleType, value, policy, options) {
  const normalizedType = String(ruleType || "DOMAIN-SUFFIX").trim().toUpperCase();
  const normalizedPolicy = String(policy || "Proxy").trim() || "Proxy";
  if (normalizedType === "FINAL" || normalizedType === "MATCH") {
    return ["FINAL", normalizedPolicy, ...normalizeRuleSetOptionList(options)].join(",");
  }
  const parts = [normalizedType, String(value || "").trim(), normalizedPolicy];
  parts.push(...normalizeRuleSetOptionList(options));
  return parts.join(",");
}

function updateRuleSetDirectRuleFromRow(index, row, filterOptionsForType = false) {
  const rule = ensureRuleSets().directRules[index];
  if (!rule) return;
  const ruleType = row.querySelector('[data-rule-set-direct-field="ruleType"]')?.value || "DOMAIN-SUFFIX";
  const value = row.querySelector('[data-rule-set-direct-field="value"]')?.value || "";
  const policy = row.querySelector('[data-rule-set-direct-field="policy"]')?.value || "Proxy";
  const selectedOptions = row.querySelector('[data-rule-set-direct-field="options"]')?.value || "";
  const options = filterOptionsForType
    ? normalizeRuleSetOptionList(selectedOptions).filter((option) => allowedUnifiedDirectRuleOptions(ruleType).has(option)).join(",")
    : selectedOptions;
  rule.policy = policy;
  rule.rule = buildRuleSetDirectRuleLine(ruleType, value, policy, options);
  rule.enabled = row.querySelector('[data-rule-set-direct-field="enabled"]')?.checked !== false;
}

function convertRuleSetItem(index, currentKind, nextKind) {
  const ruleSets = ensureRuleSets();
  if ((currentKind === "output" && nextKind === "single") || (currentKind === "direct" && nextKind === "rule-set")) {
    if (!window.confirm(t("ruleSetKindChangeConfirm"))) {
      renderRuleSetRuleRows();
      return;
    }
  }
  if (currentKind === "output" && nextKind === "single") {
    const output = ruleSets.outputs[index];
    if (!output) return;
    ruleSets.outputs.splice(index, 1);
    ruleSets.directRules.push({
      id: crypto.randomUUID(),
      name: output.name || t("newRuleSetDirectRule"),
      enabled: output.enabled !== false,
      rule: buildRuleSetDirectRuleLine("DOMAIN-SUFFIX", "", output.policy, ""),
      policy: output.policy || "Proxy",
      order: output.order
    });
    pruneUnusedRuleSetSources(ruleSets);
    renderRuleSetRuleRows();
    return;
  }
  if (currentKind === "direct" && nextKind === "rule-set") {
    const rule = ruleSets.directRules[index];
    if (!rule) return;
    ruleSets.directRules.splice(index, 1);
    ruleSets.outputs.push({
      name: uniqueRuleSetOutputName(rule.name && rule.name !== t("newRuleSetDirectRule") ? rule.name : t("newRuleSetOutput")),
      enabled: rule.enabled !== false,
      policy: rule.policy || "Proxy",
      sourceIds: [],
      inlineRules: [],
      order: rule.order,
      surgeOptions: []
    });
    renderRuleSetRuleRows();
  }
}

function moveRuleSetItem(itemIndex, kind, direction) {
  const items = orderedRuleSetItems();
  const index = items.findIndex((entry) => entry.kind === kind && entry.itemIndex === itemIndex);
  const nextIndex = index + direction;
  if (index < 0 || nextIndex < 0 || nextIndex >= items.length) return;
  [items[index], items[nextIndex]] = [items[nextIndex], items[index]];
  items.forEach((entry, order) => {
    entry.item.order = order;
  });
  renderRuleSetRuleRows();
}

function removeRuleSetItem(index, kind) {
  const ruleSets = ensureRuleSets();
  if (kind === "output") {
    ruleSets.outputs.splice(index, 1);
    pruneUnusedRuleSetSources(ruleSets);
  } else {
    ruleSets.directRules.splice(index, 1);
  }
  orderedRuleSetItems().forEach((entry, order) => {
    entry.item.order = order;
  });
  renderRuleSetRuleRows();
  renderRuleSetStatus();
}

function handleRuleSetRuleEdit(event) {
  const target = event.target instanceof Element ? event.target : null;
  const row = target?.closest("[data-rule-set-item]");
  if (!row) return;
  const index = Number(row.dataset.ruleSetItemIndex);
  const kind = row.dataset.ruleSetItemKind || "";
  if (!Number.isInteger(index) || index < 0) return;
  if (target.matches("[data-rule-set-kind]")) {
    if (event.type === "change") convertRuleSetItem(index, kind, target.value);
    return;
  }
  if (kind === "output" && target.matches("[data-rule-set-output-field]")) {
    updateRuleSetOutput(index, target);
    return;
  }
  if (kind !== "direct") return;
  if (target.matches("[data-rule-set-direct-field]")) {
    const ruleTypeChanged = event.type === "change" && target.dataset.ruleSetDirectField === "ruleType";
    updateRuleSetDirectRuleFromRow(index, row, ruleTypeChanged);
    if (ruleTypeChanged) {
      renderRuleSetRuleRows();
    }
    return;
  }
}

function handleRuleSetRuleClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  const row = target?.closest("[data-rule-set-item]");
  if (!row) return;
  const index = Number(row.dataset.ruleSetItemIndex);
  const kind = row.dataset.ruleSetItemKind || "";
  if (!Number.isInteger(index) || index < 0) return;
  if (target.closest("[data-rule-set-remove]")) {
    removeRuleSetItem(index, kind);
    return;
  }
  const move = target.closest("[data-rule-set-move]")?.dataset.ruleSetMove;
  if (move === "up") moveRuleSetItem(index, kind, -1);
  if (move === "down") moveRuleSetItem(index, kind, 1);
}

function addRuleSetOutput() {
  ensureRuleSets().outputs.push({
    name: uniqueRuleSetOutputName(t("newRuleSetOutput")),
    enabled: true,
    policy: "Proxy",
    sourceIds: [],
    inlineRules: [],
    order: nextRuleSetOrder([...ensureRuleSets().outputs, ...ensureRuleSets().directRules]),
    surgeOptions: []
  });
  renderRuleSetRuleRows();
}

function uniqueRuleSetOutputName(preferredName) {
  const normalizeName = (value) => String(value || "").normalize("NFC").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  const base = normalizeName(preferredName) || t("newRuleSetOutput");
  const names = new Set(ensureRuleSets().outputs.map((output) => normalizeName(output.name)));
  if (!names.has(base)) return base;
  let suffix = 2;
  while (names.has(`${base} ${suffix}`)) suffix += 1;
  return `${base} ${suffix}`;
}

function addRuleSetDirectRule() {
  ensureRuleSets().directRules.push({
    id: crypto.randomUUID(),
    name: t("newRuleSetDirectRule"),
    enabled: true,
    rule: "DOMAIN-SUFFIX,,Proxy",
    policy: "Proxy",
    order: nextRuleSetOrder([...ensureRuleSets().outputs, ...ensureRuleSets().directRules])
  });
  renderRuleSetRuleRows();
}

function nextRuleSetOrder(items) {
  return Math.max(-1, ...items.map((item) => Number(item.order) || 0)) + 1;
}

async function refreshRuleSets() {
  refs.refreshRuleSetsBtn.disabled = true;
  refs.ruleSetStatusSummary.innerHTML = `<div class="warning">${escapeHtml(t("saving"))}</div>`;
  try {
    await requestRuleSetRefresh();
  } catch (error) {
    refs.ruleSetStatusSummary.innerHTML = `<div class="error">${escapeHtml(t("ruleSetRefreshFailed"))}${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`;
  } finally {
    refs.refreshRuleSetsBtn.disabled = false;
  }
}

function renderProxyNodeEmptyState() {
  return `<div class="proxy-node-empty">${escapeHtml(t("proxyNodeNoRows"))}</div>`;
}

function proxyNodeConfigText(node) {
  const config = String(node.config || "").trim();
  return config || legacyProxyNodeConfigText(node);
}

function legacyProxyNodeConfigText(node) {
  const server = String(node.server || "").trim();
  const port = Number(node.port);
  if (!server || !Number.isFinite(port) || port < 1 || port > 65535) return "";
  const protocol = PROXY_NODE_PROTOCOLS.includes(node.protocol) ? node.protocol : "socks5";
  const name = String(node.name || t("newProxyNode")).trim() || t("newProxyNode");
  const username = String(node.username || "").trim();
  const password = String(node.password || "").trim();
  const parts = [server, String(port)];
  if (protocol === "ss") {
    if (username) parts.push(`encrypt-method=${username}`);
    if (password) parts.push(`password=${password}`);
  } else if (protocol === "snell") {
    if (password) parts.push(`psk=${password}`);
    parts.push("version=4");
  } else if (protocol === "tuic") {
    if (username) parts.push(`username=${username}`);
    if (password) parts.push(`password=${password}`);
  } else if (["trojan", "hysteria2", "anytls"].includes(protocol)) {
    if (password) parts.push(`password=${password}`);
  } else {
    if (username) parts.push(`username=${username}`);
    if (password) parts.push(`password=${password}`);
  }
  return `${name} = ${protocol}, ${parts.join(", ")}`;
}

function renderProxyNodes() {
  const nodes = state.proxyNodes || [];
  refs.proxyNodesBody.innerHTML = nodes.length > 0 ? "" : renderProxyNodeEmptyState();
  nodes.forEach((node, index) => {
    const card = document.createElement("section");
    card.className = "proxy-node-card";
    card.dataset.proxyNodeId = node.id;
    card.innerHTML = `
      <div class="proxy-node-card-head">
        <div class="proxy-node-card-kicker">${escapeHtml(t("proxyNodesTitle"))} #${index + 1}</div>
        <div class="proxy-node-card-actions">
          <label class="check proxy-node-check"><input data-field="enabled" type="checkbox"${node.enabled !== false ? " checked" : ""}> <span>${escapeHtml(t("proxyNodeEnabled"))}</span></label>
          <label class="check proxy-node-check"><input data-field="chainExit" type="checkbox"${node.chainExit === true ? " checked" : ""}> <span>${escapeHtml(t("proxyNodeChainExit"))}</span></label>
          <button class="danger proxy-node-remove" data-remove type="button">${escapeHtml(t("remove"))}</button>
        </div>
      </div>
      <div class="proxy-node-card-grid">
        <label class="proxy-node-field proxy-node-config-field">
          <span>${escapeHtml(t("proxyNodeConfigText"))}</span>
          <textarea class="line-editor config-code-textarea proxy-node-config-textarea" rows="10" data-code-editor-max-rows="10" data-field="config" spellcheck="false" placeholder="${escapeHtml(t("proxyNodeConfigPlaceholder"))}">${escapeHtml(proxyNodeConfigText(node))}</textarea>
          <small>${escapeHtml(t("proxyNodeConfigHelp"))}</small>
        </label>
        ${node.chainExit === true ? `
        <div class="proxy-node-field proxy-node-chain-options-field">
          <span>${escapeHtml(t("proxyNodeFlags"))}</span>
          <label class="check proxy-node-check proxy-node-option-check"><input data-field="includeInGroups" type="checkbox"${node.includeInGroups === true ? " checked" : ""}> <span>${escapeHtml(t("proxyNodeIncludeInGroups"))}</span></label>
          <small>${escapeHtml(t("proxyNodeIncludeInGroupsHelp"))}</small>
        </div>
        <label class="proxy-node-field proxy-node-chain-filter-field">
          <span>${escapeHtml(t("proxyNodeChainFilter"))}</span>
          <input data-field="chainFilter" type="text" value="${escapeHtml((node.chainFilter || []).join(", "))}" placeholder="${escapeHtml(t("proxyNodeChainFilterPlaceholder"))}">
          <small>${escapeHtml(t("proxyNodeChainFilterHelp"))}</small>
        </label>
        ` : ""}
      </div>
    `;
    card.querySelectorAll("[data-field]").forEach((input) => {
      input.addEventListener(input.type === "checkbox" ? "change" : "input", () => updateProxyNode(node.id, input));
    });
    card.querySelector("[data-remove]").addEventListener("click", () => {
      state.proxyNodes = (state.proxyNodes || []).filter((item) => item.id !== node.id);
      renderProxyNodes();
    });
    refs.proxyNodesBody.append(card);
  });
  void ensureConfigCodeEditors();
}

function updateProxyNode(id, input) {
  const node = (state.proxyNodes || []).find((item) => item.id === id);
  if (!node) return;
  const field = input.dataset.field;
  if (field === "enabled") {
    node[field] = input.checked;
    return;
  }
  if (field === "chainExit") {
    node.chainExit = input.checked;
    node.includeInGroups = input.checked ? false : true;
    renderProxyNodes();
    return;
  }
  if (field === "includeInGroups") {
    node.includeInGroups = input.checked;
    return;
  }
  if (field === "chainFilter") {
    node.chainFilter = input.value.split(",").map((item) => item.trim()).filter(Boolean);
    return;
  }
  node[field] = input.value;
}

function addProxyNode() {
  if (!Array.isArray(state.proxyNodes)) state.proxyNodes = [];
  state.proxyNodes.push({
    id: crypto.randomUUID(),
    config: "",
    chainFilter: [],
    enabled: true,
    chainExit: false,
    includeInGroups: false
  });
  renderProxyNodes();
}

function validateProxyNodes() {
  const errors = [];
  const names = new Set();
  const groupNames = new Set(Object.keys(state.groups || {}).map((name) => name.trim()).filter(Boolean));
  (state.proxyNodes || []).forEach((node, index) => {
    const rowNumber = index + 1;
    const config = proxyNodeConfigText(node);
    if (!config) {
      errors.push(`第 ${rowNumber} 个代理节点缺少配置文本。`);
      return;
    }
    const draft = parseProxyNodeConfigDraft(config);
    if (!draft.valid) {
      errors.push(`第 ${rowNumber} 个代理节点需要是完整 Surge 节点行或 Clash proxy YAML。`);
      return;
    }
    if (names.has(draft.name)) {
      errors.push(`代理节点名称 ${draft.name} 重复。`);
    }
    if (groupNames.has(draft.name)) {
      errors.push(formatMessage("proxyNodeGroupNameConflict", { name: draft.name }));
    }
    names.add(draft.name);
  });
  return { errors };
}

function proxyNodeDraftNames() {
  const names = new Set();
  (state.proxyNodes || []).forEach((node) => {
    const draft = parseProxyNodeConfigDraft(proxyNodeConfigText(node));
    if (draft.valid && draft.name) names.add(draft.name);
  });
  return names;
}

function validateGroups() {
  const errors = [];
  const proxyNodeNames = proxyNodeDraftNames();
  Object.keys(state.groups || {}).forEach((name) => {
    if (proxyNodeNames.has(name)) {
      errors.push(formatMessage("groupProxyNodeNameConflict", { name }));
    }
  });
  return { errors };
}

function readSettingsDraft() {
  const notificationTelegramBotToken = refs.notificationTelegramBotToken.value.trim();
  return {
    settings: {
      ...state.settings,
      managedBaseUrl: refs.managedBaseUrl.value.trim(),
      userAgentSurge: refs.userAgentSurge.value.trim(),
      userAgentClash: refs.userAgentClash.value.trim(),
      userAgentStash: refs.userAgentStash.value.trim(),
      userAgentShadowrocket: refs.userAgentShadowrocket.value.trim(),
      excludeKeywords: refs.excludeKeywords.value.split(",").map((item) => item.trim()).filter(Boolean),
      featureTagRules: textToLines(refs.featureTagRules.value),
      displayTimeZone: normalizeDisplayTimeZone(refs.displayTimeZone.value),
      updateCheckEnabled: refs.updateCheckEnabled.checked,
      notificationChannel: notificationTelegramBotToken ? "telegram" : "off",
      notificationTelegramChatId: notificationTelegramBotToken ? state.settings.notificationTelegramChatId || "" : "",
      notificationTelegramBotToken
    },
    ruleSets: {
      mode: refs.ruleSetModeCompiled.checked ? "compiled" : "manual"
    }
  };
}

function collectSettings() {
  const draft = readSettingsDraft();
  state.settings = draft.settings;
  ensureRuleSets().mode = draft.ruleSets.mode;
}

function readSurgeDraft() {
  const encryptedDnsServer = refs.surgeEncryptedDnsServer.value.split(",").map((item) => item.trim()).filter(Boolean);
  const compiledRules = isRuleSetModeEnabled();
  return {
    ...state.surge,
    skipProxy: refs.surgeSkipProxy.value.split(",").map((item) => item.trim()).filter(Boolean),
    dnsServer: refs.surgeDnsServer.value.split(",").map((item) => item.trim()).filter(Boolean),
    alwaysRealIp: refs.surgeAlwaysRealIp.value.split(",").map((item) => item.trim()).filter(Boolean),
    managedConfigIntervalSeconds: Number(refs.surgeManagedConfigIntervalSeconds.value) || state.surge.managedConfigIntervalSeconds,
    internetTestUrl: refs.surgeInternetTestUrl.value.trim(),
    proxyTestUrl: refs.surgeProxyTestUrl.value.trim(),
    showErrorPageForReject: refs.surgeShowErrorPageForReject.checked,
    ipv6: refs.surgeIpv6.checked,
    ipv6Vif: refs.surgeIpv6Vif.value.trim(),
    allowWifiAccess: refs.surgeAllowWifiAccess.checked,
    tunExcludedRoutes: refs.surgeTunExcludedRoutes.value.split(",").map((item) => item.trim()).filter(Boolean),
    encryptedDnsServer,
    wifiAssist: refs.surgeWifiAssist.checked,
    excludeSimpleHostnames: refs.surgeExcludeSimpleHostnames.checked,
    encryptedDnsFollowOutboundMode: encryptedDnsServer.length > 0 && refs.surgeEncryptedDnsFollowOutboundMode.checked,
    ponteDeviceNames: normalizePonteDeviceNames(refs.surgePonteDeviceNames.value),
    hosts: isModeTogglePressed(refs.surgeHostAdvancedMode)
      ? textToLines(refs.surgeHosts.value)
      : buildSurgeHostLines(readSurgeHostRows()),
    urlRewrite: isModeTogglePressed(refs.surgeUrlRewriteAdvancedMode)
      ? textToLines(refs.surgeUrlRewrite.value)
      : buildSurgeUrlRewriteLines(readSurgeUrlRewriteRows()),
    scripts: textToLines(refs.surgeScripts.value),
    mitm: {
      ...state.surge.mitm,
      skipServerCertVerify: refs.surgeMitmSkipServerCertVerify.checked,
      h2: refs.surgeMitmH2.checked,
      hostname: textToLines(refs.surgeMitmHostname.value),
      caPassphrase: refs.surgeMitmCaPassphrase.value.trim(),
      caP12: refs.surgeMitmCaP12.value.trim()
    },
    rules: compiledRules
      ? state.surge.rules
      : isModeTogglePressed(refs.surgeRuleAdvancedMode)
        ? textToLines(refs.surgeRules.value)
        : buildSurgeRuleLines(readSurgeRuleRows())
  };
}

function readClashDraft() {
  const compiledRules = isRuleSetModeEnabled();
  return {
    ...state.clash,
    port: Number(refs.clashPort.value) || 7890,
    socksPort: Number(refs.clashSocksPort.value) || 7891,
    mixedPort: Number(refs.clashMixedPort.value) || 7892,
    allowLan: refs.clashAllowLan.checked,
    mode: DEFAULT_CLASH_MODE,
    logLevel: DEFAULT_CLASH_LOG_LEVEL,
    ipv6: refs.clashIpv6.checked,
    unifiedDelay: refs.clashUnifiedDelay.checked,
    tcpConcurrent: refs.clashTcpConcurrent.checked,
    externalController: refs.clashExternalController.value.trim(),
    tun: {
      ...state.clash.tun,
      enable: refs.clashTunEnable.checked,
      stack: refs.clashTunStack.value.trim(),
      autoRoute: refs.clashTunAutoRoute.checked,
      autoDetectInterface: refs.clashTunAutoDetectInterface.checked,
      skipProxy: textToLines(refs.clashTunSkipProxy.value)
    },
    dnsEnabled: refs.clashDnsEnabled.checked,
    dnsListen: refs.clashDnsListen.value.trim(),
    dnsIpv6: refs.clashDnsIpv6.checked,
    dnsEnhancedMode: refs.clashDnsEnhancedMode.value,
    dnsFakeIpRange: refs.clashDnsFakeIpRange.value.trim(),
    defaultNameservers: textToLines(refs.clashDefaultNameservers.value),
    nameservers: textToLines(refs.clashNameservers.value),
    fallbackNameservers: textToLines(refs.clashFallbackNameservers.value),
    fallbackFilterGeoip: refs.clashFallbackFilterGeoip.checked,
    fallbackFilterIpcidr: textToLines(refs.clashFallbackFilterIpcidr.value),
    fakeIpFilter: textToLines(refs.clashFakeIpFilter.value),
    ruleProviders: compiledRules ? state.clash.ruleProviders : refs.clashRuleProviders.value.trimEnd(),
    rules: compiledRules ? state.clash.rules : currentClashRuleLines()
  };
}

function readStashDraft() {
  const compiledRules = isRuleSetModeEnabled();
  return {
    ...state.stash,
    port: Number(refs.stashPort.value) || 7890,
    socksPort: Number(refs.stashSocksPort.value) || 7891,
    mixedPort: Number(refs.stashMixedPort.value) || 7892,
    allowLan: refs.stashAllowLan.checked,
    mode: refs.stashMode.value || DEFAULT_CLASH_MODE,
    logLevel: refs.stashLogLevel.value || DEFAULT_CLASH_LOG_LEVEL,
    ipv6: refs.stashIpv6.checked,
    unifiedDelay: refs.stashUnifiedDelay.checked,
    tcpConcurrent: refs.stashTcpConcurrent.checked,
    externalController: refs.stashExternalController.value.trim(),
    tun: {
      ...state.stash.tun,
      enable: refs.stashTunEnable.checked,
      stack: refs.stashTunStack.value.trim(),
      autoRoute: refs.stashTunAutoRoute.checked,
      autoDetectInterface: refs.stashTunAutoDetectInterface.checked,
      skipProxy: textToLines(refs.stashTunSkipProxy.value)
    },
    dns: {
      ...state.stash.dns,
      enable: refs.stashDnsEnabled.checked,
      listen: refs.stashDnsListen.value.trim(),
      ipv6: refs.stashDnsIpv6.checked,
      enhancedMode: refs.stashDnsEnhancedMode.value,
      fakeIpRange: refs.stashDnsFakeIpRange.value.trim(),
      defaultNameservers: textToLines(refs.stashDefaultNameservers.value),
      nameservers: textToLines(refs.stashNameservers.value),
      fallbackNameservers: textToLines(refs.stashFallbackNameservers.value),
      fallbackFilterGeoip: refs.stashFallbackFilterGeoip.checked,
      fallbackFilterIpcidr: textToLines(refs.stashFallbackFilterIpcidr.value),
      fakeIpFilter: textToLines(refs.stashFakeIpFilter.value)
    },
    hosts: textToLines(refs.stashHosts.value),
    urlRewrite: textToLines(refs.stashUrlRewrite.value),
    scripts: textToLines(refs.stashScripts.value),
    mitm: {
      hostname: textToLines(refs.stashMitmHostname.value)
    },
    ruleProviders: compiledRules ? state.stash.ruleProviders : refs.stashRuleProviders.value.trimEnd(),
    rules: compiledRules ? state.stash.rules : parseClashRulesYaml(refs.stashRules.value).rules
  };
}

function readGroupsDraft() {
  const groups = Object.fromEntries(groupEntries()
    .map(([name, spec]) => [name.trim(), normalizeGroupSpec(name.trim(), spec)])
    .filter(([name]) => name));
  const disabledGroups = (state.disabledGroups || [])
    .map((name) => String(name).trim())
    .filter((name, index, names) => name && name !== "Proxy" && Object.prototype.hasOwnProperty.call(groups, name) && names.indexOf(name) === index);
  return { groups, disabledGroups };
}

function pageDraft(page) {
  if (!state) return null;
  if (page === "settings") return readSettingsDraft();
  if (page === "sources") return { sources: cloneConfig(state.sources || []) };
  if (page === "proxy-nodes") return { proxyNodes: cloneConfig(state.proxyNodes || []) };
  if (page === "groups") return readGroupsDraft();
  if (page === "unified-config") {
    return {
      ruleSets: cloneConfig(ensureRuleSets()),
      common: cloneConfig(ensureUnifiedCommonDraft())
    };
  }
  if (page === "surge") return { surge: readSurgeDraft() };
  if (page === "clash") return { clash: readClashDraft() };
  if (page === "stash") return { stash: readStashDraft() };
  return null;
}

function pageBaseline(page) {
  if (!lastSavedState) return null;
  if (page === "settings") {
    return {
      settings: lastSavedState.settings,
      ruleSets: {
        mode: normalizeRuleSetMode(lastSavedState.ruleSets?.mode)
      }
    };
  }
  if (page === "sources") return { sources: lastSavedState.sources || [] };
  if (page === "proxy-nodes") return { proxyNodes: lastSavedState.proxyNodes || [] };
  if (page === "groups") return { groups: lastSavedState.groups, disabledGroups: lastSavedState.disabledGroups };
  if (page === "unified-config") {
    return {
      ruleSets: lastSavedState.ruleSets || { mode: "manual", sources: [], outputs: [], directRules: [] },
      common: unifiedCommonState(lastSavedState)
    };
  }
  if (page === "surge") return { surge: lastSavedState.surge };
  if (page === "clash") return { clash: lastSavedState.clash };
  if (page === "stash") return { stash: lastSavedState.stash };
  return null;
}

function hasUnsavedChanges(page) {
  const draft = pageDraft(page);
  const baseline = pageBaseline(page);
  return Boolean(draft && baseline && JSON.stringify(draft) !== JSON.stringify(baseline));
}

function cloneConfig(value) {
  return JSON.parse(JSON.stringify(value));
}

function collectGroups() {
  const draft = readGroupsDraft();
  state.groups = draft.groups;
  state.disabledGroups = draft.disabledGroups;
}

function collectSurge() {
  state.surge = readSurgeDraft();
}

function collectClash() {
  state.clash = readClashDraft();
}

function collectStash() {
  state.stash = readStashDraft();
}

function syncSurgeIpv6VifVisibility() {
  refs.surgeIpv6VifRow.classList.toggle("hidden", !refs.surgeIpv6.checked);
  refs.surgeIpv6Vif.disabled = !refs.surgeIpv6.checked;
}

function syncSurgeEncryptedDnsFollowOutboundModeVisibility() {
  const hasEncryptedDnsServer = refs.surgeEncryptedDnsServer.value.split(",").some((item) => item.trim());
  refs.surgeEncryptedDnsFollowOutboundModeRow.classList.toggle("hidden", !hasEncryptedDnsServer);
  refs.surgeEncryptedDnsFollowOutboundMode.disabled = !hasEncryptedDnsServer;
  if (!hasEncryptedDnsServer) refs.surgeEncryptedDnsFollowOutboundMode.checked = false;
}

function syncClashTunVisibility() {
  const enabled = refs.clashTunEnable.checked;
  document.querySelectorAll("[data-clash-tun-dependent]").forEach((row) => {
    row.classList.toggle("hidden", !enabled);
    row.querySelectorAll("input, select, textarea").forEach((control) => {
      control.disabled = !enabled;
    });
  });
  refreshConfigCodeEditors();
}

function syncClashFakeIpVisibility() {
  const enabled = refs.clashDnsEnhancedMode.value === "fake-ip";
  document.querySelectorAll("[data-clash-fake-ip-dependent]").forEach((row) => {
    row.classList.toggle("hidden", !enabled);
    row.querySelectorAll("input, select, textarea").forEach((control) => {
      control.disabled = !enabled;
    });
  });
  refreshConfigCodeEditors();
}

function syncStashTunVisibility() {
  const enabled = refs.stashTunEnable.checked;
  document.querySelectorAll("[data-stash-tun-dependent]").forEach((row) => {
    row.classList.toggle("hidden", !enabled);
    row.querySelectorAll("input, select, textarea").forEach((control) => {
      control.disabled = !enabled;
    });
  });
  refreshConfigCodeEditors();
}

function syncStashFakeIpVisibility() {
  const enabled = refs.stashDnsEnhancedMode.value === "fake-ip";
  document.querySelectorAll("[data-stash-fake-ip-dependent]").forEach((row) => {
    row.classList.toggle("hidden", !enabled);
    row.querySelectorAll("input, select, textarea").forEach((control) => {
      control.disabled = !enabled;
    });
  });
  refreshConfigCodeEditors();
}

function isTelegramChatBound() {
  return Boolean((state.settings.notificationTelegramChatId || "").trim());
}

function syncTelegramBindActionButton() {
  refs.telegramBindCodeBtn.textContent = isTelegramChatBound()
    ? t("telegramUnbind")
    : t("telegramBindCode");
}

function renderTelegramBindStatus() {
  const isBound = isTelegramChatBound();
  refs.telegramBindStatus.textContent = isBound
    ? t("telegramBindStatusBound")
    : t("telegramBindStatusUnbound");
  syncTelegramBindActionButton();
  if (isBound) {
    stopTelegramBindPolling();
  }
}

function renderTelegramBindCommand(command, expiresAt) {
  refs.telegramBindStatus.innerHTML = [
    `<span>${escapeHtml(t("telegramBindCommandSteps"))}</span>`,
    `<span>${escapeHtml(t("telegramBindCommandHelp"))}</span>`,
    `<code>${escapeHtml(command)}</code>`,
    `<small>${escapeHtml(formatMessage("telegramBindCommandExpires", { time: formatTimestamp(expiresAt) }))}</small>`
  ].join("");
}

function syncTelegramSettingsFromConfig(config) {
  const savedSettings = config?.settings || {};
  const notificationTelegramBotToken = typeof savedSettings.notificationTelegramBotToken === "string"
    ? savedSettings.notificationTelegramBotToken
    : state.settings.notificationTelegramBotToken || "";
  const notificationTelegramWebhookSecret = typeof savedSettings.notificationTelegramWebhookSecret === "string"
    ? savedSettings.notificationTelegramWebhookSecret
    : state.settings.notificationTelegramWebhookSecret || "";
  const notificationTelegramChatId = typeof savedSettings.notificationTelegramChatId === "string"
    ? savedSettings.notificationTelegramChatId
    : "";
  const syncedTelegramSettings = {
    notificationChannel: notificationTelegramBotToken ? "telegram" : "off",
    notificationTelegramBotToken,
    notificationTelegramWebhookSecret,
    notificationTelegramChatId
  };
  state.settings = { ...state.settings, ...syncedTelegramSettings };
  if (lastSavedState) {
    lastSavedState.settings = { ...lastSavedState.settings, ...syncedTelegramSettings };
  }
  return Boolean(syncedTelegramSettings.notificationTelegramChatId.trim());
}

function stopTelegramBindPolling() {
  if (!telegramBindPollTimer) return;
  window.clearTimeout(telegramBindPollTimer);
  telegramBindPollTimer = 0;
}

function startTelegramBindPolling(expiresAt) {
  stopTelegramBindPolling();
  const deadline = Date.parse(expiresAt);
  if (!Number.isFinite(deadline)) return;
  const poll = async () => {
    telegramBindPollTimer = 0;
    if (Date.now() >= deadline) return;
    try {
      const latestConfig = await request("/api/config");
      if (syncTelegramSettingsFromConfig(latestConfig)) {
        renderTelegramBindStatus();
        updateSaveAvailability();
        return;
      }
    } catch {
      // Keep the bind command visible; the bot confirmation is the source of truth.
    }
    if (Date.now() < deadline) {
      telegramBindPollTimer = window.setTimeout(poll, 3000);
    }
  };
  telegramBindPollTimer = window.setTimeout(poll, 3000);
}

async function generateTelegramBindCode() {
  const token = refs.notificationTelegramBotToken.value.trim();
  if (!token) {
    window.alert(t("telegramBindMissingToken"));
    return;
  }
  refs.telegramBindCodeBtn.disabled = true;
  refs.telegramBindCodeBtn.textContent = t("telegramBindCodeLoading");
  try {
    const result = await request("/api/telegram/bind-code", {
      method: "POST",
      body: JSON.stringify({ token })
    });
    const savedSettings = result.config?.settings || {};
    const syncedTelegramSettings = {
      notificationChannel: "telegram",
      notificationTelegramBotToken: savedSettings.notificationTelegramBotToken || token,
      notificationTelegramWebhookSecret: savedSettings.notificationTelegramWebhookSecret || "",
      notificationTelegramChatId: savedSettings.notificationTelegramChatId || state.settings.notificationTelegramChatId || ""
    };
    state.settings = { ...state.settings, ...syncedTelegramSettings };
    if (lastSavedState) {
      lastSavedState.settings = { ...lastSavedState.settings, ...syncedTelegramSettings };
    }
    refs.notificationTelegramBotToken.value = syncedTelegramSettings.notificationTelegramBotToken;
    renderTelegramBindStatus();
    if (syncedTelegramSettings.notificationTelegramChatId.trim()) {
      updateSaveAvailability();
      return;
    }
    renderTelegramBindCommand(String(result.command || ""), result.expiresAt);
    startTelegramBindPolling(result.expiresAt);
    updateSaveAvailability();
  } catch (error) {
    window.alert(`${t("telegramBindFailed")}${error instanceof Error ? error.message : String(error)}`);
  } finally {
    refs.telegramBindCodeBtn.disabled = false;
    syncTelegramBindActionButton();
  }
}

async function unbindTelegramChat() {
  if (!window.confirm(t("telegramUnbindConfirm"))) return;
  stopTelegramBindPolling();
  refs.telegramBindCodeBtn.disabled = true;
  try {
    const savedConfig = await request("/api/telegram/unbind", { method: "POST" });
    syncTelegramSettingsFromConfig(savedConfig);
    renderTelegramBindStatus();
    updateSaveAvailability();
  } catch (error) {
    window.alert(`${t("telegramUnbindFailed")}${error instanceof Error ? error.message : String(error)}`);
  } finally {
    refs.telegramBindCodeBtn.disabled = false;
    syncTelegramBindActionButton();
  }
}

function handleTelegramBindAction() {
  if (isTelegramChatBound()) {
    void unbindTelegramChat();
    return;
  }
  void generateTelegramBindCode();
}

function renderGeoIpMmdbStatus(type = "") {
  const uploaded = Boolean(geoIpMmdbStatus?.uploaded);
  refs.geoIpMmdbMissingNotice.classList.toggle("hidden", uploaded);
  const message = uploaded
    ? formatMessage("geoIpMmdbStatusReady", {
      fileName: geoIpMmdbStatus.fileName || "GeoIP.mmdb",
      size: formatBytes(geoIpMmdbStatus.size || 0),
      time: formatTimestamp(geoIpMmdbStatus.updatedAt)
    })
    : t("geoIpMmdbStatusEmpty");
  const className = type || (uploaded ? "success" : "warning");
  refs.geoIpMmdbStatus.innerHTML = `<div class="${className}">${escapeHtml(message)}</div>`;
}

async function requestGeoIpMmdbUpload(file) {
  const body = new FormData();
  body.append("file", file);
  const response = await fetch("/api/geoip/mmdb", {
    method: "POST",
    body
  });
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.error || `HTTP ${response.status}`);
  }
  return response.json();
}

async function uploadGeoIpMmdb() {
  const file = refs.geoIpMmdbFile.files?.[0];
  if (!file) {
    window.alert(t("geoIpMmdbSelectFile"));
    return;
  }
  refs.uploadGeoIpMmdbBtn.disabled = true;
  refs.uploadGeoIpMmdbBtn.textContent = t("uploadGeoIpMmdbUploading");
  try {
    geoIpMmdbStatus = await requestGeoIpMmdbUpload(file);
    refs.geoIpMmdbFile.value = "";
    renderGeoIpMmdbStatus("success");
  } catch (error) {
    window.alert(`${t("geoIpMmdbUploadFailed")}${error instanceof Error ? error.message : String(error)}`);
  } finally {
    refs.uploadGeoIpMmdbBtn.disabled = false;
    refs.uploadGeoIpMmdbBtn.textContent = t("uploadGeoIpMmdb");
  }
}

function validateSurgeScriptLines(lines) {
  const validation = { errors: [], warnings: [] };
  (lines || []).forEach((line, index) => {
    const trimmed = String(line || "").trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    if (/^\[[^\]]+\]$/.test(trimmed)) {
      validation.errors.push(`第 ${index + 1} 行不能包含配置段标题`);
      return;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0 || !trimmed.slice(separatorIndex + 1).trim()) {
      validation.errors.push(`第 ${index + 1} 行脚本语法应为 名称 = 参数`);
    }
  });
  return validation;
}

function renderSurgeScriptValidation(validation) {
  const messages = [
    ...(validation?.errors || []).map((message) => ({ type: "error", message })),
    ...(validation?.warnings || []).map((message) => ({ type: "warning", message }))
  ];
  refs.surgeScriptValidation.classList.toggle("hidden", messages.length === 0);
  refs.surgeScriptValidation.innerHTML = messages
    .map(({ type, message }) => `<div class="${type}">${escapeHtml(message)}</div>`)
    .join("");
}

function validateCurrentSurgeScripts() {
  const validation = validateSurgeScriptLines(textToLines(refs.surgeScripts.value));
  renderSurgeScriptValidation(validation);
  return validation;
}

function randomBase64Url(bytes = 24) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function generateSurgeMitmCaPassphrase() {
  refs.surgeMitmCaPassphrase.value = randomBase64Url(24);
  updateSaveAvailability();
}

function renderSurgeMitmCaGenerationStatus(type, message) {
  refs.surgeMitmCaGenerationStatus.classList.remove("hidden");
  refs.surgeMitmCaGenerationStatus.innerHTML = `<div class="${type}">${escapeHtml(message)}</div>`;
}

function base64ToBytes(base64) {
  const clean = String(base64 || "").replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function downloadBase64File(base64, fileName, contentType) {
  const blob = new Blob([base64ToBytes(base64)], { type: contentType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function generateSurgeMitmCa() {
  if (!refs.surgeMitmCaPassphrase.value.trim()) {
    generateSurgeMitmCaPassphrase();
  }
  refs.generateSurgeMitmCaBtn.disabled = true;
  renderSurgeMitmCaGenerationStatus("warning", t("surgeMitmCaGenerating"));
  try {
    const { generateMitmCaP12 } = await import("/mitm-ca.js");
    const result = await generateMitmCaP12({
      commonName: "SubPilot MITM CA",
      passphrase: refs.surgeMitmCaPassphrase.value.trim()
    });
    refs.surgeMitmCaP12.value = result.caP12;
    syncConfigCodeEditor(refs.surgeMitmCaP12);
    downloadBase64File(result.caP12, result.fileName || "SubPilot-MITM-CA.p12", "application/x-pkcs12");
    renderSurgeMitmCaGenerationStatus("success", t("surgeMitmCaGenerated"));
    updateSaveAvailability();
  } catch (error) {
    renderSurgeMitmCaGenerationStatus("error", `${t("surgeMitmCaFailed")}${error instanceof Error ? error.message : String(error)}`);
  } finally {
    refs.generateSurgeMitmCaBtn.disabled = false;
  }
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.split(",").pop() || "" : result);
    });
    reader.addEventListener("error", () => reject(reader.error || new Error("File read failed")));
    reader.readAsDataURL(file);
  });
}

async function importSurgeMitmCaP12() {
  const file = refs.surgeMitmCaP12File.files?.[0];
  if (!file) return;
  refs.surgeMitmCaP12.value = await readFileAsBase64(file);
  syncConfigCodeEditor(refs.surgeMitmCaP12);
  refs.surgeMitmCaP12File.value = "";
  updateSaveAvailability();
}

async function save() {
  await saveActivePage();
}

async function saveActivePage(page = activePage) {
  if (!hasUnsavedChanges(page)) {
    setSaveStatus("idle");
    return;
  }
  setSaveStatus("saving");
  try {
    let patch = null;
    if (page === "settings") {
      collectSettings();
      patch = { settings: state.settings, ruleSets: { mode: ensureRuleSets().mode } };
    } else if (page === "sources") {
      patch = { sources: state.sources || [] };
    } else if (page === "proxy-nodes") {
      const validation = validateProxyNodes();
      if (validation.errors.length > 0) {
        setSaveStatus("idle");
        window.alert(`${t("proxyNodeValidationError")}\n${validation.errors.join("\n")}`);
        return;
      }
      patch = { proxyNodes: state.proxyNodes || [] };
    } else if (page === "groups") {
      collectGroups();
      const groupValidation = validateGroups();
      if (groupValidation.errors.length > 0) {
        setSaveStatus("idle");
        window.alert(`${t("groupValidationError")}\n${groupValidation.errors.join("\n")}`);
        return;
      }
      patch = { groups: state.groups, disabledGroups: state.disabledGroups };
    } else if (page === "unified-config") {
      const common = ensureUnifiedCommonDraft();
      const baselineDomains = unifiedCommonState(lastSavedState).realIpDomains;
      if (JSON.stringify(common.realIpDomains) !== JSON.stringify(baselineDomains)) {
        const invalid = invalidUnifiedRealIpDomains(common.realIpDomains.flat());
        if (invalid.length > 0) {
          setSaveStatus("idle");
          window.alert(`${t("unifiedRealIpDomainsInvalid")}\n${invalid.join("\n")}`);
          return;
        }
      }
      patch = buildUnifiedCommonPatch(common, ensureRuleSets());
    } else if (page === "surge") {
      const hostValidation = validateCurrentSurgeHosts();
      if (hostValidation.errors.length > 0) {
        setSaveStatus("idle");
        window.alert(t("surgeHostValidationError"));
        return;
      }
      const urlRewriteValidation = validateCurrentSurgeUrlRewrite();
      if (urlRewriteValidation.errors.length > 0) {
        setSaveStatus("idle");
        window.alert(t("surgeUrlRewriteValidationError"));
        return;
      }
      const scriptValidation = validateCurrentSurgeScripts();
      if (scriptValidation.errors.length > 0) {
        setSaveStatus("idle");
        window.alert(t("surgeScriptValidationError"));
        return;
      }
      if (!isRuleSetModeEnabled()) {
        const ruleValidation = validateCurrentSurgeRules();
        if (ruleValidation.errors.length > 0) {
          setSaveStatus("idle");
          window.alert(t("surgeRuleValidationError"));
          return;
        }
      }
      collectSurge();
      patch = { surge: state.surge };
    } else if (page === "clash") {
      if (!isRuleSetModeEnabled()) {
        const ruleProviderValidation = validateCurrentClashRuleProviders();
        if (ruleProviderValidation.errors.length > 0) {
          setSaveStatus("idle");
          window.alert(t("clashRuleProviderValidationError"));
          return;
        }
        const ruleValidation = validateCurrentClashRules();
        if (ruleValidation.errors.length > 0) {
          setSaveStatus("idle");
          window.alert(t("clashRuleValidationError"));
          return;
        }
      }
      collectClash();
      patch = { clash: state.clash };
    } else if (page === "stash") {
      const hostValidation = validateCurrentStashHosts();
      if (hostValidation.errors.length > 0) {
        setSaveStatus("idle");
        window.alert(t("stashHostValidationError"));
        return;
      }
      const urlRewriteValidation = validateCurrentStashUrlRewrite();
      if (urlRewriteValidation.errors.length > 0) {
        setSaveStatus("idle");
        window.alert(t("stashUrlRewriteValidationError"));
        return;
      }
      const scriptValidation = validateCurrentStashScripts();
      if (scriptValidation.errors.length > 0) {
        setSaveStatus("idle");
        window.alert(t("stashScriptValidationError"));
        return;
      }
      if (!isRuleSetModeEnabled()) {
        const ruleProviderValidation = validateCurrentStashRuleProviders();
        if (ruleProviderValidation.errors.length > 0) {
          setSaveStatus("idle");
          window.alert(t("stashRuleProvidersValidationError"));
          return;
        }
        const ruleValidation = validateCurrentStashRules();
        if (ruleValidation.errors.length > 0) {
          setSaveStatus("idle");
          window.alert(t("stashRuleValidationError"));
          return;
        }
      }
      collectStash();
      patch = { stash: state.stash };
    }
    if (patch) {
      state = await request("/api/config", { method: "PATCH", body: JSON.stringify(patch) });
      lastSavedState = cloneConfig(state);
    }
    if (saveStatusResetTimer) window.clearTimeout(saveStatusResetTimer);
    setSaveStatus("saved");
    saveStatusResetTimer = window.setTimeout(() => { setSaveStatus("idle"); }, 1600);
    render({ preserveUnifiedCommonDraft: page !== "unified-config" });
  } catch (error) {
    if (saveStatusResetTimer) window.clearTimeout(saveStatusResetTimer);
    setSaveStatus("idle");
    window.alert(`${t("saveFailed")}${error instanceof Error ? error.message : String(error)}`);
  }
}

async function rotateToken() {
  const result = await request("/api/read-token/rotate", { method: "POST", body: "{}" });
  currentReadToken = result.token;
  renderLinks();
}

function renderLinks() {
  const token = currentReadToken || "<rotate-read-token>";
  const base = new URL(state?.settings?.managedBaseUrl || `${location.origin}/sync`, location.origin);
  const url = subscriptionUrl(base, token);
  refs.links.innerHTML = [
    renderLinkRow(t("automaticLink"), url)
  ].join("");
  renderSummary();
}

function renderLinkRow(label, url) {
  return `<div class="link-row"><strong>${escapeHtml(label)}</strong><div class="link-copy-field"><code>${escapeHtml(url)}</code><button class="btn copy-link-btn" type="button" data-copy-link="${escapeHtml(url)}">${t("copyLink")}</button></div></div>`;
}

function subscriptionUrl(base, token, fileName = "") {
  const normalizedBase = new URL(base.toString());
  normalizedBase.search = "";
  normalizedBase.hash = "";
  const baseHref = normalizedBase.toString().replace(/\/+$/, "");
  const encodedToken = encodeURIComponent(token);
  const filePath = fileName ? encodeURIComponent(fileName) : "";
  return filePath ? `${baseHref}/${encodedToken}/${filePath}` : `${baseHref}/${encodedToken}/`;
}

async function copyLink(event) {
  const button = event.target instanceof Element ? event.target.closest("[data-copy-link]") : null;
  if (!button) return;
  const value = button.dataset.copyLink || "";
  try {
    await navigator.clipboard.writeText(value);
    button.textContent = t("copied");
    window.setTimeout(() => {
      button.textContent = t("copyLink");
    }, 1400);
  } catch {
    button.textContent = t("copyFailed");
    window.setTimeout(() => {
      button.textContent = t("copyLink");
    }, 1800);
  }
}

function renderSummary() {
  if (!state) return;
  const enabledSources = state.sources.filter((source) => source.enabled).length;
  refs.summarySources.textContent = `${enabledSources} / ${state.sources.length}`;
  refs.summaryGroups.textContent = `${Object.keys(state.groups || {}).length - (state.disabledGroups || []).length} / ${Object.keys(state.groups || {}).length}`;
  refs.summarySourceCache.innerHTML = formatSourceCacheStatus(fetchStats?.sourceCache);
  refs.refreshSourceCacheBtn.disabled = false;
  refs.summaryRuleSetCache.innerHTML = formatRuleSetCacheStatus(ruleSetStatus);
  refs.refreshRuleSetCacheBtn.disabled = ruleSetStatus?.mode !== "compiled";
}

function renderSystemStatus() {
  const app = systemStatus?.app || {};
  const update = systemStatus?.update || {};
  refs.systemCurrentVersion.textContent = app.version || "-";
  refs.systemUpdateStatus.innerHTML = formatUpdateStatus(update);
  refs.checkUpdateBtn.disabled = false;
}

function formatUpdateStatus(update) {
  if (!update || typeof update !== "object" || !update.checkedAt) {
    return `<div class="update-status-message neutral">${escapeHtml(t(state?.settings?.updateCheckEnabled ? "updateCheckNever" : "updateCheckDisabled"))}</div>`;
  }
  if (update.error) {
    return [
      `<div class="update-status-message warning">${escapeHtml(t("updateCheckFailed").replace("{error}", update.error))}</div>`,
      `<div class="update-status-time">${escapeHtml(formatTimestamp(update.checkedAt))}</div>`
    ].join("");
  }
  const latest = update.latestVersion || "-";
  const label = update.updateAvailable
    ? t("updateAvailable").replace("{version}", latest)
    : t("updateCurrent");
  const link = update.releaseUrl
    ? `<a class="update-status-link" href="${escapeHtml(update.releaseUrl)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`
    : escapeHtml(label);
  return [
    `<div class="update-status-message ${update.updateAvailable ? "warning" : "ready"}">${link}</div>`,
    `<div class="update-status-time">${escapeHtml(formatTimestamp(update.checkedAt))}</div>`
  ].join("");
}

function formatSourceCacheStatus(sourceCache) {
  if (!sourceCache || typeof sourceCache !== "object") return `<div>${escapeHtml(t("sourceCacheUnknown"))}</div>`;
  const count = Number(sourceCache.count) || 0;
  const expected = Math.max(0, Number(sourceCache.expectedCount) || 0);
  const cached = Math.max(0, Number(sourceCache.cachedSourceCount) || 0);
  if (expected <= 0) {
    return [
      `<div>${escapeHtml(count > 0 ? t("sourceCacheEntryCount").replace("{count}", String(count)) : t("sourceCacheEmpty"))}</div>`,
      `<div class="status-cache-muted">${escapeHtml(t("sourceCacheUpdatedLabel").replace("{time}", formatTimestamp(sourceCache.updatedAt)))}</div>`
    ].join("");
  }
  const missing = Math.max(0, expected - cached);
  const coverageState = missing > 0
    ? t("sourceCacheCoverageMissing").replace("{count}", String(missing))
    : t("sourceCacheCoverageReady");
  const sourceRows = Array.isArray(sourceCache.sources)
    ? sourceCache.sources.map(formatSourceCacheSourceRow).join("")
    : "";
  return [
    `<div><strong>${escapeHtml(t("sourceCacheCoverage").replace("{cached}", String(cached)).replace("{expected}", String(expected)))}</strong><span class="status-cache-pill ${missing > 0 ? "warning" : "ready"}">${escapeHtml(coverageState)}</span></div>`,
    `<div class="status-cache-muted">${escapeHtml(t("sourceCacheEntryCount").replace("{count}", String(count)))}</div>`,
    `<div class="status-cache-muted">${escapeHtml(t("sourceCacheUpdatedLabel").replace("{time}", formatTimestamp(sourceCache.updatedAt)))}</div>`,
    `<div>${escapeHtml(t("sourceCacheProtocols").replace("{value}", formatSourceCacheProtocols(sourceCache)))}</div>`,
    sourceRows ? `<div class="status-cache-sources">${sourceRows}</div>` : ""
  ].join("");
}

function formatSourceCacheProtocols(sourceCache) {
  return formatSourceCacheProtocolCounts(Number(sourceCache.totalNodes) || 0, sourceCache.protocolCounts, true);
}

function formatSourceCacheProtocolCounts(totalNodes, protocolCounts, includeTotal) {
  const counts = Array.isArray(protocolCounts) ? protocolCounts : [];
  if (totalNodes <= 0 || counts.length === 0) return t("sourceCacheNoNodes");
  const parts = counts
    .map((item) => `${item.protocol || "unknown"} ${Number(item.count) || 0}`)
    .filter((item) => !item.endsWith(" 0"));
  if (includeTotal) parts.push(`总计 ${totalNodes}`);
  return parts.length > 0 ? parts.join("，") : t("sourceCacheNoNodes");
}

function formatSourceCacheSourceRow(source) {
  const name = source?.sourceName || source?.sourceId || "-";
  let text = source?.cached
    ? t("sourceCacheSourceCached")
      .replace("{name}", name)
      .replace("{count}", String(Number(source.nodeCount) || 0))
    : t("sourceCacheSourceMissing").replace("{name}", name);
  if (source?.cached) {
    text += t("sourceCacheSourceProtocols")
      .replace("{value}", formatSourceCacheProtocolCounts(Number(source.nodeCount) || 0, source.protocolCounts, false));
  }
  return `<div class="status-cache-source ${source?.cached ? "ready" : "warning"}">${escapeHtml(text)}</div>`;
}

function formatRuleSetCacheStatus(status) {
  if (status?.mode !== "compiled") return `<div>${escapeHtml(t("ruleSetCacheDisabled"))}</div>`;
  const outputs = Array.isArray(status.outputs) ? status.outputs : [];
  if (outputs.length === 0) return `<div>${escapeHtml(t("ruleSetCacheEmpty"))}</div>`;
  const cached = outputs.filter((output) => output?.cached).length;
  const missing = outputs.length - cached;
  const totalRules = outputs.reduce((sum, output) => sum + (Number(output?.ruleCount) || 0), 0);
  const latestUpdatedAt = outputs
    .map((output) => output?.updatedAt)
    .filter(Boolean)
    .sort()
    .at(-1);
  const coverageState = missing > 0
    ? t("ruleSetCacheCoverageMissing").replace("{count}", String(missing))
    : t("ruleSetCacheCoverageReady");
  return [
    `<div><strong>${escapeHtml(t("ruleSetCacheCoverage").replace("{cached}", String(cached)).replace("{expected}", String(outputs.length)))}</strong><span class="status-cache-pill ${missing > 0 ? "warning" : "ready"}">${escapeHtml(coverageState)}</span></div>`,
    `<div class="status-cache-muted">${escapeHtml(t("ruleSetCacheRuleCount").replace("{count}", String(totalRules)))}</div>`,
    `<div class="status-cache-muted">${escapeHtml(t("ruleSetCacheUpdatedLabel").replace("{time}", formatTimestamp(latestUpdatedAt)))}</div>`,
    `<div class="status-cache-sources">${outputs.map(formatRuleSetCacheOutputRow).join("")}</div>`
  ].join("");
}

function formatRuleSetCacheOutputRow(output) {
  const name = output?.outputName || "-";
  if (!output?.cached) {
    return `<div class="status-cache-source warning">${escapeHtml(t("ruleSetCacheOutputMissing").replace("{name}", name))}</div>`;
  }
  const buckets = Array.isArray(output.buckets)
    ? output.buckets.map((bucket) => `${bucket.bucket || "-"} ${Number(bucket.count) || 0}`).join("，")
    : "";
  let text = t("ruleSetCacheOutputCached")
    .replace("{name}", name)
    .replace("{count}", String(Number(output.ruleCount) || 0));
  text += t("ruleSetCacheOutputBuckets").replace("{value}", buckets || t("ruleSetCacheNoBuckets"));
  const warningCount = Array.isArray(output.warnings) ? output.warnings.length : 0;
  if (warningCount > 0) text += t("ruleSetCacheOutputWarnings").replace("{count}", String(warningCount));
  return `<div class="status-cache-source ready">${escapeHtml(text)}</div>`;
}

async function requestRuleSetRefresh() {
  const result = await request("/api/rule-sets/refresh", { method: "POST", body: "{}" });
  ruleSetStatus = { mode: ensureRuleSets().mode, outputs: result.outputs || [] };
  renderRuleSetStatus();
  renderSummary();
  return result;
}

async function refreshRuleSetCache() {
  refs.refreshRuleSetCacheBtn.disabled = true;
  refs.refreshRuleSetCacheBtn.textContent = t("refreshingRuleSetCache");
  try {
    await requestRuleSetRefresh();
  } finally {
    refs.refreshRuleSetCacheBtn.textContent = t("refreshRuleSetCache");
    refs.refreshRuleSetCacheBtn.disabled = ruleSetStatus?.mode !== "compiled";
  }
}

async function refreshSourceCache() {
  refs.refreshSourceCacheBtn.disabled = true;
  refs.refreshSourceCacheBtn.textContent = t("refreshingSourceCache");
  try {
    const result = await request("/api/cache/source/refresh", { method: "POST", body: "{}" });
    const refreshVersion = ++statusStatsRefreshVersion;
    const stats = await request("/api/stats");
    if (refreshVersion === statusStatsRefreshVersion) {
      fetchStats = stats;
      renderPage("status", { force: true });
    }
    showSourceRefreshWarnings(result);
  } finally {
    refs.refreshSourceCacheBtn.textContent = t("refreshSourceCache");
    refs.refreshSourceCacheBtn.disabled = false;
  }
}

async function checkForUpdates() {
  refs.checkUpdateBtn.disabled = true;
  refs.checkUpdateBtn.textContent = t("checkingUpdate");
  try {
    const result = await request("/api/update-check", { method: "POST", body: "{}" });
    systemStatus = {
      ...(systemStatus || {}),
      update: result.update
    };
    renderSystemStatus();
  } finally {
    refs.checkUpdateBtn.textContent = t("checkUpdate");
    refs.checkUpdateBtn.disabled = false;
  }
}

function refreshStatusStatsIfVisible() {
  if (!state || activePage !== "status") return;
  if (statusStatsRefreshPromise) return;
  const refreshVersion = ++statusStatsRefreshVersion;
  statusStatsRefreshPromise = request("/api/stats")
    .then((stats) => {
      if (refreshVersion !== statusStatsRefreshVersion) return;
      fetchStats = stats;
      if (activePage === "status") {
        renderPage("status", { force: true });
      }
    })
    .catch((error) => {
      console.warn("Status stats refresh failed", error);
    })
    .finally(() => {
      statusStatsRefreshPromise = null;
    });
}

function showSourceRefreshWarnings(result) {
  const failed = Number(result?.failed) || 0;
  if (failed <= 0) return;
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const notificationWarnings = Array.isArray(result.notification?.warnings) ? result.notification.warnings : [];
  let message = t("sourceCacheRefreshFailed")
    .replace("{count}", String(failed))
    .replace("{warnings}", warnings.join("\n") || "- Unknown error");
  if (notificationWarnings.length > 0) {
    message += t("sourceCacheNotificationWarnings").replace("{warnings}", notificationWarnings.join("\n"));
  }
  window.alert(message);
}

function renderFetchStats() {
  const lastFetched = fetchStats?.lastFetched || {};
  const targets = ["surge", "clash", "stash", "shadowrocket"];
  const records = Array.isArray(fetchStats?.recentUserAgents) ? fetchStats.recentUserAgents : [];
  const rows = records.map((record) => ({
    ...record,
    fetchedAt: record.fetchedAt || lastFetched[record.target]
  }));
  for (const target of targets) {
    if (rows.some((record) => record.target === target)) continue;
    rows.push({
      target,
      fetchedAt: lastFetched[target],
      userAgent: "",
      ipAddress: "",
      location: null
    });
  }
  const totalRows = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / FETCH_RECORDS_PAGE_SIZE));
  fetchRecordsPage = Math.min(Math.max(1, fetchRecordsPage), totalPages);
  const startIndex = totalRows > 0 ? (fetchRecordsPage - 1) * FETCH_RECORDS_PAGE_SIZE : 0;
  const pageRows = rows.slice(startIndex, startIndex + FETCH_RECORDS_PAGE_SIZE);
  const endIndex = startIndex + pageRows.length;
  refs.fetchRecordsTableBody.innerHTML = rows.length > 0
    ? pageRows.map(renderFetchRecordRow).join("")
    : `<tr><td class="status-empty-cell" colspan="4">${escapeHtml(t("noRecentUa"))}</td></tr>`;
  renderFetchRecordsPagination(totalRows, startIndex, endIndex, totalPages);
}

function renderFetchRecordRow(record) {
  const hasClient = Boolean(record.userAgent || record.ipAddress || record.location);
  const ipAddress = record.ipAddress || (hasClient ? t("unknownIp") : "");
  const location = hasClient ? formatLocation(record.location) : "";
  const network = [ipAddress, location].filter(Boolean).join(" · ");
  return `
    <tr>
      <td data-label="${escapeHtml(t("fetchColumnTarget"))}">${escapeHtml(formatFetchTargetLabel(record.target))}</td>
      <td data-label="${escapeHtml(t("fetchColumnTime"))}"><time>${escapeHtml(formatTimestamp(record.fetchedAt))}</time></td>
      <td class="status-fetch-ua" data-label="${escapeHtml(t("fetchColumnUa"))}">${escapeHtml(record.userAgent || t("emptyCell"))}</td>
      <td class="status-fetch-network" data-label="${escapeHtml(t("fetchColumnNetwork"))}">${escapeHtml(network || t("emptyCell"))}</td>
    </tr>
  `;
}

function renderFetchRecordsPagination(totalRows, startIndex, endIndex, totalPages) {
  if (!refs.fetchRecordsPagination) return;
  const showPagination = totalRows > FETCH_RECORDS_PAGE_SIZE;
  refs.fetchRecordsPagination.classList.toggle("hidden", !showPagination);
  refs.fetchRecordsPageInfo.textContent = formatMessage("fetchRecordsPageInfo", {
    start: totalRows > 0 ? startIndex + 1 : 0,
    end: endIndex,
    total: totalRows
  });
  refs.fetchRecordsPrevBtn.disabled = fetchRecordsPage <= 1;
  refs.fetchRecordsNextBtn.disabled = fetchRecordsPage >= totalPages;
}

function setFetchRecordsPage(page) {
  fetchRecordsPage = Math.max(1, Number(page) || 1);
  renderFetchStats();
}

function formatFetchTargetLabel(target) {
  const key = {
    surge: "fetchTargetSurge",
    clash: "fetchTargetClash",
    stash: "fetchTargetStash",
    shadowrocket: "fetchTargetShadowrocket"
  }[target];
  return key ? t(key) : String(target || "-");
}

function formatLocation(location) {
  if (!location || typeof location !== "object") return t("unknownLocation");
  const label = String(location.label || "").trim();
  if (label) return label;
  const parts = [location.city, location.region, location.countryCode]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const text = parts.join(", ");
  return text || t("unknownLocation");
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function formatTimestamp(value) {
  if (!value) return t("neverFetched");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t("neverFetched");
  return formatDateInTimeZone(date, currentDisplayTimeZone());
}

function currentDisplayTimeZone() {
  return normalizeDisplayTimeZone(state?.settings?.displayTimeZone);
}

function setDisplayTimeZoneValue(value) {
  const timeZone = normalizeDisplayTimeZone(value);
  if (![...refs.displayTimeZone.options].some((option) => option.value === timeZone)) {
    const option = document.createElement("option");
    option.value = timeZone;
    option.textContent = timeZone;
    refs.displayTimeZone.append(option);
  }
  refs.displayTimeZone.value = timeZone;
}

function normalizeDisplayTimeZone(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  const timeZone = raw.toLowerCase() === "aisa/shanghai" ? DEFAULT_DISPLAY_TIME_ZONE : raw;
  if (!timeZone) return DEFAULT_DISPLAY_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return timeZone;
  } catch {
    return DEFAULT_DISPLAY_TIME_ZONE;
  }
}

function formatDateInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

async function preview(target, options = {}) {
  previewLoadingTarget = target;
  updatePreviewControls();
  setPreviewOutput(formatMessage("previewLoading", { target: PREVIEW_TARGET_LABELS[target] || target }), true);
  refs.surgeOnlineValidation.classList.add("hidden");
  refs.surgeOnlineValidation.innerHTML = "";
  try {
    const result = await request(`/api/preview?target=${target}`, { method: "POST", body: "{}" });
    currentPreviewTarget = target;
    currentPreviewContent = result.content || "";
    setPreviewOutput(currentPreviewContent, !currentPreviewContent);
    renderPreviewWarnings(Array.isArray(result.warnings) ? result.warnings : []);
    return currentPreviewContent;
  } catch (error) {
    currentPreviewTarget = "";
    currentPreviewContent = "";
    setPreviewOutput(`${t("previewFailed")}${error instanceof Error ? error.message : String(error)}`, true);
    if (options.propagateError) throw error;
    return "";
  } finally {
    previewLoadingTarget = "";
    updatePreviewControls();
  }
}

function renderPreviewWarnings(warnings) {
  if (!warnings.length) {
    refs.surgeOnlineValidation.classList.add("hidden");
    refs.surgeOnlineValidation.innerHTML = "";
    return;
  }
  const groups = groupPreviewWarnings(warnings);
  refs.surgeOnlineValidation.classList.remove("hidden");
  refs.surgeOnlineValidation.innerHTML = [
    `<div class="warning">${escapeHtml(t("previewWarnings"))}</div>`,
    ...groups.map((group) => renderPreviewWarningGroup(group))
  ].join("");
}

function renderPreviewWarningGroup(group) {
  if (!group.details.length) return `<div class="warning">${escapeHtml(simplifyPreviewRuleSetNames(group.summary))}</div>`;
  return [
    `<details class="diagnostic-group warning">`,
    `<summary><span class="diagnostic-summary">${escapeHtml(simplifyPreviewRuleSetNames(group.summary))}</span><span class="diagnostic-toggle">查看详情</span></summary>`,
    `<ul class="diagnostic-detail-list">`,
    ...group.details.map((message) => `<li>${escapeHtml(simplifyPreviewRuleSetNames(message))}</li>`),
    `</ul>`,
    `</details>`
  ].join("");
}

function updatePreviewControls() {
  const loading = Boolean(previewLoadingTarget);
  for (const target of PREVIEW_TARGETS) {
    const button = {
      surge: refs.previewSurgeBtn,
      clash: refs.previewClashBtn,
      stash: refs.previewStashBtn
    }[target];
    if (!button) continue;
    button.disabled = loading;
    button.textContent = PREVIEW_TARGET_LABELS[target];
  }
  refs.validateSurgeOnlineBtn.disabled = loading || surgeValidationRunning;
}

function renderSurgeOnlineValidation(type, message) {
  refs.surgeOnlineValidation.classList.remove("hidden");
  refs.surgeOnlineValidation.innerHTML = `<div class="${type}">${escapeHtml(message)}</div>`;
}

async function validateSurgeOnline() {
  if (!window.confirm(t("validateSurgeOnlineRisk"))) return;
  surgeValidationRunning = true;
  updatePreviewControls();
  renderSurgeOnlineValidation("warning", t("validateSurgeOnlineRunning"));
  try {
    if (currentPreviewTarget !== "surge" || !currentPreviewContent) {
      await preview("surge", { propagateError: true });
      renderSurgeOnlineValidation("warning", t("validateSurgeOnlineRunning"));
    }
    const result = await request("/api/surge/validate-online", {
      method: "POST",
      body: JSON.stringify({ content: currentPreviewContent, acknowledgeRisk: true })
    });
    if (result.valid) {
      renderSurgeOnlineValidation("success", t("validateSurgeOnlinePassed"));
    } else {
      renderSurgeOnlineValidation("error", `${t("validateSurgeOnlineFailed")}${result.error || "Unknown error"}`);
    }
  } catch (error) {
    renderSurgeOnlineValidation("error", `${t("validateSurgeOnlineFailed")}${error instanceof Error ? error.message : String(error)}`);
  } finally {
    surgeValidationRunning = false;
    updatePreviewControls();
  }
}

function linesToText(lines) {
  return (lines || []).join("\n");
}

function textToLines(value) {
  return String(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function inputWithTitle(attrs, value) {
  const escaped = escapeHtml(value || "");
  return `<input ${attrs} title="${escaped}" value="${escaped}">`;
}

function syncInputTitle(event) {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.type !== "checkbox") {
    target.title = target.value;
  }
}

refs.loginBtn.addEventListener("click", login);
refs.saveBtn.addEventListener("click", save);
refs.addGroupBtn.addEventListener("click", addGroup);
refs.addSourceBtn.addEventListener("click", addSource);
refs.addProxyNodeBtn.addEventListener("click", addProxyNode);
refs.ruleSetModeManual.addEventListener("change", () => {
  if (refs.ruleSetModeManual.checked) updateRuleSetMode("manual");
});
refs.ruleSetModeCompiled.addEventListener("change", () => {
  if (refs.ruleSetModeCompiled.checked) updateRuleSetMode("compiled");
});
refs.ruleSetAggregateByPolicy.addEventListener("change", () => {
  ensureRuleSets().aggregateByPolicy = refs.ruleSetAggregateByPolicy.checked;
  updateSaveAvailability();
});
refs.unifiedIpv6.addEventListener("change", () => setUnifiedCommonBoolean("ipv6", refs.unifiedIpv6.checked));
refs.unifiedLanAccess.addEventListener("change", () => setUnifiedCommonBoolean("lanAccess", refs.unifiedLanAccess.checked));
refs.unifiedBasicDnsServers.addEventListener("input", () => setUnifiedDnsServers("basicDnsServers", refs.unifiedBasicDnsServers.value));
refs.unifiedEncryptedDnsServers.addEventListener("input", () => setUnifiedDnsServers("encryptedDnsServers", refs.unifiedEncryptedDnsServers.value));
refs.unifiedRealIpDomains.addEventListener("input", () => setUnifiedRealIpDomains(refs.unifiedRealIpDomains.value));
refs.addRuleSetOutputBtn.addEventListener("click", addRuleSetOutput);
refs.addRuleSetDirectRuleBtn.addEventListener("click", addRuleSetDirectRule);
refs.refreshRuleSetsBtn.addEventListener("click", refreshRuleSets);
refs.ruleSetRulesBody.addEventListener("click", handleRuleSetRuleClick);
refs.ruleSetRulesBody.addEventListener("input", handleRuleSetRuleEdit);
refs.ruleSetRulesBody.addEventListener("change", handleRuleSetRuleEdit);
refs.rotateTokenBtn.addEventListener("click", rotateToken);
refs.refreshSourceCacheBtn.addEventListener("click", refreshSourceCache);
refs.refreshRuleSetCacheBtn.addEventListener("click", refreshRuleSetCache);
refs.checkUpdateBtn.addEventListener("click", checkForUpdates);
refs.fetchRecordsPrevBtn.addEventListener("click", () => setFetchRecordsPage(fetchRecordsPage - 1));
refs.fetchRecordsNextBtn.addEventListener("click", () => setFetchRecordsPage(fetchRecordsPage + 1));
refs.links.addEventListener("click", copyLink);
refs.previewSurgeBtn.addEventListener("click", () => preview("surge"));
refs.previewClashBtn.addEventListener("click", () => preview("clash"));
refs.previewStashBtn.addEventListener("click", () => preview("stash"));
refs.validateSurgeOnlineBtn.addEventListener("click", validateSurgeOnline);
refs.uploadGeoIpMmdbBtn.addEventListener("click", uploadGeoIpMmdb);
refs.notificationTelegramBotToken.addEventListener("input", () => {
  stopTelegramBindPolling();
  renderTelegramBindStatus();
  updateSaveAvailability();
});
refs.updateCheckEnabled.addEventListener("change", updateSaveAvailability);
refs.telegramBindCodeBtn.addEventListener("click", handleTelegramBindAction);
refs.surgeIpv6.addEventListener("change", syncSurgeIpv6VifVisibility);
refs.surgeEncryptedDnsServer.addEventListener("input", syncSurgeEncryptedDnsFollowOutboundModeVisibility);
refs.clashTunEnable.addEventListener("change", syncClashTunVisibility);
refs.clashDnsEnhancedMode.addEventListener("change", syncClashFakeIpVisibility);
refs.stashTunEnable.addEventListener("change", syncStashTunVisibility);
refs.stashDnsEnhancedMode.addEventListener("change", syncStashFakeIpVisibility);
refs.surgeHostAdvancedMode.addEventListener("click", toggleSurgeHostAdvancedMode);
refs.addSurgeHostBtn.addEventListener("click", addSurgeHost);
refs.surgeHostRows.addEventListener("click", handleSurgeHostListClick);
refs.surgeHostRows.addEventListener("input", updateSurgeHostOutput);
refs.surgeHosts.addEventListener("input", validateCurrentSurgeHosts);
refs.surgeUrlRewriteAdvancedMode.addEventListener("click", toggleSurgeUrlRewriteAdvancedMode);
refs.addSurgeUrlRewriteBtn.addEventListener("click", addSurgeUrlRewrite);
refs.surgeUrlRewriteRows.addEventListener("click", handleSurgeUrlRewriteListClick);
refs.surgeUrlRewriteRows.addEventListener("input", updateSurgeUrlRewriteOutput);
refs.surgeUrlRewriteRows.addEventListener("change", handleSurgeUrlRewriteListChange);
refs.surgeUrlRewrite.addEventListener("input", validateCurrentSurgeUrlRewrite);
refs.surgeRuleAdvancedMode.addEventListener("click", toggleSurgeRuleAdvancedMode);
refs.addSurgeRuleBtn.addEventListener("click", () => addSurgeRule("single"));
refs.addSurgeRuleSetBtn.addEventListener("click", () => addSurgeRule("rule-set"));
refs.surgeRuleRows.addEventListener("click", handleSurgeRuleListClick);
refs.surgeRuleRows.addEventListener("input", updateSurgeRuleOutput);
refs.surgeRuleRows.addEventListener("change", handleSurgeRuleListChange);
refs.surgeScripts.addEventListener("input", validateCurrentSurgeScripts);
refs.clashRuleProviderAdvancedMode.addEventListener("click", toggleClashRuleProviderAdvancedMode);
refs.addClashRuleProviderBtn.addEventListener("click", addClashRuleProvider);
refs.clashRuleProviderRows.addEventListener("click", handleClashRuleProviderListClick);
refs.clashRuleProviderRows.addEventListener("input", updateClashRuleProviderOutput);
refs.clashRuleProviderRows.addEventListener("change", handleClashRuleProviderListChange);
refs.clashRuleProviders.addEventListener("input", handleClashRuleProvidersInput);
refs.clashRuleAdvancedMode.addEventListener("click", toggleClashRuleAdvancedMode);
refs.addClashRuleBtn.addEventListener("click", () => addClashRule("single"));
refs.addClashRuleSetBtn.addEventListener("click", () => addClashRule("rule-set"));
refs.clashRuleRows.addEventListener("click", handleClashRuleListClick);
refs.clashRuleRows.addEventListener("input", updateClashRuleOutput);
refs.clashRuleRows.addEventListener("change", handleClashRuleListChange);
refs.clashRules.addEventListener("input", validateCurrentClashRules);
refs.generateSurgeMitmCaBtn.addEventListener("click", generateSurgeMitmCa);
refs.generateSurgeMitmCaPassphraseBtn.addEventListener("click", generateSurgeMitmCaPassphrase);
refs.surgeMitmCaP12File.addEventListener("change", importSurgeMitmCaP12);
refs.surgeRules.addEventListener("input", validateCurrentSurgeRules);
refs.surgePonteDeviceNames.addEventListener("input", syncSurgePonteDeviceNames);
refs.stashHosts.addEventListener("input", validateCurrentStashHosts);
refs.stashUrlRewrite.addEventListener("input", validateCurrentStashUrlRewrite);
refs.stashScripts.addEventListener("input", validateCurrentStashScripts);
refs.stashRuleProviders.addEventListener("input", () => {
  validateCurrentStashRuleProviders();
  validateCurrentStashRules();
});
refs.stashRules.addEventListener("input", validateCurrentStashRules);
document.addEventListener("input", () => queueMicrotask(updateSaveAvailability));
document.addEventListener("change", () => queueMicrotask(updateSaveAvailability));
document.addEventListener("click", () => queueMicrotask(updateSaveAvailability));
document.addEventListener("input", syncInputTitle);
document.querySelectorAll("[data-surge-tab]").forEach((button) => {
  button.addEventListener("click", () => showSurgeTab(button.dataset.surgeTab));
});
document.querySelectorAll("[data-clash-tab]").forEach((button) => {
  button.addEventListener("click", () => showClashTab(button.dataset.clashTab));
});
document.querySelectorAll("[data-stash-tab]").forEach((button) => {
  button.addEventListener("click", () => showStashTab(button.dataset.stashTab));
});
document.querySelectorAll("[data-unified-config-tab]").forEach((button) => {
  button.addEventListener("click", () => showUnifiedConfigTab(button.dataset.unifiedConfigTab));
  button.addEventListener("keydown", handleUnifiedConfigTabKeydown);
});
document.querySelectorAll(".luci-menu a").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    showPage(link.dataset.page, true);
  });
});
window.addEventListener("hashchange", () => {
  showPage(getPageFromHash());
});

applyLanguage();
showPage(activePage);
boot();
