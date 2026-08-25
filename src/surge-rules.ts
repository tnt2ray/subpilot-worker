import type { AppConfig } from "./types";
import { splitRuleLine as splitSurgeRuleLine } from "./rule-line";
import { validateLogicalRuleExpression } from "./logical-rules";
import {
  collectCoverageWarnings,
  CoverageWarningCollection,
  dedupeCoverageReferences,
  flattenResolvedCoverageEntries,
  type CoverageEntry,
  type CoverageRule
} from "./rule-coverage-core";
import { mapWithConcurrency, readResponseTextWithLimit } from "./util";
import { fetchWithTimeout } from "./upstream-fetch";
import { SURGE_BUILT_IN_RULE_POLICIES } from "./rule-targets";
import { validateRuleMatchValue } from "./rule-value-validation";

const VALUELESS_RULE_TYPES = new Set(["FINAL"]);
const RULE_SET_TYPES = new Set(["RULE-SET", "DOMAIN-SET"]);
const RULE_OPTION_ORDER = ["no-resolve", "extended-matching", "dns-failed"];
const RULE_SET_OPTIONS = new Set(["no-resolve", "extended-matching"]);
const DOMAIN_SET_OPTIONS = new Set(["extended-matching"]);
const IP_RULE_OPTIONS = new Set(["no-resolve"]);
const IP_RULE_TYPES = new Set(["IP-CIDR", "IP-CIDR6", "GEOIP", "IP-ASN"]);
const EXTENDED_MATCHING_RULE_TYPES = new Set(["DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "URL-REGEX"]);
const FINAL_RULE_OPTIONS = new Set(["dns-failed"]);
const MAX_RULE_SET_CONTENT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_COVERAGE_WARNINGS = 80;
const RULE_SET_FETCH_CONCURRENCY = 3;
const MAX_EXTERNAL_RULE_SET_FETCHES = 24;
const EXTERNAL_RULE_SET_FETCH_TIMEOUT_MS = 2_500;
const MAX_COVERAGE_SOURCE_CHARACTERS = 8 * 1024 * 1024;
const MAX_COVERAGE_RULES = 5_000;
const VALUE_RULE_TYPES = new Set([
  "DOMAIN",
  "DOMAIN-SUFFIX",
  "DOMAIN-KEYWORD",
  "IP-CIDR",
  "IP-CIDR6",
  "GEOIP",
  "IP-ASN",
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
const COVERAGE_VALUE_RULE_TYPES = new Set(VALUE_RULE_TYPES);
const EXACT_MATCH_RULE_TYPES = new Set([
  "GEOIP",
  "IP-ASN",
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
const INTERNAL_RULE_SETS = new Map<string, string[]>([
  ["LAN", [
    "DOMAIN-SUFFIX,local",
    "IP-CIDR,192.168.0.0/16",
    "IP-CIDR,10.0.0.0/8",
    "IP-CIDR,172.16.0.0/12",
    "IP-CIDR,127.0.0.0/8",
    "IP-CIDR,100.64.0.0/10",
    "IP-CIDR6,fe80::/10"
  ]]
]);
const UNRESOLVED_INTERNAL_RULE_SETS = new Set(["SYSTEM"]);

type SurgeRuleFetch = typeof fetch;

export interface SurgeRuleCoverageOptions {
  includeExternalRuleSets?: boolean;
  fetcher?: SurgeRuleFetch;
  maxWarnings?: number;
  userAgent?: string;
}

interface TopLevelRuleSetReference {
  kind: "rule-set";
  type: string;
  name: string;
  policy: string;
  lineNumber: number;
}

export function validateSurgeRules(config: Partial<Pick<AppConfig, "disabledGroups" | "groups" | "surge">>): string | null {
  const knownPolicies = new Set([
    ...Object.keys(config.groups || {}).filter((name) => !config.disabledGroups?.includes(name)),
    ...SURGE_BUILT_IN_RULE_POLICIES,
    ...(config.surge?.tailscaleNodes || [])
      .filter((node) => node.enabled && typeof node.authKey === "string" && Boolean(node.authKey.trim()))
      .map((node) => node.name)
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

export async function collectSurgeRuleCoverageWarnings(
  config: Partial<Pick<AppConfig, "settings" | "surge">>,
  options: SurgeRuleCoverageOptions = {}
): Promise<string[]> {
  const rules = Array.isArray(config.surge?.rules) ? config.surge.rules : [];
  const maxWarnings = Math.max(1, options.maxWarnings ?? DEFAULT_MAX_COVERAGE_WARNINGS);
  const collection = new CoverageWarningCollection(maxWarnings, "Surge");
  const entries = await flattenSurgeRulesForCoverage(config, rules, options, collection);
  if (entries.length > MAX_COVERAGE_RULES) {
    collection.push(`Surge Rule 覆盖诊断仅检查前 ${MAX_COVERAGE_RULES} 条规则。`);
  }
  collectCoverageWarnings(entries.slice(0, MAX_COVERAGE_RULES), collection, {
    targetName: "Surge",
    valuelessRuleTypes: VALUELESS_RULE_TYPES,
    exactMatchRuleTypes: EXACT_MATCH_RULE_TYPES,
    normalizeDomainValue: normalizeSurgeDomainValue
  });

  return collection.messages;
}

async function flattenSurgeRulesForCoverage(
  config: Partial<Pick<AppConfig, "settings" | "surge">>,
  rules: string[],
  options: SurgeRuleCoverageOptions,
  warnings: CoverageWarningCollection
): Promise<CoverageRule[]> {
  const parsed = rules.flatMap((line, index) => parseTopLevelRuleForCoverage(line, index + 1));
  const references = parsed.filter((entry): entry is TopLevelRuleSetReference => entry.kind === "rule-set");
  const resolvedRuleSets = await resolveRuleSetReferences(config, references, options, warnings);
  return flattenResolvedCoverageEntries(parsed, resolvedRuleSets, ruleSetReferenceKey);
}

function parseTopLevelRuleForCoverage(line: string, lineNumber: number): Array<CoverageEntry<TopLevelRuleSetReference>> {
  const trimmed = String(line || "").trim();
  if (!trimmed || isCommentLine(trimmed) || /^\[[^\]]+\]$/.test(trimmed)) return [];
  const parts = splitSurgeRuleLine(trimmed);
  const type = (parts[0] || "").trim().toUpperCase();
  if (!type) return [];

  if (RULE_SET_TYPES.has(type)) {
    const name = (parts[1] || "").trim();
    const policy = (parts[2] || "").trim();
    return name && policy ? [{ kind: "rule-set", type, name, policy, lineNumber }] : [];
  }

  const entry = parseCoverageRuleParts(parts, lineNumberLabel(lineNumber));
  return entry ? [entry] : [];
}

async function resolveRuleSetReferences(
  config: Partial<Pick<AppConfig, "settings" | "surge">>,
  references: TopLevelRuleSetReference[],
  options: SurgeRuleCoverageOptions,
  warnings: CoverageWarningCollection
): Promise<Map<string, CoverageRule[]>> {
  const resolved = new Map<string, CoverageRule[]>();
  const unique = dedupeCoverageReferences(references, ruleSetReferenceKey);
  const external = unique.filter((reference) => !resolveInternalRuleSet(reference, resolved, warnings));
  if (external.length === 0) return resolved;

  if (options.includeExternalRuleSets === false) {
    for (const reference of external) {
      warnings.push(`${lineNumberLabel(reference.lineNumber)}规则集 ${shortRuleSetName(reference.name)} 内容未参与覆盖检查。`);
    }
    return resolved;
  }

  const toFetch = external.slice(0, MAX_EXTERNAL_RULE_SET_FETCHES);
  const skipped = external.slice(MAX_EXTERNAL_RULE_SET_FETCHES);
  if (skipped.length > 0) {
    warnings.push(`Surge Rule 覆盖诊断跳过 ${skipped.length} 个额外外部规则集；最多检查 ${MAX_EXTERNAL_RULE_SET_FETCHES} 个。`);
    for (const reference of skipped) resolved.set(ruleSetReferenceKey(reference), []);
  }

  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const userAgent = options.userAgent ?? config.settings?.userAgentSurge ?? "Surge";
  let retainedCharacters = 0;
  let retainedRules = 0;
  await mapWithConcurrency(toFetch, RULE_SET_FETCH_CONCURRENCY, async (reference) => {
    const key = ruleSetReferenceKey(reference);
    if (!isHttpUrl(reference.name)) {
      warnings.push(`${lineNumberLabel(reference.lineNumber)}规则集 ${shortRuleSetName(reference.name)} 不是 HTTP(S) 地址，内容未参与覆盖检查。`);
      resolved.set(key, []);
      return;
    }

    try {
      if (retainedCharacters >= MAX_COVERAGE_SOURCE_CHARACTERS || retainedRules >= MAX_COVERAGE_RULES) {
        warnings.push(`${lineNumberLabel(reference.lineNumber)}规则集 ${shortRuleSetName(reference.name)} 因覆盖诊断总量上限而跳过。`);
        resolved.set(key, []);
        return;
      }
      const content = await fetchRuleSetContent(reference.name, userAgent, fetcher);
      if (retainedCharacters + content.length > MAX_COVERAGE_SOURCE_CHARACTERS) {
        warnings.push(`${lineNumberLabel(reference.lineNumber)}规则集 ${shortRuleSetName(reference.name)} 超出覆盖诊断 ${MAX_COVERAGE_SOURCE_CHARACTERS} 字符总量上限。`);
        resolved.set(key, []);
        return;
      }
      const parsed = parseRuleSetContentForCoverage(reference, content);
      if (retainedRules + parsed.length > MAX_COVERAGE_RULES) {
        warnings.push(`${lineNumberLabel(reference.lineNumber)}规则集 ${shortRuleSetName(reference.name)} 超出覆盖诊断 ${MAX_COVERAGE_RULES} 条规则总量上限。`);
        resolved.set(key, []);
        return;
      }
      retainedCharacters += content.length;
      retainedRules += parsed.length;
      resolved.set(key, parsed);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`${lineNumberLabel(reference.lineNumber)}规则集 ${shortRuleSetName(reference.name)} 内容未参与覆盖检查：${reason}`);
      resolved.set(key, []);
    }
  });
  return resolved;
}

function resolveInternalRuleSet(
  reference: TopLevelRuleSetReference,
  resolved: Map<string, CoverageRule[]>,
  warnings: CoverageWarningCollection
): boolean {
  const name = reference.name.toUpperCase();
  const lines = INTERNAL_RULE_SETS.get(name);
  if (!lines && UNRESOLVED_INTERNAL_RULE_SETS.has(name)) {
    warnings.push(`${lineNumberLabel(reference.lineNumber)}内置规则集 ${reference.name} 内容由 Surge 版本维护，未参与覆盖检查。`);
    resolved.set(ruleSetReferenceKey(reference), []);
    return true;
  }
  if (!lines) return false;
  resolved.set(ruleSetReferenceKey(reference), parseRuleSetLinesForCoverage(reference, lines));
  return true;
}

function parseRuleSetContentForCoverage(reference: TopLevelRuleSetReference, content: string): CoverageRule[] {
  const lines = content.split(/\r?\n/);
  if (reference.type === "DOMAIN-SET") return parseDomainSetLinesForCoverage(reference, lines);
  return parseRuleSetLinesForCoverage(reference, lines);
}

function parseRuleSetLinesForCoverage(reference: TopLevelRuleSetReference, lines: string[]): CoverageRule[] {
  return lines.flatMap((line, index) => {
    const trimmed = String(line || "").trim();
    if (!trimmed || isCommentLine(trimmed) || /^\[[^\]]+\]$/.test(trimmed)) return [];
    const parts = splitSurgeRuleLine(trimmed);
    const type = (parts[0] || "").trim().toUpperCase();
    const value = (parts[1] || "").trim();
    if (!COVERAGE_VALUE_RULE_TYPES.has(type) || !value) return [];
    return [{
      kind: "rule" as const,
      type,
      value,
      policy: reference.policy,
      label: ruleSetLineLabel(reference, index + 1)
    }];
  });
}

function parseDomainSetLinesForCoverage(reference: TopLevelRuleSetReference, lines: string[]): CoverageRule[] {
  return lines.flatMap((line, index) => {
    const value = String(line || "").trim();
    if (!value || isCommentLine(value) || value.includes(",")) return [];
    const suffix = value.startsWith("+.") || value.startsWith(".") || value.startsWith("*.");
    const normalized = suffix ? value.replace(/^\+\./, "").replace(/^\*\./, "").replace(/^\./, "") : value;
    const type = suffix ? "DOMAIN-SUFFIX" : "DOMAIN";
    if (!normalized || normalized.includes("://")) return [];
    return [{
      kind: "rule" as const,
      type,
      value: normalized,
      policy: reference.policy,
      label: ruleSetLineLabel(reference, index + 1)
    }];
  });
}

function parseCoverageRuleParts(parts: string[], label: string): CoverageRule | null {
  const type = (parts[0] || "").trim().toUpperCase();
  if (VALUELESS_RULE_TYPES.has(type)) {
    const policy = (parts[1] || "").trim();
    return policy ? { kind: "rule", type, value: "", policy, label } : null;
  }
  if (!COVERAGE_VALUE_RULE_TYPES.has(type)) return null;
  const value = (parts[1] || "").trim();
  const policy = (parts[2] || "").trim();
  return value && policy ? { kind: "rule", type, value, policy, label } : null;
}

async function fetchRuleSetContent(url: string, userAgent: string, fetcher: SurgeRuleFetch): Promise<string> {
  return fetchWithTimeout(
    fetcher,
    url,
    { headers: { "user-agent": userAgent } },
    EXTERNAL_RULE_SET_FETCH_TIMEOUT_MS,
    async (response) => {
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`HTTP ${response.status}`);
      }
      return readResponseTextWithLimit(response, MAX_RULE_SET_CONTENT_BYTES, "rule-set");
    }
  );
}

function normalizeSurgeDomainValue(value: string): string {
  return value.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
}

function lineNumberLabel(lineNumber: number): string {
  return `第 ${lineNumber} 行`;
}

function ruleSetLineLabel(reference: TopLevelRuleSetReference, ruleSetLineNumber: number): string {
  return `${lineNumberLabel(reference.lineNumber)}规则集 ${shortRuleSetName(reference.name)} 内第 ${ruleSetLineNumber} 行`;
}

function shortRuleSetName(name: string): string {
  const trimmed = name.trim();
  return trimmed.length <= 96 ? trimmed : `${trimmed.slice(0, 48)}...${trimmed.slice(-32)}`;
}

function ruleSetReferenceKey(reference: TopLevelRuleSetReference): string {
  return `${reference.type}\0${reference.name}\0${reference.policy}`;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isCommentLine(line: string): boolean {
  return line.startsWith("#") || line.startsWith(";") || line.startsWith("//");
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
  const valueError = validateRuleMatchValue(type, parts[1] || "");
  if (valueError) return `Surge Rule 第 ${lineNumber} 行${valueError}`;

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
  if (type === "AND" || type === "OR" || type === "NOT") {
    const logicalError = validateLogicalRuleExpression(type, parts[1] || "", validateSurgeLogicalLeaf);
    if (logicalError) return `Surge Rule 第 ${lineNumber} 行${logicalError}`;
  }
  const policyError = validatePolicy(parts[2] || "", knownPolicies);
  if (policyError) return `Surge Rule 第 ${lineNumber} 行${policyError}`;
  const optionError = validateRuleOptions(parts.slice(3), type);
  if (optionError) return `Surge Rule 第 ${lineNumber} 行${optionError}`;
  return null;
}

function validateSurgeLogicalLeaf(parts: string[]): string | null {
  const type = (parts[0] || "").trim().toUpperCase();
  if (!VALUE_RULE_TYPES.has(type) || type === "AND" || type === "OR" || type === "NOT") {
    return `逻辑子规则类型 ${type || "(空)"} 不受支持`;
  }
  if (!(parts[1] || "").trim()) return "逻辑子规则缺少匹配值";
  const valueError = validateRuleMatchValue(type, parts[1]!);
  if (valueError) return `逻辑子规则${valueError}`;
  const optionError = validateRuleOptions(parts.slice(2), type);
  return optionError ? `逻辑子规则${optionError}` : null;
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
  if (IP_RULE_TYPES.has(type)) return IP_RULE_OPTIONS;
  if (EXTENDED_MATCHING_RULE_TYPES.has(type)) return DOMAIN_SET_OPTIONS;
  return new Set();
}

function validatePolicy(policy: string, knownPolicies: Set<string>): string | null {
  const trimmed = policy.trim();
  if (!trimmed || /[\r\n,[\]]/.test(trimmed)) return "策略出口格式无效";
  if (!knownPolicies.has(trimmed) && !isSurgeDevicePolicy(trimmed)) return "策略出口必须是已配置策略组、Tailscale 节点或 Surge 内置策略";
  return null;
}

function isSurgeDevicePolicy(policy: string): boolean {
  return /^DEVICE:[^,\r\n[\]]+$/i.test(policy);
}
