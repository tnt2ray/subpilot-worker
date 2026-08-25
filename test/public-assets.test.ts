import { createContext, Script } from "node:vm";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractFunctionSource, readAdminAppBundle, readPublicFile } from "./helpers/public-assets";

describe("admin static assets", () => {
  it("keeps the admin static asset contract", () => {
    const html = readPublicFile("index.html");
    const app = readAdminAppBundle();
    const css = readPublicFile("styles.css");
    const codeMirror = readPublicFile("vendor/codemirror/codemirror.js");

    expect(html).not.toContain("/vendor/codemirror/codemirror.css");
    expect(html).not.toContain("/vendor/codemirror/codemirror.js");
    expect(app).toContain('loadStylesheet("/vendor/codemirror/codemirror.css")');
    expect(app).toContain('loadScript("/vendor/codemirror/codemirror.js")');
    expect(app).toContain("window.SubPilotCodeMirror");
    expect(codeMirror).toContain("SubPilotCodeMirror");
    expect(html).toContain('id="userAgentStash"');
    expect(html).toContain('id="userAgentShadowrocket"');
    expect(app).toContain('fetchUserAgentStash: "Stash User-Agent"');
    expect(app).toContain('fetchUserAgentShadowrocket: "Shadowrocket User-Agent"');
    expect(app).toContain('<option value="stash">');
    expect(app).toContain('<option value="shadowrocket">');
    expect(app).toContain('data-group-part="surgeHidden"');
    expect(app).toContain('groupSurgeHidden: "在 Surge 中隐藏"');
    expect(app).toContain('if (editor.surgeHidden) parts.push("hidden=true")');
    expect(app).toContain('surgeHidden: row.querySelector(\'[data-group-part="surgeHidden"]\').checked');

    const generalStart = html.indexOf('data-surge-panel="general"');
    const hostStart = html.indexOf('data-surge-panel="host"');
    const generalPanel = html.slice(generalStart, hostStart);

    expect(generalStart).toBeGreaterThan(-1);
    expect(hostStart).toBeGreaterThan(generalStart);
    expect(generalPanel).toContain('id="surgeManagedConfigIntervalSeconds"');
    expect(generalPanel).toContain('min="300" max="604800" step="60"');
    expect(generalPanel).toContain("主配置更新间隔");
    expect(app).toContain('managedConfigIntervalHelp: "写入 #!MANAGED-CONFIG 的 interval，单位秒；默认 43200（12 小时）。"');

    expect(html).toContain('id="fetchRecordsTableBody"');
    expect(html).toContain('id="fetchRecordsPagination"');
    expect(html).not.toContain('data-i18n="fetchColumnCount"');
    expect(html).toContain("配置获取记录");
    expect(app).toContain('fetchTargetSurge: "Surge 配置"');
    expect(app).toContain('fetchTargetStash: "Stash 配置"');
    expect(app).toContain('fetchTargetShadowrocket: "Shadowrocket Clash YAML"');

    expect(html).toContain('data-page="stash"');
    expect(html).toContain('data-page="surge"');
    expect(html).toContain('data-page="clash"');
    expect(html).toContain('id="previewStashBtn"');
    expect(html).not.toContain('id="validateSurgeOnlineBtn"');
    expect(app).not.toContain("/api/surge/validate-online");
    expect(html).toContain('data-surge-tab="mapLocal"');
    expect(html).toContain('id="surgeMapLocalRows"');
    expect(app).toContain("validateSurgeMapLocalLines");
    expect(app).toContain('"mapLocal", "script", "mitm", "tailscale"');
    expect(html).toContain('id="stashMitmHostname"');
    const settingsPageStart = html.indexOf('id="page-settings"');
    const unifiedConfigPageStart = html.indexOf('id="page-unified-config"');
    const ruleSetModeStart = html.indexOf('id="ruleSetModeCompiled"');
    expect(settingsPageStart).toBeGreaterThan(-1);
    expect(unifiedConfigPageStart).toBeGreaterThan(settingsPageStart);
    expect(ruleSetModeStart).toBeGreaterThan(settingsPageStart);
    expect(ruleSetModeStart).toBeLessThan(unifiedConfigPageStart);
    expect(html.slice(unifiedConfigPageStart)).not.toContain('id="ruleSetModeCompiled"');
    expect(html).toContain('href="#unified-config" data-page="unified-config"');
    expect(html).not.toContain('data-page="rule-sets"');
    expect(html).not.toContain('id="page-rule-sets"');
    expect(html).toContain('href="#sources" data-page="sources"');
    expect(html).toContain('href="#proxy-nodes" data-page="proxy-nodes"');
    expect(html).toContain('href="#groups" data-page="groups"');
    expect(html.match(/data-unified-config-tab=/g)).toHaveLength(3);
    expect(html.match(/data-unified-config-panel=/g)).toHaveLength(3);
    expect(html).toContain('data-unified-config-tab="general"');
    expect(html).toContain('data-unified-config-tab="dns"');
    expect(html).toContain('data-unified-config-tab="rules"');
    expect(html).not.toContain('data-unified-config-slot=');
    expect(html).toContain('id="unifiedIpv6"');
    expect(html).toContain('id="unifiedLanAccess"');
    expect(html).toContain('id="unifiedIpv6Mixed"');
    expect(html).toContain('id="unifiedLanAccessMixed"');
    expect(html).toContain('id="unifiedBasicDnsServers"');
    expect(html).toContain('id="unifiedBasicDnsServersMixed"');
    expect(html).toContain('id="unifiedEncryptedDnsServers"');
    expect(html).toContain('id="unifiedEncryptedDnsServersMixed"');
    expect(html).toContain('id="unifiedRealIpDomains"');
    expect(html).toContain('id="unifiedRealIpDomainsMixed"');
    expect(html).toContain('id="unifiedRealIpDomainsInvalid"');
    expect(html).not.toContain('id="clearUnifiedBasicDnsServersBtn"');
    expect(html).not.toContain('id="clearUnifiedEncryptedDnsServersBtn"');
    expect(html).not.toContain('id="clearUnifiedRealIpDomainsBtn"');
    expect(html.match(/data-code-editor-rows="(?:6|8)"/g)).toHaveLength(3);
    expect(html.match(/data-unified-common-target-control/g)).toHaveLength(9);
    expect(html.match(/role="tab"/g)).toHaveLength(22);
    expect(html.match(/role="tabpanel"/g)).toHaveLength(22);
    expect(html.match(/aria-controls="(?:surge|clash|stash)-panel-/g)).toHaveLength(19);
    expect(html.match(/aria-labelledby="(?:surge|clash|stash)-tab-/g)).toHaveLength(19);
    expect(html).toContain('aria-controls="unified-config-panel-general"');
    expect(html).toContain('aria-controls="unified-config-panel-dns"');
    expect(html).toContain('aria-controls="unified-config-panel-rules"');
    expect(html).toContain('id="page-surge" class="page-view hidden" data-page="surge"');
    expect(html).toContain('id="page-clash" class="page-view hidden" data-page="clash"');
    expect(html).toContain('id="page-stash" class="page-view hidden" data-page="stash"');
    expect(app).toContain('const UNIFIED_CONFIG_TABS = ["general", "dns", "rules"]');
    expect(app).not.toContain("organizeUnifiedConfigPanels");
    expect(app).not.toContain("restoreIndependentConfigPanels");
    expect(app).not.toContain('return "unified-config"');
    expect(app).not.toContain('nextPage === "unified-config"');
    expect(app).not.toContain("moveConfigRowsToSlot");
    expect(app).not.toContain("moveConfigRowsToPanel");
    expect(app).toContain('link?.classList.remove("hidden")');
    expect(app).toContain('document.querySelectorAll("[data-unified-common-target-control]")');
    expect(app).toContain('control.classList.add("hidden")');
    expect(app).toContain('if (!compiled && activeUnifiedConfigTab === "rules") activeUnifiedConfigTab = "general"');
    expect(app).toContain('page === "unified-config"');
    expect(app).toContain("common: cloneConfig(ensureUnifiedCommonDraft())");
    expect(app).toContain("buildUnifiedCommonPatch(common, ruleSetsForSave)");
    expect(app).not.toContain("validateUnifiedConfig");
    expect(app).toContain('render({ preserveUnifiedCommonDraft: page !== "unified-config" })');
    expect(app).toContain("if (state && nextPage !== activePage) {");
    expect(app).toContain('window.addEventListener("beforeunload", handleBeforeUnload)');
    expect(app).toContain("applyStoredPageDrafts(page)");
    expect(app).toContain("restoreStateForPage(nextPage)");
    expect(html).toContain('<nav id="mainMenu"');
    expect(html).toContain('<h1 id="pageTitle" tabindex="-1">');
    expect(app).toContain('panel.setAttribute("aria-hidden", active ? "false" : "true")');
    expect(app).toContain('CODE_EDITOR_PAGES = new Set(["proxy-nodes", "unified-config"');
    expect(html.match(/data-manual-rule-tab/g)).toHaveLength(4);
    expect(html.match(/data-manual-rule-panel/g)).toHaveLength(4);
    expect(app).toContain("syncTargetRuleSectionsVisibility();");
    expect(app).toContain('document.querySelectorAll("[data-manual-rule-tab]")');
    expect(app).toContain('isRuleSetModeEnabled() && ["providers", "rules"].includes(requestedTab)');
    expect(app).toContain("rules: compiledRules ? state.clash.rules : currentClashRuleLines()");
    expect(app).toContain("rules: compiledRules ? state.stash.rules : parseClashRulesYaml(refs.stashRules.value).rules");
    expect(html).not.toContain('id="ruleSetSourcesBody"');
    expect(html).not.toContain('id="addRuleSetSourceBtn"');
    expect(app).not.toContain("renderRuleSetSources");
    expect(html).toContain('id="ruleSetRulesBody" class="rule-set-rule-list"');
    expect(html).toContain('id="ruleSetAggregateByPolicy"');
    expect(html).not.toContain('id="ruleSetOutputsBody"');
    expect(html).not.toContain('id="ruleSetDirectRulesBody"');
    expect(html).not.toContain('class="luci-table source-table rule-set-table rule-set-output-table"');
    expect(html).toContain('data-i18n="ruleSetOutputsTitle">统一规则集</span>');
    expect(html).toContain('data-i18n="refreshRuleSets">更新规则内容</button>');
    expect(html).toContain('id="summaryRuleSetCache"');
    expect(html).toContain('id="refreshRuleSetCacheBtn"');
    expect(app).toContain("formatRuleSetCacheStatus(ruleSetStatus)");
    expect(app).toContain('request("/api/rule-sets/refresh"');
    expect(app).toContain('refs.refreshRuleSetCacheBtn.addEventListener("click", refreshRuleSetCache)');
    expect(html).toContain('data-i18n="addRuleSetDirectRule">添加单条规则</button>');
    expect(html).toContain('data-i18n="addRuleSetOutput">添加规则集</button>');
    expect(app).toContain('ruleSetStatusEmpty: "尚无可用规则集，请先更新规则内容。"');
    expect(app).toContain('ruleSetStatusReady: "已有 {count} 个规则集可以使用。"');
    expect(app).toContain('ruleSetAutoType: "自动判断"');
    expect(app).toContain('data-rule-set-kind');
    expect(app).toContain('data-rule-set-direct-field="ruleType"');
    expect(app).toContain('data-rule-set-output-field="sourceUrls"');
    expect(app).toContain('data-rule-set-output-field="surgeOptions"');
    expect(app).toContain("output.surgeOptions = normalizeRuleSetOptionList(input.value)");
    expect(app).not.toContain('data-rule-set-output-field="inlineRules"');
    expect(css).not.toContain(".rule-set-source-table");
    expect(css).not.toContain(".rule-set-output-table");
    expect(css).toContain(".rule-set-rule-row.single");
    expect(app).not.toContain("rule-set-target-settings");
    expect(app).not.toContain("data-rule-set-direct-target");
    expect(app).not.toContain("data-rule-set-direct-raw");
    expect(css).not.toContain(".rule-set-target-settings");
    expect(html).toContain('class="rule-set-mode-tabs"');
    expect(html).not.toContain('section-tabs rule-set-mode-tabs');
    expect(css).toContain("grid-template-columns: repeat(2, minmax(0, max-content));");
    expect(css).toContain(".rule-set-mode-tabs .tab:has(input:focus-visible)");
    expect(html).not.toContain('data-page="shadowrocket"');
    expect(html).not.toContain('id="previewShadowrocketBtn"');
    expect(html).not.toContain('id="shadowrocketSkipProxy"');
    expect(html).not.toContain('id="shadowrocketRules"');
    expect(html).not.toContain('data-shadowrocket-tab');
    expect(app).not.toContain('preview("shadowrocket")');
    expect(app).toContain('const PREVIEW_TARGETS = ["surge", "clash", "stash"]');
    expect(app).toContain('previewWarnings: "诊断提示："');
    expect(app).toContain('class="diagnostic-group warning"');
    expect(app).toContain("查看详情");
    expect(app).toContain('t("previewDetails")');
    expect(css).toContain(".validation-messages .diagnostic-group");
    expect(css).toContain(".validation-messages .diagnostic-detail-list");
    expect(css).toContain(".config-code-editor .cm-gutter.cm-lineNumbers");
    expect(css).toContain("min-width: calc(4ch + 12px);");

    expect(html).toContain('id="displayTimeZone"');
    expect(html).toContain('value="Asia/Shanghai"');
    expect(html).toContain('value="UTC"');
    expect(html).toContain('value="Asia/Kolkata"');
    expect(html).toContain('value="America/Chicago"');
    expect(html).toContain('value="America/Sao_Paulo"');
    expect(html).toContain('value="Australia/Sydney"');
    expect(html).toContain('value="Africa/Johannesburg"');
    expect(html).toContain('<optgroup label="欧洲">');
    expect(html).toContain("显示时区");
    expect(app).toContain('displayTimeZone: "显示时区"');

    expect(html).not.toContain('data-i18n="service"');
    expect(html).not.toContain('data-i18n="stateRunning"');
    expect(html).not.toContain('id="systemSchemaVersion"');
    expect(app).not.toContain("kvSchemaVersion");
    expect(css).toContain(".status-grid {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr);");

    expect(html).toContain('id="logoutBtn"');
    expect(html).toContain('id="tokenRotationStatus"');
    expect(html).toContain('id="surgeTailscaleValidation"');
    expect(html).toContain('id="managedBaseUrlValidation"');
    expect(app).toContain('window.confirm(t("rotateReadTokenConfirm"))');
    expect(app).toContain("if (rotateTokenInFlight");
    expect(app).toContain('request("/api/logout", { method: "POST"');
    expect(app).toContain('document.querySelectorAll("#workspace input, #workspace textarea")');
    expect(app).toContain("refs.telegramBindStatus,");
    expect(app).toContain("refs.fetchRecordsTableBody,");
    expect(app).toContain("currentReadToken = \"\"");
    expect(app).toContain("currentPreviewContent = \"\"");
    expect(app).toContain('refs.notificationTelegramBotToken.addEventListener("input", handleTelegramBotTokenInput)');
    expect(app).toContain('url.protocol === "https:" && url.hostname.toLowerCase() === "github.com"');
    expect(app).toContain('setSaveStatus("idle");\n        window.alert(t("surgeTailscaleValidationError"))');
    expect(app).toContain("validateCompiledRuleSetFallback(ensureRuleSets())");
    expect(readPublicFile("app.js")).not.toMatch(/[一-龥]/u);
  });

  it("keeps runtime status version aligned with package metadata", () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const packageJson = JSON.parse(readFileSync(join(testDir, "../package.json"), "utf8")) as { version: string };
    const versionSource = readFileSync(join(testDir, "../src/version.ts"), "utf8");

    expect(versionSource).toContain(`APP_VERSION = "${packageJson.version}"`);
  });

  it("keeps target configuration routes available beside unified configuration", () => {
    const app = readPublicFile("app.js");
    const sandbox: { compiled: boolean; result?: unknown } = { compiled: false };
    const context = createContext(sandbox);
    const normalizedActivePage = extractFunctionSource(app, "normalizedActivePage");

    new Script(`
      const state = {};
      const isPageAvailable = () => true;
      const isRuleSetModeEnabled = () => globalThis.compiled;
      ${normalizedActivePage}
      globalThis.result = {
        manual: ["surge", "clash", "stash", "unified-config"].map(normalizedActivePage),
        compiled: (() => {
          globalThis.compiled = true;
          return ["surge", "clash", "stash", "unified-config"].map(normalizedActivePage);
        })()
      };
    `).runInContext(context);

    expect(sandbox.result).toEqual({
      manual: ["surge", "clash", "stash", "unified-config"],
      compiled: ["surge", "clash", "stash", "unified-config"]
    });
  });

  it("keeps common tabs available while limiting unified rules to compiled mode", () => {
    const app = readPublicFile("app.js");
    const sandbox: { result?: unknown } = {};
    const context = createContext(sandbox);
    const normalizedUnifiedConfigTab = extractFunctionSource(app, "normalizedUnifiedConfigTab");
    const syncUnifiedConfigTabs = extractFunctionSource(app, "syncUnifiedConfigTabs");

    new Script(`
      const UNIFIED_CONFIG_TABS = ["general", "dns", "rules"];
      const makeNode = (kind, name) => {
        const classes = new Set();
        return {
          dataset: kind === "tab" ? { unifiedConfigTab: name } : { unifiedConfigPanel: name },
          tabIndex: -1,
          attrs: {},
          classList: {
            toggle(value, force) { force ? classes.add(value) : classes.delete(value); },
            contains(value) { return classes.has(value); }
          },
          setAttribute(name, value) { this.attrs[name] = value; }
        };
      };
      const buttons = UNIFIED_CONFIG_TABS.map((name) => makeNode("tab", name));
      const panels = UNIFIED_CONFIG_TABS.map((name) => makeNode("panel", name));
      const document = {
        querySelectorAll(selector) {
          return selector === "[data-unified-config-tab]" ? buttons : panels;
        }
      };
      const state = {};
      let compiled = false;
      let activeUnifiedConfigTab = "rules";
      const isRuleSetModeEnabled = () => compiled;
      ${normalizedUnifiedConfigTab}
      ${syncUnifiedConfigTabs}
      syncUnifiedConfigTabs();
      const manual = {
        active: activeUnifiedConfigTab,
        tabs: buttons.map((button) => ({
          name: button.dataset.unifiedConfigTab,
          hidden: button.classList.contains("hidden"),
          active: button.classList.contains("active"),
          selected: button.attrs["aria-selected"],
          tabIndex: button.tabIndex
        })),
        visiblePanel: panels.find((panel) => !panel.classList.contains("hidden"))?.dataset.unifiedConfigPanel
      };
      compiled = true;
      activeUnifiedConfigTab = "rules";
      syncUnifiedConfigTabs();
      globalThis.result = {
        manual,
        compiled: {
          active: activeUnifiedConfigTab,
          rulesHidden: buttons[2].classList.contains("hidden"),
          rulesSelected: buttons[2].attrs["aria-selected"],
          rulesTabIndex: buttons[2].tabIndex,
          visiblePanel: panels.find((panel) => !panel.classList.contains("hidden"))?.dataset.unifiedConfigPanel
        }
      };
    `).runInContext(context);

    expect(sandbox.result).toEqual({
      manual: {
        active: "general",
        tabs: [
          { name: "general", hidden: false, active: true, selected: "true", tabIndex: 0 },
          { name: "dns", hidden: false, active: false, selected: "false", tabIndex: -1 },
          { name: "rules", hidden: true, active: false, selected: "false", tabIndex: -1 }
        ],
        visiblePanel: "general"
      },
      compiled: {
        active: "rules",
        rulesHidden: false,
        rulesSelected: "true",
        rulesTabIndex: 0,
        visiblePanel: "rules"
      }
    });
  });

  it("projects and rebuilds common settings without flattening mixed target values", () => {
    const app = readPublicFile("app.js");
    const sandbox: { result?: unknown } = {};
    const context = createContext(sandbox);
    const unifiedCommonState = extractFunctionSource(app, "unifiedCommonState");
    const splitUnifiedDnsServers = extractFunctionSource(app, "splitUnifiedDnsServers");
    const effectiveUnifiedNameservers = extractFunctionSource(app, "effectiveUnifiedNameservers");
    const isUnifiedRealIpDomain = extractFunctionSource(app, "isUnifiedRealIpDomain");
    const invalidUnifiedRealIpDomains = extractFunctionSource(app, "invalidUnifiedRealIpDomains");
    const unifiedBooleanControlState = extractFunctionSource(app, "unifiedBooleanControlState");
    const unifiedListControlState = extractFunctionSource(app, "unifiedListControlState");
    const buildUnifiedCommonPatch = extractFunctionSource(app, "buildUnifiedCommonPatch");

    new Script(`
      ${splitUnifiedDnsServers}
      ${effectiveUnifiedNameservers}
      ${isUnifiedRealIpDomain}
      ${invalidUnifiedRealIpDomains}
      ${unifiedCommonState}
      ${unifiedBooleanControlState}
      ${unifiedListControlState}
      ${buildUnifiedCommonPatch}
      const config = {
        surge: { ipv6: true, allowWifiAccess: false, dnsServer: ["1.1.1.1"], encryptedDnsServer: ["https://surge.example/dns-query"], alwaysRealIp: ["surge.example"] },
        clash: { ipv6: false, allowLan: true, defaultNameservers: ["223.5.5.5"], nameservers: ["udp://9.9.9.9", "https://clash.example/dns-query"], fakeIpFilter: ["clash.example"] },
        stash: { ipv6: true, allowLan: false, dns: { defaultNameservers: ["1.1.1.1"], nameservers: ["system", "quic://stash.example"], fakeIpFilter: ["stash.example"] } }
      };
      const projection = unifiedCommonState(config);
      const initialDraft = JSON.parse(JSON.stringify(projection));
      const changedDraft = JSON.parse(JSON.stringify(projection));
      changedDraft.ipv6 = [false, false, false];
      const fallbackPatch = buildUnifiedCommonPatch({
        ipv6: [true, true, true],
        lanAccess: [false, false, false],
        basicDnsServers: [["surge-basic"], ["clash-basic"], ["stash-basic"]],
        encryptedDnsServers: [[], [], []],
        realIpDomains: [["surge-real.example"], ["clash-real.example"], ["stash-real.example"]]
      }, { mode: "manual", sources: [], outputs: [], directRules: [] });
      globalThis.result = {
        enabled: unifiedBooleanControlState([true, true, true]),
        disabled: unifiedBooleanControlState([false, false, false]),
        mixed: unifiedBooleanControlState([true, false, true]),
        sameList: unifiedListControlState([["https://dns.example"], ["https://dns.example"], ["https://dns.example"]]),
        mixedList: unifiedListControlState([["https://dns.example"], ["quic://dns.example"], ["https://dns.example"]]),
        encryptedNameservers: effectiveUnifiedNameservers(["1.1.1.1"], ["https://dns.example", "https://dns.example"]),
        fallbackNameservers: effectiveUnifiedNameservers(["1.1.1.1", "1.1.1.1"], []),
        realIpDomainValidation: {
          exact: isUnifiedRealIpDomain("service.example.com"),
          wildcard: isUnifiedRealIpDomain("*.example.com"),
          embeddedWildcard: isUnifiedRealIpDomain("xbox.*.microsoft.com"),
          trailingWildcard: isUnifiedRealIpDomain("stun.*"),
          partialLabelWildcard: isUnifiedRealIpDomain("stun*.example.com"),
          geosite: isUnifiedRealIpDomain("geosite:private"),
          invalid: invalidUnifiedRealIpDomains(["valid.example", "rule-set:private", "+.example.com", "rule-set:private"])
        },
        projection,
        initialDirty: JSON.stringify(initialDraft) !== JSON.stringify(projection),
        changedDirty: JSON.stringify(changedDraft) !== JSON.stringify(projection),
        fallbackPatch: {
          clash: fallbackPatch.clash,
          stash: fallbackPatch.stash
        },
        patch: buildUnifiedCommonPatch({
          ipv6: [true, false, true],
          lanAccess: [false, true, false],
          basicDnsServers: [["surge-basic"], ["clash-basic"], ["stash-basic"]],
          encryptedDnsServers: [["surge-encrypted"], ["clash-encrypted"], ["stash-encrypted"]],
          realIpDomains: [["surge-real.example"], ["clash-real.example"], ["stash-real.example"]]
        }, { mode: "compiled", sources: [], outputs: [], directRules: [] })
      };
    `).runInContext(context);

    expect(sandbox.result).toEqual({
      enabled: { checked: true, mixed: false },
      disabled: { checked: false, mixed: false },
      mixed: { checked: false, mixed: true },
      sameList: { value: "https://dns.example", mixed: false },
      mixedList: { value: "", mixed: true },
      encryptedNameservers: ["https://dns.example"],
      fallbackNameservers: ["1.1.1.1"],
      realIpDomainValidation: {
        exact: true,
        wildcard: true,
        embeddedWildcard: true,
        trailingWildcard: true,
        partialLabelWildcard: false,
        geosite: false,
        invalid: ["rule-set:private", "+.example.com"]
      },
      projection: {
        ipv6: [true, false, true],
        lanAccess: [false, true, false],
        basicDnsServers: [
          ["1.1.1.1"],
          ["223.5.5.5"],
          ["1.1.1.1"]
        ],
        encryptedDnsServers: [
          ["https://surge.example/dns-query"],
          ["https://clash.example/dns-query"],
          ["quic://stash.example"]
        ],
        realIpDomains: [
          ["surge.example"],
          ["clash.example"],
          ["stash.example"]
        ]
      },
      initialDirty: false,
      changedDirty: true,
      fallbackPatch: {
        clash: { ipv6: true, allowLan: false, defaultNameservers: ["clash-basic"], nameservers: ["clash-basic"], fakeIpFilter: ["clash-real.example"] },
        stash: { ipv6: true, allowLan: false, dns: { defaultNameservers: ["stash-basic"], nameservers: ["stash-basic"], fakeIpFilter: ["stash-real.example"] } }
      },
      patch: {
        ruleSets: { mode: "compiled", sources: [], outputs: [], directRules: [] },
        surge: { ipv6: true, allowWifiAccess: false, dnsServer: ["surge-basic"], encryptedDnsServer: ["surge-encrypted"], alwaysRealIp: ["surge-real.example"] },
        clash: { ipv6: false, allowLan: true, defaultNameservers: ["clash-basic"], nameservers: ["clash-encrypted"], fakeIpFilter: ["clash-real.example"] },
        stash: { ipv6: true, allowLan: false, dns: { defaultNameservers: ["stash-basic"], nameservers: ["stash-encrypted"], fakeIpFilter: ["stash-real.example"] } }
      }
    });
  });

  it("maps newline-separated output URLs to shared internal rule sources", () => {
    const app = readPublicFile("app.js");
    let nextId = 0;
    const sandbox: {
      result?: unknown;
      ruleSets: {
        sources: Array<Record<string, unknown>>;
        outputs: Array<{ name: string; sourceIds: string[] }>;
      };
      crypto: { randomUUID: () => string };
      URL: typeof URL;
    } = {
      ruleSets: {
        sources: [{
          id: "shared",
          name: "shared.list",
          url: "https://rules.example/shared.list",
          enabled: true,
          format: "auto",
          order: 0
        }],
        outputs: [
          { name: "First", sourceIds: ["shared"] },
          { name: "Second", sourceIds: ["shared"] }
        ]
      },
      crypto: { randomUUID: () => `generated-${++nextId}` },
      URL
    };
    const context = createContext(sandbox);
    const functions = [
      "textToLines",
      "nextRuleSetOrder",
      "ruleSetSourceName",
      "pruneUnusedRuleSetSources",
      "syncRuleSetOutputSourceUrls"
    ].map((name) => extractFunctionSource(app, name)).join("\n");

    new Script(`${functions}
      syncRuleSetOutputSourceUrls(
        globalThis.ruleSets,
        globalThis.ruleSets.outputs[0],
        "https://rules.example/shared.list\\nhttps://rules.example/new.yaml\\nhttps://rules.example/new.yaml"
      );
      syncRuleSetOutputSourceUrls(
        globalThis.ruleSets,
        globalThis.ruleSets.outputs[0],
        "https://rules.example/new.yaml"
      );
      globalThis.ruleSets.outputs = globalThis.ruleSets.outputs.filter((output) => output.name !== "Second");
      pruneUnusedRuleSetSources(globalThis.ruleSets);
      globalThis.result = globalThis.ruleSets;
    `).runInContext(context);

    expect(sandbox.result).toEqual({
      sources: [{
        id: "generated-1",
        name: "new.yaml",
        url: "https://rules.example/new.yaml",
        enabled: true,
        format: "auto",
        order: 1
      }],
      outputs: [{ name: "First", sourceIds: ["generated-1"] }]
    });
  });

  it("offers enabled Tailscale policies in the unified rule target selector", () => {
    const app = readPublicFile("app.js");
    const sandbox: {
      result?: string;
      state: {
        surge: {
          tailscaleNodes: Array<{ name: string; authKey: string; enabled: boolean }>;
        };
      };
      CLASH_BUILT_IN_POLICIES: string[];
      groupEntries: () => Array<[string, string]>;
      escapeHtml: (value: unknown) => string;
      renderPolicyLabel: (value: string) => string;
    } = {
      state: {
        surge: {
          tailscaleNodes: [
            { name: "Tailnet Exit", authKey: "tskey-auth-test", enabled: true },
            { name: "Disabled Tailnet", authKey: "tskey-auth-disabled", enabled: false },
            { name: "Missing Key", authKey: "", enabled: true }
          ]
        }
      },
      CLASH_BUILT_IN_POLICIES: ["DIRECT", "REJECT"],
      groupEntries: () => [["Proxy", "select"]],
      escapeHtml: (value) => String(value),
      renderPolicyLabel: (value) => value
    };
    const context = createContext(sandbox);
    const functions = [
      "clashPolicyCandidates",
      "configuredSurgeTailscalePolicies",
      "renderRuleSetPolicyOptions"
    ].map((name) => extractFunctionSource(app, name)).join("\n");

    new Script(`${functions}
      globalThis.result = renderRuleSetPolicyOptions("Tailnet Exit");
    `).runInContext(context);

    expect(sandbox.result).toContain('<option value="Tailnet Exit" selected>Tailnet Exit</option>');
    expect(sandbox.result).not.toContain("Disabled Tailnet");
    expect(sandbox.result).not.toContain("Missing Key");
  });

  it("supports IP-ASN in the Surge rule editor and its no-resolve validation", () => {
    const app = readPublicFile("app.js");
    const constantsStart = app.indexOf("const SURGE_RULE_TYPES");
    const constantsEnd = app.indexOf("function isBuiltInGroupName", constantsStart);
    expect(constantsStart).toBeGreaterThan(-1);
    expect(constantsEnd).toBeGreaterThan(constantsStart);

    const sandbox: { result?: unknown } = {};
    const context = createContext(sandbox);
    new Script(`${app.slice(constantsStart, constantsEnd)}
      ${extractFunctionSource(app, "allowedSurgeRuleOptions")}
      globalThis.result = {
        selectable: SURGE_RULE_TYPES.includes("IP-ASN"),
        valueRule: SURGE_VALUE_RULE_TYPES.has("IP-ASN"),
        options: [...allowedSurgeRuleOptions("single", "", "IP-ASN")],
        unrelatedOptions: [...allowedSurgeRuleOptions("single", "", "PROCESS-NAME")]
      };
    `).runInContext(context);

    expect(sandbox.result).toEqual({
      selectable: true,
      valueRule: true,
      options: ["no-resolve"],
      unrelatedOptions: []
    });
  });

  it("keeps quoted commas, logical expressions, and target-specific policies intact", () => {
    const app = readPublicFile("app.js");
    const constantsStart = app.indexOf("const CLASH_BUILT_IN_POLICIES");
    const constantsEnd = app.indexOf("function parseClashRulesYaml", constantsStart);
    const sandbox: { lines: string[]; result?: unknown } = {
      lines: [
        'DOMAIN-REGEX,"^foo,bar$",Proxy',
        "DOMAIN-REGEX,'^foo,bar$',Proxy",
        'DOMAIN-REGEX,"^foo,""bar""$",Proxy',
        String.raw`DOMAIN-REGEX,"^foo\",bar$",Proxy`,
        "AND,((DOMAIN,a.example),(DOMAIN,b.example)),Proxy"
      ]
    };
    const context = createContext(sandbox);

    new Script(`
      ${app.slice(constantsStart, constantsEnd)}
      ${extractFunctionSource(app, "splitSurgeRuleLine")}
      const normalizeClashRulePolicy = (value) => String(value || "").trim();
      ${extractFunctionSource(app, "parseClashRuleLine")}
      globalThis.result = {
        parts: globalThis.lines.map(splitSurgeRuleLine),
        logical: parseClashRuleLine(globalThis.lines[4]),
        clashPolicies: CLASH_BUILT_IN_POLICIES,
        stashPolicies: STASH_BUILT_IN_POLICIES,
        logicalTypes: ["AND", "OR", "NOT", "PROCESS-NAME-REGEX", "NETWORK", "DSCP", "IN-PORT", "SRC-IP-ASN"]
          .every((type) => CLASH_RULE_TYPES.includes(type))
      };
    `).runInContext(context);

    expect(sandbox.result).toEqual({
      parts: [
        ["DOMAIN-REGEX", '"^foo,bar$"', "Proxy"],
        ["DOMAIN-REGEX", "'^foo,bar$'", "Proxy"],
        ["DOMAIN-REGEX", '"^foo,""bar""$"', "Proxy"],
        ["DOMAIN-REGEX", String.raw`"^foo\",bar$"`, "Proxy"],
        ["AND", "((DOMAIN,a.example),(DOMAIN,b.example))", "Proxy"]
      ],
      logical: {
        kind: "single",
        ruleType: "AND",
        value: "((DOMAIN,a.example),(DOMAIN,b.example))",
        policy: "Proxy",
        options: ""
      },
      clashPolicies: ["Proxy", "DIRECT", "REJECT", "REJECT-DROP", "PASS", "PASS-RULE", "COMPATIBLE", "GLOBAL"],
      stashPolicies: ["Proxy", "DIRECT", "REJECT", "REJECT-DROP", "PASS", "GLOBAL"],
      logicalTypes: true
    });
  });

  it("rejects reserved managed paths and invalid group policy names before save", () => {
    const app = readPublicFile("app.js");
    const reservedPaths = app.match(/const RESERVED_MANAGED_BASE_PATHS = new Set\(\[[\s\S]*?\]\);/)?.[0];
    if (!reservedPaths) throw new Error("RESERVED_MANAGED_BASE_PATHS not found");
    const sandbox: { result?: unknown; URL: typeof URL } = { URL };
    const context = createContext(sandbox);

    new Script(`
      ${reservedPaths}
      const SUBNET_BUILT_IN_POLICIES = ["Proxy", "DIRECT", "CELLULAR", "CELLULAR-ONLY", "HYBRID", "NO-HYBRID", "REJECT", "REJECT-DROP", "REJECT-NO-DROP", "REJECT-TINYGIF"];
      const CLASH_BUILT_IN_POLICIES = ["Proxy", "DIRECT", "REJECT", "REJECT-DROP", "PASS", "PASS-RULE", "COMPATIBLE", "GLOBAL"];
      const STASH_BUILT_IN_POLICIES = ["Proxy", "DIRECT", "REJECT", "REJECT-DROP", "PASS", "GLOBAL"];
      ${extractFunctionSource(app, "managedBaseUrlValidationKey")}
      ${extractFunctionSource(app, "isReservedClientPolicyName")}
      ${extractFunctionSource(app, "groupNameValidationKey")}
      globalThis.result = {
        managed: {
          valid: managedBaseUrlValidationKey("https://subpilot.example.com/sync/"),
          missing: managedBaseUrlValidationKey(""),
          invalid: managedBaseUrlValidationKey("ftp://subpilot.example.com/sync"),
          root: managedBaseUrlValidationKey("https://subpilot.example.com/"),
          api: managedBaseUrlValidationKey("https://subpilot.example.com/api/config"),
          vendor: managedBaseUrlValidationKey("https://subpilot.example.com/vendor/codemirror"),
          asset: managedBaseUrlValidationKey("https://subpilot.example.com/app.js/")
        },
        groups: {
          proxy: groupNameValidationKey("Proxy"),
          normal: groupNameValidationKey("Streaming"),
          reserved: groupNameValidationKey("global"),
          comma: groupNameValidationKey("Bad,Group"),
          whitespace: groupNameValidationKey(" Padded ")
        }
      };
    `).runInContext(context);

    expect(sandbox.result).toEqual({
      managed: {
        valid: "",
        missing: "managedBaseUrlRequired",
        invalid: "managedBaseUrlInvalid",
        root: "managedBaseUrlRoot",
        api: "managedBaseUrlReserved",
        vendor: "managedBaseUrlReserved",
        asset: "managedBaseUrlReserved"
      },
      groups: {
        proxy: "",
        normal: "",
        reserved: "groupNameReserved",
        comma: "groupNameInvalid",
        whitespace: "groupNameInvalid"
      }
    });
  });

  it("requires one cross-target-compatible compiled fallback", () => {
    const app = readPublicFile("app.js");
    const sandbox: { result?: unknown } = {};
    const context = createContext(sandbox);

    new Script(`
      const SUBNET_BUILT_IN_POLICIES = ["Proxy", "DIRECT", "CELLULAR", "CELLULAR-ONLY", "HYBRID", "NO-HYBRID", "REJECT", "REJECT-DROP", "REJECT-NO-DROP", "REJECT-TINYGIF"];
      const CLASH_BUILT_IN_POLICIES = ["Proxy", "DIRECT", "REJECT", "REJECT-DROP", "PASS", "PASS-RULE", "COMPATIBLE", "GLOBAL"];
      const STASH_BUILT_IN_POLICIES = ["Proxy", "DIRECT", "REJECT", "REJECT-DROP", "PASS", "GLOBAL"];
      ${extractFunctionSource(app, "normalizeRuleSetMode")}
      ${extractFunctionSource(app, "splitSurgeRuleLine")}
      ${extractFunctionSource(app, "compiledRuleSetFallbackError")}
      const config = (directRules, mode = "compiled") => ({ mode, directRules });
      const fallback = (policy, rule = "FINAL,Proxy", enabled = true) => ({ policy, rule, enabled });
      globalThis.result = {
        manual: compiledRuleSetFallbackError(config([], "manual"), []),
        missing: compiledRuleSetFallbackError(config([]), []),
        duplicate: compiledRuleSetFallbackError(config([fallback("Proxy"), fallback("Proxy", "MATCH,Proxy")]), []),
        tailscale: compiledRuleSetFallbackError(config([fallback("Tailnet Exit")]), ["Tailnet Exit"]),
        surgeOnly: compiledRuleSetFallbackError(config([fallback("REJECT-NO-DROP")]), []),
        clashOnly: compiledRuleSetFallbackError(config([fallback("GLOBAL")]), []),
        device: compiledRuleSetFallbackError(config([fallback("DEVICE:Mac")]), []),
        direct: compiledRuleSetFallbackError(config([fallback("DIRECT")]), []),
        rejectDrop: compiledRuleSetFallbackError(config([fallback("REJECT-DROP")]), []),
        custom: compiledRuleSetFallbackError(config([fallback("Streaming")]), [])
      };
    `).runInContext(context);

    expect(sandbox.result).toEqual({
      manual: null,
      missing: { key: "compiledFallbackMissing", policy: "" },
      duplicate: { key: "compiledFallbackDuplicate", policy: "" },
      tailscale: { key: "compiledFallbackTargetInvalid", policy: "Tailnet Exit" },
      surgeOnly: { key: "compiledFallbackTargetInvalid", policy: "REJECT-NO-DROP" },
      clashOnly: { key: "compiledFallbackTargetInvalid", policy: "GLOBAL" },
      device: { key: "compiledFallbackTargetInvalid", policy: "DEVICE:Mac" },
      direct: null,
      rejectDrop: null,
      custom: null
    });
  });

  it("mirrors Tailscale test URL and underlying-policy validation", () => {
    const app = readPublicFile("app.js");
    const groupSpecs = readPublicFile("app-policy-group-spec.js");
    const sandbox: { result?: unknown; URL: typeof URL } = { URL };
    const context = createContext(sandbox);
    const functions = [
      "isValidSurgeTailscaleTestUrl",
      "hasSurgeTailscaleUnderlyingCycle",
      "potentialSurgeGroupHasMemberDraft",
      "resolvePotentialSurgePoliciesDraft",
      "surgeProxyNodeDraftProtocol",
      "validateSurgeTailscaleNodeList"
    ].map((name) => extractFunctionSource(app, name)).join("\n");
    const groupFunctions = groupSpecs.replaceAll("export ", "");

    new Script(`
      const SUBNET_BUILT_IN_POLICIES = ["Proxy", "DIRECT", "CELLULAR", "CELLULAR-ONLY", "HYBRID", "NO-HYBRID", "REJECT", "REJECT-DROP", "REJECT-NO-DROP", "REJECT-TINYGIF"];
      ${groupFunctions}
      ${functions}
      const node = (name, underlyingProxy = "") => ({
        name,
        sectionName: name.toLowerCase().replace(/\\s+/g, "-"),
        authKey: "tskey-auth-test",
        enabled: true,
        mtu: 1280,
        testTimeout: 5,
        testUrl: "http://example.com/generate_204",
        underlyingProxy
      });
      const options = {
        groupNames: ["Proxy", "Disabled", "Empty", "Via Manual", "Via Vless"],
        activeGroupNames: ["Proxy", "Empty", "Via Manual", "Via Vless"],
        proxyNames: ["Manual Exit"],
        configuredProxyNames: ["Manual Exit", "VLESS Exit"],
        groupSpecs: {
          Proxy: "select, {all}",
          Disabled: "select, DIRECT",
          Empty: "select",
          "Via Manual": "select, Manual Exit",
          "Via Vless": "select, VLESS Exit"
        },
        builtInPolicies: SUBNET_BUILT_IN_POLICIES,
        reservedPolicies: [...SUBNET_BUILT_IN_POLICIES, "PASS", "PASS-RULE", "COMPATIBLE", "GLOBAL"]
      };
      const invalidHttps = node("HTTPS Test", "Proxy");
      invalidHttps.testUrl = "https://example.com/generate_204";
      const disabled = node("Disabled Tailnet");
      disabled.enabled = false;
      disabled.authKey = "";
      globalThis.result = {
        validGroup: validateSurgeTailscaleNodeList([node("Tail A", "Proxy")], options).valid,
        validProxy: validateSurgeTailscaleNodeList([node("Tail A", "Manual Exit")], options).valid,
        validDirect: validateSurgeTailscaleNodeList([node("Tail A", "DIRECT")], options).valid,
        validDisabled: validateSurgeTailscaleNodeList([disabled], options).valid,
        invalidHttps: validateSurgeTailscaleNodeList([invalidHttps], options).valid,
        missingUnderlying: validateSurgeTailscaleNodeList([node("Tail A", "Missing")], options).valid,
        selfReference: validateSurgeTailscaleNodeList([node("Tail A", "Tail A")], options).valid,
        cycle: validateSurgeTailscaleNodeList([node("Tail A", "Tail B"), node("Tail B", "Tail A")], options).valid,
        validDependency: validateSurgeTailscaleNodeList([node("Tail A", "Tail B"), node("Tail B")], options).valid,
        disabledGroup: validateSurgeTailscaleNodeList([node("Tail A", "Disabled")], options).valid,
        emptyGroup: validateSurgeTailscaleNodeList([node("Tail A", "Empty")], options).valid,
        supportedProxyGroup: validateSurgeTailscaleNodeList([node("Tail A", "Via Manual")], options).valid,
        unsupportedProxyGroup: validateSurgeTailscaleNodeList([node("Tail A", "Via Vless")], options).valid,
        protocols: {
          surgeVless: surgeProxyNodeDraftProtocol("VLESS = vless, example.com, 443"),
          surgeSs: surgeProxyNodeDraftProtocol("SS = ss://cipher@example.com:443"),
          clashVless: surgeProxyNodeDraftProtocol("- name: VLESS Exit\\n  type: vless\\n  server: example.com\\n  port: 443")
        },
        nameCollision: validateSurgeTailscaleNodeList([node("GLOBAL")], options).valid
      };
    `).runInContext(context);

    expect(sandbox.result).toEqual({
      validGroup: true,
      validProxy: true,
      validDirect: true,
      validDisabled: true,
      invalidHttps: false,
      missingUnderlying: false,
      selfReference: false,
      cycle: false,
      validDependency: true,
      disabledGroup: false,
      emptyGroup: false,
      supportedProxyGroup: true,
      unsupportedProxyGroup: false,
      protocols: { surgeVless: "vless", surgeSs: "ss", clashVless: "vless" },
      nameCollision: false
    });
  });

  it("restores drafts from other pages after a page-scoped save and warns before unload", () => {
    const app = readPublicFile("app.js");
    const sandbox: { result?: unknown } = {};
    const context = createContext(sandbox);
    const functions = [
      "applyPageDraftToState",
      "syncPageDraft",
      "applyStoredPageDrafts",
      "restoreStateForPage",
      "handleBeforeUnload"
    ].map((name) => extractFunctionSource(app, name)).join("\n");

    new Script(`
      const cloneConfig = (value) => JSON.parse(JSON.stringify(value));
      const normalizeRuleSetMode = (mode) => mode === "compiled" ? "compiled" : "manual";
      const EDITABLE_PAGES = new Set(["settings", "sources"]);
      const renderedPages = new Set(["settings", "sources"]);
      const pageDrafts = new Map();
      let state = {
        settings: { managedBaseUrl: "https://old.example/sync" },
        ruleSets: { mode: "manual" },
        sources: [{ name: "Old source" }]
      };
      let lastSavedState = cloneConfig(state);
      const settingsDraft = {
        settings: { managedBaseUrl: "https://draft.example/sync" },
        ruleSets: { mode: "compiled" }
      };
      const pageDraft = (page) => page === "settings" ? settingsDraft : { sources: cloneConfig(state.sources) };
      const pageBaseline = (page) => page === "settings"
        ? { settings: lastSavedState.settings, ruleSets: { mode: lastSavedState.ruleSets.mode } }
        : { sources: lastSavedState.sources };
      let unloadDirty = true;
      const hasAnyUnsavedChanges = () => unloadDirty;
      ${functions}

      const captured = syncPageDraft("settings");
      state = {
        settings: { managedBaseUrl: "https://old.example/sync" },
        ruleSets: { mode: "manual" },
        sources: [{ name: "Saved source" }]
      };
      lastSavedState = cloneConfig(state);
      restoreStateForPage("sources");
      const savedPageState = cloneConfig(state);
      restoreStateForPage("settings");

      const dirtyEvent = { prevented: false, returnValue: null, preventDefault() { this.prevented = true; } };
      handleBeforeUnload(dirtyEvent);
      unloadDirty = false;
      const cleanEvent = { prevented: false, returnValue: null, preventDefault() { this.prevented = true; } };
      handleBeforeUnload(cleanEvent);
      globalThis.result = {
        captured,
        draftCount: pageDrafts.size,
        savedPageState,
        state,
        dirtyEvent,
        cleanEvent
      };
    `).runInContext(context);

    expect(sandbox.result).toEqual({
      captured: true,
      draftCount: 1,
      savedPageState: {
        settings: { managedBaseUrl: "https://old.example/sync" },
        ruleSets: { mode: "compiled" },
        sources: [{ name: "Saved source" }]
      },
      state: {
        settings: { managedBaseUrl: "https://draft.example/sync" },
        ruleSets: { mode: "compiled" },
        sources: [{ name: "Saved source" }]
      },
      dirtyEvent: { prevented: true, returnValue: "", preventDefault: expect.any(Function) },
      cleanEvent: { prevented: false, returnValue: null, preventDefault: expect.any(Function) }
    });
  });

  it("rebases overlapping page drafts onto the latest saved fields", () => {
    const app = readPublicFile("app.js");
    const sandbox: { result?: unknown } = {};
    const context = createContext(sandbox);

    new Script(`
      const cloneConfig = (value) => JSON.parse(JSON.stringify(value));
      ${extractFunctionSource(app, "rebaseDraftValue")}
      const oldUnified = {
        ruleSets: { mode: "manual", outputs: [{ name: "Old" }] },
        common: { ipv6: [true, true, true], basicDnsServers: [["1.1.1.1"], ["1.1.1.1"], ["1.1.1.1"]] }
      };
      const unifiedDraft = cloneConfig(oldUnified);
      unifiedDraft.common.ipv6 = [false, false, false];
      const newUnified = {
        ruleSets: { mode: "compiled", outputs: [{ name: "Server" }] },
        common: { ipv6: [true, true, true], basicDnsServers: [["9.9.9.9"], ["9.9.9.9"], ["9.9.9.9"]] }
      };
      globalThis.result = {
        unified: rebaseDraftValue(oldUnified, unifiedDraft, newUnified),
        target: rebaseDraftValue(
          { surge: { ipv6: true, proxyTestUrl: "https://old.example/test" } },
          { surge: { ipv6: true, proxyTestUrl: "https://draft.example/test" } },
          { surge: { ipv6: false, proxyTestUrl: "https://old.example/test" } }
        )
      };
    `).runInContext(context);

    expect(sandbox.result).toEqual({
      unified: {
        ruleSets: { mode: "compiled", outputs: [{ name: "Server" }] },
        common: {
          ipv6: [false, false, false],
          basicDnsServers: [["9.9.9.9"], ["9.9.9.9"], ["9.9.9.9"]]
        }
      },
      target: {
        surge: { ipv6: false, proxyTestUrl: "https://draft.example/test" }
      }
    });
  });

  it("preserves edits made on the saved page while its request is in flight", async () => {
    const app = readPublicFile("app.js");
    const sandbox: { done?: Promise<void>; result?: unknown } = {};
    const context = createContext(sandbox);
    const saveActivePage = `async ${extractFunctionSource(app, "saveActivePage")}`;

    new Script(`
      const cloneConfig = (value) => JSON.parse(JSON.stringify(value));
      let state = { sources: [{ name: "Submitted" }] };
      let lastSavedState = { sources: [{ name: "Saved" }] };
      const pageDrafts = new Map();
      const pendingPageSaveDrafts = new Map();
      let activePage = "sources";
      let unifiedCommonDraft = null;
      let saveStatusResetTimer = 0;
      let clientSessionVersion = 0;
      let configSaveInFlight = false;
      let logoutInFlight = false;
      let resolveRequest;
      const refs = {
        saveBtn: {
          dataset: { state: "idle" },
          textContent: "",
          disabled: false,
          setAttribute() {}
        }
      };
      const window = {
        alert() {},
        clearTimeout() {},
        setTimeout() { return 0; }
      };
      const t = (key) => key;
      const isSaveButtonDisabled = (_button, status) => status === "saving" || status === "saved";
      const syncLogoutButtonState = () => {};
      const updateSaveAvailability = () => {};
      ${extractFunctionSource(app, "setSaveStatus")}
      const pageDraft = () => cloneConfig({ sources: state.sources });
      ${extractFunctionSource(app, "pageBaseline")}
      ${extractFunctionSource(app, "hasUnsavedChanges")}
      ${extractFunctionSource(app, "baselineForPageFromState")}
      ${extractFunctionSource(app, "rebaseDraftValue")}
      ${extractFunctionSource(app, "rebaseStoredPageDrafts")}
      const syncPageDraft = () => {};
      const applyStoredPageDrafts = (page) => {
        const draft = pageDrafts.get(page);
        if (draft) state.sources = cloneConfig(draft.sources);
      };
      const normalizeRuleSetMode = (mode) => mode === "compiled" ? "compiled" : "manual";
      ${extractFunctionSource(app, "restoreStateForPage")}
      const render = () => {};
      const requests = [];
      const request = (_url, options) => new Promise((resolve) => {
        const body = JSON.parse(options.body);
        requests.push(body);
        resolveRequest = () => resolve(body);
      });
      const requestConfigSave = (patch) => request("/api/config", { method: "PATCH", body: JSON.stringify(patch) });
      ${saveActivePage}

      globalThis.done = (async () => {
        const saving = saveActivePage("sources");
        await Promise.resolve();
        await saveActivePage("sources");
        const concurrentRequestCount = requests.length;
        state.sources[0].name = "Edited after submit";
        resolveRequest();
        await saving;
        const afterFirstSave = {
          state: cloneConfig(state),
          baseline: cloneConfig(lastSavedState),
          draft: cloneConfig(pageDrafts.get("sources")),
          dirty: hasUnsavedChanges("sources"),
          pendingCount: pendingPageSaveDrafts.size
        };
        const secondSave = saveActivePage("sources");
        await Promise.resolve();
        resolveRequest();
        await secondSave;
        globalThis.result = {
          afterFirstSave,
          concurrentRequestCount,
          requests,
          finalState: cloneConfig(state),
          finalBaseline: cloneConfig(lastSavedState),
          finalDraftCount: pageDrafts.size
        };
      })();
    `).runInContext(context);

    await sandbox.done;
    expect(sandbox.result).toEqual({
      afterFirstSave: {
        state: { sources: [{ name: "Edited after submit" }] },
        baseline: { sources: [{ name: "Submitted" }] },
        draft: { sources: [{ name: "Edited after submit" }] },
        dirty: true,
        pendingCount: 0
      },
      concurrentRequestCount: 1,
      requests: [
        { sources: [{ name: "Submitted" }] },
        { sources: [{ name: "Edited after submit" }] }
      ],
      finalState: { sources: [{ name: "Edited after submit" }] },
      finalBaseline: { sources: [{ name: "Edited after submit" }] },
      finalDraftCount: 0
    });
  });

  it("serializes config saves and retries one transient 429 using Retry-After", async () => {
    const app = readPublicFile("app.js");
    const sandbox: { done?: Promise<void>; result?: unknown } = {};
    const context = createContext(sandbox);

    new Script(`
      let clientSessionVersion = 3;
      let requestCount = 0;
      const delays = [];
      const bodies = [];
      const window = {
        setTimeout(resolve, delay) {
          delays.push(delay);
          resolve();
          return 1;
        }
      };
      const request = async (_path, options) => {
        requestCount += 1;
        bodies.push(options.body);
        if (requestCount === 1) {
          const error = new Error("busy");
          error.status = 429;
          error.retryAfter = "2";
          throw error;
        }
        return { sources: [{ name: "Saved" }] };
      };
      ${extractFunctionSource(app, "configSaveRetryDelayMilliseconds")}
      ${`async ${extractFunctionSource(app, "requestConfigSave")}`}

      globalThis.done = (async () => {
        const result = await requestConfigSave({ sources: [{ name: "Saved" }] });
        globalThis.result = { requestCount, delays, bodies, result };
      })();
    `).runInContext(context);

    await sandbox.done;
    expect(sandbox.result).toEqual({
      requestCount: 2,
      delays: [2000],
      bodies: [
        JSON.stringify({ sources: [{ name: "Saved" }] }),
        JSON.stringify({ sources: [{ name: "Saved" }] })
      ],
      result: { sources: [{ name: "Saved" }] }
    });
  });

  it("clears Telegram binding state when the bot token changes", () => {
    const app = readPublicFile("app.js");
    const sandbox: { result?: unknown } = {};
    const context = createContext(sandbox);

    new Script(`
      const refs = { notificationTelegramBotToken: { value: "new-token" } };
      const state = { settings: {
        notificationTelegramBotToken: "saved-token",
        notificationTelegramChatId: "12345",
        notificationTelegramWebhookSecret: "saved-secret"
      } };
      const lastSavedState = { settings: {
        notificationTelegramBotToken: "saved-token",
        notificationTelegramChatId: "12345",
        notificationTelegramWebhookSecret: "saved-secret"
      } };
      let stopped = 0;
      let rendered = 0;
      let updated = 0;
      const stopTelegramBindPolling = () => { stopped += 1; };
      const renderTelegramBindStatus = () => { rendered += 1; };
      const updateSaveAvailability = () => { updated += 1; };
      ${extractFunctionSource(app, "isTelegramChatBound")}
      ${extractFunctionSource(app, "handleTelegramBotTokenInput")}

      handleTelegramBotTokenInput();
      const changed = {
        chatId: state.settings.notificationTelegramChatId,
        webhookSecret: state.settings.notificationTelegramWebhookSecret,
        bound: isTelegramChatBound()
      };
      refs.notificationTelegramBotToken.value = "saved-token";
      handleTelegramBotTokenInput();
      globalThis.result = {
        changed,
        restored: {
          chatId: state.settings.notificationTelegramChatId,
          webhookSecret: state.settings.notificationTelegramWebhookSecret,
          bound: isTelegramChatBound()
        },
        stopped,
        rendered,
        updated
      };
    `).runInContext(context);

    expect(sandbox.result).toEqual({
      changed: { chatId: "", webhookSecret: "", bound: false },
      restored: { chatId: "12345", webhookSecret: "saved-secret", bound: true },
      stopped: 2,
      rendered: 2,
      updated: 2
    });
  });

  it("invalidates in-flight Telegram binding work when polling stops or the token changes", async () => {
    const app = readPublicFile("app.js");
    const sandbox: { done?: Promise<void>; result?: unknown } = {};
    const context = createContext(sandbox);

    new Script(`
      let clientSessionVersion = 0;
      let telegramBindPollTimer = 0;
      let telegramBindPollVersion = 0;
      let state = { settings: { notificationTelegramBotToken: "old-token" } };
      let lastSavedState = { settings: { notificationTelegramBotToken: "old-token" } };
      let nextTimerId = 0;
      let resolvePollRequest;
      let resolveBindRequest;
      let syncCount = 0;
      let renderCount = 0;
      let updateCount = 0;
      let bindRequestPending = false;
      const scheduled = [];
      const refs = {
        notificationTelegramBotToken: { value: "old-token" },
        telegramBindCodeBtn: { disabled: false, textContent: "" }
      };
      const window = {
        alert() {},
        clearTimeout() {},
        setTimeout(callback, delay) {
          scheduled.push({ callback, delay });
          return ++nextTimerId;
        }
      };
      const t = (key) => key;
      const request = (path) => new Promise((resolve) => {
        if (path === "/api/config") resolvePollRequest = resolve;
        else {
          bindRequestPending = true;
          resolveBindRequest = resolve;
        }
      });
      const syncTelegramSettingsFromConfig = () => { syncCount += 1; return false; };
      const renderTelegramBindStatus = () => { renderCount += 1; };
      const renderTelegramBindCommand = () => { renderCount += 1; };
      const updateSaveAvailability = () => { updateCount += 1; };
      const syncTelegramBindActionButton = () => {};
      ${extractFunctionSource(app, "stopTelegramBindPolling")}
      ${extractFunctionSource(app, "startTelegramBindPolling")}
      ${`async ${extractFunctionSource(app, "generateTelegramBindCode")}`}

      globalThis.done = (async () => {
        startTelegramBindPolling(new Date(Date.now() + 60_000).toISOString());
        const firstPoll = scheduled.shift().callback();
        await Promise.resolve();
        stopTelegramBindPolling();
        resolvePollRequest({ settings: { notificationTelegramChatId: "12345" } });
        await firstPoll;
        const afterStoppedPoll = {
          syncCount,
          scheduledCount: scheduled.length,
          pollVersion: telegramBindPollVersion
        };

        const binding = generateTelegramBindCode();
        await Promise.resolve();
        refs.notificationTelegramBotToken.value = "new-token";
        stopTelegramBindPolling();
        resolveBindRequest({
          config: { settings: { notificationTelegramBotToken: "old-token", notificationTelegramChatId: "12345" } },
          command: "/bind stale",
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        });
        await binding;
        globalThis.result = {
          afterStoppedPoll,
          bindRequestPending,
          token: refs.notificationTelegramBotToken.value,
          stateToken: state.settings.notificationTelegramBotToken,
          renderCount,
          updateCount,
          scheduledCount: scheduled.length
        };
      })();
    `).runInContext(context);

    await sandbox.done;
    expect(sandbox.result).toEqual({
      afterStoppedPoll: { syncCount: 0, scheduledCount: 0, pollVersion: 2 },
      bindRequestPending: true,
      token: "new-token",
      stateToken: "old-token",
      renderCount: 0,
      updateCount: 0,
      scheduledCount: 0
    });
  });

  it("keeps target tabs roving-focus keyboard accessible", () => {
    const app = readPublicFile("app.js");
    const sandbox: { result?: unknown } = {};
    const context = createContext(sandbox);

    new Script(`
      const makeClassList = () => {
        const values = new Set();
        return {
          toggle(name, force) { force ? values.add(name) : values.delete(name); },
          contains(name) { return values.has(name); }
        };
      };
      const tablist = { querySelectorAll: () => tabs };
      const tabs = ["general", "dns", "rules"].map((name) => ({
        name,
        tabIndex: -1,
        attrs: {},
        focused: false,
        classList: makeClassList(),
        getAttribute(attribute) { return attribute === "data-clash-tab" ? this.name : null; },
        setAttribute(attribute, value) { this.attrs[attribute] = value; },
        closest() { return tablist; },
        focus() { this.focused = true; }
      }));
      const panels = ["general", "dns", "rules"].map((name) => ({
        name,
        attrs: {},
        classList: makeClassList(),
        getAttribute(attribute) { return attribute === "data-clash-panel" ? this.name : null; },
        setAttribute(attribute, value) { this.attrs[attribute] = value; }
      }));
      const document = {
        querySelectorAll(selector) { return selector.includes("-tab]") ? tabs : panels; }
      };
      ${extractFunctionSource(app, "syncSectionTabs")}
      const showSurgeTab = (name) => syncSectionTabs("surge", name);
      const showClashTab = (name) => syncSectionTabs("clash", name);
      const showStashTab = (name) => syncSectionTabs("stash", name);
      ${extractFunctionSource(app, "handleSectionTabKeydown")}

      syncSectionTabs("clash", "general");
      const event = {
        key: "ArrowRight",
        currentTarget: tabs[0],
        prevented: false,
        preventDefault() { this.prevented = true; }
      };
      handleSectionTabKeydown(event, "clash");
      globalThis.result = {
        prevented: event.prevented,
        tabs: tabs.map((tab) => ({ selected: tab.attrs["aria-selected"], tabIndex: tab.tabIndex, focused: tab.focused })),
        panels: panels.map((panel) => ({ hidden: panel.classList.contains("hidden"), ariaHidden: panel.attrs["aria-hidden"] }))
      };
    `).runInContext(context);

    expect(sandbox.result).toEqual({
      prevented: true,
      tabs: [
        { selected: "false", tabIndex: -1, focused: false },
        { selected: "true", tabIndex: 0, focused: true },
        { selected: "false", tabIndex: -1, focused: false }
      ],
      panels: [
        { hidden: true, ariaHidden: "true" },
        { hidden: false, ariaHidden: "false" },
        { hidden: true, ariaHidden: "true" }
      ]
    });
  });

  it("only links trusted HTTPS GitHub releases", () => {
    const app = readPublicFile("app.js");
    const sandbox: { result?: unknown; URL: typeof URL } = { URL };
    const context = createContext(sandbox);

    new Script(`
      ${extractFunctionSource(app, "trustedGithubReleaseUrl")}
      globalThis.result = {
        trusted: trustedGithubReleaseUrl("https://github.com/example/subpilot/releases/tag/v1.2.3"),
        insecure: trustedGithubReleaseUrl("http://github.com/example/subpilot/releases/tag/v1.2.3"),
        subdomain: trustedGithubReleaseUrl("https://github.com.evil.example/release"),
        differentHost: trustedGithubReleaseUrl("https://example.com/release"),
        invalid: trustedGithubReleaseUrl("not a URL")
      };
    `).runInContext(context);

    expect(sandbox.result).toEqual({
      trusted: "https://github.com/example/subpilot/releases/tag/v1.2.3",
      insecure: "",
      subdomain: "",
      differentHost: "",
      invalid: ""
    });
  });

  it("confirms and interlocks read-token rotation while surfacing failures", async () => {
    const app = readPublicFile("app.js");
    const sandbox: { done?: Promise<void>; result?: unknown } = {};
    const context = createContext(sandbox);
    const rotateToken = `async ${extractFunctionSource(app, "rotateToken")}`;

    new Script(`
      const makeClassList = () => {
        const values = new Set();
        return {
          toggle(name, force) { force ? values.add(name) : values.delete(name); },
          contains(name) { return values.has(name); }
        };
      };
      const refs = {
        rotateTokenBtn: {
          disabled: false,
          textContent: "",
          attrs: {},
          setAttribute(name, value) { this.attrs[name] = value; }
        },
        tokenRotationStatus: {
          textContent: "",
          attrs: {},
          classList: makeClassList(),
          setAttribute(name, value) { this.attrs[name] = value; }
        }
      };
      let rotateTokenInFlight = false;
      let configSaveInFlight = false;
      let logoutInFlight = false;
      let clientSessionVersion = 0;
      let state = { settings: { managedBaseUrl: "https://example.com/sync" } };
      let currentReadToken = "old-token";
      let confirmAllowed = false;
      let confirmCount = 0;
      let requestCount = 0;
      let renderLinksCount = 0;
      let shouldFail = false;
      const window = { confirm() { confirmCount += 1; return confirmAllowed; } };
      const t = (key) => key;
      const syncLogoutButtonState = () => {};
      const renderLinks = () => { renderLinksCount += 1; };
      const request = async () => {
        requestCount += 1;
        await Promise.resolve();
        if (shouldFail) throw new Error("boom");
        return { token: "new-token" };
      };
      ${extractFunctionSource(app, "renderTokenRotationStatus")}
      ${rotateToken}

      globalThis.done = (async () => {
        await rotateToken();
        const canceledRequestCount = requestCount;
        confirmAllowed = true;
        const first = rotateToken();
        const second = rotateToken();
        await Promise.all([first, second]);
        const success = {
          requestCount,
          token: currentReadToken,
          renderLinksCount,
          status: refs.tokenRotationStatus.textContent,
          buttonDisabled: refs.rotateTokenBtn.disabled,
          buttonBusy: refs.rotateTokenBtn.attrs["aria-busy"]
        };
        shouldFail = true;
        await rotateToken();
        globalThis.result = {
          canceledRequestCount,
          confirmCount,
          success,
          failure: {
            requestCount,
            status: refs.tokenRotationStatus.textContent,
            role: refs.tokenRotationStatus.attrs.role,
            buttonDisabled: refs.rotateTokenBtn.disabled,
            buttonBusy: refs.rotateTokenBtn.attrs["aria-busy"]
          }
        };
      })();
    `).runInContext(context);
    await sandbox.done;

    expect(sandbox.result).toEqual({
      canceledRequestCount: 0,
      confirmCount: 3,
      success: {
        requestCount: 1,
        token: "new-token",
        renderLinksCount: 1,
        status: "rotateReadTokenSuccess",
        buttonDisabled: false,
        buttonBusy: "false"
      },
      failure: {
        requestCount: 2,
        status: "rotateReadTokenFailedboom",
        role: "alert",
        buttonDisabled: false,
        buttonBusy: "false"
      }
    });
  });

  it("round-trips structured single rules for the unified rule set editor", () => {
    const app = readPublicFile("app.js");
    const sandbox: { result?: unknown } = {};
    const context = createContext(sandbox);
    const functions = [
      "splitSurgeRuleLine",
      "normalizeRuleSetOptionList",
      "parseRuleSetDirectRule",
      "buildRuleSetDirectRuleLine"
    ].map((name) => extractFunctionSource(app, name)).join("\n");

    new Script(`${functions}
      globalThis.result = {
        parsed: parseRuleSetDirectRule({ rule: "IP-CIDR,10.0.0.0/8,Proxy,no-resolve" }),
        rebuilt: buildRuleSetDirectRuleLine("IP-CIDR", "10.0.0.0/8", "Proxy", "no-resolve"),
        final: buildRuleSetDirectRuleLine("FINAL", "ignored", "Proxy", "dns-failed")
      };
    `).runInContext(context);

    expect(sandbox.result).toEqual({
      parsed: { ruleType: "IP-CIDR", value: "10.0.0.0/8", options: "no-resolve" },
      rebuilt: "IP-CIDR,10.0.0.0/8,Proxy,no-resolve",
      final: "FINAL,Proxy,dns-failed"
    });
  });

  it("groups preview coverage warnings into expandable summaries", () => {
    const app = readPublicFile("app-preview-warnings.js");
    const sandbox: {
      result?: Array<{ summary: string; details: string[] }>;
      simplified?: string;
      URL: typeof URL;
    } = { URL };
    const context = createContext(sandbox);
    const functions = [
      "groupPreviewWarnings",
      "prioritizePreviewWarningGroups",
      "isPreviewRedundantWarningGroup",
      "isPreviewOverflowWarningGroup",
      "parsePreviewCoverageWarning",
      "summarizeCoverageLabel",
      "formatPreviewCoverageSummary",
      "simplifyPreviewRuleSetNames",
      "formatRuleSetDisplayName"
    ].map((name) => extractFunctionSource(app, name)).join("\n");
    const warnings = [
      "Surge Rule 第 4 行规则集 https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/Advertising/Advertising.list 内第 284 行 被前面的 第 4 行规则集 https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/Advertising/Advertising.list 内第 283 行 覆盖（DOMAIN-KEYWORD,analytics 覆盖 DOMAIN-KEYWORD,app-analytics；策略同为 REJECT，当前规则冗余）。",
      "Surge Rule 第 4 行规则集 https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/Advertising/Advertising.list 内第 285 行 被前面的 第 4 行规则集 https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/Advertising/Advertising.list 内第 283 行 覆盖（DOMAIN-KEYWORD,analytics 覆盖 DOMAIN-KEYWORD,event-analytics；策略同为 REJECT，当前规则冗余）。",
      "Surge Rule 第 2 行 被前面的 第 1 行 覆盖（DOMAIN-SUFFIX,example.com 覆盖 DOMAIN,www.example.com；DIRECT 会优先生效，Proxy 不会生效）。",
      "Surge Rule 覆盖诊断还有 2 条提示未显示。"
    ];

    new Script(`${functions}\nglobalThis.result = groupPreviewWarnings(${JSON.stringify(warnings)});`).runInContext(context);

    expect(sandbox.result).toEqual([
      {
        summary: "Surge Rule 第 2 行 有部分规则被前面的第 1 行覆盖（DIRECT 会优先生效，Proxy 不会生效）。",
        details: [warnings[2]]
      },
      {
        summary: "Surge Rule 第 4 行规则集 Advertising.list 有部分规则被同一规则集内前面的规则覆盖，共 2 条（策略同为 REJECT，当前规则冗余）。",
        details: [warnings[0], warnings[1]]
      },
      {
        summary: warnings[3],
        details: []
      }
    ]);

    new Script(`globalThis.simplified = simplifyPreviewRuleSetNames(${JSON.stringify(warnings[0])});`).runInContext(context);

    expect(sandbox.simplified).toContain("规则集 Advertising.list 内第 284 行");
    expect(sandbox.simplified).not.toContain("raw.githubusercontent.com");
  });

  it("accepts Surge proxy node drafts with keyed params after port", () => {
    const constants = readPublicFile("app-constants.js");
    const drafts = readPublicFile("app-proxy-node-drafts.js");
    const sandbox: {
      result?: Array<{ valid: boolean; name: string }>;
    } = {};
    const context = createContext(sandbox);
    const uriPattern = constants.match(/export const PROXY_NODE_URI_PATTERN = [^;]+;/)?.[0]?.replace(/^export /, "");
    if (!uriPattern) throw new Error("PROXY_NODE_URI_PATTERN not found");
    const functions = [
      uriPattern,
      "splitProxyNodeSurgeConfig",
      "parseProxyNodeConfigDraft",
      "parseSurgeProxyNodeDraft",
      "readProxyNodeYamlScalar",
      "parseClashProxyNodeDraft"
    ].map((item) => item.startsWith("const ") ? item : extractFunctionSource(drafts, item)).join("\n");
    const lines = [
      "Chain Exit = socks5, 207.97.145.15, 443, username=ed221103117, password=sxVQPhwY",
      "DMIT = snell, 191.223.220.184, 42821, psk=7aa28cb89c5e5ca38b3bb8c0a30079035525c00175891727, version=6, mode=default, reuse=true, tfo=true"
    ];

    new Script(`${functions}\nglobalThis.result = ${JSON.stringify(lines)}.map(parseProxyNodeConfigDraft);`).runInContext(context);

    expect(sandbox.result).toEqual([
      { valid: true, name: "Chain Exit" },
      { valid: true, name: "DMIT" }
    ]);
  });
});
