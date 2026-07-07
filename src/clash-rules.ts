import YAML from "yaml";
import { parseClashRuleProvidersYaml } from "./clash-rule-providers";
import { splitRuleLine } from "./rule-line";
import {
  collectCoverageWarnings,
  CoverageWarningCollection,
  dedupeCoverageReferences,
  flattenResolvedCoverageEntries,
  type CoverageEntry,
  type CoverageRule
} from "./rule-coverage-core";
import type { AppConfig, Target } from "./types";
import { mapWithConcurrency, readResponseTextWithLimit } from "./util";

const MAX_PROVIDER_CONTENT_BYTES = 2 * 1024 * 1024;
const MAX_EXTERNAL_PROVIDER_FETCHES = 80;
const PROVIDER_FETCH_CONCURRENCY = 6;
const PROVIDER_FETCH_TIMEOUT_MS = 2500;
const DEFAULT_MAX_COVERAGE_WARNINGS = 80;
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

type Fetcher = typeof fetch;
type ClashDiagnosticsTarget = Extract<Target, "clash" | "stash">;

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

export async function collectClashRuleCoverageWarnings(
  config: Pick<AppConfig, "settings" | "clash" | "stash">,
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
  collectCoverageWarnings(entries, collection, {
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
  config: Pick<AppConfig, "settings">,
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
  config: Pick<AppConfig, "settings">,
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
  const userAgent = options.userAgent ?? config.settings.userAgentClash;
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
      const content = await fetchProviderContent(provider.url, userAgent, fetcher);
      resolved.set(key, parseProviderContentForCoverage(reference, provider, content));
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetcher(url, { headers: { "user-agent": userAgent }, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error("fetch timeout");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`HTTP ${response.status}`);
  }
  return readResponseTextWithLimit(response, MAX_PROVIDER_CONTENT_BYTES, "rule provider");
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
