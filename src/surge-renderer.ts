import { managedSubscriptionUrlForRequest } from "./managed-url";
import { isIPv4, isIPv6 } from "./node-transforms";
import { beijingTimestamp, renderHostEntryLine, renderSection } from "./output-render";
import { toSurgeLine } from "./parsers";
import { buildSurgeGroups, type SurgeGroupOutput } from "./policy-groups";
import { rewriteUnavailableGroupRuleTargets } from "./rule-targets";
import { parseHostEntries } from "./host-entries";
import type { AppConfig, HostEntry, ProxyNode } from "./types";

const DEFAULT_SURGE_LOGLEVEL = "notify";

interface SurgeRenderOptions {
  includeProxyServerHostEntries?: boolean;
}

export function buildSurge(config: AppConfig, nodes: ProxyNode[], sourceHostEntries: HostEntry[], requestUrl: string): string {
  return buildSurgeInline(config, nodes, sourceHostEntries, requestUrl);
}

export function buildSurgeValidationProfile(config: AppConfig, nodes: ProxyNode[], sourceHostEntries: HostEntry[], requestUrl: string): string {
  return buildSurgeInline(config, nodes, sourceHostEntries, requestUrl, { includeProxyServerHostEntries: false });
}

function buildSurgeInline(
  config: AppConfig,
  nodes: ProxyNode[],
  sourceHostEntries: HostEntry[],
  requestUrl: string,
  options: SurgeRenderOptions = {}
): string {
  const proxyLines = nodes.map(toSurgeLine);
  const groupOutputs = buildSurgeGroups(config, nodes);
  const variant = renderSurgeInlineProfile(config, nodes, sourceHostEntries, proxyLines, groupOutputs, options);
  const managedUrl = managedSubscriptionUrlForRequest(config, requestUrl);
  return `#!MANAGED-CONFIG ${managedUrl} interval=${config.surge.managedConfigIntervalSeconds} strict=true\n# Last Updated: ${beijingTimestamp()} (UTC+8)\n${variant}`;
}

function renderSurgeInlineProfile(
  config: AppConfig,
  nodes: ProxyNode[],
  sourceHostEntries: HostEntry[],
  proxyLines: string[],
  groupOutputs: SurgeGroupOutput[],
  options: SurgeRenderOptions = {}
): string {
  const sections = renderSurgeBaseSections(config);
  const configuredHostEntries = parseHostEntries(`[Host]\n${config.surge.hosts.join("\n")}`);
  const autoProxyHostLines = options.includeProxyServerHostEntries === false
    ? []
    : proxyServerHostEntries(config, nodes, [...configuredHostEntries, ...sourceHostEntries]).map(renderHostEntryLine);
  const sourceHostLines = sourceHostEntries.map(renderHostEntryLine);
  const hostLines = [...config.surge.hosts, ...sourceHostLines, ...autoProxyHostLines];
  if (hostLines.length > 0) {
    sections.push(renderSection("Host", [...new Set(hostLines)]));
  }
  sections.push(renderSection("Proxy", proxyLines));
  sections.push(renderSection("Proxy Group", groupOutputs.map((group) => group.line)));
  appendSurgeStableTailSections(sections, config);
  appendSurgeRuleSection(sections, config, nodes, groupOutputs);
  return `${sections.join("\n\n")}\n`;
}

function renderSurgeBaseSections(config: AppConfig): string[] {
  const sections: string[] = [];
  const generalLines = [
    `loglevel = ${DEFAULT_SURGE_LOGLEVEL}`,
    `skip-proxy = ${config.surge.skipProxy.join(", ")}`,
    `dns-server = ${config.surge.dnsServer.join(", ")}`,
    `always-real-ip = ${config.surge.alwaysRealIp.join(", ")}`,
    `internet-test-url = ${config.surge.internetTestUrl}`,
    `proxy-test-url = ${config.surge.proxyTestUrl}`,
    `show-error-page-for-reject = ${config.surge.showErrorPageForReject ? "true" : "false"}`,
    `ipv6 = ${config.surge.ipv6 ? "true" : "false"}`,
    `allow-wifi-access = ${config.surge.allowWifiAccess ? "true" : "false"}`
  ];
  if (config.surge.ipv6) {
    generalLines.push(`ipv6-vif = ${config.surge.ipv6Vif}`);
  }
  if (config.surge.tunExcludedRoutes.length > 0) {
    generalLines.push(`tun-excluded-routes = ${config.surge.tunExcludedRoutes.join(", ")}`);
  }
  if (config.surge.encryptedDnsServer.length > 0) {
    generalLines.push(`encrypted-dns-server = ${config.surge.encryptedDnsServer.join(", ")}`);
  }
  generalLines.push(
    `wifi-assist = ${config.surge.wifiAssist ? "true" : "false"}`,
    `exclude-simple-hostnames = ${config.surge.excludeSimpleHostnames ? "true" : "false"}`
  );
  if (config.surge.encryptedDnsServer.length > 0) {
    generalLines.push(`encrypted-dns-follow-outbound-mode = ${config.surge.encryptedDnsFollowOutboundMode ? "true" : "false"}`);
  }
  sections.push(renderSection("General", generalLines));
  return sections;
}

function appendSurgeStableTailSections(sections: string[], config: AppConfig): void {
  if (config.surge.urlRewrite.length > 0) {
    sections.push(renderSection("URL Rewrite", config.surge.urlRewrite));
  }
  if (config.surge.scripts.length > 0) {
    sections.push(renderSection("Script", config.surge.scripts));
  }
  sections.push(renderSection("MITM", [
    `skip-server-cert-verify = ${config.surge.mitm.skipServerCertVerify ? "true" : "false"}`,
    `h2 = ${config.surge.mitm.h2 ? "true" : "false"}`,
    `hostname = ${config.surge.mitm.hostname.join(", ")}`,
    `ca-passphrase = ${config.surge.mitm.caPassphrase}`,
    `ca-p12 = ${config.surge.mitm.caP12}`
  ]));
}

function appendSurgeRuleSection(sections: string[], config: AppConfig, nodes: ProxyNode[], groupOutputs: SurgeGroupOutput[]): void {
  const rules = config.surge.rules;
  sections.push(renderSection("Rule", rewriteUnavailableGroupRuleTargets(config, rules, nodes, new Set(groupOutputs.map((group) => group.name)))));
}

function proxyServerHostEntries(config: AppConfig, nodes: ProxyNode[], existingEntries: HostEntry[]): HostEntry[] {
  if (!config.surge.encryptedDnsFollowOutboundMode || config.surge.encryptedDnsServer.length === 0) return [];
  const dnsServer = firstSurgeEncryptedDnsServer(config);
  if (!dnsServer) return [];
  const mappedHosts = existingEntries.map((entry) => entry.host);
  const seen = new Set<string>();
  return nodes.flatMap((node) => {
    const host = proxyServerHost(node.server);
    if (!host || seen.has(host) || hostEntryCoversHost(mappedHosts, host)) return [];
    seen.add(host);
    return [{ host, value: `server:${dnsServer}` }];
  });
}

function firstSurgeEncryptedDnsServer(config: AppConfig): string {
  return config.surge.encryptedDnsServer.map((server) => String(server).trim()).find(Boolean) || "";
}

function proxyServerHost(value: string): string {
  const host = value.trim().replace(/\.$/, "").toLowerCase();
  if (!host || !host.includes(".") || isIPv4(host) || isIPv6(host)) return "";
  if (!/^[a-z0-9.-]+$/.test(host)) return "";
  return host;
}

function hostEntryCoversHost(entries: string[], host: string): boolean {
  return entries.some((entry) => {
    const normalized = entry.trim().replace(/\.$/, "").toLowerCase();
    return normalized === host || (normalized.startsWith("*.") && host.endsWith(normalized.slice(1)));
  });
}
