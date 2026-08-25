import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { parseRuleSetContent } from "../src/rule-set-parser";
import { renderCombinedRuleSet, renderCompiledRuleSetBucket } from "../src/rule-set-renderer";
import type { RuleSetSourceFormat } from "../src/rule-set-types";

describe("rule set domain parsing", () => {
  it.each([
    ["auto", domainEntries().join("\n")],
    ["plain-domain", domainEntries().join("\n")],
    ["clash-yaml", YAML.stringify({ behavior: "domain", payload: domainEntries() })]
  ] satisfies Array<[RuleSetSourceFormat, string]>)(
    "preserves distinct Clash domain-provider patterns for %s",
    (format, content) => {
      const result = parseRuleSetContent(content, format, "Domains");

      expect(result.warnings).toEqual([]);
      expect(result.rules.map((rule) => [rule.type, rule.clashDomainPattern, rule.raw])).toEqual([
        ["DOMAIN", undefined, "DOMAIN,example.com"],
        ["DOMAIN-REGEX", ".example.com", "DOMAIN-REGEX,^([^.]+\\.)+example\\.com$"],
        ["DOMAIN-SUFFIX", undefined, "DOMAIN-SUFFIX,example.com"],
        ["DOMAIN-REGEX", "*.example.com", "DOMAIN-REGEX,^[^.]+\\.example\\.com$"]
      ]);
      expect(new Set(result.rules.map((rule) => rule.normalizedKey)).size).toBe(4);
    }
  );

  it("keeps Surge DOMAIN-SET leading-dot suffix semantics without widening Clash wildcards", () => {
    const parsed = parseRuleSetContent(domainEntries().join("\n"), "surge-domain-set", "Domains");

    expect(parsed.rules.map((rule) => [rule.type, rule.clashDomainPattern])).toEqual([
      ["DOMAIN", undefined],
      ["DOMAIN-SUFFIX", undefined],
      ["DOMAIN-SUFFIX", undefined],
      ["DOMAIN-REGEX", "*.example.com"]
    ]);
    expect(parsed.rules[1]?.normalizedKey).toBe(parsed.rules[2]?.normalizedKey);
  });

  it("renders Clash patterns natively and safely filters non-equivalent Surge entries", () => {
    const parsed = parseRuleSetContent(
      YAML.stringify({ behavior: "domain", payload: domainEntries() }),
      "clash-yaml",
      "Domains"
    );

    expect(renderCompiledRuleSetBucket(parsed.rules, "domain", "surge")).toBe("example.com\n.example.com\n");
    expect(YAML.parse(renderCompiledRuleSetBucket(parsed.rules, "domain", "clash"))).toEqual({
      payload: ["example.com", ".example.com", "+.example.com", "*.example.com"]
    });
    expect(YAML.parse(renderCompiledRuleSetBucket(parsed.rules, "domain", "stash"))).toEqual({
      payload: ["example.com", ".example.com", "+.example.com", "*.example.com"]
    });
    expect(renderCombinedRuleSet({ domain: parsed.rules, ipcidr: [], classical: [] }, "surge", {
      includesDomains: true,
      includesIpCidr: false
    })).toBe("DOMAIN,example.com\nDOMAIN-SUFFIX,example.com\n");
    expect(YAML.parse(renderCombinedRuleSet({ domain: parsed.rules, ipcidr: [], classical: [] }, "stash", {
      includesDomains: true,
      includesIpCidr: false
    }))).toEqual({
      payload: [
        "DOMAIN,example.com",
        "DOMAIN-REGEX,^([^.]+\\.)+example\\.com$",
        "DOMAIN-SUFFIX,example.com",
        "DOMAIN-REGEX,^[^.]+\\.example\\.com$"
      ]
    });
  });

  it("compiles Clash wildcard labels to exact classical regex semantics", () => {
    const parsed = parseRuleSetContent(
      YAML.stringify({ behavior: "domain", payload: [".example.com", "*.example.com", "*.*.microsoft.com"] }),
      "clash-yaml",
      "Domains"
    );
    const [subdomains, oneLabel, twoLabels] = parsed.rules.map((rule) => new RegExp(rule.value));

    expect(subdomains!.test("example.com")).toBe(false);
    expect(subdomains!.test("a.example.com")).toBe(true);
    expect(subdomains!.test("a.b.example.com")).toBe(true);
    expect(oneLabel!.test("a.example.com")).toBe(true);
    expect(oneLabel!.test("a.b.example.com")).toBe(false);
    expect(twoLabels!.test("a.b.microsoft.com")).toBe(true);
    expect(twoLabels!.test("a.microsoft.com")).toBe(false);
    expect(twoLabels!.test("a.b.c.microsoft.com")).toBe(false);
  });

  it("keeps case-sensitive classical values distinct", () => {
    const parsed = parseRuleSetContent([
      "URL-REGEX,^https://example.com/API",
      "URL-REGEX,^https://example.com/api",
      "PROCESS-PATH,/Applications/Example.app",
      "PROCESS-PATH,/applications/example.app"
    ].join("\n"), "plain-classical", "Classical");

    expect(new Set(parsed.rules.map((rule) => rule.normalizedKey)).size).toBe(4);
  });

  it("preserves IP source options and filters src only for non-Clash targets", () => {
    const parsed = parseRuleSetContent([
      "IP-ASN,13335,no-resolve",
      "IP-CIDR,192.0.2.0/24,src",
      "IP-CIDR6,2001:db8::/32,src,no-resolve",
      "IP-CIDR,203.0.113.0/24,Proxy,no-resolve"
    ].join("\n"), "surge-rule-set", "IP rules");

    expect(parsed.warnings).toEqual([]);
    expect(parsed.rules.map((rule) => [rule.raw, rule.bucket])).toEqual([
      ["IP-ASN,13335,no-resolve", "classical"],
      ["IP-CIDR,192.0.2.0/24,src", "classical"],
      ["IP-CIDR6,2001:db8::/32,src,no-resolve", "classical"],
      ["IP-CIDR,203.0.113.0/24,no-resolve", "ipcidr"]
    ]);

    const buckets = {
      domain: parsed.rules.filter((rule) => rule.bucket === "domain"),
      ipcidr: parsed.rules.filter((rule) => rule.bucket === "ipcidr"),
      classical: parsed.rules.filter((rule) => rule.bucket === "classical")
    };
    const options = { includesDomains: true, includesIpCidr: true };
    const clash = YAML.parse(renderCombinedRuleSet(buckets, "clash", options)) as { payload: string[] };
    const stash = YAML.parse(renderCombinedRuleSet(buckets, "stash", options)) as { payload: string[] };
    const surge = renderCombinedRuleSet(buckets, "surge", options);

    expect(clash.payload).toContain("IP-CIDR,192.0.2.0/24,src");
    expect(clash.payload).toContain("IP-CIDR6,2001:db8::/32,src,no-resolve");
    expect(stash.payload).toContain("IP-CIDR,192.0.2.0/24");
    expect(stash.payload).toContain("IP-CIDR6,2001:db8::/32,no-resolve");
    expect(stash.payload.join("\n")).not.toContain(",src");
    expect(surge).toContain("IP-CIDR,192.0.2.0/24\n");
    expect(surge).toContain("IP-CIDR6,2001:db8::/32,no-resolve\n");
    expect(surge).not.toContain(",src");
  });

  it("rejects malformed IPv4 and IPv6 CIDR values", () => {
    const parsed = parseRuleSetContent([
      "999.999.999.999/99",
      "2001:db8::/999",
      "2001:::1/64",
      "IP-CIDR,192.0.2.999/24",
      "IP-CIDR6,2001:db8::1/129",
      "IP-CIDR,2001:db8::/32",
      "IP-CIDR6,192.0.2.0/24",
      "192.0.2.1/32",
      "2001:db8::/32",
      "::ffff:192.0.2.1/128",
      "1:2:3:4:5:6:7:8/64"
    ].join("\n"), "plain-classical", "CIDR rules");

    expect(parsed.rules.map((rule) => [rule.type, rule.value])).toEqual([
      ["IP-CIDR", "192.0.2.1/32"],
      ["IP-CIDR6", "2001:db8::/32"],
      ["IP-CIDR6", "::ffff:192.0.2.1/128"],
      ["IP-CIDR6", "1:2:3:4:5:6:7:8/64"]
    ]);
    expect(parsed.warnings).toHaveLength(7);
    expect(parsed.warnings.every((warning) => warning.includes("无法识别") || warning.includes("无效的 CIDR"))).toBe(true);
  });
});

function domainEntries(): string[] {
  return ["Example.COM.", ".Example.COM.", "+.Example.COM.", "*.Example.COM."];
}
