import YAML from "yaml";
import type { ParsedRuleSetRule } from "./rule-set-parser";
import type { RuleSetBucket, RuleSetOutputTarget } from "./rule-set-types";

export function renderCompiledRuleSetBucket(
  rules: ParsedRuleSetRule[],
  bucket: RuleSetBucket,
  target: RuleSetOutputTarget
): string {
  if (target === "surge") return renderSurgeRuleSetBucket(rules, bucket);
  return renderClashLikeRuleSetBucket(rules, bucket);
}

export function renderCombinedRuleSet(
  buckets: Record<RuleSetBucket, ParsedRuleSetRule[]>,
  target: RuleSetOutputTarget,
  options: { includesDomains: boolean; includesIpCidr: boolean }
): string {
  const rules = [
    ...(options.includesDomains ? buckets.domain : []),
    ...(options.includesIpCidr ? buckets.ipcidr : []),
    ...buckets.classical
  ];
  if (target === "surge") return `${rules.map((rule) => rule.raw).join("\n")}\n`;
  return YAML.stringify({ payload: rules.map((rule) => rule.raw) });
}

function renderSurgeRuleSetBucket(rules: ParsedRuleSetRule[], bucket: RuleSetBucket): string {
  const lines = bucket === "domain"
    ? rules.map(renderSurgeDomainSetLine)
    : rules.map((rule) => rule.raw);
  return `${lines.join("\n")}\n`;
}

function renderClashLikeRuleSetBucket(rules: ParsedRuleSetRule[], bucket: RuleSetBucket): string {
  const payload = bucket === "domain"
    ? rules.map(renderClashDomainPayloadLine)
    : bucket === "ipcidr"
      ? rules.map((rule) => rule.value)
      : rules.map((rule) => rule.raw);
  return YAML.stringify({ payload });
}

function renderSurgeDomainSetLine(rule: ParsedRuleSetRule): string {
  if (rule.type === "DOMAIN") return normalizeDomain(rule.value);
  return `.${normalizeDomain(rule.value)}`;
}

function renderClashDomainPayloadLine(rule: ParsedRuleSetRule): string {
  if (rule.type === "DOMAIN") return normalizeDomain(rule.value);
  return `+.${normalizeDomain(rule.value)}`;
}

function normalizeDomain(value: string): string {
  return value.trim().replace(/^\+\./, "").replace(/^\*\./, "").replace(/^\./, "").replace(/\.$/, "").toLowerCase();
}
