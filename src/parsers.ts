import YAML from "yaml";
import type { HostEntry, HostEntryValue, ProxyNode, ProxyParamValue } from "./types";

const URI_PROTOCOLS = ["trojan:", "vless:", "vmess:", "ss:", "hysteria2:", "hy2:", "tuic:", "anytls:"];

export function maybeDecodeBase64(content: string): string {
  const trimmed = content.trim();
  if (!trimmed || /[\s{}:[\],]/.test(trimmed.slice(0, 80))) return content;
  try {
    const padded = trimmed + "=".repeat((4 - (trimmed.length % 4)) % 4);
    const decoded = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    return text.includes("\n") || text.includes("://") ? text : content;
  } catch {
    return content;
  }
}

export function parseSubscription(content: string, sourceId: string): ProxyNode[] {
  const decoded = maybeDecodeBase64(content);
  return [
    ...parseYamlProxies(decoded, sourceId),
    ...parseTextProxies(decoded, sourceId)
  ];
}

export function parseSurgeHostLines(content: string): string[] {
  return parseSurgeHostEntries(maybeDecodeBase64(content)).map(renderHostEntryLine);
}

export function parseHostEntries(content: string): HostEntry[] {
  const decoded = maybeDecodeBase64(content);
  return dedupeHostEntries([
    ...parseSurgeHostEntries(decoded),
    ...parseClashHostEntries(decoded)
  ]);
}

function parseSurgeHostEntries(content: string): HostEntry[] {
  const lines = content.split(/\r?\n/);
  const entries: HostEntry[] = [];
  let inHost = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^\[host\]$/i.test(line)) {
      inHost = true;
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      inHost = false;
      continue;
    }
    if (inHost && line && !line.startsWith("#") && !line.startsWith(";")) {
      const entry = parseHostLine(line);
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

function parseClashHostEntries(content: string): HostEntry[] {
  if (!/^\s*hosts\s*:/m.test(content)) return [];
  try {
    const data = YAML.parse(content) as { hosts?: unknown } | null;
    if (!data?.hosts || typeof data.hosts !== "object" || Array.isArray(data.hosts)) return [];
    return Object.entries(data.hosts as Record<string, unknown>).flatMap(([host, value]) => {
      const normalized = normalizeHostValue(value);
      return host && normalized !== undefined ? [{ host, value: normalized }] : [];
    });
  } catch {
    return [];
  }
}

export function parseManualSurge(content: string): ProxyNode[] {
  const lines = content.split(/\r?\n/);
  let inProxy = false;
  const nodes: ProxyNode[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (/^\[proxy\]$/i.test(line)) {
      inProxy = true;
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      inProxy = false;
      continue;
    }
    if (inProxy) {
      const node = parseSurgeLine(line);
      if (node) nodes.push(node);
    }
  }
  return nodes;
}

export function toSurgeLine(node: ProxyNode): string {
  if (node.surgeDetail) return `${node.name} = ${node.surgeDetail}`;
  const type = normalizeTypeForSurge(node.type);
  const suffix = buildSurgeParams(node).map(([key, value]) => `${key}=${value}`);
  return `${node.name} = ${[type, node.server, String(node.port ?? 0), ...suffix].join(", ")}`;
}

export function toClashProxy(node: ProxyNode): Record<string, unknown> {
  const type = normalizeTypeForClash(node.type);
  const base: Record<string, unknown> = node.raw ? { ...node.raw } : {};
  const wsOpts = clashWsOptionsFromParams(node.params);
  const nestedOpts = clashNestedOptionsFromParams(node.params);
  const pluginOpts = clashPluginOptionsFromParams(node.params);
  base.name = node.name;
  base.type = type;
  base.server = node.server;
  base.port = node.port;
  if (node.password) base.password = node.password;
  if (node.uuid && !clashUsesUsername(type)) base.uuid = node.uuid;
  if (node.cipher) base.cipher = node.cipher;
  if (node.type === "https" || node.type === "socks5-tls") base.tls = true;
  for (const [key, value] of Object.entries(node.params)) {
    if (["name", "type", "server", "port", "password", "uuid", "cipher"].includes(key) || value === "") continue;
    if (["ws", "ws-path", "ws-headers"].includes(key)) continue;
    if (key === "ws-opts" && wsOpts) continue;
    if (isClashNestedParamKey(key)) continue;
    if (pluginOpts && ["obfs", "obfs-host", "obfs-uri", "plugin-opts"].includes(key)) continue;
    if (node.type === "tuic" && key === "token") continue;
    const mappedKey = mapSurgeParamToClash(key, node.type);
    base[mappedKey] = normalizeClashParamValue(mappedKey, value);
  }
  Object.assign(base, nestedOpts);
  if (pluginOpts) {
    base.plugin = base.plugin ?? node.params.plugin ?? "obfs";
    base["plugin-opts"] = pluginOpts;
  }
  if (wsOpts) {
    base.network = "ws";
    base["ws-opts"] = wsOpts;
  }
  return base;
}

function parseYamlProxies(content: string, sourceId: string): ProxyNode[] {
  if (!/^\s*(proxies|Proxy|dns|rules):/m.test(content)) return [];
  try {
    const data = YAML.parse(content) as { proxies?: unknown[] } | null;
    if (!data || !Array.isArray(data.proxies)) return [];
    return data.proxies.flatMap((proxy) => {
      if (!proxy || typeof proxy !== "object") return [];
      const record = proxy as Record<string, unknown>;
      const name = asString(record.name);
      const type = asString(record.type);
      const server = asString(record.server);
      const port = toPort(record.port);
      if (!name || !type || !server || port === undefined) return [];
      const params: ProxyNode["params"] = {};
      for (const [key, value] of Object.entries(record)) {
        if (["name", "type", "server", "port", "password", "uuid", "cipher"].includes(key)) continue;
        if (isProxyParamValue(value)) params[key] = value;
      }
      return [{
        name,
        type,
        server,
        port,
        password: asString(record.password),
        uuid: asString(record.uuid),
        cipher: asString(record.cipher),
        params,
        raw: sanitizeProxyRecord(record),
        sourceId
      }];
    });
  } catch {
    return [];
  }
}

function parseTextProxies(content: string, sourceId: string): ProxyNode[] {
  const nodes: ProxyNode[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const urlNode = parseProxyUrl(line);
    const surgeNode = urlNode ?? parseSurgeLine(line);
    if (surgeNode) nodes.push({ ...surgeNode, sourceId });
  }
  return nodes;
}

export function parseSurgeLine(line: string): ProxyNode | null {
  if (!line.includes("=")) return null;
  const [namePart, detailPart] = line.split(/=(.*)/s);
  const name = namePart?.trim();
  const detail = detailPart?.trim();
  if (!name || !detail) return null;
  const urlNode = parseProxyUrl(detail);
  if (urlNode) return { ...urlNode, name, surgeDetail: detail };
  const parts = detail.split(",").map((item) => item.trim()).filter(Boolean);
  if (parts.length < 3) return null;
  const type = parts[0]!;
  const server = parts[1]!;
  const port = toPort(parts[2]);
  if (port === undefined) return null;
  const params: ProxyNode["params"] = {};
  for (const part of parts.slice(3)) {
    const [key, ...rest] = part.split("=");
    if (key && rest.length > 0) params[key.trim()] = rest.join("=").trim();
  }
  return {
    name,
    type,
    server,
    port,
    password: asString(params.password),
    uuid: asString(params.username),
    cipher: asString(params["encrypt-method"]),
    params,
    surgeDetail: detail
  };
}

function parseProxyUrl(value: string): ProxyNode | null {
  if (!URI_PROTOCOLS.some((protocol) => value.startsWith(protocol))) return null;
  if (value.startsWith("vmess://")) return parseVmess(value);
  try {
    const parsed = new URL(value);
    const name = decodeURIComponent(parsed.hash.replace(/^#/, "")) || `${parsed.protocol.replace(":", "")}-${parsed.hostname}`;
    const params: ProxyNode["params"] = {};
    parsed.searchParams.forEach((v, k) => {
      params[k] = v;
    });
    normalizeUriParams(params);
    const auth = decodeURIComponent(parsed.username || "");
    const secret = decodeURIComponent(parsed.password || "");
    const type = parsed.protocol.replace(":", "");
    const node: ProxyNode = {
      name,
      type,
      server: parsed.hostname,
      port: toPort(parsed.port) ?? defaultPortFor(type),
      params
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
    return node.server ? node : null;
  } catch {
    return null;
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
    return {
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
  } catch {
    return null;
  }
}

function defaultPortFor(type: string): number {
  if (type === "https" || type === "trojan") return 443;
  return 80;
}

function normalizeTypeForSurge(type: string): string {
  return type === "hy2" ? "hysteria2" : type;
}

function normalizeTypeForClash(type: string): string {
  if (type === "https") return "http";
  if (type === "socks5-tls") return "socks5";
  return type === "hy2" ? "hysteria2" : type;
}

function clashUsesUsername(type: string): boolean {
  return ["socks5", "http", "trust-tunnel", "ssh"].includes(normalizeTypeForClash(type));
}

function mapSurgeParamToClash(key: string, type: string): string {
  if (key === "underlying-proxy") return "dialer-proxy";
  if (key === "encrypt-method") return "cipher";
  if (key === "udp-relay") return "udp";
  if (key === "username" && !clashUsesUsername(type)) return "uuid";
  return key;
}

function normalizeClashParamValue(key: string, value: ProxyParamValue): ProxyParamValue {
  if (["skip-cert-verify", "tls", "udp", "tfo"].includes(key)) return paramEnabled(value);
  if (key === "alpn") return normalizeClashAlpn(value);
  return value;
}

function normalizeClashAlpn(value: ProxyParamValue): ProxyParamValue {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return value;
  return value
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function clashWsOptionsFromParams(params: ProxyNode["params"]): Record<string, ProxyParamValue> | null {
  const wsOpts = isProxyParamRecord(params["ws-opts"]) ? { ...params["ws-opts"] } : {};
  const headers = isProxyParamRecord(wsOpts.headers) ? { ...wsOpts.headers } : {};
  const parsedHeaders = parseHeaderParams(params["ws-headers"]);
  for (const [key, value] of Object.entries(parsedHeaders)) headers[key] = value;
  if (params["ws-path"] !== undefined) wsOpts.path = params["ws-path"];
  if (Object.keys(headers).length > 0) wsOpts.headers = headers;
  const enabled = params.network === "ws"
    || paramEnabled(params.ws)
    || params["ws-path"] !== undefined
    || params["ws-headers"] !== undefined
    || params["ws-opts"] !== undefined;
  return enabled ? wsOpts : null;
}

function clashNestedOptionsFromParams(params: ProxyNode["params"]): Record<string, Record<string, ProxyParamValue>> {
  const output: Record<string, Record<string, ProxyParamValue>> = {};
  addNestedOptions(output, "reality-opts", params["reality-opts"], prefixedParams(params, "reality", false));
  addNestedOptions(output, "grpc-opts", params["grpc-opts"], prefixedParams(params, "grpc", true));
  addNestedOptions(output, "h2-opts", params["h2-opts"], prefixedParams(params, "h2", false));
  addNestedOptions(output, "http-opts", params["http-opts"], prefixedParams(params, "http", false));
  addNestedOptions(output, "httpupgrade-opts", params["httpupgrade-opts"], prefixedParams(params, "httpupgrade", false));
  return output;
}

function addNestedOptions(
  output: Record<string, Record<string, ProxyParamValue>>,
  key: string,
  direct: ProxyParamValue | undefined,
  flattened: Record<string, ProxyParamValue>
): void {
  const merged = {
    ...(isProxyParamRecord(direct) ? direct : {}),
    ...flattened
  };
  if (Object.keys(merged).length > 0) output[key] = merged;
}

function prefixedParams(params: ProxyNode["params"], prefix: string, keepPrefix: boolean): Record<string, ProxyParamValue> {
  const output: Record<string, ProxyParamValue> = {};
  const marker = `${prefix}-`;
  for (const [key, value] of Object.entries(params)) {
    if (key === `${prefix}-opts`) continue;
    if (!key.startsWith(marker)) continue;
    if (value === "") continue;
    output[keepPrefix ? key : key.slice(marker.length)] = value;
  }
  return output;
}

function clashPluginOptionsFromParams(params: ProxyNode["params"]): Record<string, ProxyParamValue> | null {
  const direct = isProxyParamRecord(params["plugin-opts"]) ? { ...params["plugin-opts"] } : {};
  if (params.obfs !== undefined) direct.mode = params.obfs;
  if (params["obfs-host"] !== undefined) direct.host = params["obfs-host"];
  if (params["obfs-uri"] !== undefined) direct.path = params["obfs-uri"];
  return Object.keys(direct).length > 0 ? direct : null;
}

function isClashNestedParamKey(key: string): boolean {
  return key === "reality-opts"
    || key === "grpc-opts"
    || key === "h2-opts"
    || key === "http-opts"
    || key === "httpupgrade-opts"
    || key.startsWith("reality-")
    || key.startsWith("grpc-")
    || key.startsWith("h2-")
    || key.startsWith("http-")
    || key.startsWith("httpupgrade-");
}

function parseHeaderParams(value: ProxyParamValue | undefined): Record<string, string> {
  if (isProxyParamRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unquoteHeaderValue(formatSurgeParamValue(item))]));
  }
  if (typeof value !== "string") return {};
  return Object.fromEntries(value.split("|").flatMap((part): Array<[string, string]> => {
    const index = part.indexOf(":");
    if (index <= 0) return [];
    const key = part.slice(0, index).trim();
    const item = unquoteHeaderValue(part.slice(index + 1).trim());
    return key && item ? [[key, item]] : [];
  }));
}

function unquoteHeaderValue(value: string): string {
  const trimmed = value.trim();
  return trimmed.match(/^"(.*)"$/s)?.[1] ?? trimmed;
}

function paramEnabled(value: ProxyParamValue | undefined): boolean {
  return value === true || value === "true" || value === "1" || value === 1;
}

function buildSurgeParams(node: ProxyNode): [string, string][] {
  const entries: [string, string][] = [];
  const added = new Set<string>();
  const add = (key: string, value: ProxyParamValue | undefined): void => {
    const formatted = formatSurgeParamValue(value);
    if (!key || formatted === "") return;
    if (added.has(key)) return;
    added.add(key);
    entries.push([key, formatted]);
  };

  if (node.password) add(node.type === "tuic" ? "token" : "password", node.password);
  if (node.uuid) add("username", node.uuid);
  if (node.cipher) add("encrypt-method", node.cipher);

  const plugin = typeof node.params.plugin === "string" ? node.params.plugin : "";
  for (const [key, value] of Object.entries(node.params)) {
    if (["name", "type", "server", "port", "password", "uuid", "cipher"].includes(key)) continue;
    switch (key) {
      case "uuid":
        add("username", value);
        break;
      case "cipher":
        add("encrypt-method", value);
        break;
      case "udp":
        add("udp-relay", value);
        break;
      case "dialer-proxy":
        add("underlying-proxy", value);
        break;
      case "servername":
        add("sni", value);
        break;
      case "network":
        if (value === "ws") add("ws", true);
        else add(key, value);
        break;
      case "ws-opts":
        writeWsOpts(value, add);
        break;
      case "plugin-opts":
        writePluginOpts(plugin, value, add);
        break;
      case "grpc-opts":
        writeFlattenedParams("grpc", value, add);
        break;
      case "h2-opts":
        writeFlattenedParams("h2", value, add);
        break;
      case "http-opts":
        writeFlattenedParams("http", value, add);
        break;
      case "reality-opts":
        writeFlattenedParams("reality", value, add);
        break;
      default:
        add(key, value);
        break;
    }
  }
  return entries;
}

function writeWsOpts(value: ProxyParamValue, add: (key: string, value: ProxyParamValue | undefined) => void): void {
  if (!isProxyParamRecord(value)) {
    add("ws-opts", value);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === "path") add("ws-path", item);
    else if (key === "headers") add("ws-headers", formatHeaderParams(item));
    else add(`ws-${key}`, item);
  }
}

function writePluginOpts(plugin: string, value: ProxyParamValue, add: (key: string, value: ProxyParamValue | undefined) => void): void {
  if (!isProxyParamRecord(value)) {
    add("plugin-opts", value);
    return;
  }
  if (plugin === "obfs" || plugin === "simple-obfs") {
    if (value.mode !== undefined) add("obfs", value.mode);
    if (value.host !== undefined) add("obfs-host", value.host);
    if (value.path !== undefined) add("obfs-uri", value.path);
  } else if (plugin === "v2ray-plugin") {
    if (value.mode === "websocket") add("ws", true);
    if (value.host !== undefined) add("ws-headers", `Host:${formatSurgeParamValue(value.host)}`);
    if (value.path !== undefined) add("ws-path", value.path);
    if (value.tls !== undefined) add("tls", value.tls);
  }
  for (const [key, item] of Object.entries(value)) {
    writeFlattenedParams(`plugin-${key}`, item, add);
  }
}

function writeFlattenedParams(prefix: string, value: ProxyParamValue, add: (key: string, value: ProxyParamValue | undefined) => void): void {
  if (!isProxyParamRecord(value)) {
    add(prefix, value);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const nextPrefix = key.startsWith(`${prefix}-`) ? key : `${prefix}-${key}`;
    writeFlattenedParams(nextPrefix, item, add);
  }
}

function formatSurgeParamValue(value: ProxyParamValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map(formatSurgeParamValue).filter(Boolean).join(";");
  if (typeof value === "object") return Object.entries(value).map(([key, item]) => `${key}:${formatSurgeParamValue(item)}`).join("|");
  return String(value);
}

function formatHeaderParams(value: ProxyParamValue): string {
  if (!isProxyParamRecord(value)) return formatSurgeParamValue(value);
  return Object.entries(value)
    .map(([key, item]) => `${key}:${formatSurgeParamValue(item)}`)
    .join("|");
}

function isProxyParamRecord(value: ProxyParamValue | undefined): value is { [key: string]: ProxyParamValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isProxyParamValue(value: unknown): value is ProxyParamValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isProxyParamValue);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every(isProxyParamValue);
  }
  return false;
}

function sanitizeProxyRecord(record: Record<string, unknown>): Record<string, ProxyParamValue> {
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, ProxyParamValue] => isProxyParamValue(entry[1]))
  );
}

function parseHostLine(line: string): HostEntry | null {
  const [host, value] = line.split(/=(.*)/s);
  const key = host?.trim();
  const target = value?.trim();
  return key && target ? { host: key, value: target } : null;
}

function normalizeHostValue(value: unknown): HostEntryValue | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const values = value
      .filter((item): item is string | number | boolean => (
        typeof item === "string" || typeof item === "number" || typeof item === "boolean"
      ))
      .map(String);
    return values.length > 0 ? values : undefined;
  }
  return undefined;
}

function renderHostEntryLine(entry: HostEntry): string {
  return `${entry.host} = ${Array.isArray(entry.value) ? entry.value.join(", ") : entry.value}`;
}

function dedupeHostEntries(entries: HostEntry[]): HostEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.host}\0${JSON.stringify(entry.value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toPort(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : undefined;
}
