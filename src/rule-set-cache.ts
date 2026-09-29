import { decryptText, encryptText } from "./crypto-store";
import { deleteKvKeys, listKvKeys, readKvJson } from "./kv-helpers";
import { renderCombinedRuleSet, renderCompiledRuleSetBucket } from "./rule-set-renderer";
import type { CompiledRuleSetRule } from "./rule-set-parser";
import { compiledRuleSetSources, effectiveRuleSetOutputs, ruleSetOutputNeedsCompilation } from "./rule-set-outputs";
import { renderRuleSetRuleForTarget } from "./rule-targets";
import { renderSingboxRules } from "./rule-set-renderer";
import type { RuleSetBucket, RuleSetDownloadBucket, RuleSetOutputTarget, RuleSetSource } from "./rule-set-types";
import { RULE_SET_BUCKETS, RULE_SET_TARGETS } from "./rule-set-types";
import { planRuleSetArtifacts } from "./rule-set-artifacts";
import { requireSecret } from "./secrets";
import type { RenderConfig } from "./types";
import { randomToken, readResponseTextWithLimit, sha256Hex } from "./util";
import { fetchWithTimeout, waitForRetry } from "./upstream-fetch";

export const RULE_SET_SOURCE_CACHE_PREFIX = "cache:ruleSetSource:";
export const RULE_SET_SOURCE_CACHE_META_PREFIX = "cache:ruleSetSourceMeta:";
export const COMPILED_RULE_SET_PREFIX = "cache:compiledRuleSet:";
export const COMPILED_RULE_SET_META_PREFIX = "cache:compiledRuleSetMeta:";

const MAX_RULE_SET_SOURCE_FETCH_RETRIES = 1;
const RULE_SET_SOURCE_FETCH_ATTEMPT_TIMEOUT_MS = 8_000;
const RULE_SET_SOURCE_FETCH_TOTAL_TIMEOUT_MS = 25_000;
const RULE_SET_SOURCE_FETCH_RETRY_BASE_DELAY_MS = 100;
const UNKNOWN_RULE_SET_SOURCE_FETCHED_AT = "1970-01-01T00:00:00.000Z";
const ENCRYPTED_CACHE_STORAGE_PREFIX = "\u001fsubpilot-encrypted-cache:";
// Leave room for encryption/base64 within KV's value limit and Worker memory.
const MAX_RULE_SET_SOURCE_CONTENT_BYTES = 16 * 1024 * 1024;
const MAX_COMPILED_RULE_SET_PLAINTEXT_CHARACTERS = 16 * 1024 * 1024;
const MAX_COMPILED_RULE_SET_KV_VALUE_BYTES = 24 * 1024 * 1024;
const COMPILED_RULE_SET_PUBLISH_GRACE_MS = 5 * 60 * 1000;
const MAX_COMPILED_MANIFEST_CANDIDATES = 8;

export class InvalidRuleSetSourceResponseError extends Error {}

export interface RuleSetSourceCacheEntry {
  key: string;
  fetchedAt: string;
  checkedAt?: string;
  contentHash?: string;
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
  contentHash?: string;
  usedCachedContent: boolean;
  warning?: string | undefined;
  reason?: string | undefined;
}

export interface RuleSetSourceRefreshState extends Omit<RuleSetSourceFetchResult, "content"> {
  contentHash: string;
}

export interface RuleSetSourceCacheRefreshResult {
  refreshed: number;
  failed: number;
  cached: number;
  deleted: number;
  warnings: string[];
  failures: RuleSetSourceCacheFailure[];
  sourcesByKey: Map<string, RuleSetSourceRefreshState>;
  errorsByKey: Map<string, string>;
}

export interface CompiledRuleSetBucketMeta {
  bucket: RuleSetBucket;
  count: number;
  targets: RuleSetOutputTarget[];
  targetCounts?: Partial<Record<RuleSetOutputTarget, number>>;
}

export interface CompiledRuleSetManifest {
  publication?: { confirmedAt: number; commit: string; jobId: string; integration: string; target: import("./types").Target };
  dnsRuleCount?: number;
  provider?: { behavior: RuleSetBucket; interval: number };
  surgeType?: "RULE-SET" | "DOMAIN-SET";
  asnExpiresAt?: number;
  outputName: string;
  outputFingerprint: string;
  policy: string;
  updatedAt: string;
  sourceIds: string[];
  sourceContentHashes?: Record<string, string>;
  ruleCount: number;
  duplicateCount: number;
  buckets: CompiledRuleSetBucketMeta[];
  warnings: string[];
  storageId?: string | undefined;
}

export interface CompiledRuleSetStatusItem {
  direct?: boolean;
  outputName: string;
  enabled: boolean;
  updatedAt: string | null;
  ruleCount: number;
  duplicateCount: number;
  buckets: CompiledRuleSetBucketMeta[];
  artifacts: Array<{ behavior: RuleSetBucket; count: number }>;
  warnings: string[];
  cached: boolean;
}

export async function scopeRuleSetSourceRefresh(result: RuleSetSourceCacheRefreshResult, config: RenderConfig): Promise<RuleSetSourceCacheRefreshResult> {
  const sourcesByKey: RuleSetSourceCacheRefreshResult["sourcesByKey"] = new Map();
  const errorsByKey: RuleSetSourceCacheRefreshResult["errorsByKey"] = new Map();
  const failures: RuleSetSourceCacheFailure[] = [];
  const warnings = result.warnings.filter((message) => !result.failures.some((failure) => message === `${failure.sourceName}: ${failure.reason}`));
  for (const source of compiledRuleSetSources(config.ruleSets, config.renderTarget ?? "surge")) {
    const key = await ruleSetSourceCacheKey(source.url);
    const content = result.sourcesByKey.get(key);
    const error = result.errorsByKey.get(key);
    if (content) sourcesByKey.set(key, content);
    if (error) errorsByKey.set(key, error);
    const reason = error ?? content?.reason ?? content?.warning;
    if (reason) {
      failures.push({ sourceId: source.id, sourceName: source.name, reason, usedCachedContent: Boolean(content?.usedCachedContent) });
      warnings.push(`${source.name}: ${reason}`);
    }
  }
  return { refreshed: [...sourcesByKey.values()].filter((item) => !item.usedCachedContent).length, cached: [...sourcesByKey.values()].filter((item) => item.usedCachedContent).length, failed: failures.length, deleted: 0, warnings, failures, sourcesByKey, errorsByKey };
}

export function allCompiledRuleSetSources(config: RenderConfig): RuleSetSource[] {
  if (!config.document) return compiledRuleSetSources(config.ruleSets, config.renderTarget ?? "surge");
  const sources = Object.entries(config.document.clients).flatMap(([id, client]) => {
    const target = id === "singbox" ? "sing-box" : id === "clash" ? "clash" : "surge";
    const selected = target === (config.renderTarget ?? "surge") ? config.ruleSets : client.ruleSets;
    const plan = { ...selected, aggregateByPolicy: target === "surge" && selected.aggregateByPolicy };
    return plan.mode === "compiled" ? compiledRuleSetSources(plan, target) : [];
  });
  return [...new Map(sources.map((source) => [source.url, source])).values()];
}

export async function fetchCachedRuleSetSource(
  env: Env,
  source: RuleSetSource,
  options: { allowCachedFallback?: boolean; forceRefresh?: boolean; deadline?: number } = {}
): Promise<RuleSetSourceFetchResult> {
  const key = await ruleSetSourceCacheKey(source.url);
  if (!options.forceRefresh) {
    const cached = await readRuleSetSourceContent(env, key);
    if (cached !== null) return { content: cached, contentHash: await sha256Hex(cached), usedCachedContent: false };
  }

  try {
    if (deadlineExceeded(options.deadline)) throw new Error(RULE_SET_REFRESH_DEADLINE_REASON);
    const content = await fetchRuleSetSourceContent(source.url, options.deadline);
    const contentHash = await sha256Hex(content);
    let warning: string | undefined;
    try {
      await writeRuleSetSourceCacheEntry(env, {
        key,
        content,
        contentHash,
        fetchedAt: new Date().toISOString(),
        sourceId: source.id,
        sourceName: source.name
      });
    } catch (error) {
      warning = `${source.name}: 规则来源缓存写入失败：${error instanceof Error ? error.message : String(error)}`;
      console.warn(JSON.stringify({ level: "warn", message: warning }));
    }
    return { content, contentHash, usedCachedContent: false, ...(warning ? { warning } : {}) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const cached = options.allowCachedFallback ? await readRuleSetSourceContent(env, key) : null;
    if (options.allowCachedFallback && cached !== null) {
      return {
        content: cached,
        contentHash: await sha256Hex(cached),
        usedCachedContent: true,
        warning: `${source.name}: ${reason}`
      };
    }
    throw new Error(`${source.name}: ${reason}`, { cause: error });
  }
}

async function readRuleSetSourceContent(env: Env, key: string): Promise<string | null> {
  const stored = await env.SUBPILOT_CONFIG.get(key);
  if (stored === null) return null;
  try { return await readEncryptedCacheContent(env, stored); }
  catch { return null; }
}

/** Load one source at a time; refresh summaries never retain response bodies. */
export async function readRefreshedRuleSetSource(env: Env, key: string, state: RuleSetSourceRefreshState): Promise<RuleSetSourceFetchResult> {
  const content = await readRuleSetSourceContent(env, key);
  if (content === null || await sha256Hex(content) !== state.contentHash) {
    throw new Error("规则来源缓存尚未同步或已被更新，请稍后重试。");
  }
  return { content, contentHash: state.contentHash, usedCachedContent: state.usedCachedContent, ...(state.warning ? { warning: state.warning } : {}) };
}

export async function refreshRuleSetSourceCaches(
  env: Env,
  config: RenderConfig,
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
      sourcesByKey: new Map(),
      errorsByKey: new Map(await Promise.all(sourcesToRefresh.filter((source) => source.enabled && source.url).map(async (source) => [await ruleSetSourceCacheKey(source.url), reason] as const)))
    };
  }
  const warnings: string[] = [];
  const failures: RuleSetSourceCacheFailure[] = [];
  const sourcesByKey = new Map<string, RuleSetSourceRefreshState>();
  const errorsByKey = new Map<string, string>();
  let refreshed = 0;
  let cached = 0;

  for (const source of new Map(sourcesToRefresh.filter((source) => source.enabled && source.url).map((source) => [source.url, source])).values()) {
    if (!source.enabled || !source.url) continue;
    const key = await ruleSetSourceCacheKey(source.url);
    if (deadlineExceeded(options.deadline)) {
      const reason = RULE_SET_REFRESH_DEADLINE_REASON;
      errorsByKey.set(key, reason);
      failures.push({ sourceId: source.id, sourceName: source.name, reason, usedCachedContent: false });
      warnings.push(`${source.name}: ${reason}`);
      continue;
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
      });
      sourcesByKey.set(key, { contentHash: entry.contentHash, usedCachedContent: false });
      refreshed += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const cachedContent = await readRuleSetSourceContent(env, key);
      let usedCachedContent = false;
      if (cachedContent !== null) {
        sourcesByKey.set(key, {
          contentHash: await sha256Hex(cachedContent),
          usedCachedContent: true,
          reason,
          warning: `${source.name}: ${reason}`
        });
        cached += 1;
        usedCachedContent = true;
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
    ? await pruneRuleSetSourceCaches(env, config)
    : 0;
  if (options.pruneUnexpected && deadlineExceeded(options.deadline)) {
    warnings.push("规则集刷新已到截止时间，跳过过期来源缓存清理。");
  }
  return {
    refreshed,
    failed: failures.length,
    cached,
    deleted,
    warnings,
    failures,
    sourcesByKey,
    errorsByKey
  };
}

export async function pruneRuleSetSourceCaches(env: Env, config: RenderConfig): Promise<number> {
  const sourceEntries = await readRuleSetSourceCacheEntries(env);
  const expectedKeys = await ruleSetSourceCacheKeysForEnabledSources(config);
  return pruneUnexpectedRuleSetSourceCacheEntries(env, sourceEntries, expectedKeys);
}

export async function pruneCompiledRuleSetCaches(env: Env, config: RenderConfig): Promise<number> {
  const outputNames = config.ruleSets.mode === "compiled" ? effectiveRuleSetOutputs(config.ruleSets)
    .filter((output) => ruleSetOutputNeedsCompilation(config.ruleSets, output, config.renderTarget ?? "surge"))
    .map((output) => output.name) : [];
  const deleted = await pruneUnexpectedCompiledRuleSets(env, new Set(outputNames));
  for (const outputName of outputNames) {
    await pruneOldCompiledRuleSetVersions(env, outputName).catch(logCompiledCacheCleanupFailure);
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

  // A publication remains usable if its head index write failed. Inspect only
  // a complete bounded metadata page so an oldest-first listing cannot select
  // a stale version while newer metadata is outside the page.
  const metadataPage = await listKvKeyPage(
    env,
    compiledRuleSetVersionMetaPrefix(outputName),
    MAX_COMPILED_MANIFEST_CANDIDATES
  );
  if (metadataPage.complete) {
    for (const versionKey of metadataPage.keys.sort().reverse()) {
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
  return null;
}

export async function readCompiledRuleSetBucket(
  env: Env,
  outputName: string,
  bucket: RuleSetDownloadBucket,
  target: RuleSetOutputTarget,
  manifest?: CompiledRuleSetManifest
): Promise<string | null> {
  const selectedManifest = manifest ?? await readCompiledRuleSetManifest(env, outputName);
  if (!selectedManifest?.storageId) return null;
  const key = compiledRuleSetContentKey(outputName, bucket, target, selectedManifest.storageId);
  const stored = await env.SUBPILOT_CONFIG.get(key);
  if (stored === null) return null;
  try {
    return await readEncryptedCacheContent(env, stored);
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
  buckets: Record<RuleSetBucket, CompiledRuleSetRule[]>,
  options: { canPublish?: () => Promise<boolean> } = {}
): Promise<void> {
  const storageId = compiledRuleSetStorageId();
  manifest.storageId = storageId;
  const writtenKeys = new Set<string>();
  const writeContent = async (key: string, content: string): Promise<void> => {
    writtenKeys.add(key);
    await writeEncryptedCompiledContent(env, key, content);
  };
  try {
    for (const target of RULE_SET_TARGETS) {
      for (const artifact of planRuleSetArtifacts(manifest.buckets, target, manifest.provider?.behavior, manifest.surgeType)) {
        const key = compiledRuleSetContentKey(manifest.outputName, artifact.bucket, target, storageId);
        const content = artifact.bucket === "combined"
          ? renderCombinedRuleSet(buckets, target, artifact)
          : renderCompiledRuleSetBucket(buckets[artifact.bucket], artifact.bucket, target);
        await writeContent(key, content);
      }
    }
    if (manifest.dnsRuleCount !== undefined) {
      const dnsRules = [...buckets.domain, ...buckets.classical].filter((rule) =>
        ["DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "DOMAIN-REGEX", "DOMAIN-WILDCARD"].includes(rule.type)
        && renderRuleSetRuleForTarget(rule.raw, "sing-box") !== null);
      manifest.dnsRuleCount = dnsRules.length;
      if (dnsRules.length) await writeContent(
        compiledRuleSetContentKey(manifest.outputName, "dns", "sing-box", storageId), renderSingboxRules(dnsRules));
    }
    // Publish the manifest only after every artifact. Track exact keys so a
    // failed write can be cleaned even before KV listing sees the new objects.
    if (options.canPublish && !await options.canPublish()) {
      throw new Error("Rule-set configuration changed before cache publication.");
    }
    const metaKey = compiledRuleSetVersionMetaKey(manifest.outputName, storageId);
    writtenKeys.add(metaKey);
    await env.SUBPILOT_CONFIG.put(metaKey, JSON.stringify(manifest));
    const headKey = compiledRuleSetVersionHeadKey(manifest.outputName, storageId);
    writtenKeys.add(headKey);
    // The manifest already committed this complete version. A failed index
    // write must not remove it; readers can discover the version metadata.
    await env.SUBPILOT_CONFIG.put(headKey, storageId).catch(() => {
      console.warn(JSON.stringify({ level: "warn", message: "编译缓存索引更新失败，将使用独立版本元数据。" }));
    });
  } catch (error) {
    await deleteKvKeys(env, [...writtenKeys]).catch(logCompiledCacheCleanupFailure);
    throw error;
  }
  // A later configuration can commit while publication is in flight. Preserve
  // its artifacts; the caller reconciles any completed obsolete publication.
  if (options.canPublish && !await options.canPublish()) return;
  await pruneOldCompiledRuleSetVersions(env, manifest.outputName, storageId).catch(logCompiledCacheCleanupFailure);
}

function logCompiledCacheCleanupFailure(): void {
  console.warn(JSON.stringify({ level: "warn", message: "旧编译缓存清理失败，将在下次保存或刷新时重试。" }));
}

export async function deleteCompiledRuleSet(env: Env, outputName: string): Promise<void> {
  const [metaKeys, contentKeys] = await Promise.all([
    listKvKeys(env, compiledRuleSetMetaOutputPrefix(outputName)),
    listKvKeys(env, compiledRuleSetContentOutputPrefix(outputName))
  ]);
  const keys = [...new Set([
    ...metaKeys,
    ...contentKeys
  ])];
  await deleteKvKeys(env, keys);
}

export function compiledRuleSetContentKey(
  outputName: string,
  bucket: RuleSetDownloadBucket,
  target: RuleSetOutputTarget,
  storageId: string
): string {
  return `${compiledRuleSetContentOutputPrefix(outputName)}${storageId}:${bucket}:${target}`;
}

function compiledRuleSetMetaOutputPrefix(outputName: string): string {
  return `${COMPILED_RULE_SET_META_PREFIX}${encodeURIComponent(outputName)}:`;
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
  const sortedKeys = (await listKvKeys(env, metaPrefix)).sort();
  // Publish immutable artifacts before switching readers, then keep only the
  // newest successful version. They are not a cache history or rollback store.
  const newestKey = [...sortedKeys, ...(currentStorageId ? [compiledRuleSetVersionMetaKey(outputName, currentStorageId)] : [])].sort().at(-1);
  const staleMetaKeys = sortedKeys.filter((key) => key !== newestKey);
  for (const metaKey of staleMetaKeys) {
    await deleteCompiledRuleSetVersion(env, outputName, metaKey);
  }
  await pruneOrphanCompiledRuleSetContents(env, outputName, currentStorageId, now);
}

async function deleteCompiledRuleSetVersion(env: Env, outputName: string, metaKey: string): Promise<void> {
  const storageId = metaKey.slice(compiledRuleSetVersionMetaPrefix(outputName).length);
  const contentPrefix = `${compiledRuleSetContentOutputPrefix(outputName)}${storageId}:`;
  await deleteKvKeys(env, await listKvKeys(env, contentPrefix));
  // Delete the publication marker only after every content page is removed.
  await deleteKvKeys(env, [compiledRuleSetVersionHeadKey(outputName, storageId), metaKey]);
}

async function pruneOrphanCompiledRuleSetContents(
  env: Env,
  outputName: string,
  currentStorageId: string | undefined,
  now: number
): Promise<void> {
  const contentPrefix = compiledRuleSetContentOutputPrefix(outputName);
  const keys = await listKvKeys(env, contentPrefix);
  const candidates = [...new Set(keys.flatMap((key) => {
    const storageId = compiledStorageIdFromContentKey(key, outputName);
    return storageId
      && storageId !== currentStorageId
      && compiledStorageIdIsOldEnough(storageId, now)
      ? [storageId]
      : [];
  }))];
  for (const storageId of candidates) {
    if (await env.SUBPILOT_CONFIG.get(compiledRuleSetVersionMetaKey(outputName, storageId)) !== null) continue;
    const orphanPrefix = `${contentPrefix}${storageId}:`;
    await deleteKvKeys(env, keys.filter((key) => key.startsWith(orphanPrefix)));
  }
}

async function compiledManifestContentIsVisible(env: Env, manifest: CompiledRuleSetManifest): Promise<boolean> {
  if (!manifest.storageId) return false;
  const keys = compiledManifestContentKeys(manifest);
  for (const key of keys) {
    const stream = await env.SUBPILOT_CONFIG.get(key, "stream");
    if (stream === null) return false;
    await stream.cancel();
  }
  return true;
}

function compiledManifestContentKeys(manifest: CompiledRuleSetManifest): string[] {
  if (!manifest.storageId) return [];
  const keys = new Set<string>();
  for (const target of RULE_SET_TARGETS) {
    for (const artifact of planRuleSetArtifacts(manifest.buckets, target, manifest.provider?.behavior, manifest.surgeType)) {
      keys.add(compiledRuleSetContentKey(manifest.outputName, artifact.bucket, target, manifest.storageId));
    }
  }
  if (manifest.dnsRuleCount) keys.add(compiledRuleSetContentKey(manifest.outputName, "dns", "sing-box", manifest.storageId));
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

function compiledStorageIdFromContentKey(key: string, outputName: string): string | null {
  const prefix = compiledRuleSetContentOutputPrefix(outputName);
  if (!key.startsWith(prefix)) return null;
  const storageId = key.slice(prefix.length).split(":", 1)[0] ?? "";
  return compiledStorageIdTimestamp(storageId) === null ? null : storageId;
}

function compiledStorageIdIsOldEnough(storageId: string, now: number): boolean {
  const timestamp = compiledStorageIdTimestamp(storageId);
  return timestamp !== null && timestamp <= now - COMPILED_RULE_SET_PUBLISH_GRACE_MS;
}

function compiledStorageIdTimestamp(storageId: string): number | null {
  const match = storageId.match(/^(\d{16})-[A-Za-z0-9_-]+$/);
  if (!match) return null;
  const timestamp = Number(match[1]);
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
}

export async function ruleSetSourceCacheKey(url: string): Promise<string> {
  return `${RULE_SET_SOURCE_CACHE_PREFIX}${await sha256Hex(url)}`;
}

/** Read only metadata; checking refresh eligibility must not load source bodies. */
export async function readRuleSetSourceCacheMetadata(env: Env, key: string): Promise<RuleSetSourceCacheEntry | null> {
  return normalizeRuleSetSourceCacheEntry(await readKvJson<unknown>(env, ruleSetSourceCacheMetaKey(key)))
    .find((entry) => entry.key === key) ?? null;
}

async function writeRuleSetSourceCacheEntry(
  env: Env,
  entry: Omit<RuleSetSourceCacheEntry, "contentAvailable"> & { content: string }
): Promise<RuleSetSourceCacheEntry & { contentHash: string; checkedAt: string }> {
  const { content, ...baseMeta } = entry;
  const [contentHash, stored, previous] = await Promise.all([
    entry.contentHash ?? sha256Hex(content),
    env.SUBPILOT_CONFIG.get(entry.key),
    readRuleSetSourceCacheMetadata(env, entry.key)
  ]);
  let unchanged = false;
  if (stored !== null) {
    try {
      const cached = await readEncryptedCacheContent(env, stored);
      unchanged = await sha256Hex(cached) === contentHash;
    } catch { /* Missing or unreadable content must be repaired even if metadata hashes match. */ }
  }
  const meta = {
    ...baseMeta,
    fetchedAt: unchanged ? previous?.fetchedAt ?? UNKNOWN_RULE_SET_SOURCE_FETCHED_AT : entry.fetchedAt,
    checkedAt: entry.checkedAt ?? entry.fetchedAt,
    contentHash,
    contentAvailable: true
  };
  // Unchanged encrypted bodies keep their original value; unreadable bodies rebuild.
  if (!unchanged) {
    await env.SUBPILOT_CONFIG.put(entry.key, await encryptCacheContent(env, content));
  }
  // Publish the hash/check time only after its corresponding body was stored.
  await env.SUBPILOT_CONFIG.put(ruleSetSourceCacheMetaKey(entry.key), JSON.stringify(meta));
  return meta;
}

async function readEncryptedCacheContent(env: Env, stored: string): Promise<string> {
  if (!stored.startsWith(ENCRYPTED_CACHE_STORAGE_PREFIX)) throw new Error("Unsupported rule-set cache format");
  return decryptText(
    requireSecret(env, "CONFIG_ENCRYPTION_KEY"),
    stored.slice(ENCRYPTED_CACHE_STORAGE_PREFIX.length)
  );
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
          const content = await readResponseTextWithLimit(response, MAX_RULE_SET_SOURCE_CONTENT_BYTES, "规则来源");
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
  const metaKeys = (await listKvKeys(env, RULE_SET_SOURCE_CACHE_META_PREFIX))
    .filter((key) => /^[a-f0-9]{64}$/.test(key.slice(RULE_SET_SOURCE_CACHE_META_PREFIX.length)));
  const entries = await Promise.all(metaKeys.map((key) => readKvJson<unknown>(env, key)));
  return entries.flatMap(normalizeRuleSetSourceCacheEntry);
}

async function ruleSetSourceCacheKeysForEnabledSources(config: RenderConfig): Promise<Set<string>> {
  const expectedKeys = new Set<string>();
  for (const source of allCompiledRuleSetSources(config)) {
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
  await deleteKvKeys(env, [...staleCacheKeys].flatMap((key) => [key, ruleSetSourceCacheMetaKey(key)]));
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
  const selected = [...staleOutputNames].sort();
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

function normalizeRuleSetSourceCacheEntry(value: unknown): RuleSetSourceCacheEntry[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const entry = value as Partial<RuleSetSourceCacheEntry>;
  if (typeof entry.key !== "string" || !entry.key.startsWith(RULE_SET_SOURCE_CACHE_PREFIX)) return [];
  if (typeof entry.fetchedAt !== "string" || Number.isNaN(new Date(entry.fetchedAt).getTime())) return [];
  if (typeof entry.checkedAt !== "string" || !Number.isFinite(Date.parse(entry.checkedAt))
    || typeof entry.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(entry.contentHash)
    || typeof entry.sourceId !== "string" || typeof entry.sourceName !== "string" || typeof entry.contentAvailable !== "boolean") return [];
  return [{
    key: entry.key,
    fetchedAt: entry.fetchedAt,
    checkedAt: entry.checkedAt,
    contentHash: entry.contentHash,
    sourceId: entry.sourceId,
    sourceName: entry.sourceName,
    contentAvailable: entry.contentAvailable
  }];
}

function normalizeCompiledManifest(value: unknown): CompiledRuleSetManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<CompiledRuleSetManifest>;
  if (typeof record.outputName !== "string" || typeof record.storageId !== "string" || compiledStorageIdTimestamp(record.storageId) === null) return null;
  if (typeof record.outputFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(record.outputFingerprint)
    || typeof record.policy !== "string" || typeof record.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt))
    || !Array.isArray(record.sourceIds) || record.sourceIds.some((item) => typeof item !== "string")
    || !record.sourceContentHashes || typeof record.sourceContentHashes !== "object" || Array.isArray(record.sourceContentHashes)
    || typeof record.ruleCount !== "number" || !Number.isSafeInteger(record.ruleCount) || record.ruleCount < 0
    || typeof record.duplicateCount !== "number" || !Number.isSafeInteger(record.duplicateCount) || record.duplicateCount < 0
    || !Array.isArray(record.buckets) || !Array.isArray(record.warnings) || record.warnings.some((item) => typeof item !== "string")) return null;
  const buckets = record.buckets.flatMap(normalizeBucketMeta);
  if (buckets.length !== record.buckets.length) return null;
  return {
    outputName: record.outputName,
    outputFingerprint: record.outputFingerprint,
    policy: record.policy,
    updatedAt: record.updatedAt,
    sourceIds: record.sourceIds,
    sourceContentHashes: Object.fromEntries(Object.entries(record.sourceContentHashes).filter(([key, hash]) =>
      key.startsWith(RULE_SET_SOURCE_CACHE_PREFIX) && /^[a-f0-9]{64}$/.test(key.slice(RULE_SET_SOURCE_CACHE_PREFIX.length))
      && typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))),
    ruleCount: record.ruleCount,
    ...(typeof record.dnsRuleCount === "number" ? { dnsRuleCount: record.dnsRuleCount } : {}),
    duplicateCount: record.duplicateCount,
    ...(record.provider && RULE_SET_BUCKETS.includes(record.provider.behavior) && Number.isSafeInteger(record.provider.interval) && record.provider.interval > 0 ? { provider: record.provider } : {}),
    ...(["RULE-SET", "DOMAIN-SET"].includes(record.surgeType ?? "") ? { surgeType: record.surgeType } : {}),
    ...(typeof record.asnExpiresAt === "number" && Number.isFinite(record.asnExpiresAt) ? { asnExpiresAt: record.asnExpiresAt } : {}),
    buckets,
    warnings: record.warnings,
    storageId: record.storageId
  };
}

function normalizeBucketMeta(value: unknown): CompiledRuleSetBucketMeta[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Partial<CompiledRuleSetBucketMeta>;
  if (!record.bucket || !RULE_SET_BUCKETS.includes(record.bucket)) return [];
  if (typeof record.count !== "number" || !Number.isSafeInteger(record.count) || record.count < 0
    || !Array.isArray(record.targets) || record.targets.some((target) => !RULE_SET_TARGETS.includes(target))
    || !record.targetCounts || typeof record.targetCounts !== "object" || Array.isArray(record.targetCounts)) return [];
  return [{
    bucket: record.bucket,
    count: record.count,
    targets: record.targets,
    targetCounts: Object.fromEntries(RULE_SET_TARGETS.flatMap((target) => {
      const count = record.targetCounts?.[target];
      return typeof count === "number" && count >= 0 ? [[target, count]] : [];
    }))
  }];
}
