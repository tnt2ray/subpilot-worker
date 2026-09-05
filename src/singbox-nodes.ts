import type { ProxyNode, ProxyParamValue, Target } from "./types";

type JsonObject = Record<string, ProxyParamValue>;
export const SINGBOX_PROTOCOLS = new Set(["http", "https", "socks5", "socks5-tls", "ss", "snell", "trojan", "vmess", "vless", "hysteria2", "hy2", "tuic-v5", "anytls", "ssh"]);
const NORMAL_TYPE: Record<string,string> = { shadowsocks: "ss", socks: "socks5", tuic: "tuic-v5" };

export function parseSingboxNodes(content: string, sourceId: string): ProxyNode[] {
  let value: unknown;
  try { value = JSON.parse(content); } catch { return []; }
  const object = record(value);
  const entries = Array.isArray(object?.outbounds) ? object.outbounds : Array.isArray(value) ? value : object?.type ? [object] : [];
  return entries.flatMap((entry, index): ProxyNode[] => {
    const outbound = record(entry);
    if (!outbound || typeof outbound.type !== "string" || typeof outbound.server !== "string") return [];
    const tls = record(outbound.tls);
    const transport = record(outbound.transport);
    const type = tls?.enabled && outbound.type === "socks" ? "socks5-tls" : tls?.enabled && outbound.type === "http" ? "https" : NORMAL_TYPE[outbound.type] ?? outbound.type;
    const params: JsonObject = {};
    const fields: Record<string,string> = { username: "username", password: "password", alter_id: "alter-id", security: "cipher", flow: "flow", congestion_control: "congestion-controller", up_mbps: "up", down_mbps: "down", detour: "dialer-proxy", version: "version", user: "username", psk: "psk", userkey: "userkey" };
    for (const [from,to] of Object.entries(fields)) if (outbound[from] !== undefined) params[to] = outbound[from]!;
    if (tls?.enabled) {
      params.tls = true;
      if (tls.server_name) params.sni = tls.server_name;
      if (tls.insecure !== undefined) params["skip-cert-verify"] = tls.insecure;
      if (tls.alpn) params.alpn = tls.alpn;
      const utls = record(tls.utls); if (utls?.enabled && utls.fingerprint) params["client-fingerprint"] = utls.fingerprint;
      const reality = record(tls.reality); if (reality?.enabled) params["reality-opts"] = { "public-key": reality.public_key ?? "", "short-id": reality.short_id ?? "" };
    }
    if (transport?.type) {
      params.network = transport.type;
      if (transport.type === "ws") params["ws-opts"] = { path: transport.path ?? "/", headers: transport.headers ?? {} };
      if (transport.type === "grpc") params["grpc-opts"] = { "grpc-service-name": transport.service_name ?? "" };
    }
    const obfs = record(outbound.obfs);
    if (obfs) { params.obfs = obfs.type ?? "salamander"; params["obfs-password"] = obfs.password ?? ""; }
    return [{ name: typeof outbound.tag === "string" && outbound.tag ? outbound.tag : `sing-box-${index + 1}`, type,
      server: outbound.server, port: Number(outbound.server_port || 0),
      password: typeof (outbound.password ?? outbound.psk) === "string" ? String(outbound.password ?? outbound.psk) : undefined,
      uuid: typeof outbound.uuid === "string" ? outbound.uuid : undefined,
      cipher: typeof (outbound.method ?? outbound.security) === "string" ? String(outbound.method ?? outbound.security) : undefined,
      params, sourceId, singbox: outbound }];
  });
}

export function toSingboxOutbound(node: ProxyNode, canonical: JsonObject): JsonObject {
  if (!node.server || !Number.isInteger(node.port) || Number(node.port) < 1 || Number(node.port) > 65535) throw new Error("节点服务器或端口无效");
  if (node.singbox) {
    const output = structuredClone(node.singbox);
    output.tag = node.name; output.server = node.server; output.server_port = node.port ?? 0;
    const detour = node.params["dialer-proxy"] ?? node.params["underlying-proxy"];
    if (detour) output.detour = detour;
    return output;
  }
  const type = node.type.toLowerCase();
  if (!SINGBOX_PROTOCOLS.has(type)) throw new Error("协议不受 sing-box 支持");
  const mapped: Record<string,string> = { ss: "shadowsocks", https: "http", socks5: "socks", "socks5-tls": "socks", "tuic-v5": "tuic", hy2: "hysteria2" };
  const output: JsonObject = { type: mapped[type] ?? type, tag: node.name, server: node.server, server_port: node.port ?? 0 };
  const p = canonical;
  const convertedFields = new Set(["name", "type", "server", "port", "password", "uuid", "cipher", "username", "psk", "version", "userkey", "reuse", "mode", "obfs-opts", "obfs", "obfs-password", "up", "down", "alterId", "alter-id", "flow", "congestion-controller", "udp-relay-mode", "zero-rtt-handshake", "private-key", "tls", "sni", "servername", "skip-cert-verify", "alpn", "client-fingerprint", "reality-opts", "network", "ws", "ws-path", "ws-headers", "ws-opts", "grpc-opts", "dialer-proxy", "underlying-proxy", "plugin", "plugin-opts", "udp", "udp-relay", "tfo", "fast-open"]);
  for (const [key, value] of Object.entries(p)) if (value !== undefined && value !== "" && !convertedFields.has(key)) throw new Error(`节点选项 ${key} 无法等价转换，请使用原生 sing-box 节点配置`);
  if (node.password || type === "snell" && p.psk) output[type === "snell" ? "psk" : "password"] = node.password || p.psk!;
  if (node.uuid) output.uuid = node.uuid;
  if (p.username) output.username = p.username;
  if (type === "ss") {
    output.method = node.cipher ?? canonical.cipher ?? "";
    if (p.plugin) { output.plugin = p.plugin; throw new Error("Shadowsocks 插件选项需使用原生 sing-box 节点配置"); }
  }
  if (type === "snell") {
    const version = Number(p.version ?? 4);
    if (version !== 4 && version !== 6) throw new Error("sing-box 仅支持 Snell 4 与 6，请明确节点协议版本");
    output.version = version;
    for (const key of ["userkey", "reuse", "mode"]) if (p[key] !== undefined) output[key] = p[key]!;
    const obfs = record(p["obfs-opts"]);
    if (obfs?.mode) {
      if (!["http", "tls"].includes(String(obfs.mode))) throw new Error("Snell 混淆类型无法等价转换");
      output.obfs_mode = obfs.mode; if (obfs.host) output.obfs_host = obfs.host;
    }
  }
  if (type === "socks5" || type === "socks5-tls") output.version = "5";
  if (type === "vmess") { output.security = canonical.cipher ?? "auto"; output.alter_id = Number(p.alterId ?? p["alter-id"] ?? 0); }
  if (type === "vless" && p.flow) output.flow = p.flow;
  if (type === "hysteria2" || type === "hy2") {
    for (const key of ["up", "down"]) if (p[key]) {
      const value = String(p[key]); if (!/^\d+(?:\.\d+)?(?:\s*Mbps)?$/i.test(value)) throw new Error("Hysteria2 速率单位无法转换");
      output[`${key}_mbps`] = Number.parseFloat(value);
    }
    if (p.obfs) output.obfs = { type: p.obfs, password: p["obfs-password"] ?? "" };
  }
  if (type === "tuic-v5") {
    if (p["congestion-controller"]) output.congestion_control = p["congestion-controller"];
    if (p["udp-relay-mode"]) output.udp_relay_mode = p["udp-relay-mode"];
    if (p["zero-rtt-handshake"]) output.zero_rtt_handshake = p["zero-rtt-handshake"];
  }
  if (type === "ssh") { output.user = p.username ?? "root"; delete output.username; if (p["private-key"]) output.private_key = p["private-key"]; }
  if (p.tls === true || ["trojan", "hysteria2", "hy2", "tuic-v5", "anytls", "https", "socks5-tls"].includes(type)) {
    const tls: JsonObject = { enabled: true };
    if (p.sni || p.servername) tls.server_name = p.sni ?? p.servername!;
    if (p["skip-cert-verify"] !== undefined) tls.insecure = p["skip-cert-verify"];
    if (p.alpn) tls.alpn = Array.isArray(p.alpn) ? p.alpn : String(p.alpn).split(/[|,]/);
    if (p["client-fingerprint"]) tls.utls = { enabled: true, fingerprint: p["client-fingerprint"] };
    const reality = record(p["reality-opts"]);
    if (reality) tls.reality = { enabled: true, public_key: reality["public-key"] ?? "", short_id: reality["short-id"] ?? "" };
    output.tls = tls;
  }
  const network = String(p.network ?? (p.ws ? "ws" : "tcp"));
  if (network !== "tcp") {
    if (!["vmess", "vless", "trojan"].includes(type)) throw new Error("此协议的传输选项无法转换");
    if (network === "ws") { const ws = record(canonical["ws-opts"] ?? p["ws-opts"]); output.transport = { type: "ws", path: ws?.path ?? p["ws-path"] ?? "/", headers: ws?.headers ?? {} };
      for (const key of Object.keys(ws ?? {})) if (!["path", "headers"].includes(key)) throw new Error(`WebSocket ${key} 需要原生 sing-box 节点配置`);
    }
    else if (network === "grpc") { const grpc = record(p["grpc-opts"]); output.transport = { type: "grpc", service_name: grpc?.["grpc-service-name"] ?? "" }; }
    else throw new Error("传输类型需使用原生 sing-box 节点配置");
  }
  const detour = p["dialer-proxy"] ?? p["underlying-proxy"];
  if (detour) output.detour = detour;
  if ((p.udp === false || p["udp-relay"] === false) && !["http", "https", "ssh"].includes(type)) output.network = "tcp";
  if (p.tfo !== undefined || p["fast-open"] !== undefined) output.tcp_fast_open = p.tfo ?? p["fast-open"]!;
  return output;
}

/** Reject lossy native-node conversions before a legacy renderer sees the node. */
export function nativeNodeCompatibility(node: ProxyNode, target: Target): string | null {
  if (target === "clash" && node.type === "snell" && Number(node.params.version ?? node.raw?.version) === 6) return "mihomo 不支持 Snell 6，未改写协议版本";
  if (!node.singbox || target === "sing-box") return null;
  const native = node.singbox;
  const supported = new Set(["type", "tag", "server", "server_port", "username", "password", "uuid", "method", "security", "alter_id", "flow", "congestion_control", "up_mbps", "down_mbps", "detour", "version", "user", "psk", "userkey", "tls", "transport", "obfs"]);
  for (const key of Object.keys(native)) if (!supported.has(key)) return `原生 sing-box ${key} 选项无法等价转换`;
  const tls = record(native.tls);
  if (tls) {
    if (tls.enabled === false && ["trojan", "hysteria2", "tuic", "anytls"].includes(String(native.type))) return "当前输出端不能等价禁用此协议的 TLS";
    for (const key of Object.keys(tls)) if (!["enabled", "server_name", "insecure", "alpn", "utls", "reality"].includes(key)) return `原生 TLS ${key} 选项无法等价转换`;
    if (target === "surge" && (record(tls.reality)?.enabled || record(tls.utls)?.enabled)) return "Surge 无法等价使用原生 Reality/uTLS 参数";
    for (const key of Object.keys(record(tls.utls) ?? {})) if (!["enabled", "fingerprint"].includes(key)) return `原生 uTLS ${key} 选项无法等价转换`;
    for (const key of Object.keys(record(tls.reality) ?? {})) if (!["enabled", "public_key", "short_id"].includes(key)) return `原生 Reality ${key} 选项无法等价转换`;
  }
  const transport = record(native.transport);
  if (transport) {
    if (!["ws", "grpc"].includes(String(transport.type)) || target === "surge" && transport.type !== "ws") return "原生传输类型无法等价转换";
    for (const key of Object.keys(transport)) if (!["type", "path", "headers", "service_name"].includes(key)) return `原生传输 ${key} 选项无法等价转换`;
  }
  if (native.type === "socks" && native.version !== undefined && String(native.version) !== "5") return "原生 SOCKS 版本不是 SOCKS5";
  if (native.type === "snell" && native.userkey !== undefined && target === "clash") return "原生 Snell userkey 无法等价转换";
  if (native.type === "ssh" && target === "surge") return "原生 SSH 节点请使用 Surge 配置语法";
  return null;
}

function record(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}
