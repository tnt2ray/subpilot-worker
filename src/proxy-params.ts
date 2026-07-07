import type { ProxyNode, ProxyParamValue } from "./types";

const BOOLEAN_PROXY_PARAM_KEYS = new Set([
  "allow-insecure",
  "allowinsecure",
  "disable",
  "disabled",
  "disable-sni",
  "ech",
  "enable",
  "enabled",
  "fast-open",
  "fastopen",
  "insecure",
  "mptcp",
  "multi-mode",
  "mux",
  "prefer-h3",
  "reduce-rtt",
  "reuse",
  "skip-cert-verify",
  "smux",
  "tcp-fast-open",
  "tfo",
  "tls",
  "udp",
  "udp-over-tcp",
  "udpovertcp",
  "udp-relay",
  "vmess-aead",
  "ws"
]);
const TRUE_PROXY_PARAM_VALUES = new Set(["true", "1", "yes", "y", "on", "enable", "enabled"]);
const FALSE_PROXY_PARAM_VALUES = new Set(["false", "0", "no", "n", "off", "disable", "disabled"]);
const TRUE_PROXY_PARAM_TYPOS = new Set(["treu", "tru", "tue", "ture"]);
const FALSE_PROXY_PARAM_TYPOS = new Set(["fales", "fals", "fasle", "flase", "flse"]);

export function normalizeProxyParams(params: ProxyNode["params"]): boolean {
  let changed = false;
  for (const [key, value] of Object.entries(params)) {
    const normalized = normalizeProxyParamValue(key, value);
    if (formatSurgeParamValue(value) !== formatSurgeParamValue(normalized)) changed = true;
    params[key] = normalized;
  }
  return changed;
}

function normalizeProxyParamValue(key: string, value: ProxyParamValue): ProxyParamValue {
  const normalizedKey = normalizeProxyParamKey(key);
  if (Array.isArray(value)) return value.map((item) => normalizeProxyParamValue(key, item));
  if (isProxyParamRecord(value)) {
    if (isHeaderParamContainer(normalizedKey)) return value;
    return Object.fromEntries(Object.entries(value).map(([nestedKey, nestedValue]) => [
      nestedKey,
      normalizeProxyParamValue(nestedKey, nestedValue)
    ]));
  }
  if (!isBooleanProxyParamKey(normalizedKey)) return value;
  return normalizeBooleanProxyParamValue(value);
}

export function normalizeBooleanProxyParamValue(value: ProxyParamValue): ProxyParamValue {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (TRUE_PROXY_PARAM_VALUES.has(normalized) || TRUE_PROXY_PARAM_TYPOS.has(normalized)) return true;
  if (FALSE_PROXY_PARAM_VALUES.has(normalized) || FALSE_PROXY_PARAM_TYPOS.has(normalized)) return false;
  return value;
}

export function isBooleanProxyParamKey(normalizedKey: string): boolean {
  return BOOLEAN_PROXY_PARAM_KEYS.has(normalizedKey)
    || normalizedKey.endsWith("-enable")
    || normalizedKey.endsWith("-enabled")
    || normalizedKey.startsWith("enable-")
    || normalizedKey.endsWith("-disable")
    || normalizedKey.endsWith("-disabled")
    || normalizedKey.startsWith("disable-");
}

function isHeaderParamContainer(normalizedKey: string): boolean {
  return normalizedKey === "header"
    || normalizedKey === "headers"
    || normalizedKey.endsWith("-header")
    || normalizedKey.endsWith("-headers");
}

export function normalizeProxyParamKey(key: string): string {
  return key.trim().toLowerCase().replace(/_/g, "-");
}

export function paramEnabled(value: ProxyParamValue | undefined): boolean {
  if (value === true || value === 1) return true;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return TRUE_PROXY_PARAM_VALUES.has(normalized) || TRUE_PROXY_PARAM_TYPOS.has(normalized);
}

export function formatSurgeParamValue(value: ProxyParamValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map(formatSurgeParamValue).filter(Boolean).join(";");
  if (typeof value === "object") return Object.entries(value).map(([key, item]) => `${key}:${formatSurgeParamValue(item)}`).join("|");
  return String(value);
}

export function isProxyParamRecord(value: ProxyParamValue | undefined): value is { [key: string]: ProxyParamValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
