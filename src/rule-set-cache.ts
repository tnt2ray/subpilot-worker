import { decryptText, encryptText } from "./crypto-store";
import { listKvKeys, readKvJson } from "./kv-helpers";
import { renderCombinedRuleSet, renderCompiledRuleSetBucket } from "./rule-set-renderer";
import type { ParsedRuleSetRule } from "./rule-set-parser";
import { effectiveRuleSetOutputs } from "./rule-set-outputs";
import type { RuleSetBucket, RuleSetDownloadBucket, RuleSetOutputTarget, RuleSetSource } from "./rule-set-types";
import { RULE_SET_BUCKETS, RULE_SET_TARGETS } from "./rule-set-types";
import { planRuleSetArtifacts } from "./rule-set-artifacts";
import { requireSecret } from "./secrets";
import type { AppConfig } from "./types";
import { randomToken, readResponseTextWithLimit, sha256Hex } from "./util";
import { fetchWithTimeout, waitForRetry } from "./upstream-fetch";

export const RULE_SET_SOURCE_CACHE_PREFIX = "cache:ruleSetSource:";
export const RULE_SET_SOURCE_CACHE_META_PREFIX = "cache:ruleSetSourceMeta:";
export const RULE_SET_SOURCE_CACHE_META_INDEX_KEY = "cache:ruleSetSourceMeta:index";
export const COMPILED_RULE_SET_PREFIX = "cache:compiledRuleSet:";
export const COMPILED_RULE_SET_META_PREFIX = "cache:compiledRuleSetMeta:";

const MAX_RULE_SET_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_RULE_SET_SOURCE_FETCH_RETRIES = 1;
const RULE_SET_SOURCE_FETCH_ATTEMPT_TIMEOUT_MS = 8_000;
const RULE_SET_SOURCE_FETCH_TOTAL_TIMEOUT_MS = 25_000;
const RULE_SET_SOURCE_FETCH_RETRY_BASE_DELAY_MS = 100;
const UNKNOWN_RULE_SET_SOURCE_FETCHED_AT = "1970-01-01T00:00:00.000Z";
const ENCRYPTED_CACHE_STORAGE_PREFIX = "\u001fsubpilot-encrypted-cache:";
const MAX_RULE_SET_SOURCE_CACHE_MIGRATIONS_PER_PRUNE = 100;
const MAX_RULE_SET_REFRESH_CONTENT_CHARACTERS = 12 * 1024 * 1024;
const MAX_COMPILED_RULE_SET_PLAINTEXT_CHARACTERS = 16 * 1024 * 1024;
const MAX_COMPILED_RULE_SET_KV_VALUE_BYTES = 24 * 1024 * 1024;
const RETAINED_COMPILED_RULE_SET_VERSIONS = 3;
const COMPILED_RULE_SET_GC_GRACE_MS = 5 * 60 * 1000;
const MAX_COMPILED_VERSION_KEYS_PER_PAGE = 64;
const MAX_COMPILED_CONTENT_KEYS_PER_PAGE = 64;
const MAX_COMPILED_OUTPUTS_GC_PER_RUN = 4;
const MAX_COMPILED_VERSIONS_DELETED_PER_OUTPUT = 2;
const MAX_COMPILED_ORPHANS_CHECKED_PER_OUTPUT = 4;
const MAX_COMPILED_ORPHANS_DELETED_PER_OUTPUT = 1;
const MAX_COMPILED_OUTPUT_KEYS_DELETED_PER_RUN = 64;
const MAX_STALE_COMPILED_OUTPUTS_DELETED_PER_RUN = 2;
const MAX_COMPILED_MANIFEST_CANDIDATES = 8;

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
  targetCounts?: Partial<Record<RuleSetOutputTarget, number>>;
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
  storageId?: string | undefined;
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
  options: { allowCachedFallback?: boolean; forceRefresh?: boolean; deadline?: number } = {}
): Promise<RuleSetSourceFetchResult> {
  const key = await ruleSetSourceCacheKey(source.url);
  const stored = await env.SUBPILOT_CONFIG.get(key);
  let cached: string | null = null;
  if (stored !== null) {
    try {
      cached = await readEncryptedCacheContent(env, key, stored, {
        migratePlaintext: options.forceRefresh !== true
      });
    } catch {
      cached = null;
      // A successful upstream fetch below replaces the corrupt value with one
      // put. Avoid delete-then-put on the same key within KV's one-second write
      // window.
    }
  }
  if (!options.forceRefresh) {
    if (cached !== null) return { content: cached, usedCachedContent: false };
  }

  try {
    if (deadlineExceeded(options.deadline)) throw new Error(RULE_SET_REFRESH_DEADLINE_REASON);
    const content = await fetchRuleSetSourceContent(source.url, options.deadline);
    let warning: string | undefined;
    try {
      await writeRuleSetSourceCacheEntry(env, {
        key,
        content,
        fetchedAt: new Date().toISOString(),
        sourceId: source.id,
        sourceName: source.name
      }, { updateIndex: false });
    } catch (error) {
      warning = `${source.name}: 规则来源缓存写入失败：${error instanceof Error ? error.message : String(error)}`;
      console.warn(JSON.stringify({ level: "warn", message: warning }));
    }
    return { content, usedCachedContent: false, ...(warning ? { warning } : {}) };
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
  options: { pruneUnexpected: boolean; deadline?: number }
): Promise<RuleSetSourceCacheRefreshResult> {
  if (deadlineExceeded(options.deadline)) {
    const reason = RULE_SET_REFRESH_DEADLINE_REASON;
    const failures = sourcesToRefresh
      .filter((source) => source.enabled && source.url)
      .map((source) => ({
        sourceId: source.id,
        sourceName: source.name,
        reason,
        usedCachedContent: false
      }));
    return {
      refreshed: 0,
      failed: failures.length,
      cached: 0,
      deleted: 0,
      warnings: failures.map((failure) => `${failure.sourceName}: ${reason}`),
      failures,
      contentByKey: new Map(),
      errorsByKey: new Map()
    };
  }
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
  let retainedCharacters = 0;

  for (const source of sourcesToRefresh) {
    if (!source.enabled || !source.url) continue;
    const key = await ruleSetSourceCacheKey(source.url);
    if (deadlineExceeded(options.deadline)) {
      const reason = RULE_SET_REFRESH_DEADLINE_REASON;
      errorsByKey.set(key, reason);
      failures.push({ sourceId: source.id, sourceName: source.name, reason, usedCachedContent: false });
      warnings.push(`${source.name}: ${reason}`);
      continue;
    }
    const storedCachedContent = await env.SUBPILOT_CONFIG.get(key);
    let cachedContent: string | null = null;
    if (storedCachedContent !== null) {
      try {
        cachedContent = await readEncryptedCacheContent(env, key, storedCachedContent, {
          migratePlaintext: false
        });
      } catch {
        cachedContent = null;
        // Leave the corrupt value in place until the successful refresh below
        // atomically replaces it with a single KV write.
      }
    }
    try {
      if (deadlineExceeded(options.deadline)) throw new Error(RULE_SET_REFRESH_DEADLINE_REASON);
      const content = await fetchRuleSetSourceContent(source.url, options.deadline);
      const entry = await writeRuleSetSourceCacheEntry(env, {
        key,
        content,
        fetchedAt: new Date().toISOString(),
        sourceId: source.id,
        sourceName: source.name
      }, { updateIndex: false });
      nextEntries.set(key, entry);
      if (retainedCharacters + content.length > MAX_RULE_SET_REFRESH_CONTENT_CHARACTERS) {
        const reason = `规则集来源内容总量超过 ${MAX_RULE_SET_REFRESH_CONTENT_CHARACTERS} 字符限制`;
        errorsByKey.set(key, reason);
        failures.push({ sourceId: source.id, sourceName: source.name, reason, usedCachedContent: false });
        warnings.push(`${source.name}: ${reason}`);
        continue;
      }
      retainedCharacters += content.length;
      contentByKey.set(key, { content, usedCachedContent: false });
      refreshed += 1;
    } catch (error) {
      let reason = error instanceof Error ? error.message : String(error);
      const existingEntry = existingByKey.get(key);
      let usedCachedContent = false;
      if (cachedContent !== null) {
        nextEntries.set(key, existingEntry ?? {
          key,
          fetchedAt: UNKNOWN_RULE_SET_SOURCE_FETCHED_AT,
          sourceId: source.id,
          sourceName: source.name,
          contentAvailable: true
        });
        if (retainedCharacters + cachedContent.length <= MAX_RULE_SET_REFRESH_CONTENT_CHARACTERS) {
          retainedCharacters += cachedContent.length;
          contentByKey.set(key, {
            content: cachedContent,
            usedCachedContent: true,
            warning: `${source.name}: ${reason}`
          });
          cached += 1;
          usedCachedContent = true;
        } else {
          reason = `规则集来源内容总量超过 ${MAX_RULE_SET_REFRESH_CONTENT_CHARACTERS} 字符限制`;
          errorsByKey.set(key, reason);
        }
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

  const deleted = options.pruneUnexpected && !deadlineExceeded(options.deadline)
    ? await pruneUnexpectedRuleSetSourceCacheEntries(env, existing, expectedKeys)
    : 0;
  if (options.pruneUnexpected && deadlineExceeded(options.deadline)) {
    warnings.push("规则集刷新已到截止时间，跳过过期来源缓存清理。");
  }
  const entries = [...nextEntries.values()].sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
  if (!deadlineExceeded(options.deadline)) {
    await env.SUBPILOT_CONFIG.put(RULE_SET_SOURCE_CACHE_META_INDEX_KEY, JSON.stringify(entries));
  }

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
  await migrateRetainedRuleSetSourceCacheContents(env, expectedKeys);
  await env.SUBPILOT_CONFIG.put(
    RULE_SET_SOURCE_CACHE_META_INDEX_KEY,
    JSON.stringify(sourceEntries.filter((entry) => expectedKeys.has(entry.key)).sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt)))
  );
  const compiledDeleted = await pruneCompiledRuleSetCaches(env, config);
  return sourceDeleted + compiledDeleted;
}

export async function pruneCompiledRuleSetCaches(env: Env, config: AppConfig): Promise<number> {
  const outputNames = effectiveRuleSetOutputs(config.ruleSets).map((output) => output.name);
  const deleted = await pruneUnexpectedCompiledRuleSets(env, new Set(outputNames));
  for (const outputName of compiledOutputsForGarbageCollection(outputNames, Date.now())) {
    await pruneOldCompiledRuleSetVersions(env, outputName).catch(() => undefined);
  }
  return deleted;
}

export async function readCompiledRuleSetManifest(env: Env, outputName: string): Promise<CompiledRuleSetManifest | null> {
  const headPage = await listKvKeyPage(
    env,
    compiledRuleSetVersionHeadPrefix(outputName),
    MAX_COMPILED_MANIFEST_CANDIDATES
  );
  for (const versionKey of headPage.keys) {
    const storageId = compiledRuleSetVersionHeadStorageId(outputName, versionKey);
    if (!storageId) continue;
    const versioned = normalizeCompiledManifest(await readKvJson<unknown>(
      env,
      compiledRuleSetVersionMetaKey(outputName, storageId)
    ));
    if (
      versioned
      && versioned.outputName === outputName
      && versioned.storageId === storageId
      && await compiledManifestContentIsVisible(env, versioned)
    ) return versioned;
  }

  // Compatibility for versioned caches written before the newest-first head
  // index existed. Only inspect a complete bounded page: returning an entry
  // from a truncated oldest-first page could select a stale version.
  const legacyPage = await listKvKeyPage(
    env,
    compiledRuleSetVersionMetaPrefix(outputName),
    MAX_COMPILED_MANIFEST_CANDIDATES
  );
  if (legacyPage.complete) {
    for (const versionKey of legacyPage.keys.sort().reverse()) {
      const versioned = normalizeCompiledManifest(await readKvJson<unknown>(env, versionKey));
      const storageId = versionKey.slice(compiledRuleSetVersionMetaPrefix(outputName).length);
      if (
        versioned
        && versioned.outputName === outputName
        && versioned.storageId === storageId
        && await compiledManifestContentIsVisible(env, versioned)
      ) return versioned;
    }
  }
  return normalizeCompiledManifest(await readKvJson<unknown>(env, compiledRuleSetMetaKey(outputName)));
}

export async function readCompiledRuleSetBucket(
  env: Env,
  outputName: string,
  bucket: RuleSetDownloadBucket,
  target: RuleSetOutputTarget,
  manifest?: CompiledRuleSetManifest
): Promise<string | null> {
  const selectedManifest = manifest ?? await readCompiledRuleSetManifest(env, outputName);
  const key = compiledRuleSetContentKey(outputName, bucket, target, selectedManifest?.storageId);
  const stored = await env.SUBPILOT_CONFIG.get(key);
  if (stored === null) return null;
  try {
    return await readEncryptedCacheContent(env, key, stored);
  } catch {
    // Versioned artifacts are immutable. Do not delete a corrupt value here:
    // it may have been published less than a second ago, and a delete would
    // violate KV's same-key write limit. A later compilation publishes a new
    // version and bounded garbage collection removes the old one after grace.
    return null;
  }
}

export async function writeCompiledRuleSet(
  env: Env,
  manifest: CompiledRuleSetManifest,
  buckets: Record<RuleSetBucket, ParsedRuleSetRule[]>
): Promise<void> {
  const storageId = compiledRuleSetStorageId();
  manifest.storageId = storageId;
  for (const bucket of RULE_SET_BUCKETS) {
    const rules = buckets[bucket];
    if (rules.length === 0) continue;
    const bucketMeta = manifest.buckets.find((item) => item.bucket === bucket);
    for (const target of RULE_SET_TARGETS) {
      if (bucketMeta && !bucketMeta.targets.includes(target)) continue;
      const key = compiledRuleSetContentKey(manifest.outputName, bucket, target, storageId);
      const content = renderCompiledRuleSetBucket(rules, bucket, target);
      await writeEncryptedCompiledContent(env, key, content);
    }
  }
  for (const target of RULE_SET_TARGETS) {
    const combined = planRuleSetArtifacts(manifest.buckets, target).find((artifact) => artifact.bucket === "combined");
    if (!combined) continue;
    const key = compiledRuleSetContentKey(manifest.outputName, "combined", target, storageId);
    const content = renderCombinedRuleSet(buckets, target, combined);
    await writeEncryptedCompiledContent(env, key, content);
  }
  // The manifest is the commit marker and is written only after every content
  // object. Failed publishes intentionally leave append-only orphan content;
  // deleting freshly written keys here can hit KV's one-write-per-second limit.
  const serializedManifest = JSON.stringify(manifest);
  await env.SUBPILOT_CONFIG.put(compiledRuleSetVersionMetaKey(manifest.outputName, storageId), serializedManifest);
  await env.SUBPILOT_CONFIG.put(compiledRuleSetVersionHeadKey(manifest.outputName, storageId), storageId);
  // Output-specific/manual refreshes skip the global prune pass. Keep their
  // immutable versions bounded too, without turning a successful commit into
  // a refresh failure if best-effort cleanup is temporarily unavailable.
  await pruneOldCompiledRuleSetVersions(env, manifest.outputName, storageId).catch(() => undefined);
}

export async function deleteCompiledRuleSet(env: Env, outputName: string): Promise<void> {
  const now = Date.now();
  const [metaPage, contentPage] = await Promise.all([
    listKvKeyPage(env, compiledRuleSetMetaOutputPrefix(outputName), MAX_COMPILED_OUTPUT_KEYS_DELETED_PER_RUN),
    listKvKeyPage(env, compiledRuleSetContentOutputPrefix(outputName), MAX_COMPILED_OUTPUT_KEYS_DELETED_PER_RUN)
  ]);
  const keys = [...new Set([
    ...metaPage.keys,
    ...contentPage.keys,
    compiledRuleSetMetaKey(outputName)
  ])]
    .filter((key) => compiledArtifactIsOldEnoughToDelete(key, outputName, now))
    .slice(0, MAX_COMPILED_OUTPUT_KEYS_DELETED_PER_RUN);
  await Promise.all(keys.map((key) => env.SUBPILOT_CONFIG.delete(key)));
}

export function compiledRuleSetContentKey(
  outputName: string,
  bucket: RuleSetDownloadBucket,
  target: RuleSetOutputTarget,
  storageId?: string
): string {
  const version = storageId ? `${storageId}:` : "";
  return `${compiledRuleSetContentOutputPrefix(outputName)}${version}${bucket}:${target}`;
}

export function compiledRuleSetMetaKey(outputName: string): string {
  return `${COMPILED_RULE_SET_META_PREFIX}${encodeURIComponent(outputName)}`;
}

function compiledRuleSetMetaOutputPrefix(outputName: string): string {
  return `${compiledRuleSetMetaKey(outputName)}:`;
}

function compiledRuleSetVersionMetaPrefix(outputName: string): string {
  return `${compiledRuleSetMetaOutputPrefix(outputName)}v:`;
}

function compiledRuleSetVersionMetaKey(outputName: string, storageId: string): string {
  return `${compiledRuleSetVersionMetaPrefix(outputName)}${storageId}`;
}

function compiledRuleSetVersionHeadPrefix(outputName: string): string {
  return `${compiledRuleSetMetaOutputPrefix(outputName)}h:`;
}

function compiledRuleSetVersionHeadKey(outputName: string, storageId: string): string {
  const timestamp = compiledStorageIdTimestamp(storageId) ?? 0;
  const reverseTimestamp = String(Number.MAX_SAFE_INTEGER - timestamp).padStart(16, "0");
  return `${compiledRuleSetVersionHeadPrefix(outputName)}${reverseTimestamp}:${storageId}`;
}

function compiledRuleSetVersionHeadStorageId(outputName: string, key: string): string | null {
  const prefix = compiledRuleSetVersionHeadPrefix(outputName);
  if (!key.startsWith(prefix)) return null;
  const separator = key.indexOf(":", prefix.length);
  if (separator < 0) return null;
  const storageId = key.slice(separator + 1);
  return key === compiledRuleSetVersionHeadKey(outputName, storageId) ? storageId : null;
}

function compiledRuleSetContentOutputPrefix(outputName: string): string {
  return `${COMPILED_RULE_SET_PREFIX}${encodeURIComponent(outputName)}:`;
}

function compiledRuleSetStorageId(): string {
  return `${String(Date.now()).padStart(16, "0")}-${randomToken(8)}`;
}

async function writeEncryptedCompiledContent(env: Env, key: string, content: string): Promise<void> {
  if (content.length > MAX_COMPILED_RULE_SET_PLAINTEXT_CHARACTERS) {
    throw new Error(`编译规则集产物超过 ${MAX_COMPILED_RULE_SET_PLAINTEXT_CHARACTERS} 字符限制`);
  }
  const encrypted = await encryptCacheContent(env, content);
  if (encrypted.length > MAX_COMPILED_RULE_SET_KV_VALUE_BYTES) {
    throw new Error(`编译规则集加密产物超过 ${MAX_COMPILED_RULE_SET_KV_VALUE_BYTES} 字节 KV 限制`);
  }
  await env.SUBPILOT_CONFIG.put(key, encrypted);
}

async function pruneOldCompiledRuleSetVersions(
  env: Env,
  outputName: string,
  currentStorageId?: string
): Promise<void> {
  const now = Date.now();
  const metaPrefix = compiledRuleSetVersionMetaPrefix(outputName);
  const page = await listKvKeyPage(env, metaPrefix, MAX_COMPILED_VERSION_KEYS_PER_PAGE);
  const sortedKeys = [...page.keys].sort();
  const retained = new Set<string>(page.complete ? sortedKeys.slice(-RETAINED_COMPILED_RULE_SET_VERSIONS) : []);
  if (currentStorageId) retained.add(compiledRuleSetVersionMetaKey(outputName, currentStorageId));
  const staleMetaKeys = sortedKeys
    .filter((key) => !retained.has(key))
    .filter((key) => compiledStorageIdIsOldEnough(
      key.slice(metaPrefix.length),
      now
    ))
    .slice(0, MAX_COMPILED_VERSIONS_DELETED_PER_OUTPUT);
  for (const metaKey of staleMetaKeys) {
    await deleteCompiledRuleSetVersion(env, outputName, metaKey);
  }
  await pruneOrphanCompiledRuleSetContents(env, outputName, currentStorageId, now);
}

async function deleteCompiledRuleSetVersion(env: Env, outputName: string, metaKey: string): Promise<void> {
  const storageId = metaKey.slice(compiledRuleSetVersionMetaPrefix(outputName).length);
  const contentPrefix = `${compiledRuleSetContentOutputPrefix(outputName)}${storageId}:`;
  const page = await listKvKeyPage(env, contentPrefix, MAX_COMPILED_CONTENT_KEYS_PER_PAGE);
  await Promise.all(page.keys.map((key) => env.SUBPILOT_CONFIG.delete(key)));
  // Keep the manifest as a retry marker until every content page is gone.
  if (page.complete) {
    const headKey = compiledRuleSetVersionHeadKey(outputName, storageId);
    if (await env.SUBPILOT_CONFIG.get(headKey) !== null) {
      await env.SUBPILOT_CONFIG.delete(headKey);
    }
    await env.SUBPILOT_CONFIG.delete(metaKey);
  }
}

async function pruneOrphanCompiledRuleSetContents(
  env: Env,
  outputName: string,
  currentStorageId: string | undefined,
  now: number
): Promise<void> {
  const contentPrefix = compiledRuleSetContentOutputPrefix(outputName);
  const page = await listKvKeyPage(env, contentPrefix, MAX_COMPILED_CONTENT_KEYS_PER_PAGE);
  const candidates = [...new Set(page.keys.flatMap((key) => {
    const storageId = compiledStorageIdFromContentKey(key, outputName);
    return storageId
      && storageId !== currentStorageId
      && compiledStorageIdIsOldEnough(storageId, now)
      ? [storageId]
      : [];
  }))].slice(0, MAX_COMPILED_ORPHANS_CHECKED_PER_OUTPUT);
  let deleted = 0;
  for (const storageId of candidates) {
    if (deleted >= MAX_COMPILED_ORPHANS_DELETED_PER_OUTPUT) break;
    if (await env.SUBPILOT_CONFIG.get(compiledRuleSetVersionMetaKey(outputName, storageId)) !== null) continue;
    const orphanPrefix = `${contentPrefix}${storageId}:`;
    const orphanPage = await listKvKeyPage(env, orphanPrefix, MAX_COMPILED_CONTENT_KEYS_PER_PAGE);
    await Promise.all(orphanPage.keys.map((key) => env.SUBPILOT_CONFIG.delete(key)));
    deleted += 1;
  }
}

async function compiledManifestContentIsVisible(env: Env, manifest: CompiledRuleSetManifest): Promise<boolean> {
  if (!manifest.storageId) return true;
  const keys = compiledManifestContentKeys(manifest);
  const values = await Promise.all(keys.map((key) => env.SUBPILOT_CONFIG.get(key)));
  return values.every((value) => value !== null);
}

function compiledManifestContentKeys(manifest: CompiledRuleSetManifest): string[] {
  if (!manifest.storageId) return [];
  const keys = new Set<string>();
  for (const bucket of manifest.buckets) {
    for (const target of bucket.targets) {
      keys.add(compiledRuleSetContentKey(manifest.outputName, bucket.bucket, target, manifest.storageId));
    }
  }
  for (const target of RULE_SET_TARGETS) {
    if (planRuleSetArtifacts(manifest.buckets, target).some((artifact) => artifact.bucket === "combined")) {
      keys.add(compiledRuleSetContentKey(manifest.outputName, "combined", target, manifest.storageId));
    }
  }
  return [...keys];
}

interface KvKeyPage {
  keys: string[];
  complete: boolean;
}

async function listKvKeyPage(env: Env, prefix: string, limit: number): Promise<KvKeyPage> {
  const page = await env.SUBPILOT_CONFIG.list({ prefix, limit });
  const names = page.keys.map((key) => key.name).sort();
  return {
    keys: names.slice(0, limit),
    complete: page.list_complete && names.length <= limit
  };
}

function compiledArtifactIsOldEnoughToDelete(key: string, outputName: string, now: number): boolean {
  const versionMetaPrefix = compiledRuleSetVersionMetaPrefix(outputName);
  if (key.startsWith(versionMetaPrefix)) {
    return compiledStorageIdIsOldEnough(key.slice(versionMetaPrefix.length), now);
  }
  const versionHeadPrefix = compiledRuleSetVersionHeadPrefix(outputName);
  if (key.startsWith(versionHeadPrefix)) {
    const storageId = compiledRuleSetVersionHeadStorageId(outputName, key);
    return storageId !== null && compiledStorageIdIsOldEnough(storageId, now);
  }
  const storageId = compiledStorageIdFromContentKey(key, outputName);
  return storageId === null || compiledStorageIdIsOldEnough(storageId, now);
}

function compiledStorageIdFromContentKey(key: string, outputName: string): string | null {
  const prefix = compiledRuleSetContentOutputPrefix(outputName);
  if (!key.startsWith(prefix)) return null;
  const storageId = key.slice(prefix.length).split(":", 1)[0] ?? "";
  return compiledStorageIdTimestamp(storageId) === null ? null : storageId;
}

function compiledStorageIdIsOldEnough(storageId: string, now: number): boolean {
  const timestamp = compiledStorageIdTimestamp(storageId);
  return timestamp !== null && timestamp <= now - COMPILED_RULE_SET_GC_GRACE_MS;
}

function compiledStorageIdTimestamp(storageId: string): number | null {
  const match = storageId.match(/^(\d{16})-[A-Za-z0-9_-]+$/);
  if (!match) return null;
  const timestamp = Number(match[1]);
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
}

function compiledOutputsForGarbageCollection(outputNames: string[], now: number): string[] {
  if (outputNames.length <= MAX_COMPILED_OUTPUTS_GC_PER_RUN) return outputNames;
  const start = Math.floor(now / (24 * 60 * 60 * 1000)) % outputNames.length;
  return Array.from(
    { length: MAX_COMPILED_OUTPUTS_GC_PER_RUN },
    (_, index) => outputNames[(start + index) % outputNames.length]!
  );
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
  const encryptedContent = await encryptCacheContent(env, content);
  const writes: Promise<unknown>[] = [
    env.SUBPILOT_CONFIG.put(entry.key, encryptedContent),
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

async function migrateRetainedRuleSetSourceCacheContents(env: Env, expectedKeys: Set<string>): Promise<void> {
  for (const key of [...expectedKeys].slice(0, MAX_RULE_SET_SOURCE_CACHE_MIGRATIONS_PER_PRUNE)) {
    const stored = await env.SUBPILOT_CONFIG.get(key);
    if (stored === null || stored.startsWith(ENCRYPTED_CACHE_STORAGE_PREFIX)) continue;
    await readEncryptedCacheContent(env, key, stored);
  }
}

async function readEncryptedCacheContent(
  env: Env,
  key: string,
  stored: string,
  options: { migratePlaintext?: boolean } = {}
): Promise<string> {
  if (stored.startsWith(ENCRYPTED_CACHE_STORAGE_PREFIX)) {
    return decryptText(
      requireSecret(env, "CONFIG_ENCRYPTION_KEY"),
      stored.slice(ENCRYPTED_CACHE_STORAGE_PREFIX.length)
    );
  }

  if (options.migratePlaintext === false) return stored;
  const encrypted = await encryptCacheContent(env, stored);
  await env.SUBPILOT_CONFIG.put(key, encrypted).catch(() => undefined);
  return stored;
}

async function encryptCacheContent(env: Env, content: string): Promise<string> {
  const encrypted = await encryptText(requireSecret(env, "CONFIG_ENCRYPTION_KEY"), content);
  return `${ENCRYPTED_CACHE_STORAGE_PREFIX}${encrypted}`;
}

const RULE_SET_REFRESH_DEADLINE_REASON = "规则集刷新已超过截止时间";

function deadlineExceeded(deadline: number | undefined): boolean {
  return deadline !== undefined && Date.now() >= deadline;
}

async function fetchRuleSetSourceContent(url: string, absoluteDeadline?: number): Promise<string> {
  let lastError: unknown;
  const deadline = Math.min(
    Date.now() + RULE_SET_SOURCE_FETCH_TOTAL_TIMEOUT_MS,
    absoluteDeadline ?? Number.POSITIVE_INFINITY
  );
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
      if (absoluteDeadline !== undefined && Date.now() >= absoluteDeadline) {
        lastError = new Error(RULE_SET_REFRESH_DEADLINE_REASON);
        break;
      }
      if (attempt < MAX_RULE_SET_SOURCE_FETCH_RETRIES) {
        await waitForRetry(attempt, RULE_SET_SOURCE_FETCH_RETRY_BASE_DELAY_MS, deadline);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(
    absoluteDeadline !== undefined && Date.now() >= absoluteDeadline
      ? RULE_SET_REFRESH_DEADLINE_REASON
      : "规则来源拉取失败"
  );
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
  const selected = [...staleOutputNames].sort().slice(0, MAX_STALE_COMPILED_OUTPUTS_DELETED_PER_RUN);
  for (const outputName of selected) await deleteCompiledRuleSet(env, outputName);
  return selected.length;
}

function ruleSetSourceCacheMetaKey(key: string): string {
  return `${RULE_SET_SOURCE_CACHE_META_PREFIX}${key.slice(RULE_SET_SOURCE_CACHE_PREFIX.length)}`;
}

function compiledRuleSetOutputNameFromMetaKey(key: string): string | null {
  if (!key.startsWith(COMPILED_RULE_SET_META_PREFIX)) return null;
  return safeDecodeURIComponent(key.slice(COMPILED_RULE_SET_META_PREFIX.length).split(":", 1)[0] ?? "");
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
    warnings: Array.isArray(record.warnings) ? record.warnings.filter((item): item is string => typeof item === "string") : [],
    ...(typeof record.storageId === "string" && /^[A-Za-z0-9_-]+$/.test(record.storageId)
      ? { storageId: record.storageId }
      : {})
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
      : [],
    ...(record.targetCounts && typeof record.targetCounts === "object"
      ? {
        targetCounts: Object.fromEntries(RULE_SET_TARGETS.flatMap((target) => {
          const count = record.targetCounts?.[target];
          return typeof count === "number" && count >= 0 ? [[target, count]] : [];
        }))
      }
      : {})
  }];
}
