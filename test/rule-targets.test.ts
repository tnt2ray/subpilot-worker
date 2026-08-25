import { describe, expect, it } from "vitest";
import {
  configuredTailscalePolicyNames,
  inferDirectRuleTargets,
  omitRulesTargetingPolicies,
  renderDirectRuleForTarget,
  renderRuleSetRuleForTarget,
  rewriteUnavailableGroupRuleTargets
} from "../src/rule-targets";
import { DEFAULT_CONFIG } from "../src/default-config";
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

    const userAgent = directRule({ rule: 'USER-AGENT,"Example, App",Proxy' });
    expect(inferDirectRuleTargets(userAgent)).toEqual(["surge", "stash"]);
    expect(renderDirectRuleForTarget(userAgent, "surge")).toBe('USER-AGENT,"Example, App",Proxy');
    expect(renderDirectRuleForTarget(userAgent, "clash")).toBeNull();
    expect(renderDirectRuleForTarget(userAgent, "stash")).toBe('USER-AGENT,"Example, App",Proxy');

    const urlRegex = directRule({ rule: 'URL-REGEX,"^https://example.com/(a,b)",Proxy' });
    expect(inferDirectRuleTargets(urlRegex)).toEqual(["surge", "stash"]);
    expect(renderDirectRuleForTarget(urlRegex, "clash")).toBeNull();
    expect(renderDirectRuleForTarget(urlRegex, "stash")).toBe('URL-REGEX,"^https://example.com/(a,b)",Proxy');

    const destinationPort = directRule({ rule: "DEST-PORT,443,Proxy" });
    expect(renderDirectRuleForTarget(destinationPort, "surge")).toBe("DEST-PORT,443,Proxy");
    expect(renderDirectRuleForTarget(destinationPort, "clash")).toBe("DST-PORT,443,Proxy");

    const processPath = directRule({ rule: "PROCESS-PATH,/Applications/App,Proxy" });
    expect(renderDirectRuleForTarget(processPath, "surge")).toBeNull();
    expect(renderDirectRuleForTarget(processPath, "clash")).toBe("PROCESS-PATH,/Applications/App,Proxy");

    expect(inferDirectRuleTargets(directRule({ policy: "PASS" }))).toEqual(["clash", "stash"]);
    expect(inferDirectRuleTargets(directRule({ policy: "GLOBAL" }))).toEqual(["clash", "stash"]);
    expect(inferDirectRuleTargets(directRule({ policy: "REJECT-TINYGIF" }))).toEqual(["surge"]);
    expect(inferDirectRuleTargets(directRule({ policy: "REJECT-DROP" }))).toEqual(["surge", "clash", "stash"]);

  });

  it("omits rules that target configured Tailscale policies", () => {
    const config = {
      ...DEFAULT_CONFIG,
      surge: {
        ...DEFAULT_CONFIG.surge,
        tailscaleNodes: [{
          name: "Tailnet Exit",
          sectionName: "tailnet-exit",
          authKey: "",
          controlUrl: "",
          hostname: "",
          derpOnly: false,
          exitNode: "none",
          idleKeepalive: 600,
          preferIpv6: false,
          dnsServer: [],
          mtu: 1280,
          underlyingProxy: "",
          testUrl: "",
          testTimeout: 5,
          enabled: false
        }]
      }
    };
    const policies = configuredTailscalePolicyNames(config);

    expect(omitRulesTargetingPolicies([
      "DOMAIN-SUFFIX,tailnet.example,Tailnet Exit",
      "RULE-SET,Tailnet,Tailnet Exit",
      "AND,((DOMAIN,a.example),(DOMAIN,b.example)),Tailnet Exit",
      "DOMAIN-SUFFIX,shared.example,Proxy",
      "MATCH,DIRECT"
    ], policies)).toEqual([
      "DOMAIN-SUFFIX,shared.example,Proxy",
      "MATCH,DIRECT"
    ]);
  });

  it("translates logical child types without rewriting regex values", () => {
    const surgeRule = directRule({
      rule: 'AND,((URL-REGEX,"^https://example\\.com/(DST-PORT,foo)$"),(DST-PORT,443)),Proxy'
    });
    expect(renderDirectRuleForTarget(surgeRule, "surge")).toBe(
      'AND,((URL-REGEX,"^https://example\\.com/(DST-PORT,foo)$"),(DEST-PORT,443)),Proxy'
    );

    const clashRule = directRule({
      rule: "AND,((DOMAIN-REGEX,^(SUBNET|DEST-PORT,foo)$),(DEST-PORT,443)),Proxy"
    });
    expect(renderDirectRuleForTarget(clashRule, "clash")).toBe(
      "AND,((DOMAIN-REGEX,^(SUBNET|DEST-PORT,foo)$),(DST-PORT,443)),Proxy"
    );

    const nestedRule = directRule({
      rule: "AND,((DOMAIN,a.example),(OR,((DEST-PORT,443),(DOMAIN,b.example)))),Proxy"
    });
    expect(renderDirectRuleForTarget(nestedRule, "clash")).toBe(
      "AND,((DOMAIN,a.example),(OR,((DST-PORT,443),(DOMAIN,b.example)))),Proxy"
    );

    const sourceRule = "AND,((IP-CIDR,192.0.2.0/24,src,no-resolve),(DOMAIN,a.example))";
    expect(renderRuleSetRuleForTarget(sourceRule, "clash")).toBe(sourceRule);
    expect(renderRuleSetRuleForTarget(sourceRule, "stash")).toBe(
      "AND,((IP-CIDR,192.0.2.0/24,no-resolve),(DOMAIN,a.example))"
    );
    expect(renderRuleSetRuleForTarget(sourceRule, "surge")).toBe(
      "AND,((IP-CIDR,192.0.2.0/24,no-resolve),(DOMAIN,a.example))"
    );
  });

  it("rewrites logical targets and preserves target-specific built-in policies", () => {
    const rules = [
      "AND,((DOMAIN,a.example),(DOMAIN,b.example)),Missing",
      "DOMAIN,a.example,PASS",
      "DOMAIN,b.example,DEVICE:Air",
      "DOMAIN,c.example,REJECT-TINYGIF"
    ];
    const groupNames = new Set(["Proxy"]);

    expect(rewriteUnavailableGroupRuleTargets(DEFAULT_CONFIG, rules, [], groupNames, "surge")).toEqual([
      "AND,((DOMAIN,a.example),(DOMAIN,b.example)),Proxy",
      "DOMAIN,a.example,Proxy",
      "DOMAIN,b.example,DEVICE:Air",
      "DOMAIN,c.example,REJECT-TINYGIF"
    ]);
    expect(rewriteUnavailableGroupRuleTargets(DEFAULT_CONFIG, rules, [], groupNames, "clash")).toEqual([
      "AND,((DOMAIN,a.example),(DOMAIN,b.example)),Proxy",
      "DOMAIN,a.example,PASS",
      "DOMAIN,b.example,Proxy",
      "DOMAIN,c.example,Proxy"
    ]);
  });
});
