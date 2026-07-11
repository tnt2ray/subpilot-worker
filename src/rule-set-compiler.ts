import { managedRuleSetUrlForRequest } from "./managed-url";
import { parseInlineRuleSetLines, parseRuleSetContent, type ParsedRuleSetRule } from "./rule-set-parser";
import {
  fetchCachedRuleSetSource,
  pruneCompiledRuleSetCaches,
  readCompiledRuleSetManifest,
  refreshRuleSetSourceCaches,
  ruleSetSourceCacheKey,
  writeCompiledRuleSet,
  type CompiledRuleSetManifest,
  type CompiledRuleSetStatusItem,
  type RuleSetSourceCacheFailure,
  type RuleSetSourceFetchResult
} from "./rule-set-cache";
import { RULE_SET_BUCKETS, type RuleSetBucket, type RuleSetOutput, type RuleSetOutputTarget } from "./rule-set-types";
import { planRuleSetArtifacts } from "./rule-set-artifacts";
import { compiledRuleProviderName } from "./rule-provider-name";
import { splitRuleLine } from "./rule-line";
import { renderDirectRuleForTarget } from "./rule-targets";
import { effectiveRuleSetOutputs, planRuleSetOutputs } from "./rule-set-outputs";
import type { AppConfig } from "./types";

export interface RuleSetRefreshResult {
  refreshed: number;
  failed: number;
  cached: number;
  deleted: number;
  updatedAt: string;
  warnings: string[];
  failures: RuleSetSourceCacheFailure[];
  outputs: CompiledRuleSetStatusItem[];
}

export interface CompiledRuleSetReferencePlan {
  surgeRules: string[];
  clashRuleProviders: Record<string, Record<string, unknown>>;
  clashRules: string[];
  clashRuleComments: Record<string, string>;
  warnings: string[];
}

interface CompileOptions {
  allowStaleFallback?: boolean;
  forceSourceRefresh?: boolean;
  sourceContentByKey?: Map<string, RuleSetSourceFetchResult>;
  sourceErrorsByKey?: Map<string, string>;
}

const FINAL_RULE_TYPES = new Set(["FINAL", "MATCH"]);
const RULE_SET_UPDATE_INTERVAL_SECONDS = 24 * 60 * 60;

export async function compileRuleSetOutput(
  env: Env,
  config: AppConfig,
  output: RuleSetOutput,
  options: CompileOptions = {}
): Promise<{ manifest: CompiledRuleSetManifest; stale: boolean }> {
  const buckets = emptyBuckets();
  const warnings: string[] = [];
  const sourceErrors: string[] = [];
  const sourceById = new Map(config.ruleSets.sources.map((source) => [source.id, source]));
  const parsedRules: ParsedRuleSetRule[] = [];
  let usedCachedSource = false;

  for (const sourceId of output.sourceIds) {
    const source = sourceById.get(sourceId);
    if (!source) {
      warnings.push(`${output.name}: 规则来源 ${sourceId} 不存在。`);
      continue;
    }
    if (!source.enabled || !source.url) {
      warnings.push(`${output.name}: 规则来源 ${source.name} 已禁用或缺少 URL。`);
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
        forceRefresh: Boolean(options.forceSourceRefresh)
      });
      if (result.usedCachedContent) {
        usedCachedSource = true;
        if (result.warning) warnings.push(`${output.name}: 刷新失败，继续使用旧规则集源缓存：${result.warning}`);
      }
      const { content } = result;
      const parsed = parseRuleSetContent(content, source.format, source.name);
      parsedRules.push(...parsed.rules);
      warnings.push(...parsed.warnings);
    } catch (error) {
      sourceErrors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const inline = parseInlineRuleSetLines(output.inlineRules, `${output.name} 内联规则`);
  parsedRules.push(...inline.rules);
  warnings.push(...inline.warnings);

  if (sourceErrors.length > 0) {
    const existing = options.allowStaleFallback ? await readCompiledRuleSetManifest(env, output.name) : null;
    if (existing?.outputFingerprint === ruleSetOutputFingerprint(output)) {
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

  const seen = new Set<string>();
  let duplicateCount = 0;
  for (const rule of parsedRules) {
    if (seen.has(rule.normalizedKey)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(rule.normalizedKey);
    buckets[rule.bucket].push(rule);
  }
  warnings.push(...collectDomainContainmentWarnings(buckets.domain));

  const manifest: CompiledRuleSetManifest = {
    outputName: output.name,
    outputFingerprint: ruleSetOutputFingerprint(output),
    policy: output.policy,
    updatedAt: new Date().toISOString(),
    sourceIds: output.sourceIds,
    ruleCount: RULE_SET_BUCKETS.reduce((sum, bucket) => sum + buckets[bucket].length, 0),
    duplicateCount,
    buckets: RULE_SET_BUCKETS.flatMap((bucket) => buckets[bucket].length > 0
      ? [{ bucket, count: buckets[bucket].length, targets: ["surge", "clash", "stash"] as RuleSetOutputTarget[] }]
      : []),
    warnings
  };
  await writeCompiledRuleSet(env, manifest, buckets);
  return { manifest, stale: usedCachedSource };
}

export async function ensureCompiledRuleSet(
  env: Env,
  config: AppConfig,
  output: RuleSetOutput
): Promise<CompiledRuleSetManifest> {
  const cached = await readCompiledRuleSetManifest(env, output.name);
  if (cached?.outputFingerprint === ruleSetOutputFingerprint(output)) return cached;
  return compileRuleSetOutput(env, config, output, { allowStaleFallback: true }).then((result) => result.manifest);
}

function ruleSetOutputFingerprint(output: RuleSetOutput): string {
  return JSON.stringify({
    policy: output.policy,
    sourceIds: output.sourceIds,
    inlineRules: output.inlineRules,
    surgeOptions: output.surgeOptions
  });
}

export async function refreshRuleSetCaches(env: Env, config: AppConfig, outputName?: string): Promise<RuleSetRefreshResult> {
  const effectiveOutputs = effectiveRuleSetOutputs(config.ruleSets);
  const outputs = outputName
    ? effectiveOutputs.filter((output) => output.name === outputName)
    : effectiveOutputs;
  if (outputName && outputs.length === 0) throw new Error("Rule set output not found");
  const sourcesToRefresh = ruleSetSourcesForOutputs(config, outputs, Boolean(outputName));
  return refreshRuleSetOutputs(env, config, outputs, sourcesToRefresh, !outputName);
}

export async function refreshChangedRuleSetCaches(
  env: Env,
  previousConfig: AppConfig,
  config: AppConfig
): Promise<RuleSetRefreshResult | null> {
  if (config.ruleSets.mode !== "compiled") return null;
  const outputs = changedRuleSetOutputs(previousConfig, config);
  if (outputs.length === 0) return null;
  const changedSourceIds = changedRuleSetSourceIds(previousConfig, config);
  const sourcesToRefresh = previousConfig.ruleSets.mode !== "compiled"
    ? config.ruleSets.sources.filter((source) => source.enabled && source.url)
    : config.ruleSets.sources.filter((source) => source.enabled && source.url && changedSourceIds.has(source.id));
  return refreshRuleSetOutputs(env, config, outputs, sourcesToRefresh, false);
}

async function refreshRuleSetOutputs(
  env: Env,
  config: AppConfig,
  outputs: RuleSetOutput[],
  sourcesToRefresh: AppConfig["ruleSets"]["sources"],
  pruneUnexpected: boolean
): Promise<RuleSetRefreshResult> {
  const sourceRefresh = await refreshRuleSetSourceCaches(env, config, sourcesToRefresh, { pruneUnexpected });
  const compiledDeleted = pruneUnexpected ? await pruneCompiledRuleSetCaches(env, config) : 0;

  let refreshed = 0;
  let failed = 0;
  let cached = 0;
  const warnings = new Set(sourceRefresh.warnings);

  for (const output of outputs) {
    try {
      const result = await compileRuleSetOutput(env, config, output, {
        allowStaleFallback: true,
        sourceContentByKey: sourceRefresh.contentByKey,
        sourceErrorsByKey: sourceRefresh.errorsByKey
      });
      if (result.stale) {
        cached += 1;
      } else {
        refreshed += 1;
      }
      for (const warning of result.manifest.warnings) warnings.add(warning);
    } catch (error) {
      failed += 1;
      warnings.add(`${output.name}: ${error instanceof Error ? error.message : String(error)}`);
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
    outputs: await readRuleSetStatus(env, config)
  };
}

export async function readRuleSetStatus(env: Env, config: AppConfig): Promise<CompiledRuleSetStatusItem[]> {
  return Promise.all(effectiveRuleSetOutputs(config.ruleSets).map(async (output) => {
    const manifest = await readCompiledRuleSetManifest(env, output.name);
    return {
      outputName: output.name,
      enabled: output.enabled,
      updatedAt: manifest?.updatedAt || null,
      ruleCount: manifest?.ruleCount ?? 0,
      duplicateCount: manifest?.duplicateCount ?? 0,
      buckets: manifest?.buckets ?? [],
      warnings: manifest?.warnings ?? [],
      cached: Boolean(manifest)
    };
  }));
}

export async function buildCompiledRuleSetReferencePlan(
  env: Env,
  config: AppConfig,
  target: RuleSetOutputTarget,
  requestUrl: string
): Promise<CompiledRuleSetReferencePlan> {
  const plan: CompiledRuleSetReferencePlan = {
    surgeRules: [],
    clashRuleProviders: {},
    clashRules: [],
    clashRuleComments: {},
    warnings: []
  };
  const directRules = config.ruleSets.directRules.filter((rule) => rule.enabled);
  const outputPlans = planRuleSetOutputs(config.ruleSets);
  const items = [
    ...outputPlans.map((outputPlan) => ({ kind: "output" as const, outputPlan, order: outputPlan.output.order })),
    ...directRules.map((rule) => ({ kind: "direct" as const, rule, order: rule.order }))
  ].sort((left, right) => left.order - right.order);
  const finalDirectRules: string[] = [];

  for (const item of items) {
    if (item.kind === "direct") {
      const line = renderDirectRuleForTarget(item.rule, target);
      if (!line) continue;
      if (isFinalRuleLine(line)) {
        finalDirectRules.push(line);
      } else {
        appendMainRule(plan, target, line);
      }
      continue;
    }
    try {
      const { output, includedOutputNames } = item.outputPlan;
      const manifest = await ensureCompiledRuleSet(env, config, output);
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
      plan.warnings.push(...manifest.warnings);
    } catch (error) {
      plan.warnings.push(`${item.outputPlan.output.name}: 规则集尚未可用：${error instanceof Error ? error.message : String(error)}`);
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
  config: AppConfig,
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
    plan.clashRules.push(`RULE-SET,${providerName},${output.policy}`);
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

function surgeRuleSetOptions(output: RuleSetOutput, includesIpCidr: boolean): string[] {
  const options = output.surgeOptions.filter((option) => !/^update-interval=/i.test(option));
  if (includesIpCidr && !options.some((option) => option.toLowerCase() === "no-resolve")) {
    options.unshift("no-resolve");
  }
  options.push(`update-interval=${RULE_SET_UPDATE_INTERVAL_SECONDS}`);
  return options;
}

function emptyBuckets(): Record<RuleSetBucket, ParsedRuleSetRule[]> {
  return {
    domain: [],
    ipcidr: [],
    classical: []
  };
}

function collectDomainContainmentWarnings(rules: ParsedRuleSetRule[]): string[] {
  const suffixes: string[] = [];
  const warnings: string[] = [];
  for (const rule of rules) {
    const value = normalizeDomain(rule.value);
    if (rule.type === "DOMAIN" && suffixes.some((suffix) => value === suffix || value.endsWith(`.${suffix}`))) {
      warnings.push(`${rule.label} DOMAIN,${rule.value} 可能已被前面的 DOMAIN-SUFFIX 覆盖。`);
    }
    if (rule.type === "DOMAIN-SUFFIX") suffixes.push(value);
  }
  return warnings;
}

function normalizeDomain(value: string): string {
  return value.trim().replace(/^\+\./, "").replace(/^\*\./, "").replace(/^\./, "").replace(/\.$/, "").toLowerCase();
}

function ruleSetSourcesForOutputs(config: AppConfig, outputs: RuleSetOutput[], outputSpecific: boolean): AppConfig["ruleSets"]["sources"] {
  if (!outputSpecific) {
    return config.ruleSets.sources.filter((source) => source.enabled && source.url);
  }
  const sourceIds = new Set(outputs.flatMap((output) => output.sourceIds));
  return config.ruleSets.sources.filter((source) => source.enabled && source.url && sourceIds.has(source.id));
}

function changedRuleSetOutputs(previousConfig: AppConfig, config: AppConfig): RuleSetOutput[] {
  const outputs = effectiveRuleSetOutputs(config.ruleSets);
  if (previousConfig.ruleSets.mode !== "compiled") return outputs;
  const changedSourceIds = changedRuleSetSourceIds(previousConfig, config);
  const previousByName = new Map(effectiveRuleSetOutputs(previousConfig.ruleSets).map((output) => [output.name, output]));
  return outputs.filter((output) => {
    const previous = previousByName.get(output.name);
    if (!previous || !previous.enabled) return true;
    if (output.sourceIds.some((sourceId) => changedSourceIds.has(sourceId))) return true;
    return previous.policy !== output.policy
      || previous.enabled !== output.enabled
      || !sameStringList(previous.sourceIds, output.sourceIds)
      || !sameStringList(previous.inlineRules, output.inlineRules)
      || !sameStringList(previous.surgeOptions, output.surgeOptions);
  });
}

function changedRuleSetSourceIds(previousConfig: AppConfig, config: AppConfig): Set<string> {
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
