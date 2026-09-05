import { isIP } from "node:net";
import { splitRuleLine } from "./rule-line";
import { ruleTargetIndex } from "./rule-targets";
import type { ConfigDiagnostic, HostEntry, ProxyParamValue, RenderConfig, SingboxConfig } from "./types";

type JsonObject = Record<string, ProxyParamValue>;

export function defaultSingboxConfig(): SingboxConfig {
  return {
    coreVersion: "1.14.0", log: { level: "info", timestamp: true },
    dns: { servers: [{ type: "udp", tag: "dns-direct", server: "1.1.1.1" }], final: "dns-direct" },
    inbounds: [{ type: "tun", tag: "tun-in", address: ["172.19.0.1/30"], auto_route: true, stack: "system" }],
    route: { auto_detect_interface: true, default_domain_resolver: "dns-direct", rules: [{ protocol: "dns", action: "hijack-dns" }], final: "Proxy" },
    experimental: { cache_file: { enabled: true } }, migrationIssues: []
  };
}

export function convertSurgeToSingbox(config: RenderConfig): SingboxConfig {
  const result = defaultSingboxConfig();
  const issues = result.migrationIssues;
  const surge = config.surge;
  const servers: JsonObject[] = [];
  for (const [index, value] of [...surge.dnsServer, ...surge.encryptedDnsServer].entries()) {
    try { servers.push(dnsServerFromUrl(value, `dns-${index + 1}`)); }
    catch { issues.push(issue(`clients.singbox.dns.servers`, "dns-conversion", "error", `DNS 服务器 #${index + 1} 无法等价转换，请手动配置。`)); }
  }
  if (servers.length) {
    result.dns.servers = servers;
    // Bootstrap encrypted resolver hostnames using an IP-addressed resolver.
    const bootstrap = servers.find((server) => typeof server.server === "string" && isIP(server.server));
    if (bootstrap) {
      result.route.default_domain_resolver = bootstrap.tag!;
      for (const server of servers) {
        if (typeof server.server === "string" && !isIP(server.server)) server.domain_resolver = bootstrap.tag!;
      }
    }
    if (!bootstrap) { servers.push({ type: "udp", tag: "dns-direct", server: "1.1.1.1" });
      for (const server of servers) if (typeof server.server === "string" && !isIP(server.server)) server.domain_resolver = "dns-direct";
      issues.push(issue("clients.singbox.dns", "dns-bootstrap", "warning", "已添加默认引导解析器，请确认其符合网络要求。"));
    }
    result.dns.final = servers[0]!.tag!;
  }
  result.inbounds[0]!.address = surge.ipv6 ? ["172.19.0.1/30", "fdfe:dcba:9876::1/126"] : ["172.19.0.1/30"];
  result.inbounds[0]!.route_exclude_address = surge.tunExcludedRoutes;
  if (surge.allowWifiAccess) result.inbounds.push({ type: "mixed", tag: "mixed-in", listen: "0.0.0.0", listen_port: 7890 });
  const rules: JsonObject[] = [{ protocol: "dns", action: "hijack-dns" }];
  if (config.ruleSets.mode !== "compiled") {
    surge.rules.forEach((line, index) => {
      if (!line.trim() || /^\s*[#;]/.test(line)) return;
      try {
        const converted = convertRule(line);
        if (converted.final) {
          const action = policyAction(converted.final);
          if (action.action === "reject") { rules.push(action); delete result.route.final; }
          else if (typeof action.outbound === "string") result.route.final = action.outbound;
        }
        else if (converted.rule) rules.push(converted.rule);
      } catch (error) {
        issues.push(issue("clients.singbox.route.rules", `surge-rule-${index + 1}`, "error", `Surge 规则 #${index + 1}：${error instanceof Error ? error.message : "无法转换"}`));
      }
    });
  }
  result.route.rules = rules;
  mergeSingboxHosts(result.dns, surge.hosts.flatMap((line) => {
    if (!line.trim() || /^\s*[#;]/.test(line)) return [];
    const at = line.indexOf("=");
    return [{ host: line.slice(0, at).trim(), value: line.slice(at + 1).trim() }];
  }), issues);
  for (const field of ["urlRewrite", "mapLocal", "scripts", "ponteDeviceNames", "tailscaleNodes", "alwaysRealIp", "skipProxy"] as const) {
    if (surge[field].length) issues.push(issue(`clients.singbox`, `surge-${field}`, field === "skipProxy" ? "error" : "warning", `Surge ${field} 未自动转换，请检查 sing-box 对应设置。`));
  }
  if (surge.mitm.hostname.length) issues.push(issue("clients.singbox", "surge-mitm", "warning", "sing-box 不输出 MITM 配置。"));
  return result;
}

export function mergeSingboxHosts(dns: JsonObject, hosts: HostEntry[], diagnostics: ConfigDiagnostic[]): void {
  const predefined: JsonObject = {};
  for (const [index, entry] of hosts.entries()) {
    const addresses = (Array.isArray(entry.value) ? entry.value : entry.value.split(",")).map((value) => value.trim());
    if (!/^[a-z\d_-]+(?:\.[a-z\d_-]+)*\.?$/i.test(entry.host) || !addresses.length || addresses.some((value) => !isIP(value))) {
      diagnostics.push(issue("clients.singbox.dns", `hosts-${index + 1}`, "error", `Hosts 第 ${index + 1} 项包含通配、别名或指定解析器，请手动转换。`));
      continue;
    }
    if (predefined[entry.host] === undefined) predefined[entry.host] = addresses;
  }
  if (!Object.keys(predefined).length) return;
  const servers = Array.isArray(dns.servers) ? dns.servers as JsonObject[] : [];
  let tag = "subpilot-hosts";
  while (servers.some((server) => server.tag === tag)) tag += "-source";
  dns.servers = [...servers, { type: "hosts", tag, predefined }];
  // Explicit client DNS rules have priority over hosts obtained from shared sources.
  dns.rules = [...(Array.isArray(dns.rules) ? dns.rules : []), { domain: Object.keys(predefined), action: "route", server: tag }];
}

export function issue(path: string, code: string, severity: ConfigDiagnostic["severity"], message: string): ConfigDiagnostic {
  return { target: "sing-box", path, code, severity, message };
}

export function dnsServerFromUrl(value: string, tag: string): JsonObject {
  if (value === "system") return { type: "local", tag };
  const url = new URL(value.includes("://") ? value : `udp://${value.includes(":") && isIP(value) === 6 ? `[${value}]` : value}`);
  const type = ({ "udp:": "udp", "tcp:": "tcp", "tls:": "tls", "https:": "https", "quic:": "quic", "h3:": "h3" } as Record<string,string>)[url.protocol];
  if (!type || !url.hostname || url.username || url.password || url.search) throw new Error("Unsupported resolver");
  return { type, tag, server: url.hostname.replace(/^\[|\]$/g, ""), ...(url.port ? { server_port: Number(url.port) } : {}), ...(type === "https" || type === "h3" ? { path: url.pathname || "/dns-query" } : {}) };
}

const RULE_FIELDS: Record<string, string> = {
  DOMAIN: "domain", "DOMAIN-SUFFIX": "domain_suffix", "DOMAIN-KEYWORD": "domain_keyword", "DOMAIN-REGEX": "domain_regex",
  "IP-CIDR": "ip_cidr", "IP-CIDR6": "ip_cidr", "SRC-IP": "source_ip_cidr", "SRC-IP-CIDR": "source_ip_cidr",
  "PROCESS-NAME": "process_name", "PROCESS-PATH": "process_path", "PROCESS-PATH-REGEX": "process_path_regex",
  "DST-PORT": "port", "DEST-PORT": "port", "SRC-PORT": "source_port",
  NETWORK: "network", PROTOCOL: "network"
};

export function convertRule(line: string, headless = false): { rule?: JsonObject; final?: string } {
  const parts = splitRuleLine(line);
  const type = (parts[0] ?? "").toUpperCase();
  const targetIndex = headless ? null : ruleTargetIndex(parts);
  const policy = targetIndex === null ? undefined : parts[targetIndex];
  if (type === "FINAL" || type === "MATCH") {
    if (!policy || parts.length !== 2) throw new Error("默认策略或附加选项无法等价转换");
    policyAction(policy);
    return { final: policy };
  }
  if (["AND", "OR", "NOT"].includes(type)) throw new Error("逻辑规则需手动转换为 sing-box logical 规则");
  if (parts.slice((targetIndex ?? 1) + 1).some((part) => part && part !== "no-resolve")) throw new Error("规则选项无法等价转换");
  if (parts.includes("no-resolve")) throw new Error("no-resolve 需显式配置解析与路由顺序");
  if (type === "GEOIP" && parts[1]?.toLowerCase() === "private") return { rule: { ip_is_private: true, ...policyAction(policy) } };
  const field = RULE_FIELDS[type];
  if (!field) throw new Error(`${type || "未知"} 需要手动转换或关联支持的规则来源`);
  const value = parts[1]?.trim();
  if (!value) throw new Error("缺少匹配值");
  let match: ProxyParamValue = [value];
  if (field === "port" || field === "source_port") {
    if (!/^\d+$/.test(value)) throw new Error("端口范围需要手动转换");
    match = [Number(value)];
  }
  if (field === "network" && !["tcp", "udp"].includes(value.toLowerCase())) throw new Error("网络协议无法等价转换");
  return { rule: { [field]: field === "network" ? [value.toLowerCase()] : match, ...(headless ? {} : policyAction(policy)) } };
}

export function policyAction(policy?: string): JsonObject {
  if (!policy) return {};
  if (policy === "REJECT") return { action: "reject" };
  if (policy === "REJECT-DROP") return { action: "reject", method: "drop" };
  if (/^(CELLULAR|HYBRID|NO-HYBRID|REJECT-|DEVICE:|PASS|COMPATIBLE|GLOBAL)/.test(policy)) throw new Error("目标策略无法等价转换");
  return { action: "route", outbound: policy };
}
