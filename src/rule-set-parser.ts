import YAML from "yaml";
import { splitRuleLine } from "./rule-line";
import type { RuleSetBucket, RuleSetSourceFormat } from "./rule-set-types";

const DOMAIN_RULE_TYPES = new Set(["DOMAIN", "DOMAIN-SUFFIX"]);
const IPCIDR_RULE_TYPES = new Set(["IP-CIDR", "IP-CIDR6"]);
const SKIPPED_EXTERNAL_RULE_TYPES = new Set(["RULE-SET", "DOMAIN-SET", "FINAL", "MATCH"]);
const IP_RULE_OPTIONS = new Set(["no-resolve"]);

export interface ParsedRuleSetRule {
  type: string;
  value: string;
  bucket: RuleSetBucket;
  raw: string;
  normalizedKey: string;
  label: string;
}

export interface ParseRuleSetResult {
  rules: ParsedRuleSetRule[];
  warnings: string[];
}

interface ParseLineOptions {
  sourceLabel: string;
  lineNumber: number;
  defaultFormat: RuleSetSourceFormat;
}

export function parseRuleSetContent(content: string, format: RuleSetSourceFormat, sourceLabel: string): ParseRuleSetResult {
  const selectedFormat = inferRuleSetFormat(content, format);
  if (selectedFormat === "clash-yaml") return parseClashYamlRuleSet(content, sourceLabel);
  if (selectedFormat === "surge-domain-set" || selectedFormat === "plain-domain") {
    return parsePlainRuleSetLines(content, sourceLabel, "plain-domain");
  }
  if (selectedFormat === "plain-ipcidr") return parsePlainRuleSetLines(content, sourceLabel, "plain-ipcidr");
  if (selectedFormat === "plain-classical") return parsePlainRuleSetLines(content, sourceLabel, "plain-classical");
  return parsePlainRuleSetLines(content, sourceLabel, "surge-rule-set");
}

export function parseInlineRuleSetLines(lines: string[], sourceLabel: string): ParseRuleSetResult {
  const rules: ParsedRuleSetRule[] = [];
  const warnings: string[] = [];
  lines.forEach((line, index) => {
    const parsed = parseRuleLineForRuleSet(line, {
      sourceLabel,
      lineNumber: index + 1,
      defaultFormat: "surge-rule-set"
    });
    if (parsed.rule) rules.push(parsed.rule);
    if (parsed.warning) warnings.push(parsed.warning);
  });
  return { rules, warnings };
}

function inferRuleSetFormat(content: string, format: RuleSetSourceFormat): RuleSetSourceFormat {
  if (format !== "auto") return format;
  const trimmed = content.trimStart();
  if (/^(payload|rules|rule-providers)\s*:/m.test(trimmed) || trimmed.startsWith("- ")) return "clash-yaml";
  const effectiveLines = content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !isCommentLine(line));
  if (effectiveLines.length > 0 && effectiveLines.every((line) => !line.includes(",") && looksLikeDomain(line))) return "plain-domain";
  if (effectiveLines.length > 0 && effectiveLines.every((line) => !line.includes(",") && looksLikeCidr(line))) return "plain-ipcidr";
  return "surge-rule-set";
}

function parseClashYamlRuleSet(content: string, sourceLabel: string): ParseRuleSetResult {
  const parsed = YAML.parse(content);
  const payload = clashPayload(parsed);
  if (!Array.isArray(payload)) {
    return { rules: [], warnings: [`${sourceLabel}: Clash YAML 缺少 payload 数组。`] };
  }
  const behavior = clashBehavior(parsed);
  const defaultFormat = behavior === "domain"
    ? "plain-domain"
    : behavior === "ipcidr"
      ? "plain-ipcidr"
      : "plain-classical";
  const rules: ParsedRuleSetRule[] = [];
  const warnings: string[] = [];
  payload.forEach((item, index) => {
    if (typeof item !== "string") return;
    const parsedLine = parseRuleLineForRuleSet(item, {
      sourceLabel,
      lineNumber: index + 1,
      defaultFormat
    });
    if (parsedLine.rule) rules.push(parsedLine.rule);
    if (parsedLine.warning) warnings.push(parsedLine.warning);
  });
  return { rules, warnings };
}

function parsePlainRuleSetLines(content: string, sourceLabel: string, defaultFormat: RuleSetSourceFormat): ParseRuleSetResult {
  const rules: ParsedRuleSetRule[] = [];
  const warnings: string[] = [];
  content.split(/\r?\n/).forEach((line, index) => {
    const parsed = parseRuleLineForRuleSet(line, {
      sourceLabel,
      lineNumber: index + 1,
      defaultFormat
    });
    if (parsed.rule) rules.push(parsed.rule);
    if (parsed.warning) warnings.push(parsed.warning);
  });
  return { rules, warnings };
}

function parseRuleLineForRuleSet(line: string, options: ParseLineOptions): { rule?: ParsedRuleSetRule; warning?: string } {
  const trimmed = String(line || "").trim();
  if (!trimmed || isCommentLine(trimmed) || /^\[[^\]]+\]$/.test(trimmed)) return {};

  if (!trimmed.includes(",")) {
    if ((options.defaultFormat === "plain-domain" || options.defaultFormat === "surge-domain-set") && looksLikeDomain(trimmed)) {
      return { rule: parsedRule("DOMAIN-SUFFIX", normalizeDomainSetValue(trimmed), options, "domain") };
    }
    if (options.defaultFormat === "plain-ipcidr" && looksLikeCidr(trimmed)) {
      return { rule: parsedRule(trimmed.includes(":") ? "IP-CIDR6" : "IP-CIDR", trimmed, options, "ipcidr") };
    }
    if (looksLikeDomain(trimmed)) return { rule: parsedRule("DOMAIN-SUFFIX", normalizeDomainSetValue(trimmed), options, "domain") };
    if (looksLikeCidr(trimmed)) return { rule: parsedRule(trimmed.includes(":") ? "IP-CIDR6" : "IP-CIDR", trimmed, options, "ipcidr") };
    return { warning: `${lineLabel(options)}无法识别为可编译规则。` };
  }

  const parts = splitRuleLine(trimmed);
  const type = (parts[0] || "").trim().toUpperCase();
  const value = (parts[1] || "").trim();
  if (!type || !value) return { warning: `${lineLabel(options)}规则缺少类型或内容。` };
  if (SKIPPED_EXTERNAL_RULE_TYPES.has(type)) return { warning: `${lineLabel(options)}${type} 应作为主配置规则保存，不进入外部规则集。` };
  const bucket = bucketForRuleType(type);
  const raw = ruleWithoutPolicy(parts, bucket);
  return {
    rule: {
      type,
      value,
      bucket,
      raw,
      normalizedKey: normalizedRuleKey(type, value, raw, bucket),
      label: lineLabel(options)
    }
  };
}

function parsedRule(type: string, value: string, options: ParseLineOptions, bucket: RuleSetBucket): ParsedRuleSetRule {
  const raw = `${type},${value}`;
  return {
    type,
    value,
    bucket,
    raw,
    normalizedKey: normalizedRuleKey(type, value, raw, bucket),
    label: lineLabel(options)
  };
}

function bucketForRuleType(type: string): RuleSetBucket {
  if (DOMAIN_RULE_TYPES.has(type)) return "domain";
  if (IPCIDR_RULE_TYPES.has(type)) return "ipcidr";
  return "classical";
}

function ruleWithoutPolicy(parts: string[], bucket: RuleSetBucket): string {
  const normalized = parts.map((part) => part.trim()).filter(Boolean);
  if (normalized.length <= 2) return normalized.join(",");
  if (bucket === "ipcidr" && IP_RULE_OPTIONS.has((normalized[2] || "").toLowerCase())) {
    return normalized.join(",");
  }
  return [normalized[0], normalized[1], ...normalized.slice(3)].join(",");
}

function normalizedRuleKey(type: string, value: string, raw: string, bucket: RuleSetBucket): string {
  if (bucket === "domain") return `${bucket}\0${type}\0${normalizeDomainValue(value)}`;
  if (bucket === "ipcidr") return `${bucket}\0${type}\0${value.trim().toLowerCase()}`;
  return `${bucket}\0${raw.trim().replace(/\s*,\s*/g, ",").toUpperCase()}`;
}

function clashPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.payload)) return record.payload;
  if (Array.isArray(record.rules)) return record.rules;
  return [];
}

function clashBehavior(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const behavior = (value as Record<string, unknown>).behavior;
  return typeof behavior === "string" ? behavior.trim().toLowerCase() : "";
}

function normalizeDomainSetValue(value: string): string {
  return value.trim().replace(/^\+\./, "").replace(/^\*\./, "").replace(/^\./, "").replace(/\.$/, "");
}

function normalizeDomainValue(value: string): string {
  return normalizeDomainSetValue(value).toLowerCase();
}

function looksLikeDomain(value: string): boolean {
  const normalized = normalizeDomainSetValue(value);
  return /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(normalized) && !normalized.includes("://");
}

function looksLikeCidr(value: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(value.trim())
    || /^[0-9a-f:]+\/\d{1,3}$/i.test(value.trim());
}

function isCommentLine(line: string): boolean {
  return line.startsWith("#") || line.startsWith(";") || line.startsWith("//");
}

function lineLabel(options: ParseLineOptions): string {
  return `${options.sourceLabel} 第 ${options.lineNumber} 行`;
}
