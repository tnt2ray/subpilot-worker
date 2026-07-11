import { formatSurgeParamValue, isProxyParamRecord, normalizeProxyParams } from "./proxy-params";
import { isSafeConfigText } from "./config-text-safety";
import { asString, toPort } from "./proxy-value";
import type { ProxyNode } from "./types";

const URI_PROTOCOLS = ["trojan:", "vless:", "vmess:", "ss:", "hysteria2:", "hy2:", "tuic:", "anytls:"];

export function parseProxyUrl(value: string): ProxyNode | null {
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
