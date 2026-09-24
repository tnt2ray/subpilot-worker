import { compileRuleSetContent, RuleSetCompileError, ruleSetOutputFingerprint } from "./rule-set-compiler-core";
export { RuleSetCompileError, ruleSetOutputFingerprint } from "./rule-set-compiler-core";
import { managedRuleSetUrlForRequest } from "./managed-url";
import {
  fetchCachedRuleSetSource,
  InvalidRuleSetSourceResponseError,
  readRefreshedRuleSetSource,
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
  type RuleSetSourceRefreshState
} from "./rule-set-cache";
import { type RuleSetBucket, type RuleSetOutput, type RuleSetOutputTarget } from "./rule-set-types";
import { planRuleSetArtifacts } from "./rule-set-artifacts";
import { compiledRuleProviderName } from "./rule-provider-name";
import { splitRuleLine } from "./rule-line";
import {
  configuredTailscalePolicyNames,
  isRulePolicyCompatibleWithTarget,
  renderDirectRuleForTarget
} from "./rule-targets";
import { directRuleSetSource, effectiveRuleSetOutputs, isSingboxBinarySource, planRuleSetOutputs, ruleSetOutputNeedsCompilation } from "./rule-set-outputs";
import type { RenderConfig } from "./types";
import { createSingboxAsnResolver } from "./singbox-asn";
import { createActionsManifestReader, ensureActionsCompilation, readActionsManifest, usesActionsCompilation } from "./actions-compiler";
import { githubActionsArtifactUrl } from "./actions-compiler-artifacts";
import { ruleCompilationMode, workerFallbackConfig } from "./rule-compilation-mode";
import { aggregateRuleSet } from "./singbox-srs";
import { ruleSetArtifactsBucket, workerFallbackEnv } from "./rule-set-scope";
import { readWasmCompilationFailure, recordWasmCompilationFailure, wasmCompilationFailureUnresolved } from "./rule-set-wasm-failure";

export interface RuleSetRefreshResult {
  queued?: boolean;
  refreshed: number;
  /** Outputs whose current configuration and source bodies already match the cache. */
  unchanged?: number;
  failed: number;
  cached: number;
  deleted: number;
  updatedAt: string;
  warnings: string[];
  failures: RuleSetSourceCacheFailure[];
  outputFailures: RuleSetOutputRefreshFailure[];
  /** Outputs that still need a successful refresh, including stale cache fallbacks. */
  pendingOutputNames?: string[];
  outputs: CompiledRuleSetStatusItem[];
}

export interface RuleSetOutputRefreshFailure {
  outputName: string;
  reason: string;
  usedCachedManifest: boolean;
}

export interface RuleSetRefreshOptions {
  skipActionsDispatch?: boolean;
  sourceRefresh?: RuleSetSourceCacheRefreshResult;
  /** Revalidate the current output before publishing its completed artifacts. */
  canPublish?: (output: RuleSetOutput) => Promise<boolean>;
  /** Absolute Unix timestamp in milliseconds after which no new fetch or output compilation starts. */
  deadline?: number;
}

export interface CompiledRuleSetReferencePlan {
  surgeDnsHosts?: string[];
  clashDnsPolicy?: Record<string, string>;
  surgeRules: string[];
  clashRuleProviders: Record<string, Record<string, unknown>>;
  clashRules: string[];
  clashRuleComments: Record<string, string>;
  errors: string[];
  warnings: string[];
}

interface CompileOptions {
  /** Retained for managed downloads; this never overrides the selected compiler. */
  workerOnly?: boolean;
  asnResolver?: ReturnType<typeof createSingboxAsnResolver>;
  allowStaleFallback?: boolean;
  forceSourceRefresh?: boolean;
  /** Repair callers omit this flag so damaged artifacts are always rebuilt. */
  skipUnchangedSources?: boolean;
  sourceStatesByKey?: Map<string, RuleSetSourceRefreshState>;
  sourceErrorsByKey?: Map<string, string>;
  deadline?: number;
  canPublish?: () => Promise<boolean>;
}

const FINAL_RULE_TYPES = new Set(["FINAL", "MATCH"]);
const RULE_SET_UPDATE_INTERVAL_SECONDS = 24 * 60 * 60;

export async function compileRuleSetOutput(
  env: Env,
  config: RenderConfig,
  output: RuleSetOutput,
  options: CompileOptions = {}
): Promise<{ manifest: CompiledRuleSetManifest; stale: boolean; unchanged?: boolean }> {
  const mode = ruleCompilationMode(config);
  if (mode === "actions") {
    const manifest = await readActionsManifest(env, config, output);
    if (manifest) return { manifest, stale: false };
    throw new Error("Actions 规则产物尚未就绪，请查看编译进度并稍后重试。");
  }
  if (mode !== "wasm") return compileRuleSetSourceOutput(env, config, output, options);
  const target = config.renderTarget ?? "surge";
  const fingerprint = await ruleSetOutputFingerprint(config, output);
  try {
    if (!ruleSetArtifactsBucket(env)) {
      throw new Error("WASM 模式需要启用可选的 R2 规则产物存储；请运行 npm run setup -- --enable-r2 后重新部署。");
    }
    const failedAt = await readWasmCompilationFailure(env, target, fingerprint);
    const previous = failedAt ? await readCompiledRuleSetManifest(env, output.name, { allowLegacy: false }) : null;
    const needsRecovery = wasmCompilationFailureUnresolved(failedAt, previous?.outputFingerprint === fingerprint ? previous : null);
    const result = await compileRuleSetSourceOutput(env, config, output, {
      ...options, ...(needsRecovery ? { skipUnchangedSources: false } : {})
    });
    // A retained WASM artifact cannot stand in for a failed preferred refresh.
    if (result.stale) throw new Error("WASM 规则编译失败，首选产物暂不可用。");
    return result;
  } catch (error) {
    await recordWasmCompilationFailure(env, target, fingerprint);
    throw error;
  }
}

async function compileRuleSetSourceOutput(
  env: Env,
  config: RenderConfig,
  output: RuleSetOutput,
  options: CompileOptions
): Promise<{ manifest: CompiledRuleSetManifest; stale: boolean; unchanged?: boolean }> {
  const compilationMode = ruleCompilationMode(config);
  if (compilationMode === "actions") throw new Error("Actions 模式不允许在 Worker 中编译规则。");
  const outputFingerprint = await ruleSetOutputFingerprint(config, output);
  const stored = options.skipUnchangedSources
    ? await readCompiledRuleSetManifest(env, output.name, { allowLegacy: false }).catch(() => null)
    : null;
  const previous = stored && manifestMatchesCompiler(config, stored) ? stored : null;
  if (previous) {
    const refreshed = await refreshedSourceHashes(config, output, options);
    if (refreshed && canReuseCompiledOutput(previous, outputFingerprint, refreshed.hashes)) {
      return { manifest: previous, stale: refreshed.stale, unchanged: true };
    }
  }
  let compiled;
  try {
    compiled = await compileRuleSetContent(config, output, {
      ...(compilationMode === "wasm" ? { aggregateRules: aggregateRuleSet } : {}),
      ...(options.deadline !== undefined ? { deadline: options.deadline } : {}),
      reuseManifest: (hashes) => previous && canReuseCompiledOutput(previous, outputFingerprint, hashes) ? previous : null,
      asnResolver: options.asnResolver ?? createSingboxAsnResolver(env, options.deadline),
      loadSource: async (source) => {
        const sourceKey = await ruleSetSourceCacheKey(source.url);
        const error = options.sourceErrorsByKey?.get(sourceKey);
        if (error) throw new Error(`${source.name}: ${error}`);
        const refreshed = options.sourceStatesByKey?.get(sourceKey);
        try {
          return await (refreshed ? readRefreshedRuleSetSource(env, sourceKey, refreshed) : fetchCachedRuleSetSource(env, source, {
          allowCachedFallback: true, forceRefresh: Boolean(options.forceSourceRefresh),
          ...(options.deadline !== undefined ? { deadline: options.deadline } : {})
          }));
        } catch (error) {
          if (config.renderTarget === "sing-box" && (error instanceof InvalidRuleSetSourceResponseError
            || error instanceof Error && error.cause instanceof InvalidRuleSetSourceResponseError)) throw new RuleSetCompileError("format");
          throw error;
        }
      }
    });
  } catch (error) {
    const existing = options.allowStaleFallback && !refreshDeadlineExceeded(options.deadline)
      ? await readCompiledRuleSetManifest(env, output.name) : null;
    if (existing?.outputFingerprint === outputFingerprint) return { manifest: { ...existing, warnings: [...existing.warnings, `${output.name}: 刷新失败，继续使用旧编译缓存：${error instanceof Error ? error.message : String(error)}`] }, stale: true };
    throw error;
  }
  const { manifest, buckets, stale: usedCachedSource } = compiled;
  if (compilationMode === "wasm") {
    if (usedCachedSource) throw new Error("Compilation requires complete current source data");
    const target = config.renderTarget ?? "surge";
    if (manifest.buckets.some((bucket) => bucket.targetCounts?.[target] !== bucket.count)) {
      throw new Error("Rules cannot be represented by the target client");
    }
  }
  if (compiled.unchanged) return { manifest, stale: usedCachedSource, unchanged: true };
  if (previous && canReuseCompiledOutput(previous, outputFingerprint, manifest.sourceContentHashes ?? {})) {
    return { manifest: previous, stale: usedCachedSource, unchanged: true };
  }
  try {
    await writeCompiledRuleSet(env, manifest, buckets, { compilationMode, ...(options.canPublish ? { canPublish: options.canPublish } : {}) });
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
  output: RuleSetOutput,
  options: { canPublish?: () => Promise<boolean> } = {}
): Promise<CompiledRuleSetManifest> {
  if (ruleCompilationMode(config) === "actions") {
    const published = await readActionsManifest(env, config, output);
    if (published) return published;
    throw new Error("Actions 规则产物尚未就绪，请查看编译进度并稍后重试。");
  }
  const cached = await readCompiledRuleSetManifest(env, output.name);
  const fingerprint = await ruleSetOutputFingerprint(config, output);
  const wasmFailed = ruleCompilationMode(config) === "wasm" && wasmCompilationFailureUnresolved(
    await readWasmCompilationFailure(env, config.renderTarget ?? "surge", fingerprint), cached
  );
  if (!wasmFailed && cached?.outputFingerprint === fingerprint && manifestMatchesCompiler(config, cached)
    && (cached.asnExpiresAt === undefined || cached.asnExpiresAt > Date.now())) return cached;
  return compileRuleSetOutput(env, config, output, { allowStaleFallback: true, ...options }).then((result) => result.manifest);
}

/** Older manifests must still provide all artifacts required by the selected compiler. */
export function manifestMatchesCompiler(config: RenderConfig, manifest: CompiledRuleSetManifest): boolean {
  const mode = ruleCompilationMode(config);
  if (mode !== "actions" && manifest.compilationMode && manifest.compilationMode !== mode) return false;
  if (mode !== "wasm" || config.renderTarget !== "sing-box") return true;
  if (manifest.storageBackend !== "r2") return false;
  const required = new Set<NonNullable<CompiledRuleSetManifest["srsBuckets"]>[number]>(
    planRuleSetArtifacts(manifest.buckets, "sing-box", manifest.provider?.behavior, manifest.surgeType)
      .map((artifact) => artifact.bucket)
  );
  if ((manifest.dnsRuleCount ?? 0) > 0) required.add("dns");
  return [...required].every((bucket) => manifest.srsBuckets?.includes(bucket));
}

function canReuseCompiledOutput(
  manifest: CompiledRuleSetManifest,
  outputFingerprint: string,
  hashes: Record<string, string>
): boolean {
  const previous = manifest.sourceContentHashes;
  return Boolean(manifest.storageId) && manifest.outputFingerprint === outputFingerprint
    && (manifest.asnExpiresAt === undefined || manifest.asnExpiresAt > Date.now())
    && previous !== undefined && Object.keys(previous).length === Object.keys(hashes).length
    && Object.entries(hashes).every(([key, hash]) => previous[key] === hash);
}

async function refreshedSourceHashes(
  config: RenderConfig,
  output: RuleSetOutput,
  options: CompileOptions
): Promise<{ hashes: Record<string, string>; stale: boolean } | null> {
  const sources = new Map(config.ruleSets.sources.map((source) => [source.id, source]));
  const hashes: Record<string, string> = {};
  let stale = false;
  for (const sourceId of output.sourceIds) {
    const source = sources.get(sourceId);
    if (!source?.enabled || !source.url) return null;
    if (config.renderTarget === "sing-box" && isSingboxBinarySource(source)) continue;
    const key = await ruleSetSourceCacheKey(source.url);
    if (options.sourceErrorsByKey?.has(key)) return null;
    const state = options.sourceStatesByKey?.get(key);
    if (!state) return null;
    hashes[key] = state.contentHash;
    stale ||= state.usedCachedContent;
  }
  return { hashes, stale };
}

export async function refreshRuleSetCaches(
  env: Env,
  config: RenderConfig,
  outputName?: string,
  options: RuleSetRefreshOptions = {}
): Promise<RuleSetRefreshResult> {
  const effectiveOutputs = config.ruleSets.mode === "compiled" ? effectiveRuleSetOutputs(config.ruleSets) : [];
  const outputs = outputName
    ? effectiveOutputs.filter((output) => output.name === outputName)
    : effectiveOutputs;
  if (outputName && outputs.length === 0) throw new Error("Rule set output not found");
  if (usesActionsCompilation(config)) {
    let queued = false;
    const warnings: string[] = [];
    if (!options.skipActionsDispatch) {
      try {
        await ensureActionsCompilation(env, config, { force: true, refresh: true, ...(options.deadline ? { deadline: options.deadline } : {}) });
        queued = true;
        warnings.push("已提交 Actions 编译请求，请等待远程产物就绪。");
      } catch { warnings.push("Actions 请求暂未确认，后台将重试；请在编译进度中查看状态。"); }
    }
    return {
      queued, refreshed: 0, unchanged: 0, failed: 0, cached: 0, deleted: 0,
      updatedAt: new Date().toISOString(), warnings, failures: [], outputFailures: [], pendingOutputNames: [],
      outputs: refreshDeadlineExceeded(options.deadline) ? [] : await readRuleSetStatus(env, config)
    };
  }
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
  if (usesActionsCompilation(config)) return refreshRuleSetCaches(env, config, undefined, options);
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
  outputs = outputs.filter((output) => ruleSetOutputNeedsCompilation(config.ruleSets, output, config.renderTarget ?? "surge"));
  const neededSourceIds = new Set(outputs.flatMap((output) => output.sourceIds));
  sourcesToRefresh = sourcesToRefresh.filter((source) => neededSourceIds.has(source.id)
    && !(config.renderTarget === "sing-box" && isSingboxBinarySource(source)));
  const sourceRefresh = options.sourceRefresh ? await scopeRuleSetSourceRefresh(options.sourceRefresh, config) : await refreshRuleSetSourceCaches(env, config, sourcesToRefresh, {
    pruneUnexpected,
    ...(options.deadline !== undefined ? { deadline: options.deadline } : {})
  });
  const canContinue = !refreshDeadlineExceeded(options.deadline);
  const compiledDeleted = pruneUnexpected && canContinue ? await pruneCompiledRuleSetCaches(env, config) : 0;

  let refreshed = 0;
  let unchanged = 0;
  let failed = 0;
  let cached = 0;
  const warnings = new Set(sourceRefresh.warnings);
  const outputFailures: RuleSetOutputRefreshFailure[] = [];
  const pendingOutputNames: string[] = [];
  if (pruneUnexpected && !canContinue) warnings.add("规则集刷新已到截止时间，跳过过期编译缓存清理。");

  for (let outputIndex = 0; outputIndex < outputs.length; outputIndex += 1) {
    const output = outputs[outputIndex]!;
    if (refreshDeadlineExceeded(options.deadline)) {
      const reason = "规则集刷新已超过截止时间";
      for (const remaining of outputs.slice(outputIndex)) {
        failed += 1;
        pendingOutputNames.push(remaining.name);
        outputFailures.push({ outputName: remaining.name, reason, usedCachedManifest: false });
        warnings.add(`${remaining.name}: ${reason}。`);
      }
      break;
    }
    try {
      const result = await compileRuleSetOutput(env, config, output, {
        asnResolver: createSingboxAsnResolver(env, options.deadline),
        allowStaleFallback: true,
        skipUnchangedSources: true,
        sourceStatesByKey: sourceRefresh.sourcesByKey,
        sourceErrorsByKey: sourceRefresh.errorsByKey,
        ...(options.canPublish ? { canPublish: () => options.canPublish!(output) } : {}),
        ...(options.deadline !== undefined ? { deadline: options.deadline } : {})
      });
      if (result.stale) {
        cached += 1;
        pendingOutputNames.push(output.name);
      } else if (result.unchanged) {
        unchanged += 1;
      } else {
        refreshed += 1;
      }
      for (const warning of result.manifest.warnings) warnings.add(warning);
    } catch (error) {
      failed += 1;
      pendingOutputNames.push(output.name);
      const reason = error instanceof Error ? error.message : String(error);
      const existing = refreshDeadlineExceeded(options.deadline)
        ? null
        : await readCompiledRuleSetManifest(env, output.name);
      const usedCachedManifest = ruleCompilationMode(config) !== "wasm"
        && existing?.outputFingerprint === await ruleSetOutputFingerprint(config, output);
      if (usedCachedManifest) cached += 1;
      outputFailures.push({ outputName: output.name, reason, usedCachedManifest });
      warnings.add(`${output.name}: ${reason}${usedCachedManifest ? "，继续使用旧编译缓存" : ""}`);
    }
  }

  return {
    refreshed,
    unchanged,
    failed,
    cached,
    deleted: sourceRefresh.deleted + compiledDeleted,
    updatedAt: new Date().toISOString(),
    warnings: [...warnings],
    failures: sourceRefresh.failures,
    outputFailures,
    pendingOutputNames,
    outputs: refreshDeadlineExceeded(options.deadline) ? [] : await readRuleSetStatus(env, config)
  };
}

function refreshDeadlineExceeded(deadline: number | undefined): boolean {
  return deadline !== undefined && Date.now() >= deadline;
}

export async function readRuleSetStatus(env: Env, config: RenderConfig): Promise<CompiledRuleSetStatusItem[]> {
  if (config.ruleSets.mode !== "compiled") return [];
  const mode = ruleCompilationMode(config);
  const wasmNeedsR2 = mode === "wasm" && !ruleSetArtifactsBucket(env);
  const readActions = usesActionsCompilation(config) ? await createActionsManifestReader(env, config) : null;
  return Promise.all(effectiveRuleSetOutputs(config.ruleSets).map(async (output) => {
    if (!ruleSetOutputNeedsCompilation(config.ruleSets, output, config.renderTarget ?? "surge")) return {
      outputName: output.name, enabled: output.enabled, direct: true, updatedAt: null,
      ruleCount: 0, duplicateCount: 0, buckets: [], artifacts: [], warnings: [], cached: false
    };
    const published = readActions ? await readActions(output) : null;
    const stored = readActions ? published : await readCompiledRuleSetManifest(env, output.name);
    const fingerprint = await ruleSetOutputFingerprint(config, output);
    let manifest = stored?.outputFingerprint === fingerprint && manifestMatchesCompiler(config, stored) ? stored : null;
    const wasmFailed = mode === "wasm" && wasmCompilationFailureUnresolved(
      await readWasmCompilationFailure(env, config.renderTarget ?? "surge", fingerprint), manifest
    );
    if (wasmFailed) manifest = null;
    let fallback = false;
    if (!manifest && mode !== "worker") {
      const backup = await readCompiledRuleSetManifest(workerFallbackEnv(env, config.renderTarget ?? "surge"), output.name, { allowLegacy: false });
      if (backup?.outputFingerprint === await ruleSetOutputFingerprint(workerFallbackConfig(config), output)) {
        manifest = backup;
        fallback = true;
      }
    }
    const target = config.renderTarget ?? "surge";
    const actionsPending = usesActionsCompilation(config) && !published;
    const count = (bucket: RuleSetBucket): number => manifest?.buckets.find((item) => item.bucket === bucket)?.targetCounts?.[target] ?? 0;
    return {
      outputName: output.name,
      enabled: output.enabled,
      updatedAt: manifest?.updatedAt || null,
      ruleCount: manifest?.ruleCount ?? 0,
      duplicateCount: manifest?.duplicateCount ?? 0,
      buckets: manifest?.buckets ?? [],
      artifacts: planRuleSetArtifacts(manifest?.buckets ?? [], target, manifest?.provider?.behavior, manifest?.surgeType).map((artifact) => ({
        behavior: artifact.behavior,
        count: artifact.behavior === "domain" ? count("domain") : artifact.behavior === "ipcidr" ? count("ipcidr") : count("classical") + (artifact.includesDomains ? count("domain") : 0) + (artifact.includesIpCidr ? count("ipcidr") : 0)
      })),
      warnings: [...(manifest?.warnings ?? []), ...(fallback ? [wasmNeedsR2
        ? "WASM 需要可选的 R2 存储；当前使用普通 Worker 回退。配置 R2 后将自动恢复 WASM。"
        : "当前使用普通 Worker 备用规则，首选产物就绪后自动恢复。"]
        : actionsPending ? ["Actions 与普通 Worker 备用产物仍在准备，请稍后重试。"]
          : wasmNeedsR2 ? ["WASM 需要可选的 R2 存储；启用并重新部署后即可恢复 WASM。"]
            : wasmFailed ? ["WASM 编译失败，普通 Worker 备用产物仍在准备，请稍后重试。"] : [])],
      cached: Boolean(manifest)
    };
  }));
}

export async function buildCompiledRuleSetReferencePlan(
  env: Env,
  config: RenderConfig,
  target: RuleSetOutputTarget,
  requestUrl: string,
  manifests?: ReadonlyMap<string, CompiledRuleSetManifest>
): Promise<CompiledRuleSetReferencePlan> {
  const plan: CompiledRuleSetReferencePlan = {
    surgeDnsHosts: [],
    clashDnsPolicy: {},
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
        plan.errors.push(`${item.rule.id}: Tailscale 策略 ${item.rule.policy} 仅支持 Surge，已从 ${targetName(target)} 输出过滤。`);
        continue;
      }
      if (!isRulePolicyCompatibleWithTarget(item.rule.policy, target)) {
        plan.errors.push(`${item.rule.id}: 策略 ${item.rule.policy} 不受 ${targetName(target)} 支持，已过滤。`);
        continue;
      }
      const line = renderDirectRuleForTarget(item.rule, target);
      if (!line) {
        plan.errors.push(`${item.rule.id}: 规则语法不受 ${targetName(target)} 支持，已过滤。`);
        continue;
      }
      if (!isFinalRuleLine(line) && directRuleMatchSignature(item.rule.rule) !== directRuleMatchSignature(line)) {
        plan.warnings.push(`${item.rule.id}: 规则语法已映射为 ${targetName(target)} 兼容格式。`);
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
      const direct = directRuleSetSource(config.ruleSets, output, target);
      if (direct) {
        if (target === "surge") {
          if (output.dnsServer) plan.surgeDnsHosts!.push(`${direct.surgeType}:${direct.url} = server:${output.dnsServer}`);
          plan.surgeRules.push([direct.surgeType!, direct.url, output.policy, ...output.surgeOptions].join(","));
        } else {
          const providerName = compiledRuleProviderName(output.name, "combined");
          plan.clashRuleProviders[providerName] = {
            type: "http", behavior: output.provider!.behavior, format: direct.format,
            url: direct.url, path: `./rules/${providerName}.${direct.format === "yaml" ? "yaml" : "txt"}`,
            interval: output.provider!.interval
          };
          if (output.dnsServer) plan.clashDnsPolicy![`rule-set:${providerName}`] = output.dnsServer;
          plan.clashRules.push(`RULE-SET,${providerName},${output.policy}${output.surgeOptions.includes("no-resolve") ? ",no-resolve" : ""}`);
        }
        continue;
      }
      const manifest = manifests ? manifests.get(output.name) : await ensureCompiledRuleSet(env, config, output);
      if (!manifest) throw new Error("规则集缓存尚未就绪，请稍后重试。");
      const compatibleCount = manifest.buckets.reduce((sum, bucket) => sum + (bucket.targetCounts?.[target] ?? 0), 0);
      if (compatibleCount !== manifest.ruleCount) throw new Error("规则集中存在当前输出端无法等价表达的规则。");
      const surgeStart = plan.surgeRules.length;
      const clashStart = plan.clashRules.length;
      appendCompiledOutputReferences(plan, config, output, manifest, target, requestUrl);
      if (config.ruleSets.aggregateByPolicy && !output.provider && !output.surgeType && !output.dnsServer) {
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
  const artifacts = planRuleSetArtifacts(manifest.buckets, target, manifest.provider?.behavior, manifest.surgeType);
  if (target === "surge") {
    for (const artifact of artifacts) {
      const url = manifest.publication ? githubActionsArtifactUrl(config, output.name, artifact.bucket) : managedRuleSetUrlForRequest(config, requestUrl, output.name, artifact.bucket, target);
      const options = surgeRuleSetOptions(output);
      const type = artifact.bucket === "domain" ? "DOMAIN-SET" : "RULE-SET";
      if (output.dnsServer && artifact.behavior !== "ipcidr") plan.surgeDnsHosts!.push(`${type}:${url} = server:${output.dnsServer}`);
      plan.surgeRules.push([type, url, output.policy, ...options].join(","));
    }
    return;
  }
  for (const artifact of artifacts) {
    const url = manifest.publication ? githubActionsArtifactUrl(config, output.name, artifact.bucket) : managedRuleSetUrlForRequest(config, requestUrl, output.name, artifact.bucket, target);
    const providerName = compiledRuleProviderName(output.name, artifact.bucket);
    plan.clashRuleProviders[providerName] = {
      type: "http",
      behavior: artifact.behavior,
      url,
      path: `./rules/${providerName}.yaml`,
      interval: output.provider?.interval ?? RULE_SET_UPDATE_INTERVAL_SECONDS
    };
    if (output.dnsServer && artifact.behavior !== "ipcidr") plan.clashDnsPolicy![`rule-set:${providerName}`] = output.dnsServer;
    plan.clashRules.push(`RULE-SET,${providerName},${output.policy}${output.surgeOptions.includes("no-resolve") && !(target === "clash" && config.ruleSets.aggregateByPolicy && !output.provider) ? ",no-resolve" : ""}`);
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

function surgeRuleSetOptions(output: RuleSetOutput): string[] {
  const options = output.surgeOptions.filter((option) => !/^update-interval=/i.test(option));
  options.push(`update-interval=${RULE_SET_UPDATE_INTERVAL_SECONDS}`);
  return options;
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
      || JSON.stringify(previous.provider) !== JSON.stringify(output.provider)
      || previous.dnsServer !== output.dnsServer
      || previous.surgeType !== output.surgeType
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

function nativeOutputMembers(config: RenderConfig, output: RuleSetOutput): unknown {
  if (config.renderTarget !== "clash" || !config.ruleSets.aggregateByPolicy || output.provider) return undefined;
  const names = new Set(planRuleSetOutputs(config.ruleSets).find((plan) => plan.output.name === output.name)?.includedOutputNames ?? [output.name]);
  return config.ruleSets.outputs.filter((item) => names.has(item.name))
    .map((item) => ({ sourceIds: item.sourceIds, inlineRules: item.inlineRules, options: item.surgeOptions, order: item.order }));
}
