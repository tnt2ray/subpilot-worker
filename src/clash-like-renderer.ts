import YAML from "yaml";
import { parseClashRuleProvidersYaml } from "./clash-rule-providers";
import { parseHostEntries } from "./host-entries";
import { managedSubscriptionUrlForRequest } from "./managed-url";
import { beijingTimestamp } from "./output-render";
import { toClashProxy } from "./parsers";
import { buildClashGroups } from "./policy-groups";
import { addMissingClashRuleProviderRules, filterClashRules, rewriteUnavailableGroupRuleTargets } from "./rule-targets";
import { parseStashScriptLine } from "./stash-scripts";
import type { AppConfig, HostEntry, HostEntryValue, ProxyNode } from "./types";

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

interface ClashLikeConfigDataOptions {
  baseConfig: ClashLikeBaseConfig;
  hosts: Record<string, HostEntryValue>;
  ruleProvidersYaml: string;
  rules: string[];
  extraSections?: Record<string, unknown>;
}

interface StashHttpOutput {
  http: Record<string, unknown>;
  scriptProviders: Record<string, unknown>;
}

export function buildClash(config: AppConfig, nodes: ProxyNode[], sourceHostEntries: HostEntry[]): string {
  const data = buildClashLikeConfigData(config, nodes, {
    baseConfig: clashBaseConfig(config.clash),
    hosts: hostEntriesToClashHosts(sourceHostEntries),
    ruleProvidersYaml: config.clash.ruleProviders,
    rules: config.clash.rules
  });
  return `# Last Updated: ${beijingTimestamp()} (UTC+8)\n${YAML.stringify(data)}`;
}

export function buildStash(config: AppConfig, nodes: ProxyNode[], sourceHostEntries: HostEntry[], requestUrl: string, warnings: string[]): string {
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
  return `#SUBSCRIBED ${managedSubscriptionUrlForRequest(config, requestUrl)}\n# Last Updated: ${beijingTimestamp()} (UTC+8)\n${YAML.stringify(data)}`;
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
