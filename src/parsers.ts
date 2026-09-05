import { parseSingboxNodes } from "./singbox-nodes";
import YAML from "yaml";
import { assertSafeConfigText, isSafeConfigText } from "./config-text-safety";
import {
  formatSurgeParamValue,
  isBooleanProxyParamKey,
  isProxyParamRecord,
  normalizeBooleanProxyParamValue,
  normalizeProxyParamKey,
  normalizeProxyParams,
  paramEnabled
} from "./proxy-params";
import { parseProxyUrl } from "./proxy-url-parser";
import { asString, isProxyParamValue, sanitizeProxyRecord, toPort } from "./proxy-value";
import { maybeDecodeBase64 } from "./subscription-text";
import type { ProxyNode, ProxyParamValue, StaticProxyNodeConfig } from "./types";

export { parseHostEntries, parseSurgeHostLines } from "./host-entries";
export { maybeDecodeBase64 } from "./subscription-text";

export function parseSubscription(content: string, sourceId: string): ProxyNode[] {
  const decoded = maybeDecodeBase64(content);
  const native = parseSingboxNodes(decoded, sourceId);
  if (native.length) return native;
  return [
    ...parseYamlProxies(decoded, sourceId),
    ...parseTextProxies(decoded, sourceId)
  ];
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

export function parseConfiguredProxyNode(proxyNode: StaticProxyNodeConfig): ProxyNode | null {
  const config = String(proxyNode.config || "").trim();
  if (!config) return null;
  const native = parseSingboxNodes(config, "manual");
  if (native.length) return native[0]!;
  return parseManualSurge(`[Proxy]\n${config}`)[0] ?? parseConfiguredClashNode(config);
}

function parseConfiguredClashNode(config: string): ProxyNode | null {
  const record = readClashProxyRecord(config);
  if (!record) return null;
  return parseSubscription(YAML.stringify({ proxies: [record] }), "manual")[0] ?? null;
}

function readClashProxyRecord(config: string): Record<string, unknown> | null {
  try {
    const parsed = YAML.parse(config) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (Array.isArray(record.proxies)) {
        const [first] = record.proxies;
        return first && typeof first === "object" && !Array.isArray(first)
          ? first as Record<string, unknown>
          : null;
      }
      return record;
    }
    if (Array.isArray(parsed)) {
      const [first] = parsed;
      return first && typeof first === "object" && !Array.isArray(first)
        ? first as Record<string, unknown>
        : null;
    }
  } catch {
    return null;
  }
  return null;
}

export function toSurgeLine(node: ProxyNode): string {
  assertSafeConfigText(node, "Proxy node");
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
  const snellObfsOpts = clashSnellObfsOptionsFromParams(node.type, node.params);
  const pluginOpts = usesClashPluginOptions(node.type) ? clashPluginOptionsFromParams(node.params) : null;
  base.name = node.name;
  base.type = type;
  base.server = node.server;
  base.port = node.port;
  if (node.password) base.password = node.password;
  if (node.uuid && !clashUsesUsername(type)) base.uuid = node.uuid;
  if (node.cipher) base.cipher = node.cipher;
  if (type === "vmess" && base.cipher === undefined) base.cipher = "auto";
  if (node.type === "https" || node.type === "socks5-tls") base.tls = true;
  for (const [key, value] of Object.entries(node.params)) {
    if (["name", "type", "server", "port", "password", "uuid", "cipher"].includes(key) || value === "") continue;
    if (["ws", "ws-path", "ws-headers"].includes(key)) {
      delete base[key];
      continue;
    }
    if (key === "ws-opts" && wsOpts) {
      delete base[key];
      continue;
    }
    if (isClashNestedParamKey(key)) {
      delete base[key];
      continue;
    }
    if (snellObfsOpts && ["obfs", "obfs-host", "obfs-uri", "obfs-opts"].includes(key)) {
      delete base[key];
      continue;
    }
    if (pluginOpts && ["obfs", "obfs-host", "obfs-uri", "plugin-opts"].includes(key)) {
      delete base[key];
      continue;
    }
    if (node.type === "tuic" && key === "token" && node.password) {
      delete base[key];
      continue;
    }
    const mappedKey = mapSurgeParamToClash(key, node.type);
    if (mappedKey !== key) delete base[key];
    base[mappedKey] = normalizeClashParamValue(mappedKey, node.type, value);
  }
  const obfsPassword = base["obfs-password"];
  if (isHysteria2Type(node.type) && base.obfs === undefined && obfsPassword !== undefined && obfsPassword !== "") {
    base.obfs = "salamander";
  }
  Object.assign(base, nestedOpts);
  if (snellObfsOpts) base["obfs-opts"] = snellObfsOpts;
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
      if (!isSafeConfigText(record)) return [];
      const name = asString(record.name);
      const type = normalizeClashInputType(asString(record.type));
      const server = asString(record.server);
      const port = toPort(record.port);
      if (!name || !type || !server || port === undefined) return [];
      const params: ProxyNode["params"] = {};
      for (const [key, value] of Object.entries(record)) {
        if (["name", "type", "server", "port", "password", "uuid", "cipher"].includes(key)) continue;
        if (isProxyParamValue(value)) params[key] = value;
      }
      const paramsNormalized = normalizeProxyParams(params);
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
        paramsNormalized: paramsNormalized || undefined,
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
  if (!line.includes("=") || !isSafeConfigText(line)) return null;
  const [namePart, detailPart] = line.split(/=(.*)/s);
  const name = namePart?.trim();
  const detail = detailPart?.trim();
  if (!name || !detail) return null;
  const urlNode = parseProxyUrl(detail);
  if (urlNode) {
    const node = {
      ...urlNode,
      name,
      surgeDetail: urlNode.paramsNormalized || urlNode.type === "tuic-v5" ? undefined : detail
    };
    return isSafeConfigText(node) ? node : null;
  }
  const parts = detail.split(",").map((item) => item.trim()).filter(Boolean);
  if (parts.length < 3) return null;
  const sourceType = parts[0]!;
  const server = parts[1]!;
  const port = toPort(parts[2]);
  if (port === undefined) return null;
  const params: ProxyNode["params"] = {};
  for (const part of parts.slice(3)) {
    const [key, ...rest] = part.split("=");
    if (key && rest.length > 0) params[key.trim()] = rest.join("=").trim();
  }
  const type = normalizeSurgeInputType(sourceType, params);
  const paramsNormalized = normalizeProxyParams(params);
  const node: ProxyNode = {
    name,
    type,
    server,
    port,
    password: asString(params.password),
    uuid: asString(params.username) || asString(params.uuid),
    cipher: asString(params["encrypt-method"]),
    params,
    surgeDetail: paramsNormalized || type !== sourceType ? undefined : detail,
    paramsNormalized: paramsNormalized || undefined
  };
  return isSafeConfigText(node) ? node : null;
}

function normalizeTypeForSurge(type: string): string {
  return type === "hy2" ? "hysteria2" : type;
}

function normalizeTypeForClash(type: string): string {
  if (type === "https") return "http";
  if (type === "socks5-tls") return "socks5";
  if (type === "tuic-v5") return "tuic";
  return type === "hy2" ? "hysteria2" : type;
}

function normalizeClashInputType(type: string): string {
  return type.toLowerCase() === "tuic" ? "tuic-v5" : type;
}

function normalizeSurgeInputType(type: string, params: ProxyNode["params"]): string {
  const normalizedType = type.toLowerCase();
  if (normalizedType === "tuic-v5") return "tuic-v5";
  if (normalizedType !== "tuic") return type;
  const hasV5Credentials = (params.uuid !== undefined || params.username !== undefined)
    && params.password !== undefined
    && params.token === undefined;
  return hasV5Credentials ? "tuic-v5" : "tuic";
}

function clashUsesUsername(type: string): boolean {
  return ["socks5", "http", "trust-tunnel", "ssh"].includes(normalizeTypeForClash(type));
}

function isSnellType(type: string): boolean {
  return normalizeTypeForClash(type) === "snell";
}

function isHysteria2Type(type: string): boolean {
  return normalizeTypeForClash(type) === "hysteria2";
}

function usesClashPluginOptions(type: string): boolean {
  return normalizeTypeForClash(type) === "ss";
}

function mapSurgeParamToClash(key: string, type: string): string {
  if (isHysteria2Type(type)) {
    if (key === "download-bandwidth") return "down";
    if (key === "upload-bandwidth") return "up";
    if (key === "port-hopping") return "ports";
    if (key === "port-hopping-interval") return "hop-interval";
    if (key === "salamander-password") return "obfs-password";
  }
  if (key === "underlying-proxy") return "dialer-proxy";
  if (key === "encrypt-method") return "cipher";
  if (key === "udp-relay") return "udp";
  if (key === "server-cert-fingerprint-sha256") return "fingerprint";
  if (key === "username" && !clashUsesUsername(type)) return "uuid";
  return key;
}

function normalizeClashParamValue(key: string, type: string, value: ProxyParamValue): ProxyParamValue {
  if (isSnellType(type) && key === "version") {
    const version = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
    return version;
  }
  if (isHysteria2Type(type) && key === "ports" && typeof value === "string") {
    return value.split(";").map((item) => item.trim()).filter(Boolean).join(",");
  }
  if (isBooleanProxyParamKey(normalizeProxyParamKey(key))) {
    const normalized = normalizeBooleanProxyParamValue(value);
    return typeof normalized === "boolean" ? normalized : value;
  }
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

function clashSnellObfsOptionsFromParams(type: string, params: ProxyNode["params"]): Record<string, ProxyParamValue> | null {
  if (!isSnellType(type)) return null;
  const direct = isProxyParamRecord(params["obfs-opts"]) ? { ...params["obfs-opts"] } : {};
  if (params.obfs !== undefined) direct.mode = params.obfs;
  if (params["obfs-host"] !== undefined) direct.host = params["obfs-host"];
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

  if (node.type === "snell") {
    add("psk", node.params.psk ?? node.password);
  } else if (node.type === "tuic") {
    if (node.password) add("token", node.password);
  } else if (node.type === "tuic-v5") {
    if (node.uuid) add("uuid", node.uuid);
    if (node.password) add("password", node.password);
  } else {
    if (node.password) add("password", node.password);
    if (node.uuid) add("username", node.uuid);
  }
  if (node.cipher) add("encrypt-method", node.cipher);

  const plugin = typeof node.params.plugin === "string" ? node.params.plugin : "";
  for (const [key, value] of Object.entries(node.params)) {
    if (["name", "type", "server", "port", "password", "uuid", "cipher"].includes(key)) continue;
    switch (key) {
      case "uuid":
        add(node.type === "tuic-v5" ? "uuid" : "username", value);
        break;
      case "username":
        add(node.type === "tuic-v5" ? "uuid" : "username", value);
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
      case "fingerprint":
        add("server-cert-fingerprint-sha256", value);
        break;
      case "servername":
        add("sni", value);
        break;
      case "down":
        if (isHysteria2Type(node.type)) add("download-bandwidth", value);
        else add(key, value);
        break;
      case "up":
        if (isHysteria2Type(node.type)) add("upload-bandwidth", value);
        else add(key, value);
        break;
      case "ports":
        if (isHysteria2Type(node.type)) add("port-hopping", formatHysteria2SurgePorts(value));
        else add(key, value);
        break;
      case "hop-interval":
        if (isHysteria2Type(node.type)) add("port-hopping-interval", value);
        else add(key, value);
        break;
      case "obfs":
        if (!(isHysteria2Type(node.type) && value === "salamander")) add(key, value);
        break;
      case "obfs-password":
        if (isHysteria2Type(node.type)) add("salamander-password", value);
        else add(key, value);
        break;
      case "plugin":
        if (!isTranslatedSurgePlugin(value)) add(key, value);
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
      case "obfs-opts":
        if (isSnellType(node.type)) writeSnellObfsOpts(value, add);
        else add(key, value);
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
  const consumed = new Set<string>();
  if (plugin === "obfs" || plugin === "simple-obfs") {
    if (value.mode !== undefined) add("obfs", value.mode);
    if (value.host !== undefined) add("obfs-host", value.host);
    if (value.path !== undefined) add("obfs-uri", value.path);
    consumed.add("mode");
    consumed.add("host");
    consumed.add("path");
  } else if (plugin === "v2ray-plugin") {
    if (value.mode === "websocket") add("ws", true);
    if (value.host !== undefined) add("ws-headers", `Host:${formatSurgeParamValue(value.host)}`);
    if (value.path !== undefined) add("ws-path", value.path);
    if (value.tls !== undefined) add("tls", value.tls);
    consumed.add("mode");
    consumed.add("host");
    consumed.add("path");
    consumed.add("tls");
  }
  for (const [key, item] of Object.entries(value)) {
    if (consumed.has(key)) continue;
    writeFlattenedParams(`plugin-${key}`, item, add);
  }
}

function isTranslatedSurgePlugin(value: ProxyParamValue): boolean {
  return value === "obfs" || value === "simple-obfs" || value === "v2ray-plugin";
}

function writeSnellObfsOpts(value: ProxyParamValue, add: (key: string, value: ProxyParamValue | undefined) => void): void {
  if (!isProxyParamRecord(value)) {
    add("obfs-opts", value);
    return;
  }
  if (value.mode !== undefined) add("obfs", value.mode);
  if (value.host !== undefined) add("obfs-host", value.host);
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

function formatHysteria2SurgePorts(value: ProxyParamValue): ProxyParamValue {
  return typeof value === "string"
    ? value.split(/[,/]/).map((item) => item.trim()).filter(Boolean).join(";")
    : value;
}

function formatHeaderParams(value: ProxyParamValue): string {
  if (!isProxyParamRecord(value)) return formatSurgeParamValue(value);
  return Object.entries(value)
    .map(([key, item]) => `${key}:${formatSurgeParamValue(item)}`)
    .join("|");
}
