import { managedRuleSetUrl } from "./managed-url";
import {
  readCompiledRuleSetBucket,
  readCompiledRuleSetManifest,
  type CompiledRuleSetManifest
} from "./rule-set-cache";
import type { RuleSetOutput, RuleSetOutputTarget } from "./rule-set-types";
import { effectiveRuleSetOutputs } from "./rule-set-outputs";
import { planRuleSetArtifacts } from "./rule-set-artifacts";
import type { AppConfig } from "./types";
import { sha256Hex } from "./util";

const RULE_SET_WORKER_CACHE_TTL_SECONDS = 12 * 60 * 60;
const INTERNAL_CACHE_VERSION_PARAM = "__subpilot_version";
const RULE_SET_PUBLIC_TARGETS = ["surge", "clash"] as const;

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
  const response = await caches.default.match(internalRuleSetCacheRequest(request.url, version));
  return response ? clientRuleSetResponse(request, response) : null;
}

export async function cacheCompiledRuleSetResponse(requestUrl: string, version: string, response: Response): Promise<void> {
  if (!workerCacheAvailable()) return;
  const headers = new Headers(response.headers);
  headers.set("cache-control", `public, max-age=${RULE_SET_WORKER_CACHE_TTL_SECONDS}`);
  await caches.default.put(
    internalRuleSetCacheRequest(requestUrl, version),
    new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  );
}

export function clientRuleSetResponse(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
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
  config: AppConfig,
  requestUrl: string,
  token: string,
  outputs?: RuleSetOutput[]
): Promise<{ cached: number }> {
  if (!token || !workerCacheAvailable()) return { cached: 0 };
  const enabledOutputs = outputs ?? effectiveRuleSetOutputs(config.ruleSets);
  const writes: Promise<void>[] = [];

  for (const output of enabledOutputs) {
    const manifest = await readCompiledRuleSetManifest(env, output.name);
    if (!manifest) continue;
    writes.push(...await compiledRuleSetCacheWritesForOutput(env, config, requestUrl, token, manifest));
  }

  await Promise.all(writes);
  return { cached: writes.length };
}

async function compiledRuleSetCacheWritesForOutput(
  env: Env,
  config: AppConfig,
  requestUrl: string,
  token: string,
  manifest: CompiledRuleSetManifest
): Promise<Promise<void>[]> {
  const writes: Promise<void>[] = [];
  for (const target of RULE_SET_PUBLIC_TARGETS) {
    for (const artifact of planRuleSetArtifacts(manifest.buckets, target)) {
      const content = await readCompiledRuleSetBucket(env, manifest.outputName, artifact.bucket, target);
      if (content === null) continue;
      const url = managedRuleSetUrl(config, requestUrl, token, manifest.outputName, artifact.bucket, target);
      const response = await compiledRuleSetFileResponse(content, target);
      writes.push(cacheCompiledRuleSetResponse(url, manifest.updatedAt, response));
    }
  }
  return writes;
}

function ruleSetContentType(target: RuleSetOutputTarget): string {
  return target === "surge" ? "text/plain; charset=utf-8" : "text/yaml; charset=utf-8";
}

function workerCacheAvailable(): boolean {
  return typeof caches !== "undefined" && Boolean(caches.default);
}

function internalRuleSetCacheRequest(requestUrl: string, version: string): Request {
  const url = new URL(requestUrl);
  url.searchParams.set(INTERNAL_CACHE_VERSION_PARAM, version || "legacy");
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
