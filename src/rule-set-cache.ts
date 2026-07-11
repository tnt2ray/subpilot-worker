import { listKvKeys, readKvJson } from "./kv-helpers";
import { renderCombinedRuleSet, renderCompiledRuleSetBucket } from "./rule-set-renderer";
import type { ParsedRuleSetRule } from "./rule-set-parser";
import { effectiveRuleSetOutputs } from "./rule-set-outputs";
import type { RuleSetBucket, RuleSetDownloadBucket, RuleSetOutputTarget, RuleSetSource } from "./rule-set-types";
import { RULE_SET_BUCKETS, RULE_SET_TARGETS } from "./rule-set-types";
import { planRuleSetArtifacts } from "./rule-set-artifacts";
import type { AppConfig } from "./types";
import { readResponseTextWithLimit, sha256Hex } from "./util";
import { fetchWithTimeout, waitForRetry } from "./upstream-fetch";

export const RULE_SET_SOURCE_CACHE_PREFIX = "cache:ruleSetSource:";
export const RULE_SET_SOURCE_CACHE_META_PREFIX = "cache:ruleSetSourceMeta:";
export const RULE_SET_SOURCE_CACHE_META_INDEX_KEY = "cache:ruleSetSourceMeta:index";
export const COMPILED_RULE_SET_PREFIX = "cache:compiledRuleSet:";
export const COMPILED_RULE_SET_META_PREFIX = "cache:compiledRuleSetMeta:";

const MAX_RULE_SET_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_RULE_SET_SOURCE_FETCH_RETRIES = 3;
const RULE_SET_SOURCE_FETCH_ATTEMPT_TIMEOUT_MS = 8_000;
const RULE_SET_SOURCE_FETCH_TOTAL_TIMEOUT_MS = 25_000;
const RULE_SET_SOURCE_FETCH_RETRY_BASE_DELAY_MS = 100;
const UNKNOWN_RULE_SET_SOURCE_FETCHED_AT = "1970-01-01T00:00:00.000Z";

class InvalidRuleSetSourceResponseError extends Error {}

export interface RuleSetSourceCacheEntry {
  key: string;
  fetchedAt: string;
  sourceId: string;
  sourceName: string;
  contentAvailable: boolean;
}

export interface RuleSetSourceCacheFailure {
  sourceId: string;
  sourceName: string;
  reason: string;
  usedCachedContent: boolean;
}

export interface RuleSetSourceFetchResult {
  content: string;
  usedCachedContent: boolean;
  warning?: string | undefined;
}

export interface RuleSetSourceCacheRefreshResult {
  refreshed: number;
  failed: number;
  cached: number;
  deleted: number;
  warnings: string[];
  failures: RuleSetSourceCacheFailure[];
  contentByKey: Map<string, RuleSetSourceFetchResult>;
  errorsByKey: Map<string, string>;
}

export interface CompiledRuleSetBucketMeta {
  bucket: RuleSetBucket;
  count: number;
  targets: RuleSetOutputTarget[];
}

export interface CompiledRuleSetManifest {
  outputName: string;
  outputFingerprint: string;
  policy: string;
  updatedAt: string;
  sourceIds: string[];
  ruleCount: number;
  duplicateCount: number;
  buckets: CompiledRuleSetBucketMeta[];
  warnings: string[];
}

export interface CompiledRuleSetStatusItem {
  outputName: string;
  enabled: boolean;
  updatedAt: string | null;
  ruleCount: number;
  duplicateCount: number;
  buckets: CompiledRuleSetBucketMeta[];
  warnings: string[];
  cached: boolean;
}

export async function fetchCachedRuleSetSource(
  env: Env,
  source: RuleSetSource,
  options: { allowCachedFallback?: boolean; forceRefresh?: boolean } = {}
): Promise<RuleSetSourceFetchResult> {
  const key = await ruleSetSourceCacheKey(source.url);
  const cached = await env.SUBPILOT_CONFIG.get(key);
  if (!options.forceRefresh) {
    if (cached !== null) return { content: cached, usedCachedContent: false };
  }

  try {
    const content = await fetchRuleSetSourceContent(source.url);
    await writeRuleSetSourceCacheEntry(env, {
      key,
      content,
      fetchedAt: new Date().toISOString(),
      sourceId: source.id,
      sourceName: source.name
    });
    return { content, usedCachedContent: false };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (options.allowCachedFallback && cached !== null) {
      return {
        content: cached,
        usedCachedContent: true,
        warning: `${source.name}: ${reason}`
      };
    }
    throw new Error(`${source.name}: ${reason}`);
  }
}

export async function refreshRuleSetSourceCaches(
  env: Env,
  config: AppConfig,
  sourcesToRefresh: RuleSetSource[],
  options: { pruneUnexpected: boolean }
): Promise<RuleSetSourceCacheRefreshResult> {
  const existing = await readRuleSetSourceCacheEntries(env);
  const existingByKey = new Map(existing.map((entry) => [entry.key, entry]));
  const expectedKeys = await ruleSetSourceCacheKeysForEnabledSources(config);
  const nextEntries = new Map(existing
    .filter((entry) => expectedKeys.has(entry.key))
    .map((entry) => [entry.key, entry]));
  const warnings: string[] = [];
  const failures: RuleSetSourceCacheFailure[] = [];
  const contentByKey = new Map<string, RuleSetSourceFetchResult>();
  const errorsByKey = new Map<string, string>();
  let refreshed = 0;
  let cached = 0;

  for (const source of sourcesToRefresh) {
    if (!source.enabled || !source.url) continue;
    const key = await ruleSetSourceCacheKey(source.url);
    const cachedContent = await env.SUBPILOT_CONFIG.get(key);
    try {
      const content = await fetchRuleSetSourceContent(source.url);
      const entry = await writeRuleSetSourceCacheEntry(env, {
        key,
        content,
        fetchedAt: new Date().toISOString(),
        sourceId: source.id,
        sourceName: source.name
      }, { updateIndex: false });
      nextEntries.set(key, entry);
      contentByKey.set(key, { content, usedCachedContent: false });
      refreshed += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const existingEntry = existingByKey.get(key);
      const usedCachedContent = cachedContent !== null;
      if (usedCachedContent) {
        nextEntries.set(key, existingEntry ?? {
          key,
          fetchedAt: UNKNOWN_RULE_SET_SOURCE_FETCHED_AT,
          sourceId: source.id,
          sourceName: source.name,
          contentAvailable: true
        });
        contentByKey.set(key, {
          content: cachedContent,
          usedCachedContent: true,
          warning: `${source.name}: ${reason}`
        });
        cached += 1;
      } else {
        errorsByKey.set(key, reason);
      }
      failures.push({
        sourceId: source.id,
        sourceName: source.name,
        reason,
        usedCachedContent
      });
      warnings.push(`${source.name}: ${reason}`);
    }
  }

  const deleted = options.pruneUnexpected
    ? await pruneUnexpectedRuleSetSourceCacheEntries(env, existing, expectedKeys)
    : 0;
  const entries = [...nextEntries.values()].sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
  await env.SUBPILOT_CONFIG.put(RULE_SET_SOURCE_CACHE_META_INDEX_KEY, JSON.stringify(entries));

  return {
    refreshed,
    failed: failures.length,
    cached,
    deleted,
    warnings,
    failures,
    contentByKey,
    errorsByKey
  };
}

export async function pruneRuleSetCaches(env: Env, config: AppConfig): Promise<number> {
  const sourceEntries = await readRuleSetSourceCacheEntries(env);
  const expectedKeys = await ruleSetSourceCacheKeysForEnabledSources(config);
  const sourceDeleted = await pruneUnexpectedRuleSetSourceCacheEntries(env, sourceEntries, expectedKeys);
  await env.SUBPILOT_CONFIG.put(
    RULE_SET_SOURCE_CACHE_META_INDEX_KEY,
    JSON.stringify(sourceEntries.filter((entry) => expectedKeys.has(entry.key)).sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt)))
  );
  const compiledDeleted = await pruneCompiledRuleSetCaches(env, config);
  return sourceDeleted + compiledDeleted;
}

export async function pruneCompiledRuleSetCaches(env: Env, config: AppConfig): Promise<number> {
  return pruneUnexpectedCompiledRuleSets(env, new Set(
    effectiveRuleSetOutputs(config.ruleSets).map((output) => output.name)
  ));
}

export async function readCompiledRuleSetManifest(env: Env, outputName: string): Promise<CompiledRuleSetManifest | null> {
  return normalizeCompiledManifest(await readKvJson<unknown>(env, compiledRuleSetMetaKey(outputName)));
}

export async function readCompiledRuleSetBucket(
  env: Env,
  outputName: string,
  bucket: RuleSetDownloadBucket,
  target: RuleSetOutputTarget
): Promise<string | null> {
  return env.SUBPILOT_CONFIG.get(compiledRuleSetContentKey(outputName, bucket, target));
}

export async function writeCompiledRuleSet(
  env: Env,
  manifest: CompiledRuleSetManifest,
  buckets: Record<RuleSetBucket, ParsedRuleSetRule[]>
): Promise<void> {
  const expectedKeys = new Set<string>();
  const writes: Promise<unknown>[] = [];
  for (const bucket of RULE_SET_BUCKETS) {
    const rules = buckets[bucket];
    if (rules.length === 0) continue;
    for (const target of RULE_SET_TARGETS) {
      const key = compiledRuleSetContentKey(manifest.outputName, bucket, target);
      expectedKeys.add(key);
      writes.push(env.SUBPILOT_CONFIG.put(
        key,
        renderCompiledRuleSetBucket(rules, bucket, target)
      ));
    }
  }
  for (const target of RULE_SET_TARGETS) {
    const combined = planRuleSetArtifacts(manifest.buckets, target).find((artifact) => artifact.bucket === "combined");
    if (!combined) continue;
    const key = compiledRuleSetContentKey(manifest.outputName, "combined", target);
    expectedKeys.add(key);
    writes.push(env.SUBPILOT_CONFIG.put(
      key,
      renderCombinedRuleSet(buckets, target, combined)
    ));
  }
  await Promise.all(writes);
  await env.SUBPILOT_CONFIG.put(compiledRuleSetMetaKey(manifest.outputName), JSON.stringify(manifest));

  const possibleKeys = [
    ...RULE_SET_BUCKETS.flatMap((bucket) => RULE_SET_TARGETS.map((target) => (
      compiledRuleSetContentKey(manifest.outputName, bucket, target)
    ))),
    ...RULE_SET_TARGETS.map((target) => compiledRuleSetContentKey(manifest.outputName, "combined", target))
  ];
  await Promise.all(possibleKeys
    .filter((key) => !expectedKeys.has(key))
    .map((key) => env.SUBPILOT_CONFIG.delete(key)));
}

export async function deleteCompiledRuleSet(env: Env, outputName: string): Promise<void> {
  await Promise.all([
    env.SUBPILOT_CONFIG.delete(compiledRuleSetMetaKey(outputName)),
    ...RULE_SET_BUCKETS.flatMap((bucket) => RULE_SET_TARGETS.map((target) => (
      env.SUBPILOT_CONFIG.delete(compiledRuleSetContentKey(outputName, bucket, target))
    ))),
    ...RULE_SET_TARGETS.map((target) => (
      env.SUBPILOT_CONFIG.delete(compiledRuleSetContentKey(outputName, "combined", target))
    ))
  ]);
}

export function compiledRuleSetContentKey(outputName: string, bucket: RuleSetDownloadBucket, target: RuleSetOutputTarget): string {
  return `${COMPILED_RULE_SET_PREFIX}${encodeURIComponent(outputName)}:${bucket}:${target}`;
}

export function compiledRuleSetMetaKey(outputName: string): string {
  return `${COMPILED_RULE_SET_META_PREFIX}${encodeURIComponent(outputName)}`;
}

export async function ruleSetSourceCacheKey(url: string): Promise<string> {
  return `${RULE_SET_SOURCE_CACHE_PREFIX}${await sha256Hex(url)}`;
}

async function writeRuleSetSourceCacheEntry(
  env: Env,
  entry: Omit<RuleSetSourceCacheEntry, "contentAvailable"> & { content: string },
  options: { updateIndex?: boolean } = {}
): Promise<RuleSetSourceCacheEntry> {
  const { content, ...baseMeta } = entry;
  const meta: RuleSetSourceCacheEntry = {
    ...baseMeta,
    contentAvailable: true
  };
  const updateIndex = options.updateIndex !== false;
  const writes: Promise<unknown>[] = [
    env.SUBPILOT_CONFIG.put(entry.key, content),
    env.SUBPILOT_CONFIG.put(ruleSetSourceCacheMetaKey(entry.key), JSON.stringify(meta))
  ];
  if (updateIndex) {
    const entries = [
      meta,
      ...await readRuleSetSourceCacheEntries(env).then((existing) => existing.filter((item) => item.key !== entry.key))
    ];
    writes.push(env.SUBPILOT_CONFIG.put(RULE_SET_SOURCE_CACHE_META_INDEX_KEY, JSON.stringify(entries)));
  }
  await Promise.all(writes);
  return meta;
}

async function fetchRuleSetSourceContent(url: string): Promise<string> {
  let lastError: unknown;
  const deadline = Date.now() + RULE_SET_SOURCE_FETCH_TOTAL_TIMEOUT_MS;
  for (let attempt = 0; attempt <= MAX_RULE_SET_SOURCE_FETCH_RETRIES; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      return await fetchWithTimeout(
        globalThis.fetch,
        url,
        undefined,
        Math.min(RULE_SET_SOURCE_FETCH_ATTEMPT_TIMEOUT_MS, remaining),
        async (response) => {
          if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            throw new Error(`HTTP ${response.status}`);
          }
          if (response.headers.get("content-type")?.toLowerCase().includes("text/html")) {
            await response.body?.cancel().catch(() => undefined);
            throw new InvalidRuleSetSourceResponseError("规则来源返回了 HTML 页面，请改用原始规则文件 URL");
          }
          const content = await readResponseTextWithLimit(response, MAX_RULE_SET_SOURCE_BYTES, "rule set source");
          if (looksLikeHtmlDocument(content)) {
            throw new InvalidRuleSetSourceResponseError("规则来源返回了 HTML 页面，请改用原始规则文件 URL");
          }
          return content;
        }
      );
    } catch (error) {
      if (error instanceof InvalidRuleSetSourceResponseError) throw error;
      lastError = error;
      if (attempt < MAX_RULE_SET_SOURCE_FETCH_RETRIES) {
        await waitForRetry(attempt, RULE_SET_SOURCE_FETCH_RETRY_BASE_DELAY_MS, deadline);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function looksLikeHtmlDocument(content: string): boolean {
  return /^\s*(?:<!doctype\s+html\b|<html\b)/i.test(content);
}

async function readRuleSetSourceCacheEntries(env: Env): Promise<RuleSetSourceCacheEntry[]> {
  const indexed = await readKvJson<unknown>(env, RULE_SET_SOURCE_CACHE_META_INDEX_KEY);
  const indexedEntries = Array.isArray(indexed) ? indexed.flatMap(normalizeRuleSetSourceCacheEntry) : [];
  const metaKeys = (await listKvKeys(env, RULE_SET_SOURCE_CACHE_META_PREFIX))
    .filter((key) => key !== RULE_SET_SOURCE_CACHE_META_INDEX_KEY);
  const entries = await Promise.all(metaKeys.map((key) => readKvJson<unknown>(env, key)));
  return dedupeRuleSetSourceCacheEntries([
    ...indexedEntries,
    ...entries.flatMap(normalizeRuleSetSourceCacheEntry)
  ]);
}

async function ruleSetSourceCacheKeysForEnabledSources(config: AppConfig): Promise<Set<string>> {
  const expectedKeys = new Set<string>();
  for (const source of config.ruleSets.sources) {
    if (!source.enabled || !source.url) continue;
    expectedKeys.add(await ruleSetSourceCacheKey(source.url));
  }
  return expectedKeys;
}

async function pruneUnexpectedRuleSetSourceCacheEntries(
  env: Env,
  existing: RuleSetSourceCacheEntry[],
  expectedKeys: Set<string>
): Promise<number> {
  const contentKeys = await listKvKeys(env, RULE_SET_SOURCE_CACHE_PREFIX);
  const staleCacheKeys = new Set<string>();
  for (const entry of existing) {
    if (!expectedKeys.has(entry.key)) staleCacheKeys.add(entry.key);
  }
  for (const key of contentKeys) {
    if (!expectedKeys.has(key)) staleCacheKeys.add(key);
  }
  await Promise.all([...staleCacheKeys].flatMap((key) => [
    env.SUBPILOT_CONFIG.delete(key),
    env.SUBPILOT_CONFIG.delete(ruleSetSourceCacheMetaKey(key))
  ]));
  return staleCacheKeys.size;
}

async function pruneUnexpectedCompiledRuleSets(env: Env, expectedOutputNames: Set<string>): Promise<number> {
  const staleOutputNames = new Set<string>();
  const metaKeys = await listKvKeys(env, COMPILED_RULE_SET_META_PREFIX);
  for (const key of metaKeys) {
    const outputName = compiledRuleSetOutputNameFromMetaKey(key);
    if (outputName !== null && !expectedOutputNames.has(outputName)) staleOutputNames.add(outputName);
  }
  const contentKeys = await listKvKeys(env, COMPILED_RULE_SET_PREFIX);
  for (const key of contentKeys) {
    const outputName = compiledRuleSetOutputNameFromContentKey(key);
    if (outputName !== null && !expectedOutputNames.has(outputName)) staleOutputNames.add(outputName);
  }
  await Promise.all([...staleOutputNames].map((outputName) => deleteCompiledRuleSet(env, outputName)));
  return staleOutputNames.size;
}

function ruleSetSourceCacheMetaKey(key: string): string {
  return `${RULE_SET_SOURCE_CACHE_META_PREFIX}${key.slice(RULE_SET_SOURCE_CACHE_PREFIX.length)}`;
}

function compiledRuleSetOutputNameFromMetaKey(key: string): string | null {
  if (!key.startsWith(COMPILED_RULE_SET_META_PREFIX)) return null;
  return safeDecodeURIComponent(key.slice(COMPILED_RULE_SET_META_PREFIX.length));
}

function compiledRuleSetOutputNameFromContentKey(key: string): string | null {
  if (!key.startsWith(COMPILED_RULE_SET_PREFIX)) return null;
  const rest = key.slice(COMPILED_RULE_SET_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator < 0) return null;
  return safeDecodeURIComponent(rest.slice(0, separator));
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function dedupeRuleSetSourceCacheEntries(entries: RuleSetSourceCacheEntry[]): RuleSetSourceCacheEntry[] {
  const selected = new Map<string, RuleSetSourceCacheEntry>();
  for (const entry of entries) {
    const existing = selected.get(entry.key);
    if (!existing || entry.fetchedAt > existing.fetchedAt) {
      selected.set(entry.key, entry);
    }
  }
  return [...selected.values()];
}

function normalizeRuleSetSourceCacheEntry(value: unknown): RuleSetSourceCacheEntry[] {
  if (!value || typeof value !== "object") return [];
  const entry = value as Partial<RuleSetSourceCacheEntry>;
  if (typeof entry.key !== "string" || !entry.key.startsWith(RULE_SET_SOURCE_CACHE_PREFIX)) return [];
  if (typeof entry.fetchedAt !== "string" || Number.isNaN(new Date(entry.fetchedAt).getTime())) return [];
  return [{
    key: entry.key,
    fetchedAt: entry.fetchedAt,
    sourceId: typeof entry.sourceId === "string" ? entry.sourceId : "",
    sourceName: typeof entry.sourceName === "string" ? entry.sourceName : "",
    contentAvailable: typeof entry.contentAvailable === "boolean" ? entry.contentAvailable : true
  }];
}

function normalizeCompiledManifest(value: unknown): CompiledRuleSetManifest | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<CompiledRuleSetManifest>;
  if (typeof record.outputName !== "string") return null;
  return {
    outputName: record.outputName,
    outputFingerprint: typeof record.outputFingerprint === "string" ? record.outputFingerprint : "",
    policy: typeof record.policy === "string" ? record.policy : "Proxy",
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
    sourceIds: Array.isArray(record.sourceIds) ? record.sourceIds.filter((item): item is string => typeof item === "string") : [],
    ruleCount: typeof record.ruleCount === "number" ? record.ruleCount : 0,
    duplicateCount: typeof record.duplicateCount === "number" ? record.duplicateCount : 0,
    buckets: Array.isArray(record.buckets) ? record.buckets.flatMap(normalizeBucketMeta) : [],
    warnings: Array.isArray(record.warnings) ? record.warnings.filter((item): item is string => typeof item === "string") : []
  };
}

function normalizeBucketMeta(value: unknown): CompiledRuleSetBucketMeta[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Partial<CompiledRuleSetBucketMeta>;
  if (!record.bucket || !RULE_SET_BUCKETS.includes(record.bucket)) return [];
  return [{
    bucket: record.bucket,
    count: typeof record.count === "number" ? record.count : 0,
    targets: Array.isArray(record.targets)
      ? record.targets.filter((item): item is RuleSetOutputTarget => RULE_SET_TARGETS.includes(item as RuleSetOutputTarget))
      : []
  }];
}
