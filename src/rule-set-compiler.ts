import { clashRuleWithNoResolve } from "./rule-targets";
import { managedRuleSetUrlForRequest } from "./managed-url";
import { parseInlineRuleSetLines, parseRuleSetContent, type ParsedRuleSetRule, type CompiledRuleSetRule } from "./rule-set-parser";
import {
  fetchCachedRuleSetSource,
  pruneCompiledRuleSetCaches,
  readCompiledRuleSetManifest,
  refreshRuleSetSourceCaches,
  scopeRuleSetSourceRefresh,
  ruleSetSourceCacheKey,
  writeCompiledRuleSet,
  type CompiledRuleSetManifest,
  type CompiledRuleSetStatusItem,
  type RuleSetSourceCacheFailure,
  type RuleSetSourceCacheRefreshResult,
  type RuleSetSourceFetchResult
} from "./rule-set-cache";
import { RULE_SET_BUCKETS, RULE_SET_TARGETS, type RuleSetBucket, type RuleSetOutput, type RuleSetOutputTarget } from "./rule-set-types";
import { planRuleSetArtifacts } from "./rule-set-artifacts";
import { compiledRuleProviderName } from "./rule-provider-name";
import { splitRuleLine } from "./rule-line";
import {
  configuredTailscalePolicyNames,
  isRulePolicyCompatibleWithTarget,
  renderDirectRuleForTarget,
  renderRuleSetRuleForTarget
} from "./rule-targets";
import { effectiveRuleSetOutputs, planRuleSetOutputs } from "./rule-set-outputs";
import type { RenderConfig } from "./types";
import { sha256Hex } from "./util";

export interface RuleSetRefreshResult {
  refreshed: number;
  failed: number;
  cached: number;
  deleted: number;
  updatedAt: string;
  warnings: string[];
  failures: RuleSetSourceCacheFailure[];
  outputFailures: RuleSetOutputRefreshFailure[];
  outputs: CompiledRuleSetStatusItem[];
}

export interface RuleSetOutputRefreshFailure {
  outputName: string;
  reason: string;
  usedCachedManifest: boolean;
}

export interface RuleSetRefreshOptions {
  sourceRefresh?: RuleSetSourceCacheRefreshResult;
  /** Absolute Unix timestamp in milliseconds after which no new fetch or output compilation starts. */
  deadline?: number;
}

export interface CompiledRuleSetReferencePlan {
  surgeRules: string[];
  clashRuleProviders: Record<string, Record<string, unknown>>;
  clashRules: string[];
  clashRuleComments: Record<string, string>;
  errors: string[];
  warnings: string[];
}

interface CompileOptions {
  allowStaleFallback?: boolean;
  forceSourceRefresh?: boolean;
  sourceContentByKey?: Map<string, RuleSetSourceFetchResult>;
  sourceErrorsByKey?: Map<string, string>;
  deadline?: number;
}

const FINAL_RULE_TYPES = new Set(["FINAL", "MATCH"]);
const RULE_SET_UPDATE_INTERVAL_SECONDS = 24 * 60 * 60;
const RULE_SET_COMPILER_REVISION = 9;

export async function compileRuleSetOutput(
  env: Env,
  config: RenderConfig,
  output: RuleSetOutput,
  options: CompileOptions = {}
): Promise<{ manifest: CompiledRuleSetManifest; stale: boolean }> {
  const outputFingerprint = await ruleSetOutputFingerprint(config, output);
  const buckets = emptyBuckets();
  const warnings: string[] = [];
  const sourceErrors: string[] = [];
  const sourceById = new Map(config.ruleSets.sources.map((source) => [source.id, source]));
  const seen = new Set<string>();
  const suffixes = new Set<string>();
  const compatibility = new Map<string, CompatibilitySummary>();
  const targets = config.renderTarget ? [config.renderTarget] : RULE_SET_TARGETS;
  let duplicateCount = 0;
  const acceptRule = (rule: ParsedRuleSetRule): void => {
    recordTargetCompatibility(rule, compatibility, targets);
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
  const nativeAggregation = config.renderTarget === "clash" && config.ruleSets.aggregateByPolicy;
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
    if (refreshDeadlineExceeded(options.deadline)) {
      sourceErrors.push("规则集刷新已超过截止时间");
      break;
    }
    const source = sourceById.get(sourceId);
    if (!source) {
      sourceErrors.push(`${output.name}: 规则来源 ${sourceId} 不存在。`);
      continue;
    }
    if (!source.enabled || !source.url) {
      sourceErrors.push(`${output.name}: 规则来源 ${source.name} 已禁用或缺少 URL。`);
      continue;
    }
    try {
      const sourceKey = await ruleSetSourceCacheKey(source.url);
      const sourceError = options.sourceErrorsByKey?.get(sourceKey);
      if (sourceError) {
        sourceErrors.push(`${source.name}: ${sourceError}`);
        continue;
      }
      const result = options.sourceContentByKey?.get(sourceKey) ?? await fetchCachedRuleSetSource(env, source, {
        allowCachedFallback: true,
        forceRefresh: Boolean(options.forceSourceRefresh),
        ...(options.deadline !== undefined ? { deadline: options.deadline } : {})
      });
      if (result.usedCachedContent) {
        usedCachedSource = true;
        if (result.warning) warnings.push(`${output.name}: 刷新失败，继续使用旧规则集源缓存：${result.warning}`);
      } else if (result.warning) {
        warnings.push(`${output.name}: ${result.warning}`);
      }
      const { content } = result;
      const parsed = parseRuleSetContent(content, source.format, source.name, visitorFor(member), config.renderTarget === "clash");
      for (const warning of parsed.warnings) sourceErrors.push(warning);
    } catch (error) {
      sourceErrors.push(error instanceof Error ? error.message : String(error));
    }
  }

  for (const member of members) {
    const inline = parseInlineRuleSetLines(member.inlineRules, `${member.name} 内联规则`, visitorFor(member), config.renderTarget === "clash");
    for (const warning of inline.warnings) sourceErrors.push(warning);
  }

  if (sourceErrors.length > 0) {
    const existing = options.allowStaleFallback && !refreshDeadlineExceeded(options.deadline)
      ? await readCompiledRuleSetManifest(env, output.name)
      : null;
    if (existing?.outputFingerprint === outputFingerprint) {
      return {
        manifest: {
          ...existing,
          warnings: [
            ...existing.warnings,
            ...sourceErrors.map((error) => `${output.name}: 刷新失败，继续使用旧编译缓存：${error}`)
          ]
        },
        stale: true
      };
    }
    throw new Error(sourceErrors.join("; "));
  }

  for (const warning of compatibilityWarnings(compatibility)) warnings.push(warning);
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
    ruleCount: RULE_SET_BUCKETS.reduce((sum, bucket) => sum + buckets[bucket].length, 0),
    duplicateCount,
    buckets: RULE_SET_BUCKETS.flatMap((bucket) => {
      if (!buckets[bucket].length) return [];
      const counts = targetCounts(bucket);
      return [{ bucket, count: buckets[bucket].length, targets: targets.filter((target) => (counts[target] ?? 0) > 0), targetCounts: counts }];
    }),
    warnings
  };
  try {
    await writeCompiledRuleSet(env, manifest, buckets);
  } catch (error) {
    const existing = options.allowStaleFallback
      ? await readCompiledRuleSetManifest(env, output.name).catch(() => null)
      : null;
    if (existing?.outputFingerprint === outputFingerprint) {
      return {
        manifest: {
          ...existing,
          warnings: [
            ...existing.warnings,
            `${output.name}: 新编译缓存写入失败，继续使用旧版本：${error instanceof Error ? error.message : String(error)}`
          ]
        },
        stale: true
      };
    }
    throw error;
  }
  return { manifest, stale: usedCachedSource };
}

export async function ensureCompiledRuleSet(
  env: Env,
  config: RenderConfig,
  output: RuleSetOutput
): Promise<CompiledRuleSetManifest> {
  const cached = await readCompiledRuleSetManifest(env, output.name);
  if (cached?.outputFingerprint === await ruleSetOutputFingerprint(config, output)) return cached;
  return compileRuleSetOutput(env, config, output, { allowStaleFallback: true }).then((result) => result.manifest);
}

async function ruleSetOutputFingerprint(config: RenderConfig, output: RuleSetOutput): Promise<string> {
  const sources = new Map(config.ruleSets.sources.map((source) => [source.id, source]));
  return sha256Hex(JSON.stringify({
    compilerRevision: RULE_SET_COMPILER_REVISION,
    target: config.renderTarget ?? "surge",
    policy: output.policy,
    sourceIds: output.sourceIds,
    sources: output.sourceIds.map((id) => {
      const source = sources.get(id);
      return source ? { id, url: source.url, enabled: source.enabled, format: source.format } : { id, missing: true };
    }),
    nativeMembers: nativeOutputMembers(config, output),
    inlineRules: output.inlineRules,
    surgeOptions: output.surgeOptions
  }));
}

export async function refreshRuleSetCaches(
  env: Env,
  config: RenderConfig,
  outputName?: string,
  options: RuleSetRefreshOptions = {}
): Promise<RuleSetRefreshResult> {
  const effectiveOutputs = effectiveRuleSetOutputs(config.ruleSets);
  const outputs = outputName
    ? effectiveOutputs.filter((output) => output.name === outputName)
    : effectiveOutputs;
  if (outputName && outputs.length === 0) throw new Error("Rule set output not found");
  const sourcesToRefresh = ruleSetSourcesForOutputs(config, outputs, Boolean(outputName));
  return refreshRuleSetOutputs(env, config, outputs, sourcesToRefresh, !outputName, options);
}

export async function refreshChangedRuleSetCaches(
  env: Env,
  previousConfig: RenderConfig,
  config: RenderConfig,
  options: RuleSetRefreshOptions = {}
): Promise<RuleSetRefreshResult | null> {
  if (config.ruleSets.mode !== "compiled") return null;
  const outputs = changedRuleSetOutputs(previousConfig, config);
  if (outputs.length === 0) return null;
  const changedSourceIds = changedRuleSetSourceIds(previousConfig, config);
  const sourcesToRefresh = previousConfig.ruleSets.mode !== "compiled"
    ? config.ruleSets.sources.filter((source) => source.enabled && source.url)
    : config.ruleSets.sources.filter((source) => source.enabled && source.url && changedSourceIds.has(source.id));
  return refreshRuleSetOutputs(env, config, outputs, sourcesToRefresh, false, options);
}

async function refreshRuleSetOutputs(
  env: Env,
  config: RenderConfig,
  outputs: RuleSetOutput[],
  sourcesToRefresh: RenderConfig["ruleSets"]["sources"],
  pruneUnexpected: boolean,
  options: RuleSetRefreshOptions
): Promise<RuleSetRefreshResult> {
  const sourceRefresh = options.sourceRefresh ? await scopeRuleSetSourceRefresh(options.sourceRefresh, config) : await refreshRuleSetSourceCaches(env, config, sourcesToRefresh, {
    pruneUnexpected,
    ...(options.deadline !== undefined ? { deadline: options.deadline } : {})
  });
  const canContinue = !refreshDeadlineExceeded(options.deadline);
  const compiledDeleted = pruneUnexpected && canContinue ? await pruneCompiledRuleSetCaches(env, config) : 0;

  let refreshed = 0;
  let failed = 0;
  let cached = 0;
  const warnings = new Set(sourceRefresh.warnings);
  const outputFailures: RuleSetOutputRefreshFailure[] = [];
  if (pruneUnexpected && !canContinue) warnings.add("规则集刷新已到截止时间，跳过过期编译缓存清理。");

  for (let outputIndex = 0; outputIndex < outputs.length; outputIndex += 1) {
    const output = outputs[outputIndex]!;
    if (refreshDeadlineExceeded(options.deadline)) {
      const reason = "规则集刷新已超过截止时间";
      for (const remaining of outputs.slice(outputIndex)) {
        failed += 1;
        outputFailures.push({ outputName: remaining.name, reason, usedCachedManifest: false });
        warnings.add(`${remaining.name}: ${reason}。`);
      }
      break;
    }
    try {
      const result = await compileRuleSetOutput(env, config, output, {
        allowStaleFallback: true,
        sourceContentByKey: sourceRefresh.contentByKey,
        sourceErrorsByKey: sourceRefresh.errorsByKey,
        ...(options.deadline !== undefined ? { deadline: options.deadline } : {})
      });
      if (result.stale) {
        cached += 1;
      } else {
        refreshed += 1;
      }
      for (const warning of result.manifest.warnings) warnings.add(warning);
    } catch (error) {
      failed += 1;
      const reason = error instanceof Error ? error.message : String(error);
      const existing = refreshDeadlineExceeded(options.deadline)
        ? null
        : await readCompiledRuleSetManifest(env, output.name);
      const usedCachedManifest = existing !== null;
      if (usedCachedManifest) cached += 1;
      outputFailures.push({ outputName: output.name, reason, usedCachedManifest });
      warnings.add(`${output.name}: ${reason}${usedCachedManifest ? "，继续使用旧编译缓存" : ""}`);
    }
  }

  return {
    refreshed,
    failed,
    cached,
    deleted: sourceRefresh.deleted + compiledDeleted,
    updatedAt: new Date().toISOString(),
    warnings: [...warnings],
    failures: sourceRefresh.failures,
    outputFailures,
    outputs: refreshDeadlineExceeded(options.deadline) ? [] : await readRuleSetStatus(env, config)
  };
}

function refreshDeadlineExceeded(deadline: number | undefined): boolean {
  return deadline !== undefined && Date.now() >= deadline;
}

export async function readRuleSetStatus(env: Env, config: RenderConfig): Promise<CompiledRuleSetStatusItem[]> {
  return Promise.all(effectiveRuleSetOutputs(config.ruleSets).map(async (output) => {
    const stored = await readCompiledRuleSetManifest(env, output.name);
    const manifest = stored?.outputFingerprint === await ruleSetOutputFingerprint(config, output) ? stored : null;
    const target = config.renderTarget ?? "surge";
    const count = (bucket: RuleSetBucket): number => manifest?.buckets.find((item) => item.bucket === bucket)?.targetCounts?.[target] ?? 0;
    return {
      outputName: output.name,
      enabled: output.enabled,
      updatedAt: manifest?.updatedAt || null,
      ruleCount: manifest?.ruleCount ?? 0,
      duplicateCount: manifest?.duplicateCount ?? 0,
      buckets: manifest?.buckets ?? [],
      artifacts: planRuleSetArtifacts(manifest?.buckets ?? [], target).map((artifact) => ({
        behavior: artifact.behavior,
        count: artifact.behavior === "domain" ? count("domain") : artifact.behavior === "ipcidr" ? count("ipcidr") : count("classical") + (artifact.includesDomains ? count("domain") : 0) + (artifact.includesIpCidr ? count("ipcidr") : 0)
      })),
      warnings: manifest?.warnings ?? [],
      cached: Boolean(manifest)
    };
  }));
}

export async function buildCompiledRuleSetReferencePlan(
  env: Env,
  config: RenderConfig,
  target: RuleSetOutputTarget,
  requestUrl: string
): Promise<CompiledRuleSetReferencePlan> {
  const plan: CompiledRuleSetReferencePlan = {
    surgeRules: [],
    clashRuleProviders: {},
    clashRules: [],
    clashRuleComments: {},
    errors: [],
    warnings: []
  };
  const directRules = config.ruleSets.directRules.filter((rule) => rule.enabled);
  const outputPlans = planRuleSetOutputs(config.ruleSets);
  const tailscalePolicies = configuredTailscalePolicyNames(config);
  const items = [
    ...outputPlans.map((outputPlan) => ({ kind: "output" as const, outputPlan, order: outputPlan.output.order })),
    ...directRules.map((rule) => ({ kind: "direct" as const, rule, order: rule.order }))
  ].sort((left, right) => left.order - right.order);
  const finalDirectRules: string[] = [];

  for (const item of items) {
    if (item.kind === "direct") {
      if (target !== "surge" && tailscalePolicies.has(item.rule.policy.trim())) {
        plan.errors.push(`${item.rule.name}: Tailscale 策略 ${item.rule.policy} 仅支持 Surge，已从 ${targetName(target)} 输出过滤。`);
        continue;
      }
      if (!isRulePolicyCompatibleWithTarget(item.rule.policy, target)) {
        plan.errors.push(`${item.rule.name}: 策略 ${item.rule.policy} 不受 ${targetName(target)} 支持，已过滤。`);
        continue;
      }
      const line = renderDirectRuleForTarget(item.rule, target);
      if (!line) {
        plan.errors.push(`${item.rule.name}: 规则语法不受 ${targetName(target)} 支持，已过滤。`);
        continue;
      }
      if (!isFinalRuleLine(line) && directRuleMatchSignature(item.rule.rule) !== directRuleMatchSignature(line)) {
        plan.warnings.push(`${item.rule.name}: 规则语法已映射为 ${targetName(target)} 兼容格式。`);
      }
      if (isFinalRuleLine(line)) {
        finalDirectRules.push(line);
      } else {
        appendMainRule(plan, target, line);
      }
      continue;
    }
    try {
      const { output, includedOutputNames } = item.outputPlan;
      if (target !== "surge" && output.surgeOptions.some((option) => option !== "no-resolve")) throw new Error("规则输出含有不能等价转换的 Surge 专属选项。");
      if (target !== "surge" && tailscalePolicies.has(output.policy.trim())) {
        plan.errors.push(`${output.name}: Tailscale 策略 ${output.policy} 仅支持 Surge，已从 ${targetName(target)} 输出过滤。`);
        continue;
      }
      if (!isRulePolicyCompatibleWithTarget(output.policy, target)) {
        plan.errors.push(`${output.name}: 策略 ${output.policy} 不受 ${targetName(target)} 支持，已过滤。`);
        continue;
      }
      const manifest = await ensureCompiledRuleSet(env, config, output);
      const compatibleCount = manifest.buckets.reduce((sum, bucket) => sum + (bucket.targetCounts?.[target] ?? 0), 0);
      if (compatibleCount !== manifest.ruleCount) throw new Error("规则集中存在当前输出端无法等价表达的规则。");
      const surgeStart = plan.surgeRules.length;
      const clashStart = plan.clashRules.length;
      appendCompiledOutputReferences(plan, config, output, manifest, target, requestUrl);
      if (config.ruleSets.aggregateByPolicy) {
        const comment = ruleSetAggregationComment(output.policy, includedOutputNames);
        if (target === "surge" && plan.surgeRules.length > surgeStart) {
          plan.surgeRules.splice(surgeStart, 0, `# ${comment}`);
        } else if (target !== "surge" && plan.clashRules.length > clashStart) {
          plan.clashRuleComments[plan.clashRules[clashStart]!] = comment;
        }
      }
      for (const warning of manifest.warnings) plan.warnings.push(warning);
    } catch (error) {
      plan.errors.push(`${item.outputPlan.output.name}: 规则集尚未可用：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const line of finalDirectRules) appendMainRule(plan, target, line);
  return plan;
}

function ruleSetAggregationComment(policy: string, outputNames: string[]): string {
  const clean = (value: string) => value.replace(/[\r\n]+/g, " ").trim();
  return `策略组 ${clean(policy)} 包含规则集：${outputNames.map(clean).join("、")}`;
}

function appendCompiledOutputReferences(
  plan: CompiledRuleSetReferencePlan,
  config: RenderConfig,
  output: RuleSetOutput,
  manifest: CompiledRuleSetManifest,
  target: RuleSetOutputTarget,
  requestUrl: string
): void {
  const artifacts = planRuleSetArtifacts(manifest.buckets, target);
  if (target === "surge") {
    for (const artifact of artifacts) {
      const url = managedRuleSetUrlForRequest(config, requestUrl, output.name, artifact.bucket, target);
      const options = surgeRuleSetOptions(output, artifact.includesIpCidr);
      const type = artifact.bucket === "domain" ? "DOMAIN-SET" : "RULE-SET";
      plan.surgeRules.push([type, url, output.policy, ...options].join(","));
    }
    return;
  }
  for (const artifact of artifacts) {
    const url = managedRuleSetUrlForRequest(config, requestUrl, output.name, artifact.bucket, target);
    const providerName = compiledRuleProviderName(output.name, artifact.bucket);
    plan.clashRuleProviders[providerName] = {
      type: "http",
      behavior: artifact.behavior,
      url,
      path: `./rules/${providerName}.yaml`,
      interval: RULE_SET_UPDATE_INTERVAL_SECONDS
    };
    plan.clashRules.push(`RULE-SET,${providerName},${output.policy}${output.surgeOptions.includes("no-resolve") && !(target === "clash" && config.ruleSets.aggregateByPolicy) ? ",no-resolve" : ""}`);
  }
}

function appendMainRule(plan: CompiledRuleSetReferencePlan, target: RuleSetOutputTarget, line: string): void {
  if (target === "surge") {
    plan.surgeRules.push(line);
  } else {
    plan.clashRules.push(line);
  }
}

function isFinalRuleLine(line: string): boolean {
  const type = (splitRuleLine(line)[0] || "").trim().toUpperCase();
  return FINAL_RULE_TYPES.has(type);
}

function directRuleMatchSignature(line: string): string {
  const parts = splitRuleLine(line);
  return [(parts[0] || "").trim().toUpperCase(), (parts[1] || "").trim()].join("\0");
}

function surgeRuleSetOptions(output: RuleSetOutput, includesIpCidr: boolean): string[] {
  const options = output.surgeOptions.filter((option) => !/^update-interval=/i.test(option));
  if (includesIpCidr && !options.some((option) => option.toLowerCase() === "no-resolve")) {
    options.unshift("no-resolve");
  }
  options.push(`update-interval=${RULE_SET_UPDATE_INTERVAL_SECONDS}`);
  return options;
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
  const diagnosticType = rule.clashDomainPattern ? "Clash domain-provider 模式" : rule.type;
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
    ? `${item.label}${item.type} 不受 ${targetName(item.target)} 支持，已从该目标规则集过滤${item.count > 1 ? `（共 ${item.count} 条）` : ""}。`
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

function ruleSetSourcesForOutputs(config: RenderConfig, outputs: RuleSetOutput[], outputSpecific: boolean): RenderConfig["ruleSets"]["sources"] {
  if (!outputSpecific) {
    return config.ruleSets.sources.filter((source) => source.enabled && source.url);
  }
  const sourceIds = new Set(outputs.flatMap((output) => output.sourceIds));
  return config.ruleSets.sources.filter((source) => source.enabled && source.url && sourceIds.has(source.id));
}

function changedRuleSetOutputs(previousConfig: RenderConfig, config: RenderConfig): RuleSetOutput[] {
  const outputs = effectiveRuleSetOutputs(config.ruleSets);
  if (previousConfig.ruleSets.mode !== "compiled") return outputs;
  if (config.renderTarget === "clash" && previousConfig.ruleSets.aggregateByPolicy !== config.ruleSets.aggregateByPolicy) return outputs;
  const changedSourceIds = changedRuleSetSourceIds(previousConfig, config);
  const previousByName = new Map(effectiveRuleSetOutputs(previousConfig.ruleSets).map((output) => [output.name, output]));
  return outputs.filter((output) => {
    const previous = previousByName.get(output.name);
    if (!previous || !previous.enabled) return true;
    if (output.sourceIds.some((sourceId) => changedSourceIds.has(sourceId))) return true;
    return JSON.stringify(nativeOutputMembers(previousConfig, previous)) !== JSON.stringify(nativeOutputMembers(config, output))
      || previous.policy !== output.policy
      || previous.enabled !== output.enabled
      || !sameStringList(previous.sourceIds, output.sourceIds)
      || !sameStringList(previous.inlineRules, output.inlineRules)
      || !sameStringList(previous.surgeOptions, output.surgeOptions);
  });
}

function changedRuleSetSourceIds(previousConfig: RenderConfig, config: RenderConfig): Set<string> {
  const previousById = new Map(previousConfig.ruleSets.sources.map((source) => [source.id, source]));
  const nextById = new Map(config.ruleSets.sources.map((source) => [source.id, source]));
  const ids = new Set([...previousById.keys(), ...nextById.keys()]);
  const changed = new Set<string>();
  for (const id of ids) {
    const previous = previousById.get(id);
    const next = nextById.get(id);
    if (!previous || !next) {
      changed.add(id);
      continue;
    }
    if (previous.name !== next.name
      || previous.url !== next.url
      || previous.enabled !== next.enabled
      || previous.format !== next.format) {
      changed.add(id);
    }
  }
  return changed;
}

function sameStringList(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => item === right[index]);
}

function isPlainDomainRule(rule: CompiledRuleSetRule): boolean {
  return (rule.type === "DOMAIN" || rule.type === "DOMAIN-SUFFIX") && rule.raw === `${rule.type},${rule.value}`;
}

function nativeOutputMembers(config: RenderConfig, output: RuleSetOutput): unknown {
  if (config.renderTarget !== "clash" || !config.ruleSets.aggregateByPolicy) return undefined;
  return config.ruleSets.outputs.filter((item) => item.enabled && item.policy.trim() === output.policy.trim())
    .map((item) => ({ sourceIds: item.sourceIds, inlineRules: item.inlineRules, options: item.surgeOptions, order: item.order }));
}
