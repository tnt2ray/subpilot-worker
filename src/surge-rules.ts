import type { AppConfig } from "./types";

const VALUELESS_RULE_TYPES = new Set(["FINAL", "MATCH"]);
const RULE_SET_TYPES = new Set(["RULE-SET", "DOMAIN-SET"]);
const RULE_OPTION_ORDER = ["no-resolve", "extended-matching", "dns-failed"];
const RULE_SET_OPTIONS = new Set(["no-resolve", "extended-matching"]);
const DOMAIN_SET_OPTIONS = new Set(["extended-matching"]);
const IP_RULE_OPTIONS = new Set(["no-resolve"]);
const EXTENDED_MATCHING_RULE_TYPES = new Set(["DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "URL-REGEX"]);
const FINAL_RULE_OPTIONS = new Set(["dns-failed"]);
const MAX_RULE_SET_CONTENT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_COVERAGE_WARNINGS = 80;
const RULE_SET_FETCH_CONCURRENCY = 6;
const MAX_EXTERNAL_RULE_SET_FETCHES = 80;
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
const COVERAGE_VALUE_RULE_TYPES = new Set([
  ...VALUE_RULE_TYPES,
  "IP-ASN"
]);
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

export const SURGE_BUILT_IN_POLICIES = [
  "DIRECT",
  "REJECT",
  "REJECT-DROP",
  "REJECT-NO-DROP",
  "REJECT-TINYGIF"
] as const;

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

export async function collectSurgeRuleCoverageWarnings(
  config: Partial<Pick<AppConfig, "settings" | "surge">>,
  options: SurgeRuleCoverageOptions = {}
): Promise<string[]> {
  const rules = Array.isArray(config.surge?.rules) ? config.surge.rules : [];
  const maxWarnings = Math.max(1, options.maxWarnings ?? DEFAULT_MAX_COVERAGE_WARNINGS);
  const collection = new CoverageWarningCollection(maxWarnings);
  const entries = await flattenSurgeRulesForCoverage(config, rules, options, collection);
  const previousRules: CoverageRule[] = [];

  for (const entry of entries) {
    const cover = previousRules.find((previous) => ruleCoversRule(previous, entry));
    if (cover) {
      collection.push(formatCoverageWarning(entry, cover));
    }
    previousRules.push(entry);
  }

  return collection.messages;
}

class CoverageWarningCollection {
  readonly messages: string[] = [];
  private hidden = 0;

  constructor(private readonly maxWarnings: number) {}

  push(message: string): void {
    if (this.messages.length < this.maxWarnings) {
      this.messages.push(message);
      return;
    }
    this.hidden += this.hidden === 0 ? 2 : 1;
    const summary = `Surge Rule 覆盖诊断还有 ${this.hidden} 条提示未显示。`;
    const lastIndex = this.messages.length - 1;
    if (lastIndex >= 0 && this.messages[lastIndex]?.startsWith("Surge Rule 覆盖诊断还有 ")) {
      this.messages[lastIndex] = summary;
    } else if (lastIndex >= 0) {
      this.messages[lastIndex] = summary;
    }
  }
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
  const flattened: CoverageRule[] = [];

  for (const entry of parsed) {
    if (entry.kind === "rule") {
      flattened.push(entry);
      continue;
    }
    const resolved = resolvedRuleSets.get(ruleSetReferenceKey(entry));
    if (resolved) flattened.push(...resolved);
  }
  return flattened;
}

function parseTopLevelRuleForCoverage(line: string, lineNumber: number): Array<CoverageRule | TopLevelRuleSetReference> {
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
  const unique = dedupeRuleSetReferences(references);
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
  await mapWithConcurrency(toFetch, RULE_SET_FETCH_CONCURRENCY, async (reference) => {
    const key = ruleSetReferenceKey(reference);
    if (!isHttpUrl(reference.name)) {
      warnings.push(`${lineNumberLabel(reference.lineNumber)}规则集 ${shortRuleSetName(reference.name)} 不是 HTTP(S) 地址，内容未参与覆盖检查。`);
      resolved.set(key, []);
      return;
    }

    try {
      const content = await fetchRuleSetContent(reference.name, userAgent, fetcher);
      resolved.set(key, parseRuleSetContentForCoverage(reference, content));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`${lineNumberLabel(reference.lineNumber)}规则集 ${shortRuleSetName(reference.name)} 内容未参与覆盖检查：${reason}`);
      resolved.set(key, []);
    }
  });
  return resolved;
}

function dedupeRuleSetReferences(references: TopLevelRuleSetReference[]): TopLevelRuleSetReference[] {
  const selected = new Map<string, TopLevelRuleSetReference>();
  for (const reference of references) {
    selected.set(ruleSetReferenceKey(reference), reference);
  }
  return [...selected.values()];
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
    const normalized = value.startsWith(".") || value.startsWith("*.") ? value.replace(/^\*\./, "").replace(/^\./, "") : value;
    const type = value.startsWith(".") || value.startsWith("*.") ? "DOMAIN-SUFFIX" : "DOMAIN";
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
  const response = await fetcher(url, { headers: { "user-agent": userAgent } });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`HTTP ${response.status}`);
  }
  return readResponseTextWithLimit(response, MAX_RULE_SET_CONTENT_BYTES);
}

async function readResponseTextWithLimit(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) throw new Error(`rule-set exceeds ${formatBytes(maxBytes)} limit`);
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
      throw new Error(`rule-set exceeds ${formatBytes(maxBytes)} limit`);
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

function ruleCoversRule(previous: CoverageRule, current: CoverageRule): boolean {
  if (VALUELESS_RULE_TYPES.has(previous.type)) return true;
  if (VALUELESS_RULE_TYPES.has(current.type)) return false;
  if (isDomainRule(previous.type) && isDomainRule(current.type)) return domainRuleCovers(previous, current);
  if (isIpCidrRule(previous.type) && isIpCidrRule(current.type)) return ipRuleCovers(previous, current);
  if (EXACT_MATCH_RULE_TYPES.has(previous.type) && previous.type === current.type) {
    return normalizeExactValue(previous.value) === normalizeExactValue(current.value);
  }
  return false;
}

function domainRuleCovers(previous: CoverageRule, current: CoverageRule): boolean {
  const previousValue = normalizeDomainValue(previous.value);
  const currentValue = normalizeDomainValue(current.value);
  if (!previousValue || !currentValue) return false;

  if (previous.type === "DOMAIN") {
    return current.type === "DOMAIN" && previousValue === currentValue;
  }
  if (previous.type === "DOMAIN-SUFFIX") {
    if (current.type === "DOMAIN") return domainMatchesSuffix(currentValue, previousValue);
    if (current.type === "DOMAIN-SUFFIX") return suffixContainsSuffix(previousValue, currentValue);
    return false;
  }
  if (previous.type === "DOMAIN-KEYWORD") {
    return currentValue.includes(previousValue);
  }
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
  const prefix = prefixPart === undefined || prefixPart === ""
    ? totalBits
    : Number(prefixPart);
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
  const parts = compressedParts.length === 2
    ? [...head, ...Array.from({ length: missing }, () => "0"), ...tail]
    : head;
  if (parts.length !== 8) return null;

  let output = 0n;
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
    output = (output << 16n) + BigInt(Number.parseInt(part, 16));
  }
  return output;
}

function isDomainRule(type: string): boolean {
  return type === "DOMAIN" || type === "DOMAIN-SUFFIX" || type === "DOMAIN-KEYWORD";
}

function isIpCidrRule(type: string): boolean {
  return type === "IP-CIDR" || type === "IP-CIDR6";
}

function domainMatchesSuffix(domain: string, suffix: string): boolean {
  return domain === suffix || domain.endsWith(`.${suffix}`);
}

function suffixContainsSuffix(previousSuffix: string, currentSuffix: string): boolean {
  return currentSuffix === previousSuffix || currentSuffix.endsWith(`.${previousSuffix}`);
}

function normalizeDomainValue(value: string): string {
  return value.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
}

function normalizeExactValue(value: string): string {
  return value.trim().toLowerCase();
}

function formatCoverageWarning(current: CoverageRule, previous: CoverageRule): string {
  const matcherText = `${formatMatcher(previous)} 覆盖 ${formatMatcher(current)}`;
  if (current.policy === previous.policy) {
    return `Surge Rule ${current.label} 被前面的 ${previous.label} 覆盖（${matcherText}；策略同为 ${current.policy}，当前规则冗余）。`;
  }
  return `Surge Rule ${current.label} 被前面的 ${previous.label} 覆盖（${matcherText}；${previous.policy} 会优先生效，${current.policy} 不会生效）。`;
}

function formatMatcher(rule: CoverageRule): string {
  return VALUELESS_RULE_TYPES.has(rule.type) ? rule.type : `${rule.type},${rule.value}`;
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

function formatBytes(bytes: number): string {
  return `${Math.floor(bytes / 1024 / 1024)} MiB`;
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
