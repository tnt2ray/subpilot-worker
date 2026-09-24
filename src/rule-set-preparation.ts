import { readCompiledRuleSetManifest, type CompiledRuleSetManifest } from "./rule-set-cache";
import { compileRuleSetOutput, manifestMatchesCompiler, RuleSetCompileError, ruleSetOutputFingerprint } from "./rule-set-compiler";
import { effectiveRuleSetOutputs, ruleSetOutputNeedsCompilation } from "./rule-set-outputs";
import type { RuleSetOutput } from "./rule-set-types";
import { createSingboxAsnResolver } from "./singbox-asn";
import type { RenderConfig } from "./types";
import { mapWithConcurrency } from "./util";
import { createActionsManifestReader, usesActionsCompilation } from "./actions-compiler";
import { ruleCompilationMode, workerFallbackConfig } from "./rule-compilation-mode";
import { workerFallbackEnv } from "./rule-set-scope";
import { createRuleSetPublicationGuard } from "./rule-set-publication";
import { readWasmCompilationFailure, wasmCompilationFailureUnresolved } from "./rule-set-wasm-failure";

const PREPARATION_CONCURRENCY = 3;
const REBUILD_DEADLINE_MS = 25_000;
const MIN_REBUILD_REMAINING_MS = 15_000;
const REBUILD_RETRY_SECONDS = 60;
const DEFAULT_RETRY_AFTER_SECONDS = 30;
const REBUILD_RETRY_PREFIX = "cache:ruleSetRebuildRetry:";

export interface PreparedRuleSetCache {
  manifests: Map<string, CompiledRuleSetManifest>;
  pending: RuleSetOutput[];
  unavailable: string[];
  retryAfterSeconds: number;
  failed: boolean;
  errors: string[];
}

interface PreparedOutput {
  output: RuleSetOutput;
  manifest: CompiledRuleSetManifest | null;
  pending: boolean;
  retryAfter: number;
  failed: boolean;
  error?: string;
}

interface RebuildFailure {
  retryAfter: number;
  code?: "configuration" | "format";
}

export interface RuntimeRuleSetCache {
  config: RenderConfig;
  env: Env;
  cache: PreparedRuleSetCache;
  preferred: PreparedRuleSetCache;
  fallback: boolean;
}

/** Keep the saved preference intact; select a separate Worker cache while it is unavailable. */
export async function prepareRuntimeRuleSetCache(
  env: Env,
  config: RenderConfig,
  outputs?: RuleSetOutput[]
): Promise<RuntimeRuleSetCache> {
  const preferred = await prepareRuleSetCache(env, config, outputs);
  if (ruleCompilationMode(config) === "worker" || (!preferred.unavailable.length && !preferred.failed)) {
    return { env, config, cache: preferred, preferred, fallback: false };
  }
  const fallbackConfig = workerFallbackConfig(config);
  const fallbackEnv = workerFallbackEnv(env, config.renderTarget ?? "surge");
  return {
    env: fallbackEnv, config: fallbackConfig, preferred, fallback: true,
    cache: await prepareRuleSetCache(fallbackEnv, fallbackConfig, outputs, { sourceOnly: true })
  };
}

export function scheduleRuntimeRuleSetRebuild(
  env: Env,
  config: RenderConfig,
  runtime: RuntimeRuleSetCache,
  ctx: Pick<ExecutionContext, "waitUntil">
): void {
  // Start the cheaper recovery path first. Preferred compilation remains enabled.
  if (runtime.fallback) scheduleRuleSetRebuild(runtime.env, runtime.config, runtime.cache.pending, ctx, { workerFallback: true });
  scheduleRuleSetRebuild(env, config, runtime.preferred.pending, ctx);
}

/** Read only artifacts produced by the selected compiler. */
export async function prepareRuleSetCache(
  env: Env,
  config: RenderConfig,
  outputs?: RuleSetOutput[],
  options: { force?: boolean; sourceOnly?: boolean } = {}
): Promise<PreparedRuleSetCache> {
  const result: PreparedRuleSetCache = {
    manifests: new Map(), pending: [], unavailable: [],
    retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS, failed: false, errors: []
  };
  const selected = compilationOutputs(config, outputs);
  const states: PreparedOutput[] = selected.map((output) => ({
    output, manifest: null, pending: true, retryAfter: 0, failed: false
  }));
  const actions = usesActionsCompilation(config);
  const wasm = ruleCompilationMode(config) === "wasm";
  const readActions = actions ? await createActionsManifestReader(env, config) : null;
  await mapWithConcurrency(states, PREPARATION_CONCURRENCY, async (state) => {
    try {
      const fingerprint = await ruleSetOutputFingerprint(config, state.output);
      const cached = readActions ? await readActions(state.output)
        : options.force ? null : await readCompiledRuleSetManifest(env, state.output.name, { allowLegacy: false, compilationMode: wasm ? "wasm" : "worker" });
      const wasmFailed = wasm && wasmCompilationFailureUnresolved(
        await readWasmCompilationFailure(env, config.renderTarget ?? "surge", fingerprint),
        cached?.outputFingerprint === fingerprint ? cached : null
      );
      state.failed = wasmFailed;
      if (!wasmFailed && cached?.outputFingerprint === fingerprint && manifestMatchesCompiler(config, cached)) {
        state.manifest = cached;
        state.pending = !manifestIsFresh(config, cached, fingerprint, options.sourceOnly === true);
      }
      if (state.pending && !actions) {
        const failure = await readRebuildFailure(env, config, fingerprint);
        state.retryAfter = failure.retryAfter;
        state.failed ||= state.retryAfter > Date.now();
        if (!state.manifest && failure.code) state.error = new RuleSetCompileError(failure.code).message;
      }
    } catch {
      state.failed = true;
    }
  });
  for (const state of states) {
    if (state.manifest) result.manifests.set(state.output.name, state.manifest);
    else result.unavailable.push(state.output.name);
    result.failed ||= state.failed;
    if (state.error && !result.errors.includes(state.error)) result.errors.push(state.error);
    result.retryAfterSeconds = Math.max(result.retryAfterSeconds, Math.ceil((state.retryAfter - Date.now()) / 1000));
  }
  // New or changed configurations take precedence over refreshing stale ASN data.
  result.pending = [
    ...states.filter((state) => !state.manifest),
    ...states.filter((state) => state.manifest && state.pending)
  ].filter((state) => state.retryAfter <= Date.now()).map((state) => state.output);
  return result;
}

/** Published manifests preserve progress between bounded background invocations. */
export function scheduleRuleSetRebuild(
  env: Env,
  config: RenderConfig,
  outputs: RuleSetOutput[],
  ctx: Pick<ExecutionContext, "waitUntil">,
  options: { force?: boolean; sourceOnly?: boolean; workerFallback?: boolean } = {}
): void {
  if (ruleCompilationMode(config) === "actions") return;
  const selected = compilationOutputs(config, outputs);
  if (!selected.length) return;
  ctx.waitUntil((async () => {
    const deadline = Date.now() + REBUILD_DEADLINE_MS;
    for (const output of selected) {
      if (deadline - Date.now() < MIN_REBUILD_REMAINING_MS) break;
      let fingerprint: string | undefined;
      try {
        fingerprint = await ruleSetOutputFingerprint(config, output);
        const cached = await readCompiledRuleSetManifest(env, output.name, {
          allowLegacy: false, compilationMode: ruleCompilationMode(config) === "wasm" ? "wasm" : "worker"
        });
        const wasmFailed = ruleCompilationMode(config) === "wasm" && wasmCompilationFailureUnresolved(
          await readWasmCompilationFailure(env, config.renderTarget ?? "surge", fingerprint),
          cached?.outputFingerprint === fingerprint ? cached : null
        );
        if (!options.force && !wasmFailed && cached && manifestIsFresh(config, cached, fingerprint, Boolean(options.sourceOnly || options.workerFallback))) {
          continue;
        }
        if ((await readRebuildFailure(env, config, fingerprint)).retryAfter > Date.now()) continue;
        if (deadline - Date.now() < MIN_REBUILD_REMAINING_MS) break;
        const resolveAsn = createSingboxAsnResolver(env, deadline);
        const compiled = await compileRuleSetOutput(env, config, output, {
          workerOnly: Boolean(options.sourceOnly), forceSourceRefresh: Boolean(options.sourceOnly || options.workerFallback), allowStaleFallback: true, deadline,
          canPublish: () => createRuleSetPublicationGuard(env, config, { workerFallback: options.workerFallback === true })(output),
          asnResolver: async (value) => {
            const result = await resolveAsn(value);
            // Never publish a partial output when an ASN has no usable fallback.
            if (!result.prefixes.length && result.warning) throw new Error("Rule-set ASN data is unavailable.");
            return result;
          }
        });
        if (compiled.stale || !manifestIsFresh(config, compiled.manifest, fingerprint, Boolean(options.sourceOnly || options.workerFallback))
          || (options.force && cached && compiled.manifest.storageId === cached.storageId)) {
          await recordRebuildFailure(env, config, fingerprint);
        }
      } catch (error) {
        if (fingerprint) await recordRebuildFailure(env, config, fingerprint, error instanceof RuleSetCompileError ? error.code : undefined);
        else logRebuildFailure();
      }
    }
  })().catch(logRebuildFailure));
}

function compilationOutputs(config: RenderConfig, outputs?: RuleSetOutput[]): RuleSetOutput[] {
  if (config.ruleSets.mode !== "compiled") return [];
  const target = config.renderTarget ?? "surge";
  const names = new Set<string>();
  return (outputs ?? effectiveRuleSetOutputs(config.ruleSets)).filter((output) => {
    if (!output.enabled || names.has(output.name) || !ruleSetOutputNeedsCompilation(config.ruleSets, output, target)) return false;
    names.add(output.name);
    return true;
  });
}

function manifestIsFresh(config: RenderConfig, manifest: CompiledRuleSetManifest, fingerprint: string, checkAge = false): boolean {
  return Boolean(manifest.storageId || manifest.publication) && manifest.outputFingerprint === fingerprint && manifestMatchesCompiler(config, manifest)
    && (manifest.asnExpiresAt === undefined || manifest.asnExpiresAt > Date.now())
    && (!checkAge || Date.now() - Date.parse(manifest.updatedAt) < 24 * 60 * 60_000);
}

function retryKey(config: RenderConfig, fingerprint: string): string {
  // Fingerprints are SHA-256 digests; keys contain no output names or source URLs.
  return `${REBUILD_RETRY_PREFIX}${config.renderTarget ?? "surge"}:${fingerprint}`;
}

async function readRebuildFailure(env: Env, config: RenderConfig, fingerprint: string): Promise<RebuildFailure> {
  const stored = await env.SUBPILOT_CONFIG.get<RebuildFailure | number>(retryKey(config, fingerprint), "json");
  const retryAfter = Number(typeof stored === "number" ? stored : stored?.retryAfter);
  const now = Date.now();
  if (!Number.isFinite(retryAfter) || retryAfter <= now || retryAfter > now + REBUILD_RETRY_SECONDS * 1000) return { retryAfter: 0 };
  const code = typeof stored === "object" ? stored?.code : undefined;
  return { retryAfter, ...(code === "configuration" || code === "format" ? { code } : {}) };
}

async function recordRebuildFailure(env: Env, config: RenderConfig, fingerprint: string, code?: RebuildFailure["code"]): Promise<void> {
  logRebuildFailure();
  try {
    // Persist only a fixed category and timestamp, never compiler error text.
    await env.SUBPILOT_CONFIG.put(retryKey(config, fingerprint), JSON.stringify({ retryAfter: Date.now() + REBUILD_RETRY_SECONDS * 1000, code }), {
      expirationTtl: REBUILD_RETRY_SECONDS
    });
  } catch { /* A failed retry marker must not prevent other outputs from progressing. */ }
}

function logRebuildFailure(): void {
  console.warn(JSON.stringify({ level: "warn", message: "Background rule-set preparation failed; retry is deferred." }));
}
