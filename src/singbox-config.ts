import { isIP } from "node:net";
import { splitRuleLine } from "./rule-line";
import { ruleTargetIndex } from "./rule-targets";
import type { AppConfig, ConfigDiagnostic, HostEntry, ProxyParamValue } from "./types";

type JsonObject = Record<string, ProxyParamValue>;

/** Native defaults owned by sing-box, independent of every other client. */
export function defaultSingboxConfig(): AppConfig["clients"]["singbox"] {
  return {
    coreVersion: "1.15.0-alpha.6",
    log: { level: "info", timestamp: true },
    dns: { servers: [{ type: "udp", tag: "dns-direct", server: "1.1.1.1" }], final: "dns-direct" },
    inbounds: [{ type: "tun", tag: "tun-in", address: ["172.19.0.1/30", "fdfe:dcba:9876::1/126"], auto_route: true }],
    route: { auto_detect_interface: true, default_domain_resolver: "dns-direct", final: "Proxy" },
    experimental: {},
    groups: { Proxy: "select, {all}, DIRECT" },
    disabledGroups: [],
    ruleSets: {
      mode: "compiled", aggregateByPolicy: false, sources: [], outputs: [],
      directRules: [{ id: "singbox-final", rule: "FINAL", policy: "Proxy", enabled: true, order: 0 }]
    }
  };
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
  const headlessIp = headless && ["IP-CIDR", "IP-CIDR6"].includes(type);
  if (parts.slice((targetIndex ?? 1) + 1).some((part) => part && part !== "no-resolve" && !(headlessIp && part === "src"))) throw new Error("规则选项无法等价转换");
  // Headless IP matches use available addresses; they never trigger DNS resolution.
  if (parts.includes("no-resolve") && !headlessIp) throw new Error("no-resolve 需显式配置解析与路由顺序");
  if (type === "GEOIP" && parts[1]?.toLowerCase() === "private") return { rule: { ip_is_private: true, ...policyAction(policy) } };
  let field = headlessIp && parts.includes("src") ? "source_ip_cidr" : RULE_FIELDS[type];
  if (!field) throw new Error(`${type || "未知"} 需要手动转换或关联支持的规则来源`);
  const value = parts[1]?.trim();
  if (!value) throw new Error("缺少匹配值");
  let match: ProxyParamValue = [value];
  if (field === "port" || field === "source_port") {
    const values = value.split("/");
    if (values.some((item) => !/^\d+(?:-\d+)?$/.test(item) || item.split("-").some((port) => Number(port) > 65535)
      || item.includes("-") && Number(item.split("-")[0]) > Number(item.split("-")[1]))) throw new Error("端口或范围无效");
    if (values.some((item) => item.includes("-"))) {
      field += "_range";
      match = values.map((item) => item.includes("-") ? item.replace("-", ":") : `${item}:${item}`);
    } else match = values.map(Number);
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
