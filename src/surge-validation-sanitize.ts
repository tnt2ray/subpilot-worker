import { parseSurgeLine, toSurgeLine } from "./parsers";
import type { ProxyNode, ProxyParamValue } from "./types";

const FAKE_HOST = "test.local";
const FAKE_PORT = 443;
const FAKE_TEXT_SECRET = "test";
const FAKE_MANAGED_URL = "https://subpilot.invalid/sync/validation/";

const HOST_PARAM_KEYS = new Set([
  "server",
  "host",
  "sni",
  "servername",
  "server_name",
  "tls-servername",
  "obfs-host",
  "peer",
  "ws-host"
]);
const USER_PARAM_KEYS = new Set(["username", "user", "uuid"]);
const PASSWORD_PARAM_KEYS = new Set(["password", "pass", "token", "psk", "obfs-password", "obfs_password"]);

export function sanitizeSurgeValidationContent(content: string): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  let inProxySection = false;
  let nodeIndex = 0;

  return content.split(/\r?\n/).map((raw) => {
    const line = raw.trim();
    const indent = raw.match(/^\s*/)?.[0] ?? "";
    const managedConfig = line.match(/^#!MANAGED-CONFIG\s+\S+(\s+.*)?$/i);
    if (managedConfig) return `${indent}#!MANAGED-CONFIG ${FAKE_MANAGED_URL}${managedConfig[1] ?? ""}`;
    if (/^\[proxy\]$/i.test(line)) {
      inProxySection = true;
      return raw;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      inProxySection = false;
      return raw;
    }
    if (!inProxySection || !line || line.startsWith("#") || line.startsWith(";")) return raw;

    const node = parseSurgeLine(line);
    if (!node) return raw;

    return `${indent}${toSurgeLine(sanitizeNode(node, nodeIndex++))}`;
  }).join(eol);
}

function sanitizeNode(node: ProxyNode, index: number): ProxyNode {
  const fakeUuid = fakeUuidFor(index);
  const useUuid = shouldUseUuidCredential(node);
  const params = sanitizeParams(node.params, useUuid ? fakeUuid : FAKE_TEXT_SECRET);

  return {
    ...node,
    server: FAKE_HOST,
    port: FAKE_PORT,
    password: node.password ? FAKE_TEXT_SECRET : undefined,
    uuid: node.uuid ? (useUuid ? fakeUuid : FAKE_TEXT_SECRET) : undefined,
    params,
    surgeDetail: undefined
  };
}

function sanitizeParams(params: ProxyNode["params"], fakeUser: string): ProxyNode["params"] {
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [
    key,
    sanitizeParamValue(key, value, fakeUser)
  ]));
}

function sanitizeParamValue(key: string, value: ProxyParamValue, fakeUser: string): ProxyParamValue {
  const normalizedKey = key.toLowerCase();
  if (HOST_PARAM_KEYS.has(normalizedKey)) return FAKE_HOST;
  if (normalizedKey === "port" || normalizedKey.endsWith("-port")) return FAKE_PORT;
  if (USER_PARAM_KEYS.has(normalizedKey)) return fakeUser;
  if (PASSWORD_PARAM_KEYS.has(normalizedKey)) return FAKE_TEXT_SECRET;
  if (normalizedKey === "ws-headers" && typeof value === "string" && /^host:/i.test(value.trim())) return `Host:${FAKE_HOST}`;
  if (Array.isArray(value)) return value.map((item) => sanitizeParamValue(key, item, fakeUser));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([nestedKey, nestedValue]) => [
      nestedKey,
      sanitizeParamValue(nestedKey, nestedValue, fakeUser)
    ]));
  }
  return value;
}

function shouldUseUuidCredential(node: ProxyNode): boolean {
  const type = node.type.toLowerCase();
  return ["vmess", "vless", "tuic"].includes(type)
    || isUuidLike(node.uuid)
    || isUuidLike(node.params.username)
    || isUuidLike(node.params.uuid);
}

function isUuidLike(value: ProxyParamValue | undefined): boolean {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function fakeUuidFor(index: number): string {
  const suffix = String(index + 1).padStart(12, "0").slice(-12);
  return `00000000-0000-4000-8000-${suffix}`;
}
