import { getOrCreateReadToken } from "./auth";
import { notifyRuleSetRefreshFailures } from "./notifications";
import { compileRuleSetOutput, ensureCompiledRuleSet, readRuleSetStatus, refreshRuleSetCaches } from "./rule-set-compiler";
import { readCompiledRuleSetBucket, readCompiledRuleSetManifest } from "./rule-set-cache";
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
import { effectiveRuleSetOutputs } from "./rule-set-outputs";
import type { RuleSetOutputTarget } from "./rule-set-types";
import type { RenderConfig } from "./types";
import { badRequest, jsonResponse, notFound } from "./util";

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
      deadline: Date.now() + MANUAL_RULE_SET_REFRESH_DEADLINE_MS
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
        deadline: Date.now() + MANUAL_RULE_SET_REFRESH_DEADLINE_MS
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
    const manifest = await readCompiledRuleSetManifest(env, outputName);
    if (!manifest) return notFound();
    return jsonResponse({ manifest });
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

  let manifest;
  try {
    manifest = await ensureCompiledRuleSet(env, config, output);
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
      manifest = await compileRuleSetOutput(env, config, output, { allowStaleFallback: true }).then((result) => result.manifest);
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

function manifestSupportsDownload(
  manifest: NonNullable<Awaited<ReturnType<typeof readCompiledRuleSetManifest>>>,
  bucket: "domain" | "ipcidr" | "combined",
  target: RuleSetOutputTarget
): boolean {
  if (bucket === "combined") {
    return planRuleSetArtifacts(manifest.buckets, target, manifest.provider?.behavior, manifest.surgeType).some((artifact) => artifact.bucket === "combined");
  }
  return planRuleSetArtifacts(manifest.buckets, target, manifest.provider?.behavior, manifest.surgeType).some((artifact) => artifact.bucket === bucket);
}

function resolveRuleSetDownload(config: RenderConfig, path: RuleSetSyncPath): {
  output: RenderConfig["ruleSets"]["outputs"][number];
  bucket: "domain" | "ipcidr" | "combined";
  target: RuleSetOutputTarget;
} | null {
  const outputs = effectiveRuleSetOutputs(config.ruleSets);
  const exact = outputs.find((output) => ruleSetPathName(output.name) === path.artifactName);
  if (exact) return { output: exact, bucket: "combined", target: path.target };
  for (const [suffix, bucket] of [["-domain", "domain"], ["-ipcidr", "ipcidr"]] as const) {
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
    await warmCompiledRuleSetWorkerCache(
      env,
      config,
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
    message: error instanceof Error ? error.message : String(error)
  }));
}
