import { isIP } from "node:net";
import { migrateClashRouting } from "./clash-routing-migration";
import { defaultSingboxConfig, dnsServerFromUrl, convertRule, issue } from "./singbox-config";
import { splitGroupSpec, parseGroupOption } from "./policy-group-spec";
import type { AppConfig, ProxyParamValue, SurgeConfig } from "./types";

type JsonObject = Record<string, ProxyParamValue>;

/** Initialize once from the other clients. Subsequent edits remain independent. */
export function initializeSingbox(clash: AppConfig["clients"]["clash"], surge: SurgeConfig): AppConfig["clients"]["singbox"] {
  const result: AppConfig["clients"]["singbox"] = {
    ...defaultSingboxConfig(), groups: {}, disabledGroups: [...clash.disabledGroups],
    ruleSets: { mode: "compiled", aggregateByPolicy: false, sources: [], outputs: [], directRules: [] },
    log: { level: "info", timestamp: true },
    inbounds: [{ type: "tun", tag: "tun-in", address: clash.ipv6 ? ["172.19.0.1/30", "fdfe:dcba:9876::1/126"] : ["172.19.0.1/30"], auto_route: true }],
    route: { auto_detect_interface: true, final: "Proxy" }
  };
  const warn = (path: string, code: string, message: string): void => { result.migrationIssues.push(issue(`clients.singbox.${path}`, code, "warning", message)); };
  for (const [name, spec] of Object.entries(clash.groups)) {
    const [originalType, ...parts] = splitGroupSpec(spec);
    const type = originalType === "url-test" ? "url-test" : "select";
    if (originalType !== type) warn("groups", "clash-group-type", `${name} 的 ${originalType} 已转换为手动选择组。`);
    const supported = type === "url-test" ? ["url", "interval", "tolerance", "idle_timeout"] : ["default"];
    const members = parts.filter((part) => {
      const option = parseGroupOption(part);
      if (!option || supported.includes(option.key)) return true;
      warn("groups", "clash-group-option", `${name} 的 ${option.key} 选项未迁移。`);
      return false;
    });
    result.groups[name] = [type, ...members].join(", ");
  }
  result.groups.Proxy ||= "select, {all}, DIRECT";
  result.disabledGroups = result.disabledGroups.filter((name) => name !== "Proxy");

  const migrated = migrateClashRouting(clash);
  if (migrated.issues.length) {
    for (const message of migrated.issues) result.migrationIssues.push(issue("clients.singbox.ruleSets", "clash-routing", "error", message));
  } else {
    result.ruleSets = structuredClone(migrated.client.ruleSets);
    result.ruleSets.aggregateByPolicy = false;
    result.ruleSets.outputs.forEach((output) => { delete output.provider; delete output.surgeType; output.surgeOptions = output.surgeOptions.filter((option) => option === "no-resolve"); });
    result.ruleSets.directRules = result.ruleSets.directRules.filter((rule) => {
      if (/^(MATCH|FINAL)$/i.test(rule.rule)) {
        rule.rule = "FINAL";
        if (rule.enabled) result.route.final = rule.policy;
        return true;
      }
      try { convertRule(rule.rule); return true; }
      catch {
        // The rule compiler handles ASN expansion, no-resolve CIDRs and unsupported matches.
        let name = `rule-${rule.id}`;
        while (result.ruleSets.outputs.some((output) => output.name === name)) name += "-rule";
        result.ruleSets.outputs.push({ name, enabled: rule.enabled, policy: rule.policy, order: rule.order, sourceIds: [], inlineRules: [rule.rule], surgeOptions: [] });
        warn("ruleSets", "clash-rule-compile", `单条规则 ${rule.id} 将通过规则集转换；不支持的匹配会跳过并报告。`);
        return false;
      }
    });
  }

  const servers: JsonObject[] = [];
  const addServers = (values: string[], prefix: string): string[] => values.flatMap((value, index) => {
    try { const server = dnsServerFromUrl(value, `${prefix}-${index + 1}`); servers.push(server); return [String(server.tag)]; }
    catch { result.migrationIssues.push(issue("clients.singbox.dns", "clash-dns-address", "error", `${prefix} 第 ${index + 1} 个 DNS 地址无法转换，请修改该解析器。`)); return []; }
  });
  const bootstrap = addServers(clash.defaultNameservers, "dns-bootstrap");
  const primary = addServers(clash.nameservers, "dns-main");
  const fallback = addServers(clash.fallbackNameservers, "dns-fallback");
  let resolver = servers.find((server) => bootstrap.includes(String(server.tag)) && (server.type === "local" || typeof server.server === "string" && isIP(server.server)))?.tag;
  if (!resolver) {
    resolver = "dns-system";
    servers.push({ type: "local", tag: resolver });
  }
  for (const server of servers) if (typeof server.server === "string" && !isIP(server.server)) server.domain_resolver = resolver;
  result.route.default_domain_resolver = resolver;
  const realServers = primary.length ? primary : fallback.length ? fallback : [String(resolver)];
  result.dns = { servers, final: realServers[0]!, ...(clash.dnsIpv6 ? {} : { strategy: "ipv4_only" }) };
  const rules: JsonObject[] = [];
  if (clash.dnsEnhancedMode === "fake-ip") {
    servers.push({ type: "fakeip", tag: "dns-fakeip", inet4_range: clash.dnsFakeIpRange || "198.18.0.0/15", ...(clash.dnsIpv6 ? { inet6_range: "fc00::/18" } : {}) });
    const patterns = clash.fakeIpFilter.flatMap((entry) => {
      if (/^(geosite|rule-set):/i.test(entry)) { warn("dns", "clash-fakeip-filter", "Fake IP 的 geosite/rule-set 筛选未迁移，请改为域名规则。"); return []; }
      const suffix = entry.startsWith("+.") || entry.startsWith(".");
      const value = suffix ? entry.replace(/^\+?\./, "") : entry;
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, "[^.]*").replace(/\\\?/g, "[^.]");
      return [`^${suffix ? "(?:.*\\.)?" : ""}${escaped}\\.?$`];
    });
    rules.push({ type: "logical", mode: "and", rules: [{ query_type: clash.dnsIpv6 ? ["A", "AAAA"] : ["A"] }, ...(patterns.length ? [{ domain_regex: patterns, invert: true }] : [])], action: "route", server: "dns-fakeip" });
    result.experimental = { cache_file: { enabled: true, store_fakeip: true } };
  }
  // Keep all resolvers and use evaluated replies for ordered failover and CIDR filtering.
  const candidates = [...realServers, ...fallback.filter((tag) => !realServers.includes(tag))];
  for (const server of candidates) {
    rules.push({ action: "evaluate", server });
    const matches: JsonObject[] = [{ type: "logical", mode: "or", rules: [{ match_response: true, response_rcode: "NOERROR" }, { match_response: true, response_rcode: "NXDOMAIN" }] }];
    if (primary.includes(server) && fallback.length && clash.fallbackFilterIpcidr.length) matches.push({ match_response: true, ip_cidr: [...clash.fallbackFilterIpcidr], invert: true });
    rules.push({ type: "logical", mode: "and", rules: matches, action: "respond" });
  }
  result.dns.rules = rules;
  if (fallback.length && clash.fallbackFilterGeoip) warn("dns", "clash-dns-geoip", "备用 DNS 的 GeoIP 国家过滤无法直接迁移；已保留解析器和 IP-CIDR 过滤，请核对解析结果。" );
  if (candidates.length > 1) warn("dns", "clash-dns-order", "多个 DNS 解析器按配置顺序尝试，未复制 Clash 的并发解析行为。" );

  result.endpoints = surge.tailscaleNodes.filter((node) => node.enabled).map((node, index) => {
    const endpoint: JsonObject = { type: "tailscale", tag: node.name, state_directory: `tailscale-${index + 1}`, accept_routes: true };
    for (const [key, value] of [["auth_key", node.authKey], ["control_url", node.controlUrl], ["hostname", node.hostname]] as const) if (value) endpoint[key] = value;
    if (node.exitNode && node.exitNode !== "none") endpoint.exit_node = node.exitNode;
    if (node.underlyingProxy && node.underlyingProxy !== "DIRECT") endpoint.detour = node.underlyingProxy;
    const dnsTag = `dns-tailscale-${index + 1}`;
    servers.push({ type: "tailscale", tag: dnsTag, endpoint: node.name });
    rules.unshift({ preferred_by: [dnsTag], action: "route", server: dnsTag });
    if (node.derpOnly || node.idleKeepalive || node.preferIpv6 || node.dnsServer.some((address) => address !== "100.100.100.100") || node.mtu) warn("endpoints", "surge-tailscale-options", `${node.name} 的 DERP、保活、DNS、IPv6 偏好或 MTU 选项没有直接对应项，未复制。`);
    return endpoint;
  });
  return result;
}
