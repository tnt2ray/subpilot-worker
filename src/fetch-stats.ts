import { lookupIpLocation, type GeoIpLocation } from "./geoip";
import { readSourceCacheStatus, type SourceCacheStatus } from "./source-cache";
import type { AppConfig, Target } from "./types";

const LAST_FETCH_PREFIX = "stats:config:lastFetched:";
const RECENT_FETCHES_KEY = "stats:config:recentFetches";
const RECENT_FETCH_PREFIX = "stats:config:recentFetch:";
export type ConfigFetchTarget = Target;

const TRACKED_TARGETS: ConfigFetchTarget[] = ["surge", "clash", "stash"];
const MAX_STORED_FETCH_RECORDS = 500;
const MAX_RECENT_FETCH_ROWS = MAX_STORED_FETCH_RECORDS;
const MAX_USER_AGENT_LENGTH = 240;
const MAX_IP_ADDRESS_LENGTH = 80;

export interface ConfigFetchLocation {
  countryCode: string;
  city: string;
  region: string;
  colo: string;
  label: string;
  source: "local" | "mmdb" | "cloudflare" | "";
}

export interface ConfigFetchRecord {
  target: ConfigFetchTarget;
  userAgent: string;
  ipAddress: string;
  location: ConfigFetchLocation;
  fetchedAt: string;
}

export interface ConfigFetchStats {
  lastFetched: Record<ConfigFetchTarget, string | null>;
  recentUserAgents: ConfigFetchRecord[];
  sourceCache: SourceCacheStatus;
}

export async function readConfigFetchStats(env: Env, config?: AppConfig): Promise<ConfigFetchStats> {
  const [lastFetchedEntries, recentUserAgents, sourceCache] = await Promise.all([
    Promise.all(TRACKED_TARGETS.map(async (target): Promise<[ConfigFetchTarget, string | null]> => [
      target,
      await env.SUBPILOT_CONFIG.get(lastFetchKey(target))
    ])),
    readRecentFetches(env),
    readSourceCacheStatus(env, config)
  ]);
  return {
    lastFetched: Object.fromEntries(lastFetchedEntries) as Record<ConfigFetchTarget, string | null>,
    recentUserAgents,
    sourceCache
  };
}

export async function recordConfigFetch(env: Env, target: ConfigFetchTarget, request: Request): Promise<void> {
  const ipAddress = extractClientIp(request);
  const record: ConfigFetchRecord = {
    target,
    userAgent: normalizeUserAgent(request.headers.get("user-agent")),
    ipAddress,
    location: await readClientLocation(env, request, ipAddress),
    fetchedAt: new Date().toISOString()
  };
  await Promise.all([
    env.SUBPILOT_CONFIG.put(lastFetchKey(target), record.fetchedAt),
    env.SUBPILOT_CONFIG.put(recentFetchKey(record), JSON.stringify(record))
  ]);
  await pruneRecentFetchRecords(env);
}

function lastFetchKey(target: ConfigFetchTarget): string {
  return `${LAST_FETCH_PREFIX}${target}`;
}

async function readRecentFetches(env: Env): Promise<ConfigFetchRecord[]> {
  const [records, legacyRecords] = await Promise.all([
    readRecentFetchRecordKeys(env).then(async (keys) => {
      const values = await Promise.all(keys.map((key) => env.SUBPILOT_CONFIG.get(key)));
      return values.flatMap(readFetchRecordFromString);
    }),
    readLegacyRecentFetches(env)
  ]);
  return [...records, ...legacyRecords]
    .sort((left, right) => right.fetchedAt.localeCompare(left.fetchedAt))
    .slice(0, MAX_RECENT_FETCH_ROWS);
}

async function readLegacyRecentFetches(env: Env): Promise<ConfigFetchRecord[]> {
  const value = await env.SUBPILOT_CONFIG.get(RECENT_FETCHES_KEY);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap(normalizeFetchRecord).slice(0, MAX_STORED_FETCH_RECORDS);
  } catch {
    return [];
  }
}

function readFetchRecordFromString(value: string | null): ConfigFetchRecord[] {
  if (!value) return [];
  try {
    return normalizeFetchRecord(JSON.parse(value) as unknown);
  } catch {
    return [];
  }
}

function recentFetchKey(record: ConfigFetchRecord): string {
  return `${RECENT_FETCH_PREFIX}${record.fetchedAt}:${crypto.randomUUID()}`;
}

async function pruneRecentFetchRecords(env: Env): Promise<void> {
  const keys = await readRecentFetchRecordKeys(env);
  const staleKeys = keys.slice(MAX_STORED_FETCH_RECORDS);
  if (staleKeys.length === 0) return;
  await Promise.all(staleKeys.map((key) => env.SUBPILOT_CONFIG.delete(key)));
}

async function readRecentFetchRecordKeys(env: Env): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | null = null;
  do {
    const page: KVNamespaceListResult<unknown, string> = await env.SUBPILOT_CONFIG.list(cursor
      ? { prefix: RECENT_FETCH_PREFIX, cursor }
      : { prefix: RECENT_FETCH_PREFIX });
    keys.push(...page.keys.map((key) => key.name));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return keys.sort().reverse();
}

function normalizeFetchRecord(value: unknown): ConfigFetchRecord[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Partial<ConfigFetchRecord>;
  if (!isTrackedTarget(record.target) || typeof record.fetchedAt !== "string") return [];
  const fetchedAt = normalizeFetchTimestamp(record.fetchedAt);
  if (!fetchedAt) return [];
  return [{
    target: record.target,
    fetchedAt,
    userAgent: normalizeUserAgent(record.userAgent),
    ipAddress: normalizeIpAddress(record.ipAddress),
    location: normalizeLocation(record.location)
  }];
}

function isTrackedTarget(value: unknown): value is ConfigFetchTarget {
  return typeof value === "string" && TRACKED_TARGETS.includes(value as ConfigFetchTarget);
}

function normalizeUserAgent(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return (trimmed || "(empty)").slice(0, MAX_USER_AGENT_LENGTH);
}

function normalizeFetchTimestamp(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return Number.isNaN(Date.parse(trimmed)) ? "" : trimmed;
}

function extractClientIp(request: Request): string {
  return normalizeIpAddress(
    request.headers.get("cf-connecting-ip")
      ?? request.headers.get("x-real-ip")
      ?? request.headers.get("x-forwarded-for")?.split(",")[0]
  );
}

function normalizeIpAddress(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return (trimmed || "(unknown)").slice(0, MAX_IP_ADDRESS_LENGTH);
}

async function readClientLocation(env: Env, request: Request, ipAddress: string): Promise<ConfigFetchLocation> {
  const local = ipAddress !== "(unknown)" ? await lookupIpLocation(env, ipAddress).catch(() => null) : null;
  return mergeLocation(local, readCloudflareLocation(request));
}

function readCloudflareLocation(request: Request): Partial<ConfigFetchLocation> {
  const cf = request.cf as Record<string, unknown> | undefined;
  if (!cf) return {};
  const countryCode = normalizeCountryCode(cf.country);
  const city = asString(cf.city).trim();
  const region = asString(cf.region).trim() || asString(cf.regionCode).trim();
  const colo = asString(cf.colo).trim();
  return {
    countryCode,
    city,
    region,
    colo,
    source: countryCode || city || region || colo ? "cloudflare" : ""
  };
}

function mergeLocation(local: GeoIpLocation | null, cloudflare: Partial<ConfigFetchLocation>): ConfigFetchLocation {
  const location = normalizeLocation({
    countryCode: local?.countryCode || cloudflare.countryCode || "",
    city: local?.city || cloudflare.city || "",
    region: local?.region || cloudflare.region || "",
    colo: cloudflare.colo || "",
    source: local?.source || cloudflare.source || ""
  });
  return {
    ...location,
    label: formatLocationLabel(location)
  };
}

function normalizeLocation(value: unknown): ConfigFetchLocation {
  if (!value || typeof value !== "object") return emptyLocation();
  const record = value as Partial<ConfigFetchLocation>;
  const location: ConfigFetchLocation = {
    countryCode: normalizeCountryCode(record.countryCode),
    city: asString(record.city).trim(),
    region: asString(record.region).trim(),
    colo: asString(record.colo).trim(),
    label: asString(record.label).trim(),
    source: normalizeLocationSource(record.source)
  };
  if (!location.label) location.label = formatLocationLabel(location);
  return location;
}

function emptyLocation(): ConfigFetchLocation {
  return {
    countryCode: "",
    city: "",
    region: "",
    colo: "",
    label: "",
    source: ""
  };
}

function formatLocationLabel(location: ConfigFetchLocation): string {
  return [location.city, location.region, location.countryCode].filter(Boolean).join(", ");
}

function normalizeLocationSource(value: unknown): ConfigFetchLocation["source"] {
  return value === "local" || value === "mmdb" || value === "cloudflare" ? value : "";
}

function normalizeCountryCode(value: unknown): string {
  const code = asString(value).toUpperCase();
  return /^[A-Z0-9]{2}$/.test(code) ? code : "";
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
