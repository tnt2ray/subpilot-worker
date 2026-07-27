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
    expect(html.match(/role="tabpanel"/g)).toHaveLength(3);
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
    expect(app).toContain("buildUnifiedCommonPatch(common, ensureRuleSets())");
    expect(app).not.toContain("validateUnifiedConfig");
    expect(app).toContain('render({ preserveUnifiedCommonDraft: page !== "unified-config" })');
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
