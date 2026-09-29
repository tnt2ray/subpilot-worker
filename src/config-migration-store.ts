import { migrateV233Document } from "./config-migration-v233";
import { compareConfigSnapshotKeys, CONFIG_SNAPSHOT_VERSION_PREFIX } from "./config-store";
import { normalizeConfigDocument } from "./config-document";
import { decryptJson, decryptText, encryptJson } from "./crypto-store";
import { requireSecret } from "./secrets";
import type { AppConfig } from "./types";
import { sha256Hex } from "./util";

const BACKUP_PREFIX = "integration:config-migration:v233:backup:";
const SUFFIX = ":v233-v1";
const MAX_TIME = Number.MAX_SAFE_INTEGER;
const ACTIONS_STATE_KEY = "integration:actions-compiler:migration:v1";
const ACTIONS_CHECKPOINT_KEY = "integration:config-migration:v233:actions-checkpoint:v1";
const ACTIONS_PROPAGATION_MS = 65_000;
const ACTIONS_RECORDS = [
  { kind: "credentials", current: "integration:actions-compiler:credentials:v1", previous: "integration:actions-compiler:migrated-v233-credentials:v1", migrated: "integration:actions-compiler:migrated-credentials:v1", legacy: "integration:singbox-srs:credentials:v1" },
  { kind: "callback-origin", current: "integration:actions-compiler:callback-origin:v1", previous: "integration:actions-compiler:migrated-v233-callback-origin:v1", migrated: "integration:actions-compiler:migrated-callback-origin:v1", legacy: "integration:singbox-srs:callback-origin:v1" }
] as const;

export interface V233MigrationStatus {
  status: "ready" | "current" | "empty" | "blocked" | "applied" | "pending";
  revision?: string;
  changes: string[];
  blockers: string[];
  backupKey?: string;
  retryAfterSeconds?: number;
}

class MigrationBlockedError extends Error {}
type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue => !!value && typeof value === "object" && !Array.isArray(value);
function block(message: string): never { throw new MigrationBlockedError(message); }

interface MigrationWrite { key: string; stored?: string; value?: unknown }
interface ActionsRelocation {
  kind: typeof ACTIONS_RECORDS[number]["kind"];
  currentKey: string;
  current: string | null;
  expected: string;
  oldRecords: [string, string | null][];
}
interface ActionsCheckpoint {
  version: 1;
  notBefore: number;
  records: { currentKey: string; currentHash: string; oldHashes: [string, string | null][] }[];
}
interface MigrationPlan {
  result: V233MigrationStatus;
  records: [string, string | null][];
  source?: { key: string; stored: string };
  document?: AppConfig;
  snapshotKey?: string;
  writes: MigrationWrite[];
  actions: ActionsRelocation[];
  checkpoint?: { stored: string | null; value: ActionsCheckpoint | null; matches: boolean };
}

/** A bounded read set, also used to detect stale previews without exposing data. */
class MigrationReadSet {
  readonly values = new Map<string, string | null>();
  readonly listings = new Map<string, string[]>();
  constructor(readonly env: Env) {}
  async get(key: string): Promise<string | null> {
    if (!this.values.has(key)) this.values.set(key, await this.env.SUBPILOT_CONFIG.get(key));
    return this.values.get(key) ?? null;
  }
  async list(prefix: string): Promise<string[]> {
    if (!this.listings.has(prefix)) {
      const page = await this.env.SUBPILOT_CONFIG.list({ prefix, limit: 1000 });
      if (!page.list_complete) block("相关历史记录过多，无法在一次迁移中安全检查。");
      this.listings.set(prefix, page.keys.map(({ name }) => name).sort());
    }
    return this.listings.get(prefix)!;
  }
  async revision(): Promise<string> {
    return sha256Hex(JSON.stringify({ records: [...this.values].sort(([a], [b]) => a.localeCompare(b)), listings: [...this.listings].sort(([a], [b]) => a.localeCompare(b)) }));
  }
}

async function selectSnapshot(read: MigrationReadSet): Promise<{ key: string; stored: string } | undefined> {
  const versioned = await read.list(CONFIG_SNAPSHOT_VERSION_PREFIX);
  const first = versioned.sort(compareConfigSnapshotKeys)[0];
  if (first) {
    const stored = await read.get(first);
    if (stored === null) block("最新配置快照暂时不可读，请稍后重试。");
    return { key: first, stored };
  }
  const fixed = await read.get("config:snapshot");
  if (fixed !== null) return { key: "config:snapshot", stored: fixed };
  const migrated = (await read.list("config:snapshot:migrated:")).sort().at(-1);
  if (migrated) {
    const stored = await read.get(migrated);
    if (stored === null) block("最新旧版配置快照暂时不可读，请稍后重试。");
    return { key: migrated, stored };
  }
  const migratedFixed = await read.get("config:snapshot:migrated");
  if (migratedFixed !== null) return { key: "config:snapshot:migrated", stored: migratedFixed };
  if ((await read.list("config:")).length) block("没有受支持的加密配置快照；请先使用旧版完成更早的数据迁移。");
  return undefined;
}

async function canonicalizeSources(document: RecordValue, secret: string, changes: string[]): Promise<void> {
  if (!Array.isArray(document.sources)) return;
  for (const source of document.sources) {
    if (!object(source) || !Object.hasOwn(source, "urlEncrypted")) continue;
    if (!source.url) {
      if (typeof source.urlEncrypted !== "string") block("旧订阅源加密字段无效，未修改数据。");
      try { source.url = await decryptText(secret, source.urlEncrypted); }
      catch { block("旧订阅源无法解密，未修改数据。"); }
    }
    delete source.urlEncrypted;
  }
  changes.push("将旧订阅源独立加密字段合并到完整加密快照。");
}

async function validateActionsRecord(kind: ActionsRelocation["kind"], stored: string, secret: string): Promise<void> {
  let value: unknown;
  try { value = await decryptJson(secret, stored); }
  catch { block("Actions 记录无法解密，迁移已停止。"); }
  if (!object(value) || value.version !== 1) block("Actions 记录版本或结构无效，迁移已停止。");
  if (kind === "credentials") {
    if (typeof value.token !== "string" || (value.token !== "" && !/^[A-Za-z0-9_]{20,255}$/.test(value.token))
      || typeof value.sharedSecret !== "string" || (value.sharedSecret !== "" && !/^[\x21-\x7e]{32,256}$/.test(value.sharedSecret))) {
      block("Actions 凭据结构无效，迁移已停止。");
    }
  } else {
    if (typeof value.origin !== "string") block("Actions 回调地址结构无效，迁移已停止。");
    try {
      const url = new URL(value.origin);
      if (url.protocol !== "https:" || url.origin !== value.origin || url.username || url.password || url.port) throw new Error();
    } catch { block("Actions 回调地址结构无效，迁移已停止。"); }
  }
}

async function planActions(read: MigrationReadSet, secret: string, changes: string[], actions: ActionsRelocation[]): Promise<void> {
  for (const item of ACTIONS_RECORDS) {
    const current = await read.get(item.current);
    // Back up and fingerprint every retired location, even when current wins.
    const oldRecords: [string, string | null][] = [];
    for (const key of [item.previous, item.migrated, item.legacy]) oldRecords.push([key, await read.get(key)]);
    let stored = current ?? oldRecords[0]![1] ?? oldRecords[1]![1];
    if (stored === null) {
      const rawState = await read.get(ACTIONS_STATE_KEY);
      let done = false;
      if (rawState !== null) {
        try {
          const state: unknown = JSON.parse(rawState);
          if (!object(state) || state.version !== 1 || !["copy", "grace", "cleanup", "done"].includes(String(state.phase))) throw new Error();
          done = state.phase === "done";
        }
        catch { block("旧 Actions 迁移状态无效，无法安全选择凭据。"); }
      }
      if (!done) stored = oldRecords[2]![1];
      else if (oldRecords[2]![1] !== null) block("Actions 旧记录已标记退役，但正式记录缺失；无法安全恢复或清理，请先修复正式记录。");
    }
    if (stored === null) continue;
    await validateActionsRecord(item.kind, stored, secret);
    if (oldRecords.some(([, value]) => value !== null)) {
      actions.push({ kind: item.kind, currentKey: item.current, current, expected: stored, oldRecords });
      const label = item.kind === "credentials" ? "Actions 凭据" : "Actions 回调地址";
      changes.push(current === null
        ? `将旧 ${label} 写入正式记录，验证成功后清理旧记录。`
        : `保留现有正式 ${label}，验证并备份后清理旧记录。`);
    }
  }
}

async function readActionsCheckpoint(read: MigrationReadSet, secret: string, actions: ActionsRelocation[]): Promise<NonNullable<MigrationPlan["checkpoint"]>> {
  const stored = await read.get(ACTIONS_CHECKPOINT_KEY);
  if (stored === null) return { stored, value: null, matches: false };
  let raw: unknown;
  try { raw = await decryptJson(secret, stored); }
  catch { block("Actions 迁移检查点无法解密，未继续清理旧记录。"); }
  const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  if (!object(raw) || raw.version !== 1 || !Number.isSafeInteger(raw.notBefore) || Number(raw.notBefore) < 0
    || !Array.isArray(raw.records) || raw.records.length < 1 || raw.records.length > ACTIONS_RECORDS.length) {
    block("Actions 迁移检查点格式无效，未继续清理旧记录。");
  }
  const currentKeys = new Set<string>();
  for (const entry of raw.records) {
    const item = object(entry) ? ACTIONS_RECORDS.find((item) => item.current === entry.currentKey) : undefined;
    if (!item || !object(entry) || currentKeys.has(item.current) || !hash(entry.currentHash) || !Array.isArray(entry.oldHashes)
      || entry.oldHashes.length !== 3) block("Actions 迁移检查点格式无效，未继续清理旧记录。");
    const oldKeys = new Set<string>();
    for (const pair of entry.oldHashes) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || oldKeys.has(pair[0])
        || ![item.previous, item.migrated, item.legacy].some((key) => key === pair[0]) || pair[1] !== null && !hash(pair[1])) {
        block("Actions 迁移检查点格式无效，未继续清理旧记录。");
      }
      oldKeys.add(pair[0]);
    }
    currentKeys.add(item.current);
  }
  const value = raw as unknown as ActionsCheckpoint;
  let matches = true;
  for (const action of actions) {
    const record = value.records.find((item) => item.currentKey === action.currentKey);
    if (action.current === null || !record || record.currentHash !== await sha256Hex(action.current)) { matches = false; break; }
    for (const [key, ciphertext] of action.oldRecords) {
      // Missing old records may already have been deleted by an interrupted pass.
      if (ciphertext !== null && record.oldHashes.find(([name]) => name === key)?.[1] !== await sha256Hex(ciphertext)) matches = false;
    }
  }
  return { stored, value, matches };
}

async function assertActionsState(env: Env, action: ActionsRelocation, expectedCurrent: string | null): Promise<void> {
  for (const [key, expected] of action.oldRecords) {
    if (await env.SUBPILOT_CONFIG.get(key) !== expected) block("Actions 旧记录已变化，请重新预览；未继续写入或清理。");
  }
  if (await env.SUBPILOT_CONFIG.get(action.currentKey) !== expectedCurrent) block("Actions 正式记录已变化，请重新预览；未覆盖现有记录。");
}

async function confirmActionsCurrent(env: Env, action: ActionsRelocation, secret: string): Promise<void> {
  const stored = await env.SUBPILOT_CONFIG.get(action.currentKey);
  if (stored !== action.expected) block("Actions 正式记录尚未确认或已变化，未继续清理旧记录；请重新预览。");
  await validateActionsRecord(action.kind, stored, secret);
}

async function planReadToken(read: MigrationReadSet, secret: string, changes: string[], writes: MigrationWrite[]): Promise<void> {
  const latest = async (prefix: string) => (await read.list(prefix)).at(-1);
  let key = await latest("auth:read_token_rotation:");
  if (!key) {
    for (const fixed of ["auth:read_token_record", "auth:read_token_record:migrated"]) {
      if (await read.get(fixed) !== null) { key = fixed; break; }
    }
  }
  key ??= await latest("auth:read_token_migration:");
  key ??= await latest("auth:read_token_initial:");
  if (key) {
    const stored = await read.get(key);
    if (stored === null) block("订阅令牌记录暂时不可读，请稍后重试。");
    let value: unknown;
    try { value = await decryptJson(secret, stored); }
    catch { block("订阅令牌记录无法解密，未修改数据。"); }
    if (!object(value) || value.version !== 1 || typeof value.token !== "string" || !value.token
      || value.hash !== await sha256Hex(value.token)
      || value.rotatedAt !== undefined && (!Number.isSafeInteger(value.rotatedAt) || Number(value.rotatedAt) < 0)) {
      block("订阅令牌记录校验失败，未修改数据。");
    }
    return;
  }
  const stored = await read.get("auth:read_token");
  const hash = await read.get("auth:read_token_hash");
  if (stored === null && hash === null) return;
  if (stored === null || hash === null || !/^[a-f0-9]{64}$/i.test(hash)) block("旧订阅令牌不完整，无法保留原订阅链接；请先在旧版修复令牌记录。");
  let token: string;
  try { token = await decryptText(secret, stored); }
  catch { block("旧订阅令牌无法解密，未修改数据。"); }
  if (!token || await sha256Hex(token) !== hash.toLowerCase()) block("旧订阅令牌与校验值不匹配，未修改数据。");
  writes.push({ key: `auth:read_token_migration:v233:${await sha256Hex(stored)}`, value: { version: 1, token, hash: hash.toLowerCase() } });
  changes.push("保留原订阅令牌并转换为完整加密记录，订阅链接不变。");
}

async function buildPlan(env: Env): Promise<MigrationPlan> {
  const read = new MigrationReadSet(env);
  const source = await selectSnapshot(read);
  if (!source) return { result: { status: "empty", changes: [], blockers: [] }, records: [...read.values], writes: [], actions: [] };
  const secret = requireSecret(env, "CONFIG_ENCRYPTION_KEY");
  let snapshot: unknown;
  try { snapshot = await decryptJson(secret, source.stored); }
  catch { block("最新配置快照无法解密，未回退到旧快照；请检查原加密密钥。"); }
  if (!object(snapshot) || snapshot.version !== 2 || !object(snapshot.config)) block("仅支持 v2.3.3 的版本 2 加密快照封装。");
  const raw = structuredClone(snapshot.config);
  const changes: string[] = [];
  if (Array.isArray(raw.sources) && raw.sources.some((item) => object(item) && Object.hasOwn(item, "urlEncrypted"))) {
    await canonicalizeSources(raw, secret, changes);
  }
  let transformed: ReturnType<typeof migrateV233Document>;
  try { transformed = migrateV233Document(raw); }
  catch (error) { block(error instanceof Error ? error.message : "旧配置无法安全转换。"); }
  changes.push(...transformed.changes);
  const writes: MigrationWrite[] = [];
  const actions: ActionsRelocation[] = [];
  await planActions(read, secret, changes, actions);
  const checkpoint = actions.length ? await readActionsCheckpoint(read, secret, actions) : undefined;
  await planReadToken(read, secret, changes, writes);
  let snapshotKey: string | undefined;
  if (transformed.changes.length || changes.some((item) => item.startsWith("将旧订阅源")) || !source.key.startsWith(CONFIG_SNAPSHOT_VERSION_PREFIX)) {
    if (source.key.endsWith(SUFFIX)) block("已迁移快照仍包含旧字段，请检查配置后重试。");
    if (source.key.startsWith(CONFIG_SNAPSHOT_VERSION_PREFIX)) snapshotKey = `${source.key}${SUFFIX}`;
    else {
      const rawTime = snapshot.config.updatedAt;
      const time = rawTime === undefined ? 0 : typeof rawTime === "string" ? Date.parse(rawTime) : NaN;
      if (!Number.isSafeInteger(time) || time < 0 || time > Date.now()) block("旧快照的更新时间无效，无法安全确定配置顺序。");
      snapshotKey = `${CONFIG_SNAPSHOT_VERSION_PREFIX}${String(MAX_TIME - time).padStart(16, "0")}:${MAX_TIME}:~legacy:${await sha256Hex(source.key)}${SUFFIX}`;
      changes.push("将旧固定位置快照保存为当前版本快照。");
    }
  }
  const revision = await read.revision();
  const pending = checkpoint?.matches && checkpoint.value && checkpoint.value.notBefore > Date.now();
  return {
    result: {
      status: pending ? "pending" : snapshotKey || writes.length || actions.length ? "ready" : "current", revision, changes, blockers: [],
      ...(pending ? { retryAfterSeconds: Math.max(1, Math.ceil((checkpoint!.value!.notBefore - Date.now()) / 1000)) } : {})
    },
    records: [...read.values], source, document: transformed.document, ...(snapshotKey ? { snapshotKey } : {}), writes, actions,
    ...(checkpoint ? { checkpoint } : {})
  };
}

function blockedResult(error: unknown): V233MigrationStatus {
  return { status: "blocked", changes: [], blockers: [error instanceof MigrationBlockedError ? error.message : "迁移未完成，请重新预览后重试；旧 Actions 记录仅在备份与正式记录验证后清理。"] };
}

export async function previewV233Migration(env: Env): Promise<V233MigrationStatus> {
  try { return (await buildPlan(env)).result; }
  catch (error) { return blockedResult(error); }
}

/** Explicit administrator action only. No normal read or scheduled path invokes it. */
export async function applyV233Migration(env: Env, revision: string): Promise<V233MigrationStatus> {
  try {
    const plan = await buildPlan(env);
    if (plan.result.status !== "ready") return plan.result;
    if (plan.result.revision !== revision) block("配置或凭据已变化，请重新预览后再迁移。");
    const secret = requireSecret(env, "CONFIG_ENCRYPTION_KEY");
    const backupKey = `${BACKUP_PREFIX}${revision}`;
    const backup = { version: 1, migration: "v233-v1", revision, records: plan.records };
    const oldBackup = await env.SUBPILOT_CONFIG.get(backupKey);
    if (oldBackup === null) {
      const encryptedBackup = await encryptJson(secret, backup);
      if (new TextEncoder().encode(encryptedBackup).byteLength > 20 * 1024 * 1024) block("原始记录备份超过单条安全大小，未修改配置。");
      await env.SUBPILOT_CONFIG.put(backupKey, encryptedBackup);
    }
    const storedBackup = await env.SUBPILOT_CONFIG.get(backupKey);
    if (storedBackup === null || JSON.stringify(await decryptJson(secret, storedBackup)) !== JSON.stringify(backup)) block("原始加密记录备份校验未完成，未继续迁移。");
    if ((await buildPlan(env)).result.revision !== revision) block("备份后配置或凭据已变化，请重新预览后再迁移。");
    for (const action of plan.actions) {
      await assertActionsState(env, action, action.current);
      if (action.current === null) await env.SUBPILOT_CONFIG.put(action.currentKey, action.expected);
      await confirmActionsCurrent(env, action, secret);
    }
    for (const write of plan.writes) {
      const expected = write.stored ?? await encryptJson(secret, write.value);
      const existing = await env.SUBPILOT_CONFIG.get(write.key);
      if (existing !== null && JSON.stringify(await decryptJson(secret, existing)) !== JSON.stringify(await decryptJson(secret, expected))) {
        block("迁移目标记录已变化，未覆盖现有记录；请重新预览。");
      }
      if (existing === null) await env.SUBPILOT_CONFIG.put(write.key, expected);
      const verified = await env.SUBPILOT_CONFIG.get(write.key);
      if (verified === null || JSON.stringify(await decryptJson(secret, verified)) !== JSON.stringify(await decryptJson(secret, expected))) block("迁移记录写入校验未完成，请重新预览后重试。");
    }
    if (plan.snapshotKey) {
      const expected = { version: 2, config: normalizeConfigDocument(plan.document!) };
      const existing = await env.SUBPILOT_CONFIG.get(plan.snapshotKey);
      if (existing !== null && JSON.stringify(await decryptJson(secret, existing)) !== JSON.stringify(expected)) block("迁移快照已变化，未覆盖现有快照；请重新预览。");
      if (existing === null) await env.SUBPILOT_CONFIG.put(plan.snapshotKey, await encryptJson(secret, expected));
      const verified = await env.SUBPILOT_CONFIG.get(plan.snapshotKey);
      if (verified === null || JSON.stringify(await decryptJson(secret, verified)) !== JSON.stringify(expected)) block("迁移快照写入校验未完成，请重新预览后重试。");
    }
    if (plan.actions.length) {
      const checkpoint = plan.checkpoint!;
      const pending = (): V233MigrationStatus => ({ status: "pending", changes: plan.result.changes, blockers: [], backupKey, retryAfterSeconds: Math.ceil(ACTIONS_PROPAGATION_MS / 1000) });
      if (!checkpoint.matches) {
        const records: ActionsCheckpoint["records"] = [];
        for (const action of plan.actions) {
          await assertActionsState(env, action, action.expected);
          const oldHashes: [string, string | null][] = [];
          for (const [key, stored] of action.oldRecords) oldHashes.push([key, stored === null ? null : await sha256Hex(stored)]);
          records.push({ currentKey: action.currentKey, currentHash: await sha256Hex(action.expected), oldHashes });
        }
        if (await env.SUBPILOT_CONFIG.get(ACTIONS_CHECKPOINT_KEY) !== checkpoint.stored) block("Actions 迁移检查点已变化，请重新预览后继续。");
        const value: ActionsCheckpoint = { version: 1, notBefore: Date.now() + ACTIONS_PROPAGATION_MS, records };
        const stored = await encryptJson(secret, value);
        await env.SUBPILOT_CONFIG.put(ACTIONS_CHECKPOINT_KEY, stored);
        if (await env.SUBPILOT_CONFIG.get(ACTIONS_CHECKPOINT_KEY) !== stored) block("Actions 迁移检查点写入尚未确认，旧记录尚未清理；请稍后重新预览。");
        return pending();
      }
      if (!checkpoint.value || Date.now() < checkpoint.value.notBefore) return pending();
      for (const action of plan.actions) {
        await assertActionsState(env, action, action.expected);
        for (const [key, expected] of action.oldRecords) {
          if (expected === null) continue;
          if (await env.SUBPILOT_CONFIG.get(ACTIONS_CHECKPOINT_KEY) !== checkpoint.stored) block("Actions 迁移检查点已变化，未继续清理；请重新预览。");
          const stored = await env.SUBPILOT_CONFIG.get(key);
          if (stored === null) continue;
          if (stored !== expected) block("Actions 旧记录已变化，未继续清理；请重新预览。");
          await confirmActionsCurrent(env, action, secret);
          await env.SUBPILOT_CONFIG.delete(key);
          const remaining = await env.SUBPILOT_CONFIG.get(key);
          if (remaining !== null) {
            if (remaining !== expected) block("Actions 旧记录在清理期间发生变化，请重新预览；加密备份已保留。");
            return pending();
          }
        }
        await confirmActionsCurrent(env, action, secret);
        for (const [key] of action.oldRecords) {
          if (await env.SUBPILOT_CONFIG.get(key) !== null) block("Actions 旧记录清理尚未全部确认，请重新预览；加密备份已保留。");
        }
      }
    }
    return { status: "applied", revision, changes: plan.result.changes, blockers: [], backupKey };
  } catch (error) { return blockedResult(error); }
}
