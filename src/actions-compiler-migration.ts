import { decryptJson } from "./crypto-store";
import { requireSecret } from "./secrets";
import { sha256Hex } from "./util";

export const ACTIONS_CREDENTIALS_KEY = "integration:actions-compiler:credentials:v1";
export const ACTIONS_CALLBACK_ORIGIN_KEY = "integration:actions-compiler:callback-origin:v1";
export const ACTIONS_MIGRATED_CREDENTIALS_KEY = "integration:actions-compiler:migrated-credentials:v1";
export const ACTIONS_MIGRATED_CALLBACK_ORIGIN_KEY = "integration:actions-compiler:migrated-callback-origin:v1";
export const ACTIONS_INTEGRATION_MIGRATION_KEY = "integration:actions-compiler:migration:v1";

const RECORD_KEYS = {
  credentials: { current: ACTIONS_CREDENTIALS_KEY, migrated: ACTIONS_MIGRATED_CREDENTIALS_KEY, legacy: "integration:singbox-srs:credentials:v1" },
  callbackOrigin: { current: ACTIONS_CALLBACK_ORIGIN_KEY, migrated: ACTIONS_MIGRATED_CALLBACK_ORIGIN_KEY, legacy: "integration:singbox-srs:callback-origin:v1" }
} as const;
type RecordKind = keyof typeof RECORD_KEYS;
const RECORD_KINDS = ["credentials", "callbackOrigin"] as const;
const GRACE_MS = 5 * 60_000;
const MAX_KEYS = 200;
const PAGE_SIZE = 100;
const MAX_PAGES = 4;
const CLEANUP_PREFIXES = [
  "integration:singbox-srs:batch-protocol:",
  "cache:singboxSrs:",
  "cache:v2:sing-box:compiledRuleSet:"
] as const;
const SRS_RECEIPT = /:combined:sing-box:srs:[a-f0-9]{64}:complete$/;
const HASH = /^[a-f0-9]{64}$/;

interface MigrationState {
  version: 1;
  phase: "copy" | "grace" | "cleanup" | "done";
  notBefore: number;
  stage: number;
  cursor?: string;
  hashes: Record<RecordKind, string | null>;
  sweepHadDeletes: boolean;
  retire: Partial<Record<RecordKind, { hash: string; notBefore: number }>>;
}

/** A present record is authoritative even when empty or unreadable. Callers validate it. */
export async function readActionsIntegrationRecord(env: Env, kind: RecordKind): Promise<string | null> {
  const keys = RECORD_KEYS[kind];
  const current = await env.SUBPILOT_CONFIG.get(keys.current);
  if (current !== null) return current;
  const migrated = await env.SUBPILOT_CONFIG.get(keys.migrated);
  if (migrated !== null) return migrated;
  const state = parseState(await env.SUBPILOT_CONFIG.get(ACTIONS_INTEGRATION_MIGRATION_KEY));
  return state?.phase === "done" ? null : env.SUBPILOT_CONFIG.get(keys.legacy);
}

/** Run only from scheduled maintenance; request reads never copy, list or delete records. */
export async function maintainActionsIntegrationMigration(env: Env, deadline = Date.now() + 25_000): Promise<void> {
  const cutoff = Math.min(deadline, Date.now() + 25_000);
  checkDeadline(cutoff);
  const stored = await env.SUBPILOT_CONFIG.get(ACTIONS_INTEGRATION_MIGRATION_KEY);
  const state = parseState(stored) ?? {
    version: 1, phase: "copy", notBefore: 0, stage: 0,
    hashes: { credentials: null, callbackOrigin: null }, sweepHadDeletes: false, retire: {}
  } satisfies MigrationState;
  const before = JSON.stringify(state);
  try {
    if (state.phase === "done") {
      await retireMigratedRecords(env, state, cutoff);
      return;
    }
    const preserved = await preserveRecords(env, cutoff);
    if (state.phase === "copy" || RECORD_KINDS.some((kind) => state.hashes[kind] !== preserved.hashes[kind])) {
      state.hashes = preserved.hashes;
      restartGrace(state);
      return;
    }
    if (Date.now() < state.notBefore) return;
    state.phase = "cleanup";
    let processed = 0;
    for (const kind of RECORD_KINDS) {
      if (!preserved.legacyPresent[kind]) continue;
      checkDeadline(cutoff);
      await env.SUBPILOT_CONFIG.delete(RECORD_KEYS[kind].legacy);
      state.sweepHadDeletes = true;
      processed += 1;
    }
    // Persist the cursor only after every selected deletion on its page succeeds.
    // A failed or interrupted page is safe to replay on the next cron invocation.
    for (let pages = 0; state.stage < CLEANUP_PREFIXES.length && pages < MAX_PAGES && processed < MAX_KEYS; pages += 1) {
      checkDeadline(cutoff);
      const prefix = CLEANUP_PREFIXES[state.stage]!;
      const page = await env.SUBPILOT_CONFIG.list({ prefix, limit: Math.min(PAGE_SIZE, MAX_KEYS - processed), ...(state.cursor ? { cursor: state.cursor } : {}) });
      const selected = page.keys.filter(({ name }) => name.startsWith(prefix)
        && (state.stage !== 2 || SRS_RECEIPT.test(name)));
      for (let offset = 0; offset < selected.length; offset += 10) {
        checkDeadline(cutoff);
        const results = await Promise.allSettled(selected.slice(offset, offset + 10).map(({ name }) => env.SUBPILOT_CONFIG.delete(name)));
        if (results.some((result) => result.status === "fulfilled")) state.sweepHadDeletes = true;
        if (results.some((result) => result.status === "rejected")) throw new Error("Actions migration cleanup is incomplete.");
      }
      processed += page.keys.length;
      if (page.list_complete) {
        state.stage += 1;
        delete state.cursor;
      } else {
        if (!page.cursor || page.cursor === state.cursor) throw new Error("Actions migration listing did not advance.");
        state.cursor = page.cursor;
      }
    }
    if (state.stage === CLEANUP_PREFIXES.length) {
      if (state.sweepHadDeletes) restartGrace(state);
      else {
        await retireMigratedRecords(env, state, cutoff);
        state.phase = "done";
      }
    }
  } finally {
    // One checkpoint per invocation avoids repeatedly writing this fixed KV key.
    const next = JSON.stringify(state);
    if (stored === null || next !== before) await env.SUBPILOT_CONFIG.put(ACTIONS_INTEGRATION_MIGRATION_KEY, next);
  }
}

async function preserveRecords(env: Env, deadline: number): Promise<{
  hashes: Record<RecordKind, string | null>;
  legacyPresent: Record<RecordKind, boolean>;
}> {
  const hashes: Record<RecordKind, string | null> = { credentials: null, callbackOrigin: null };
  const legacyPresent = { credentials: false, callbackOrigin: false };
  for (const kind of RECORD_KINDS) {
    checkDeadline(deadline);
    const keys = RECORD_KEYS[kind];
    const current = await env.SUBPILOT_CONFIG.get(keys.current);
    const legacy = await env.SUBPILOT_CONFIG.get(keys.legacy);
    legacyPresent[kind] = legacy !== null;
    if (current !== null) {
      await validateRecord(env, kind, current);
      hashes[kind] = await sha256Hex(current);
      continue;
    }
    let migrated = await env.SUBPILOT_CONFIG.get(keys.migrated);
    if (migrated === null && legacy !== null) {
      await validateRecord(env, kind, legacy);
      checkDeadline(deadline);
      // Never write the user-owned primary key: a concurrent clear remains authoritative.
      await env.SUBPILOT_CONFIG.put(keys.migrated, legacy);
      migrated = await env.SUBPILOT_CONFIG.get(keys.migrated);
      if (migrated !== legacy) throw new Error("Actions migration copy is not yet verified.");
    }
    if (migrated !== null) {
      await validateRecord(env, kind, migrated);
      if (legacy !== null && legacy !== migrated) throw new Error("Actions migration source changed; cleanup is deferred.");
      hashes[kind] = await sha256Hex(migrated);
    }
  }
  return { hashes, legacyPresent };
}

/** Reclaim a candidate only after the same valid primary has survived a full grace period. */
async function retireMigratedRecords(env: Env, state: MigrationState, deadline: number): Promise<void> {
  for (const kind of RECORD_KINDS) {
    checkDeadline(deadline);
    const keys = RECORD_KEYS[kind];
    const candidate = await env.SUBPILOT_CONFIG.get(keys.migrated);
    if (candidate === null) {
      delete state.retire[kind];
      continue;
    }
    const current = await env.SUBPILOT_CONFIG.get(keys.current);
    if (current === null) {
      delete state.retire[kind];
      continue;
    }
    await validateRecord(env, kind, current);
    const hash = await sha256Hex(current);
    const previous = state.retire[kind];
    if (!previous || previous.hash !== hash) {
      state.retire[kind] = { hash, notBefore: Date.now() + GRACE_MS };
      continue;
    }
    if (Date.now() < previous.notBefore) continue;
    checkDeadline(deadline);
    if (await env.SUBPILOT_CONFIG.get(keys.current) !== current) continue;
    await env.SUBPILOT_CONFIG.delete(keys.migrated);
    delete state.retire[kind];
  }
}

async function validateRecord(env: Env, kind: RecordKind, ciphertext: string): Promise<void> {
  try {
    const value = await decryptJson<Record<string, unknown>>(requireSecret(env, "CONFIG_ENCRYPTION_KEY"), ciphertext);
    if (!value || Array.isArray(value) || value.version !== 1) throw new Error();
    if (kind === "credentials") {
      if (!(value.token === "" || typeof value.token === "string" && /^[A-Za-z0-9_]{20,255}$/.test(value.token))
        || !(value.sharedSecret === "" || typeof value.sharedSecret === "string" && /^[\x21-\x7e]{32,256}$/.test(value.sharedSecret))) throw new Error();
    } else {
      if (typeof value.origin !== "string") throw new Error();
      const origin = new URL(value.origin);
      if (origin.protocol !== "https:" || origin.origin !== value.origin || origin.username || origin.password || origin.port) throw new Error();
    }
  } catch {
    throw new Error("Actions migration record validation failed; legacy data was retained.");
  }
}

function restartGrace(state: MigrationState): void {
  state.phase = "grace";
  state.notBefore = Date.now() + GRACE_MS;
  state.stage = 0;
  state.sweepHadDeletes = false;
  delete state.cursor;
}

function checkDeadline(deadline: number): void {
  if (Date.now() >= deadline) throw new Error("Actions migration maintenance reached its deadline.");
}

function parseState(stored: string | null): MigrationState | null {
  if (stored === null) return null;
  try {
    const state = JSON.parse(stored) as MigrationState;
    if (!state || typeof state !== "object" || Array.isArray(state) || state.version !== 1 || !["copy", "grace", "cleanup", "done"].includes(state.phase)
      || !Number.isSafeInteger(state.notBefore) || state.notBefore < 0
      || !Number.isInteger(state.stage) || state.stage < 0 || state.stage > CLEANUP_PREFIXES.length
      || (state.cursor !== undefined && typeof state.cursor !== "string")
      || typeof state.sweepHadDeletes !== "boolean"
      || !state.hashes || typeof state.hashes !== "object" || Array.isArray(state.hashes)
      || !state.retire || typeof state.retire !== "object" || Array.isArray(state.retire)) throw new Error();
    for (const kind of RECORD_KINDS) {
      if (state.hashes[kind] !== null && (typeof state.hashes[kind] !== "string" || !HASH.test(state.hashes[kind]))) throw new Error();
      const retire = state.retire[kind];
      if (retire && (typeof retire.hash !== "string" || !HASH.test(retire.hash) || !Number.isSafeInteger(retire.notBefore) || retire.notBefore < 0)) throw new Error();
    }
    return state;
  } catch {
    throw new Error("Actions migration state is unreadable; cleanup is deferred.");
  }
}
