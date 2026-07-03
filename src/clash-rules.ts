import YAML from "yaml";
import { parseClashRuleProvidersYaml } from "./clash-rule-providers";
import type { AppConfig, Target } from "./types";

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

interface CoverageRule {
  kind: "rule";
  type: string;
  value: string;
  policy: string;
  label: string;
}

interface IpRange {
  family: 4 | 6;
  start: bigint;
  end: bigint;
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
  const previousRules: CoverageRule[] = [];

  for (const entry of entries) {
    const cover = previousRules.find((previous) => ruleCoversRule(previous, entry));
    if (cover) collection.push(formatCoverageWarning(diagnosticsName(target), entry, cover));
    previousRules.push(entry);
  }

  return collection.messages;
}

class CoverageWarningCollection {
  readonly messages: string[] = [];
  private hidden = 0;

  constructor(private readonly maxWarnings: number, private readonly targetName: string) {}

  push(message: string): void {
    if (this.messages.length < this.maxWarnings) {
      this.messages.push(message);
      return;
    }
    this.hidden += this.hidden === 0 ? 2 : 1;
    const summary = `${this.targetName} Rule 覆盖诊断还有 ${this.hidden} 条提示未显示。`;
    const lastIndex = this.messages.length - 1;
    if (lastIndex >= 0) this.messages[lastIndex] = summary;
  }
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
  const flattened: CoverageRule[] = [];

  for (const entry of parsed) {
    if (entry.kind === "rule") {
      flattened.push(entry);
      continue;
    }
    const resolved = resolvedProviders.get(providerReferenceKey(entry));
    if (resolved) flattened.push(...resolved);
  }
  return flattened;
}

function parseTopLevelRule(line: string, lineNumber: number): Array<CoverageRule | RuleSetReference> {
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
  const unique = dedupeProviderReferences(references);
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
  return readResponseTextWithLimit(response, MAX_PROVIDER_CONTENT_BYTES);
}

async function readResponseTextWithLimit(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) throw new Error(`rule provider exceeds ${formatBytes(maxBytes)} limit`);
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`rule provider exceeds ${formatBytes(maxBytes)} limit`);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, callback: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      if (item !== undefined) await callback(item);
    }
  });
  await Promise.all(workers);
}

function dedupeProviderReferences(references: RuleSetReference[]): RuleSetReference[] {
  const selected = new Map<string, RuleSetReference>();
  for (const reference of references) selected.set(providerReferenceKey(reference), reference);
  return [...selected.values()];
}

function ruleCoversRule(previous: CoverageRule, current: CoverageRule): boolean {
  if (VALUELESS_RULE_TYPES.has(previous.type)) return true;
  if (VALUELESS_RULE_TYPES.has(current.type)) return false;
  if (DOMAIN_RULE_TYPES.has(previous.type) && DOMAIN_RULE_TYPES.has(current.type)) return domainRuleCovers(previous, current);
  if (IP_CIDR_RULE_TYPES.has(previous.type) && IP_CIDR_RULE_TYPES.has(current.type)) return ipRuleCovers(previous, current);
  if (EXACT_MATCH_RULE_TYPES.has(previous.type) && previous.type === current.type) {
    return normalizeExactValue(previous.value) === normalizeExactValue(current.value);
  }
  return false;
}

function domainRuleCovers(previous: CoverageRule, current: CoverageRule): boolean {
  const previousValue = normalizeDomainValue(previous.value);
  const currentValue = normalizeDomainValue(current.value);
  if (!previousValue || !currentValue) return false;
  if (previous.type === "DOMAIN") return current.type === "DOMAIN" && previousValue === currentValue;
  if (previous.type === "DOMAIN-SUFFIX") {
    if (current.type === "DOMAIN") return currentValue === previousValue || currentValue.endsWith(`.${previousValue}`);
    if (current.type === "DOMAIN-SUFFIX") return currentValue === previousValue || currentValue.endsWith(`.${previousValue}`);
  }
  if (previous.type === "DOMAIN-KEYWORD") return currentValue.includes(previousValue);
  return false;
}

function ipRuleCovers(previous: CoverageRule, current: CoverageRule): boolean {
  const previousRange = parseIpRange(previous.type, previous.value);
  const currentRange = parseIpRange(current.type, current.value);
  return Boolean(previousRange && currentRange
    && previousRange.family === currentRange.family
    && previousRange.start <= currentRange.start
    && previousRange.end >= currentRange.end);
}

function parseIpRange(type: string, value: string): IpRange | null {
  const family = type === "IP-CIDR6" ? 6 : 4;
  const totalBits = family === 6 ? 128 : 32;
  const [addressPart = "", prefixPart] = value.trim().split("/", 2);
  const address = family === 6 ? parseIPv6Address(addressPart) : parseIPv4Address(addressPart);
  if (address === null) return null;
  const prefix = prefixPart === undefined || prefixPart === "" ? totalBits : Number(prefixPart);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > totalBits) return null;
  const blockSize = 1n << BigInt(totalBits - prefix);
  const start = (address / blockSize) * blockSize;
  return { family, start, end: start + blockSize - 1n };
}

function parseIPv4Address(value: string): bigint | null {
  const parts = value.trim().split(".");
  if (parts.length !== 4) return null;
  let output = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const number = Number(part);
    if (number < 0 || number > 255) return null;
    output = (output << 8n) + BigInt(number);
  }
  return output;
}

function parseIPv6Address(value: string): bigint | null {
  const address = value.trim().toLowerCase();
  if (!address || address.includes(".")) return null;
  const compressedParts = address.split("::");
  if (compressedParts.length > 2) return null;
  const head = compressedParts[0] ? compressedParts[0].split(":") : [];
  const tail = compressedParts.length === 2 && compressedParts[1] ? compressedParts[1].split(":") : [];
  const missing = compressedParts.length === 2 ? 8 - head.length - tail.length : 0;
  if (missing < 0) return null;
  const parts = compressedParts.length === 2 ? [...head, ...Array.from({ length: missing }, () => "0"), ...tail] : head;
  if (parts.length !== 8) return null;
  let output = 0n;
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
    output = (output << 16n) + BigInt(Number.parseInt(part, 16));
  }
  return output;
}

function formatCoverageWarning(targetName: string, current: CoverageRule, previous: CoverageRule): string {
  const matcherText = `${formatMatcher(previous)} 覆盖 ${formatMatcher(current)}`;
  if (current.policy === previous.policy) {
    return `${targetName} Rule ${current.label} 被前面的 ${previous.label} 覆盖（${matcherText}；策略同为 ${current.policy}，当前规则冗余）。`;
  }
  return `${targetName} Rule ${current.label} 被前面的 ${previous.label} 覆盖（${matcherText}；${previous.policy} 会优先生效，${current.policy} 不会生效）。`;
}

function formatMatcher(rule: CoverageRule): string {
  return VALUELESS_RULE_TYPES.has(rule.type) ? rule.type : `${rule.type},${rule.value}`;
}

function ruleSetLineLabel(reference: RuleSetReference, ruleSetLineNumber: number): string {
  return `${reference.label}规则集 ${reference.name} 内第 ${ruleSetLineNumber} 行`;
}

function providerReferenceKey(reference: RuleSetReference): string {
  return `${reference.name}\0${reference.policy}`;
}

function splitRuleLine(line: string): string[] {
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

function normalizeDomainValue(value: string): string {
  return value.trim().toLowerCase().replace(/^\+\./, "").replace(/^\*\./, "").replace(/\.$/, "");
}

function normalizeExactValue(value: string): string {
  return value.trim().toLowerCase();
}

function diagnosticsName(target: ClashDiagnosticsTarget): string {
  return target === "stash" ? "Stash" : "Clash";
}

function isCommentLine(line: string): boolean {
  return line.startsWith("#") || line.startsWith(";") || line.startsWith("//");
}

function formatBytes(bytes: number): string {
  return `${Math.floor(bytes / 1024 / 1024)} MiB`;
}
