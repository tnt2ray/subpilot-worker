import { convertRule } from "./singbox-config";
import { isValidSingboxHeadlessRule } from "./singbox-validation";
import type { RenderConfig, ProxyNode } from "./types";
import { compiledFinalRuleOptions, splitRuleLine } from "./rule-line";
import { RULE_SET_TARGETS, type RuleSetDirectRule, type RuleSetOutputTarget } from "./rule-set-types";

export const SURGE_BUILT_IN_RULE_POLICIES = new Set([
  "DIRECT",
  "CELLULAR",
  "CELLULAR-ONLY",
  "HYBRID",
  "NO-HYBRID",
  "REJECT",
  "REJECT-DROP",
  "REJECT-NO-DROP",
  "REJECT-TINYGIF"
]);

export const CLASH_BUILT_IN_RULE_POLICIES = new Set([
  "DIRECT",
  "REJECT",
  "REJECT-DROP",
  "PASS",
  "PASS-RULE",
  "COMPATIBLE",
  "GLOBAL"
]);
export const STASH_BUILT_IN_RULE_POLICIES = new Set(["DIRECT", "REJECT", "REJECT-DROP", "PASS", "GLOBAL"]);

const ALL_BUILT_IN_RULE_POLICIES = new Set([
  ...SURGE_BUILT_IN_RULE_POLICIES,
  ...CLASH_BUILT_IN_RULE_POLICIES,
  ...STASH_BUILT_IN_RULE_POLICIES
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
  "WIFI-SSID",
  "USER-AGENT",
  "URL-REGEX"
]);
const CLASH_ONLY_RULE_TYPES = new Set([
  "IN-PORT",
  "DOMAIN-REGEX",
  "GEOSITE",
  "PROCESS-PATH",
  "PROCESS-NAME-REGEX",
  "NETWORK",
  "DSCP",
  "SRC-PORT",
  "DST-PORT",
  "SRC-IP-CIDR",
  "SRC-IP-ASN"
]);
const STASH_ONLY_RULE_TYPES = new Set([
  ...CLASH_ONLY_RULE_TYPES,
  "USER-AGENT",
  "URL-REGEX"
]);
const FINAL_RULE_TYPES = new Set(["FINAL", "MATCH"]);
const LOGICAL_RULE_TYPES = new Set(["AND", "OR", "NOT"]);
const TARGET_IP_RULE_TYPES = new Set(["IP-CIDR", "IP-CIDR6", "GEOIP", "IP-ASN"]);
const SURGE_EXTENDED_MATCHING_RULE_TYPES = new Set(["DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "URL-REGEX"]);

export function rewriteUnavailableGroupRuleTargets(
  config: RenderConfig,
  rules: string[],
  nodes: ProxyNode[],
  groupNames: Set<string>,
  outputTarget: RuleSetOutputTarget,
  extraPolicies: Set<string> = new Set()
): string[] {
  const disabledGroups = new Set(config.disabledGroups);
  const proxyNames = new Set(nodes.map((node) => node.name));
  return rules.map((rule) => {
    const parts = splitRuleLine(rule);
    const targetIndex = ruleTargetIndex(parts);
    if (targetIndex === null) return rule;
    const target = parts[targetIndex]?.trim() ?? "";
    if (!target || extraPolicies.has(target) || isAvailableRuleTarget(target, groupNames, disabledGroups, proxyNames, outputTarget)) return rule;
    // Keep the original reference; generation diagnostics decide whether output is usable.
    return parts.join(",");
  });
}

export function configuredTailscalePolicyNames(config: RenderConfig): Set<string> {
  return new Set(config.surge.tailscaleNodes
    .map((node) => node.name.trim())
    .filter(Boolean));
}

export function omitRulesTargetingPolicies(rules: string[], omittedPolicies: Set<string>): string[] {
  if (omittedPolicies.size === 0) return rules;
  return rules.filter((rule) => {
    const parts = splitRuleLine(rule);
    const targetIndex = ruleTargetIndex(parts);
    if (targetIndex === null) return true;
    return !omittedPolicies.has(parts[targetIndex]?.trim() ?? "");
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
  return RULE_SET_TARGETS.filter((target) => (
    isRulePolicyCompatibleWithTarget(rule.policy, target)
    && translateRuleLineForTarget(rule.rule, target, true) !== null
  ));
}

export function renderDirectRuleForTarget(rule: RuleSetDirectRule, target: RuleSetOutputTarget): string | null {
  if (!inferDirectRuleTargets(rule).includes(target)) return null;

  const parts = splitRuleLine(rule.rule);
  const type = (parts[0] || "").trim().toUpperCase();
  if (!type) return null;
  if (FINAL_RULE_TYPES.has(type)) {
    // The plan's policy is independent; allow FINAL,dns-failed as well as
    // FINAL,Proxy,dns-failed. Keep unsupported options visible to diagnostics.
    const rawOptions = compiledFinalRuleOptions(parts);
    const outputType = target === "surge" ? "FINAL" : "MATCH";
    const options = filterDirectRuleOptions(outputType, rawOptions, target);
    if (options.length !== rawOptions.filter(Boolean).length) return null;
    return target === "surge"
      ? ["FINAL", rule.policy, ...options].join(",")
      : `MATCH,${rule.policy}`;
  }
  const translated = translateRuleLineForTarget(rule.rule, target, true);
  if (!translated) return null;
  const translatedParts = splitRuleLine(translated);
  const translatedType = (translatedParts[0] || "").trim().toUpperCase();
  const value = (translatedParts[1] || "").trim();
  if (!value) return null;
  return [translatedType, value, rule.policy, ...filterDirectRuleOptions(translatedType, directRuleOptions(translatedParts), target)].join(",");
}

/** Preserve a provider-level no-resolve option when merging native Clash sources. */
export function clashRuleWithNoResolve(rule: string): string {
  const parts = splitRuleLine(rule);
  const type = parts[0]?.trim().toUpperCase() ?? "";
  if (TARGET_IP_RULE_TYPES.has(type)) {
    return parts.slice(2).some((part) => part.toLowerCase() === "no-resolve") ? rule : `${rule},no-resolve`;
  }
  if (!LOGICAL_RULE_TYPES.has(type)) return rule;
  const rewriteExpression = (value: string): string => {
    let result = "";
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] !== "(") { result += value[index]; continue; }
      const end = findClosingParenthesis(value, index);
      if (end < 0) return value;
      const inner = value.slice(index + 1, end);
      result += `(${logicalRuleParts(inner) ? clashRuleWithNoResolve(inner) : rewriteExpression(inner)})`;
      index = end;
    }
    return result;
  };
  parts[1] = rewriteExpression(parts[1] ?? "");
  return parts.join(",");
}

/** Main rules may retain a legacy policy; the plan's separate policy wins. */
export function isNativeClashDirectRule(rule: string): boolean {
  const parts = splitRuleLine(rule);
  const type = parts[0]?.toUpperCase() ?? "";
  if (FINAL_RULE_TYPES.has(type)) return compiledFinalRuleOptions(parts).length === 0;
  if (!parts[1]) return false;
  // Keep provider validation strict after removing only the main rule's policy.
  return isNativeClashRule([type, parts[1], ...directRuleOptions(parts)].join(","));
}

/** Validate native provider syntax without translating another client's rules. */
export function isNativeClashRule(rule: string): boolean {
  const parts = splitRuleLine(rule);
  const type = parts[0]?.trim().toUpperCase() ?? "";
  if (!parts[1]?.trim() || (!AUTO_SHARED_RULE_TYPES.has(type) && !CLASH_ONLY_RULE_TYPES.has(type))) return false;
  const normalized = [type, ...parts.slice(1)].join(",");
  if (translateRuleLineForTarget(normalized, "clash", false) !== normalized) return false;
  if (!LOGICAL_RULE_TYPES.has(type)) return true;
  const expression = parts[1] ?? "";
  const validateExpression = (value: string): boolean => {
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] !== "(") continue;
      const end = findClosingParenthesis(value, index);
      if (end < 0) return false;
      const inner = value.slice(index + 1, end);
      if (logicalRuleParts(inner) ? !isNativeClashRule(inner) : !validateExpression(inner)) return false;
      index = end;
    }
    return true;
  };
  return validateExpression(expression);
}

export function renderRuleSetRuleForTarget(rule: string, target: RuleSetOutputTarget): string | null {
  if (target !== "surge" && ruleUsesUnknownMatch(rule)) return null;
  if (target === "sing-box") {
    try { const converted = convertRule(rule, true).rule; return converted && isValidSingboxHeadlessRule(converted) ? rule : null; } catch { return null; }
  }
  return translateRuleLineForTarget(rule, target, false);
}

function ruleUsesUnknownMatch(rule: string): boolean {
  const matches = (parts: string[]): boolean => ["GEOIP", "IP-ASN"].includes(parts[0]?.trim().toUpperCase() ?? "") && parts[1]?.trim() === "UNKNOWN";
  const parts = splitRuleLine(rule);
  return matches(parts) || (LOGICAL_RULE_TYPES.has(parts[0]?.trim().toUpperCase() ?? "") && Boolean(parts[1]) && logicalExpressionSome(parts[1]!, matches));
}

export function ruleUsesExtendedMatching(rule: string): boolean {
  const hasOption = (parts: string[]): boolean => parts.slice(2).some((part) => part.trim().toLowerCase() === "extended-matching");
  const parts = splitRuleLine(rule);
  if (hasOption(parts)) return true;
  return LOGICAL_RULE_TYPES.has(parts[0]?.trim().toUpperCase() ?? "") && Boolean(parts[1])
    ? logicalExpressionSome(parts[1]!, hasOption)
    : false;
}

export function isRulePolicyCompatibleWithTarget(policy: string, target: RuleSetOutputTarget): boolean {
  const normalized = policy.trim();
  if (!normalized) return false;
  if (/^DEVICE:/i.test(normalized)) return false;
  const upper = normalized.toUpperCase();
  if (!ALL_BUILT_IN_RULE_POLICIES.has(upper)) return true;
  return builtInPoliciesForTarget(target).has(upper);
}

export function builtInPoliciesForTarget(target: RuleSetOutputTarget): ReadonlySet<string> {
  if (target === "sing-box") return new Set(["DIRECT", "REJECT", "REJECT-DROP"]);
  if (target === "surge") return SURGE_BUILT_IN_RULE_POLICIES;
  if (target === "stash") return STASH_BUILT_IN_RULE_POLICIES;
  return CLASH_BUILT_IN_RULE_POLICIES;
}

function translateRuleLineForTarget(rule: string, target: RuleSetOutputTarget, mainRule: boolean): string | null {
  const parts = splitRuleLine(rule);
  const sourceType = (parts[0] || "").trim().toUpperCase();
  if (!sourceType) return null;
  if (target !== "surge" && ruleUsesUnknownMatch(rule)) return null;
  if (FINAL_RULE_TYPES.has(sourceType)) return rule;
  if (mainRule && (sourceType === "RULE-SET" || sourceType === "DOMAIN-SET")) {
    return target === "surge" ? rule : null;
  }
  if (target !== "surge" && usesSurgeSubnetRule(rule)) return null;
  const translatedType = translateRuleType(sourceType, target);
  if (!translatedType) return null;
  parts[0] = translatedType;
  if (LOGICAL_RULE_TYPES.has(translatedType) && parts[1]) {
    const expression = translateLogicalExpression(parts[1], target);
    if (expression === null) return null;
    parts[1] = expression;
  }
  const translated = translateSourceMatchOptions(parts, target, mainRule);
  if (!translated) return null;
  const options = mainRule ? directRuleOptions(translated) : translated.slice(2);
  if (filterDirectRuleOptions(translated[0]!, options, target).length !== options.length) return null;
  return translated.join(",");
}

function translateLogicalExpression(expression: string, target: RuleSetOutputTarget): string | null {
  let translated = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index]!;
    if (escaped) {
      translated += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== null) {
      translated += char;
      escaped = true;
      continue;
    }
    if (quote !== null) {
      translated += char;
      if (char === quote) {
        if (expression[index + 1] === quote) {
          translated += expression[index + 1];
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      translated += char;
      continue;
    }
    if (char !== "(") {
      translated += char;
      continue;
    }

    const closingIndex = findClosingParenthesis(expression, index);
    if (closingIndex < 0) return null;
    const inner = expression.slice(index + 1, closingIndex);
    const translatedInner = translateLogicalNode(inner, target);
    if (translatedInner === null) return null;
    translated += `(${translatedInner})`;
    index = closingIndex;
  }
  return translated;
}

function translateLogicalNode(content: string, target: RuleSetOutputTarget): string | null {
  const parts = logicalRuleParts(content);
  if (!parts) return translateLogicalExpression(content, target);

  const type = translateRuleType(parts[0]!.trim().toUpperCase(), target);
  if (!type) return null;
  parts[0] = type;
  if (LOGICAL_RULE_TYPES.has(type) && parts[1]) {
    const expression = translateLogicalExpression(parts[1], target);
    if (expression === null) return null;
    parts[1] = expression;
  }
  const translated = translateSourceMatchOptions(parts, target, false);
  if (!translated) return null;
  const options = translated.slice(2);
  if (filterDirectRuleOptions(translated[0]!, options, target).length !== options.length) return null;
  return translated.join(",");
}

function logicalRuleParts(content: string): string[] | null {
  const parts = splitRuleLine(content);
  const type = parts[0]?.trim() ?? "";
  return parts.length >= 2 && /^[A-Za-z][A-Za-z0-9-]*$/.test(type) ? parts : null;
}

function findClosingParenthesis(value: string, openingIndex: number): number {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = openingIndex; index < value.length; index += 1) {
    const char = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== null) {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (char === quote) {
        if (value[index + 1] === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function translateRuleType(type: string, target: RuleSetOutputTarget): string | null {
  if (target === "surge") {
    const mapped = type === "DST-PORT"
      ? "DEST-PORT"
      : type === "SRC-IP-CIDR"
        ? "SRC-IP"
        : type;
    return AUTO_SHARED_RULE_TYPES.has(mapped) || AUTO_SURGE_ONLY_RULE_TYPES.has(mapped) ? mapped : null;
  }
  const mapped = type === "DEST-PORT"
    ? "DST-PORT"
    : type === "SRC-IP"
      ? "SRC-IP-CIDR"
      : type;
  const targetSpecificTypes = target === "stash" ? STASH_ONLY_RULE_TYPES : CLASH_ONLY_RULE_TYPES;
  return AUTO_SHARED_RULE_TYPES.has(mapped) || targetSpecificTypes.has(mapped) ? mapped : null;
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

function translateSourceMatchOptions(parts: string[], target: RuleSetOutputTarget, mainRule: boolean): string[] | null {
  const type = parts[0]?.trim().toUpperCase() ?? "";
  if (target === "clash" || !TARGET_IP_RULE_TYPES.has(type)) return parts;
  const optionStart = mainRule ? parts.length - directRuleOptions(parts).length : 2;
  if (!parts.slice(optionStart).some((part) => part.trim().toLowerCase() === "src")) return parts;
  // Dropping `src` would silently turn source matching into destination
  // matching. Only CIDRs have an equivalent on both other targets.
  if (type !== "IP-CIDR" && type !== "IP-CIDR6") return null;
  const sourceType = translateRuleType("SRC-IP-CIDR", target);
  if (parts.slice(optionStart).some((part) => !["src"].includes(part.trim().toLowerCase()))) return null;
  return sourceType ? [sourceType, ...parts.slice(1, optionStart)] : null;
}

function usesSurgeSubnetRule(rule: string): boolean {
  const parts = splitRuleLine(rule);
  const type = parts[0]?.trim().toUpperCase() ?? "";
  if (type === "SUBNET") return true;
  return LOGICAL_RULE_TYPES.has(type) && Boolean(parts[1])
    ? logicalExpressionSome(parts[1]!, (child) => child[0]!.trim().toUpperCase() === "SUBNET")
    : false;
}

function logicalExpressionSome(expression: string, matches: (parts: string[]) => boolean): boolean {
  for (let index = 0; index < expression.length; index += 1) {
    if (expression[index] !== "(") continue;
    const closingIndex = findClosingParenthesis(expression, index);
    if (closingIndex < 0) return false;
    const inner = expression.slice(index + 1, closingIndex);
    const parts = logicalRuleParts(inner);
    if (parts) {
      const type = parts[0]!.trim().toUpperCase();
      if (matches(parts)) return true;
      if (LOGICAL_RULE_TYPES.has(type) && parts[1] && logicalExpressionSome(parts[1], matches)) return true;
    } else if (logicalExpressionSome(inner, matches)) {
      return true;
    }
    index = closingIndex;
  }
  return false;
}

function directRuleOptions(parts: string[]): string[] {
  const normalized = parts.map((part) => part.trim()).filter(Boolean);
  if (normalized.length <= 2) return [];
  const third = (normalized[2] || "").toLowerCase();
  if (["no-resolve", "src", "extended-matching"].includes(third)) return normalized.slice(2);
  return normalized.slice(3);
}

export function ruleTargetIndex(parts: string[]): number | null {
  const type = parts[0]?.trim().toUpperCase();
  if (!type || type.startsWith("#")) return null;
  if ((type === "AND" || type === "OR" || type === "NOT") && parts.length >= 3) return 2;
  if ((type === "FINAL" || type === "MATCH") && parts.length >= 2) return 1;
  if (parts.length >= 3) return 2;
  return null;
}

function isAvailableRuleTarget(
  target: string,
  activeGroups: Set<string>,
  disabledGroups: Set<string>,
  proxyNames: Set<string>,
  outputTarget: RuleSetOutputTarget
): boolean {
  if (disabledGroups.has(target) || /^DEVICE:/i.test(target)) return false;
  return activeGroups.has(target)
    || proxyNames.has(target)
    || builtInPoliciesForTarget(outputTarget).has(target.toUpperCase());
}
