import { createGeoIpCountryReader, GEOIP_MMDB_KV_KEY, GEOIP_MMDB_META_KV_KEY, resetGeoIpCountryReader } from "./geoip";
import { badRequest, jsonResponse } from "./util";

const MAX_MMDB_BYTES = 25 * 1024 * 1024;
const GEOIP_LOCATION_CACHE_PREFIX = "cache:geoip:location:";

interface GeoIpMmdbMeta {
  fileName: string;
  size: number;
  updatedAt: string;
}

export async function readGeoIpMmdbStatus(env: Env): Promise<{ uploaded: boolean } & Partial<GeoIpMmdbMeta>> {
  const [meta, hasData] = await Promise.all([
    env.SUBPILOT_CONFIG.get(GEOIP_MMDB_META_KV_KEY, "json") as Promise<Partial<GeoIpMmdbMeta> | null>,
    hasKvKey(env, GEOIP_MMDB_KV_KEY)
  ]);
  if (!hasData) return { uploaded: false };
  if (!meta || typeof meta !== "object") return { uploaded: false };
  const fileName = typeof meta.fileName === "string" ? meta.fileName : "";
  const size = typeof meta.size === "number" && Number.isFinite(meta.size) ? meta.size : 0;
  const updatedAt = typeof meta.updatedAt === "string" ? meta.updatedAt : "";
  return { uploaded: true, fileName, size, updatedAt };
}

export async function handleGeoIpMmdbUpload(request: Request, env: Env): Promise<Response> {
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return badRequest("Missing MMDB file");
  if (file.size <= 0) return badRequest("MMDB file is empty");
  if (file.size > MAX_MMDB_BYTES) return badRequest("MMDB file exceeds 25 MiB KV value limit");

  const data = await file.arrayBuffer();
  try {
    createGeoIpCountryReader(data);
  } catch {
    return badRequest("Invalid MMDB file");
  }

  const meta: GeoIpMmdbMeta = {
    fileName: file.name || "GeoIP.mmdb",
    size: file.size,
    updatedAt: new Date().toISOString()
  };
  await env.SUBPILOT_CONFIG.put(GEOIP_MMDB_KV_KEY, data);
  await env.SUBPILOT_CONFIG.put(GEOIP_MMDB_META_KV_KEY, JSON.stringify(meta));
  await deleteGeoIpLocationCache(env);
  resetGeoIpCountryReader();
  return jsonResponse({ uploaded: true, ...meta });
}

async function hasKvKey(env: Env, key: string): Promise<boolean> {
  const page = await env.SUBPILOT_CONFIG.list({ prefix: key });
  return page.keys.some((entry) => entry.name === key);
}

async function deleteGeoIpLocationCache(env: Env): Promise<void> {
  let cursor: string | undefined;
  do {
    const options: KVNamespaceListOptions = cursor
      ? { prefix: GEOIP_LOCATION_CACHE_PREFIX, cursor }
      : { prefix: GEOIP_LOCATION_CACHE_PREFIX };
    const page = await env.SUBPILOT_CONFIG.list(options);
    await Promise.all(page.keys.map((key) => env.SUBPILOT_CONFIG.delete(key.name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}
