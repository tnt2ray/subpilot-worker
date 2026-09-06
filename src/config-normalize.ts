import { DEFAULT_CONFIG } from "./default-config";
import { splitGroupSpec } from "./policy-group-spec";
import {
  RULE_SET_SOURCE_FORMATS,
  type RuleSetConfig,
  type RuleSetDirectRule,
  type RuleSetOutput,
  type RuleSetSource,
  type RuleSetSourceFormat
} from "./rule-set-types";
import { inferUrlRewriteMitmHostnames } from "./surge-url-rewrite";
import { ruleSetPathName } from "./managed-url";
import { CHAIN_EXIT_PROTOCOLS, type RenderConfig, type ChainExitProtocol, type NotificationChannel, type SourceConfig, type StaticProxyNodeConfig, type SurgeIpv6VifMode, type Target } from "./types";
import { normalizeDisplayTimeZone } from "./util";

const SURGE_IPV6_VIF_MODES = ["off", "auto", "always"] as const satisfies readonly SurgeIpv6VifMode[];
type ClashLikeBaseConfig = Pick<
  RenderConfig["clash"],
  "port" | "socksPort" | "mixedPort" | "allowLan" | "mode" | "logLevel" | "ipv6" | "unifiedDelay" | "tcpConcurrent" | "externalController"
>;
type ClashLikeTunConfig = RenderConfig["clash"]["tun"];
type ClashLikeDnsConfig = RenderConfig["stash"]["dns"];
type LoosePartial<T> = { [Key in keyof T]?: T[Key] | undefined };

function notificationChannelFromTelegramToken(token: string): NotificationChannel {
  return token.trim() ? "telegram" : "off";
}

export function normalizeTarget(value: string | null | undefined): Target | null {
  const lowered = String(value ?? "").toLowerCase();
  if (lowered === "mihomo") return "clash";
  if (lowered === "surge" || lowered === "clash" || lowered === "sing-box") return lowered;
  return null;
}

export function normalizeConfig(input: RenderConfig): RenderConfig {
  const chain = normalizeChain(input.chain);
  const groups = normalizeGroups(typeof input.groups === "object" && input.groups ? input.groups : DEFAULT_CONFIG.groups);
  const notificationTelegramBotToken = stringValue(input.settings?.notificationTelegramBotToken, "");
  return {
    version: 1,
    ...(input.document ? { document: input.document } : {}),
    ...(input.renderTarget ? { renderTarget: input.renderTarget } : {}),
    ...(input.migrationRequired ? { migrationRequired: true } : {}),
    ...(input.groupTargets ? { groupTargets: input.groupTargets } : {}),
    settings: {
      managedBaseUrl: stringValue(input.settings?.managedBaseUrl, DEFAULT_CONFIG.settings.managedBaseUrl),
      userAgentSurge: input.settings?.userAgentSurge || DEFAULT_CONFIG.settings.userAgentSurge,
      userAgentClash: input.settings?.userAgentClash || DEFAULT_CONFIG.settings.userAgentClash,
      userAgentStash: input.settings?.userAgentStash || DEFAULT_CONFIG.settings.userAgentStash,
      userAgentShadowrocket: input.settings?.userAgentShadowrocket || DEFAULT_CONFIG.settings.userAgentShadowrocket,
      excludeKeywords: stringArray(input.settings?.excludeKeywords, []),
      geoipRenameEnabled: input.settings?.geoipRenameEnabled !== false,
      featureTagRules: stringArray(input.settings?.featureTagRules, DEFAULT_CONFIG.settings.featureTagRules),
      updateCheckEnabled: input.settings?.updateCheckEnabled === true,
      displayTimeZone: normalizeDisplayTimeZone(input.settings?.displayTimeZone),
      notificationChannel: notificationChannelFromTelegramToken(notificationTelegramBotToken),
      notificationTelegramChatId: notificationTelegramBotToken ? stringValue(input.settings?.notificationTelegramChatId, "") : "",
      notificationTelegramBotToken,
      notificationTelegramWebhookSecret: notificationTelegramBotToken ? stringValue(input.settings?.notificationTelegramWebhookSecret, "") : ""
    },
    groups,
    disabledGroups: normalizeDisabledGroups(input.disabledGroups, groups),
    sources: Array.isArray(input.sources) ? input.sources.map(normalizeSource) : [],
    proxyNodes: Array.isArray(input.proxyNodes) ? normalizeProxyNodes(input.proxyNodes) : DEFAULT_CONFIG.proxyNodes,
    chain,
    ruleSets: normalizeRuleSets(input.ruleSets),
    surge: normalizeSurge(input.surge),
    clash: normalizeClash(input.clash),
    stash: normalizeStash(input.stash),
    updatedAt: input.updatedAt
  };
}

function normalizeGroups(input: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).map(([name, spec]) => {
    const [rawType = "select", ...items] = splitGroupSpec(String(spec));
    const type = rawType.trim().toLowerCase() || "select";
    // Preserve explicit references, including unresolved ones, for target diagnostics.
    return [name, [type, ...items.filter((item) => item)].join(", ")];
  }));
}

function normalizeDisabledGroups(input: unknown, groups: Record<string, string>): string[] {
  if (!Array.isArray(input)) return DEFAULT_CONFIG.disabledGroups;
  const knownGroups = new Set(Object.keys(groups));
  const output: string[] = [];
  for (const item of input) {
    const name = typeof item === "string" ? item.trim() : "";
    if (!name || name === "Proxy" || !knownGroups.has(name) || output.includes(name)) continue;
    output.push(name);
  }
  return output;
}

export function inferManagedBaseUrl(requestUrl: string): string {
  return `${new URL(requestUrl).origin}/sync`;
}

export function withInferredManagedBaseUrl(config: RenderConfig, requestUrl: string): RenderConfig {
  const managedBaseUrl = config.settings.managedBaseUrl.trim();
  if (managedBaseUrl) {
    return {
      ...config,
      settings: {
        ...config.settings,
        managedBaseUrl
      }
    };
  }

  return {
    ...config,
    settings: {
      ...config.settings,
      managedBaseUrl: inferManagedBaseUrl(requestUrl)
    }
  };
}

export function normalizeSource(source: SourceConfig): SourceConfig {
  return {
    id: source.id || crypto.randomUUID(),
    name: source.name || "source",
    url: source.url || "",
    urlEncrypted: source.urlEncrypted,
    fetchUserAgent: normalizeSourceFetchUserAgent(source.fetchUserAgent),
    enabled: source.enabled !== false
  };
}

function normalizeSourceFetchUserAgent(value: unknown): SourceConfig["fetchUserAgent"] {
  return typeof value === "string" && value.trim() ? value.trim() : "surge";
}

export function normalizeRuleSets(input: Partial<RuleSetConfig> | undefined): RuleSetConfig {
  const ruleSets = input ?? {};
  const mode = ruleSets.mode === "compiled" ? "compiled" : "manual";
  const directRules = Array.isArray(ruleSets.directRules) ? normalizeRuleSetDirectRules(ruleSets.directRules) : [];
  return {
    mode,
    aggregateByPolicy: ruleSets.aggregateByPolicy === true,
    sources: Array.isArray(ruleSets.sources) ? normalizeRuleSetSources(ruleSets.sources) : [],
    outputs: Array.isArray(ruleSets.outputs) ? normalizeRuleSetOutputs(ruleSets.outputs) : [],
    directRules: directRules.sort(compareByOrder)
  };
}

function normalizeRuleSetSources(sources: RuleSetSource[]): RuleSetSource[] {
  return sources.map(normalizeRuleSetSource).sort(compareByOrder);
}

function normalizeRuleSetSource(source: RuleSetSource, index: number): RuleSetSource {
  return {
    id: normalizeStableId(source.id, `rule-set-source-${index + 1}`),
    name: stringValue(source.name, `规则来源 ${index + 1}`),
    url: typeof source.url === "string" ? source.url.trim() : "",
    enabled: source.enabled !== false,
    format: normalizeRuleSetSourceFormat(source.format),
    order: finiteOrder(source.order, index)
  };
}

function normalizeRuleSetOutputs(outputs: RuleSetOutput[]): RuleSetOutput[] {
  return outputs.map(normalizeRuleSetOutput).sort(compareByOrder);
}

function normalizeRuleSetOutput(output: RuleSetOutput, index: number): RuleSetOutput {
  const updatedAt = typeof output.updatedAt === "string" && !Number.isNaN(new Date(output.updatedAt).getTime())
    ? output.updatedAt
    : undefined;
  return {
    name: ruleSetPathName(output.name) || `规则集 ${index + 1}`,
    enabled: output.enabled !== false,
    policy: stringValue(output.policy, ""),
    sourceIds: uniqueStringArray(output.sourceIds, []),
    inlineRules: stringArray(output.inlineRules, []),
    order: finiteOrder(output.order, index),
    surgeOptions: uniqueStringArray(output.surgeOptions, []),
    ...(updatedAt ? { updatedAt } : {})
  };
}

function normalizeRuleSetDirectRules(rules: RuleSetDirectRule[]): RuleSetDirectRule[] {
  return rules.map(normalizeRuleSetDirectRule).sort(compareByOrder);
}

function normalizeRuleSetDirectRule(rule: RuleSetDirectRule, index: number): RuleSetDirectRule {
  return {
    id: normalizeStableId(rule.id, `rule-set-direct-rule-${index + 1}`),
    name: stringValue(rule.name, `主配置规则 ${index + 1}`),
    enabled: rule.enabled !== false,
    rule: typeof rule.rule === "string" ? rule.rule.trim() : "",
    policy: stringValue(rule.policy, ""),
    order: finiteOrder(rule.order, index)
  };
}

function normalizeRuleSetSourceFormat(value: unknown): RuleSetSourceFormat {
  return typeof value === "string" && RULE_SET_SOURCE_FORMATS.includes(value as RuleSetSourceFormat)
    ? value as RuleSetSourceFormat
    : "auto";
}

function normalizeStableId(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

function uniqueStringArray(value: unknown, fallback: string[]): string[] {
  return [...new Set(stringArray(value, fallback))];
}

function finiteOrder(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function compareByOrder<T extends { order: number }>(left: T, right: T): number {
  return left.order - right.order;
}

function normalizeProxyNodes(nodes: StaticProxyNodeConfig[]): StaticProxyNodeConfig[] {
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  return nodes.flatMap((node, index) => {
    const normalized = normalizeProxyNode(node, index, seenNames);
    if (!normalized || seenIds.has(normalized.id)) return [];
    seenIds.add(normalized.id);
    return [normalized];
  });
}

function normalizeProxyNode(value: unknown, index: number, seenNames: Set<string>): StaticProxyNodeConfig | null {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const config = normalizeProxyNodeConfig(record, index, seenNames);
  if (!config) return null;
  const id = normalizeProxyNodeId(record.id, index);
  const chainExit = record.chainExit === true;
  return {
    id,
    config,
    chainFilter: filterArray(record.chainFilter, []),
    enabled: record.enabled !== false,
    chainExit,
    includeInGroups: chainExit ? record.includeInGroups === true : record.includeInGroups !== false
  };
}

function normalizeProxyNodeConfig(record: Record<string, unknown>, index: number, seenNames: Set<string>): string {
  const config = typeof record.config === "string" ? record.config.trim() : "";
  if (config) return config;
  const protocol = chainExitProtocol(record.protocol, "socks5");
  const outputProtocol = protocol === "tuic" ? "tuic-v5" : protocol;
  const rawName = typeof record.name === "string" ? record.name.trim() : "";
  const name = uniqueProxyNodeName(rawName || `Proxy Node ${index + 1}`, seenNames);
  const legacy = legacyProxyNodeParams({ ...record, protocol: outputProtocol });
  return legacy ? `${name} = ${outputProtocol}, ${legacy}` : "";
}

function legacyProxyNodeParams(record: Record<string, unknown>): string {
  const server = typeof record.server === "string" ? record.server.trim() : "";
  const port = clampNumber(record.port, 1, 65535, 0);
  if (!server || !port) return "";
  const protocol = chainExitProtocol(record.protocol, "socks5");
  const username = typeof record.username === "string" ? record.username.trim() : "";
  const password = typeof record.password === "string" ? record.password.trim() : "";
  const parts = [server, String(port)];
  if (protocol === "ss") {
    if (username) parts.push(`encrypt-method=${username}`);
    if (password) parts.push(`password=${password}`);
  } else if (protocol === "snell") {
    if (password) parts.push(`psk=${password}`);
    parts.push("version=4");
  } else if (protocol === "tuic-v5") {
    if (username) parts.push(`uuid=${username}`);
    if (password) parts.push(`password=${password}`);
  } else if (protocol === "tuic") {
    if (password) parts.push(`token=${password}`);
  } else if (["trojan", "hysteria2", "anytls"].includes(protocol)) {
    if (password) parts.push(`password=${password}`);
  } else {
    if (username) parts.push(`username=${username}`);
    if (password) parts.push(`password=${password}`);
  }
  return parts.join(", ");
}

function normalizeProxyNodeId(value: unknown, index: number): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || `proxy-node-${index + 1}`;
}

function uniqueProxyNodeName(name: string, seenNames: Set<string>): string {
  let candidate = name;
  let suffix = 2;
  while (seenNames.has(candidate)) {
    candidate = `${name} ${suffix}`;
    suffix += 1;
  }
  seenNames.add(candidate);
  return candidate;
}

export function normalizeSurge(input: Partial<RenderConfig["surge"]> | undefined): RenderConfig["surge"] {
  const surge = input ?? {};
  const urlRewrite = stringArray(surge.urlRewrite, DEFAULT_CONFIG.surge.urlRewrite);
  const mitm = normalizeSurgeMitm(surge.mitm);
  const inferredMitmHosts = inferUrlRewriteMitmHostnames(urlRewrite);
  const encryptedDnsServer = stringArray(surge.encryptedDnsServer, DEFAULT_CONFIG.surge.encryptedDnsServer);
  return {
    skipProxy: stringArray(surge.skipProxy, DEFAULT_CONFIG.surge.skipProxy),
    dnsServer: stringArray(surge.dnsServer, DEFAULT_CONFIG.surge.dnsServer),
    alwaysRealIp: stringArray(surge.alwaysRealIp, DEFAULT_CONFIG.surge.alwaysRealIp),
    managedConfigIntervalSeconds: clampNumber(surge.managedConfigIntervalSeconds, 300, 604800, DEFAULT_CONFIG.surge.managedConfigIntervalSeconds),
    internetTestUrl: stringValue(surge.internetTestUrl, DEFAULT_CONFIG.surge.internetTestUrl),
    proxyTestUrl: stringValue(surge.proxyTestUrl, DEFAULT_CONFIG.surge.proxyTestUrl),
    showErrorPageForReject: surge.showErrorPageForReject !== false,
    ipv6: surge.ipv6 !== false,
    ipv6Vif: surgeIpv6VifMode(surge.ipv6Vif, DEFAULT_CONFIG.surge.ipv6Vif),
    allowWifiAccess: surge.allowWifiAccess === true,
    tunExcludedRoutes: stringArray(surge.tunExcludedRoutes, DEFAULT_CONFIG.surge.tunExcludedRoutes),
    encryptedDnsServer,
    wifiAssist: surge.wifiAssist === true,
    excludeSimpleHostnames: surge.excludeSimpleHostnames !== false,
    encryptedDnsFollowOutboundMode: surge.encryptedDnsFollowOutboundMode !== false,
    tailscaleNodes: normalizeSurgeTailscaleNodes(surge.tailscaleNodes),
    hosts: stringArray(surge.hosts, DEFAULT_CONFIG.surge.hosts),
    urlRewrite,
    mapLocal: stringArray(surge.mapLocal, DEFAULT_CONFIG.surge.mapLocal),
    scripts: stringArray(surge.scripts, DEFAULT_CONFIG.surge.scripts),
    mitm: {
      ...mitm,
      hostname: [...new Set([...mitm.hostname, ...inferredMitmHosts])]
    },
    rules: stringArray(surge.rules, DEFAULT_CONFIG.surge.rules)
  };
}

function normalizeSurgeTailscaleNodes(value: unknown): RenderConfig["surge"]["tailscaleNodes"] {
  if (!Array.isArray(value)) return DEFAULT_CONFIG.surge.tailscaleNodes;
  const seenNames = new Set<string>();
  const seenSections = new Set<string>();
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const name = stringValue(record.name, `Tailscale ${index + 1}`);
    const sectionName = stringValue(record.sectionName, `tailscale-${index + 1}`);
    if (
      !name || !sectionName
      || /[=,\r\n[\]]/.test(name)
      || /[\s=,\r\n[\]]/.test(sectionName)
      || seenNames.has(name)
      || seenSections.has(sectionName)
    ) return [];
    seenNames.add(name);
    seenSections.add(sectionName);
    return [{
      name,
      sectionName,
      authKey: surgeTailscaleValue(record.authKey),
      controlUrl: surgeTailscaleValue(record.controlUrl),
      hostname: surgeTailscaleValue(record.hostname),
      derpOnly: record.derpOnly === true,
      exitNode: surgeTailscaleValue(record.exitNode) || "none",
      idleKeepalive: clampNumber(record.idleKeepalive, -1, 86400, 600),
      preferIpv6: record.preferIpv6 === true,
      dnsServer: stringArray(record.dnsServer, []).filter((item) => !/[\r\n]/.test(item)),
      mtu: clampNumber(record.mtu, 576, 1420, 1280),
      underlyingProxy: normalizeSurgeTailscaleUnderlyingProxy(record.underlyingProxy),
      testUrl: surgeTailscalePolicyValue(record.testUrl),
      testTimeout: clampNumber(record.testTimeout, 1, 60, 5),
      enabled: record.enabled !== false
    }];
  });
}

function surgeTailscaleValue(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /[\r\n]/.test(normalized) ? "" : normalized;
}

function surgeTailscalePolicyValue(value: unknown): string {
  const normalized = surgeTailscaleValue(value);
  return normalized.includes(",") ? "" : normalized;
}

function normalizeSurgeTailscaleUnderlyingProxy(value: unknown): string {
  const normalized = surgeTailscalePolicyValue(value);
  return normalized.toUpperCase() === "DIRECT" ? "" : normalized;
}

function normalizeSurgeMitm(input: Partial<RenderConfig["surge"]["mitm"]> | undefined): RenderConfig["surge"]["mitm"] {
  const mitm = input ?? {};
  return {
    skipServerCertVerify: mitm.skipServerCertVerify !== false,
    h2: mitm.h2 !== false,
    hostname: stringArray(mitm.hostname, DEFAULT_CONFIG.surge.mitm.hostname),
    caPassphrase: typeof mitm.caPassphrase === "string" ? mitm.caPassphrase.trim() : DEFAULT_CONFIG.surge.mitm.caPassphrase,
    caP12: typeof mitm.caP12 === "string" ? mitm.caP12.trim() : DEFAULT_CONFIG.surge.mitm.caP12
  };
}

export function normalizeClash(input: Partial<RenderConfig["clash"]> | undefined): RenderConfig["clash"] {
  const clash = input ?? {};
  const base = normalizeClashLikeBase(clash, DEFAULT_CONFIG.clash);
  const dns = normalizeClashLikeDns({
    enable: clash.dnsEnabled,
    listen: clash.dnsListen,
    ipv6: clash.dnsIpv6,
    enhancedMode: clash.dnsEnhancedMode,
    fakeIpRange: clash.dnsFakeIpRange,
    defaultNameservers: clash.defaultNameservers,
    nameservers: clash.nameservers,
    fallbackNameservers: clash.fallbackNameservers,
    fallbackFilterGeoip: clash.fallbackFilterGeoip,
    fallbackFilterIpcidr: clash.fallbackFilterIpcidr,
    fakeIpFilter: clash.fakeIpFilter
  }, {
    enable: DEFAULT_CONFIG.clash.dnsEnabled,
    listen: DEFAULT_CONFIG.clash.dnsListen,
    ipv6: DEFAULT_CONFIG.clash.dnsIpv6,
    enhancedMode: DEFAULT_CONFIG.clash.dnsEnhancedMode,
    fakeIpRange: DEFAULT_CONFIG.clash.dnsFakeIpRange,
    defaultNameservers: DEFAULT_CONFIG.clash.defaultNameservers,
    nameservers: DEFAULT_CONFIG.clash.nameservers,
    fallbackNameservers: DEFAULT_CONFIG.clash.fallbackNameservers,
    fallbackFilterGeoip: DEFAULT_CONFIG.clash.fallbackFilterGeoip,
    fallbackFilterIpcidr: DEFAULT_CONFIG.clash.fallbackFilterIpcidr,
    fakeIpFilter: DEFAULT_CONFIG.clash.fakeIpFilter
  });
  return {
    ...base,
    tun: normalizeClashLikeTun(clash.tun, DEFAULT_CONFIG.clash.tun),
    dnsEnabled: dns.enable,
    dnsListen: dns.listen,
    dnsIpv6: dns.ipv6,
    dnsEnhancedMode: dns.enhancedMode,
    dnsFakeIpRange: dns.fakeIpRange,
    defaultNameservers: dns.defaultNameservers,
    nameservers: dns.nameservers,
    fallbackNameservers: dns.fallbackNameservers,
    fallbackFilterGeoip: dns.fallbackFilterGeoip,
    fallbackFilterIpcidr: dns.fallbackFilterIpcidr,
    fakeIpFilter: dns.fakeIpFilter,
    ruleProviders: normalizeRuleProviders(clash.ruleProviders, DEFAULT_CONFIG.clash.ruleProviders),
    rules: stringArray(clash.rules, DEFAULT_CONFIG.clash.rules)
  };
}

export function normalizeStash(input: Partial<RenderConfig["stash"]> | undefined): RenderConfig["stash"] {
  const stash = input ?? {};
  return {
    ...normalizeClashLikeBase(stash, DEFAULT_CONFIG.stash),
    tun: normalizeClashLikeTun(stash.tun, DEFAULT_CONFIG.stash.tun),
    dns: normalizeStashDns(stash.dns),
    ruleProviders: normalizeRuleProviders(stash.ruleProviders, DEFAULT_CONFIG.stash.ruleProviders),
    rules: stringArray(stash.rules, DEFAULT_CONFIG.stash.rules),
    hosts: stringArray(stash.hosts, DEFAULT_CONFIG.stash.hosts),
    urlRewrite: stringArray(stash.urlRewrite, DEFAULT_CONFIG.stash.urlRewrite),
    scripts: stringArray(stash.scripts, DEFAULT_CONFIG.stash.scripts),
    mitm: normalizeStashMitm(stash.mitm)
  };
}

function normalizeStashDns(input: Partial<RenderConfig["stash"]["dns"]> | undefined): RenderConfig["stash"]["dns"] {
  return normalizeClashLikeDns(input ?? {}, DEFAULT_CONFIG.stash.dns);
}

function normalizeClashLikeBase(input: LoosePartial<ClashLikeBaseConfig>, defaults: ClashLikeBaseConfig): ClashLikeBaseConfig {
  return {
    port: clampNumber(input.port, 1, 65535, defaults.port),
    socksPort: clampNumber(input.socksPort, 1, 65535, defaults.socksPort),
    mixedPort: clampNumber(input.mixedPort, 1, 65535, defaults.mixedPort),
    allowLan: input.allowLan === true,
    mode: stringValue(input.mode, defaults.mode),
    logLevel: stringValue(input.logLevel, defaults.logLevel),
    ipv6: input.ipv6 !== false,
    unifiedDelay: input.unifiedDelay !== false,
    tcpConcurrent: input.tcpConcurrent !== false,
    externalController: stringValue(input.externalController, defaults.externalController)
  };
}

function normalizeClashLikeTun(input: LoosePartial<ClashLikeTunConfig> | undefined, defaults: ClashLikeTunConfig): ClashLikeTunConfig {
  const tun = input ?? {};
  return {
    enable: tun.enable !== false,
    stack: stringValue(tun.stack, defaults.stack),
    autoRoute: tun.autoRoute !== false,
    autoDetectInterface: tun.autoDetectInterface !== false,
    skipProxy: stringArray(tun.skipProxy, defaults.skipProxy)
  };
}

function normalizeClashLikeDns(input: LoosePartial<ClashLikeDnsConfig>, defaults: ClashLikeDnsConfig): ClashLikeDnsConfig {
  const dns = input ?? {};
  return {
    enable: dns.enable !== false,
    listen: stringValue(dns.listen, defaults.listen),
    ipv6: dns.ipv6 !== false,
    enhancedMode: normalizeDnsEnhancedMode(dns.enhancedMode, defaults.enhancedMode),
    fakeIpRange: stringValue(dns.fakeIpRange, defaults.fakeIpRange),
    defaultNameservers: stringArray(dns.defaultNameservers, defaults.defaultNameservers),
    nameservers: stringArray(dns.nameservers, defaults.nameservers),
    fallbackNameservers: stringArray(dns.fallbackNameservers, defaults.fallbackNameservers),
    fallbackFilterGeoip: dns.fallbackFilterGeoip !== false,
    fallbackFilterIpcidr: stringArray(dns.fallbackFilterIpcidr, defaults.fallbackFilterIpcidr),
    fakeIpFilter: stringArray(dns.fakeIpFilter, defaults.fakeIpFilter)
  };
}

function normalizeDnsEnhancedMode(value: unknown, fallback: string): string {
  return value === "fake-ip" || value === "redir-host" ? value : fallback;
}

function normalizeRuleProviders(input: unknown, fallback: string): string {
  if (input === undefined || input === null) return fallback;
  return typeof input === "string" ? input.trimEnd() : fallback;
}

function normalizeStashMitm(input: Partial<RenderConfig["stash"]["mitm"]> | undefined): RenderConfig["stash"]["mitm"] {
  const mitm = input ?? {};
  return {
    hostname: stringArray(mitm.hostname, DEFAULT_CONFIG.stash.mitm.hostname)
  };
}

export function normalizeChain(_input: { filter?: unknown } | undefined): RenderConfig["chain"] {
  return {
    filter: []
  };
}

function chainExitProtocol(value: unknown, fallback: ChainExitProtocol): ChainExitProtocol {
  return typeof value === "string" && CHAIN_EXIT_PROTOCOLS.includes(value as ChainExitProtocol)
    ? value as ChainExitProtocol
    : fallback;
}

function surgeIpv6VifMode(value: unknown, fallback: SurgeIpv6VifMode): SurgeIpv6VifMode {
  return typeof value === "string" && SURGE_IPV6_VIF_MODES.includes(value as SurgeIpv6VifMode)
    ? value as SurgeIpv6VifMode
    : fallback;
}

function filterArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return [...new Set(value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean))];
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}
