import { configDocument, defaultConfigDocument, normalizeConfigDocument, renderConfig, OUTPUT_TARGETS, UnsupportedConfigError } from "./config-document";
import { retryActionsCompilationJobs } from "./actions-compiler";
import { ruleSetEnv } from "./rule-set-scope";
import { queueChangedRuleSetUpdates, runRuleSetUpdateJobs } from "./rule-set-jobs";
import type { AppConfig, RenderConfig } from "./types";
import { decryptJson, encryptJson } from "./crypto-store";
import { listKvKeys } from "./kv-helpers";
import { pruneRuleSetSourceCaches, pruneCompiledRuleSetCaches } from "./rule-set-cache";
import { requireSecret } from "./secrets";
import { pruneSourceCache } from "./source-cache";
import { base64Url, mapWithConcurrency, randomToken, sha256Hex } from "./util";

export { inferManagedBaseUrl, normalizeConfig, normalizeTarget, withInferredManagedBaseUrl } from "./config-normalize";
export { validateManagedBaseUrl, validateProxyPolicyNameConflicts } from "./config-validation";

export const CONFIG_SNAPSHOT_VERSION_PREFIX = "config:snapshot:version:";
const CONFIG_SNAPSHOT_VERSION = 2;
const CONFIG_SNAPSHOT_CLEANUP_GRACE_MS = 5 * 60 * 1000;
const CONFIG_SNAPSHOT_RETAINED_VALID_VERSIONS = 3;
const CONFIG_SNAPSHOT_VERSION_PRUNE_BATCH_SIZE = 20;
const CONFIG_SNAPSHOT_VERSION_LIST_LIMIT = 64;
const CONFIG_SNAPSHOT_LOGICAL_TIME_MAX = Number.MAX_SAFE_INTEGER;
export const READ_TOKEN_INITIAL_RECORD_PREFIX = "auth:read_token_initial:";
export const READ_TOKEN_ROTATION_PREFIX = "auth:read_token_rotation:";
const READ_TOKEN_RECORD_VERSION = 1;

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
}

export async function loadConfig(env: Env): Promise<RenderConfig> {
  const stored = await readStoredConfigSnapshot(env);
  if (stored.config) return stored.config;
  if (stored.found) throw new Error("No valid encrypted config snapshot is available");
  const existing = await env.SUBPILOT_CONFIG.list({ prefix: "config:", limit: 1 });
  if (existing.keys.length) throw new UnsupportedConfigError("不支持现有配置存储格式；当前版本仅支持版本 3 配置快照。");
  return renderConfig(defaultConfigDocument());
}

export async function saveConfig(env: Env, config: RenderConfig): Promise<RenderConfig> {
  return commitPreparedConfigSave(env, await prepareConfigSave(env, config));
}

export async function prepareConfigSave(env: Env, config: RenderConfig): Promise<PreparedConfigSave> {
  // Fail before callers perform any related external side effect.
  requireSecret(env, "CONFIG_ENCRYPTION_KEY");
  const revision = nextConfigSnapshotRevision();
  const document = configDocument({ ...config, updatedAt: new Date(revision.logicalTime).toISOString() });
  return {
    config: renderConfig(document, config.renderTarget),
    snapshotKey: revision.key,
    logicalTime: revision.logicalTime
  };
}

export async function commitPreparedConfigSave(env: Env, prepared: PreparedConfigSave, context?: Pick<ExecutionContext, "waitUntil">): Promise<RenderConfig> {
  const jobs = await queueChangedRuleSetUpdates(env, await loadConfig(env), prepared.config);
  await writeConfigSnapshot(env, prepared.config, prepared.snapshotKey);
  const verified = await env.SUBPILOT_CONFIG.get(prepared.snapshotKey);
  if (!verified || !(await tryDecryptConfigSnapshot(env, verified))) throw new Error("新配置写入校验失败，请重试。");
  if (context && (jobs.length || prepared.config.settings.actionsCompilation?.enabled)) {
    const deadline = Date.now() + 25_000;
    // Dispatch failure must not consume the Worker's fallback preparation budget.
    context.waitUntil(retryActionsCompilationJobs(env, prepared.config, deadline));
    context.waitUntil(runRuleSetUpdateJobs(env, prepared.config, {
      jobs, deadline, loadCurrentConfig: () => loadConfig(env)
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
  await finishCommittedConfigSave(env, prepared);
  return config;
}

async function finishCommittedConfigSave(env: Env, prepared: PreparedConfigSave): Promise<void> {
  const document = configDocument(prepared.config);
  const results = await Promise.allSettled([
    pruneSourceCache(env, prepared.config),
    pruneRuleSetSourceCaches(env, prepared.config),
    ...OUTPUT_TARGETS.map((target) => pruneCompiledRuleSetCaches(ruleSetEnv(env, target), renderConfig(document, target))),
    pruneConfigSnapshotVersions(env, {
      key: prepared.snapshotKey,
      logicalTime: prepared.logicalTime
    })
  ]);
  for (const result of results) {
    if (result.status === "rejected") logConfigHousekeepingFailure(result.reason);
  }
}

export async function readStoredReadTokenHash(env: Env): Promise<string | null> {
  return (await readTokenRecord(env))?.hash ?? null;
}

export async function readStoredReadToken(env: Env): Promise<string | null> {
  return (await readTokenRecord(env))?.token ?? null;
}

export async function storeInitialReadToken(env: Env, token: string): Promise<string> {
  const stored = await readTokenRecord(env);
  if (stored) return stored.token;
  await writeReadTokenRecord(env, await createReadTokenRecord(token), `${READ_TOKEN_INITIAL_RECORD_PREFIX}${randomToken(8)}`);
  return token;
}

export async function rotateStoredReadToken(env: Env): Promise<string> {
  const now = Date.now();
  const latestKey = (await listKvKeys(env, READ_TOKEN_ROTATION_PREFIX)).sort().at(-1);
  const previousTime = latestKey ? Number(latestKey.slice(READ_TOKEN_ROTATION_PREFIX.length).split(":", 1)[0]) : 0;
  const rotationTime = Math.max(now, Number.isSafeInteger(previousTime) ? previousTime + 1 : 0);
  const token = randomToken(32);
  await writeReadTokenRecord(env, await createReadTokenRecord(token, { rotatedAt: now }),
    `${READ_TOKEN_ROTATION_PREFIX}${String(rotationTime).padStart(16, "0")}:${randomToken(8)}`);
  return token;
}

export async function deterministicInitialReadToken(env: Env): Promise<string> {
  return deriveReadToken(env, "subpilot:initial-read-token:v1");
}

async function writeConfigSnapshot(env: Env, config: RenderConfig, key: string): Promise<void> {
  const snapshot: ConfigSnapshot = { version: CONFIG_SNAPSHOT_VERSION, config: configDocument(config) };
  const encrypted = await encryptJson(requireSecret(env, "CONFIG_ENCRYPTION_KEY"), snapshot);
  await env.SUBPILOT_CONFIG.put(key, encrypted);
}

async function readStoredConfigSnapshot(env: Env): Promise<StoredConfigSnapshotResult> {
  const page = await env.SUBPILOT_CONFIG.list({ prefix: CONFIG_SNAPSHOT_VERSION_PREFIX, limit: CONFIG_SNAPSHOT_VERSION_LIST_LIMIT });
  const keys = page.keys.map((entry) => entry.name).sort(compareConfigSnapshotKeys);
  if (keys.length) requireSecret(env, "CONFIG_ENCRYPTION_KEY");
  for (const key of keys) {
    const stored = await env.SUBPILOT_CONFIG.get(key);
    if (stored === null) continue;
    const config = await tryDecryptConfigSnapshot(env, stored);
    if (config) return { config, found: true };
  }
  return { config: null, found: keys.length > 0 };
}

async function tryDecryptConfigSnapshot(env: Env, stored: string): Promise<RenderConfig | null> {
  try {
    return await decryptConfigSnapshot(env, stored);
  } catch (error) {
    if (error instanceof UnsupportedConfigError) throw error;
    return null;
  }
}

async function decryptConfigSnapshot(env: Env, stored: string): Promise<RenderConfig> {
  const value = await decryptJson<unknown>(requireSecret(env, "CONFIG_ENCRYPTION_KEY"), stored);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid config snapshot");
  const snapshot = value as Partial<ConfigSnapshot>;
  if (snapshot.version !== CONFIG_SNAPSHOT_VERSION) throw new UnsupportedConfigError("不支持此配置快照版本。");
  if (!snapshot.config || typeof snapshot.config !== "object" || Array.isArray(snapshot.config)) throw new Error("Invalid config snapshot");
  return renderConfig(normalizeConfigDocument(snapshot.config));
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
  const page = await env.SUBPILOT_CONFIG.list({
    prefix: CONFIG_SNAPSHOT_VERSION_PREFIX,
    limit: CONFIG_SNAPSHOT_VERSION_LIST_LIMIT
  });
  const listedKeys = page.keys.map((entry) => entry.name).sort(compareConfigSnapshotKeys);
  const candidates = [...new Set([current.key, ...listedKeys])].sort(compareConfigSnapshotKeys);
  const cutoff = Date.now() - CONFIG_SNAPSHOT_CLEANUP_GRACE_MS;
  const retainedValid: string[] = [];
  const unsupported = new Set<string>();
  for (const key of candidates) {
    let valid = false;
    if (key === current.key) {
      valid = true;
    } else {
      const stored = await env.SUBPILOT_CONFIG.get(key);
      try {
        valid = stored !== null && await tryDecryptConfigSnapshot(env, stored) !== null;
      } catch (error) {
        if (!(error instanceof UnsupportedConfigError)) throw error;
        unsupported.add(key);
      }
    }
    if (!valid) continue;
    if (retainedValid.length < CONFIG_SNAPSHOT_RETAINED_VALID_VERSIONS) retainedValid.push(key);
    if (retainedValid.length >= CONFIG_SNAPSHOT_RETAINED_VALID_VERSIONS) break;
  }
  if (retainedValid.length < CONFIG_SNAPSHOT_RETAINED_VALID_VERSIONS) return;

  const retained = new Set(retainedValid);
  const staleVersionKeys = listedKeys.filter((key) => (
    !retained.has(key)
    && !unsupported.has(key)
    && configSnapshotLogicalTimeFromKey(key) < cutoff
  ));
  const deleteKeys = staleVersionKeys.slice(0, CONFIG_SNAPSHOT_VERSION_PRUNE_BATCH_SIZE);

  await mapWithConcurrency([...new Set(deleteKeys)], 10, async (key) => {
    const stored = await env.SUBPILOT_CONFIG.get(key);
    if (stored === null) return;
    try { await tryDecryptConfigSnapshot(env, stored); }
    catch (error) {
      if (error instanceof UnsupportedConfigError) return;
      throw error;
    }
    await env.SUBPILOT_CONFIG.delete(key);
  });
}

export function compareConfigSnapshotKeys(left: string, right: string): number {
  const suffix = /(?::(?:actions|workflow|v233)-v1)+$/;
  const leftMigrations = left.match(suffix)?.[0] ?? "";
  const rightMigrations = right.match(suffix)?.[0] ?? "";
  const leftSource = left.slice(0, left.length - leftMigrations.length);
  const rightSource = right.slice(0, right.length - rightMigrations.length);
  if (leftSource !== rightSource) return leftSource < rightSource ? -1 : 1;
  const priority = (migrations: string) => Number(migrations.includes(":v233-v1")) * 4 + Number(migrations.includes(":workflow-v1")) * 2 + Number(migrations.includes(":actions-v1"));
  return priority(rightMigrations) - priority(leftMigrations) || (left === right ? 0 : left < right ? -1 : 1);
}

function configSnapshotLogicalTimeFromKey(key: string): number {
  if (!key.startsWith(CONFIG_SNAPSHOT_VERSION_PREFIX)) return 0;
  const inverse = Number(key.slice(CONFIG_SNAPSHOT_VERSION_PREFIX.length).split(":", 1)[0]);
  if (!Number.isSafeInteger(inverse) || inverse < 0 || inverse > CONFIG_SNAPSHOT_LOGICAL_TIME_MAX) return 0;
  return CONFIG_SNAPSHOT_LOGICAL_TIME_MAX - inverse;
}

function logConfigHousekeepingFailure(error: unknown): void {
  console.warn(JSON.stringify({
    level: "warn",
    message: `Config housekeeping failed: ${error instanceof Error ? error.message : String(error)}`
  }));
}

async function readTokenRecord(env: Env): Promise<ReadTokenRecord | null> {
  const rotation = await readLatestReadTokenRecord(env, READ_TOKEN_ROTATION_PREFIX);
  if (rotation) return rotation;
  // These locations contain the same complete encrypted record written by current releases.
  for (const key of ["auth:read_token_record", "auth:read_token_record:migrated"]) {
    const stored = await env.SUBPILOT_CONFIG.get(key);
    if (stored !== null) return decryptReadTokenRecord(env, stored);
  }
  const migrated = await readLatestReadTokenRecord(env, "auth:read_token_migration:");
  if (migrated) return migrated;
  const initial = await readLatestReadTokenRecord(env, READ_TOKEN_INITIAL_RECORD_PREFIX);
  if (initial) return initial;
  const obsolete = await Promise.all([env.SUBPILOT_CONFIG.get("auth:read_token"), env.SUBPILOT_CONFIG.get("auth:read_token_hash")]);
  if (obsolete.some((value) => value !== null)) throw new UnsupportedConfigError("不支持旧订阅令牌格式；请在管理页面轮换订阅令牌。");
  return null;
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
    const computedHash = await sha256Hex(record.token);
    if (computedHash !== record.hash) throw new Error("Invalid record");
    return record as ReadTokenRecord;
  } catch {
    throw new Error("Encrypted read token record is invalid");
  }
}

async function createReadTokenRecord(token: string, options: {
  rotatedAt?: number;
} = {}): Promise<ReadTokenRecord> {
  return {
    version: READ_TOKEN_RECORD_VERSION,
    token,
    hash: await sha256Hex(token),
    ...(options.rotatedAt === undefined ? {} : { rotatedAt: options.rotatedAt })
  };
}

async function writeReadTokenRecord(env: Env, record: ReadTokenRecord, key: string): Promise<void> {
  const encrypted = await encryptJson(requireSecret(env, "CONFIG_ENCRYPTION_KEY"), record);
  await env.SUBPILOT_CONFIG.put(key, encrypted);
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
