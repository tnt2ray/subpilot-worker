import type { AppConfig, ProxyNode } from "./types";
import { splitRuleLine } from "./rule-line";
import { RULE_SET_TARGETS, type RuleSetDirectRule, type RuleSetOutputTarget } from "./rule-set-types";

const BUILT_IN_RULE_POLICIES = new Set([
  "DIRECT",
  "REJECT",
  "REJECT-DROP",
  "REJECT-NO-DROP",
  "REJECT-TINYGIF"
]);

const AUTO_SHARED_RULE_TYPES = new Set([
  "DOMAIN",
  "DOMAIN-SUFFIX",
  "DOMAIN-KEYWORD",
  "IP-CIDR",
  "IP-CIDR6",
  "IP-ASN",
  "GEOIP",
  "PROCESS-NAME",
  "USER-AGENT",
  "URL-REGEX",
  "AND",
  "OR",
  "NOT"
]);
const AUTO_SURGE_ONLY_RULE_TYPES = new Set([
  "RULE-SET",
  "DOMAIN-SET",
  "SUBNET",
  "SCRIPT",
  "SRC-IP",
  "IN-PORT",
  "DEST-PORT",
  "PROTOCOL",
  "DEVICE-NAME",
  "CELLULAR-RADIO",
  "WIFI-SSID"
]);
const FINAL_RULE_TYPES = new Set(["FINAL", "MATCH"]);
const TARGET_IP_RULE_TYPES = new Set(["IP-CIDR", "IP-CIDR6", "GEOIP", "IP-ASN"]);
const SURGE_EXTENDED_MATCHING_RULE_TYPES = new Set(["DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "URL-REGEX"]);

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

export function inferDirectRuleTargets(rule: RuleSetDirectRule): RuleSetOutputTarget[] {
  const parts = splitRuleLine(rule.rule);
  const type = (parts[0] || "").trim().toUpperCase();
  if (!type) return [];
  if (FINAL_RULE_TYPES.has(type)) return [...RULE_SET_TARGETS];
  if (
    AUTO_SURGE_ONLY_RULE_TYPES.has(type)
    || usesSurgeSubnetRule(rule.rule)
    || isSurgeDevicePolicy(rule.policy)
  ) {
    return ["surge"];
  }
  return AUTO_SHARED_RULE_TYPES.has(type) ? [...RULE_SET_TARGETS] : [];
}

export function renderDirectRuleForTarget(rule: RuleSetDirectRule, target: RuleSetOutputTarget): string | null {
  if (!inferDirectRuleTargets(rule).includes(target)) return null;

  const parts = splitRuleLine(rule.rule);
  const type = (parts[0] || "").trim().toUpperCase();
  if (!type) return null;
  if (FINAL_RULE_TYPES.has(type)) {
    const options = filterDirectRuleOptions(type, parts.slice(2), target);
    return target === "surge"
      ? ["FINAL", rule.policy, ...options].join(",")
      : `MATCH,${rule.policy}`;
  }
  const value = (parts[1] || "").trim();
  if (!value) return null;
  return [type, value, rule.policy, ...filterDirectRuleOptions(type, directRuleOptions(parts), target)].join(",");
}

function filterDirectRuleOptions(type: string, options: string[], target: RuleSetOutputTarget): string[] {
  const normalized = [...new Set(options.map((option) => option.trim().toLowerCase()).filter(Boolean))];
  if (target === "surge") {
    if (TARGET_IP_RULE_TYPES.has(type)) return normalized.filter((option) => option === "no-resolve");
    if (SURGE_EXTENDED_MATCHING_RULE_TYPES.has(type)) return normalized.filter((option) => option === "extended-matching");
    if (type === "FINAL") return normalized.filter((option) => option === "dns-failed");
    if (type === "RULE-SET") return normalized.filter((option) => option === "no-resolve" || option === "extended-matching");
    if (type === "DOMAIN-SET") return normalized.filter((option) => option === "extended-matching");
    return [];
  }
  if (!TARGET_IP_RULE_TYPES.has(type)) return [];
  return target === "clash"
    ? normalized.filter((option) => option === "no-resolve" || option === "src")
    : normalized.filter((option) => option === "no-resolve");
}

function usesSurgeSubnetRule(rule: string): boolean {
  return /(?:^|[,(])\s*SUBNET(?:\s*[:,)]|,)/i.test(rule);
}

function directRuleOptions(parts: string[]): string[] {
  const normalized = parts.map((part) => part.trim()).filter(Boolean);
  if (normalized.length <= 2) return [];
  const third = (normalized[2] || "").toLowerCase();
  if (third === "no-resolve") return normalized.slice(2);
  return normalized.slice(3);
}

function isSurgeDevicePolicy(policy: string): boolean {
  return /^DEVICE:[^,\r\n[\]]+$/i.test(policy.trim());
}

export function ruleTargetIndex(parts: string[]): number | null {
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
