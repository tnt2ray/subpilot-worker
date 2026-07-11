import { describe, expect, it } from "vitest";
import { inferDirectRuleTargets, renderDirectRuleForTarget } from "../src/rule-targets";
import type { RuleSetDirectRule } from "../src/rule-set-types";

function directRule(overrides: Partial<RuleSetDirectRule>): RuleSetDirectRule {
  return {
    id: "rule",
    name: "Rule",
    enabled: true,
    rule: "DOMAIN-SUFFIX,example.com,Proxy",
    policy: "Proxy",
    order: 0,
    ...overrides
  };
}

describe("direct rule targets", () => {
  it("infers compatible targets and lowers target-specific syntax", () => {
    const shared = directRule({});
    expect(inferDirectRuleTargets(shared)).toEqual(["surge", "clash", "stash"]);
    expect(renderDirectRuleForTarget(shared, "clash")).toBe("DOMAIN-SUFFIX,example.com,Proxy");

    const surgeDomainOption = directRule({ rule: "DOMAIN-SUFFIX,example.com,Proxy,extended-matching" });
    expect(inferDirectRuleTargets(surgeDomainOption)).toEqual(["surge", "clash", "stash"]);
    expect(renderDirectRuleForTarget(surgeDomainOption, "surge")).toBe("DOMAIN-SUFFIX,example.com,Proxy,extended-matching");
    expect(renderDirectRuleForTarget(surgeDomainOption, "clash")).toBe("DOMAIN-SUFFIX,example.com,Proxy");

    const mixedIpOptions = directRule({ rule: "IP-CIDR,192.0.2.0/24,Proxy,no-resolve,src" });
    expect(renderDirectRuleForTarget(mixedIpOptions, "surge")).toBe("IP-CIDR,192.0.2.0/24,Proxy,no-resolve");
    expect(renderDirectRuleForTarget(mixedIpOptions, "clash")).toBe("IP-CIDR,192.0.2.0/24,Proxy,no-resolve,src");
    expect(renderDirectRuleForTarget(mixedIpOptions, "stash")).toBe("IP-CIDR,192.0.2.0/24,Proxy,no-resolve");

    const subnet = directRule({
      rule: "AND,((IP-CIDR,192.168.1.0/24,no-resolve),(SUBNET,SSID:flenser)),DIRECT",
      policy: "DIRECT"
    });
    expect(inferDirectRuleTargets(subnet)).toEqual(["surge"]);
    expect(renderDirectRuleForTarget(subnet, "surge")).toBe(subnet.rule);
    expect(renderDirectRuleForTarget(subnet, "clash")).toBeNull();
    expect(renderDirectRuleForTarget(subnet, "stash")).toBeNull();

    const device = directRule({ rule: "IP-CIDR,192.0.2.0/24,DEVICE:Air,no-resolve", policy: "DEVICE:Air" });
    expect(inferDirectRuleTargets(device)).toEqual(["surge"]);
    expect(renderDirectRuleForTarget(device, "surge")).toBe(device.rule);

    const builtInRuleSet = directRule({ rule: "RULE-SET,LAN,DIRECT", policy: "DIRECT" });
    expect(inferDirectRuleTargets(builtInRuleSet)).toEqual(["surge"]);
    expect(renderDirectRuleForTarget(builtInRuleSet, "surge")).toBe(builtInRuleSet.rule);

    const final = directRule({ rule: "FINAL,Proxy,dns-failed" });
    expect(renderDirectRuleForTarget(final, "surge")).toBe("FINAL,Proxy,dns-failed");
    expect(renderDirectRuleForTarget(final, "clash")).toBe("MATCH,Proxy");
    expect(renderDirectRuleForTarget(final, "stash")).toBe("MATCH,Proxy");

    const unknown = directRule({ rule: "FUTURE-RULE,value,Proxy" });
    expect(inferDirectRuleTargets(unknown)).toEqual([]);
    expect(renderDirectRuleForTarget(unknown, "surge")).toBeNull();

  });
});
