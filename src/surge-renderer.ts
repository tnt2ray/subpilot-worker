import { managedSubscriptionUrlForRequest } from "./managed-url";
import { isIPv4, isIPv6 } from "./node-transforms";
import { beijingTimestamp, renderHostEntryLine, renderSection } from "./output-render";
import { toSurgeLine } from "./parsers";
import { buildSurgeGroups, type SurgeGroupOutput } from "./policy-groups";
import { rewriteUnavailableGroupRuleTargets } from "./rule-targets";
import { parseHostEntries } from "./host-entries";
import type { CompiledRuleSetReferencePlan } from "./rule-set-compiler";
import type { AppConfig, HostEntry, ProxyNode } from "./types";

const DEFAULT_SURGE_LOGLEVEL = "notify";

export function buildSurge(
  config: AppConfig,
  nodes: ProxyNode[],
  sourceHostEntries: HostEntry[],
  requestUrl: string,
  ruleSetPlan?: CompiledRuleSetReferencePlan
): string {
  return buildSurgeInline(config, nodes, sourceHostEntries, requestUrl, ruleSetPlan);
}

function buildSurgeInline(
  config: AppConfig,
  nodes: ProxyNode[],
  sourceHostEntries: HostEntry[],
  requestUrl: string,
  ruleSetPlan?: CompiledRuleSetReferencePlan
): string {
  const proxyLines = nodes.map(toSurgeLine);
  const groupOutputs = buildSurgeGroups(config, nodes);
  const variant = renderSurgeInlineProfile(config, nodes, sourceHostEntries, proxyLines, groupOutputs, ruleSetPlan);
  const managedUrl = managedSubscriptionUrlForRequest(config, requestUrl);
  return `#!MANAGED-CONFIG ${managedUrl} interval=${config.surge.managedConfigIntervalSeconds} strict=true\n# Last Updated: ${beijingTimestamp()} (UTC+8)\n${variant}`;
}

function renderSurgeInlineProfile(
  config: AppConfig,
  nodes: ProxyNode[],
  sourceHostEntries: HostEntry[],
  proxyLines: string[],
  groupOutputs: SurgeGroupOutput[],
  ruleSetPlan?: CompiledRuleSetReferencePlan
): string {
  const sections = renderSurgeBaseSections(config);
  const configuredHostEntries = parseHostEntries(`[Host]\n${config.surge.hosts.join("\n")}`);
  const autoProxyHostLines = proxyServerHostEntries(config, nodes, [...configuredHostEntries, ...sourceHostEntries]).map(renderHostEntryLine);
  const sourceHostLines = sourceHostEntries.map(renderHostEntryLine);
  const hostLines = [...config.surge.hosts, ...sourceHostLines, ...autoProxyHostLines];
  if (hostLines.length > 0) {
    sections.push(renderSection("Host", [...new Set(hostLines)]));
  }
  const tailscaleNodes = config.surge.tailscaleNodes.filter((node) => node.enabled && node.authKey);
  sections.push(renderSection("Proxy", [
    ...proxyLines,
    ...tailscaleNodes.map(renderTailscaleProxyLine)
  ]));
  sections.push(...tailscaleNodes.map(renderTailscaleSection));
  sections.push(renderSection("Proxy Group", groupOutputs.map((group) => group.line)));
  appendSurgeStableTailSections(sections, config);
  appendSurgeRuleSection(sections, config, nodes, groupOutputs, ruleSetPlan);
  return `${sections.join("\n\n")}\n`;
}

function renderTailscaleProxyLine(node: AppConfig["surge"]["tailscaleNodes"][number]): string {
  const options = [`section-name=${node.sectionName}`];
  if (node.underlyingProxy) options.push(`underlying-proxy=${node.underlyingProxy}`);
  if (node.testUrl) options.push(`test-url=${node.testUrl}`);
  if (node.testTimeout !== 5) options.push(`test-timeout=${node.testTimeout}`);
  return `${node.name} = tailscale, ${options.join(", ")}`;
}

function renderTailscaleSection(node: AppConfig["surge"]["tailscaleNodes"][number]): string {
  const lines = [`auth-key = ${node.authKey}`];
  if (node.controlUrl) lines.push(`control-url = ${node.controlUrl}`);
  if (node.hostname) lines.push(`hostname = ${node.hostname}`);
  if (node.derpOnly) lines.push("derp-only = true");
  if (node.exitNode && node.exitNode !== "none") lines.push(`exit-node = ${node.exitNode}`);
  if (node.idleKeepalive !== 600) lines.push(`idle-keepalive = ${node.idleKeepalive}`);
  if (node.preferIpv6) lines.push("prefer-ipv6 = true");
  if (node.dnsServer.length > 0) lines.push(`dns-server = ${node.dnsServer.join(", ")}`);
  if (node.mtu !== 1280) lines.push(`mtu = ${node.mtu}`);
  return renderSection(`Tailscale ${node.sectionName}`, lines);
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
  if (config.surge.mapLocal.length > 0) {
    sections.push(renderSection("Map Local", config.surge.mapLocal));
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

function appendSurgeRuleSection(
  sections: string[],
  config: AppConfig,
  nodes: ProxyNode[],
  groupOutputs: SurgeGroupOutput[],
  ruleSetPlan?: CompiledRuleSetReferencePlan
): void {
  const rules = config.ruleSets.mode === "compiled" && ruleSetPlan ? ruleSetPlan.surgeRules : config.surge.rules;
  const tailscalePolicies = new Set(config.surge.tailscaleNodes.filter((node) => node.enabled && node.authKey).map((node) => node.name));
  sections.push(renderSection("Rule", rewriteUnavailableGroupRuleTargets(
    config,
    rules,
    nodes,
    new Set(groupOutputs.map((group) => group.name)),
    tailscalePolicies
  )));
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
