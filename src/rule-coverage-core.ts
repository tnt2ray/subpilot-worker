import { parseIpRange } from "./ip-range";

const DEFAULT_DOMAIN_RULE_TYPES = new Set(["DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD"]);
const DEFAULT_IP_CIDR_RULE_TYPES = new Set(["IP-CIDR", "IP-CIDR6"]);

export interface CoverageRule {
  kind: "rule";
  type: string;
  value: string;
  policy: string;
  label: string;
}

export type CoverageEntry<Reference> = CoverageRule | Reference;

export interface RuleCoverageConfig {
  targetName: string;
  valuelessRuleTypes: ReadonlySet<string>;
  exactMatchRuleTypes: ReadonlySet<string>;
  domainRuleTypes?: ReadonlySet<string>;
  ipCidrRuleTypes?: ReadonlySet<string>;
  normalizeDomainValue?: (value: string) => string;
}

export class CoverageWarningCollection {
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

export function collectCoverageWarnings(
  entries: CoverageRule[],
  warnings: CoverageWarningCollection,
  config: RuleCoverageConfig
): void {
  const previousRules: CoverageRule[] = [];
  for (const entry of entries) {
    const cover = previousRules.find((previous) => ruleCoversRule(previous, entry, config));
    if (cover) warnings.push(formatCoverageWarning(entry, cover, config));
    previousRules.push(entry);
  }
}

export function dedupeCoverageReferences<Reference>(
  references: Reference[],
  referenceKey: (reference: Reference) => string
): Reference[] {
  const selected = new Map<string, Reference>();
  for (const reference of references) selected.set(referenceKey(reference), reference);
  return [...selected.values()];
}

export function flattenResolvedCoverageEntries<Reference>(
  entries: Array<CoverageEntry<Reference>>,
  resolved: Map<string, CoverageRule[]>,
  referenceKey: (reference: Reference) => string
): CoverageRule[] {
  const flattened: CoverageRule[] = [];
  for (const entry of entries) {
    if (isCoverageRule(entry)) {
      flattened.push(entry);
      continue;
    }
    const resolvedRules = resolved.get(referenceKey(entry));
    if (resolvedRules) flattened.push(...resolvedRules);
  }
  return flattened;
}

function isCoverageRule<Reference>(entry: CoverageEntry<Reference>): entry is CoverageRule {
  return typeof entry === "object" && entry !== null && (entry as { kind?: unknown }).kind === "rule";
}

function ruleCoversRule(previous: CoverageRule, current: CoverageRule, config: RuleCoverageConfig): boolean {
  if (config.valuelessRuleTypes.has(previous.type)) return true;
  if (config.valuelessRuleTypes.has(current.type)) return false;
  const domainRuleTypes = config.domainRuleTypes ?? DEFAULT_DOMAIN_RULE_TYPES;
  const ipCidrRuleTypes = config.ipCidrRuleTypes ?? DEFAULT_IP_CIDR_RULE_TYPES;
  if (domainRuleTypes.has(previous.type) && domainRuleTypes.has(current.type)) return domainRuleCovers(previous, current, config);
  if (ipCidrRuleTypes.has(previous.type) && ipCidrRuleTypes.has(current.type)) return ipRuleCovers(previous, current);
  if (config.exactMatchRuleTypes.has(previous.type) && previous.type === current.type) {
    return normalizeExactValue(previous.value) === normalizeExactValue(current.value);
  }
  return false;
}

function domainRuleCovers(previous: CoverageRule, current: CoverageRule, config: RuleCoverageConfig): boolean {
  const normalizeDomainValue = config.normalizeDomainValue ?? defaultNormalizeDomainValue;
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

function formatCoverageWarning(current: CoverageRule, previous: CoverageRule, config: RuleCoverageConfig): string {
  const matcherText = `${formatMatcher(previous, config)} 覆盖 ${formatMatcher(current, config)}`;
  if (current.policy === previous.policy) {
    return `${config.targetName} Rule ${current.label} 被前面的 ${previous.label} 覆盖（${matcherText}；策略同为 ${current.policy}，当前规则冗余）。`;
  }
  return `${config.targetName} Rule ${current.label} 被前面的 ${previous.label} 覆盖（${matcherText}；${previous.policy} 会优先生效，${current.policy} 不会生效）。`;
}

function formatMatcher(rule: CoverageRule, config: RuleCoverageConfig): string {
  return config.valuelessRuleTypes.has(rule.type) ? rule.type : `${rule.type},${rule.value}`;
}

function domainMatchesSuffix(domain: string, suffix: string): boolean {
  return domain === suffix || domain.endsWith(`.${suffix}`);
}

function suffixContainsSuffix(previousSuffix: string, currentSuffix: string): boolean {
  return currentSuffix === previousSuffix || currentSuffix.endsWith(`.${previousSuffix}`);
}

function defaultNormalizeDomainValue(value: string): string {
  return value.trim().toLowerCase().replace(/^\+\./, "").replace(/^\*\./, "").replace(/\.$/, "");
}

function normalizeExactValue(value: string): string {
  return value.trim().toLowerCase();
}
