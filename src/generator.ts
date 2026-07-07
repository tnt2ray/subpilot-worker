import YAML from "yaml";
import { Buffer } from "node:buffer";
import { parseClashRuleProvidersYaml } from "./clash-rule-providers";
import { collectClashRuleCoverageWarnings } from "./clash-rules";
import { loadConfig } from "./config-store";
import { parseHostEntries } from "./host-entries";
import { applyTransforms, buildChainNodes, buildConfiguredProxyNodes, isIPv4, isIPv6, nodeTagsForMatching, parseFeatureTagRules } from "./node-transforms";
import { parseSubscription, toClashProxy, toSurgeLine } from "./parsers";
import { buildClashGroups, buildSurgeGroups, type SurgeGroupOutput } from "./policy-groups";
import { addMissingClashRuleProviderRules, filterClashRules, rewriteUnavailableGroupRuleTargets } from "./rule-targets";
import { fetchCachedSource, sourceUserAgent } from "./source-cache";
import { parseStashScriptLine } from "./stash-scripts";
import { collectSurgeRuleCoverageWarnings } from "./surge-rules";
import { syncPathForToken } from "./target-files";
import type { AppConfig, GenerationResult, HostEntry, HostEntryValue, ProxyNode, Target } from "./types";

(globalThis as typeof globalThis & { Buffer?: typeof Buffer }).Buffer ??= Buffer;

const DEFAULT_SURGE_LOGLEVEL = "notify";
interface FetchedSources {
  nodes: ProxyNode[];
  hostEntries: HostEntry[];
}

interface PreparedOutput {
  nodes: ProxyNode[];
  hostEntries: HostEntry[];
  fetchedSources: number;
  warnings: string[];
}

interface GenerationOptions {
  includeRuleDiagnostics?: boolean;
}

interface SurgeRenderOptions {
  includeProxyServerHostEntries?: boolean;
}

export function inferTarget(request: Request): Target | null {
  const ua = request.headers.get("user-agent")?.toLowerCase() ?? "";
  if (ua.includes("stash")) return "stash";
  if (ua.includes("surge")) return "surge";
  if (ua.includes("clash") || ua.includes("mihomo") || ua.includes("clash.meta")) return "clash";
  return null;
}

export async function generateForRequest(env: Env, request: Request, forcedTarget?: Target): Promise<GenerationResult> {
  const config = await loadConfig(env);
  const target = forcedTarget ?? inferTarget(request);
  if (!target) throw new Error("Unable to infer target from request");
  return generateConfig(env, config, target, request.url);
}

export async function generateConfig(
  env: Env,
  config: AppConfig,
  target: Target,
  requestUrl: string,
  options: GenerationOptions = {}
): Promise<GenerationResult> {
  const prepared = await prepareOutput(env, config, target);
  if (options.includeRuleDiagnostics) {
    if (target === "surge") {
      prepared.warnings.push(...await collectSurgeRuleCoverageWarnings(config));
    } else {
      prepared.warnings.push(...await collectClashRuleCoverageWarnings(config, target));
    }
  }
  const content = target === "surge"
    ? buildSurge(config, prepared.nodes, prepared.hostEntries, requestUrl)
    : target === "stash"
      ? buildStash(config, prepared.nodes, prepared.hostEntries, requestUrl, prepared.warnings)
      : buildClash(config, prepared.nodes, prepared.hostEntries);
  return {
    target,
    content,
    contentType: target === "surge"
      ? "text/plain; charset=utf-8"
      : "text/yaml; charset=utf-8",
    proxyCount: prepared.nodes.length,
    fetchedSources: prepared.fetchedSources,
    warnings: prepared.warnings
  };
}

export async function generateSurgeValidationConfig(env: Env, config: AppConfig, requestUrl: string): Promise<string> {
  const prepared = await prepareOutput(env, config, "surge");
  return buildSurgeInline(config, prepared.nodes, prepared.hostEntries, requestUrl, { includeProxyServerHostEntries: false });
}

async function prepareOutput(env: Env, config: AppConfig, target: Target): Promise<PreparedOutput> {
  const warnings: string[] = [];
  const fetched = await fetchAllSources(env, config, target, warnings);
  const configuredNodes = buildConfiguredProxyNodes(config);
  const supported = await applyTransforms(env, [...fetched.nodes, ...configuredNodes], config, target, warnings);
  const chainNodes = buildChainNodes(supported);
  const nodes = chainNodes.length > 0 ? [...supported, ...chainNodes] : supported;
  return {
    nodes,
    hostEntries: fetched.hostEntries,
    fetchedSources: config.sources.filter((source) => source.enabled && source.url).length,
    warnings
  };
}

async function fetchAllSources(env: Env, config: AppConfig, target: Target, warnings: string[]): Promise<FetchedSources> {
  const enabled = config.sources.filter((source) => source.enabled && source.url);
  const featureTagRules = parseFeatureTagRules(config.settings.featureTagRules);
  const batches = await Promise.all(enabled.map(async (source) => {
    try {
      const content = await fetchCachedSource(env, source, sourceUserAgent(config, source));
      const hostEntries = parseHostEntries(content);
      const nodes = parseSubscription(content, source.id).map((node) => ({
        ...node,
        name: node.name,
        originalName: node.name,
        sourceName: source.name,
        ...nodeTagsForMatching(node.name, node.matchLabels, featureTagRules)
      }));
      return {
        nodes,
        hostEntries
      };
    } catch (error) {
      warnings.push(`${source.name}: ${error instanceof Error ? error.message : String(error)}`);
      return { nodes: [], hostEntries: [] };
    }
  }));
  return {
    nodes: batches.flatMap((batch) => batch.nodes),
    hostEntries: dedupeHostEntries(batches.flatMap((batch) => batch.hostEntries))
  };
}

function buildSurge(config: AppConfig, nodes: ProxyNode[], sourceHostEntries: HostEntry[], requestUrl: string): string {
  return buildSurgeInline(config, nodes, sourceHostEntries, requestUrl);
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
  const managedUrl = buildManagedUrl(config, requestUrl);
  return `#!MANAGED-CONFIG ${managedUrl} interval=${config.surge.managedConfigIntervalSeconds} strict=true\n# Last Updated: ${beijingTimestamp()} (UTC+8)\n${variant}`;
}

interface ClashLikeTunConfig {
  enable: boolean;
  stack: string;
  autoRoute: boolean;
  autoDetectInterface: boolean;
  skipProxy: string[];
}

interface ClashLikeDnsConfig {
  enable: boolean;
  listen: string;
  ipv6: boolean;
  enhancedMode: string;
  fakeIpRange: string;
  defaultNameservers: string[];
  nameservers: string[];
  fallbackNameservers: string[];
  fallbackFilterGeoip: boolean;
  fallbackFilterIpcidr: string[];
  fakeIpFilter: string[];
}

interface ClashLikeBaseConfig {
  port: number;
  socksPort: number;
  mixedPort: number;
  allowLan: boolean;
  mode: string;
  logLevel: string;
  ipv6: boolean;
  unifiedDelay: boolean;
  tcpConcurrent: boolean;
  externalController: string;
  tun: ClashLikeTunConfig;
  dns: ClashLikeDnsConfig;
}

function buildClashLikeBaseData(config: ClashLikeBaseConfig): Record<string, unknown> {
  const data: Record<string, unknown> = {
    port: config.port,
    "socks-port": config.socksPort,
    "mixed-port": config.mixedPort,
    "allow-lan": config.allowLan,
    mode: config.mode,
    "log-level": config.logLevel,
    ipv6: config.ipv6,
    "unified-delay": config.unifiedDelay,
    "tcp-concurrent": config.tcpConcurrent,
    "external-controller": config.externalController
  };
  if (config.tun.enable) {
    data.tun = {
      enable: true,
      stack: config.tun.stack,
      "auto-route": config.tun.autoRoute,
      "auto-detect-interface": config.tun.autoDetectInterface,
      "skip-proxy": config.tun.skipProxy
    };
  }
  if (config.dns.enable) {
    data.dns = buildClashLikeDns(config.dns);
  }
  return data;
}

function buildClashLikeDns(config: ClashLikeDnsConfig): Record<string, unknown> {
  const dns: Record<string, unknown> = {
    enable: true,
    listen: config.listen,
    ipv6: config.ipv6,
    "enhanced-mode": config.enhancedMode
  };
  if (config.enhancedMode === "fake-ip") {
    dns["fake-ip-range"] = config.fakeIpRange;
    dns["fake-ip-filter"] = config.fakeIpFilter;
  }
  Object.assign(dns, {
    "default-nameserver": config.defaultNameservers,
    nameserver: config.nameservers,
    fallback: config.fallbackNameservers,
    "fallback-filter": {
      geoip: config.fallbackFilterGeoip,
      ipcidr: config.fallbackFilterIpcidr
    }
  });
  return dns;
}

function clashBaseConfig(config: AppConfig["clash"]): ClashLikeBaseConfig {
  return {
    port: config.port,
    socksPort: config.socksPort,
    mixedPort: config.mixedPort,
    allowLan: config.allowLan,
    mode: config.mode,
    logLevel: config.logLevel,
    ipv6: config.ipv6,
    unifiedDelay: config.unifiedDelay,
    tcpConcurrent: config.tcpConcurrent,
    externalController: config.externalController,
    tun: config.tun,
    dns: {
      enable: config.dnsEnabled,
      listen: config.dnsListen,
      ipv6: config.dnsIpv6,
      enhancedMode: config.dnsEnhancedMode,
      fakeIpRange: config.dnsFakeIpRange,
      defaultNameservers: config.defaultNameservers,
      nameservers: config.nameservers,
      fallbackNameservers: config.fallbackNameservers,
      fallbackFilterGeoip: config.fallbackFilterGeoip,
      fallbackFilterIpcidr: config.fallbackFilterIpcidr,
      fakeIpFilter: config.fakeIpFilter
    }
  };
}

function stashBaseConfig(config: AppConfig["stash"]): ClashLikeBaseConfig {
  return {
    port: config.port,
    socksPort: config.socksPort,
    mixedPort: config.mixedPort,
    allowLan: config.allowLan,
    mode: config.mode,
    logLevel: config.logLevel,
    ipv6: config.ipv6,
    unifiedDelay: config.unifiedDelay,
    tcpConcurrent: config.tcpConcurrent,
    externalController: config.externalController,
    tun: config.tun,
    dns: {
      enable: config.dns.enable,
      listen: config.dns.listen,
      ipv6: config.dns.ipv6,
      enhancedMode: config.dns.enhancedMode,
      fakeIpRange: config.dns.fakeIpRange,
      defaultNameservers: config.dns.defaultNameservers,
      nameservers: config.dns.nameservers,
      fallbackNameservers: config.dns.fallbackNameservers,
      fallbackFilterGeoip: config.dns.fallbackFilterGeoip,
      fallbackFilterIpcidr: config.dns.fallbackFilterIpcidr,
      fakeIpFilter: config.dns.fakeIpFilter
    }
  };
}

function buildClash(config: AppConfig, nodes: ProxyNode[], sourceHostEntries: HostEntry[]): string {
  const data = buildClashLikeConfigData(config, nodes, {
    baseConfig: clashBaseConfig(config.clash),
    hosts: hostEntriesToClashHosts(sourceHostEntries),
    ruleProvidersYaml: config.clash.ruleProviders,
    rules: config.clash.rules
  });
  return `# Last Updated: ${beijingTimestamp()} (UTC+8)\n${YAML.stringify(data)}`;
}

function buildStash(config: AppConfig, nodes: ProxyNode[], sourceHostEntries: HostEntry[], requestUrl: string, warnings: string[]): string {
  const http = buildStashHttp(config, warnings);
  const data = buildClashLikeConfigData(config, nodes, {
    baseConfig: stashBaseConfig(config.stash),
    hosts: hostEntriesToStashHosts(config.stash.hosts, sourceHostEntries),
    ruleProvidersYaml: config.stash.ruleProviders,
    rules: config.stash.rules,
    extraSections: {
      ...(Object.keys(http.http).length > 0 ? { http: http.http } : {}),
      ...(Object.keys(http.scriptProviders).length > 0 ? { "script-providers": http.scriptProviders } : {})
    }
  });
  return `#SUBSCRIBED ${buildManagedUrl(config, requestUrl)}\n# Last Updated: ${beijingTimestamp()} (UTC+8)\n${YAML.stringify(data)}`;
}

interface ClashLikeConfigDataOptions {
  baseConfig: ClashLikeBaseConfig;
  hosts: Record<string, HostEntryValue>;
  ruleProvidersYaml: string;
  rules: string[];
  extraSections?: Record<string, unknown>;
}

function buildClashLikeConfigData(
  config: AppConfig,
  nodes: ProxyNode[],
  options: ClashLikeConfigDataOptions
): Record<string, unknown> {
  const data = buildClashLikeBaseData(options.baseConfig);
  if (Object.keys(options.hosts).length > 0) data.hosts = options.hosts;
  Object.assign(data, options.extraSections ?? {});
  const ruleProviders = parseClashRuleProvidersYaml(options.ruleProvidersYaml);
  if (Object.keys(ruleProviders).length > 0) {
    data["rule-providers"] = ruleProviders;
  }
  data.proxies = nodes.map(toClashProxy);
  const proxyGroups = buildClashGroups(config, nodes);
  data["proxy-groups"] = proxyGroups;
  data.rules = addMissingClashRuleProviderRules(
    rewriteUnavailableGroupRuleTargets(config, filterClashRules(options.rules), nodes, new Set(proxyGroups.map((group) => String(group.name)))),
    Object.keys(ruleProviders)
  );
  return data;
}

function hostEntriesToClashHosts(entries: HostEntry[]): Record<string, HostEntryValue> {
  const hosts: Record<string, HostEntryValue> = {};
  for (const entry of entries) {
    if (hosts[entry.host] === undefined) {
      hosts[entry.host] = entry.value;
    }
  }
  return hosts;
}

function hostEntriesToStashHosts(configHostLines: string[], sourceHostEntries: HostEntry[]): Record<string, HostEntryValue> {
  const hosts = hostEntriesToClashHosts(sourceHostEntries);
  for (const entry of parseHostEntries(`[Host]\n${configHostLines.join("\n")}`)) {
    hosts[entry.host] = entry.value;
  }
  return hosts;
}

interface StashHttpOutput {
  http: Record<string, unknown>;
  scriptProviders: Record<string, unknown>;
}

function buildStashHttp(config: AppConfig, warnings: string[]): StashHttpOutput {
  const http: Record<string, unknown> = {};
  const scriptProviders: Record<string, unknown> = {};
  if (config.stash.urlRewrite.length > 0) {
    http["url-rewrite"] = config.stash.urlRewrite;
  }
  if (config.stash.mitm.hostname.length > 0) {
    http.mitm = config.stash.mitm.hostname;
  }
  const scriptNames = new Set<string>();
  const scripts = config.stash.scripts.flatMap((line, index) => {
    const parsed = parseStashScriptLine(line, index + 1, warnings);
    if (!parsed) return [];
    if (scriptNames.has(parsed.name)) {
      warnings.push(`Stash script line ${index + 1}: duplicate script name ${parsed.name}`);
      return [];
    }
    scriptNames.add(parsed.name);
    scriptProviders[parsed.name] = {
      url: parsed.url,
      interval: 86400
    };
    return [{
      name: parsed.name,
      type: parsed.type,
      match: parsed.match,
      "require-body": parsed.requireBody,
      "max-size": parsed.maxSize
    }];
  });
  if (scripts.length > 0) {
    http.script = scripts;
  }
  return { http, scriptProviders };
}


function renderHostEntryLine(entry: HostEntry): string {
  return `${entry.host} = ${Array.isArray(entry.value) ? entry.value.join(", ") : entry.value}`;
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

function dedupeHostEntries(entries: HostEntry[]): HostEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.host}\0${JSON.stringify(entry.value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildManagedUrl(config: AppConfig, requestUrl: string): string {
  const request = new URL(requestUrl);
  const base = config.settings.managedBaseUrl || `${request.origin}/sync`;
  const managed = new URL(base, request.origin);
  const token = readTokenFromPath(request.pathname, managed.pathname);
  managed.pathname = `${managed.pathname.replace(/\/+$/, "")}${syncPathForToken(token)}`;
  managed.search = "";
  managed.hash = "";
  return managed.toString();
}

function readTokenFromPath(pathname: string, managedBasePath: string): string {
  const basePath = managedBasePath.replace(/\/+$/, "") || "/";
  const remainder = basePath === "/"
    ? pathname
    : pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : "";
  return remainder.split("/").filter(Boolean)[0] ?? "";
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

function renderSection(name: string, lines: string[]): string {
  return [`[${name}]`, ...lines].join("\n");
}

function beijingTimestamp(): string {
  return new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai", hour12: false });
}
