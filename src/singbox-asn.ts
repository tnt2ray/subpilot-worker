import { looksLikeCidr, validateRuleMatchValue } from "./rule-value-validation";
import { fetchWithTimeout } from "./upstream-fetch";
import { readResponseTextWithLimit } from "./util";

const CACHE_PREFIX = "cache:singbox:asn:ris-v1:";
const FRESH_MS = 24 * 60 * 60 * 1000;
const RETAIN_MS = 7 * FRESH_MS;
const RETRY_MS = 5 * 60 * 1000;
const MAX_PREFIXES = 50_000;
const MAX_ASNS = 32;

interface PrefixSnapshot {
  asn: string;
  fetchedAt: number;
  prefixes: string[];
}

export interface AsnResolution {
  prefixes: string[];
  expiresAt: number;
  warning?: string;
  stale: boolean;
}

interface AsnCache {
  get<T>(key: string, type: "json"): Promise<T | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<unknown>;
}
type AsnEnvironment = { SUBPILOT_CONFIG: AsnCache };

/** Request-local memoization; only public BGP prefix snapshots are stored in KV. */
export function createSingboxAsnResolver(env: AsnEnvironment, deadline = Date.now() + 30_000): (value: string) => Promise<AsnResolution> {
  const pending = new Map<string, Promise<AsnResolution>>();
  const cutoff = Math.min(deadline, Date.now() + 30_000);
  return (value) => {
    if (validateRuleMatchValue("IP-ASN", value)) return Promise.reject(new Error("无效的 ASN"));
    const asn = String(Number(value.replace(/^AS/i, "")));
    const existing = pending.get(asn);
    if (existing) return existing;
    if (pending.size >= MAX_ASNS) return Promise.resolve({ prefixes: [], expiresAt: Date.now() + RETRY_MS, stale: false, warning: `AS${asn}：本次刷新最多查询 ${MAX_ASNS} 个 ASN，已跳过。` });
    const result = resolvePrefixes(env, asn, cutoff);
    pending.set(asn, result);
    return result;
  };
}

async function resolvePrefixes(env: AsnEnvironment, asn: string, deadline: number): Promise<AsnResolution> {
  const key = `${CACHE_PREFIX}${asn}`;
  const now = Date.now();
  let snapshot: PrefixSnapshot | null = null;
  let retryAfter = 0;
  try {
    const value = await env.SUBPILOT_CONFIG.get<Record<string, unknown>>(key, "json");
    if (value?.asn === asn && typeof value.fetchedAt === "number" && value.fetchedAt <= now
      && value.fetchedAt > now - RETAIN_MS && validPrefixes(value.prefixes)) {
      snapshot = { asn, fetchedAt: value.fetchedAt, prefixes: value.prefixes };
    }
    if (typeof value?.retryAfter === "number" && value.retryAfter <= now + RETRY_MS) retryAfter = value.retryAfter;
  } catch { /* A missing or damaged cache must not prevent a fresh lookup. */ }
  if (snapshot && snapshot.fetchedAt + FRESH_MS > now) {
    return { prefixes: snapshot.prefixes, expiresAt: snapshot.fetchedAt + FRESH_MS, stale: false };
  }
  const fallback = (reason: string): AsnResolution => ({
    prefixes: snapshot?.prefixes ?? [],
    expiresAt: Math.max(Date.now() + 60_000, retryAfter),
    stale: Boolean(snapshot),
    warning: snapshot
      ? `AS${asn}：${reason}，使用 ${new Date(snapshot.fetchedAt).toISOString()} 的旧 CIDR 缓存。`
      : `AS${asn}：${reason}，没有可用 CIDR 缓存，已跳过此 ASN；其他规则继续生效。`
  });
  if (retryAfter > now) return fallback("上次查询失败，等待重试");
  if (Date.now() >= deadline) return fallback("刷新已到截止时间");
  try {
    // Only originating routes, never prefixes merely transiting this ASN.
    const url = `https://stat.ripe.net/data/ris-prefixes/data.json?resource=AS${asn}&list_prefixes=true&types=o&af=v4,v6&noise=filter`;
    const prefixes = await fetchWithTimeout(globalThis.fetch, url, undefined, Math.min(8_000, deadline - Date.now()), async (response) => {
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }
      const value = JSON.parse(await readResponseTextWithLimit(response, 4 * 1024 * 1024, "ASN response"));
      const v4: unknown = value?.data?.prefixes?.v4?.originating;
      const v6: unknown = value?.data?.prefixes?.v6?.originating;
      if (value?.status !== "ok" || String(value?.data?.resource).replace(/^AS/i, "") !== asn
        || !Array.isArray(v4) || !Array.isArray(v6)) throw new Error("ASN 响应格式无效");
      const entries: unknown = [...v4, ...v6];
      if (!validPrefixes(entries)) throw new Error("ASN 响应没有有效前缀或超过数量限制");
      return [...new Set(entries)];
    });
    const fetchedAt = Date.now();
    const result: AsnResolution = { prefixes, expiresAt: fetchedAt + FRESH_MS, stale: false };
    try {
      await env.SUBPILOT_CONFIG.put(key, JSON.stringify({ asn, fetchedAt, prefixes }), { expirationTtl: RETAIN_MS / 1000 });
    } catch { result.warning = `AS${asn}：CIDR 已获取，但缓存写入失败。`; }
    return result;
  } catch {
    retryAfter = Date.now() + RETRY_MS;
    try {
      await env.SUBPILOT_CONFIG.put(key, JSON.stringify({ asn, fetchedAt: snapshot?.fetchedAt ?? 0, prefixes: snapshot?.prefixes ?? [], retryAfter }), {
        expirationTtl: snapshot ? Math.max(60, Math.ceil((snapshot.fetchedAt + RETAIN_MS - Date.now()) / 1000)) : RETRY_MS / 1000
      });
    } catch { /* Reporting the lookup failure is sufficient even if KV is unavailable. */ }
    return fallback("ASN 查询失败或返回无效数据");
  }
}

function validPrefixes(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_PREFIXES
    && value.every((prefix) => typeof prefix === "string" && looksLikeCidr(prefix) && !/\/0+$/.test(prefix));
}
