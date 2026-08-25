import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/default-config";
import { collectSurgeRuleCoverageWarnings, validateSurgeRules } from "../src/surge-rules";
import { restoreMocksAfterEach } from "./helpers/fetch";

restoreMocksAfterEach();

describe("Surge rule validation", () => {
  it("accepts IP-ASN rules with the IP-only no-resolve option", () => {
    expect(validateSurgeRules({
      ...DEFAULT_CONFIG,
      surge: {
        ...DEFAULT_CONFIG.surge,
        rules: [
          "IP-ASN,13335,Proxy",
          "IP-ASN,15169,DIRECT,no-resolve",
          "FINAL,Proxy"
        ]
      }
    })).toBeNull();
  });

  it("rejects unsupported IP-ASN options without relaxing other rule types", () => {
    expect(validateSurgeRules({
      ...DEFAULT_CONFIG,
      surge: {
        ...DEFAULT_CONFIG.surge,
        rules: [
          "IP-ASN,13335,Proxy,extended-matching",
          "FINAL,Proxy"
        ]
      }
    })).toContain("附加参数 extended-matching 不适用于 IP-ASN");

    expect(validateSurgeRules({
      ...DEFAULT_CONFIG,
      surge: {
        ...DEFAULT_CONFIG.surge,
        rules: [
          "PROCESS-NAME,Example,Proxy,no-resolve",
          "FINAL,Proxy"
        ]
      }
    })).toContain("附加参数 no-resolve 不适用于 PROCESS-NAME");
  });

  it("accepts strict nested logical rules and quoted commas or parentheses", () => {
    expect(validateSurgeRules({
      ...DEFAULT_CONFIG,
      surge: {
        ...DEFAULT_CONFIG.surge,
        rules: [
          'AND,((URL-REGEX,"^https://example\\.com/(foo,bar)$"),(NOT,((IP-CIDR,192.0.2.0/24,no-resolve)))),Proxy',
          "OR,((DOMAIN,a.example),(DOMAIN,b.example)),DIRECT",
          "FINAL,Proxy"
        ]
      }
    })).toBeNull();
  });

  it.each([
    "AND,((DOMAIN,a.example)),Proxy",
    "OR,((DOMAIN,a.example)),Proxy",
    "NOT,((DOMAIN,a.example),(DOMAIN,b.example)),Proxy",
    "AND,((DOMAIN,a.example,Proxy),(DOMAIN,b.example)),Proxy",
    "AND,((DOMAIN,a.example),,(DOMAIN,b.example)),Proxy",
    "AND,((DOMAIN,a.example),(DOMAIN,b.example))),Proxy",
    "AND,((DOMAIN,a.example),(DOMAIN,b.example))tail,Proxy",
    "AND,((BOGUS,value),(DOMAIN,b.example)),Proxy",
    "AND,((DOMAIN),(DOMAIN,b.example)),Proxy",
    'AND,((URL-REGEX,"unterminated),(DOMAIN,b.example)),Proxy'
  ])("rejects malformed logical rule %s", (rule) => {
    expect(validateSurgeRules({
      ...DEFAULT_CONFIG,
      surge: {
        ...DEFAULT_CONFIG.surge,
        rules: [rule, "FINAL,Proxy"]
      }
    })).not.toBeNull();
  });
});

describe("Surge rule coverage diagnostics", () => {
  it("reports later domain and IP rules covered by earlier broader rules", async () => {
    const warnings = await collectSurgeRuleCoverageWarnings({
      ...DEFAULT_CONFIG,
      surge: {
        ...DEFAULT_CONFIG.surge,
        rules: [
          "DOMAIN-SUFFIX,example.com,DIRECT",
          "DOMAIN,www.example.com,Proxy",
          "IP-CIDR,10.0.0.0/8,DIRECT",
          "IP-CIDR,10.1.2.0/24,Proxy",
          "FINAL,Proxy"
        ]
      }
    }, { includeExternalRuleSets: false });

    expect(warnings).toContain("Surge Rule 第 2 行 被前面的 第 1 行 覆盖（DOMAIN-SUFFIX,example.com 覆盖 DOMAIN,www.example.com；DIRECT 会优先生效，Proxy 不会生效）。");
    expect(warnings).toContain("Surge Rule 第 4 行 被前面的 第 3 行 覆盖（IP-CIDR,10.0.0.0/8 覆盖 IP-CIDR,10.1.2.0/24；DIRECT 会优先生效，Proxy 不会生效）。");
  });

  it("expands external RULE-SET contents before checking coverage", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response([
      "DOMAIN,www.example.com",
      "DOMAIN-SUFFIX,api.example.com",
      "IP-CIDR,10.1.2.0/24"
    ].join("\n")));

    const warnings = await collectSurgeRuleCoverageWarnings({
      ...DEFAULT_CONFIG,
      surge: {
        ...DEFAULT_CONFIG.surge,
        rules: [
          "DOMAIN-SUFFIX,example.com,DIRECT",
          "IP-CIDR,10.0.0.0/8,DIRECT",
          "RULE-SET,https://rules.example.com/demo.list,Proxy",
          "FINAL,Proxy"
        ]
      }
    });

    expect(fetchMock).toHaveBeenCalledWith("https://rules.example.com/demo.list", expect.objectContaining({
      headers: { "user-agent": DEFAULT_CONFIG.settings.userAgentSurge },
      signal: expect.any(AbortSignal)
    }));
    expect(warnings).toContain("Surge Rule 第 3 行规则集 https://rules.example.com/demo.list 内第 1 行 被前面的 第 1 行 覆盖（DOMAIN-SUFFIX,example.com 覆盖 DOMAIN,www.example.com；DIRECT 会优先生效，Proxy 不会生效）。");
    expect(warnings).toContain("Surge Rule 第 3 行规则集 https://rules.example.com/demo.list 内第 2 行 被前面的 第 1 行 覆盖（DOMAIN-SUFFIX,example.com 覆盖 DOMAIN-SUFFIX,api.example.com；DIRECT 会优先生效，Proxy 不会生效）。");
    expect(warnings).toContain("Surge Rule 第 3 行规则集 https://rules.example.com/demo.list 内第 3 行 被前面的 第 2 行 覆盖（IP-CIDR,10.0.0.0/8 覆盖 IP-CIDR,10.1.2.0/24；DIRECT 会优先生效，Proxy 不会生效）。");
  });

  it("expands DOMAIN-SET host entries as exact and suffix domain rules", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response([
      "+.example.com",
      "static.example.net"
    ].join("\n")));

    const warnings = await collectSurgeRuleCoverageWarnings({
      ...DEFAULT_CONFIG,
      surge: {
        ...DEFAULT_CONFIG.surge,
        rules: [
          "DOMAIN-KEYWORD,example,DIRECT",
          "DOMAIN-SET,https://rules.example.com/domains.list,Proxy",
          "FINAL,Proxy"
        ]
      }
    });

    expect(warnings).toContain("Surge Rule 第 2 行规则集 https://rules.example.com/domains.list 内第 1 行 被前面的 第 1 行 覆盖（DOMAIN-KEYWORD,example 覆盖 DOMAIN-SUFFIX,example.com；DIRECT 会优先生效，Proxy 不会生效）。");
    expect(warnings).toContain("Surge Rule 第 2 行规则集 https://rules.example.com/domains.list 内第 2 行 被前面的 第 1 行 覆盖（DOMAIN-KEYWORD,example 覆盖 DOMAIN,static.example.net；DIRECT 会优先生效，Proxy 不会生效）。");
  });

  it("caps coverage diagnostics with a hidden warning summary", async () => {
    const warnings = await collectSurgeRuleCoverageWarnings({
      ...DEFAULT_CONFIG,
      surge: {
        ...DEFAULT_CONFIG.surge,
        rules: [
          "DOMAIN-SUFFIX,example.com,DIRECT",
          "DOMAIN,a.example.com,Proxy",
          "DOMAIN,b.example.com,Proxy",
          "DOMAIN,c.example.com,Proxy",
          "FINAL,Proxy"
        ]
      }
    }, { includeExternalRuleSets: false, maxWarnings: 2 });

    expect(warnings).toEqual([
      "Surge Rule 第 2 行 被前面的 第 1 行 覆盖（DOMAIN-SUFFIX,example.com 覆盖 DOMAIN,a.example.com；DIRECT 会优先生效，Proxy 不会生效）。",
      "Surge Rule 覆盖诊断还有 2 条提示未显示。"
    ]);
  });

  it("reports unresolved Surge-maintained internal rule sets clearly", async () => {
    const warnings = await collectSurgeRuleCoverageWarnings({
      ...DEFAULT_CONFIG,
      surge: {
        ...DEFAULT_CONFIG.surge,
        rules: [
          "RULE-SET,SYSTEM,DIRECT",
          "FINAL,Proxy"
        ]
      }
    });

    expect(warnings).toEqual(["第 1 行内置规则集 SYSTEM 内容由 Surge 版本维护，未参与覆盖检查。"]);
  });
});
