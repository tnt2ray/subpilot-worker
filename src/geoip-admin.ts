import {
  createGeoIpCountryReader,
  GEOIP_MMDB_DATA_PREFIX,
  GEOIP_MMDB_KV_KEY,
  GEOIP_MMDB_META_KV_KEY,
  resetGeoIpCountryReader
} from "./geoip";
import { badRequest, jsonResponse, payloadTooLarge, randomToken, readRequestBytesWithLimit, RequestBodyTooLargeError } from "./util";

const MAX_MMDB_BYTES = 25 * 1024 * 1024;
const RETAINED_MMDB_VERSIONS = 3;
const MMDB_PRUNE_GRACE_MS = 10 * 60 * 1000;
const MAX_MMDB_PRUNES_PER_UPLOAD = 20;
interface GeoIpMmdbMeta {
  fileName: string;
  size: number;
  updatedAt: string;
  storageKey: string;
  databaseType?: string;
  builtAt?: string;
}

export async function readGeoIpMmdbStatus(env: Env): Promise<{ uploaded: boolean } & Partial<GeoIpMmdbMeta>> {
  const meta = await env.SUBPILOT_CONFIG.get(GEOIP_MMDB_META_KV_KEY, "json") as Partial<GeoIpMmdbMeta> | null;
  const descriptor = normalizeGeoIpMmdbMeta(meta);
  const hasData = descriptor ? await hasKvKey(env, descriptor.storageKey) : false;
  if (!hasData) return { uploaded: false };
  if (!meta || typeof meta !== "object" || !descriptor) return { uploaded: false };
  const fileName = typeof meta.fileName === "string" ? meta.fileName : "";
  const size = typeof meta.size === "number" && Number.isFinite(meta.size) ? meta.size : 0;
  const updatedAt = typeof meta.updatedAt === "string" ? meta.updatedAt : "";
  let databaseType = typeof meta.databaseType === "string" ? meta.databaseType : undefined;
  let builtAt = typeof meta.builtAt === "string" && Number.isFinite(Date.parse(meta.builtAt)) ? meta.builtAt : undefined;
  if (!databaseType || !builtAt) {
    // Older uploads did not persist the database build metadata. Read it without
    // rewriting the active database or changing its cache version.
    const data = await env.SUBPILOT_CONFIG.get(descriptor.storageKey, "arrayBuffer");
    if (data) {
      try {
        ({ databaseType, builtAt } = databaseMetadata(data));
      } catch { /* Keep the existing upload details when metadata is unavailable. */ }
    }
  }
  return { uploaded: true, fileName, size, updatedAt, ...(databaseType ? { databaseType } : {}), ...(builtAt ? { builtAt } : {}) };
}

function databaseMetadata(data: ArrayBuffer): Pick<GeoIpMmdbMeta, "databaseType" | "builtAt"> {
  const { databaseType, buildEpoch } = createGeoIpCountryReader(data).metadata;
  return { databaseType, ...(Number.isFinite(buildEpoch.getTime()) ? { builtAt: buildEpoch.toISOString() } : {}) };
}

export async function handleGeoIpMmdbUpload(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/octet-stream") {
    return badRequest("MMDB upload must use application/octet-stream");
  }
  let body: Uint8Array;
  try {
    body = await readRequestBytesWithLimit(request, MAX_MMDB_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return payloadTooLarge("MMDB upload body is too large");
    return badRequest("Invalid MMDB upload body");
  }
  if (body.byteLength <= 0) return badRequest("MMDB file is empty");

  const data = body.buffer as ArrayBuffer;
  let metadata: Pick<GeoIpMmdbMeta, "databaseType" | "builtAt">;
  try {
    metadata = databaseMetadata(data);
  } catch {
    return badRequest("Invalid MMDB file");
  }

  const meta: GeoIpMmdbMeta = {
    ...metadata,
    fileName: uploadedFileName(request.headers.get("x-subpilot-file-name")),
    size: body.byteLength,
    updatedAt: new Date().toISOString(),
    storageKey: `${GEOIP_MMDB_DATA_PREFIX}${String(Date.now()).padStart(16, "0")}-${randomToken(8)}`
  };
  // Commit the immutable data first and publish it through the metadata pointer
  // only after the data write succeeds. A failed pointer write leaves the
  // previous database readable instead of exposing a partially updated pair.
  await env.SUBPILOT_CONFIG.put(meta.storageKey, data);
  await env.SUBPILOT_CONFIG.put(GEOIP_MMDB_META_KV_KEY, JSON.stringify(meta));
  resetGeoIpCountryReader();
  await pruneOldGeoIpMmdbVersions(env, meta.storageKey).catch(() => undefined);
  return jsonResponse({
    uploaded: true,
    fileName: meta.fileName,
    size: meta.size,
    updatedAt: meta.updatedAt,
    databaseType: meta.databaseType,
    builtAt: meta.builtAt
  });
}

function uploadedFileName(value: string | null): string {
  if (!value) return "GeoIP.mmdb";
  try {
    const decoded = decodeURIComponent(value).trim();
    return decoded && decoded.length <= 255 && !/[\r\n/\\]/.test(decoded) ? decoded : "GeoIP.mmdb";
  } catch {
    return "GeoIP.mmdb";
  }
}

async function hasKvKey(env: Env, key: string): Promise<boolean> {
  const page = await env.SUBPILOT_CONFIG.list({ prefix: key });
  return page.keys.some((entry) => entry.name === key);
}

function normalizeGeoIpMmdbMeta(meta: Partial<GeoIpMmdbMeta> | null): {
  storageKey: string;
} | null {
  if (!meta || typeof meta !== "object") return null;
  const updatedAt = typeof meta.updatedAt === "string" ? meta.updatedAt : "";
  if (!updatedAt || !Number.isFinite(Date.parse(updatedAt))) return null;
  const storageKey = typeof meta.storageKey === "string" ? meta.storageKey : GEOIP_MMDB_KV_KEY;
  if (storageKey !== GEOIP_MMDB_KV_KEY && !storageKey.startsWith(GEOIP_MMDB_DATA_PREFIX)) return null;
  return { storageKey };
}

async function pruneOldGeoIpMmdbVersions(env: Env, currentStorageKey: string): Promise<void> {
  const page = await env.SUBPILOT_CONFIG.list({ prefix: GEOIP_MMDB_DATA_PREFIX });
  const retained = new Set(page.keys
    .map((entry) => entry.name)
    .sort()
    .reverse()
    .slice(0, RETAINED_MMDB_VERSIONS));
  retained.add(currentStorageKey);
  const cutoff = Date.now() - MMDB_PRUNE_GRACE_MS;
  const stale = page.keys
    .map((entry) => entry.name)
    .filter((key) => !retained.has(key) && geoIpMmdbStorageTimestamp(key) < cutoff)
    .slice(0, MAX_MMDB_PRUNES_PER_UPLOAD);
  await Promise.all(stale.map((key) => env.SUBPILOT_CONFIG.delete(key)));
}

function geoIpMmdbStorageTimestamp(key: string): number {
  const raw = key.slice(GEOIP_MMDB_DATA_PREFIX.length).split("-", 1)[0] ?? "";
  const timestamp = Number(raw);
  return Number.isSafeInteger(timestamp) ? timestamp : 0;
}
