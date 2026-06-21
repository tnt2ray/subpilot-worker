import { parseSubscription } from "./parsers";
import type { AppConfig, SourceConfig } from "./types";
import { sha256Hex } from "./util";

const SOURCE_CACHE_PREFIX = "cache:source:";
const SOURCE_CACHE_META_PREFIX = "cache:sourceMeta:";
const SOURCE_CACHE_META_INDEX_KEY = "cache:sourceMeta:index";
const MAX_SOURCE_CONTENT_BYTES = 10 * 1024 * 1024;
const MAX_SOURCE_FETCH_RETRIES = 3;

export interface SourceCacheEntry {
  key: string;
  fetchedAt: string;
  sourceId: string;
  sourceName: string;
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
}

export interface SourceCacheProtocolCount {
  protocol: string;
  count: number;
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
  return source.fetchUserAgent === "clash"
    ? config.settings.userAgentClash
    : config.settings.userAgentSurge;
}

export async function fetchCachedSource(env: Env, source: SourceConfig, userAgent: string): Promise<string> {
  const key = await sourceCacheKeyFor(source.url, userAgent);
  const cached = await env.SUBPILOT_CONFIG.get(key);
  if (cached !== null) return cached;
  const content = await fetchSourceContent(source.url, userAgent);
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
  const existing = await readSourceCacheEntries(env);
  const existingByKey = new Map(existing.map((entry) => [entry.key, entry]));
  const expectedKeys = await sourceCacheKeysForEnabledSources(config);
  const nextEntries = new Map<string, SourceCacheEntry>();
  const warnings: string[] = [];
  const failures: SourceCacheRefreshFailure[] = [];
  let refreshed = 0;
  let cached = 0;

  for (const source of enabled) {
    const userAgent = sourceUserAgent(config, source);
    const key = await sourceCacheKeyFor(source.url, userAgent);
    const now = new Date().toISOString();
    try {
      const content = await fetchSourceContent(source.url, userAgent);
      const entry: SourceCacheEntry = {
        key,
        fetchedAt: now,
        sourceId: source.id,
        sourceName: source.name
      };
      await writeSourceCacheEntry(env, { ...entry, content }, { updateIndex: false });
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

  const deleted = await pruneUnexpectedSourceCacheEntries(env, existing, expectedKeys);

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
  const sources = config ? await readSourceCacheSourceStatuses(env, config, entries) : [];
  const protocolCounts = new Map<string, number>();
  let totalNodes = 0;
  for (const source of sources) {
    const protocols = "protocols" in source && Array.isArray(source.protocols) ? source.protocols : [];
    totalNodes += source.nodeCount;
    for (const protocol of protocols) {
      protocolCounts.set(protocol, (protocolCounts.get(protocol) ?? 0) + 1);
    }
  }
  const visibleSources = sources.map((source) => ({
    sourceId: source.sourceId,
    sourceName: source.sourceName,
    cached: source.cached,
    fetchedAt: source.fetchedAt,
    nodeCount: source.nodeCount
  }));
  const cachedSourceCount = visibleSources.filter((source) => source.cached).length;
  return {
    count: entries.length,
    updatedAt,
    expectedCount: visibleSources.length,
    cachedSourceCount,
    allSourcesCached: visibleSources.length > 0 && cachedSourceCount === visibleSources.length,
    sources: visibleSources,
    totalNodes,
    protocolCounts: [...protocolCounts.entries()]
      .map(([protocol, count]) => ({ protocol, count }))
      .sort((left, right) => right.count - left.count || left.protocol.localeCompare(right.protocol))
  };
}

async function readSourceCacheSourceStatuses(
  env: Env,
  config: AppConfig,
  entries: SourceCacheEntry[]
): Promise<Array<SourceCacheSourceStatus & { protocols: string[] }>> {
  const entriesByKey = new Map(entries.map((entry) => [entry.key, entry]));
  const statuses: Array<SourceCacheSourceStatus & { protocols: string[] }> = [];
  for (const source of config.sources) {
    if (!source.enabled || !source.url) continue;
    const key = await sourceCacheKeyFor(source.url, sourceUserAgent(config, source));
    const entry = entriesByKey.get(key);
    const content = entry ? await env.SUBPILOT_CONFIG.get(key) : null;
    const protocols = content ? parseProtocols(content, source.id) : [];
    statuses.push({
      sourceId: source.id,
      sourceName: source.name,
      cached: content !== null,
      fetchedAt: content !== null ? entry?.fetchedAt ?? null : null,
      nodeCount: protocols.length,
      protocols
    });
  }
  return statuses;
}

function parseProtocols(content: string, sourceId: string): string[] {
  try {
    return parseSubscription(content, sourceId).map((node) => normalizeProtocol(node.type));
  } catch {
    return [];
  }
}

function normalizeProtocol(value: string): string {
  const protocol = value.trim().toLowerCase();
  if (protocol === "hy2") return "hysteria2";
  return protocol || "unknown";
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
  const contentKeys = await listKeys(env, SOURCE_CACHE_PREFIX);
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
  entry: SourceCacheEntry & { content: string },
  options: { updateIndex?: boolean } = {}
): Promise<void> {
  const { content, ...meta } = entry;
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
}

async function fetchSourceContent(url: string, userAgent: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_SOURCE_FETCH_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "user-agent": userAgent } });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`HTTP ${response.status}`);
      }
      return await readResponseTextWithLimit(response, MAX_SOURCE_CONTENT_BYTES);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function readSourceCacheEntries(env: Env): Promise<SourceCacheEntry[]> {
  const indexed = await readJson<unknown>(env, SOURCE_CACHE_META_INDEX_KEY);
  const indexedEntries = Array.isArray(indexed) ? indexed.flatMap(normalizeSourceCacheEntry) : [];
  const metaKeys = await listKeys(env, SOURCE_CACHE_META_PREFIX);
  const entries = await Promise.all(metaKeys.map((key) => readJson<unknown>(env, key)));
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
  return [{
    key: entry.key,
    fetchedAt: entry.fetchedAt,
    sourceId: typeof entry.sourceId === "string" ? entry.sourceId : "",
    sourceName: typeof entry.sourceName === "string" ? entry.sourceName : ""
  }];
}

async function listKeys(env: Env, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const options: KVNamespaceListOptions = cursor ? { prefix, cursor } : { prefix };
    const page = await env.SUBPILOT_CONFIG.list(options);
    keys.push(...page.keys.map((key) => key.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return keys;
}

async function readJson<T>(env: Env, key: string): Promise<T | null> {
  const value = await env.SUBPILOT_CONFIG.get(key);
  if (value === null) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

async function readResponseTextWithLimit(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) throw new Error(`Source subscription exceeds ${formatBytes(maxBytes)} limit`);
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`Source subscription exceeds ${formatBytes(maxBytes)} limit`);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function formatBytes(bytes: number): string {
  return `${Math.floor(bytes / 1024 / 1024)} MiB`;
}
