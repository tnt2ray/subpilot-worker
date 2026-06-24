import { DEFAULT_CONFIG } from "./default-config";
import { DEFAULT_DISPLAY_TIME_ZONE } from "./util";

export const CURRENT_KV_SCHEMA_VERSION = 3;
export const CONFIG_SCHEMA_VERSION_KEY = "config:schemaVersion";

type MigrationStep = {
  from: number;
  to: number;
  run: (env: Env) => Promise<void>;
};

const MIGRATIONS: MigrationStep[] = [
  {
    from: 1,
    to: 2,
    run: async (env) => {
      const key = "config:settings:displayTimeZone";
      if (await env.SUBPILOT_CONFIG.get(key) === null) {
        await env.SUBPILOT_CONFIG.put(key, JSON.stringify(DEFAULT_DISPLAY_TIME_ZONE));
      }
    }
  },
  {
    from: 2,
    to: 3,
    run: async (env) => {
      await Promise.all(Object.entries(DEFAULT_CONFIG.stash).map(async ([field, value]) => {
        const key = `config:stash:${field}`;
        if (await env.SUBPILOT_CONFIG.get(key) === null) {
          await env.SUBPILOT_CONFIG.put(key, JSON.stringify(value));
        }
      }));
    }
  }
];

export interface KvSchemaStatus {
  current: number;
  stored: number;
  migrated: boolean;
  pending: number[];
}

export async function readKvSchemaStatus(env: Env): Promise<KvSchemaStatus> {
  const stored = await readStoredSchemaVersion(env);
  return {
    current: CURRENT_KV_SCHEMA_VERSION,
    stored,
    migrated: false,
    pending: pendingSchemaVersions(stored)
  };
}

export async function ensureKvSchema(env: Env): Promise<KvSchemaStatus> {
  return runKvMigrations(env);
}

export async function runKvMigrations(env: Env): Promise<KvSchemaStatus> {
  let stored = await readStoredSchemaVersion(env);
  if (stored > CURRENT_KV_SCHEMA_VERSION) {
    throw new Error(`KV schema version ${stored} is newer than this Worker supports (${CURRENT_KV_SCHEMA_VERSION})`);
  }

  let changed = false;
  if (stored === 0) {
    stored = 1;
    await writeStoredSchemaVersion(env, stored);
    changed = true;
  }

  while (stored < CURRENT_KV_SCHEMA_VERSION) {
    const next = stored + 1;
    const migration = MIGRATIONS.find((item) => item.from === stored && item.to === next);
    if (!migration) {
      throw new Error(`Missing KV migration from schema ${stored} to ${next}`);
    }
    await migration.run(env);
    stored = next;
    await writeStoredSchemaVersion(env, stored);
    changed = true;
  }

  return {
    current: CURRENT_KV_SCHEMA_VERSION,
    stored,
    migrated: changed,
    pending: pendingSchemaVersions(stored)
  };
}

async function readStoredSchemaVersion(env: Env): Promise<number> {
  const raw = await env.SUBPILOT_CONFIG.get(CONFIG_SCHEMA_VERSION_KEY);
  if (raw === null) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function writeStoredSchemaVersion(env: Env, version: number): Promise<void> {
  return env.SUBPILOT_CONFIG.put(CONFIG_SCHEMA_VERSION_KEY, String(version));
}

function pendingSchemaVersions(stored: number): number[] {
  const pending: number[] = [];
  for (let version = stored + 1; version <= CURRENT_KV_SCHEMA_VERSION; version += 1) {
    pending.push(version);
  }
  return pending;
}
