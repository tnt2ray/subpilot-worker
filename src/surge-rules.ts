import type { AppConfig } from "./types";

const VALUELESS_RULE_TYPES = new Set(["FINAL", "MATCH"]);
const RULE_SET_TYPES = new Set(["RULE-SET", "DOMAIN-SET"]);
const RULE_OPTION_ORDER = ["no-resolve", "extended-matching", "dns-failed"];
const RULE_SET_OPTIONS = new Set(["no-resolve", "extended-matching"]);
const DOMAIN_SET_OPTIONS = new Set(["extended-matching"]);
const IP_RULE_OPTIONS = new Set(["no-resolve"]);
const EXTENDED_MATCHING_RULE_TYPES = new Set(["DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "URL-REGEX"]);
const FINAL_RULE_OPTIONS = new Set(["dns-failed"]);
const VALUE_RULE_TYPES = new Set([
  "DOMAIN",
  "DOMAIN-SUFFIX",
  "DOMAIN-KEYWORD",
  "IP-CIDR",
  "IP-CIDR6",
  "GEOIP",
  "PROCESS-NAME",
  "USER-AGENT",
  "URL-REGEX",
  "SCRIPT",
  "SUBNET",
  "SRC-IP",
  "IN-PORT",
  "DEST-PORT",
  "PROTOCOL",
  "DEVICE-NAME",
  "CELLULAR-RADIO",
  "WIFI-SSID",
  "AND",
  "OR",
  "NOT"
]);

export const SURGE_BUILT_IN_POLICIES = [
  "DIRECT",
  "REJECT",
  "REJECT-DROP",
  "REJECT-NO-DROP",
  "REJECT-TINYGIF"
] as const;

export function validateSurgeRules(config: Partial<Pick<AppConfig, "groups" | "surge">>): string | null {
  const knownPolicies = new Set([
    ...Object.keys(config.groups || {}),
    ...SURGE_BUILT_IN_POLICIES
  ]);
  const rules = Array.isArray(config.surge?.rules) ? config.surge.rules : [];
  for (const [index, rule] of rules.entries()) {
    const error = validateSurgeRuleLine(rule, index + 1, knownPolicies);
    if (error) return error;
  }
  const finalError = validateFinalRuleOrder(rules);
  if (finalError) return finalError;
  return null;
}

function validateFinalRuleOrder(rules: string[]): string | null {
  const effectiveRules = rules.map((rule, index) => {
    const line = String(rule || "").trim();
    if (!line || line.startsWith("#")) return null;
    return {
      lineNumber: index + 1,
      type: (splitSurgeRuleLine(line)[0] || "").trim().toUpperCase()
    };
  }).filter((rule): rule is { lineNumber: number; type: string } => rule !== null);
  const finalRules = effectiveRules.filter((rule) => rule.type === "FINAL");
  if (finalRules.length === 0) return "Surge Rule 必须保留一个 FINAL 兜底规则";
  if (finalRules.length > 1) return "Surge Rule 只能保留一个 FINAL 兜底规则";
  if (effectiveRules[effectiveRules.length - 1]?.type !== "FINAL") return "Surge Rule 的 FINAL 兜底规则必须位于最后";
  return null;
}

function validateSurgeRuleLine(rule: string, lineNumber: number, knownPolicies: Set<string>): string | null {
  const line = String(rule || "").trim();
  if (!line || line.startsWith("#")) return null;
  if (/^\[[^\]]+\]$/.test(line)) return `Surge Rule 第 ${lineNumber} 行不能包含配置段标题`;

  const parts = splitSurgeRuleLine(line);
  const type = (parts[0] || "").trim().toUpperCase();
  if (!type) return `Surge Rule 第 ${lineNumber} 行缺少规则类型`;
  if (parts.some((part) => !part.trim())) return `Surge Rule 第 ${lineNumber} 行存在空参数`;

  if (RULE_SET_TYPES.has(type)) {
    if (parts.length < 3) return `Surge Rule 第 ${lineNumber} 行规则集语法应为 ${type},名称,策略`;
    const policyError = validatePolicy(parts[2] || "", knownPolicies);
    if (policyError) return `Surge Rule 第 ${lineNumber} 行${policyError}`;
    const optionError = validateRuleOptions(parts.slice(3), type);
    if (optionError) return `Surge Rule 第 ${lineNumber} 行${optionError}`;
    return null;
  }

  if (VALUELESS_RULE_TYPES.has(type)) {
    if (parts.length < 2) return `Surge Rule 第 ${lineNumber} 行 ${type} 规则缺少策略出口`;
    const policyError = validatePolicy(parts[1] || "", knownPolicies);
    if (policyError) return `Surge Rule 第 ${lineNumber} 行${policyError}`;
    const optionError = validateRuleOptions(parts.slice(2), type);
    if (optionError) return `Surge Rule 第 ${lineNumber} 行${optionError}`;
    return null;
  }

  if (!VALUE_RULE_TYPES.has(type)) return `Surge Rule 第 ${lineNumber} 行规则类型 ${type} 不受支持`;
  if (parts.length < 3) return `Surge Rule 第 ${lineNumber} 行语法应为 类型,匹配值,策略`;
  const policyError = validatePolicy(parts[2] || "", knownPolicies);
  if (policyError) return `Surge Rule 第 ${lineNumber} 行${policyError}`;
  const optionError = validateRuleOptions(parts.slice(3), type);
  if (optionError) return `Surge Rule 第 ${lineNumber} 行${optionError}`;
  return null;
}

function validateRuleOptions(options: string[], type: string): string | null {
  const values = options.map((option) => option.trim().toLowerCase()).filter(Boolean);
  const uniqueValues = new Set(values);
  if (uniqueValues.size !== values.length) return "附加参数不能重复";
  const allowed = allowedRuleOptions(type);
  const invalid = values.filter((option) => !allowed.has(option) || !RULE_OPTION_ORDER.includes(option));
  if (invalid.length > 0) {
    const allowedText = [...allowed].join(", ") || "无";
    return `附加参数 ${invalid.join(", ")} 不适用于 ${type}，可用参数：${allowedText}`;
  }
  return null;
}

function allowedRuleOptions(type: string): Set<string> {
  if (type === "RULE-SET") return RULE_SET_OPTIONS;
  if (type === "DOMAIN-SET") return DOMAIN_SET_OPTIONS;
  if (type === "FINAL") return FINAL_RULE_OPTIONS;
  if (["IP-CIDR", "IP-CIDR6", "GEOIP"].includes(type)) return IP_RULE_OPTIONS;
  if (EXTENDED_MATCHING_RULE_TYPES.has(type)) return DOMAIN_SET_OPTIONS;
  return new Set();
}

function splitSurgeRuleLine(line: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  for (const char of line) {
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim() || parts.length > 0) parts.push(current.trim());
  return parts;
}

function validatePolicy(policy: string, knownPolicies: Set<string>): string | null {
  const trimmed = policy.trim();
  if (!trimmed || /[\r\n,[\]]/.test(trimmed)) return "策略出口格式无效";
  if (!knownPolicies.has(trimmed) && !isSurgeDevicePolicy(trimmed)) return "策略出口必须是已配置策略组或 Surge 内置策略";
  return null;
}

function isSurgeDevicePolicy(policy: string): boolean {
  return /^DEVICE:[^,\r\n[\]]+$/i.test(policy);
}
