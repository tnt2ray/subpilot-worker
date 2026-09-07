import { managedRuleSetUrl } from "./managed-url";
import {
  readCompiledRuleSetBucket,
  readCompiledRuleSetManifest,
  type CompiledRuleSetManifest
} from "./rule-set-cache";
import { RULE_SET_TARGETS, type RuleSetOutput, type RuleSetOutputTarget } from "./rule-set-types";
import { effectiveRuleSetOutputs, ruleSetOutputNeedsCompilation } from "./rule-set-outputs";
import { planRuleSetArtifacts } from "./rule-set-artifacts";
import type { RenderConfig } from "./types";
import { sha256Hex } from "./util";

const RULE_SET_WORKER_CACHE_TTL_SECONDS = 12 * 60 * 60;
const INTERNAL_CACHE_VERSION_PARAM = "__subpilot_version";
const INTERNAL_CACHE_VERSION_HEADER = "x-subpilot-cache-version";
const RULE_SET_WORKER_CACHE_WARM_CONCURRENCY = 1;

export interface RuleSetWorkerCacheWarmOptions {
  /** Absolute Unix timestamp in milliseconds after which no new cache work starts. */
  deadline?: number;
}

export async function compiledRuleSetFileResponse(content: string, target: RuleSetOutputTarget): Promise<Response> {
  return new Response(content, {
    headers: {
      "content-type": ruleSetContentType(target),
      "cache-control": "no-cache",
      "etag": `"${await sha256Hex(content)}"`
    }
  });
}

export async function matchCompiledRuleSetWorkerCache(request: Request, version: string): Promise<Response | null> {
  if (request.method !== "GET" || !workerCacheAvailable()) return null;
  const response = await caches.default.match(internalRuleSetCacheRequest(request.url));
  if (response && response.headers.get(INTERNAL_CACHE_VERSION_HEADER) !== version) {
    await response.body?.cancel();
    return null;
  }
  return response ? clientRuleSetResponse(request, response) : null;
}

export async function cacheCompiledRuleSetResponse(requestUrl: string, version: string, response: Response): Promise<void> {
  if (!workerCacheAvailable()) return;
  const headers = new Headers(response.headers);
  headers.set("cache-control", `public, max-age=${RULE_SET_WORKER_CACHE_TTL_SECONDS}`);
  headers.set(INTERNAL_CACHE_VERSION_HEADER, version);
  await caches.default.put(
    internalRuleSetCacheRequest(requestUrl),
    new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  );
}

export function clientRuleSetResponse(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete(INTERNAL_CACHE_VERSION_HEADER);
  headers.set("cache-control", "no-cache");
  const etag = headers.get("etag");
  if (etag && matchesIfNoneMatch(request.headers.get("if-none-match"), etag)) {
    void response.body?.cancel();
    return new Response(null, { status: 304, headers });
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export async function warmCompiledRuleSetWorkerCache(
  env: Env,
  config: RenderConfig,
  requestUrl: string,
  token: string,
  outputs?: RuleSetOutput[],
  options: RuleSetWorkerCacheWarmOptions = {}
): Promise<{ cached: number }> {
  if (!token || !workerCacheAvailable()) return { cached: 0 };
  const enabledOutputs = (outputs ?? effectiveRuleSetOutputs(config.ruleSets)).filter((output) => ruleSetOutputNeedsCompilation(config.ruleSets, output, config.renderTarget ?? "surge"));
  let cursor = 0;
  let cached = 0;

  const worker = async (): Promise<void> => {
    while (cursor < enabledOutputs.length && !workerCacheWarmDeadlineExceeded(options.deadline)) {
      const output = enabledOutputs[cursor++];
      if (!output) return;
      const manifest = await readCompiledRuleSetManifest(env, output.name);
      if (!manifest || workerCacheWarmDeadlineExceeded(options.deadline)) continue;
      cached += await warmCompiledRuleSetCacheForOutput(env, config, requestUrl, token, manifest, options.deadline);
    }
  };

  await Promise.all(Array.from(
    { length: Math.min(RULE_SET_WORKER_CACHE_WARM_CONCURRENCY, enabledOutputs.length) },
    worker
  ));
  return { cached };
}

async function warmCompiledRuleSetCacheForOutput(
  env: Env,
  config: RenderConfig,
  requestUrl: string,
  token: string,
  manifest: CompiledRuleSetManifest,
  deadline?: number
): Promise<number> {
  let cached = 0;
  for (const target of config.renderTarget ? [config.renderTarget] : RULE_SET_TARGETS) {
    for (const artifact of planRuleSetArtifacts(manifest.buckets, target, manifest.provider?.behavior, manifest.surgeType)) {
      if (workerCacheWarmDeadlineExceeded(deadline)) return cached;
      const content = await readCompiledRuleSetBucket(env, manifest.outputName, artifact.bucket, target, manifest);
      if (content === null) continue;
      const url = managedRuleSetUrl(config, requestUrl, token, manifest.outputName, artifact.bucket, target);
      const response = await compiledRuleSetFileResponse(content, target);
      if (workerCacheWarmDeadlineExceeded(deadline)) return cached;
      await cacheCompiledRuleSetResponse(url, compiledCacheVersion(manifest), response);
      cached += 1;
    }
  }
  return cached;
}

function workerCacheWarmDeadlineExceeded(deadline: number | undefined): boolean {
  return deadline !== undefined && Date.now() >= deadline;
}

function ruleSetContentType(target: RuleSetOutputTarget): string {
  return target === "sing-box" ? "application/json; charset=utf-8" : target === "surge" ? "text/plain; charset=utf-8" : "text/yaml; charset=utf-8";
}

function workerCacheAvailable(): boolean {
  return typeof caches !== "undefined" && Boolean(caches.default);
}

function internalRuleSetCacheRequest(requestUrl: string): Request {
  const url = new URL(requestUrl);
  url.searchParams.delete(INTERNAL_CACHE_VERSION_PARAM);
  return new Request(url, { method: "GET" });
}

function matchesIfNoneMatch(header: string | null, etag: string): boolean {
  if (!header) return false;
  const normalizedEtag = etag.replace(/^W\//i, "");
  return header.split(",").some((candidate) => {
    const normalized = candidate.trim();
    return normalized === "*" || normalized.replace(/^W\//i, "") === normalizedEtag;
  });
}

export function compiledCacheVersion(manifest: CompiledRuleSetManifest): string {
  return `${manifest.updatedAt}:${manifest.outputFingerprint}:${manifest.storageId ?? ""}`;
}
