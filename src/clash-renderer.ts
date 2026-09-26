import YAML from "yaml";
import { parseClashRuleProvidersYaml } from "./clash-rule-providers";
import { beijingTimestamp } from "./output-render";
import { toClashProxy } from "./parsers";
import { buildClashGroups } from "./policy-groups";
import type { CompiledRuleSetReferencePlan } from "./rule-set-compiler";
import type { RenderConfig, HostEntry, HostEntryValue, ProxyNode } from "./types";

export function buildClash(
  config: RenderConfig,
  nodes: ProxyNode[],
  sourceHostEntries: HostEntry[],
  ruleSetPlan?: CompiledRuleSetReferencePlan
): string {
  const data = buildClashBaseData(config.clash);
  const hosts: Record<string, HostEntryValue> = {};
  for (const entry of sourceHostEntries) {
    if (hosts[entry.host] === undefined) hosts[entry.host] = entry.value;
  }
  if (Object.keys(hosts).length > 0) data.hosts = hosts;
  const compiledPlan = config.ruleSets.mode === "compiled" ? ruleSetPlan : undefined;
  const ruleProviders = compiledPlan?.clashRuleProviders ?? parseClashRuleProvidersYaml(config.clash.ruleProviders);
  if (Object.keys(ruleProviders).length > 0) {
    data["rule-providers"] = Object.fromEntries(Object.entries(ruleProviders).map(([name, provider]) => [
      name,
      provider.type === "http" ? { ...provider, proxy: provider.proxy || "Proxy" } : provider
    ]));
  }
  if (Object.keys(compiledPlan?.clashDnsPolicy ?? {}).length > 0) {
    if (!data.dns) throw new Error("规则集指定 DNS 需要启用 Clash DNS。");
    (data.dns as Record<string, unknown>)["nameserver-policy"] = compiledPlan!.clashDnsPolicy;
  }
  data.proxies = nodes.map(toClashProxy);
  data["proxy-groups"] = buildClashGroups(config, nodes);
  data.rules = compiledPlan?.clashRules ?? config.clash.rules;
  return `# Last Updated: ${beijingTimestamp()} (UTC+8)\n${new YAML.Document(data)}`;
}

function buildClashBaseData(config: RenderConfig["clash"]): Record<string, unknown> {
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
  if (config.dnsEnabled) data.dns = buildClashDns(config);
  return data;
}

function buildClashDns(config: RenderConfig["clash"]): Record<string, unknown> {
  const dns: Record<string, unknown> = {
    enable: true,
    listen: config.dnsListen,
    ipv6: config.dnsIpv6,
    "enhanced-mode": config.dnsEnhancedMode,
    "listen-routing-mark": config.dnsListenRoutingMark,
    "fallback-lazy-query": config.dnsFallbackLazyQuery
  };
  if (config.dnsEnhancedMode === "fake-ip") {
    dns["fake-ip-range"] = config.dnsFakeIpRange;
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
