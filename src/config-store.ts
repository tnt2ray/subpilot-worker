import { configDocument, defaultConfigDocument, migrateConfigDocument, normalizeConfigDocument, renderConfig, OUTPUT_TARGETS } from "./config-document";
import { ruleSetEnv } from "./rule-set-scope";
import { queueChangedRuleSetUpdates, runRuleSetUpdateJobs } from "./rule-set-jobs";
import type { AppConfig, StoredConfigDocument } from "./types";
import { DEFAULT_CONFIG } from "./default-config";
import { CONFIG_SCHEMA_VERSION_KEY, CURRENT_KV_SCHEMA_VERSION } from "./config-schema";
import { normalizeChain, normalizeClash, normalizeConfig, normalizeRuleSets, normalizeStash, normalizeSurge } from "./config-normalize";
import { decryptJson, decryptText, encryptJson, unsealSources } from "./crypto-store";
import { listKvKeys } from "./kv-helpers";
import { pruneRuleSetCaches, pruneCompiledRuleSetCaches } from "./rule-set-cache";
import type { RuleSetConfig, RuleSetDirectRule, RuleSetOutput, RuleSetSource } from "./rule-set-types";
import { getSecret, requireSecret } from "./secrets";
import { pruneSourceCache } from "./source-cache";
import type { RenderConfig, SourceConfig, StaticProxyNodeConfig } from "./types";
import { base64Url, mapWithConcurrency, randomToken, sha256Hex } from "./util";

export { inferManagedBaseUrl, normalizeConfig, normalizeTarget, withInferredManagedBaseUrl } from "./config-normalize";
export { validateManagedBaseUrl, validateProxyPolicyNameConflicts } from "./config-validation";

const CONFIG_UPDATED_AT_KEY = "config:updatedAt";
export const CONFIG_SNAPSHOT_KEY = "config:snapshot";
export const CONFIG_SNAPSHOT_VERSION_PREFIX = "config:snapshot:version:";
export const CONFIG_MIGRATED_SNAPSHOT_KEY = "config:snapshot:migrated";
export const CONFIG_MIGRATED_SNAPSHOT_PREFIX = `${CONFIG_MIGRATED_SNAPSHOT_KEY}:`;
const CONFIG_SNAPSHOT_CLEANUP_PENDING_KEY = "config:snapshot:legacyCleanupPending";
const CONFIG_SNAPSHOT_CLEANUP_PENDING_PREFIX = `${CONFIG_SNAPSHOT_CLEANUP_PENDING_KEY}:`;
const CONFIG_SNAPSHOT_CLEANUP_COMPLETE_PREFIX = `config:snapshot:legacyCleanupComplete:${CURRENT_KV_SCHEMA_VERSION}:`;
const CONFIG_SNAPSHOT_CLEANUP_COMPLETE_BASE_PREFIX = "config:snapshot:legacyCleanupComplete:";
const CONFIG_SNAPSHOT_VERSION = 2;
const DOCUMENT_MIGRATION_COMMITTED = "config:documentMigration:committed";
const CONFIG_SNAPSHOT_CLEANUP_GRACE_MS = 5 * 60 * 1000;
const CONFIG_SNAPSHOT_CLEANUP_BATCH_SIZE = 200;
const CONFIG_SNAPSHOT_RETAINED_VALID_VERSIONS = 3;
const CONFIG_SNAPSHOT_VERSION_PRUNE_BATCH_SIZE = 20;
const CONFIG_SNAPSHOT_VERSION_LIST_LIMIT = 64;
const CONFIG_SNAPSHOT_LOGICAL_TIME_MAX = Number.MAX_SAFE_INTEGER;
export const READ_TOKEN_RECORD_KEY = "auth:read_token_record";
export const READ_TOKEN_MIGRATED_RECORD_KEY = "auth:read_token_record:migrated";
export const READ_TOKEN_INITIAL_RECORD_PREFIX = "auth:read_token_initial:";
export const READ_TOKEN_MIGRATION_RECORD_PREFIX = "auth:read_token_migration:";
export const READ_TOKEN_ROTATION_PREFIX = "auth:read_token_rotation:";
const READ_TOKEN_RECORD_VERSION = 1;
const READ_TOKEN_CLEANUP_PENDING_KEY = "auth:read_token_cleanup_pending";
const READ_TOKEN_CLEANUP_PENDING_PREFIX = `${READ_TOKEN_CLEANUP_PENDING_KEY}:`;
const READ_TOKEN_CLEANUP_COMPLETE_PREFIX = `auth:read_token_cleanup_complete:${READ_TOKEN_RECORD_VERSION}:`;
const READ_TOKEN_CLEANUP_GRACE_MS = 5 * 60 * 1000;
const LEGACY_READ_TOKEN_HASH_KEY = "auth:read_token_hash";
const LEGACY_READ_TOKEN_KEY = "auth:read_token";
const SETTINGS_PREFIX = "config:settings:";
const TELEGRAM_BOT_TOKEN_KEY = `${SETTINGS_PREFIX}notificationTelegramBotToken`;
const TELEGRAM_WEBHOOK_SECRET_KEY = `${SETTINGS_PREFIX}notificationTelegramWebhookSecret`;
const GROUP_INDEX_KEY = "config:groups:index";
const GROUP_DISABLED_KEY = "config:groups:disabled";
const GROUP_PREFIX = "config:groups:";
const SOURCE_INDEX_KEY = "config:sources:index";
const SOURCE_PREFIX = "config:sources:";
const PROXY_NODE_INDEX_KEY = "config:proxyNodes:index";
const PROXY_NODE_PREFIX = "config:proxyNodes:";
const RULE_SET_MODE_KEY = "config:ruleSets:mode";
const RULE_SET_AGGREGATE_BY_POLICY_KEY = "config:ruleSets:aggregateByPolicy";
const RULE_SET_SOURCE_INDEX_KEY = "config:ruleSetSources:index";
const RULE_SET_SOURCE_PREFIX = "config:ruleSetSources:";
const RULE_SET_OUTPUT_INDEX_KEY = "config:ruleSetOutputs:index";
const RULE_SET_OUTPUT_PREFIX = "config:ruleSetOutputs:";
const RULE_SET_DIRECT_RULE_INDEX_KEY = "config:ruleSetDirectRules:index";
const RULE_SET_DIRECT_RULE_PREFIX = "config:ruleSetDirectRules:";
const SURGE_PREFIX = "config:surge:";
const CLASH_PREFIX = "config:clash:";
const STASH_PREFIX = "config:stash:";

interface ConfigSnapshot {
  version: typeof CONFIG_SNAPSHOT_VERSION;
  config: AppConfig;
}

interface ConfigSnapshotRevision {
  key: string;
  logicalTime: number;
}

interface StoredConfigSnapshotResult {
  config: RenderConfig | null;
  found: boolean;
  key: string | null;
}

export interface PreparedConfigSave {
  readonly config: RenderConfig;
  readonly snapshotKey: string;
  readonly logicalTime: number;
}

// These process-wide scalars are an ID allocator, not request-scoped data or an
// I/O promise. Saves issued by one isolate are ordered monotonically even if
// the wall clock moves backwards. Across isolates, equal time/sequence values
// use the nonce only as a deterministic conflict tie-breaker.
let lastConfigSnapshotWallTime = -1;
let configSnapshotWallTimeSequence = 0;

interface ReadTokenRecord {
  version: typeof READ_TOKEN_RECORD_VERSION;
  token: string;
  hash: string;
  rotatedAt?: number;
  legacyCleanupRequired?: boolean;
}

const SETTING_KEYS = [
  "managedBaseUrl",
  "userAgentSurge",
  "userAgentClash",
  "userAgentStash",
  "userAgentShadowrocket",
  "excludeKeywords",
  "geoipRenameEnabled",
  "featureTagRules",
  "updateCheckEnabled",
  "displayTimeZone",
  "notificationChannel",
  "notificationTelegramChatId"
] as const satisfies readonly (keyof RenderConfig["settings"])[];

const SURGE_KEYS = [
  "skipProxy",
  "dnsServer",
  "alwaysRealIp",
  "managedConfigIntervalSeconds",
  "internetTestUrl",
  "proxyTestUrl",
  "showErrorPageForReject",
  "ipv6",
  "ipv6Vif",
  "allowWifiAccess",
  "tunExcludedRoutes",
  "encryptedDnsServer",
  "wifiAssist",
  "excludeSimpleHostnames",
  "encryptedDnsFollowOutboundMode",
  "tailscaleNodes",
  "hosts",
  "urlRewrite",
  "mapLocal",
  "scripts",
  "mitm",
  "rules",
] as const satisfies readonly (keyof RenderConfig["surge"])[];

const CLASH_KEYS = [
  "port",
  "socksPort",
  "mixedPort",
  "allowLan",
  "mode",
  "logLevel",
  "ipv6",
  "unifiedDelay",
  "tcpConcurrent",
  "externalController",
  "tun",
  "dnsEnabled",
  "dnsListen",
  "dnsIpv6",
  "dnsEnhancedMode",
  "dnsFakeIpRange",
  "defaultNameservers",
  "nameservers",
  "fallbackNameservers",
  "fallbackFilterGeoip",
  "fallbackFilterIpcidr",
  "fakeIpFilter",
  "ruleProviders",
  "rules"
] as const satisfies readonly (keyof RenderConfig["clash"])[];

const STASH_KEYS = [
  "port",
  "socksPort",
  "mixedPort",
  "allowLan",
  "mode",
  "logLevel",
  "ipv6",
  "unifiedDelay",
  "tcpConcurrent",
  "externalController",
  "tun",
  "dns",
  "ruleProviders",
  "rules",
  "hosts",
  "urlRewrite",
  "scripts",
  "mitm"
] as const satisfies readonly (keyof RenderConfig["stash"])[];

export async function loadConfig(env: Env): Promise<RenderConfig> {
  return loadConfigUnlocked(env);
}

async function loadConfigUnlocked(env: Env): Promise<RenderConfig> {
  const stored = await readStoredConfigSnapshot(env);
  if (stored.config) {
    if (!stored.config.migrationRequired) {
      await markDocumentCommitted(env);
      await maintainConfigCleanup(env).catch(logConfigHousekeepingFailure);
    }
    return stored.config;
  }

  const remainingLegacyKeys = await legacyConfigKeys(env);
  if (stored.found && (remainingLegacyKeys.length === 0 || await env.SUBPILOT_CONFIG.get(DOCUMENT_MIGRATION_COMMITTED) !== null)) {
    throw new Error("No valid encrypted config snapshot is available");
  }
  if (!stored.found && remainingLegacyKeys.length === 0) return renderConfig(defaultConfigDocument());
  const legacy = await loadLegacyStoredConfig(env);
  const config = await canonicalizeConfigSources(env, legacy);
  const concurrent = await readStoredConfigSnapshot(env);
  if (concurrent.config) {
    await maintainConfigCleanup(env).catch(logConfigHousekeepingFailure);
    return concurrent.config;
  }
  return { ...renderConfig(migrateConfigDocument(config)), migrationRequired: true };
}

export async function saveConfig(env: Env, config: RenderConfig): Promise<RenderConfig> {
  return commitPreparedConfigSave(env, await prepareConfigSave(env, config));
}

export async function prepareConfigSave(env: Env, config: RenderConfig): Promise<PreparedConfigSave> {
  if (config.migrationRequired) throw new Error("请先导出旧配置并完成迁移。");
  // Fail before callers perform any related external side effect.
  requireSecret(env, "CONFIG_ENCRYPTION_KEY");
  const revision = nextConfigSnapshotRevision();
  return {
    config: await canonicalizeConfigSources(env, normalizeConfig({
      ...config,
      updatedAt: new Date(revision.logicalTime).toISOString()
    })),
    snapshotKey: revision.key,
    logicalTime: revision.logicalTime
  };
}

export async function commitPreparedConfigSave(env: Env, prepared: PreparedConfigSave, context?: Pick<ExecutionContext, "waitUntil">): Promise<RenderConfig> {
  const jobs = await queueChangedRuleSetUpdates(env, await loadConfig(env), prepared.config);
  await writeConfigSnapshot(env, prepared.config, prepared.snapshotKey);
  const verified = await env.SUBPILOT_CONFIG.get(prepared.snapshotKey);
  if (!verified || !(await tryDecryptConfigSnapshot(env, verified))) throw new Error("新配置写入校验失败，请重试。");
  await markDocumentCommitted(env);
  if (context && jobs.length) {
    context.waitUntil(runRuleSetUpdateJobs(env, prepared.config, {
      jobs, deadline: Date.now() + 25_000, loadCurrentConfig: () => loadConfig(env)
    }).catch(() => {
      console.warn(JSON.stringify({ level: "warn", message: "Saved rule-set updates remain queued for scheduled processing." }));
    }));
  }
  const cleanup = finishCommittedConfigSave(env, prepared);
  if (context) context.waitUntil(cleanup);
  else await cleanup;
  return prepared.config;
}

export async function recoverCommittedPreparedConfigSave(
  env: Env,
  prepared: PreparedConfigSave
): Promise<RenderConfig | null> {
  const stored = await env.SUBPILOT_CONFIG.get(prepared.snapshotKey);
  if (stored === null) return null;
  const config = await tryDecryptConfigSnapshot(env, stored);
  if (!config || JSON.stringify(configDocument(config)) !== JSON.stringify(configDocument(prepared.config))) return null;
  await markDocumentCommitted(env);
  await finishCommittedConfigSave(env, prepared);
  return config;
}

async function finishCommittedConfigSave(env: Env, prepared: PreparedConfigSave): Promise<void> {
  const document = configDocument(prepared.config);
  const results = await Promise.allSettled([
    pruneSourceCache(env, prepared.config),
    pruneRuleSetCaches(env, prepared.config),
    ...OUTPUT_TARGETS.map((target) => pruneCompiledRuleSetCaches(ruleSetEnv(env, target), renderConfig(document, target))),
    pruneConfigSnapshotVersions(env, {
      key: prepared.snapshotKey,
      logicalTime: prepared.logicalTime
    })
  ]);
  for (const result of results) {
    if (result.status === "rejected") logConfigHousekeepingFailure(result.reason);
  }
  await maintainConfigCleanup(env).catch(logConfigHousekeepingFailure);
}

export async function readStoredReadTokenHash(env: Env): Promise<string | null> {
  const state = await readTokenState(env);
  return state.record?.hash ?? state.legacyHash;
}

export async function readStoredReadToken(env: Env): Promise<string | null> {
  return (await readTokenState(env)).record?.token ?? null;
}

export async function storeReadToken(env: Env, token: string): Promise<void> {
  const record = await createReadTokenRecord(token);
  await writeReadTokenRecord(env, record);
  await maintainReadTokenCleanup(env, false).catch(logConfigHousekeepingFailure);
}

export async function storeInitialReadToken(env: Env, token: string): Promise<string> {
  const state = await readTokenState(env);
  if (state.record) return state.record.token;
  const legacyCleanupRequired = state.legacyHash !== null;
  const record = await createReadTokenRecord(token, { legacyCleanupRequired });
  await writeReadTokenRecord(
    env,
    record,
    appendOnlyReadTokenKey(legacyCleanupRequired ? READ_TOKEN_MIGRATION_RECORD_PREFIX : READ_TOKEN_INITIAL_RECORD_PREFIX)
  );
  await maintainReadTokenCleanup(env, legacyCleanupRequired).catch(logConfigHousekeepingFailure);
  return token;
}

export async function rotateStoredReadToken(env: Env): Promise<string> {
  const now = Date.now();
  const latestKey = (await listKvKeys(env, READ_TOKEN_ROTATION_PREFIX)).sort().at(-1);
  const previousTime = latestKey ? Number(latestKey.slice(READ_TOKEN_ROTATION_PREFIX.length).split(":", 1)[0]) : 0;
  const rotationTime = Math.max(now, Number.isSafeInteger(previousTime) ? previousTime + 1 : 0);
  const token = randomToken(32);
  const legacyCleanupRequired = await legacyReadTokenKeysExist(env).catch(() => true);
  await writeReadTokenRecord(
    env,
    await createReadTokenRecord(token, { rotatedAt: now, legacyCleanupRequired }),
    readTokenRotationKey(rotationTime)
  );
  await maintainReadTokenCleanup(env, legacyCleanupRequired).catch(logConfigHousekeepingFailure);
  return token;
}

export async function deterministicInitialReadToken(env: Env): Promise<string> {
  return deriveReadToken(env, "subpilot:initial-read-token:v1");
}

async function writeConfigSnapshot(env: Env, config: RenderConfig, key = CONFIG_SNAPSHOT_KEY): Promise<void> {
  const snapshot: ConfigSnapshot = { version: CONFIG_SNAPSHOT_VERSION, config: configDocument(config) };
  const encrypted = await encryptJson(requireSecret(env, "CONFIG_ENCRYPTION_KEY"), snapshot);
  await env.SUBPILOT_CONFIG.put(key, encrypted);
}

async function readStoredConfigSnapshot(env: Env): Promise<StoredConfigSnapshotResult> {
  const allowLegacy = await env.SUBPILOT_CONFIG.get(DOCUMENT_MIGRATION_COMMITTED) === null;
  const versionedPage = await env.SUBPILOT_CONFIG.list({
    prefix: CONFIG_SNAPSHOT_VERSION_PREFIX,
    limit: CONFIG_SNAPSHOT_VERSION_LIST_LIMIT
  });
  const versionedKeys = versionedPage.keys.map((entry) => entry.name).sort();
  let found = versionedKeys.length > 0;
  if (found) requireSecret(env, "CONFIG_ENCRYPTION_KEY");
  for (const key of versionedKeys) {
    const stored = await env.SUBPILOT_CONFIG.get(key);
    if (stored === null) continue;
    const config = await tryDecryptConfigSnapshot(env, stored);
    if (config && (allowLegacy || !config.migrationRequired)) return { config, found: true, key };
  }

  const fixed = await env.SUBPILOT_CONFIG.get(CONFIG_SNAPSHOT_KEY);
  if (fixed !== null) {
    found = true;
    requireSecret(env, "CONFIG_ENCRYPTION_KEY");
    const config = await tryDecryptConfigSnapshot(env, fixed);
    if (config && (allowLegacy || !config.migrationRequired)) return { config, found: true, key: CONFIG_SNAPSHOT_KEY };
  }

  const migratedKeys = (await listKvKeys(env, CONFIG_MIGRATED_SNAPSHOT_PREFIX)).sort().reverse();
  if (migratedKeys.length > 0) {
    found = true;
    requireSecret(env, "CONFIG_ENCRYPTION_KEY");
  }
  for (const key of migratedKeys) {
    const migrated = await env.SUBPILOT_CONFIG.get(key);
    if (migrated === null) continue;
    const config = await tryDecryptConfigSnapshot(env, migrated);
    if (config && (allowLegacy || !config.migrationRequired)) return { config, found: true, key };
  }

  const migratedFixed = await env.SUBPILOT_CONFIG.get(CONFIG_MIGRATED_SNAPSHOT_KEY);
  if (migratedFixed !== null) {
    found = true;
    requireSecret(env, "CONFIG_ENCRYPTION_KEY");
    const config = await tryDecryptConfigSnapshot(env, migratedFixed);
    if (config && (allowLegacy || !config.migrationRequired)) return { config, found: true, key: CONFIG_MIGRATED_SNAPSHOT_KEY };
  }
  return { config: null, found, key: null };
}

async function tryDecryptConfigSnapshot(env: Env, stored: string): Promise<RenderConfig | null> {
  try {
    return await decryptConfigSnapshot(env, stored);
  } catch {
    return null;
  }
}

async function decryptConfigSnapshot(env: Env, stored: string): Promise<RenderConfig> {
  const snapshot = await decryptJson<unknown>(requireSecret(env, "CONFIG_ENCRYPTION_KEY"), stored);
  if (!isConfigSnapshot(snapshot)) throw new Error("Unsupported config snapshot");
  const value = snapshot as { version: number; config: StoredConfigDocument | RenderConfig };
  if (value.version === 2 && (value.config.version === 2 || value.config.version === 3)) {
    const ruleNamesPendingSave = Object.values(value.config.clients).some((client) =>
      client.ruleSets.directRules.some((rule) => Object.hasOwn(rule, "name")));
    const document = normalizeConfigDocument(value.config);
    const fallbackCleanupPendingSave = value.config.version === 3 && document.clients.clash.ruleSets.directRules.length !== value.config.clients.clash.ruleSets.directRules.length;
    const config = await canonicalizeConfigSources(env, renderConfig(document));
    return { ...config, ...(ruleNamesPendingSave || fallbackCleanupPendingSave ? { ruleNamesPendingSave: true } : {}) };
  }
  if (value.config.version !== 1) throw new Error("Unsupported configuration document version");
  return { ...renderConfig(migrateConfigDocument(await canonicalizeConfigSources(env, normalizeConfig(value.config as RenderConfig)))), migrationRequired: true };
}

function isConfigSnapshot(value: unknown): value is ConfigSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<ConfigSnapshot>;
  return (snapshot.version === CONFIG_SNAPSHOT_VERSION || Number(snapshot.version) === 1)
    && Boolean(snapshot.config)
    && typeof snapshot.config === "object";
}

function nextConfigSnapshotRevision(): ConfigSnapshotRevision {
  const logicalTime = Math.max(Date.now(), lastConfigSnapshotWallTime);
  if (logicalTime === lastConfigSnapshotWallTime) {
    configSnapshotWallTimeSequence += 1;
  } else {
    lastConfigSnapshotWallTime = logicalTime;
    configSnapshotWallTimeSequence = 0;
  }
  const inverseTime = CONFIG_SNAPSHOT_LOGICAL_TIME_MAX - logicalTime;
  const inverseSequence = CONFIG_SNAPSHOT_LOGICAL_TIME_MAX - configSnapshotWallTimeSequence;
  return {
    key: `${CONFIG_SNAPSHOT_VERSION_PREFIX}${String(inverseTime).padStart(16, "0")}:${String(inverseSequence).padStart(16, "0")}:${randomToken(8)}`,
    logicalTime
  };
}

async function pruneConfigSnapshotVersions(env: Env, current: ConfigSnapshotRevision): Promise<void> {
  const committed = Number(await env.SUBPILOT_CONFIG.get(DOCUMENT_MIGRATION_COMMITTED));
  if (!committed || Date.now() - committed < CONFIG_SNAPSHOT_CLEANUP_GRACE_MS) return;
  // Version 2 uses target-scoped artifacts. Retire the old shared artifacts only after migration's grace period.
  await pruneCompiledRuleSetCaches(env, { ...DEFAULT_CONFIG, ruleSets: { ...DEFAULT_CONFIG.ruleSets, outputs: [] } });
  const page = await env.SUBPILOT_CONFIG.list({
    prefix: CONFIG_SNAPSHOT_VERSION_PREFIX,
    limit: CONFIG_SNAPSHOT_VERSION_LIST_LIMIT
  });
  const listedKeys = page.keys.map((entry) => entry.name).sort();
  const candidates = [...new Set([current.key, ...listedKeys])].sort();
  const listed = new Set(listedKeys);
  const cutoff = Date.now() - CONFIG_SNAPSHOT_CLEANUP_GRACE_MS;
  const retainedValid: string[] = [];
  let hasPropagatedVersion = false;
  for (const key of candidates) {
    let valid = false;
    if (key === current.key) {
      valid = true;
    } else {
      const stored = await env.SUBPILOT_CONFIG.get(key);
      valid = stored !== null && await tryDecryptConfigSnapshot(env, stored) !== null;
    }
    if (!valid) continue;
    if (retainedValid.length < CONFIG_SNAPSHOT_RETAINED_VALID_VERSIONS) retainedValid.push(key);
    if (listed.has(key) && configSnapshotLogicalTimeFromKey(key) < cutoff) hasPropagatedVersion = true;
    if (retainedValid.length >= CONFIG_SNAPSHOT_RETAINED_VALID_VERSIONS && hasPropagatedVersion) break;
  }
  if (retainedValid.length < CONFIG_SNAPSHOT_RETAINED_VALID_VERSIONS) return;

  const retained = new Set(retainedValid);
  const staleVersionKeys = listedKeys.filter((key) => (
    !retained.has(key)
    && configSnapshotLogicalTimeFromKey(key) < cutoff
  ));
  const deleteKeys = staleVersionKeys.slice(0, CONFIG_SNAPSHOT_VERSION_PRUNE_BATCH_SIZE);

  if (hasPropagatedVersion && deleteKeys.length < CONFIG_SNAPSHOT_VERSION_PRUNE_BATCH_SIZE) {
    const [fixed, migratedFixed, migratedKeys] = await Promise.all([
      env.SUBPILOT_CONFIG.get(CONFIG_SNAPSHOT_KEY),
      env.SUBPILOT_CONFIG.get(CONFIG_MIGRATED_SNAPSHOT_KEY),
      listKvKeys(env, CONFIG_MIGRATED_SNAPSHOT_PREFIX)
    ]);
    const legacyCandidates = [
      ...(fixed === null ? [] : [CONFIG_SNAPSHOT_KEY]),
      ...(migratedFixed === null ? [] : [CONFIG_MIGRATED_SNAPSHOT_KEY]),
      ...migratedKeys.sort()
    ];
    deleteKeys.push(...legacyCandidates.slice(0, CONFIG_SNAPSHOT_VERSION_PRUNE_BATCH_SIZE - deleteKeys.length));
  }
  await mapWithConcurrency([...new Set(deleteKeys)], 10, async (key) => env.SUBPILOT_CONFIG.delete(key));
}

function configSnapshotLogicalTimeFromKey(key: string): number {
  if (!key.startsWith(CONFIG_SNAPSHOT_VERSION_PREFIX)) return 0;
  const inverse = Number(key.slice(CONFIG_SNAPSHOT_VERSION_PREFIX.length).split(":", 1)[0]);
  if (!Number.isSafeInteger(inverse) || inverse < 0 || inverse > CONFIG_SNAPSHOT_LOGICAL_TIME_MAX) return 0;
  return CONFIG_SNAPSHOT_LOGICAL_TIME_MAX - inverse;
}

type CleanupState = "missing" | "pending" | "complete";

async function maintainConfigCleanup(env: Env): Promise<void> {
  if (!await env.SUBPILOT_CONFIG.get(DOCUMENT_MIGRATION_COMMITTED)) return;
  await cleanupRetiredSnapshots(env);
  const state = await retryConfigCleanup(env);
  if (state !== "missing") return;
  if ((await legacyConfigKeys(env)).length > 0) {
    await scheduleConfigCleanup(env);
  } else {
    await markConfigCleanupComplete(env);
  }
}

async function retryConfigCleanup(env: Env): Promise<CleanupState> {
  const [completeKeys, pendingKeys, legacyPending] = await Promise.all([
    listKvKeys(env, CONFIG_SNAPSHOT_CLEANUP_COMPLETE_PREFIX),
    listKvKeys(env, CONFIG_SNAPSHOT_CLEANUP_PENDING_PREFIX),
    env.SUBPILOT_CONFIG.get(CONFIG_SNAPSHOT_CLEANUP_PENDING_KEY)
  ]);
  if (completeKeys.length > 0) return "complete";

  const notBeforeValues = pendingKeys
    .map(configCleanupNotBeforeFromKey)
    .filter((value): value is number => value !== null);
  const legacyNotBefore = normalizeCleanupNotBefore(legacyPending);
  if (legacyNotBefore !== null) notBeforeValues.push(legacyNotBefore);
  if (notBeforeValues.length === 0) return "missing";
  if (Date.now() < Math.min(...notBeforeValues)) return "pending";
  return await cleanupLegacyConfigKeys(env) ? "complete" : "pending";
}

async function scheduleConfigCleanup(env: Env): Promise<void> {
  const notBefore = Date.now() + CONFIG_SNAPSHOT_CLEANUP_GRACE_MS;
  await env.SUBPILOT_CONFIG.put(
    `${CONFIG_SNAPSHOT_CLEANUP_PENDING_PREFIX}${String(notBefore).padStart(16, "0")}:${randomToken(8)}`,
    String(notBefore)
  );
}

async function cleanupLegacyConfigKeys(env: Env): Promise<boolean> {
  const legacyKeys = await legacyConfigKeys(env);
  const batch = legacyKeys.slice(0, CONFIG_SNAPSHOT_CLEANUP_BATCH_SIZE);
  await mapWithConcurrency(batch, 20, async (key) => env.SUBPILOT_CONFIG.delete(key));
  if (legacyKeys.length > batch.length) return false;
  await markConfigCleanupComplete(env);
  return true;
}

async function markConfigCleanupComplete(env: Env): Promise<void> {
  await env.SUBPILOT_CONFIG.put(`${CONFIG_SNAPSHOT_CLEANUP_COMPLETE_PREFIX}${randomToken(8)}`, "1");
}

async function legacyConfigKeys(env: Env): Promise<string[]> {
  const keys = await listKvKeys(env, "config:");
  return keys.filter((key) => !key.startsWith("config:documentMigration:") && key !== CONFIG_SCHEMA_VERSION_KEY
    && key !== CONFIG_SNAPSHOT_KEY
    && key !== CONFIG_MIGRATED_SNAPSHOT_KEY
    && key !== CONFIG_SNAPSHOT_CLEANUP_PENDING_KEY
    && !key.startsWith(CONFIG_MIGRATED_SNAPSHOT_PREFIX)
    && !key.startsWith(CONFIG_SNAPSHOT_VERSION_PREFIX)
    && !key.startsWith(CONFIG_SNAPSHOT_CLEANUP_PENDING_PREFIX)
    && !key.startsWith(CONFIG_SNAPSHOT_CLEANUP_COMPLETE_BASE_PREFIX));
}

function configCleanupNotBeforeFromKey(key: string): number | null {
  return normalizeCleanupNotBefore(key.slice(CONFIG_SNAPSHOT_CLEANUP_PENDING_PREFIX.length).split(":", 1)[0]);
}

function normalizeCleanupNotBefore(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1_000_000_000_000 ? parsed : null;
}

function logConfigHousekeepingFailure(error: unknown): void {
  console.warn(JSON.stringify({
    level: "warn",
    message: `Config housekeeping failed: ${error instanceof Error ? error.message : String(error)}`
  }));
}

async function canonicalizeConfigSources(env: Env, config: RenderConfig): Promise<RenderConfig> {
  const sources = await unsealSources(config.sources, getSecret(env, "CONFIG_ENCRYPTION_KEY"));
  return {
    ...config,
    sources: sources.map(({ urlEncrypted: _urlEncrypted, ...source }) => source)
  };
}

async function readTokenState(env: Env): Promise<{ record: ReadTokenRecord | null; legacyHash: string | null }> {
  const rotationKeys = await listKvKeys(env, READ_TOKEN_ROTATION_PREFIX);
  const latestRotationKey = rotationKeys.sort().at(-1);
  if (latestRotationKey) {
    const rotatedStored = await env.SUBPILOT_CONFIG.get(latestRotationKey);
    if (rotatedStored === null) throw new Error("Encrypted read token rotation record is unavailable");
    const record = await decryptReadTokenRecord(env, rotatedStored);
    await maintainReadTokenCleanup(env, record.legacyCleanupRequired === true).catch(logConfigHousekeepingFailure);
    return { record, legacyHash: null };
  }
  const stored = await env.SUBPILOT_CONFIG.get(READ_TOKEN_RECORD_KEY);
  if (stored !== null) {
    const record = await decryptReadTokenRecord(env, stored);
    await maintainReadTokenCleanup(env, record.legacyCleanupRequired === true).catch(logConfigHousekeepingFailure);
    return { record, legacyHash: null };
  }
  const migratedStored = await env.SUBPILOT_CONFIG.get(READ_TOKEN_MIGRATED_RECORD_KEY);
  if (migratedStored !== null) {
    const record = await decryptReadTokenRecord(env, migratedStored);
    await maintainReadTokenCleanup(env, true).catch(logConfigHousekeepingFailure);
    return { record, legacyHash: null };
  }
  const migratedRecord = await readLatestReadTokenRecord(env, READ_TOKEN_MIGRATION_RECORD_PREFIX);
  if (migratedRecord) {
    await maintainReadTokenCleanup(env, true).catch(logConfigHousekeepingFailure);
    return { record: migratedRecord, legacyHash: null };
  }
  const initialRecord = await readLatestReadTokenRecord(env, READ_TOKEN_INITIAL_RECORD_PREFIX);
  if (initialRecord) {
    await maintainReadTokenCleanup(env, initialRecord.legacyCleanupRequired === true).catch(logConfigHousekeepingFailure);
    return { record: initialRecord, legacyHash: null };
  }

  const [legacyToken, legacyHash] = await Promise.all([
    env.SUBPILOT_CONFIG.get(LEGACY_READ_TOKEN_KEY),
    env.SUBPILOT_CONFIG.get(LEGACY_READ_TOKEN_HASH_KEY)
  ]);
  if (legacyToken === null) {
    return { record: null, legacyHash: normalizeReadTokenHash(legacyHash) };
  }
  if (!legacyToken.startsWith("v1.")) return { record: null, legacyHash: null };

  let token: string;
  try {
    token = await decryptText(requireSecret(env, "CONFIG_ENCRYPTION_KEY"), legacyToken);
  } catch {
    return { record: null, legacyHash: null };
  }
  if (!token) return { record: null, legacyHash: null };

  const record = await createReadTokenRecord(token, { legacyCleanupRequired: true });
  await writeReadTokenRecord(env, record, appendOnlyReadTokenKey(READ_TOKEN_MIGRATION_RECORD_PREFIX));
  await maintainReadTokenCleanup(env, true).catch(logConfigHousekeepingFailure);
  return { record, legacyHash: null };
}

async function readLatestReadTokenRecord(env: Env, prefix: string): Promise<ReadTokenRecord | null> {
  const keys = await listKvKeys(env, prefix);
  const latestKey = keys.sort().at(-1);
  if (!latestKey) return null;
  const stored = await env.SUBPILOT_CONFIG.get(latestKey);
  if (stored === null) throw new Error("Encrypted read token record is unavailable");
  return decryptReadTokenRecord(env, stored);
}

async function decryptReadTokenRecord(env: Env, stored: string): Promise<ReadTokenRecord> {
  try {
    const value = await decryptJson<unknown>(requireSecret(env, "CONFIG_ENCRYPTION_KEY"), stored);
    if (!value || typeof value !== "object") throw new Error("Invalid record");
    const record = value as Partial<ReadTokenRecord>;
    if (record.version !== READ_TOKEN_RECORD_VERSION || typeof record.token !== "string" || !record.token) throw new Error("Invalid record");
    if (normalizeReadTokenHash(record.hash) === null) throw new Error("Invalid record");
    if (record.rotatedAt !== undefined && (!Number.isSafeInteger(record.rotatedAt) || record.rotatedAt < 0)) throw new Error("Invalid record");
    if (record.legacyCleanupRequired !== undefined && typeof record.legacyCleanupRequired !== "boolean") throw new Error("Invalid record");
    const computedHash = await sha256Hex(record.token);
    if (computedHash !== record.hash) throw new Error("Invalid record");
    return record as ReadTokenRecord;
  } catch {
    throw new Error("Encrypted read token record is invalid");
  }
}

async function createReadTokenRecord(token: string, options: {
  rotatedAt?: number;
  legacyCleanupRequired?: boolean;
} = {}): Promise<ReadTokenRecord> {
  return {
    version: READ_TOKEN_RECORD_VERSION,
    token,
    hash: await sha256Hex(token),
    ...(options.rotatedAt === undefined ? {} : { rotatedAt: options.rotatedAt }),
    ...(options.legacyCleanupRequired === true ? { legacyCleanupRequired: true } : {})
  };
}

async function writeReadTokenRecord(env: Env, record: ReadTokenRecord, key = READ_TOKEN_RECORD_KEY): Promise<void> {
  const encrypted = await encryptJson(requireSecret(env, "CONFIG_ENCRYPTION_KEY"), record);
  await env.SUBPILOT_CONFIG.put(key, encrypted);
}

async function maintainReadTokenCleanup(env: Env, ensureScheduled: boolean): Promise<void> {
  const state = await retryReadTokenCleanup(env);
  if (state === "missing" && ensureScheduled) await scheduleReadTokenCleanupIfNeeded(env);
}

async function retryReadTokenCleanup(env: Env): Promise<CleanupState> {
  const [completeKeys, pendingKeys, legacyPending] = await Promise.all([
    listKvKeys(env, READ_TOKEN_CLEANUP_COMPLETE_PREFIX),
    listKvKeys(env, READ_TOKEN_CLEANUP_PENDING_PREFIX),
    env.SUBPILOT_CONFIG.get(READ_TOKEN_CLEANUP_PENDING_KEY)
  ]);
  if (completeKeys.length > 0) return "complete";

  const notBeforeValues = pendingKeys
    .map(readTokenCleanupNotBeforeFromKey)
    .filter((value): value is number => value !== null);
  const legacyNotBefore = normalizeCleanupNotBefore(legacyPending);
  if (legacyNotBefore !== null) notBeforeValues.push(legacyNotBefore);
  if (notBeforeValues.length === 0) return "missing";
  if (Date.now() < Math.min(...notBeforeValues)) return "pending";
  await cleanupLegacyReadTokenKeys(env);
  return "complete";
}

async function scheduleReadTokenCleanupIfNeeded(env: Env): Promise<void> {
  if (await legacyReadTokenKeysExist(env)) await scheduleReadTokenCleanup(env);
}

async function scheduleReadTokenCleanup(env: Env): Promise<void> {
  const notBefore = Date.now() + READ_TOKEN_CLEANUP_GRACE_MS;
  await env.SUBPILOT_CONFIG.put(
    `${READ_TOKEN_CLEANUP_PENDING_PREFIX}${String(notBefore).padStart(16, "0")}:${randomToken(8)}`,
    String(notBefore)
  );
}

async function cleanupLegacyReadTokenKeys(env: Env): Promise<void> {
  await Promise.all([
    env.SUBPILOT_CONFIG.delete(LEGACY_READ_TOKEN_KEY),
    env.SUBPILOT_CONFIG.delete(LEGACY_READ_TOKEN_HASH_KEY)
  ]);
  await env.SUBPILOT_CONFIG.put(`${READ_TOKEN_CLEANUP_COMPLETE_PREFIX}${randomToken(8)}`, "1");
}

async function legacyReadTokenKeysExist(env: Env): Promise<boolean> {
  const [legacyToken, legacyHash] = await Promise.all([
    env.SUBPILOT_CONFIG.get(LEGACY_READ_TOKEN_KEY),
    env.SUBPILOT_CONFIG.get(LEGACY_READ_TOKEN_HASH_KEY)
  ]);
  return legacyToken !== null || legacyHash !== null;
}

function appendOnlyReadTokenKey(prefix: string): string {
  return `${prefix}${randomToken(8)}`;
}

function readTokenCleanupNotBeforeFromKey(key: string): number | null {
  return normalizeCleanupNotBefore(key.slice(READ_TOKEN_CLEANUP_PENDING_PREFIX.length).split(":", 1)[0]);
}

function readTokenRotationKey(rotationTime: number): string {
  // Millisecond keys sort after legacy 30-second slots without rewriting them.
  return `${READ_TOKEN_ROTATION_PREFIX}${String(rotationTime).padStart(16, "0")}:${randomToken(8)}`;
}

async function deriveReadToken(env: Env, purpose: string): Promise<string> {
  const secret = requireSecret(env, "CONFIG_ENCRYPTION_KEY");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(purpose));
  return base64Url(new Uint8Array(signature));
}

function normalizeReadTokenHash(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null;
}

async function loadLegacyStoredConfig(env: Env): Promise<RenderConfig> {
  const [settings, groups, disabledGroups, sources, proxyNodes, chain, ruleSets, surge, clash, stash, updatedAt] = await Promise.all([
    loadSettings(env),
    loadGroups(env),
    loadDisabledGroups(env),
    loadSources(env),
    loadProxyNodes(env),
    loadChain(env),
    loadRuleSets(env),
    loadSurge(env),
    loadClash(env),
    loadStash(env),
    getJson<string>(env, CONFIG_UPDATED_AT_KEY)
  ]);

  return normalizeConfig({
    version: 1,
    settings: { ...DEFAULT_CONFIG.settings, ...settings },
    groups,
    disabledGroups,
    sources,
    proxyNodes,
    chain,
    ruleSets,
    surge,
    clash,
    stash,
    updatedAt
  });
}

async function loadSettings(env: Env): Promise<Partial<RenderConfig["settings"]>> {
  const output: Partial<RenderConfig["settings"]> = {};
  await Promise.all(SETTING_KEYS.map(async (key) => {
    const value = await getJson<unknown>(env, `${SETTINGS_PREFIX}${key}`);
    if (value !== undefined) (output as Record<string, unknown>)[key] = value;
  }));
  const telegramBotToken = await loadEncryptedSetting(env, TELEGRAM_BOT_TOKEN_KEY);
  if (telegramBotToken !== null) output.notificationTelegramBotToken = telegramBotToken;
  const telegramWebhookSecret = await loadEncryptedSetting(env, TELEGRAM_WEBHOOK_SECRET_KEY);
  if (telegramWebhookSecret !== null) output.notificationTelegramWebhookSecret = telegramWebhookSecret;
  return output;
}

async function loadEncryptedSetting(env: Env, key: string): Promise<string | null> {
  const stored = await env.SUBPILOT_CONFIG.get(key);
  if (!stored) return null;
  return decryptText(requireSecret(env, "CONFIG_ENCRYPTION_KEY"), stored);
}

async function loadGroups(env: Env): Promise<Record<string, string>> {
  const names = await getJson<string[]>(env, GROUP_INDEX_KEY);
  if (!names) return DEFAULT_CONFIG.groups;

  const entries = await Promise.all(names.map(async (name): Promise<[string, string] | null> => {
    const value = await env.SUBPILOT_CONFIG.get(`${GROUP_PREFIX}${encodeKey(name)}`);
    return value === null ? null : [name, value];
  }));
  return Object.fromEntries(entries.filter((entry): entry is [string, string] => entry !== null));
}

async function loadDisabledGroups(env: Env): Promise<string[]> {
  return await getJson<string[]>(env, GROUP_DISABLED_KEY) ?? DEFAULT_CONFIG.disabledGroups;
}

async function loadSources(env: Env): Promise<SourceConfig[]> {
  const ids = await getJson<string[]>(env, SOURCE_INDEX_KEY);
  if (!ids) return [];

  const sources = await Promise.all(ids.map((id) => getJson<SourceConfig>(env, `${SOURCE_PREFIX}${encodeKey(id)}`)));
  return sources.filter((source): source is SourceConfig => Boolean(source));
}

async function loadProxyNodes(env: Env): Promise<StaticProxyNodeConfig[]> {
  const ids = await getJson<string[]>(env, PROXY_NODE_INDEX_KEY);
  if (!ids) return DEFAULT_CONFIG.proxyNodes;

  const nodes = await Promise.all(ids.map((id) => getJson<StaticProxyNodeConfig>(env, `${PROXY_NODE_PREFIX}${encodeKey(id)}`)));
  return nodes.filter((node): node is StaticProxyNodeConfig => Boolean(node));
}

async function loadChain(_env: Env): Promise<RenderConfig["chain"]> {
  return normalizeChain(undefined);
}

async function loadRuleSets(env: Env): Promise<RuleSetConfig> {
  const [mode, aggregateByPolicy, sources, outputs, directRules] = await Promise.all([
    getJson<unknown>(env, RULE_SET_MODE_KEY),
    getJson<unknown>(env, RULE_SET_AGGREGATE_BY_POLICY_KEY),
    loadRuleSetSources(env),
    loadRuleSetOutputs(env),
    loadRuleSetDirectRules(env)
  ]);
  return normalizeRuleSets({
    mode: mode === "compiled" ? "compiled" : "manual",
    aggregateByPolicy: aggregateByPolicy === true,
    sources,
    outputs,
    directRules
  });
}

async function loadRuleSetSources(env: Env): Promise<RuleSetSource[]> {
  const ids = await getJson<string[]>(env, RULE_SET_SOURCE_INDEX_KEY);
  if (!ids) return DEFAULT_CONFIG.ruleSets.sources;

  const sources = await Promise.all(ids.map((id) => getJson<RuleSetSource>(env, `${RULE_SET_SOURCE_PREFIX}${encodeKey(id)}`)));
  return sources.filter((source): source is RuleSetSource => Boolean(source));
}

async function loadRuleSetOutputs(env: Env): Promise<RuleSetOutput[]> {
  const names = await getJson<string[]>(env, RULE_SET_OUTPUT_INDEX_KEY);
  if (!names) return DEFAULT_CONFIG.ruleSets.outputs;

  const outputs = await Promise.all(names.map((name) => getJson<RuleSetOutput>(env, `${RULE_SET_OUTPUT_PREFIX}${encodeKey(name)}`)));
  return outputs.filter((output): output is RuleSetOutput => Boolean(output));
}

async function loadRuleSetDirectRules(env: Env): Promise<RuleSetDirectRule[]> {
  const ids = await getJson<string[]>(env, RULE_SET_DIRECT_RULE_INDEX_KEY);
  if (!ids) return DEFAULT_CONFIG.ruleSets.directRules;

  const rules = await Promise.all(ids.map((id) => getJson<RuleSetDirectRule>(env, `${RULE_SET_DIRECT_RULE_PREFIX}${encodeKey(id)}`)));
  return rules.filter((rule): rule is RuleSetDirectRule => Boolean(rule));
}

async function loadSurge(env: Env): Promise<RenderConfig["surge"]> {
  return loadConfigSection(env, SURGE_PREFIX, SURGE_KEYS, DEFAULT_CONFIG.surge, normalizeSurge);
}

async function loadClash(env: Env): Promise<RenderConfig["clash"]> {
  return loadConfigSection(env, CLASH_PREFIX, CLASH_KEYS, DEFAULT_CONFIG.clash, normalizeClash);
}


async function loadStash(env: Env): Promise<RenderConfig["stash"]> {
  return loadConfigSection(env, STASH_PREFIX, STASH_KEYS, DEFAULT_CONFIG.stash, normalizeStash);
}


async function loadConfigSection<T extends object, K extends keyof T>(
  env: Env,
  prefix: string,
  keys: readonly K[],
  defaults: T,
  normalize: (input: Partial<T>) => T
): Promise<T> {
  const entries = await Promise.all(keys.map(async (key): Promise<[K, unknown]> => {
    const value = await getJson<unknown>(env, `${prefix}${String(key)}`);
    return [key, value ?? defaults[key]];
  }));
  return normalize(Object.fromEntries(entries) as Partial<T>);
}

async function getJson<T>(env: Env, key: string): Promise<T | undefined> {
  const value = await env.SUBPILOT_CONFIG.get(key);
  if (value === null) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function encodeKey(value: string): string {
  return encodeURIComponent(value);
}

export async function exportConfigBeforeMigration(env: Env): Promise<StoredConfigDocument | RenderConfig> {
  const committed = await env.SUBPILOT_CONFIG.get(DOCUMENT_MIGRATION_COMMITTED) !== null;
  const candidates = await listKvKeys(env, CONFIG_SNAPSHOT_VERSION_PREFIX);
  const fallback = [CONFIG_SNAPSHOT_KEY, ...(await listKvKeys(env, CONFIG_MIGRATED_SNAPSHOT_PREFIX)).sort().reverse(), CONFIG_MIGRATED_SNAPSHOT_KEY];
  for (const key of [...candidates.sort(), ...fallback]) {
    const encrypted = await env.SUBPILOT_CONFIG.get(key);
    if (!encrypted) continue;
    try {
      const snapshot = await decryptJson<{ version: number; config: StoredConfigDocument | RenderConfig }>(requireSecret(env, "CONFIG_ENCRYPTION_KEY"), encrypted);
      if (snapshot.config && (!committed || (snapshot.config.version === 2 || snapshot.config.version === 3))) return snapshot.config;
    } catch { /* Try a retained valid revision without rewriting it. */ }
  }
  if (committed) throw new Error("没有可读取的有效客户端配置。");
  if (!candidates.length && !(await legacyConfigKeys(env)).length) return defaultConfigDocument();
  return loadLegacyStoredConfig(env);
}

export async function loadConfigMigration(env: Env): Promise<{ fingerprint: string; config: RenderConfig }> {
  const backup = await exportConfigBeforeMigration(env);
  const fingerprint = await sha256Hex(JSON.stringify(backup));
  // Derive the editable document from the exact revision identified by the fingerprint.
  if (backup.version === 2 || backup.version === 3) return { fingerprint, config: await canonicalizeConfigSources(env, renderConfig(normalizeConfigDocument(backup))) };
  if (backup.version !== 1) throw new Error("Unsupported configuration document version");
  const legacy = await canonicalizeConfigSources(env, normalizeConfig(backup));
  return { fingerprint, config: { ...renderConfig(migrateConfigDocument(legacy)), migrationRequired: true } };
}

async function markDocumentCommitted(env: Env): Promise<void> {
  if (await env.SUBPILOT_CONFIG.get(DOCUMENT_MIGRATION_COMMITTED) === null) await env.SUBPILOT_CONFIG.put(DOCUMENT_MIGRATION_COMMITTED, String(Date.now()));
  if (await env.SUBPILOT_CONFIG.get(CONFIG_SCHEMA_VERSION_KEY) !== String(CURRENT_KV_SCHEMA_VERSION)) await env.SUBPILOT_CONFIG.put(CONFIG_SCHEMA_VERSION_KEY, String(CURRENT_KV_SCHEMA_VERSION));
}

export async function completeDocumentMigration(env: Env, document: AppConfig): Promise<RenderConfig> {
  const current = await loadConfig(env);
  if (!current.migrationRequired) return current;
  const saved = await saveConfig(env, renderConfig(normalizeConfigDocument(document)));
  return saved;
}

async function cleanupRetiredSnapshots(env: Env): Promise<void> {
  const committed = Number(await env.SUBPILOT_CONFIG.get(DOCUMENT_MIGRATION_COMMITTED));
  if (!committed || Date.now() - committed < CONFIG_SNAPSHOT_CLEANUP_GRACE_MS) return;
  const keys = [...await listKvKeys(env, CONFIG_SNAPSHOT_VERSION_PREFIX), ...await listKvKeys(env, CONFIG_MIGRATED_SNAPSHOT_PREFIX), CONFIG_SNAPSHOT_KEY, CONFIG_MIGRATED_SNAPSHOT_KEY];
  for (const key of keys.slice(0, CONFIG_SNAPSHOT_CLEANUP_BATCH_SIZE)) {
    const value = await env.SUBPILOT_CONFIG.get(key);
    if (!value) continue;
    try {
      const snapshot = await decryptJson<{ config?: { version?: number } }>(requireSecret(env, "CONFIG_ENCRYPTION_KEY"), value);
      if (snapshot.config?.version === 1) await env.SUBPILOT_CONFIG.delete(key);
    } catch { /* A damaged revision is handled by regular snapshot maintenance. */ }
  }
}
