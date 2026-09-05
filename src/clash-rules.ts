import YAML from "yaml";
import { parseClashRuleProvidersYaml, validateClashRuleProvidersYaml } from "./clash-rule-providers";
import { splitRuleLine } from "./rule-line";
import { validateLogicalRuleExpression } from "./logical-rules";
import {
  collectCoverageWarnings,
  CoverageWarningCollection,
  dedupeCoverageReferences,
  flattenResolvedCoverageEntries,
  type CoverageEntry,
  type CoverageRule
} from "./rule-coverage-core";
import type { RenderConfig, Target } from "./types";
import { mapWithConcurrency, readResponseTextWithLimit } from "./util";
import { CLASH_BUILT_IN_RULE_POLICIES, STASH_BUILT_IN_RULE_POLICIES } from "./rule-targets";
import { validateRuleMatchValue } from "./rule-value-validation";
import { fetchWithTimeout } from "./upstream-fetch";

const MAX_PROVIDER_CONTENT_BYTES = 2 * 1024 * 1024;
const MAX_EXTERNAL_PROVIDER_FETCHES = 24;
const PROVIDER_FETCH_CONCURRENCY = 3;
const PROVIDER_FETCH_TIMEOUT_MS = 2500;
const DEFAULT_MAX_COVERAGE_WARNINGS = 80;
const MAX_COVERAGE_SOURCE_CHARACTERS = 8 * 1024 * 1024;
const MAX_COVERAGE_RULES = 5_000;
const VALUELESS_RULE_TYPES = new Set(["MATCH", "FINAL"]);
const DOMAIN_RULE_TYPES = new Set(["DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD"]);
const IP_CIDR_RULE_TYPES = new Set(["IP-CIDR", "IP-CIDR6"]);
const EXACT_MATCH_RULE_TYPES = new Set([
  "GEOIP",
  "GEOSITE",
  "IP-ASN",
  "PROCESS-NAME",
  "PROCESS-PATH",
  "PROCESS-NAME-REGEX",
  "NETWORK",
  "DSCP",
  "IN-PORT",
  "SRC-PORT",
  "DST-PORT",
  "SRC-IP-CIDR",
  "SRC-IP-ASN",
  "RULE-SET",
  "AND",
  "OR",
  "NOT"
]);
const PROVIDER_VALUE_RULE_TYPES = new Set([
  ...DOMAIN_RULE_TYPES,
  ...IP_CIDR_RULE_TYPES,
  ...EXACT_MATCH_RULE_TYPES
]);
const NO_RESOLVE_RULE_TYPES = new Set(["RULE-SET", "GEOIP", "IP-CIDR", "IP-CIDR6", "IP-ASN"]);

type Fetcher = typeof fetch;
type ClashDiagnosticsTarget = "clash" | "stash";

export interface ClashRuleCoverageOptions {
  fetcher?: Fetcher;
  maxWarnings?: number;
  userAgent?: string;
}

interface RuleProviderInfo {
  name: string;
  type: string;
  behavior: string;
  url: string;
}

interface RuleSetReference {
  kind: "rule-set";
  name: string;
  policy: string;
  label: string;
}

export function validateClashLikeRules(config: RenderConfig, target: ClashDiagnosticsTarget, nodePolicies: Iterable<string> = []): string | null {
  const targetName = target === "stash" ? "Stash" : "Clash";
  const targetConfig = target === "stash" ? config.stash : config.clash;
  const providerError = validateClashRuleProvidersYaml(targetConfig.ruleProviders, targetName);
  if (providerError) return providerError;
  const providers = new Set(Object.keys(parseClashRuleProvidersYaml(targetConfig.ruleProviders)));
  const disabledGroups = new Set(config.disabledGroups);
  const policies = new Set([
    ...nodePolicies,
    ...Object.keys(config.groups).filter((name) => !disabledGroups.has(name)),
    ...(target === "stash" ? STASH_BUILT_IN_RULE_POLICIES : CLASH_BUILT_IN_RULE_POLICIES)
  ]);
  const effective: Array<{ type: string; lineNumber: number }> = [];

  for (const [index, rawRule] of targetConfig.rules.entries()) {
    const lineNumber = index + 1;
    const line = String(rawRule || "").trim();
    if (!line || line.startsWith("#")) continue;
    if (/^\[[^\]]+\]$/.test(line)) return `${targetName} Rule 第 ${lineNumber} 行不能包含配置段标题`;
    const parts = splitRuleLine(line);
    const type = (parts[0] || "").trim().toUpperCase();
    if (!type) return `${targetName} Rule 第 ${lineNumber} 行缺少规则类型`;
    if (parts.some((part) => !part.trim())) return `${targetName} Rule 第 ${lineNumber} 行存在空参数`;
    const valueError = validateRuleMatchValue(type, parts[1] || "");
    if (valueError) return `${targetName} Rule 第 ${lineNumber} 行${valueError}`;
    effective.push({ type, lineNumber });

    let policyIndex: number;
    let optionStart: number;
    if (type === "RULE-SET") {
      if (parts.length < 3) return `${targetName} Rule 第 ${lineNumber} 行规则集语法应为 RULE-SET,名称,策略`;
      if (!providers.has(parts[1]!.trim())) return `${targetName} Rule 第 ${lineNumber} 行引用了未配置的 rule-provider`;
      policyIndex = 2;
      optionStart = 3;
    } else if (VALUELESS_RULE_TYPES.has(type)) {
      if (parts.length < 2) return `${targetName} Rule 第 ${lineNumber} 行 ${type} 规则缺少策略出口`;
      policyIndex = 1;
      optionStart = 2;
    } else {
      if (!PROVIDER_VALUE_RULE_TYPES.has(type) && type !== "DOMAIN-REGEX") {
        return `${targetName} Rule 第 ${lineNumber} 行规则类型 ${type} 不受支持`;
      }
      if (parts.length < 3) return `${targetName} Rule 第 ${lineNumber} 行语法应为 类型,匹配值,策略`;
      policyIndex = 2;
      optionStart = 3;
    }

    if (type === "AND" || type === "OR" || type === "NOT") {
      const logicalError = validateLogicalRuleExpression(type, parts[1] || "", (leafParts) => (
        validateClashLogicalLeaf(leafParts, providers)
      ));
      if (logicalError) return `${targetName} Rule 第 ${lineNumber} 行${logicalError}`;
    }

    const policy = parts[policyIndex]!.trim();
    if (!policies.has(policy)) return `${targetName} Rule 第 ${lineNumber} 行策略出口不存在或不可用`;
    const options = parts.slice(optionStart).map((option) => option.trim().toLowerCase());
    if (new Set(options).size !== options.length) return `${targetName} Rule 第 ${lineNumber} 行附加参数不能重复`;
    if (options.some((option) => option !== "no-resolve") || (options.length > 0 && !NO_RESOLVE_RULE_TYPES.has(type))) {
      return `${targetName} Rule 第 ${lineNumber} 行附加参数不适用于 ${type}`;
    }
  }

  const fallbacks = effective.filter(({ type }) => VALUELESS_RULE_TYPES.has(type));
  if (fallbacks.length === 0) return `${targetName} Rule 必须保留一个 MATCH 或 FINAL 兜底规则`;
  if (fallbacks.length > 1) return `${targetName} Rule 只能保留一个 MATCH 或 FINAL 兜底规则`;
  if (!VALUELESS_RULE_TYPES.has(effective.at(-1)?.type ?? "")) return `${targetName} Rule 的兜底规则必须位于最后`;
  return null;
}

function validateClashLogicalLeaf(parts: string[], providers: Set<string>): string | null {
  const type = (parts[0] || "").trim().toUpperCase();
  if ((!PROVIDER_VALUE_RULE_TYPES.has(type) && type !== "DOMAIN-REGEX") || type === "AND" || type === "OR" || type === "NOT") {
    return `逻辑子规则类型 ${type || "(空)"} 不受支持`;
  }
  if (!(parts[1] || "").trim()) return "逻辑子规则缺少匹配值";
  const valueError = validateRuleMatchValue(type, parts[1]!);
  if (valueError) return `逻辑子规则${valueError}`;
  if (type === "RULE-SET" && !providers.has(parts[1]!.trim())) return "逻辑子规则引用了未配置的 rule-provider";

  const options = parts.slice(2).map((option) => option.trim().toLowerCase());
  if (new Set(options).size !== options.length) return "逻辑子规则附加参数不能重复";
  if (options.some((option) => option !== "no-resolve") || (options.length > 0 && !NO_RESOLVE_RULE_TYPES.has(type))) {
    return `逻辑子规则附加参数不适用于 ${type}`;
  }
  return null;
}

export async function collectClashRuleCoverageWarnings(
  config: Pick<RenderConfig, "settings" | "clash" | "stash">,
  target: ClashDiagnosticsTarget,
  options: ClashRuleCoverageOptions = {}
): Promise<string[]> {
  const targetConfig = target === "stash" ? config.stash : config.clash;
  const providerMap = parseClashRuleProvidersYaml(targetConfig.ruleProviders);
  const providers = new Map(Object.entries(providerMap).map(([name, provider]) => [name, normalizeProvider(name, provider)]));
  const ruleLines = addMissingRuleProviderRules(targetConfig.rules, [...providers.keys()]);
  const maxWarnings = Math.max(1, options.maxWarnings ?? DEFAULT_MAX_COVERAGE_WARNINGS);
  const collection = new CoverageWarningCollection(maxWarnings, diagnosticsName(target));
  const entries = await flattenRulesForCoverage(ruleLines, providers, config, target, options, collection);
  if (entries.length > MAX_COVERAGE_RULES) {
    collection.push(`${diagnosticsName(target)} Rule 覆盖诊断仅检查前 ${MAX_COVERAGE_RULES} 条规则。`);
  }
  collectCoverageWarnings(entries.slice(0, MAX_COVERAGE_RULES), collection, {
    targetName: diagnosticsName(target),
    valuelessRuleTypes: VALUELESS_RULE_TYPES,
    exactMatchRuleTypes: EXACT_MATCH_RULE_TYPES,
    normalizeDomainValue
  });

  return collection.messages;
}

async function flattenRulesForCoverage(
  lines: string[],
  providers: Map<string, RuleProviderInfo>,
  config: Pick<RenderConfig, "settings">,
  target: ClashDiagnosticsTarget,
  options: ClashRuleCoverageOptions,
  warnings: CoverageWarningCollection
): Promise<CoverageRule[]> {
  const parsed = lines.flatMap((line, index) => parseTopLevelRule(line, index + 1));
  const references = parsed.filter((entry): entry is RuleSetReference => entry.kind === "rule-set");
  const resolvedProviders = await resolveProviderReferences(references, providers, config, target, options, warnings);
  return flattenResolvedCoverageEntries(parsed, resolvedProviders, providerReferenceKey);
}

function parseTopLevelRule(line: string, lineNumber: number): Array<CoverageEntry<RuleSetReference>> {
  const trimmed = String(line || "").trim();
  if (!trimmed || isCommentLine(trimmed)) return [];
  const parts = splitRuleLine(trimmed);
  const type = (parts[0] || "").trim().toUpperCase();
  if (!type) return [];
  const label = `第 ${lineNumber} 行`;

  if (type === "RULE-SET") {
    const name = (parts[1] || "").trim();
    const policy = (parts[2] || "").trim();
    return name && policy ? [{ kind: "rule-set", name, policy, label }] : [];
  }

  const rule = parseCoverageRuleParts(parts, label);
  if (rule) return [rule];

  if (VALUELESS_RULE_TYPES.has(type)) {
    const policy = (parts[1] || "").trim();
    return policy ? [{ kind: "rule", type, value: "", policy, label }] : [];
  }

  if (type === "DOMAIN-REGEX") {
    const value = (parts[1] || "").trim();
    const policy = (parts[2] || "").trim();
    return value && policy ? [{ kind: "rule", type, value, policy, label }] : [];
  }
  return [];
}

async function resolveProviderReferences(
  references: RuleSetReference[],
  providers: Map<string, RuleProviderInfo>,
  config: Pick<RenderConfig, "settings">,
  target: ClashDiagnosticsTarget,
  options: ClashRuleCoverageOptions,
  warnings: CoverageWarningCollection
): Promise<Map<string, CoverageRule[]>> {
  const resolved = new Map<string, CoverageRule[]>();
  const unique = dedupeCoverageReferences(references, providerReferenceKey);
  const toFetch = unique.slice(0, MAX_EXTERNAL_PROVIDER_FETCHES);
  const skipped = unique.slice(MAX_EXTERNAL_PROVIDER_FETCHES);
  const targetName = diagnosticsName(target);
  if (skipped.length > 0) {
    warnings.push(`${targetName} Rule 覆盖诊断跳过 ${skipped.length} 个额外外部规则集；最多检查 ${MAX_EXTERNAL_PROVIDER_FETCHES} 个。`);
    for (const reference of skipped) resolved.set(providerReferenceKey(reference), []);
  }

  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const userAgent = options.userAgent ?? (target === "stash" ? config.settings.userAgentStash : config.settings.userAgentClash);
  let retainedCharacters = 0;
  let retainedRules = 0;
  await mapWithConcurrency(toFetch, PROVIDER_FETCH_CONCURRENCY, async (reference) => {
    const key = providerReferenceKey(reference);
    const provider = providers.get(reference.name);
    if (!provider) {
      warnings.push(`${targetName} Rule ${reference.label}规则集 ${reference.name} 未配置，内容未参与覆盖检查。`);
      resolved.set(key, []);
      return;
    }
    if (provider.type !== "http" || !provider.url) {
      warnings.push(`${targetName} Rule ${reference.label}规则集 ${reference.name} 不是可拉取的 HTTP 规则集，内容未参与覆盖检查。`);
      resolved.set(key, []);
      return;
    }
    try {
      if (retainedCharacters >= MAX_COVERAGE_SOURCE_CHARACTERS || retainedRules >= MAX_COVERAGE_RULES) {
        warnings.push(`${targetName} Rule ${reference.label}规则集 ${reference.name} 因覆盖诊断总量上限而跳过。`);
        resolved.set(key, []);
        return;
      }
      const content = await fetchProviderContent(provider.url, userAgent, fetcher);
      if (retainedCharacters + content.length > MAX_COVERAGE_SOURCE_CHARACTERS) {
        warnings.push(`${targetName} Rule ${reference.label}规则集 ${reference.name} 超出覆盖诊断 ${MAX_COVERAGE_SOURCE_CHARACTERS} 字符总量上限。`);
        resolved.set(key, []);
        return;
      }
      const parsed = parseProviderContentForCoverage(reference, provider, content);
      if (retainedRules + parsed.length > MAX_COVERAGE_RULES) {
        warnings.push(`${targetName} Rule ${reference.label}规则集 ${reference.name} 超出覆盖诊断 ${MAX_COVERAGE_RULES} 条规则总量上限。`);
        resolved.set(key, []);
        return;
      }
      retainedCharacters += content.length;
      retainedRules += parsed.length;
      resolved.set(key, parsed);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`${targetName} Rule ${reference.label}规则集 ${reference.name} 内容未参与覆盖检查：${reason}`);
      resolved.set(key, []);
    }
  });
  return resolved;
}

function parseProviderContentForCoverage(reference: RuleSetReference, provider: RuleProviderInfo, content: string): CoverageRule[] {
  const entries = readProviderPayloadEntries(content);
  if (provider.behavior === "domain") return parseDomainProviderEntries(reference, entries);
  if (provider.behavior === "ipcidr") return parseIpCidrProviderEntries(reference, entries);
  return parseClassicalProviderEntries(reference, entries);
}

function parseClassicalProviderEntries(reference: RuleSetReference, entries: string[]): CoverageRule[] {
  return entries.flatMap((entry, index) => {
    const trimmed = entry.trim();
    if (!trimmed || isCommentLine(trimmed)) return [];
    const parts = splitRuleLine(trimmed);
    const rule = parseProviderCoverageRuleParts(parts, ruleSetLineLabel(reference, index + 1), reference.policy);
    return rule ? [rule] : [];
  });
}

function parseDomainProviderEntries(reference: RuleSetReference, entries: string[]): CoverageRule[] {
  return entries.flatMap((entry, index) => {
    const value = entry.trim();
    if (!value || isCommentLine(value) || value.includes(",")) return [];
    const suffix = value.startsWith("+.") || value.startsWith("*.") || value.startsWith(".");
    const normalized = value.replace(/^\+\./, "").replace(/^\*\./, "").replace(/^\./, "");
    if (!normalized || normalized.includes("://")) return [];
    return [{
      kind: "rule" as const,
      type: suffix ? "DOMAIN-SUFFIX" : "DOMAIN",
      value: normalized,
      policy: reference.policy,
      label: ruleSetLineLabel(reference, index + 1)
    }];
  });
}

function parseIpCidrProviderEntries(reference: RuleSetReference, entries: string[]): CoverageRule[] {
  return entries.flatMap((entry, index) => {
    const value = entry.trim();
    if (!value || isCommentLine(value) || value.includes(",")) return [];
    return [{
      kind: "rule" as const,
      type: value.includes(":") ? "IP-CIDR6" : "IP-CIDR",
      value,
      policy: reference.policy,
      label: ruleSetLineLabel(reference, index + 1)
    }];
  });
}

function parseProviderCoverageRuleParts(parts: string[], label: string, policy: string): CoverageRule | null {
  const type = (parts[0] || "").trim().toUpperCase();
  if (!PROVIDER_VALUE_RULE_TYPES.has(type)) return null;
  const value = (parts[1] || "").trim();
  return value ? { kind: "rule", type, value, policy, label } : null;
}

function parseCoverageRuleParts(parts: string[], label: string): CoverageRule | null {
  const type = (parts[0] || "").trim().toUpperCase();
  if (VALUELESS_RULE_TYPES.has(type)) {
    const policy = (parts[1] || "").trim();
    return policy ? { kind: "rule", type, value: "", policy, label } : null;
  }
  if (!PROVIDER_VALUE_RULE_TYPES.has(type) && type !== "DOMAIN-REGEX") return null;
  const value = (parts[1] || "").trim();
  const policy = (parts[2] || "").trim();
  return value && policy ? { kind: "rule", type, value, policy, label } : null;
}

function readProviderPayloadEntries(content: string): string[] {
  try {
    const parsed = YAML.parse(content);
    if (Array.isArray(parsed)) return parsed.map(String);
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { payload?: unknown }).payload)) {
      return (parsed as { payload: unknown[] }).payload.map(String);
    }
  } catch {
    // Fall back to line-oriented parsing below.
  }
  return content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function normalizeProvider(name: string, value: Record<string, unknown>): RuleProviderInfo {
  return {
    name,
    type: String(value.type || "http").trim().toLowerCase(),
    behavior: String(value.behavior || "classical").trim().toLowerCase(),
    url: typeof value.url === "string" ? value.url.trim() : ""
  };
}

function addMissingRuleProviderRules(rules: string[], providerNames: string[]): string[] {
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

async function fetchProviderContent(url: string, userAgent: string, fetcher: Fetcher): Promise<string> {
  return fetchWithTimeout(fetcher, url, { headers: { "user-agent": userAgent } }, PROVIDER_FETCH_TIMEOUT_MS, async (response) => {
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`HTTP ${response.status}`);
    }
    return readResponseTextWithLimit(response, MAX_PROVIDER_CONTENT_BYTES, "rule provider");
  });
}

function ruleSetLineLabel(reference: RuleSetReference, ruleSetLineNumber: number): string {
  return `${reference.label}规则集 ${reference.name} 内第 ${ruleSetLineNumber} 行`;
}

function providerReferenceKey(reference: RuleSetReference): string {
  return `${reference.name}\0${reference.policy}`;
}

function normalizeDomainValue(value: string): string {
  return value.trim().toLowerCase().replace(/^\+\./, "").replace(/^\*\./, "").replace(/\.$/, "");
}

function diagnosticsName(target: ClashDiagnosticsTarget): string {
  return target === "stash" ? "Stash" : "Clash";
}

function isCommentLine(line: string): boolean {
  return line.startsWith("#") || line.startsWith(";") || line.startsWith("//");
}
