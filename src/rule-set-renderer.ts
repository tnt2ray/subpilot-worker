import { convertRule } from "./singbox-config";
import type { CompiledRuleSetRule } from "./rule-set-parser";
import { renderRuleSetRuleForTarget } from "./rule-targets";
import type { RuleSetBucket, RuleSetOutputTarget } from "./rule-set-types";

export function renderCompiledRuleSetBucket(
  rules: CompiledRuleSetRule[],
  bucket: RuleSetBucket,
  target: RuleSetOutputTarget
): string {
  const compatible = rules.flatMap((rule) => {
    const rendered = renderRuleSetRuleForTarget(rule.raw, target);
    return rendered ? [rendered === rule.raw ? rule : { ...rule, raw: rendered }] : [];
  });
  if (target === "sing-box") return renderSingboxRules(compatible);
  if (target === "surge") return renderSurgeRuleSetBucket(compatible, bucket);
  return renderClashLikeRuleSetBucket(compatible, bucket);
}

export function renderCombinedRuleSet(
  buckets: Record<RuleSetBucket, CompiledRuleSetRule[]>,
  target: RuleSetOutputTarget,
  options: { includesDomains: boolean; includesIpCidr: boolean }
): string {
  const rules = [
    ...(options.includesDomains ? buckets.domain : []),
    ...(options.includesIpCidr ? buckets.ipcidr : []),
    ...buckets.classical
  ].flatMap((rule) => {
    const rendered = renderRuleSetRuleForTarget(rule.raw, target);
    return rendered ? [rendered === rule.raw ? rule : { ...rule, raw: rendered }] : [];
  });
  if (target === "sing-box") return renderSingboxRules(rules);
  if (target === "surge") return `${rules.map((rule) => rule.raw).join("\n")}\n`;
  return renderYamlPayload(rules.map((rule) => rule.raw));
}

function renderSurgeRuleSetBucket(rules: CompiledRuleSetRule[], bucket: RuleSetBucket): string {
  const lines = bucket === "domain"
    ? rules.map(renderSurgeDomainSetLine)
    : rules.map((rule) => rule.raw);
  return `${lines.join("\n")}\n`;
}

function renderClashLikeRuleSetBucket(rules: CompiledRuleSetRule[], bucket: RuleSetBucket): string {
  const payload = bucket === "domain"
    ? rules.map(renderClashDomainPayloadLine)
    : bucket === "ipcidr"
      ? rules.map((rule) => rule.value)
      : rules.map((rule) => rule.raw);
  return renderYamlPayload(payload);
}

function renderYamlPayload(payload: string[]): string {
  // JSON string literals are valid YAML scalars and need no document-sized AST.
  return payload.length ? `payload:\n${payload.map((line) => `  - ${JSON.stringify(line)}`).join("\n")}\n` : "payload: []\n";
}

function renderSurgeDomainSetLine(rule: CompiledRuleSetRule): string {
  if (rule.type === "DOMAIN") return normalizeDomain(rule.value);
  return `.${normalizeDomain(rule.value)}`;
}

function renderClashDomainPayloadLine(rule: CompiledRuleSetRule): string {
  if (rule.clashDomainPattern) return rule.clashDomainPattern;
  if (rule.type === "DOMAIN") return normalizeDomain(rule.value);
  return `+.${normalizeDomain(rule.value)}`;
}

function normalizeDomain(value: string): string {
  return value.trim().replace(/^\+\./, "").replace(/^\*\./, "").replace(/^\./, "").replace(/\.$/, "").toLowerCase();
}

function renderSingboxRules(rules: CompiledRuleSetRule[]): string {
  return JSON.stringify({ version: 4, rules: rules.map((rule) => convertRule(rule.raw, true).rule) }, null, 2) + "\n";
}
