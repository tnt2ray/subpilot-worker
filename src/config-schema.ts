import { DEFAULT_CONFIG } from "./default-config";
import { listKvKeys, readKvJson } from "./kv-helpers";
import {
  SOURCE_CACHE_META_INDEX_KEY,
  SOURCE_CACHE_META_PREFIX,
  SOURCE_CACHE_PREFIX,
  sourceCacheContentStats,
  type SourceCacheEntry
} from "./source-cache";
import { CHAIN_EXIT_PROTOCOLS, CHAIN_EXIT_PROXY_NAME, type ChainExitProtocol, type StaticProxyNodeConfig } from "./types";
import { DEFAULT_DISPLAY_TIME_ZONE } from "./util";

export const CURRENT_KV_SCHEMA_VERSION = 10;
export const CONFIG_SCHEMA_VERSION_KEY = "config:schemaVersion";
const LEGACY_DEFAULT_CHAIN_FILTER = ["JP", "KR", "TW"];

type SourceCacheMigrationEntry = Omit<SourceCacheEntry, "contentAvailable" | "nodeCount" | "protocolCounts">;

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
  },
  {
    from: 3,
    to: 4,
    run: async (env) => {
      const oldExitProxyKey = "config:chain:exitProxy";
      const oldExitProxy = await readKvJson<Record<string, unknown>>(env, oldExitProxyKey);
      const legacyChainFilter = await readLegacyChainFilter(env);
      const migratedNode = normalizeLegacyExitProxy(oldExitProxy, legacyChainFilter);
      if (migratedNode) {
        const indexKey = "config:proxyNodes:index";
        const nodeKey = `config:proxyNodes:${encodeURIComponent(migratedNode.id)}`;
        const previousIndexValue = await readKvJson<unknown>(env, indexKey);
        const previousIndex = Array.isArray(previousIndexValue)
          ? previousIndexValue.map((item) => typeof item === "string" ? item : "").filter(Boolean)
          : [];
        const nextIndex = previousIndex.includes(migratedNode.id)
          ? previousIndex
          : [...previousIndex, migratedNode.id];
        if (await env.SUBPILOT_CONFIG.get(nodeKey) === null) {
          await env.SUBPILOT_CONFIG.put(nodeKey, JSON.stringify(migratedNode));
        }
        await env.SUBPILOT_CONFIG.put(indexKey, JSON.stringify(nextIndex));
      }
      await env.SUBPILOT_CONFIG.delete(oldExitProxyKey);
    }
  },
  {
    from: 4,
    to: 5,
    run: async (env) => {
      const indexKey = "config:proxyNodes:index";
      const indexValue = await readKvJson<unknown>(env, indexKey);
      const ids = Array.isArray(indexValue)
        ? indexValue.map((item) => typeof item === "string" ? item : "").filter(Boolean)
        : [];
      await Promise.all(ids.map(async (id, index) => {
        const nodeKey = `config:proxyNodes:${encodeURIComponent(id)}`;
        const node = await readKvJson<Record<string, unknown>>(env, nodeKey);
        const migrated = migrateProxyNodeConfig(node, index);
        if (migrated) {
          await env.SUBPILOT_CONFIG.put(nodeKey, JSON.stringify(migrated));
        }
      }));
    }
  },
  {
    from: 5,
    to: 6,
    run: async (env) => {
      const legacyChainFilter = await readLegacyChainFilter(env);
      const indexKey = "config:proxyNodes:index";
      const indexValue = await readKvJson<unknown>(env, indexKey);
      const ids = Array.isArray(indexValue)
        ? indexValue.map((item) => typeof item === "string" ? item : "").filter(Boolean)
        : [];
      await Promise.all(ids.map(async (id) => {
        const nodeKey = `config:proxyNodes:${encodeURIComponent(id)}`;
        const node = await readKvJson<Record<string, unknown>>(env, nodeKey);
        const migrated = migrateProxyNodeChainFilter(node, legacyChainFilter);
        if (migrated) {
          await env.SUBPILOT_CONFIG.put(nodeKey, JSON.stringify(migrated));
        }
      }));
      await env.SUBPILOT_CONFIG.delete("config:chain:filter");
    }
  },
  {
    from: 6,
    to: 7,
    run: async (env) => {
      await migrateChainPolicyGroupSelectors(env);
    }
  },
  {
    from: 7,
    to: 8,
    run: async (env) => {
      await migrateLegacyChainExitExcludes(env);
    }
  },
  {
    from: 8,
    to: 9,
    run: async (env) => {
      await migrateGroupSpecs(env, migrateChainSelectorSpec);
      await migrateLegacyChainExitExcludes(env);
      await migrateProxyNodeGroupInclusion(env);
    }
  },
  {
    from: 9,
    to: 10,
    run: async (env) => {
      await migrateSourceCacheMetadataStats(env);
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

async function readLegacyChainFilter(env: Env): Promise<string[]> {
  const value = await readKvJson<unknown>(env, "config:chain:filter");
  return legacyFilterArray(value, LEGACY_DEFAULT_CHAIN_FILTER);
}

function normalizeLegacyExitProxy(value: Record<string, unknown> | null, chainFilter: string[]): StaticProxyNodeConfig | null {
  if (!value || typeof value !== "object") return null;
  const server = typeof value.server === "string" ? value.server.trim() : "";
  const port = legacyPort(value.port);
  if (!server || !port) return null;
  const protocol = legacyProtocol(value.protocol);
  return {
    id: "legacy-chain-exit",
    config: `${CHAIN_EXIT_PROXY_NAME} = ${protocol}, ${legacyProxyNodeParams({ ...value, protocol, server, port })}`,
    chainFilter,
    enabled: true,
    chainExit: true,
    includeInGroups: false
  };
}

function migrateProxyNodeConfig(value: Record<string, unknown> | null, index: number): StaticProxyNodeConfig | null {
  if (!value || typeof value !== "object") return null;
  const protocol = legacyProtocol(value.protocol);
  const config = typeof value.config === "string" && value.config.trim()
    ? value.config.trim()
    : legacyProxyNodeConfig(value, protocol, index);
  if (!config) return null;
  const id = typeof value.id === "string" && value.id.trim() ? value.id.trim() : `proxy-node-${index + 1}`;
  return {
    id,
    config,
    chainFilter: legacyFilterArray(value.chainFilter, []),
    enabled: value.enabled !== false,
    chainExit: value.chainExit === true,
    includeInGroups: value.chainExit === true ? value.includeInGroups === true : true
  };
}

function migrateProxyNodeChainFilter(value: Record<string, unknown> | null, legacyChainFilter: string[]): StaticProxyNodeConfig | null {
  if (!value || typeof value !== "object") return null;
  const id = typeof value.id === "string" && value.id.trim() ? value.id.trim() : "";
  const config = typeof value.config === "string" ? value.config.trim() : "";
  if (!id || !config) return null;
  const existing = legacyFilterArray(value.chainFilter, []);
  return {
    id,
    config,
    chainFilter: existing.length > 0 ? existing : value.chainExit === true ? legacyChainFilter : [],
    enabled: value.enabled !== false,
    chainExit: value.chainExit === true,
    includeInGroups: value.chainExit === true ? value.includeInGroups === true : true
  };
}

function legacyProxyNodeConfig(value: Record<string, unknown>, protocol: ChainExitProtocol, index: number): string {
  const params = legacyProxyNodeParams({ ...value, protocol });
  if (!params) return "";
  const name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : `Proxy Node ${index + 1}`;
  return `${name} = ${protocol}, ${params}`;
}

function legacyProxyNodeParams(value: Record<string, unknown>): string {
  const server = typeof value.server === "string" ? value.server.trim() : "";
  const port = legacyPort(value.port);
  if (!server || !port) return "";
  const protocol = legacyProtocol(value.protocol);
  const username = typeof value.username === "string" ? value.username.trim() : "";
  const password = typeof value.password === "string" ? value.password.trim() : "";
  const parts = [server, String(port)];
  if (protocol === "ss") {
    if (username) parts.push(`encrypt-method=${username}`);
    if (password) parts.push(`password=${password}`);
  } else if (protocol === "snell") {
    if (password) parts.push(`psk=${password}`);
    parts.push("version=4");
  } else if (protocol === "tuic") {
    if (username) parts.push(`username=${username}`);
    if (password) parts.push(`password=${password}`);
  } else if (["trojan", "hysteria2", "anytls"].includes(protocol)) {
    if (password) parts.push(`password=${password}`);
  } else {
    if (username) parts.push(`username=${username}`);
    if (password) parts.push(`password=${password}`);
  }
  return parts.join(", ");
}

function legacyProtocol(value: unknown): ChainExitProtocol {
  return typeof value === "string" && CHAIN_EXIT_PROTOCOLS.includes(value as ChainExitProtocol)
    ? value as ChainExitProtocol
    : "socks5";
}

function legacyPort(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(1, Math.min(65535, Math.floor(parsed)));
}

function legacyFilterArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return [...new Set(value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean))];
}

async function migrateChainPolicyGroupSelectors(env: Env): Promise<void> {
  await migrateGroupSpecs(env, migrateChainSelectorSpec);
}

async function migrateLegacyChainExitExcludes(env: Env): Promise<void> {
  await migrateGroupSpecs(env, removeLegacyChainExitExclude);
}

async function migrateProxyNodeGroupInclusion(env: Env): Promise<void> {
  const indexKey = "config:proxyNodes:index";
  const indexValue = await readKvJson<unknown>(env, indexKey);
  const ids = Array.isArray(indexValue)
    ? indexValue.map((item) => typeof item === "string" ? item : "").filter(Boolean)
    : [];
  await Promise.all(ids.map(async (id) => {
    const nodeKey = `config:proxyNodes:${encodeURIComponent(id)}`;
    const node = await readKvJson<Record<string, unknown>>(env, nodeKey);
    const migrated = migrateProxyNodeGroupInclusionRecord(node);
    if (migrated) {
      await env.SUBPILOT_CONFIG.put(nodeKey, JSON.stringify(migrated));
    }
  }));
}

async function migrateGroupSpecs(env: Env, transform: (spec: string) => string): Promise<void> {
  const indexValue = await readKvJson<unknown>(env, "config:groups:index");
  const names = Array.isArray(indexValue)
    ? indexValue.map((item) => typeof item === "string" ? item : "").filter(Boolean)
    : [];
  await Promise.all(names.map(async (name) => {
    const key = `config:groups:${encodeURIComponent(name)}`;
    const spec = await env.SUBPILOT_CONFIG.get(key);
    if (spec === null) return;
    const migrated = transform(spec);
    if (migrated !== spec) {
      await env.SUBPILOT_CONFIG.put(key, migrated);
    }
  }));
}

function migrateChainSelectorSpec(spec: string): string {
  return spec.replace(/\{all[^}]*\}/g, (selector) => selector
    .replace(/filter=([^}]*?)(?=\s+exclude=|})/g, (_match, value: string) => `filter=${migrateChainSelectorTerms(value)}`)
    .replace(/exclude=([^}]+)(?=})/g, (_match, value: string) => `exclude=${migrateChainSelectorTerms(value)}`));
}

function migrateChainSelectorTerms(value: string): string {
  return value
    .split(",")
    .map((item) => {
      const term = item.trim();
      return term === "Chain" || term === "-->" ? "via" : term;
    })
    .join(", ");
}

function removeLegacyChainExitExclude(spec: string): string {
  return spec.replace(/\{all[^}]*\}/g, (selector) => {
    const filterMatch = selector.match(/filter=([^}]*?)(?=\s+exclude=|})/);
    const filters = selectorTermList(filterMatch?.[1] ?? "");
    if (!filterMatch || (!filters.includes("-->") && !filters.includes("via"))) {
      return selector;
    }
    return selector.replace(/\s+exclude=([^}]+)(?=})/, (_match, value: string) => {
      const excludes = selectorTermList(value).filter((item) => item !== CHAIN_EXIT_PROXY_NAME);
      return excludes.length > 0 ? ` exclude=${excludes.join(", ")}` : "";
    });
  });
}

function selectorTermList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function migrateProxyNodeGroupInclusionRecord(value: Record<string, unknown> | null): StaticProxyNodeConfig | null {
  if (!value || typeof value !== "object") return null;
  const id = typeof value.id === "string" && value.id.trim() ? value.id.trim() : "";
  const config = typeof value.config === "string" ? value.config.trim() : "";
  if (!id || !config) return null;
  const chainExit = value.chainExit === true;
  return {
    id,
    config,
    chainFilter: legacyFilterArray(value.chainFilter, []),
    enabled: value.enabled !== false,
    chainExit,
    includeInGroups: chainExit ? value.includeInGroups === true : true
  };
}

async function migrateSourceCacheMetadataStats(env: Env): Promise<void> {
  const metaKeys = (await listKvKeys(env, SOURCE_CACHE_META_PREFIX)).filter((key) => key !== SOURCE_CACHE_META_INDEX_KEY);
  const migratedByCacheKey = new Map<string, SourceCacheEntry>();

  await Promise.all(metaKeys.map(async (metaKey) => {
    const entry = normalizeSourceCacheMigrationEntry(await readKvJson<unknown>(env, metaKey))[0];
    if (!entry) return;
    const migrated = await addSourceCacheStats(env, entry);
    migratedByCacheKey.set(migrated.key, migrated);
    await env.SUBPILOT_CONFIG.put(metaKey, JSON.stringify(migrated));
  }));

  const indexed = await readKvJson<unknown>(env, SOURCE_CACHE_META_INDEX_KEY);
  if (!Array.isArray(indexed)) return;
  const migratedIndex = await Promise.all(indexed.flatMap(normalizeSourceCacheMigrationEntry).map(async (entry) => {
    const cached = migratedByCacheKey.get(entry.key);
    return cached ?? addSourceCacheStats(env, entry);
  }));
  await env.SUBPILOT_CONFIG.put(SOURCE_CACHE_META_INDEX_KEY, JSON.stringify(dedupeSourceCacheMigrationEntries(migratedIndex)));
}

async function addSourceCacheStats(env: Env, entry: SourceCacheMigrationEntry): Promise<SourceCacheEntry> {
  const content = await env.SUBPILOT_CONFIG.get(entry.key);
  return {
    ...entry,
    contentAvailable: content !== null,
    ...(content ? sourceCacheContentStats(content, entry.sourceId) : { nodeCount: 0, protocolCounts: [] })
  };
}

function normalizeSourceCacheMigrationEntry(value: unknown): SourceCacheMigrationEntry[] {
  if (!value || typeof value !== "object") return [];
  const entry = value as Partial<SourceCacheMigrationEntry>;
  if (typeof entry.key !== "string" || !entry.key.startsWith(SOURCE_CACHE_PREFIX)) return [];
  if (typeof entry.fetchedAt !== "string" || Number.isNaN(new Date(entry.fetchedAt).getTime())) return [];
  return [{
    key: entry.key,
    fetchedAt: entry.fetchedAt,
    sourceId: typeof entry.sourceId === "string" ? entry.sourceId : "",
    sourceName: typeof entry.sourceName === "string" ? entry.sourceName : ""
  }];
}

function dedupeSourceCacheMigrationEntries(entries: SourceCacheEntry[]): SourceCacheEntry[] {
  const selected = new Map<string, SourceCacheEntry>();
  for (const entry of entries) {
    const existing = selected.get(entry.key);
    if (!existing || entry.fetchedAt > existing.fetchedAt) {
      selected.set(entry.key, entry);
    }
  }
  return [...selected.values()];
}

function pendingSchemaVersions(stored: number): number[] {
  const pending: number[] = [];
  for (let version = stored + 1; version <= CURRENT_KV_SCHEMA_VERSION; version += 1) {
    pending.push(version);
  }
  return pending;
}
