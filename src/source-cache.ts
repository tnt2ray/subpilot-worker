import { listKvKeys, readKvJson } from "./kv-helpers";
import {
  normalizeSourceCacheNodeCount,
  normalizeSourceCacheProtocolCounts,
  sourceCacheContentStats,
  type SourceCacheProtocolCount
} from "./source-cache-stats";
import { fetchUserAgentValue } from "./source-user-agent";
import type { AppConfig, SourceConfig } from "./types";
import { readResponseTextWithLimit, sha256Hex } from "./util";
import { fetchWithTimeout, waitForRetry } from "./upstream-fetch";

export const SOURCE_CACHE_PREFIX = "cache:source:";
export const SOURCE_CACHE_META_PREFIX = "cache:sourceMeta:";
export const SOURCE_CACHE_META_INDEX_KEY = "cache:sourceMeta:index";
const MAX_SOURCE_CONTENT_BYTES = 10 * 1024 * 1024;
const MAX_SOURCE_FETCH_RETRIES = 3;
const SOURCE_FETCH_ATTEMPT_TIMEOUT_MS = 8_000;
const SOURCE_FETCH_TOTAL_TIMEOUT_MS = 25_000;
const SOURCE_FETCH_RETRY_BASE_DELAY_MS = 100;

export { sourceCacheContentStats } from "./source-cache-stats";
export type { SourceCacheProtocolCount } from "./source-cache-stats";

export interface SourceCacheEntry {
  key: string;
  fetchedAt: string;
  sourceId: string;
  sourceName: string;
  contentAvailable: boolean;
  nodeCount: number;
  protocolCounts: SourceCacheProtocolCount[];
}

export interface SourceCacheStatus {
  count: number;
  updatedAt: string | null;
  expectedCount: number;
  cachedSourceCount: number;
  allSourcesCached: boolean;
  sources: SourceCacheSourceStatus[];
  totalNodes: number;
  protocolCounts: SourceCacheProtocolCount[];
}

export interface SourceCacheSourceStatus {
  sourceId: string;
  sourceName: string;
  cached: boolean;
  fetchedAt: string | null;
  nodeCount: number;
  protocolCounts: SourceCacheProtocolCount[];
}

export interface SourceCacheRefreshFailure {
  sourceId: string;
  sourceName: string;
  reason: string;
  usedCachedContent: boolean;
}

export interface SourceCacheRefreshResult {
  refreshed: number;
  failed: number;
  cached: number;
  deleted: number;
  updatedAt: string;
  warnings: string[];
  failures: SourceCacheRefreshFailure[];
  sourceCache: SourceCacheStatus;
}

export function sourceUserAgent(config: AppConfig, source: SourceConfig): string {
  return fetchUserAgentValue(config, source.fetchUserAgent);
}

export async function fetchCachedSource(env: Env, source: SourceConfig, userAgent: string): Promise<string> {
  const key = await sourceCacheKeyFor(source.url, userAgent);
  const cached = await env.SUBPILOT_CONFIG.get(key);
  if (cached !== null) return cached;
  const content = await fetchSourceContent(source.url, userAgent, source.id);
  await writeSourceCacheEntry(env, {
    key,
    content,
    fetchedAt: new Date().toISOString(),
    sourceId: source.id,
    sourceName: source.name
  });
  return content;
}

export async function refreshSourceCache(env: Env, config: AppConfig): Promise<SourceCacheRefreshResult> {
  const enabled = config.sources.filter((source) => source.enabled && source.url);
  return refreshSourceCacheForSources(env, config, enabled, { pruneUnexpected: true });
}

export async function refreshChangedSourceCache(
  env: Env,
  previousConfig: AppConfig,
  config: AppConfig
): Promise<SourceCacheRefreshResult | null> {
  const changed = changedEnabledSources(previousConfig, config);
  if (changed.length === 0) return null;
  return refreshSourceCacheForSources(env, config, changed, { pruneUnexpected: false });
}

async function refreshSourceCacheForSources(
  env: Env,
  config: AppConfig,
  sourcesToRefresh: SourceConfig[],
  options: { pruneUnexpected: boolean }
): Promise<SourceCacheRefreshResult> {
  const existing = await readSourceCacheEntries(env);
  const existingByKey = new Map(existing.map((entry) => [entry.key, entry]));
  const expectedKeys = await sourceCacheKeysForEnabledSources(config);
  const nextEntries = new Map(existing
    .filter((entry) => expectedKeys.has(entry.key))
    .map((entry) => [entry.key, entry]));
  const warnings: string[] = [];
  const failures: SourceCacheRefreshFailure[] = [];
  let refreshed = 0;
  let cached = 0;

  for (const source of sourcesToRefresh) {
    if (!source.enabled || !source.url) continue;
    const userAgent = sourceUserAgent(config, source);
    const key = await sourceCacheKeyFor(source.url, userAgent);
    const now = new Date().toISOString();
    try {
      const content = await fetchSourceContent(source.url, userAgent, source.id);
      const entry = await writeSourceCacheEntry(env, {
        key,
        content,
        fetchedAt: now,
        sourceId: source.id,
        sourceName: source.name
      }, { updateIndex: false });
      nextEntries.set(key, entry);
      refreshed += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const existingEntry = existingByKey.get(key);
      let usedCachedContent = false;
      if (existingEntry) {
        nextEntries.set(key, {
          ...existingEntry,
          sourceId: source.id,
          sourceName: source.name
        });
        cached += 1;
        usedCachedContent = true;
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
    ? await pruneUnexpectedSourceCacheEntries(env, existing, expectedKeys)
    : 0;

  const entries = [...nextEntries.values()].sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
  await env.SUBPILOT_CONFIG.put(SOURCE_CACHE_META_INDEX_KEY, JSON.stringify(entries));

  return {
    refreshed,
    failed: warnings.length,
    cached,
    deleted,
    updatedAt: new Date().toISOString(),
    warnings,
    failures,
    sourceCache: await readSourceCacheStatus(env, config)
  };
}

function changedEnabledSources(previousConfig: AppConfig, config: AppConfig): SourceConfig[] {
  const previousById = new Map(previousConfig.sources.map((source) => [source.id, source]));
  return config.sources.filter((source) => {
    if (!source.enabled || !source.url) return false;
    const previous = previousById.get(source.id);
    if (!previous || !previous.enabled || !previous.url) return true;
    return previous.url !== source.url
      || previous.fetchUserAgent !== source.fetchUserAgent
      || sourceUserAgent(previousConfig, previous) !== sourceUserAgent(config, source);
  });
}

export async function pruneSourceCache(env: Env, config: AppConfig): Promise<number> {
  const existing = await readSourceCacheEntries(env);
  const expectedKeys = await sourceCacheKeysForEnabledSources(config);
  const deleted = await pruneUnexpectedSourceCacheEntries(env, existing, expectedKeys);
  const entries = existing
    .filter((entry) => expectedKeys.has(entry.key))
    .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
  await env.SUBPILOT_CONFIG.put(SOURCE_CACHE_META_INDEX_KEY, JSON.stringify(entries));
  return deleted;
}

export async function readSourceCacheStatus(env: Env, config?: AppConfig): Promise<SourceCacheStatus> {
  const entries = await readSourceCacheEntries(env);
  const sorted = entries.map((entry) => entry.fetchedAt).sort();
  const updatedAt = sorted.length > 0 ? sorted[sorted.length - 1]! : null;
  const sources = config ? await readSourceCacheSourceStatuses(config, entries) : [];
  const protocolCounts = new Map<string, number>();
  let totalNodes = 0;
  for (const source of sources) {
    totalNodes += source.nodeCount;
    for (const item of source.protocolCounts) {
      protocolCounts.set(item.protocol, (protocolCounts.get(item.protocol) ?? 0) + item.count);
    }
  }
  const cachedSourceCount = sources.filter((source) => source.cached).length;
  return {
    count: entries.length,
    updatedAt,
    expectedCount: sources.length,
    cachedSourceCount,
    allSourcesCached: sources.length > 0 && cachedSourceCount === sources.length,
    sources,
    totalNodes,
    protocolCounts: [...protocolCounts.entries()]
      .map(([protocol, count]) => ({ protocol, count }))
      .sort((left, right) => right.count - left.count || left.protocol.localeCompare(right.protocol))
  };
}

async function readSourceCacheSourceStatuses(
  config: AppConfig,
  entries: SourceCacheEntry[]
): Promise<SourceCacheSourceStatus[]> {
  const entriesByKey = new Map(entries.map((entry) => [entry.key, entry]));
  const statuses: SourceCacheSourceStatus[] = [];
  for (const source of config.sources) {
    if (!source.enabled || !source.url) continue;
    const key = await sourceCacheKeyFor(source.url, sourceUserAgent(config, source));
    const entry = entriesByKey.get(key);
    const cached = entry?.contentAvailable === true;
    statuses.push({
      sourceId: source.id,
      sourceName: source.name,
      cached,
      fetchedAt: cached ? entry?.fetchedAt ?? null : null,
      nodeCount: cached ? entry?.nodeCount ?? 0 : 0,
      protocolCounts: cached ? entry?.protocolCounts ?? [] : []
    });
  }
  return statuses;
}

async function sourceCacheKeysForEnabledSources(config: AppConfig): Promise<Set<string>> {
  const expectedKeys = new Set<string>();
  for (const source of config.sources) {
    if (!source.enabled || !source.url) continue;
    expectedKeys.add(await sourceCacheKeyFor(source.url, sourceUserAgent(config, source)));
  }
  return expectedKeys;
}

async function pruneUnexpectedSourceCacheEntries(env: Env, existing: SourceCacheEntry[], expectedKeys: Set<string>): Promise<number> {
  const contentKeys = await listKvKeys(env, SOURCE_CACHE_PREFIX);
  const staleCacheKeys = new Set<string>();
  for (const entry of existing) {
    if (!expectedKeys.has(entry.key)) staleCacheKeys.add(entry.key);
  }
  for (const key of contentKeys) {
    if (!expectedKeys.has(key)) staleCacheKeys.add(key);
  }
  await Promise.all([...staleCacheKeys].flatMap((key) => [
    env.SUBPILOT_CONFIG.delete(key),
    env.SUBPILOT_CONFIG.delete(sourceCacheMetaKey(key))
  ]));
  return staleCacheKeys.size;
}

async function sourceCacheKeyFor(url: string, userAgent: string): Promise<string> {
  return sourceCacheKey(await sha256Hex(`${url}|${userAgent}`));
}

function sourceCacheKey(hash: string): string {
  return `${SOURCE_CACHE_PREFIX}${hash}`;
}

function sourceCacheMetaKey(key: string): string {
  return `${SOURCE_CACHE_META_PREFIX}${key.slice(SOURCE_CACHE_PREFIX.length)}`;
}

async function writeSourceCacheEntry(
  env: Env,
  entry: Omit<SourceCacheEntry, "contentAvailable" | "nodeCount" | "protocolCounts"> & { content: string },
  options: { updateIndex?: boolean } = {}
): Promise<SourceCacheEntry> {
  const { content, ...baseMeta } = entry;
  const meta: SourceCacheEntry = {
    ...baseMeta,
    contentAvailable: true,
    ...sourceCacheContentStats(content, entry.sourceId)
  };
  const updateIndex = options.updateIndex !== false;
  const writes: Promise<unknown>[] = [
    env.SUBPILOT_CONFIG.put(entry.key, content),
    env.SUBPILOT_CONFIG.put(sourceCacheMetaKey(entry.key), JSON.stringify(meta))
  ];
  if (updateIndex) {
    const entries = [
      meta,
      ...await readSourceCacheEntries(env).then((existing) => existing.filter((item) => item.key !== entry.key))
    ];
    writes.push(env.SUBPILOT_CONFIG.put(SOURCE_CACHE_META_INDEX_KEY, JSON.stringify(entries)));
  }
  await Promise.all(writes);
  return meta;
}

async function fetchSourceContent(url: string, userAgent: string, sourceId: string): Promise<string> {
  let lastError: unknown;
  const deadline = Date.now() + SOURCE_FETCH_TOTAL_TIMEOUT_MS;
  for (let attempt = 0; attempt <= MAX_SOURCE_FETCH_RETRIES; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const content = await fetchWithTimeout(
        globalThis.fetch,
        url,
        { headers: { "user-agent": userAgent } },
        Math.min(SOURCE_FETCH_ATTEMPT_TIMEOUT_MS, remaining),
        async (response) => {
          if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            throw new Error(`HTTP ${response.status}`);
          }
          return readResponseTextWithLimit(response, MAX_SOURCE_CONTENT_BYTES, "Source subscription");
        }
      );
      assertSourceContentHasNodes(content, sourceId);
      return content;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_SOURCE_FETCH_RETRIES) {
        await waitForRetry(attempt, SOURCE_FETCH_RETRY_BASE_DELAY_MS, deadline);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function assertSourceContentHasNodes(content: string, sourceId: string): void {
  if (sourceCacheContentStats(content, sourceId).nodeCount <= 0) {
    throw new Error("No proxy nodes found in upstream subscription");
  }
}

async function readSourceCacheEntries(env: Env): Promise<SourceCacheEntry[]> {
  const indexed = await readKvJson<unknown>(env, SOURCE_CACHE_META_INDEX_KEY);
  const indexedEntries = Array.isArray(indexed) ? indexed.flatMap(normalizeSourceCacheEntry) : [];
  const metaKeys = await listKvKeys(env, SOURCE_CACHE_META_PREFIX);
  const entries = await Promise.all(metaKeys.map((key) => readKvJson<unknown>(env, key)));
  return dedupeSourceCacheEntries([
    ...indexedEntries,
    ...entries.flatMap(normalizeSourceCacheEntry)
  ]);
}

function dedupeSourceCacheEntries(entries: SourceCacheEntry[]): SourceCacheEntry[] {
  const selected = new Map<string, SourceCacheEntry>();
  for (const entry of entries) {
    const existing = selected.get(entry.key);
    if (!existing || entry.fetchedAt > existing.fetchedAt) {
      selected.set(entry.key, entry);
    }
  }
  return [...selected.values()];
}

function normalizeSourceCacheEntry(value: unknown): SourceCacheEntry[] {
  if (!value || typeof value !== "object") return [];
  const entry = value as Partial<SourceCacheEntry>;
  if (typeof entry.key !== "string" || !entry.key.startsWith(SOURCE_CACHE_PREFIX)) return [];
  if (typeof entry.fetchedAt !== "string" || Number.isNaN(new Date(entry.fetchedAt).getTime())) return [];
  const protocolCounts = normalizeSourceCacheProtocolCounts(entry.protocolCounts);
  return [{
    key: entry.key,
    fetchedAt: entry.fetchedAt,
    sourceId: typeof entry.sourceId === "string" ? entry.sourceId : "",
    sourceName: typeof entry.sourceName === "string" ? entry.sourceName : "",
    contentAvailable: typeof entry.contentAvailable === "boolean" ? entry.contentAvailable : true,
    nodeCount: normalizeSourceCacheNodeCount(entry.nodeCount, protocolCounts),
    protocolCounts
  }];
}
