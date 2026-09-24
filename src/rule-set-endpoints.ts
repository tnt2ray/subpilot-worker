import { ensureActionsCompilation, usesActionsCompilation } from "./actions-compiler";
import { githubActionsArtifactUrl } from "./actions-compiler-artifacts";
import { getOrCreateReadToken } from "./auth";
import { notifyRuleSetRefreshFailures } from "./notifications";
import { compileRuleSetOutput, ensureCompiledRuleSet, readRuleSetStatus, refreshRuleSetCaches } from "./rule-set-compiler";
import { readCompiledRuleSetBucket, readCompiledRuleSetManifest, readCompiledRuleSetSrs } from "./rule-set-cache";
import {
  cacheCompiledRuleSetResponse,
  compiledCacheVersion,
  clientRuleSetResponse,
  compiledRuleSetFileResponse,
  matchCompiledRuleSetWorkerCache,
  warmCompiledRuleSetWorkerCache
} from "./rule-set-worker-cache";
import { ruleSetPathName, type RuleSetSyncPath } from "./managed-url";
import { planRuleSetArtifacts } from "./rule-set-artifacts";
import { effectiveRuleSetOutputs, ruleSetOutputNeedsCompilation } from "./rule-set-outputs";
import { prepareRuleSetCache, prepareRuntimeRuleSetCache, scheduleRuleSetRebuild, scheduleRuntimeRuleSetRebuild } from "./rule-set-preparation";
import type { RuleSetOutput, RuleSetOutputTarget } from "./rule-set-types";
import type { RenderConfig } from "./types";
import { badRequest, jsonResponse, notFound } from "./util";
import { ruleCompilationMode, workerFallbackConfig } from "./rule-compilation-mode";
import { createRuleSetPublicationGuard } from "./rule-set-publication";
import { workerFallbackEnv } from "./rule-set-scope";

const WAIT_UNTIL_CACHE_WARM_DEADLINE_MS = 20_000;
const MANUAL_RULE_SET_REFRESH_DEADLINE_MS = 20_000;

export async function handleRuleSetApi(request: Request, env: Env, ctx: ExecutionContext, config: RenderConfig): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/rule-sets/status" && request.method === "GET") {
    return jsonResponse({
      mode: config.ruleSets.mode,
      outputs: await readRuleSetStatus(env, config)
    });
  }
  if (url.pathname === "/api/rule-sets/refresh" && request.method === "POST") {
    const result = await refreshRuleSetCaches(env, config, undefined, {
      deadline: Date.now() + MANUAL_RULE_SET_REFRESH_DEADLINE_MS,
      canPublish: createRuleSetPublicationGuard(env, config)
    });
    scheduleRuleSetWorkerCacheWarm(env, ctx, config, request.url);
    return jsonResponse({
      ...result,
      notification: await notifyRuleSetRefreshFailures(env, config, result, "manual")
    });
  }
  const refreshMatch = url.pathname.match(/^\/api\/rule-sets\/refresh\/([^/]+)$/);
  if (refreshMatch && request.method === "POST") {
    const outputName = safeDecodePathSegment(refreshMatch[1]!);
    if (!outputName) return badRequest("Invalid rule set output name");
    try {
      const result = await refreshRuleSetCaches(env, config, outputName, {
        deadline: Date.now() + MANUAL_RULE_SET_REFRESH_DEADLINE_MS,
        canPublish: createRuleSetPublicationGuard(env, config)
      });
      scheduleRuleSetWorkerCacheWarm(env, ctx, config, request.url, [outputName]);
      return jsonResponse({
        ...result,
        notification: await notifyRuleSetRefreshFailures(env, config, result, "manual")
      });
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : String(error));
    }
  }
  const compiledMatch = url.pathname.match(/^\/api\/rule-sets\/compiled\/([^/]+)$/);
  if (compiledMatch && request.method === "GET") {
    const outputName = safeDecodePathSegment(compiledMatch[1]!);
    if (!outputName) return badRequest("Invalid rule set output name");
    if (config.ruleSets.mode !== "compiled" || !effectiveRuleSetOutputs(config.ruleSets).some((output) =>
      output.name === outputName && ruleSetOutputNeedsCompilation(config.ruleSets, output, config.renderTarget ?? "surge"))) return notFound();
    const output = effectiveRuleSetOutputs(config.ruleSets).find((item) => item.name === outputName)!;
    const runtime = await prepareRuntimeRuleSetCache(env, config, [output]);
    const manifest = runtime.cache.manifests.get(outputName);
    if (!manifest) return notFound();
    return jsonResponse({ manifest, compilationMode: ruleCompilationMode(runtime.config), preferredCompilationMode: ruleCompilationMode(config) });
  }
  return null;
}

export async function handleRuleSetDownload(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  config: RenderConfig,
  path: RuleSetSyncPath
): Promise<Response> {
  if (config.ruleSets.mode !== "compiled") return notFound();
  const resolved = resolveRuleSetDownload(config, path);
  if (!resolved) return notFound();
  const { output, bucket, target } = resolved;
  if (usesActionsCompilation(config)) {
    ctx.waitUntil(ensureActionsCompilation(env, config, { deadline: Date.now() + 25_000 }).catch(logRuleSetWorkerCacheError));
  }
  let fallback = false;
  if (ruleCompilationMode(config) !== "worker") {
    const runtime = await prepareRuntimeRuleSetCache(env, config);
    scheduleRuntimeRuleSetRebuild(env, config, runtime, ctx);
    // A previously issued JSON address always stays JSON, including after recovery.
    if (target === "sing-box" && !path.binarySrs) {
      config = workerFallbackConfig(config);
      env = workerFallbackEnv(env, target);
      fallback = true;
    } else if (runtime.fallback) {
      if (path.binarySrs) return ruleSetModeChangedResponse();
      config = runtime.config;
      env = runtime.env;
      fallback = true;
    } else if (usesActionsCompilation(config)) {
      const published = runtime.cache.manifests.get(output.name);
      if (!published || !manifestSupportsDownload(published, bucket, target)) return ruleSetModeChangedResponse();
      return Response.redirect(githubActionsArtifactUrl(config, output.name, bucket), 302);
    }
  }
  if (path.binarySrs && ruleCompilationMode(config) !== "wasm") return ruleSetModeChangedResponse();
  if (target === "sing-box") return handlePreparedSingboxRuleSetDownload(request, env, ctx, config, output, bucket, path.binarySrs === true, fallback);

  const publicationGuard = createRuleSetPublicationGuard(env, config, { workerFallback: fallback });
  const canPublish = () => publicationGuard(output);
  let manifest;
  try {
    manifest = await ensureCompiledRuleSet(env, config, output, { canPublish });
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : String(error));
  }
  if (!manifest) return notFound();
  if (!manifestSupportsDownload(manifest, bucket, target)) return notFound();

  const cachedResponse = await matchCompiledRuleSetWorkerCache(request, compiledCacheVersion(manifest));
  if (cachedResponse) return cachedResponse;

  let content = await readCompiledRuleSetBucket(env, output.name, bucket, target, manifest);
  if (content === null) {
    try {
      manifest = await compileRuleSetOutput(env, config, output, { workerOnly: true, allowStaleFallback: true, canPublish }).then((result) => result.manifest);
      if (!manifest) return notFound();
      if (!manifestSupportsDownload(manifest, bucket, target)) return notFound();
      content = await readCompiledRuleSetBucket(env, output.name, bucket, target, manifest);
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : String(error));
    }
  }
  if (content === null) return notFound();
  const response = await compiledRuleSetFileResponse(content, target);
  ctx.waitUntil(cacheCompiledRuleSetResponse(request.url, compiledCacheVersion(manifest), response.clone()).catch(logRuleSetWorkerCacheError));
  return clientRuleSetResponse(request, response);
}

async function handlePreparedSingboxRuleSetDownload(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  config: RenderConfig,
  output: RuleSetOutput,
  bucket: "domain" | "ipcidr" | "combined" | "dns",
  binarySrs: boolean,
  workerFallback = false
): Promise<Response> {
  const prepared = await prepareRuleSetCache(env, config, [output], { sourceOnly: true });
  const manifest = prepared.manifests.get(output.name);
  if (!manifest) {
    scheduleRuleSetRebuild(env, config, prepared.pending, ctx, { sourceOnly: true, workerFallback });
    if (prepared.errors.length) return jsonResponse({ error: prepared.errors.join(" ") }, { status: 422, headers: { "cache-control": "no-store" } });
    return ruleSetPreparingResponse(prepared.retryAfterSeconds, prepared.failed);
  }
  if (!manifestSupportsDownload(manifest, bucket, "sing-box")) return notFound();

  if (binarySrs) {
    if (!manifest.srsBuckets?.includes(bucket)) {
      const repair = await prepareRuleSetCache(env, config, [output], { force: true, sourceOnly: true });
      scheduleRuleSetRebuild(env, config, repair.pending, ctx, { force: true, sourceOnly: true, workerFallback });
      if (repair.errors.length) return jsonResponse({ error: repair.errors.join(" ") }, { status: 422, headers: { "cache-control": "no-store" } });
      return ruleSetPreparingResponse(repair.retryAfterSeconds, repair.failed);
    }
    let response = await matchCompiledRuleSetWorkerCache(request, compiledCacheVersion(manifest));
    if (!response) {
      const content = await readCompiledRuleSetSrs(env, output.name, bucket, manifest);
      if (content === null) {
        const repair = await prepareRuleSetCache(env, config, [output], { force: true, sourceOnly: true });
        scheduleRuleSetRebuild(env, config, repair.pending, ctx, { force: true, sourceOnly: true, workerFallback });
        if (repair.errors.length) return jsonResponse({ error: repair.errors.join(" ") }, { status: 422, headers: { "cache-control": "no-store" } });
        return ruleSetPreparingResponse(repair.retryAfterSeconds, repair.failed);
      }
      const file = await compiledRuleSetFileResponse(content, "sing-box", true);
      ctx.waitUntil(cacheCompiledRuleSetResponse(request.url, compiledCacheVersion(manifest), file.clone()).catch(logRuleSetWorkerCacheError));
      response = clientRuleSetResponse(request, file);
    }
    scheduleRuleSetRebuild(env, config, prepared.pending, ctx, { sourceOnly: true, workerFallback });
    return response;
  }

  let response = await matchCompiledRuleSetWorkerCache(request, compiledCacheVersion(manifest));
  if (!response) {
    const content = await readCompiledRuleSetBucket(env, output.name, bucket, "sing-box", manifest);
    if (content === null) {
      // A stream can exist but contain unreadable ciphertext. Rebuild it after
      // returning, just as for a missing artifact; never compile on this path.
      const repair = await prepareRuleSetCache(env, config, [output], { force: true, sourceOnly: true });
      scheduleRuleSetRebuild(env, config, repair.pending, ctx, { force: true, sourceOnly: true, workerFallback });
      if (repair.errors.length) return jsonResponse({ error: repair.errors.join(" ") }, { status: 422, headers: { "cache-control": "no-store" } });
      return ruleSetPreparingResponse(repair.retryAfterSeconds, repair.failed);
    }
    const file = await compiledRuleSetFileResponse(content, "sing-box");
    ctx.waitUntil(cacheCompiledRuleSetResponse(request.url, compiledCacheVersion(manifest), file.clone()).catch(logRuleSetWorkerCacheError));
    response = clientRuleSetResponse(request, file);
  }
  scheduleRuleSetRebuild(env, config, prepared.pending, ctx, { sourceOnly: true, workerFallback });
  return response;
}

function ruleSetPreparingResponse(retryAfterSeconds: number, failed = false): Response {
  return jsonResponse({
    error: failed
      ? "规则集缓存暂不可用，后台生成失败；请检查规则来源或稍后重试。"
      : "规则集缓存正在后台生成，请稍后重试下载。"
  }, { status: 503, headers: { "retry-after": String(retryAfterSeconds), "cache-control": "no-store" } });
}

function ruleSetModeChangedResponse(): Response {
  return jsonResponse({ error: "当前 SRS 产物暂不可用或规则格式已变更，请重新更新订阅配置以使用普通 Worker 规则；首选产物就绪后自动恢复。" }, {
    status: 409, headers: { "cache-control": "no-store" }
  });
}

function manifestSupportsDownload(
  manifest: NonNullable<Awaited<ReturnType<typeof readCompiledRuleSetManifest>>>,
  bucket: "domain" | "ipcidr" | "combined" | "dns",
  target: RuleSetOutputTarget
): boolean {
  if (bucket === "dns") return target === "sing-box" && (manifest.dnsRuleCount ?? 0) > 0;
  if (bucket === "combined") {
    return planRuleSetArtifacts(manifest.buckets, target, manifest.provider?.behavior, manifest.surgeType).some((artifact) => artifact.bucket === "combined");
  }
  return planRuleSetArtifacts(manifest.buckets, target, manifest.provider?.behavior, manifest.surgeType).some((artifact) => artifact.bucket === bucket);
}

function resolveRuleSetDownload(config: RenderConfig, path: RuleSetSyncPath): {
  output: RenderConfig["ruleSets"]["outputs"][number];
  bucket: "domain" | "ipcidr" | "combined" | "dns";
  target: RuleSetOutputTarget;
} | null {
  const outputs = effectiveRuleSetOutputs(config.ruleSets)
    .filter((output) => ruleSetOutputNeedsCompilation(config.ruleSets, output, path.target));
  const exact = outputs.find((output) => ruleSetPathName(output.name) === path.artifactName);
  if (exact) return { output: exact, bucket: "combined", target: path.target };
  for (const [suffix, bucket] of [["-domain", "domain"], ["-ipcidr", "ipcidr"], ["-dns", "dns"]] as const) {
    if (!path.artifactName.endsWith(suffix)) continue;
    const outputName = path.artifactName.slice(0, -suffix.length);
    const output = outputs.find((item) => ruleSetPathName(item.name) === outputName);
    if (output) return { output, bucket, target: path.target };
  }
  return null;
}

function safeDecodePathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function scheduleRuleSetWorkerCacheWarm(
  env: Env,
  ctx: ExecutionContext,
  config: RenderConfig,
  requestUrl: string,
  outputNames?: string[]
): void {
  const deadline = Date.now() + WAIT_UNTIL_CACHE_WARM_DEADLINE_MS;
  ctx.waitUntil((async () => {
    const effectiveOutputs = effectiveRuleSetOutputs(config.ruleSets);
    const outputs = outputNames
      ? effectiveOutputs.filter((output) => outputNames.includes(output.name))
      : effectiveOutputs;
    const runtime = await prepareRuntimeRuleSetCache(env, config, outputs);
    scheduleRuntimeRuleSetRebuild(env, config, runtime, ctx);
    if (usesActionsCompilation(runtime.config)) return;
    await warmCompiledRuleSetWorkerCache(
      runtime.env,
      runtime.config,
      requestUrl,
      await getOrCreateReadToken(env),
      outputs,
      { deadline }
    );
  })().catch(logRuleSetWorkerCacheError));
}

function logRuleSetWorkerCacheError(error: unknown): void {
  console.error(JSON.stringify({
    level: "error",
    message: "Rule-set background work failed; retry remains enabled."
  }));
}
