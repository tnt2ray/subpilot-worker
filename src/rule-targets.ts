import type { AppConfig, ProxyNode } from "./types";
import { splitRuleLine } from "./rule-line";

const BUILT_IN_RULE_POLICIES = new Set([
  "DIRECT",
  "REJECT",
  "REJECT-DROP",
  "REJECT-NO-DROP",
  "REJECT-TINYGIF"
]);

export function rewriteUnavailableGroupRuleTargets(config: AppConfig, rules: string[], nodes: ProxyNode[], groupNames: Set<string>): string[] {
  const disabledGroups = new Set(config.disabledGroups);
  const proxyNames = new Set(nodes.map((node) => node.name));
  return rules.map((rule) => {
    const parts = splitRuleLine(rule);
    const targetIndex = ruleTargetIndex(parts);
    if (targetIndex === null) return rule;
    const target = parts[targetIndex]?.trim() ?? "";
    if (!target || isAvailableRuleTarget(target, groupNames, disabledGroups, proxyNames)) return rule;
    parts[targetIndex] = "Proxy";
    return parts.join(",");
  });
}

export function filterClashRules(rules: string[]): string[] {
  return rules.filter((rule) => !usesSurgeSubnetRule(rule));
}

export function addMissingClashRuleProviderRules(rules: string[], providerNames: string[]): string[] {
  if (providerNames.length === 0) return rules;
  const usedProviders = new Set(rules.flatMap((rule) => {
    const parts = splitRuleLine(rule);
    return parts[0]?.trim().toUpperCase() === "RULE-SET" && parts[1]?.trim()
      ? [parts[1].trim()]
      : [];
  }));
  const missingRules = providerNames
    .filter((name) => !usedProviders.has(name))
    .map((name) => `RULE-SET,${name},Proxy`);
  if (missingRules.length === 0) return rules;
  const matchIndex = rules.findIndex((rule) => {
    const type = splitRuleLine(rule)[0]?.trim().toUpperCase();
    return type === "MATCH" || type === "FINAL";
  });
  if (matchIndex < 0) return [...rules, ...missingRules];
  return [
    ...rules.slice(0, matchIndex),
    ...missingRules,
    ...rules.slice(matchIndex)
  ];
}

function usesSurgeSubnetRule(rule: string): boolean {
  return /(?:^|[,(])\s*SUBNET(?:\s*[:,)]|,)/i.test(rule);
}

function ruleTargetIndex(parts: string[]): number | null {
  const type = parts[0]?.trim().toUpperCase();
  if (!type || type.startsWith("#")) return null;
  if (type === "AND" || type === "OR" || type === "NOT") return null;
  if ((type === "FINAL" || type === "MATCH") && parts.length >= 2) return 1;
  if (parts.length >= 3) return 2;
  return null;
}

function isAvailableRuleTarget(target: string, activeGroups: Set<string>, disabledGroups: Set<string>, proxyNames: Set<string>): boolean {
  if (disabledGroups.has(target)) return false;
  return activeGroups.has(target) || proxyNames.has(target) || BUILT_IN_RULE_POLICIES.has(target.toUpperCase());
}
