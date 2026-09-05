import { convertRule } from "./singbox-config";
import YAML from "yaml";
import type { ParsedRuleSetRule } from "./rule-set-parser";
import { renderRuleSetRuleForTarget } from "./rule-targets";
import type { RuleSetBucket, RuleSetOutputTarget } from "./rule-set-types";

export function renderCompiledRuleSetBucket(
  rules: ParsedRuleSetRule[],
  bucket: RuleSetBucket,
  target: RuleSetOutputTarget
): string {
  const compatible = rules.flatMap((rule) => {
    const rendered = renderRuleSetRuleForTarget(rule.raw, target);
    return rendered ? [{ ...rule, raw: rendered }] : [];
  });
  if (target === "sing-box") return renderSingboxRules(compatible);
  if (target === "surge") return renderSurgeRuleSetBucket(compatible, bucket);
  return renderClashLikeRuleSetBucket(compatible, bucket);
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
  ].flatMap((rule) => {
    const rendered = renderRuleSetRuleForTarget(rule.raw, target);
    return rendered ? [{ ...rule, raw: rendered }] : [];
  });
  if (target === "sing-box") return renderSingboxRules(rules);
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
  if (rule.clashDomainPattern) return rule.clashDomainPattern;
  if (rule.type === "DOMAIN") return normalizeDomain(rule.value);
  return `+.${normalizeDomain(rule.value)}`;
}

function normalizeDomain(value: string): string {
  return value.trim().replace(/^\+\./, "").replace(/^\*\./, "").replace(/^\./, "").replace(/\.$/, "").toLowerCase();
}

function renderSingboxRules(rules: ParsedRuleSetRule[]): string {
  return JSON.stringify({ version: 4, rules: rules.map((rule) => convertRule(rule.raw, true).rule) }, null, 2) + "\n";
}
