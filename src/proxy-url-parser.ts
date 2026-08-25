import { formatSurgeParamValue, isProxyParamRecord, normalizeProxyParams } from "./proxy-params";
import { isSafeConfigText } from "./config-text-safety";
import { asString, toPort } from "./proxy-value";
import type { ProxyNode } from "./types";

const URI_PROTOCOLS = ["trojan:", "vless:", "vmess:", "ss:", "hysteria2:", "hy2:", "tuic:", "anytls:"];

export function parseProxyUrl(value: string): ProxyNode | null {
  if (!URI_PROTOCOLS.some((protocol) => value.startsWith(protocol))) return null;
  if (value.startsWith("vmess://")) return parseVmess(value);
  if (value.startsWith("ss://")) return parseShadowsocks(value);
  try {
    const parsed = new URL(value);
    const name = decodeURIComponent(parsed.hash.replace(/^#/, "")) || `${parsed.protocol.replace(":", "")}-${parsed.hostname}`;
    const params: ProxyNode["params"] = {};
    parsed.searchParams.forEach((v, k) => {
      params[k] = v;
    });
    normalizeUriParams(params);
    const paramsNormalized = normalizeProxyParams(params);
    const auth = decodeURIComponent(parsed.username || "");
    const secret = decodeURIComponent(parsed.password || "");
    const type = parsed.protocol.replace(":", "");
    const node: ProxyNode = {
      name,
      type,
      server: parsed.hostname,
      port: toPort(parsed.port) ?? defaultPortFor(type),
      params,
      paramsNormalized: paramsNormalized || undefined
    };
    if (type === "ss" && secret) {
      node.cipher = auth;
      node.password = secret;
    } else if (type === "ss" && auth.includes(":")) {
      const [cipher, password] = auth.split(/:(.*)/s);
      node.cipher = cipher;
      node.password = password;
    } else if (type === "vless") {
      node.uuid = auth;
    } else if (type === "tuic") {
      if (auth.includes(":") && !secret) {
        const [uuid, password] = auth.split(/:(.*)/s);
        node.uuid = uuid;
        node.password = password;
      } else {
        node.uuid = auth;
        node.password = secret;
      }
    } else if (["trojan", "hysteria2", "hy2", "anytls"].includes(type)) {
      node.password = auth;
    } else if (auth) {
      node.password = auth;
      node.uuid = auth;
    }
    return node.server && isSafeConfigText(node) ? node : null;
  } catch {
    return null;
  }
}

function parseShadowsocks(value: string): ProxyNode | null {
  try {
    const payload = value.slice("ss://".length);
    const hashIndex = payload.indexOf("#");
    const withoutHash = hashIndex >= 0 ? payload.slice(0, hashIndex) : payload;
    const rawName = hashIndex >= 0 ? payload.slice(hashIndex + 1) : "";
    const queryIndex = withoutHash.indexOf("?");
    const authority = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
    const query = queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : "";
    const modernSeparator = authority.lastIndexOf("@");
    let credentials: string;
    let serverAuthority: string;

    if (modernSeparator >= 0) {
      const encodedCredentials = safeDecodeURIComponent(authority.slice(0, modernSeparator));
      credentials = encodedCredentials.includes(":")
        ? encodedCredentials
        : decodeBase64Url(encodedCredentials) ?? "";
      serverAuthority = authority.slice(modernSeparator + 1).replace(/\/$/, "");
    } else {
      // Legacy SIP002 links may include the URI path separator after the
      // Base64 payload. Strip it before decoding; `/` is itself a valid Base64
      // character, so trying the unstripped value first can silently decode a
      // different payload instead of failing.
      const legacyPayload = authority.endsWith("/") ? authority.slice(0, -1) : authority;
      const decoded = decodeBase64Url(legacyPayload);
      const separator = decoded?.lastIndexOf("@") ?? -1;
      if (!decoded || separator < 0) return null;
      credentials = decoded.slice(0, separator);
      serverAuthority = decoded.slice(separator + 1);
    }

    const credentialSeparator = credentials.indexOf(":");
    if (credentialSeparator <= 0) return null;
    const cipher = credentials.slice(0, credentialSeparator);
    const password = credentials.slice(credentialSeparator + 1);
    if (!cipher || !password) return null;

    const serverUrl = new URL(`http://${serverAuthority}`);
    const port = toPort(serverUrl.port);
    if (!serverUrl.hostname || port === undefined) return null;

    const params: ProxyNode["params"] = {};
    const searchParams = new URLSearchParams(query);
    searchParams.forEach((item, key) => {
      if (key !== "plugin") params[key] = item;
    });
    const plugin = searchParams.get("plugin");
    if (plugin) applySip002Plugin(params, plugin);
    normalizeUriParams(params);
    const paramsNormalized = normalizeProxyParams(params);
    const node: ProxyNode = {
      name: safeDecodeURIComponent(rawName) || `ss-${serverUrl.hostname}`,
      type: "ss",
      server: serverUrl.hostname,
      port,
      cipher,
      password,
      params,
      paramsNormalized: paramsNormalized || undefined
    };
    return isSafeConfigText(node) ? node : null;
  } catch {
    return null;
  }
}

function applySip002Plugin(params: ProxyNode["params"], value: string): void {
  const [rawName = "", ...rawOptions] = value.split(";");
  const plugin = rawName === "obfs-local" ? "obfs" : rawName;
  if (!plugin) return;
  params.plugin = plugin;
  const options: Record<string, string | boolean> = {};
  for (const rawOption of rawOptions) {
    if (!rawOption) continue;
    const separator = rawOption.indexOf("=");
    const key = separator < 0 ? rawOption : rawOption.slice(0, separator);
    const item = separator < 0 ? true : rawOption.slice(separator + 1);
    if (!key) continue;
    if (key === "obfs") options.mode = item;
    else if (key === "obfs-host") options.host = item;
    else if (key === "obfs-uri") options.path = item;
    else options[key] = item;
  }
  if (Object.keys(options).length > 0) params["plugin-opts"] = options;
}

function decodeBase64Url(value: string): string | null {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  if (!normalized || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return null;
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  try {
    const decoded = atob(padded);
    return new TextDecoder().decode(Uint8Array.from(decoded, (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeUriParams(params: ProxyNode["params"]): void {
  const security = asString(params.security).toLowerCase();
  if (security === "tls" || security === "reality") params.tls = true;
  if (params.type !== undefined && params.network === undefined) params.network = params.type;
  if (params.path !== undefined && params["ws-path"] === undefined) params["ws-path"] = params.path;
  if (params.host !== undefined && params["ws-headers"] === undefined) params["ws-headers"] = `Host:${formatSurgeParamValue(params.host)}`;
  if (params.serviceName !== undefined && params["grpc-service-name"] === undefined) params["grpc-service-name"] = params.serviceName;
  if (params.fp !== undefined && params["client-fingerprint"] === undefined) params["client-fingerprint"] = params.fp;
  const realityOpts = isProxyParamRecord(params["reality-opts"]) ? { ...params["reality-opts"] } : {};
  if (params.pbk !== undefined && realityOpts["public-key"] === undefined) realityOpts["public-key"] = params.pbk;
  if (params.sid !== undefined && realityOpts["short-id"] === undefined) realityOpts["short-id"] = params.sid;
  if (Object.keys(realityOpts).length > 0) params["reality-opts"] = realityOpts;
  delete params.security;
  delete params.type;
  delete params.path;
  delete params.host;
  delete params.serviceName;
  delete params.fp;
  delete params.pbk;
  delete params.sid;
}

function parseVmess(value: string): ProxyNode | null {
  try {
    const decoded = atob(value.replace(/^vmess:\/\//, ""));
    const data = JSON.parse(decoded) as Record<string, unknown>;
    const server = asString(data.add);
    const port = toPort(data.port);
    if (!server || port === undefined) return null;
    const node: ProxyNode = {
      name: asString(data.ps) || `vmess-${server}`,
      type: "vmess",
      server,
      port,
      uuid: asString(data.id),
      cipher: "auto",
      params: {
        tls: asString(data.tls) === "tls",
        network: asString(data.net) || "tcp",
        "ws-path": asString(data.path),
        "ws-headers": asString(data.host)
      }
    };
    return isSafeConfigText(node) ? node : null;
  } catch {
    return null;
  }
}

function defaultPortFor(type: string): number {
  if (type === "https" || type === "trojan") return 443;
  return 80;
}
