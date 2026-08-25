import { describe, expect, it } from "vitest";
import { validateClashLikeRules } from "../src/clash-rules";
import { DEFAULT_CONFIG } from "../src/default-config";
import { inferDirectRuleTargets } from "../src/rule-targets";
import { validateSurgeRules } from "../src/surge-rules";
import type { RuleSetDirectRule } from "../src/rule-set-types";
import type { AppConfig } from "../src/types";

function surgeRules(rules: string[]): ReturnType<typeof validateSurgeRules> {
  return validateSurgeRules({
    ...DEFAULT_CONFIG,
    surge: { ...DEFAULT_CONFIG.surge, rules }
  });
}

function clashLikeRules(target: "clash" | "stash", rules: string[]): string | null {
  const config: AppConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    [target]: {
      ...structuredClone(DEFAULT_CONFIG[target]),
      ruleProviders: "",
      rules
    }
  };
  return validateClashLikeRules(config, target);
}

function directRule(policy: string): RuleSetDirectRule {
  return {
    id: "rule",
    name: "Rule",
    enabled: true,
    rule: "DOMAIN,example.com,Proxy",
    policy,
    order: 0
  };
}

describe("target rule values and built-in policies", () => {
  it("keeps Surge interface policies exclusive to Surge", () => {
    for (const policy of ["CELLULAR", "CELLULAR-ONLY", "HYBRID", "NO-HYBRID"]) {
      expect(surgeRules([`DOMAIN,example.com,${policy}`, "FINAL,Proxy"])).toBeNull();
      expect(inferDirectRuleTargets(directRule(policy))).toEqual(["surge"]);
    }
  });

  it("keeps Mihomo-only preset outbounds exclusive to Clash", () => {
    for (const policy of ["PASS-RULE", "COMPATIBLE"]) {
      expect(clashLikeRules("clash", [`DOMAIN,example.com,${policy}`, "MATCH,Proxy"])).toBeNull();
      expect(clashLikeRules("stash", [`DOMAIN,example.com,${policy}`, "MATCH,Proxy"])).toContain("策略出口不存在或不可用");
      expect(inferDirectRuleTargets(directRule(policy))).toEqual(["clash"]);
    }
  });

  it("rejects MATCH in Surge manual rules without changing unified fallback lowering", () => {
    expect(surgeRules(["MATCH,DIRECT", "FINAL,Proxy"])).toContain("规则类型 MATCH 不受支持");
    const fallback: RuleSetDirectRule = {
      ...directRule("Proxy"),
      rule: "MATCH,Proxy"
    };
    expect(inferDirectRuleTargets(fallback)).toEqual(["surge", "clash", "stash"]);
  });

  it("validates domain, CIDR, and ASN values in Surge manual rules", () => {
    for (const rule of [
      "DOMAIN,not a host,Proxy",
      "DOMAIN-SUFFIX,-bad.example,Proxy",
      "IP-CIDR,999.999.999.999/99,Proxy",
      "IP-CIDR6,192.0.2.0/24,Proxy",
      "IP-ASN,banana,Proxy"
    ]) {
      expect(surgeRules([rule, "FINAL,Proxy"])).toMatch(/包含无效的(?:域名| CIDR| ASN)/);
    }
    expect(surgeRules(["IP-ASN,AS13335,Proxy,no-resolve", "FINAL,Proxy"])).toBeNull();
  });

  it("validates domain, CIDR, and ASN values in Clash and Stash manual rules", () => {
    for (const target of ["clash", "stash"] as const) {
      expect(clashLikeRules(target, ["DOMAIN,bad host,Proxy", "MATCH,Proxy"])).toContain("DOMAIN 包含无效的域名");
      expect(clashLikeRules(target, ["SRC-IP-CIDR,192.0.2.999/24,Proxy", "MATCH,Proxy"])).toContain("SRC-IP-CIDR 包含无效的 CIDR");
      expect(clashLikeRules(target, ["SRC-IP-ASN,AS4294967296,Proxy", "MATCH,Proxy"])).toContain("SRC-IP-ASN 包含无效的 ASN");
    }
  });
});
