import { getOrCreateReadToken } from "./auth";
import { notifyRuleSetRefreshFailures } from "./notifications";
import { compileRuleSetOutput, ensureCompiledRuleSet, readRuleSetStatus, refreshRuleSetCaches } from "./rule-set-compiler";
import { readCompiledRuleSetBucket, readCompiledRuleSetManifest } from "./rule-set-cache";
import {
  cacheCompiledRuleSetResponse,
  clientRuleSetResponse,
  compiledRuleSetFileResponse,
  matchCompiledRuleSetWorkerCache,
  warmCompiledRuleSetWorkerCache
} from "./rule-set-worker-cache";
import { ruleSetPathName, type RuleSetSyncPath } from "./managed-url";
import { planRuleSetArtifacts } from "./rule-set-artifacts";
import { effectiveRuleSetOutputs } from "./rule-set-outputs";
import type { AppConfig } from "./types";
import { badRequest, jsonResponse, notFound } from "./util";

export async function handleRuleSetApi(request: Request, env: Env, ctx: ExecutionContext, config: AppConfig): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/rule-sets/status" && request.method === "GET") {
    return jsonResponse({
      mode: config.ruleSets.mode,
      outputs: await readRuleSetStatus(env, config)
    });
  }
  if (url.pathname === "/api/rule-sets/refresh" && request.method === "POST") {
    const result = await refreshRuleSetCaches(env, config);
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
      const result = await refreshRuleSetCaches(env, config, outputName);
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
  config: AppConfig,
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

  const cachedResponse = await matchCompiledRuleSetWorkerCache(request, manifest.updatedAt);
  if (cachedResponse) return cachedResponse;

  let content = await readCompiledRuleSetBucket(env, output.name, bucket, target);
  if (content === null) {
    try {
      manifest = await compileRuleSetOutput(env, config, output, { allowStaleFallback: true }).then((result) => result.manifest);
      if (!manifest) return notFound();
      if (!manifestSupportsDownload(manifest, bucket, target)) return notFound();
      content = await readCompiledRuleSetBucket(env, output.name, bucket, target);
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : String(error));
    }
  }
  if (content === null) return notFound();
  const response = await compiledRuleSetFileResponse(content, target);
  ctx.waitUntil(cacheCompiledRuleSetResponse(request.url, manifest.updatedAt, response.clone()).catch(logRuleSetWorkerCacheError));
  return clientRuleSetResponse(request, response);
}

function manifestSupportsDownload(
  manifest: NonNullable<Awaited<ReturnType<typeof readCompiledRuleSetManifest>>>,
  bucket: "domain" | "ipcidr" | "combined",
  target: "surge" | "clash"
): boolean {
  if (bucket === "combined") {
    return planRuleSetArtifacts(manifest.buckets, target).some((artifact) => artifact.bucket === "combined");
  }
  return planRuleSetArtifacts(manifest.buckets, target).some((artifact) => artifact.bucket === bucket);
}

function resolveRuleSetDownload(config: AppConfig, path: RuleSetSyncPath): {
  output: AppConfig["ruleSets"]["outputs"][number];
  bucket: "domain" | "ipcidr" | "combined";
  target: "surge" | "clash";
} | null {
  const outputs = effectiveRuleSetOutputs(config.ruleSets);
  const exact = outputs.find((output) => ruleSetPathName(output.name) === path.artifactName);
  if (exact) return { output: exact, bucket: "combined", target: path.target === "surge" ? "surge" : "clash" };
  for (const [suffix, bucket] of [["-domain", "domain"], ["-ipcidr", "ipcidr"]] as const) {
    if (!path.artifactName.endsWith(suffix)) continue;
    const outputName = path.artifactName.slice(0, -suffix.length);
    const output = outputs.find((item) => ruleSetPathName(item.name) === outputName);
    if (output) return { output, bucket, target: path.target === "surge" ? "surge" : "clash" };
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
  config: AppConfig,
  requestUrl: string,
  outputNames?: string[]
): void {
  ctx.waitUntil((async () => {
    const effectiveOutputs = effectiveRuleSetOutputs(config.ruleSets);
    const outputs = outputNames
      ? effectiveOutputs.filter((output) => outputNames.includes(output.name))
      : effectiveOutputs;
    await warmCompiledRuleSetWorkerCache(env, config, requestUrl, await getOrCreateReadToken(env), outputs);
  })().catch(logRuleSetWorkerCacheError));
}

function logRuleSetWorkerCacheError(error: unknown): void {
  console.error(JSON.stringify({
    level: "error",
    message: error instanceof Error ? error.message : String(error)
  }));
}
