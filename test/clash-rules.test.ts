import { describe, expect, it, vi } from "vitest";
import { collectClashRuleCoverageWarnings } from "../src/clash-rules";
import { DEFAULT_CONFIG } from "../src/default-config";
import { restoreMocksAfterEach } from "./helpers/fetch";

restoreMocksAfterEach();

describe("Clash and Stash rule coverage diagnostics", () => {
  it("reports later Clash domain and IP rules covered by earlier broader rules", async () => {
    const warnings = await collectClashRuleCoverageWarnings({
      ...DEFAULT_CONFIG,
      clash: {
        ...DEFAULT_CONFIG.clash,
        ruleProviders: "",
        rules: [
          "DOMAIN-SUFFIX,example.com,DIRECT",
          "DOMAIN,www.example.com,Proxy",
          "IP-CIDR,10.0.0.0/8,DIRECT",
          "IP-CIDR,10.1.2.0/24,Proxy",
          "MATCH,Proxy"
        ]
      }
    }, "clash");

    expect(warnings).toContain("Clash Rule 第 2 行 被前面的 第 1 行 覆盖（DOMAIN-SUFFIX,example.com 覆盖 DOMAIN,www.example.com；DIRECT 会优先生效，Proxy 不会生效）。");
    expect(warnings).toContain("Clash Rule 第 4 行 被前面的 第 3 行 覆盖（IP-CIDR,10.0.0.0/8 覆盖 IP-CIDR,10.1.2.0/24；DIRECT 会优先生效，Proxy 不会生效）。");
  });

  it("expands Clash classical rule providers before checking coverage", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response([
      "payload:",
      "  - DOMAIN,www.example.com",
      "  - DOMAIN-SUFFIX,api.example.com",
      "  - IP-CIDR,10.1.2.0/24"
    ].join("\n")));

    const warnings = await collectClashRuleCoverageWarnings({
      ...DEFAULT_CONFIG,
      clash: {
        ...DEFAULT_CONFIG.clash,
        ruleProviders: [
          "rule-providers:",
          "  Demo:",
          "    type: http",
          "    behavior: classical",
          "    url: https://rules.example.com/demo.yaml"
        ].join("\n"),
        rules: [
          "DOMAIN-SUFFIX,example.com,DIRECT",
          "IP-CIDR,10.0.0.0/8,DIRECT",
          "RULE-SET,Demo,Proxy",
          "MATCH,Proxy"
        ]
      }
    }, "clash");

    expect(fetchMock).toHaveBeenCalledWith("https://rules.example.com/demo.yaml", expect.objectContaining({
      headers: { "user-agent": DEFAULT_CONFIG.settings.userAgentClash }
    }));
    expect(warnings).toContain("Clash Rule 第 3 行规则集 Demo 内第 1 行 被前面的 第 1 行 覆盖（DOMAIN-SUFFIX,example.com 覆盖 DOMAIN,www.example.com；DIRECT 会优先生效，Proxy 不会生效）。");
    expect(warnings).toContain("Clash Rule 第 3 行规则集 Demo 内第 3 行 被前面的 第 2 行 覆盖（IP-CIDR,10.0.0.0/8 覆盖 IP-CIDR,10.1.2.0/24；DIRECT 会优先生效，Proxy 不会生效）。");
  });

  it("expands Clash domain and ipcidr providers by behavior", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url) === "https://rules.example.com/domains.yaml") {
        return new Response([
          "payload:",
          "  - '+.example.com'",
          "  - static.example.net"
        ].join("\n"));
      }
      if (String(url) === "https://rules.example.com/ip.yaml") {
        return new Response([
          "payload:",
          "  - 10.1.2.0/24",
          "  - 2001:db8:1::/48"
        ].join("\n"));
      }
      return new Response("not found", { status: 404 });
    });

    const warnings = await collectClashRuleCoverageWarnings({
      ...DEFAULT_CONFIG,
      clash: {
        ...DEFAULT_CONFIG.clash,
        ruleProviders: [
          "rule-providers:",
          "  Domains:",
          "    type: http",
          "    behavior: domain",
          "    url: https://rules.example.com/domains.yaml",
          "  Ips:",
          "    type: http",
          "    behavior: ipcidr",
          "    url: https://rules.example.com/ip.yaml"
        ].join("\n"),
        rules: [
          "DOMAIN-KEYWORD,example,DIRECT",
          "IP-CIDR,10.0.0.0/8,DIRECT",
          "IP-CIDR6,2001:db8::/32,DIRECT",
          "RULE-SET,Domains,Proxy",
          "RULE-SET,Ips,Proxy",
          "MATCH,Proxy"
        ]
      }
    }, "clash");

    expect(warnings).toContain("Clash Rule 第 4 行规则集 Domains 内第 1 行 被前面的 第 1 行 覆盖（DOMAIN-KEYWORD,example 覆盖 DOMAIN-SUFFIX,example.com；DIRECT 会优先生效，Proxy 不会生效）。");
    expect(warnings).toContain("Clash Rule 第 5 行规则集 Ips 内第 1 行 被前面的 第 2 行 覆盖（IP-CIDR,10.0.0.0/8 覆盖 IP-CIDR,10.1.2.0/24；DIRECT 会优先生效，Proxy 不会生效）。");
    expect(warnings).toContain("Clash Rule 第 5 行规则集 Ips 内第 2 行 被前面的 第 3 行 覆盖（IP-CIDR6,2001:db8::/32 覆盖 IP-CIDR6,2001:db8:1::/48；DIRECT 会优先生效，Proxy 不会生效）。");
  });

  it("checks Stash rules with the same provider semantics", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response([
      "payload:",
      "  - '+.example.com'"
    ].join("\n")));

    const warnings = await collectClashRuleCoverageWarnings({
      ...DEFAULT_CONFIG,
      stash: {
        ...DEFAULT_CONFIG.stash,
        ruleProviders: [
          "rule-providers:",
          "  Domains:",
          "    type: http",
          "    behavior: domain",
          "    url: https://rules.example.com/domains.yaml"
        ].join("\n"),
        rules: [
          "DOMAIN-SUFFIX,example.com,DIRECT",
          "RULE-SET,Domains,Proxy",
          "MATCH,Proxy"
        ]
      }
    }, "stash");

    expect(warnings).toEqual([
      "Stash Rule 第 2 行规则集 Domains 内第 1 行 被前面的 第 1 行 覆盖（DOMAIN-SUFFIX,example.com 覆盖 DOMAIN-SUFFIX,example.com；DIRECT 会优先生效，Proxy 不会生效）。"
    ]);
  });

  it("checks generated fallback provider rules inserted before MATCH", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response([
      "payload:",
      "  - DOMAIN,www.example.com"
    ].join("\n")));

    const warnings = await collectClashRuleCoverageWarnings({
      ...DEFAULT_CONFIG,
      clash: {
        ...DEFAULT_CONFIG.clash,
        ruleProviders: [
          "rule-providers:",
          "  MissingFromRules:",
          "    type: http",
          "    behavior: classical",
          "    url: https://rules.example.com/missing.yaml"
        ].join("\n"),
        rules: [
          "DOMAIN-SUFFIX,example.com,DIRECT",
          "MATCH,Proxy"
        ]
      }
    }, "clash");

    expect(warnings).toContain("Clash Rule 第 2 行规则集 MissingFromRules 内第 1 行 被前面的 第 1 行 覆盖（DOMAIN-SUFFIX,example.com 覆盖 DOMAIN,www.example.com；DIRECT 会优先生效，Proxy 不会生效）。");
  });
});
