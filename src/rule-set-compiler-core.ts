import { YAMLParseError } from "yaml";
import { clashRuleWithNoResolve, renderRuleSetRuleForTarget, ruleUsesExtendedMatching } from "./rule-targets";
import { parseInlineRuleSetLines, parseRuleSetContent, type ParsedRuleSetRule, type CompiledRuleSetRule } from "./rule-set-parser";
import type { CompiledRuleSetManifest, RuleSetSourceFetchResult } from "./rule-set-cache";
import { RULE_SET_BUCKETS, RULE_SET_TARGETS, type RuleSetBucket, type RuleSetOutput, type RuleSetOutputTarget, type RuleSetSource } from "./rule-set-types";
import { splitRuleLine } from "./rule-line";
import { isSingboxBinarySource, planRuleSetOutputs } from "./rule-set-outputs";
import type { RenderConfig } from "./types";
import { sha256Hex } from "./util";
import type { AsnResolution } from "./singbox-asn";
import { validateRuleMatchValue } from "./rule-value-validation";
import { ruleCompilationMode } from "./rule-compilation-mode";
import { RULE_KERNEL_MAX_BYTES, type AggregationRule, type RuleSetAggregator } from "./rule-set-kernel";

export type RuleCompilationConfig = Pick<RenderConfig, "ruleSets" | "renderTarget"> & {
  settings?: Pick<RenderConfig["settings"], "ruleCompilationMode" | "actionsCompilation">;
};
export type RuleSetCompileErrorCode = "configuration" | "format";
export class RuleSetCompileError extends Error {
  constructor(readonly code: RuleSetCompileErrorCode) {
    super(code === "configuration"
      ? "规则集配置存在无效来源引用或不兼容的规则选项，请检查当前客户端的分流规则。"
      : "规则来源内容格式无效，请检查来源格式并使用原始规则文件。");
    this.name = "RuleSetCompileError";
  }
}
const RULE_SET_COMPILER_REVISION = 18;
export async function ruleSetSourceCacheKey(url: string): Promise<string> {
  return `cache:ruleSetSource:${await sha256Hex(url)}`;
}

/** Shared parsing, deduplication and bucketing; the caller owns I/O and publication. */
export async function compileRuleSetContent(
  config: RuleCompilationConfig,
  output: RuleSetOutput,
  options: {
    loadSource: (source: RuleSetSource) => Promise<RuleSetSourceFetchResult>;
    asnResolver: (value: string) => Promise<AsnResolution>;
    deadline?: number;
    aggregateRules?: RuleSetAggregator;
    reuseManifest?: (hashes: Record<string, string>) => CompiledRuleSetManifest | null;
  }
) {
  const outputFingerprint = await ruleSetOutputFingerprint(config, output);
  let buckets = emptyBuckets();
  const kernel = ruleCompilationMode(config) !== "worker";
  if (kernel && !options.aggregateRules) throw new Error("The selected compiler requires the shared WASM rule kernel");
  const kernelRules: AggregationRule[] = [];
  const asnExpansions: Record<string, AggregationRule[]> = Object.create(null);
  let kernelSink = kernelRules;
  let kernelBytes = 256;
  const appendKernelRule = (rule: AggregationRule, sink = kernelSink): void => {
    kernelBytes += new TextEncoder().encode(JSON.stringify(rule)).byteLength + 1;
    if (kernelBytes > RULE_KERNEL_MAX_BYTES) throw new Error("Rule aggregation input exceeds the size limit");
    sink.push(rule);
  };
  const sourceContentHashes: Record<string, string> = {};
  const warnings: string[] = [];
  const sourceErrors: string[] = [];
  const sourceById = new Map(config.ruleSets.sources.map((source) => [source.id, source]));
  const seen = new Set<string>();
  const suffixes = new Set<string>();
  const compatibility = new Map<string, CompatibilitySummary>();
  const targets = config.renderTarget ? [config.renderTarget] : RULE_SET_TARGETS;
  const singbox = config.renderTarget === "sing-box";
  let compileErrorCode: RuleSetCompileErrorCode | undefined;
  const asnRules = new Map<string, ParsedRuleSetRule>();
  let asnExpiresAt: number | undefined;
  let duplicateCount = 0;
  const acceptRule = (rule: ParsedRuleSetRule): void => {
    if (config.renderTarget === "surge" && output.surgeType === "DOMAIN-SET" && (rule.bucket !== "domain" || !isPlainDomainRule(rule))) {
      if (!sourceErrors.some((message) => message.includes("DOMAIN-SET 只能"))) sourceErrors.push(`${rule.label}：DOMAIN-SET 只能包含不带附加选项的域名或域名后缀，请改用 RULE-SET 或调整来源。`);
      return;
    }
    if (config.renderTarget === "clash" && output.provider && output.provider.behavior !== "classical"
      && rule.bucket !== output.provider.behavior) {
      if (!sourceErrors.some((message) => message.includes("behavior="))) sourceErrors.push(`${rule.label}：规则内容与 behavior=${output.provider.behavior} 不符，请调整 behavior 或来源地址。`);
      return;
    }
    if (ruleUsesExtendedMatching(rule.raw) && renderRuleSetRuleForTarget(rule.raw, config.renderTarget ?? "surge") === null) {
      if (singbox) compileErrorCode = "configuration";
      sourceErrors.push(`${rule.label}：extended-matching 无法等价转换为 ${targetName(config.renderTarget ?? "surge")}，请调整规则来源或使用支持该选项的客户端。`);
      return;
    }
    if (singbox && rule.type === "IP-ASN" && !validateRuleMatchValue(rule.type, rule.value)
      && splitRuleLine(rule.raw).slice(2).every((option) => ["no-resolve", "src"].includes(option))) {
      if (kernel) {
        appendKernelRule({ ...rule, asnExpansionKey: rule.normalizedKey }, kernelRules);
        // Coalesce network lookups only; every original rule reaches the kernel.
        if (!asnRules.has(rule.normalizedKey)) asnRules.set(rule.normalizedKey, rule);
      } else if (asnRules.has(rule.normalizedKey)) duplicateCount += 1;
      else asnRules.set(rule.normalizedKey, rule);
      return;
    }
    recordTargetCompatibility(rule, compatibility, targets);
    if (singbox && renderRuleSetRuleForTarget(rule.raw, "sing-box") === null) return;
    if (kernel) { appendKernelRule(rule); return; }
    if (seen.has(rule.normalizedKey)) { duplicateCount += 1; return; }
    seen.add(rule.normalizedKey);
    if (rule.type === "DOMAIN") {
      let suffix = normalizeDomain(rule.value);
      while (suffix) {
        if (suffixes.has(suffix)) {
          warnings.push(`${rule.label} DOMAIN,${rule.value} 可能已被前面的 DOMAIN-SUFFIX 覆盖。`);
          break;
        }
        const dot = suffix.indexOf(".");
        if (dot < 0) break;
        suffix = suffix.slice(dot + 1);
      }
    }
    if (rule.type === "DOMAIN-SUFFIX") suffixes.add(normalizeDomain(rule.value));
    buckets[rule.bucket].push({ type: rule.type, value: rule.value, raw: rule.raw,
      ...(rule.clashDomainPattern ? { clashDomainPattern: rule.clashDomainPattern } : {}) });
  };
  let usedCachedSource = false;
  const nativeAggregation = config.renderTarget === "clash" && config.ruleSets.aggregateByPolicy && !output.provider;
  const memberNames = nativeAggregation
    ? planRuleSetOutputs(config.ruleSets).find((plan) => plan.output.name === output.name)?.includedOutputNames
    : undefined;
  const members = memberNames ? memberNames.map((name) => config.ruleSets.outputs.find((item) => item.name === name)!) : [output];
  const visitorFor = (member: RuleSetOutput) => !nativeAggregation || !member.surgeOptions.includes("no-resolve") ? acceptRule : (rule: ParsedRuleSetRule): void => {
    if (isPlainDomainRule(rule)) { acceptRule(rule); return; }
    const raw = clashRuleWithNoResolve(rule.raw);
    if (raw === rule.raw) { acceptRule(rule); return; }
    const parsed = parseInlineRuleSetLines([raw], rule.label, acceptRule, true);
    for (const warning of parsed.warnings) sourceErrors.push(warning);
  };

  for (const { sourceId, member } of members.flatMap((member) => member.sourceIds.map((sourceId) => ({ sourceId, member })))) {
    if (options.deadline !== undefined && Date.now() >= options.deadline) {
      sourceErrors.push("规则集刷新已超过截止时间");
      break;
    }
    const source = sourceById.get(sourceId);
    if (!source) {
      if (singbox) compileErrorCode = "configuration";
      sourceErrors.push(`${output.name}: 规则来源 ${sourceId} 不存在。`);
      continue;
    }
    if (!source.enabled || !source.url) {
      if (singbox) compileErrorCode = "configuration";
      sourceErrors.push(`${output.name}: 规则来源 ${source.name} 已禁用或缺少 URL。`);
      continue;
    }
    if (singbox && isSingboxBinarySource(source)) continue;
    try {
      const sourceKey = await ruleSetSourceCacheKey(source.url);
      const result = await options.loadSource(source);
      sourceContentHashes[sourceKey] = result.contentHash ?? await sha256Hex(result.content);
      if (result.usedCachedContent) {
        usedCachedSource = true;
        if (result.warning) warnings.push(`${output.name}: 刷新失败，继续使用旧规则集源缓存：${result.warning}`);
      } else if (result.warning) {
        warnings.push(`${output.name}: ${result.warning}`);
      }
      const { content } = result;
      const format = config.renderTarget === "surge" && output.surgeType ? output.surgeType === "DOMAIN-SET" ? "surge-domain-set" : "surge-rule-set" : source.format;
      const parsed = parseRuleSetContent(content, format, source.name, visitorFor(member), config.renderTarget === "clash", singbox);
      if (singbox && parsed.fatal) compileErrorCode ??= "format";
      for (const warning of parsed.warnings) (singbox && !parsed.fatal ? warnings : sourceErrors).push(warning);
    } catch (error) {
      if (singbox && (error instanceof YAMLParseError || error instanceof RuleSetCompileError && error.code === "format")) compileErrorCode ??= "format";
      sourceErrors.push(error instanceof Error ? error.message : String(error));
    }
  }

  for (const member of members) {
    const inline = parseInlineRuleSetLines(member.inlineRules, `${member.name} 内联规则`, visitorFor(member), config.renderTarget === "clash");
    for (const warning of inline.warnings) (singbox ? warnings : sourceErrors).push(warning);
  }

  const reused = !sourceErrors.length ? options.reuseManifest?.(sourceContentHashes) : null;
  if (reused) return { manifest: reused, buckets, stale: usedCachedSource, unchanged: true };

  if (singbox && asnRules.size && !sourceErrors.length) {
    const resolve = options.asnResolver;
    for (const rule of asnRules.values()) {
      const result = await resolve(rule.value);
      if (!result.prefixes.length && result.warning) throw new Error("规则集 ASN 数据暂不可用，保留已有完整缓存。");
      asnExpiresAt = Math.min(asnExpiresAt ?? Infinity, result.expiresAt);
      usedCachedSource ||= result.stale;
      if (result.warning) warnings.push(result.warning);
      const options = splitRuleLine(rule.raw).slice(2);
      if (kernel) {
        kernelBytes += new TextEncoder().encode(JSON.stringify(rule.normalizedKey)).byteLength + 4;
        kernelSink = asnExpansions[rule.normalizedKey] = [];
      }
      parseInlineRuleSetLines(result.prefixes.map((prefix) => [prefix.includes(":") ? "IP-CIDR6" : "IP-CIDR", prefix, ...options].join(",")), rule.label, acceptRule);
    }
  }

  if (sourceErrors.length > 0) {
    if (singbox && compileErrorCode) throw new RuleSetCompileError(compileErrorCode);
    throw new Error(sourceErrors.join("; "));
  }

  if (kernel) {
    const aggregated = await options.aggregateRules!({ operation: "aggregate", version: 1,
      ...(config.renderTarget ? { target: config.renderTarget } : {}), rules: kernelRules, asnExpansions });
    buckets = aggregated.buckets;
    duplicateCount = aggregated.duplicateCount;
    warnings.push(...aggregated.warnings);
  }
  for (const warning of compatibilityWarnings(compatibility)) warnings.push(warning);
  if (!kernel && (!config.renderTarget || config.renderTarget === "surge") && buckets.classical.some((rule) =>
    ["DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD"].includes(rule.type)
    && splitRuleLine(rule.raw).slice(2).some((option) => option.toLowerCase() === "extended-matching"))) {
    // Surge applies a domain rule's flag to the entire RULE-SET. Keep those
    // domains together instead of splitting large lists into DOMAIN-SET files.
    buckets.classical = [...buckets.domain, ...buckets.classical];
    buckets.domain = [];
  }
  // Drop deduplication-only indexes before serializing large output buckets.
  seen.clear();
  suffixes.clear();
  const targetCounts = (bucket: RuleSetBucket): Partial<Record<RuleSetOutputTarget, number>> => Object.fromEntries(targets.map((target) => [
    target, buckets[bucket].reduce((count, rule) => count + Number(isPlainDomainRule(rule) || renderRuleSetRuleForTarget(rule.raw, target) !== null), 0)
  ]));

  const manifest: CompiledRuleSetManifest = {
    outputName: output.name,
    outputFingerprint,
    policy: output.policy,
    updatedAt: new Date().toISOString(),
    sourceIds: output.sourceIds,
    sourceContentHashes,
    ruleCount: RULE_SET_BUCKETS.reduce((sum, bucket) => sum + buckets[bucket].length, 0),
    duplicateCount,
    ...(config.renderTarget === "sing-box" && output.dnsServer ? { dnsRuleCount: 0 } : {}),
    ...(config.renderTarget === "clash" && output.provider ? { provider: output.provider } : {}),
    ...(config.renderTarget === "surge" && output.surgeType ? { surgeType: output.surgeType } : {}),
    ...(asnExpiresAt !== undefined ? { asnExpiresAt } : {}),
    buckets: RULE_SET_BUCKETS.flatMap((bucket) => {
      if (!buckets[bucket].length) return [];
      const counts = targetCounts(bucket);
      return [{ bucket, count: buckets[bucket].length, targets: targets.filter((target) => (counts[target] ?? 0) > 0), targetCounts: counts }];
    }),
    warnings
  };
  return { manifest, buckets, stale: usedCachedSource };
}

export async function ruleSetOutputFingerprint(config: RuleCompilationConfig, output: RuleSetOutput): Promise<string> {
  const sources = new Map(config.ruleSets.sources.map((source) => [source.id, source]));
  return sha256Hex(JSON.stringify({
    compilerRevision: config.renderTarget === "sing-box" || config.renderTarget === "clash" ? RULE_SET_COMPILER_REVISION + 1 : RULE_SET_COMPILER_REVISION,
    target: config.renderTarget ?? "surge",
    compilationMode: ruleCompilationMode(config),
    policy: output.policy,
    sourceIds: output.sourceIds,
    sources: output.sourceIds.map((id) => {
      const source = sources.get(id);
      return source ? { id, url: source.url, enabled: source.enabled, format: source.format } : { id, missing: true };
    }),
    nativeMembers: nativeOutputMembers(config, output),
    dnsServer: output.dnsServer,
    inlineRules: output.inlineRules,
    surgeOptions: output.surgeOptions,
    ...(config.renderTarget === "surge" && output.surgeType ? { surgeType: output.surgeType } : {}),
    ...(config.renderTarget === "clash" && output.provider ? { provider: output.provider } : {})
  }));
}

function emptyBuckets(): Record<RuleSetBucket, CompiledRuleSetRule[]> {
  return {
    domain: [],
    ipcidr: [],
    classical: []
  };
}

function normalizeDomain(value: string): string {
  return value.trim().replace(/^\+\./, "").replace(/^\*\./, "").replace(/^\./, "").replace(/\.$/, "").toLowerCase();
}

interface CompatibilitySummary {
  label: string;
  type: string;
  target: RuleSetOutputTarget;
  renderedType: string | null;
  count: number;
}

function recordTargetCompatibility(rule: ParsedRuleSetRule, summaries: Map<string, CompatibilitySummary>, targets: readonly RuleSetOutputTarget[]): void {
  if (isPlainDomainRule(rule)) return;
  const options = splitRuleLine(rule.raw).slice(2);
  const diagnosticType = rule.clashDomainPattern ? "Clash domain-provider 模式"
    : options.length ? `${rule.type}（${options.join(",")}）` : rule.type;
  for (const target of targets) {
    const rendered = renderRuleSetRuleForTarget(rule.raw, target);
    const renderedType = rendered === null ? null : (splitRuleLine(rendered)[0] || "").trim().toUpperCase();
    if (rendered !== null && canonicalRuleForComparison(rendered, renderedType || rule.type) === canonicalRuleForComparison(rule.raw, rule.type)) continue;
    const key = `${diagnosticType}\0${target}\0${renderedType ?? "filtered"}`;
    const existing = summaries.get(key);
    if (existing) existing.count += 1;
    else summaries.set(key, { label: rule.label, type: diagnosticType, target, renderedType, count: 1 });
  }
}

function compatibilityWarnings(summaries: Map<string, CompatibilitySummary>): string[] {
  return [...summaries.values()].map((item) => item.renderedType === null
    ? `${item.label}${item.type} 规则不能等价转换为 ${targetName(item.target)}，已从该目标规则集过滤${item.count > 1 ? `（共 ${item.count} 条）` : ""}。`
    : `${item.label}${item.type} 在 ${targetName(item.target)} 输出中映射为 ${item.renderedType}${item.count > 1 ? `（共 ${item.count} 条）` : ""}。`);
}

function canonicalRuleForComparison(rule: string, type: string): string {
  const parts = splitRuleLine(rule);
  return [type.toUpperCase(), ...parts.slice(1).map((part) => part.trim())].join(",");
}

function targetName(target: RuleSetOutputTarget): string {
  if (target === "surge") return "Surge";
  if (target === "sing-box") return "sing-box";
  return target === "stash" ? "Stash" : "Clash";
}

function isPlainDomainRule(rule: CompiledRuleSetRule): boolean {
  return (rule.type === "DOMAIN" || rule.type === "DOMAIN-SUFFIX") && rule.raw === `${rule.type},${rule.value}`;
}

function nativeOutputMembers(config: RuleCompilationConfig, output: RuleSetOutput): unknown {
  if (config.renderTarget !== "clash" || !config.ruleSets.aggregateByPolicy || output.provider) return undefined;
  const names = new Set(planRuleSetOutputs(config.ruleSets).find((plan) => plan.output.name === output.name)?.includedOutputNames ?? [output.name]);
  return config.ruleSets.outputs.filter((item) => names.has(item.name))
    .map((item) => ({ sourceIds: item.sourceIds, inlineRules: item.inlineRules, options: item.surgeOptions, order: item.order }));
}
