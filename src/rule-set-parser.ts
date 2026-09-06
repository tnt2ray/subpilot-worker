import YAML from "yaml";
import { isNativeClashRule } from "./rule-targets";
import { splitRuleLine } from "./rule-line";
import { isValidCidrForRuleType, looksLikeCidr } from "./rule-value-validation";
import type { RuleSetBucket, RuleSetSourceFormat } from "./rule-set-types";

const DOMAIN_RULE_TYPES = new Set(["DOMAIN", "DOMAIN-SUFFIX"]);
const IPCIDR_RULE_TYPES = new Set(["IP-CIDR", "IP-CIDR6"]);
const IP_OPTION_RULE_TYPES = new Set([...IPCIDR_RULE_TYPES, "GEOIP", "IP-ASN"]);
const SKIPPED_EXTERNAL_RULE_TYPES = new Set(["RULE-SET", "DOMAIN-SET", "FINAL", "MATCH"]);
const IP_RULE_OPTIONS = new Set(["no-resolve", "src"]);

export interface ParsedRuleSetRule {
  type: string;
  value: string;
  bucket: RuleSetBucket;
  raw: string;
  normalizedKey: string;
  label: string;
  /** Original normalized Clash domain-provider pattern when its semantics cannot be represented by DOMAIN/DOMAIN-SUFFIX. */
  clashDomainPattern?: string | undefined;
}

export interface ParseRuleSetResult {
  rules: ParsedRuleSetRule[];
  warnings: string[];
}

export type CompiledRuleSetRule = Pick<ParsedRuleSetRule, "type" | "value" | "raw" | "clashDomainPattern">;
type RuleVisitor = (rule: ParsedRuleSetRule) => void;

interface ParseLineOptions {
  sourceLabel: string;
  lineNumber: number;
  defaultFormat: RuleSetSourceFormat;
  clashOnly?: boolean;
}

export function parseRuleSetContent(content: string, format: RuleSetSourceFormat, sourceLabel: string, visit?: RuleVisitor, clashOnly = false): ParseRuleSetResult {
  if (clashOnly && format.startsWith("surge-")) return { rules: [], warnings: [`${sourceLabel}: Clash 不支持 Surge 来源格式。`] };
  const inferred = inferRuleSetFormat(content, format);
  const selectedFormat = clashOnly && inferred === "surge-rule-set" ? "plain-classical" : inferred;
  if (selectedFormat === "clash-yaml") return parseClashYamlRuleSet(content, sourceLabel, visit, clashOnly);
  if (selectedFormat === "surge-domain-set") return parsePlainRuleSetLines(content, sourceLabel, "surge-domain-set", visit, clashOnly);
  if (selectedFormat === "plain-domain") return parsePlainRuleSetLines(content, sourceLabel, "plain-domain", visit, clashOnly);
  if (selectedFormat === "plain-ipcidr") return parsePlainRuleSetLines(content, sourceLabel, "plain-ipcidr", visit, clashOnly);
  if (selectedFormat === "plain-classical") return parsePlainRuleSetLines(content, sourceLabel, "plain-classical", visit, clashOnly);
  return parsePlainRuleSetLines(content, sourceLabel, "surge-rule-set", visit, clashOnly);
}

export function parseInlineRuleSetLines(lines: string[], sourceLabel: string, visit?: RuleVisitor, clashOnly = false): ParseRuleSetResult {
  const rules: ParsedRuleSetRule[] = [];
  const warnings: string[] = [];
  lines.forEach((line, index) => {
    const parsed = parseRuleLineForRuleSet(line, {
      sourceLabel,
      lineNumber: index + 1,
      defaultFormat: clashOnly ? "plain-classical" : "surge-rule-set",
      clashOnly
    });
    if (parsed.rule) { if (visit) visit(parsed.rule); else rules.push(parsed.rule); }
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

function parseClashYamlRuleSet(content: string, sourceLabel: string, visit?: RuleVisitor, clashOnly = false): ParseRuleSetResult {
  const parsed = parseQuotedClashPayload(content) ?? YAML.parse(content);
  const payload = clashOnly ? (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).payload : undefined) : clashPayload(parsed);
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
    if (typeof item !== "string") { if (clashOnly) warnings.push(`${sourceLabel}: payload 第 ${index + 1} 项必须是字符串。`); return; }
    const parsedLine = parseRuleLineForRuleSet(item, {
      sourceLabel,
      lineNumber: index + 1,
      defaultFormat,
      clashOnly
    });
    if (parsedLine.rule) { if (visit) visit(parsedLine.rule); else rules.push(parsedLine.rule); }
    if (parsedLine.warning) warnings.push(parsedLine.warning);
  });
  return { rules, warnings };
}

/** Common provider files are a flat quoted sequence; avoid a large YAML syntax tree. */
function parseQuotedClashPayload(content: string): { payload: string[] } | null {
  const payload: string[] = [];
  let header = false;
  let indent: string | undefined;
  for (const match of content.matchAll(/[^\r\n]+/g)) {
    const line = match[0].trim();
    if (!line || line.startsWith("#")) continue;
    if (!header) {
      if (match[0] !== "payload:") return null;
      header = true;
      continue;
    }
    const item = /^( +)- ('(?:[^']|'')*'|"(?:[^"\\]|\\.)*")(?:[ \t]+#.*)?[ \t]*$/.exec(match[0]);
    if (!item) return null;
    if (indent !== undefined && indent !== item[1]) return null;
    indent = item[1];
    const scalar = item[2]!;
    if (scalar.startsWith("'")) payload.push(scalar.slice(1, -1).replace(/''/g, "'"));
    else {
      try { payload.push(JSON.parse(scalar) as string); }
      catch { return null; }
    }
  }
  return header ? { payload } : null;
}

function parsePlainRuleSetLines(content: string, sourceLabel: string, defaultFormat: RuleSetSourceFormat, visit?: RuleVisitor, clashOnly = false): ParseRuleSetResult {
  const rules: ParsedRuleSetRule[] = [];
  const warnings: string[] = [];
  content.split(/\r?\n/).forEach((line, index) => {
    const parsed = parseRuleLineForRuleSet(line, {
      sourceLabel,
      lineNumber: index + 1,
      defaultFormat,
      clashOnly
    });
    if (parsed.rule) { if (visit) visit(parsed.rule); else rules.push(parsed.rule); }
    if (parsed.warning) warnings.push(parsed.warning);
  });
  return { rules, warnings };
}

function parseRuleLineForRuleSet(line: string, options: ParseLineOptions): { rule?: ParsedRuleSetRule; warning?: string } {
  const trimmed = String(line || "").trim();
  if (!trimmed || isCommentLine(trimmed)) return {};
  if (/^\[[^\]]+\]$/.test(trimmed)) return options.clashOnly ? { warning: `${lineLabel(options)}Clash 规则集不支持配置段落。` } : {};

  if (!trimmed.includes(",")) {
    if ((options.defaultFormat === "plain-domain" || options.defaultFormat === "surge-domain-set") && looksLikeDomain(trimmed)) {
      return { rule: parsedDomainSetRule(trimmed, options) };
    }
    if (options.defaultFormat === "plain-ipcidr" && looksLikeCidr(trimmed)) {
      return { rule: parsedRule(trimmed.includes(":") ? "IP-CIDR6" : "IP-CIDR", trimmed, options, "ipcidr") };
    }
    if (looksLikeDomain(trimmed)) return { rule: parsedDomainSetRule(trimmed, options) };
    if (looksLikeCidr(trimmed)) return { rule: parsedRule(trimmed.includes(":") ? "IP-CIDR6" : "IP-CIDR", trimmed, options, "ipcidr") };
    return { warning: `${lineLabel(options)}无法识别为可编译规则。` };
  }

  const parts = splitRuleLine(trimmed);
  const type = (parts[0] || "").trim().toUpperCase();
  const value = (parts[1] || "").trim();
  if (!type || !value) return { warning: `${lineLabel(options)}规则缺少类型或内容。` };
  if (SKIPPED_EXTERNAL_RULE_TYPES.has(type)) return { warning: `${lineLabel(options)}${type} 应作为主配置规则保存，不进入外部规则集。` };
  if (IPCIDR_RULE_TYPES.has(type) && !isValidCidrForRuleType(value, type)) {
    return { warning: `${lineLabel(options)}${type} 包含无效的 CIDR。` };
  }
  const raw = options.clashOnly ? [type, ...parts.slice(1)].join(",") : ruleWithoutPolicy(parts, type);
  if (options.clashOnly && !isNativeClashRule(raw)) return { warning: `${lineLabel(options)}不是受支持的 Clash 规则，规则集条目不能携带出口或其他客户端参数。` };
  const bucket = bucketForRuleType(type, raw);
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

function parsedDomainSetRule(value: string, options: ParseLineOptions): ParsedRuleSetRule {
  const clashPattern = normalizeClashDomainPattern(value);
  if (
    hasClashWildcardLabel(clashPattern)
    || (clashPattern.startsWith(".") && options.defaultFormat !== "surge-domain-set")
  ) {
    const regex = clashDomainPatternRegex(clashPattern);
    return {
      type: "DOMAIN-REGEX",
      value: regex,
      bucket: "domain",
      raw: `DOMAIN-REGEX,${regex}`,
      normalizedKey: `domain\0CLASH-DOMAIN\0${clashPattern}`,
      label: lineLabel(options),
      clashDomainPattern: clashPattern
    };
  }
  const type = hasDomainSuffixPrefix(value) ? "DOMAIN-SUFFIX" : "DOMAIN";
  return parsedRule(type, normalizeDomainValue(value), options, "domain");
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

function bucketForRuleType(type: string, raw?: string): RuleSetBucket {
  if (DOMAIN_RULE_TYPES.has(type)) return "domain";
  if (IPCIDR_RULE_TYPES.has(type)) {
    const options = raw ? splitRuleLine(raw).slice(2).map((option) => option.trim().toLowerCase()) : [];
    // A plain ipcidr payload cannot express per-rule resolution/source options.
    return options.includes("src") || options.includes("no-resolve") ? "classical" : "ipcidr";
  }
  return "classical";
}

function ruleWithoutPolicy(parts: string[], type: string): string {
  const normalized = parts.map((part) => part.trim()).filter(Boolean);
  if (normalized.length <= 2) return normalized.join(",");
  if (IP_OPTION_RULE_TYPES.has(type) && IP_RULE_OPTIONS.has((normalized[2] || "").toLowerCase())) {
    return normalized.join(",");
  }
  return [normalized[0], normalized[1], ...normalized.slice(3)].join(",");
}

function normalizedRuleKey(type: string, value: string, raw: string, bucket: RuleSetBucket): string {
  if (bucket === "domain") return `${bucket}\0${type}\0${normalizeDomainValue(value)}`;
  if (bucket === "ipcidr") return `${bucket}\0${type}\0${value.trim().toLowerCase()}`;
  const parts = splitRuleLine(raw);
  return `${bucket}\0${type.toUpperCase()}\0${parts.slice(1).map((part) => part.trim()).join(",")}`;
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

function normalizeClashDomainPattern(value: string): string {
  return value.trim().replace(/\.$/, "").toLowerCase();
}

function normalizeDomainValue(value: string): string {
  return normalizeDomainSetValue(value).toLowerCase();
}

function hasDomainSuffixPrefix(value: string): boolean {
  return /^(?:\.|\+\.|\*\.)/.test(value.trim());
}

function looksLikeDomain(value: string): boolean {
  const normalized = normalizeClashDomainPattern(value);
  if (normalized.includes("://")) return false;
  const body = normalized.startsWith("+.")
    ? normalized.slice(2)
    : normalized.startsWith(".")
      ? normalized.slice(1)
      : normalized;
  const labels = body.split(".");
  return labels.length >= 2 && labels.every((label) => label === "*" || /^[a-z0-9_-]+$/i.test(label));
}

function hasClashWildcardLabel(pattern: string): boolean {
  const body = pattern.startsWith("+.") ? pattern.slice(2) : pattern.startsWith(".") ? pattern.slice(1) : pattern;
  return body.split(".").includes("*");
}

function clashDomainPatternRegex(pattern: string): string {
  const prefix = pattern.startsWith("+.") ? "suffix" : pattern.startsWith(".") ? "subdomain" : "exact";
  const body = prefix === "exact" ? pattern : pattern.slice(prefix === "suffix" ? 2 : 1);
  const labels = body.split(".").map((label) => label === "*" ? "[^.]+" : escapeRegex(label));
  const exact = labels.join("\\.");
  if (prefix === "suffix") return `^([^.]+\\.)*${exact}$`;
  if (prefix === "subdomain") return `^([^.]+\\.)+${exact}$`;
  return `^${exact}$`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isCommentLine(line: string): boolean {
  return line.startsWith("#") || line.startsWith(";") || line.startsWith("//");
}

function lineLabel(options: ParseLineOptions): string {
  return `${options.sourceLabel} 第 ${options.lineNumber} 行`;
}
