import { Buffer } from "node:buffer";
import { Reader, type CountryResponse } from "mmdb-lib";

const GEOIP_CACHE_TTL_SECONDS = 86400;
export const GEOIP_MMDB_KV_KEY = "geoip:mmdb:country";
export const GEOIP_MMDB_META_KV_KEY = "geoip:mmdb:country:meta";
export const GEOIP_MMDB_DATA_PREFIX = `${GEOIP_MMDB_KV_KEY}:data:`;

let geoIpCountryReaderCache: {
  version: string;
  reader: Reader<CountryResponse>;
} | null = null;

export interface RegionInfo {
  name: string;
  labels: string[];
}

export interface GeoIpLocation {
  countryCode: string;
  city: string;
  region: string;
  label: string;
  source: "local" | "mmdb";
}

export interface GeoIpMmdbDescriptor {
  updatedAt: string;
  storageKey: string;
}

interface PreparedGeoIpReader {
  version: string;
  reader: Reader<CountryResponse> | null;
}

export async function lookupIpRegion(env: Env, ip: string): Promise<RegionInfo | null> {
  const location = await lookupIpLocation(env, ip);
  if (!location?.countryCode) return null;
  return countryRegion(location.countryCode);
}

export async function lookupIpRegions(env: Env, ips: string[]): Promise<Map<string, RegionInfo | null>> {
  const prepared = await prepareGeoIpCountryReader(env);
  const regions = new Map<string, RegionInfo | null>();
  for (const ip of [...new Set(ips)]) {
    try {
      const location = await lookupIpLocationWithReader(env, ip, prepared);
      regions.set(ip, location?.countryCode ? countryRegion(location.countryCode) : null);
    } catch {
      regions.set(ip, null);
    }
  }
  return regions;
}

export async function lookupIpLocation(env: Env, ip: string): Promise<GeoIpLocation | null> {
  return lookupIpLocationWithReader(env, ip, undefined);
}

async function lookupIpLocationWithReader(
  env: Env,
  ip: string,
  prepared: PreparedGeoIpReader | undefined
): Promise<GeoIpLocation | null> {
  const descriptor = prepared === undefined ? await readGeoIpMmdbDescriptor(env) : null;
  const version = prepared?.version ?? geoIpMmdbVersion(descriptor);
  const key = `cache:geoip:location:${encodeURIComponent(version)}:${ip}`;
  const cached = geoIpLocationFromCache(await getJsonCache<unknown>(env, key));
  if (cached) return cached;
  const localOverride = localGeoIpRecordToLocation(await getJsonCache<unknown>(env, `geoip:ip:${ip}`), "local");
  if (localOverride) {
    await putJsonCache(env, key, localOverride, GEOIP_CACHE_TTL_SECONDS).catch(() => undefined);
    return localOverride;
  }
  const reader = prepared === undefined
    ? await getGeoIpCountryReaderForDescriptor(env, descriptor)
    : prepared.reader;
  const mmdb = reader ? reader.get(ip) : null;
  const local = localGeoIpRecordToLocation(mmdb, "mmdb");
  if (!local) return null;
  await putJsonCache(env, key, local, GEOIP_CACHE_TTL_SECONDS).catch(() => undefined);
  return local;
}

function countryRegion(countryCode: string): RegionInfo {
  return { name: countryCode, labels: [countryCode] };
}

async function prepareGeoIpCountryReader(env: Env): Promise<PreparedGeoIpReader> {
  const descriptor = await readGeoIpMmdbDescriptor(env);
  return {
    version: geoIpMmdbVersion(descriptor),
    reader: await getGeoIpCountryReaderForDescriptor(env, descriptor)
  };
}

async function getGeoIpCountryReaderForDescriptor(
  env: Env,
  descriptor: GeoIpMmdbDescriptor | null
): Promise<Reader<CountryResponse> | null> {
  if (!descriptor) {
    geoIpCountryReaderCache = null;
    return null;
  }
  const version = geoIpMmdbVersion(descriptor);
  if (geoIpCountryReaderCache?.version === version) return geoIpCountryReaderCache.reader;
  const reader = await loadGeoIpCountryReader(env, descriptor.storageKey);
  if (reader) geoIpCountryReaderCache = { version, reader };
  return reader;
}

async function loadGeoIpCountryReader(env: Env, storageKey: string): Promise<Reader<CountryResponse> | null> {
  const data = await env.SUBPILOT_CONFIG.get(storageKey, "arrayBuffer");
  if (!data) return null;
  return createGeoIpCountryReader(data);
}

export async function readGeoIpMmdbDescriptor(env: Env): Promise<GeoIpMmdbDescriptor | null> {
  const meta = await env.SUBPILOT_CONFIG.get(GEOIP_MMDB_META_KV_KEY, "json") as {
    updatedAt?: unknown;
    storageKey?: unknown;
  } | null;
  if (!meta || typeof meta.updatedAt !== "string" || meta.updatedAt.length > 128) return null;
  if (!Number.isFinite(Date.parse(meta.updatedAt))) return null;
  const storageKey = typeof meta.storageKey === "string" ? meta.storageKey : GEOIP_MMDB_KV_KEY;
  if (storageKey !== GEOIP_MMDB_KV_KEY && (
    !storageKey.startsWith(GEOIP_MMDB_DATA_PREFIX)
    || storageKey.length > 512
    || !/^[A-Za-z0-9:_-]+$/.test(storageKey)
  )) return null;
  return { updatedAt: meta.updatedAt, storageKey };
}

function geoIpMmdbVersion(descriptor: GeoIpMmdbDescriptor | null): string {
  return descriptor ? `${descriptor.updatedAt}:${descriptor.storageKey}` : "none";
}

export function createGeoIpCountryReader(data: ArrayBuffer): Reader<CountryResponse> {
  return new Reader<CountryResponse>(Buffer.from(data));
}

export function resetGeoIpCountryReader(): void {
  geoIpCountryReaderCache = null;
}

function localGeoIpRecordToLocation(data: unknown, source: GeoIpLocation["source"]): GeoIpLocation | null {
  if (typeof data === "string") {
    const countryCode = normalizeCountryCode(data);
    return countryCode ? buildLocation({ countryCode, source }) : null;
  }
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const countryCode = firstCountryCode(
    record.countryCode,
    record.country_code,
    nestedString(record.country, "iso_code"),
    nestedString(record.country, "isoCode"),
    nestedString(record.registered_country, "iso_code"),
    nestedString(record.registered_country, "isoCode"),
    nestedString(record.registeredCountry, "iso_code"),
    nestedString(record.registeredCountry, "isoCode")
  );
  if (!/^[A-Z]{2}$/.test(countryCode)) return null;
  return buildLocation({
    countryCode,
    city: readLocalizedName(record.city) || asString(record.cityName) || asString(record.city_name),
    region: readSubdivisionName(record),
    source
  });
}

function geoIpLocationFromCache(data: unknown): GeoIpLocation | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const countryCode = normalizeCountryCode(record.countryCode ?? record.country_code);
  if (!countryCode) return null;
  const source = record.source === "mmdb" ? "mmdb" : "local";
  return buildLocation({
    countryCode,
    city: asString(record.city),
    region: asString(record.region),
    source
  });
}

function buildLocation(input: { countryCode: string; city?: string; region?: string; source: GeoIpLocation["source"] }): GeoIpLocation {
  const city = input.city?.trim() ?? "";
  const region = input.region?.trim() ?? "";
  return {
    countryCode: input.countryCode,
    city,
    region,
    label: [city, region, input.countryCode].filter(Boolean).join(", "),
    source: input.source
  };
}

function readSubdivisionName(record: Record<string, unknown>): string {
  const direct = asString(record.regionName) || asString(record.region_name) || asString(record.subdivisionName) || asString(record.subdivision_name);
  if (direct) return direct;
  const subdivisions = record.subdivisions;
  if (Array.isArray(subdivisions)) return readLocalizedName(subdivisions[0]);
  return readLocalizedName(record.subdivision);
}

function readLocalizedName(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const names = record.names;
  if (names && typeof names === "object") {
    const localized = names as Record<string, unknown>;
    return asString(localized["zh-CN"]) || asString(localized.zh) || asString(localized.en);
  }
  return asString(record.name);
}

function nestedString(value: unknown, key: string): string {
  if (!value || typeof value !== "object") return "";
  return asString((value as Record<string, unknown>)[key]);
}

function normalizeCountryCode(value: unknown): string {
  const code = asString(value).toUpperCase();
  return /^[A-Z]{2}$/.test(code) && code !== "ZZ" ? code : "";
}

function firstCountryCode(...values: unknown[]): string {
  for (const value of values) {
    const code = normalizeCountryCode(value);
    if (code) return code;
  }
  return "";
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function getJsonCache<T>(env: Env, key: string): Promise<T | null> {
  const value = await env.SUBPILOT_CONFIG.get(key);
  if (value === null) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

async function putJsonCache(env: Env, key: string, value: unknown, ttlSeconds: number): Promise<void> {
  await env.SUBPILOT_CONFIG.put(key, JSON.stringify(value), { expirationTtl: Math.max(30, ttlSeconds) });
}
