import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

function readPublicFile(name: string): string {
  return readFileSync(join(root, "public", name), "utf8");
}

function extractFunctionSource(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`Function ${name} not found`);
  const bodyStart = source.indexOf("{", start);
  if (bodyStart < 0) throw new Error(`Function ${name} body not found`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Function ${name} body is incomplete`);
}

describe("admin static assets", () => {
  it("keeps the admin static asset contract", () => {
    const html = readPublicFile("index.html");
    const app = readPublicFile("app.js");
    const css = readPublicFile("styles.css");

    expect(html).not.toContain("/vendor/codemirror/codemirror.css");
    expect(html).not.toContain("/vendor/codemirror/codemirror.js");
    expect(app).toContain('loadStylesheet("/vendor/codemirror/codemirror.css")');
    expect(app).toContain('loadScript("/vendor/codemirror/codemirror.js")');

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
    expect(app).toContain("FETCH_RECORDS_PAGE_SIZE = 10");
    expect(app).toContain('const targets = ["surge", "clash", "stash"]');
    expect(app).toContain("renderFetchRecordRow");
    expect(app).toContain("fetchRecordsTableBody");

    expect(html).toContain('data-page="stash"');
    expect(html).toContain('id="previewStashBtn"');
    expect(html).toContain('id="stashMitmHostname"');
    expect(app).toContain('const PREVIEW_TARGETS = ["surge", "clash", "stash"]');
    expect(app).toContain('previewWarnings: "诊断提示："');
    expect(app).toContain("function renderPreviewWarnings(warnings)");
    expect(app).toContain("function groupPreviewWarnings(warnings)");
    expect(app).toContain("function prioritizePreviewWarningGroups(groups)");
    expect(app).toContain("function parsePreviewCoverageWarning(message)");
    expect(app).toContain("function formatPreviewCoverageSummary(group)");
    expect(app).toContain("function simplifyPreviewRuleSetNames(message)");
    expect(app).toContain("function formatRuleSetDisplayName(value)");
    expect(app).toContain('class="diagnostic-group warning"');
    expect(app).toContain("查看详情");
    expect(css).toContain(".validation-messages .diagnostic-group");
    expect(css).toContain(".validation-messages .diagnostic-detail-list");
    expect(css).toContain(".config-code-editor .CodeMirror-gutter.CodeMirror-linenumbers");
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
    expect(app).toContain("setDisplayTimeZoneValue");
    expect(app).toContain("normalizeDisplayTimeZone");
    expect(app).toContain("formatDateInTimeZone");

    expect(html).not.toContain('data-i18n="service"');
    expect(html).not.toContain('data-i18n="stateRunning"');
    expect(html).not.toContain('id="systemSchemaVersion"');
    expect(app).not.toContain("kvSchemaVersion");
    expect(css).toContain(".status-grid {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr);");

    expect(app).toContain("refreshStatusStatsIfVisible();");
    expect(app).toContain('statusStatsRefreshPromise = request("/api/stats")');
    expect(app).toContain('if (!state || activePage !== "status") return;');
    expect(app).toContain('renderPage("status", { force: true })');

    expect(app).toContain("function validateStashScriptLines(lines)");
    expect(app).toContain("function parseStashScriptParams(value)");
    expect(app).toContain('const validation = validateStashScriptLines(textToLines(refs.stashScripts.value));');
    expect(app).toContain('params["script-path"]');
    expect(app).toContain('type 必须是 http-request 或 http-response');
    expect(app).not.toContain("const validation = validateSurgeScriptLines(textToLines(refs.stashScripts.value));");
  });

  it("groups preview coverage warnings into expandable summaries", () => {
    const app = readPublicFile("app.js");
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
    const app = readPublicFile("app.js");
    const sandbox: {
      result?: Array<{ valid: boolean; name: string }>;
    } = {};
    const context = createContext(sandbox);
    const uriPattern = app.match(/const PROXY_NODE_URI_PATTERN = [^;]+;/)?.[0];
    if (!uriPattern) throw new Error("PROXY_NODE_URI_PATTERN not found");
    const functions = [
      uriPattern,
      "splitProxyNodeSurgeConfig",
      "parseProxyNodeConfigDraft",
      "parseSurgeProxyNodeDraft",
      "readProxyNodeYamlScalar",
      "parseClashProxyNodeDraft"
    ].map((item) => item.startsWith("const ") ? item : extractFunctionSource(app, item)).join("\n");
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
