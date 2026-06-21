import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

function readPublicFile(name: string): string {
  return readFileSync(join(root, "public", name), "utf8");
}

describe("admin static assets", () => {
  it("does not load CodeMirror on the initial HTML document", () => {
    const html = readPublicFile("index.html");
    const app = readPublicFile("app.js");

    expect(html).not.toContain("/vendor/codemirror/codemirror.css");
    expect(html).not.toContain("/vendor/codemirror/codemirror.js");
    expect(app).toContain('loadStylesheet("/vendor/codemirror/codemirror.css")');
    expect(app).toContain('loadScript("/vendor/codemirror/codemirror.js")');
  });

  it("exposes the Surge managed config interval in General settings", () => {
    const html = readPublicFile("index.html");
    const app = readPublicFile("app.js");
    const generalStart = html.indexOf('data-surge-panel="general"');
    const hostStart = html.indexOf('data-surge-panel="host"');
    const generalPanel = html.slice(generalStart, hostStart);

    expect(generalStart).toBeGreaterThan(-1);
    expect(hostStart).toBeGreaterThan(generalStart);
    expect(generalPanel).toContain('id="surgeManagedConfigIntervalSeconds"');
    expect(generalPanel).toContain('min="300" max="604800" step="60"');
    expect(generalPanel).toContain("主配置更新间隔");
    expect(app).toContain('managedConfigIntervalHelp: "写入 #!MANAGED-CONFIG 的 interval，单位秒；默认 43200（12 小时）。"');
  });

  it("labels config fetch status targets", () => {
    const html = readPublicFile("index.html");
    const app = readPublicFile("app.js");

    expect(html).toContain('id="fetchRecordsTableBody"');
    expect(html).toContain('id="fetchRecordsPagination"');
    expect(html).not.toContain('data-i18n="fetchColumnCount"');
    expect(html).toContain("配置获取记录");
    expect(app).toContain('fetchTargetSurge: "Surge 配置"');
    expect(app).toContain("FETCH_RECORDS_PAGE_SIZE = 10");
    expect(app).toContain('const targets = ["surge", "clash"]');
    expect(app).toContain("renderFetchRecordRow");
    expect(app).toContain("fetchRecordsTableBody");
  });

  it("stacks the status summary above fetch records without the service row", () => {
    const html = readPublicFile("index.html");
    const css = readPublicFile("styles.css");

    expect(html).not.toContain('data-i18n="service"');
    expect(html).not.toContain('data-i18n="stateRunning"');
    expect(css).toContain(".status-grid {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr);");
  });

  it("refreshes status stats when the status page becomes visible", () => {
    const app = readPublicFile("app.js");

    expect(app).toContain("refreshStatusStatsIfVisible();");
    expect(app).toContain('statusStatsRefreshPromise = request("/api/stats")');
    expect(app).toContain('if (!state || activePage !== "status") return;');
    expect(app).toContain('renderPage("status", { force: true })');
  });
});
