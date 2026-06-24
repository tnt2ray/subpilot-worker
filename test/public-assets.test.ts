import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

function readPublicFile(name: string): string {
  return readFileSync(join(root, "public", name), "utf8");
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
});
