import YAML from "yaml";
import { Buffer } from "node:buffer";
import { parseClashRuleProvidersYaml } from "./clash-rule-providers";
import { loadConfig } from "./config-store";
import { lookupIpRegion, type RegionInfo } from "./geoip";
import { parseHostEntries, parseSubscription, toClashProxy, toSurgeLine } from "./parsers";
import { fetchCachedSource, sourceUserAgent } from "./source-cache";
import { syncPathForToken } from "./target-files";
import { CHAIN_EXIT_PROXY_NAME, type AppConfig, type ChainExitProtocol, type GenerationResult, type HostEntry, type HostEntryValue, type ProxyNode, type Target } from "./types";

(globalThis as typeof globalThis & { Buffer?: typeof Buffer }).Buffer ??= Buffer;

const SURGE_PROTOCOLS = new Set(["http", "https", "socks5", "socks5-tls", "ss", "snell", "trojan", "vmess", "hysteria2", "hy2", "tuic", "anytls", "trust-tunnel", "ssh"]);
const CLASH_PROTOCOLS = new Set([...SURGE_PROTOCOLS, "vless"]);
const DEFAULT_SURGE_LOGLEVEL = "notify";
const UNKNOWN_REGION_NAME = "ZZ";
const CITY_COUNTRY_ALIASES = new Map<string, string>([
  ["amsterdam", "NL"],
  ["ashburn", "US"],
  ["bangkok", "TH"],
  ["beijing", "CN"],
  ["chicago", "US"],
  ["dallas", "US"],
  ["frankfurt", "DE"],
  ["guangzhou", "CN"],
  ["hong-kong", "HK"],
  ["jakarta", "ID"],
  ["kuala-lumpur", "MY"],
  ["london", "GB"],
  ["los-angeles", "US"],
  ["madrid", "ES"],
  ["manila", "PH"],
  ["melbourne", "AU"],
  ["miami", "US"],
  ["new-york", "US"],
  ["osaka", "JP"],
  ["paris", "FR"],
  ["sao-paulo", "BR"],
  ["seattle", "US"],
  ["seoul", "KR"],
  ["shanghai", "CN"],
  ["shenzhen", "CN"],
  ["singapore", "SG"],
  ["sydney", "AU"],
  ["taipei", "TW"],
  ["tokyo", "JP"],
  ["toronto", "CA"],
  ["vancouver", "CA"],
  ["washington", "US"],
  ["hongkong", "HK"],
  ["losangeles", "US"],
  ["newyork", "US"],
  ["saopaulo", "BR"],
  ["kualalumpur", "MY"],
  ["东京", "JP"],
  ["東京", "JP"],
  ["大阪", "JP"],
  ["首尔", "KR"],
  ["首爾", "KR"],
  ["서울", "KR"],
  ["香港", "HK"],
  ["新加坡", "SG"],
  ["台北", "TW"],
  ["臺北", "TW"],
  ["洛杉矶", "US"],
  ["洛杉磯", "US"]
]);
const COUNTRY_CODES = new Set([
  ...CITY_COUNTRY_ALIASES.values(),
  "AE",
  "CN",
  "GB",
  "HK",
  "JP",
  "KR",
  "SG",
  "TW",
  "US"
]);
const COUNTRY_CODE_ALIASES = new Map<string, string>(
  [...COUNTRY_CODES].map((code): [string, string] => [code.toLowerCase(), code])
);
const COUNTRY_NAME_ALIASES = new Map<string, string>([
  ["jpn", "JP"],
  ["japan", "JP"],
  ["日本", "JP"],
  ["kor", "KR"],
  ["korea", "KR"],
  ["south-korea", "KR"],
  ["韩国", "KR"],
  ["韓國", "KR"],
  ["南韩", "KR"],
  ["南韓", "KR"],
  ["taiwan", "TW"],
  ["台湾", "TW"],
  ["台灣", "TW"],
  ["hong-kong", "HK"],
  ["hongkong", "HK"],
  ["香港", "HK"],
  ["singapore", "SG"],
  ["新加坡", "SG"],
  ["usa", "US"],
  ["america", "US"],
  ["united-states", "US"],
  ["美国", "US"],
  ["美國", "US"],
  ["uk", "GB"],
  ["united-kingdom", "GB"],
  ["england", "GB"],
  ["英国", "GB"],
  ["英國", "GB"],
  ["china", "CN"],
  ["中国", "CN"],
  ["中國", "CN"],
  ["canada", "CA"],
  ["加拿大", "CA"],
  ["australia", "AU"],
  ["澳大利亚", "AU"],
  ["澳洲", "AU"],
  ["germany", "DE"],
  ["德国", "DE"],
  ["德國", "DE"],
  ["france", "FR"],
  ["法国", "FR"],
  ["法國", "FR"],
  ["netherlands", "NL"],
  ["holland", "NL"],
  ["荷兰", "NL"],
  ["荷蘭", "NL"],
  ["thailand", "TH"],
  ["泰国", "TH"],
  ["泰國", "TH"],
  ["indonesia", "ID"],
  ["印尼", "ID"],
  ["malaysia", "MY"],
  ["马来西亚", "MY"],
  ["馬來西亞", "MY"],
  ["philippines", "PH"],
  ["菲律宾", "PH"],
  ["菲律賓", "PH"],
  ["brazil", "BR"],
  ["巴西", "BR"],
  ["spain", "ES"],
  ["西班牙", "ES"]
]);
interface FetchedSources {
  nodes: ProxyNode[];
  hostEntries: HostEntry[];
}

interface SurgeGroupOutput {
  name: string;
  line: string;
}

interface PreparedOutput {
  nodes: ProxyNode[];
  hostEntries: HostEntry[];
  fetchedSources: number;
  warnings: string[];
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

export async function generateConfig(env: Env, config: AppConfig, target: Target, requestUrl: string): Promise<GenerationResult> {
  const prepared = await prepareOutput(env, config, target);
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
  return buildSurgeInline(config, prepared.nodes, prepared.hostEntries, requestUrl);
}

async function prepareOutput(env: Env, config: AppConfig, target: Target): Promise<PreparedOutput> {
  const warnings: string[] = [];
  const fetched = await fetchAllSources(env, config, target, warnings);
  const exitNode = buildExitNode(config);
  const exitNodes = exitNode ? [exitNode] : [];
  const supported = await applyTransforms(env, [...fetched.nodes, ...exitNodes], config, target, warnings);
  const chainSettings = chainSettingsForConfig(config);
  const nodes = chainSettings.enabled
    ? [...supported, ...buildChainNodes(supported, chainSettings.filter)]
    : supported;
  return {
    nodes,
    hostEntries: fetched.hostEntries,
    fetchedSources: config.sources.filter((source) => source.enabled && source.url).length,
    warnings
  };
}

function buildExitNode(config: AppConfig): ProxyNode | null {
  const exitProxy = config.chain.exitProxy;
  const server = exitProxy.server.trim();
  if (!server || !exitProxy.port) return null;
  const params: ProxyNode["params"] = {};
  const username = exitProxy.username.trim();
  const password = exitProxy.password.trim();
  const node: ProxyNode = {
    name: CHAIN_EXIT_PROXY_NAME,
    type: exitProxy.protocol,
    server,
    port: exitProxy.port,
    params
  };
  applyExitAuth(node, exitProxy.protocol, username, password);
  return node;
}

function applyExitAuth(node: ProxyNode, protocol: ChainExitProtocol, username: string, password: string): void {
  if (["http", "https", "socks5", "socks5-tls", "trust-tunnel", "ssh"].includes(protocol)) {
    if (username) node.params.username = username;
    if (password) {
      node.password = password;
      node.params.password = password;
    }
    return;
  }

  if (protocol === "ss") {
    node.cipher = username || "chacha20-ietf-poly1305";
    if (password) {
      node.password = password;
      node.params.password = password;
    }
    return;
  }

  if (protocol === "snell") {
    if (password) node.params.psk = password;
    node.params.version = 4;
    return;
  }

  if (protocol === "tuic") {
    if (username) node.uuid = username;
    if (password) {
      node.password = password;
      node.params.token = password;
    }
    return;
  }

  if (protocol === "vmess") {
    if (username) node.uuid = username;
    node.cipher = "auto";
    return;
  }

  if (["trojan", "hysteria2", "anytls"].includes(protocol) && password) {
    node.password = password;
    node.params.password = password;
  }
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

function filterNodesForTarget(nodes: ProxyNode[], target: Target): ProxyNode[] {
  const supported = target === "surge"
    ? SURGE_PROTOCOLS
    : CLASH_PROTOCOLS;
  return nodes.filter((node) => supported.has(node.type.toLowerCase()));
}

async function applyTransforms(
  env: Env,
  nodes: ProxyNode[],
  config: AppConfig,
  target: Target,
  warnings: string[]
): Promise<ProxyNode[]> {
  const filtered = nodes.filter((node) => !config.settings.excludeKeywords.some((keyword) => node.name.includes(keyword)));
  const deduped = dedupeByFingerprint(filtered);
  const supported = filterNodesForTarget(deduped, target);
  return config.settings.geoipRenameEnabled
    ? await renameByNodeRegion(env, supported, config.settings.featureTagRules, warnings)
    : supported.map((node) => ({ ...node, name: prependSourceNameTag(node.name, node.sourceName) }));
}

function chainSettingsForConfig(config: AppConfig): { enabled: boolean; filter: string[] } {
  return {
    enabled: Boolean(config.chain.exitProxy.server.trim() && config.chain.exitProxy.port),
    filter: config.chain.filter
  };
}

async function renameByNodeRegion(env: Env, nodes: ProxyNode[], featureTagRuleLines: string[], warnings: string[]): Promise<ProxyNode[]> {
  const featureTagRules = parseFeatureTagRules(featureTagRuleLines);
  const counters = new Map<string, number>();
  const renamed: ProxyNode[] = [];
  for (const node of nodes) {
    if (node.name === CHAIN_EXIT_PROXY_NAME) {
      renamed.push({ ...node });
      continue;
    }
    const region = await inferRegionForNode(env, node, warnings);
    const code = region.name;
    const counterKey = `${sourceNameTag(node.sourceName)}\0${code}`;
    const next = (counters.get(counterKey) ?? 0) + 1;
    counters.set(counterKey, next);
    const tags = node.featureTags ?? extractFeatureTags(node.name, featureTagRules);
    const suffix = tags.length > 0 ? ` ${tags.join(" ")}` : "";
    renamed.push({
      ...node,
      name: prependSourceNameTag(`${code} ${String(next).padStart(2, "0")}${suffix}`, node.sourceName),
      matchLabels: mergeMatchLabels(node.matchLabels, region.labels)
    });
  }
  return renamed;
}

function prependSourceNameTag(name: string, sourceName: string | undefined): string {
  const tag = sourceNameTag(sourceName);
  return tag ? `${tag} ${name}` : name;
}

function sourceNameTag(sourceName: string | undefined): string {
  const trimmed = sourceName?.trim();
  if (!trimmed) return "";
  const unwrapped = trimmed.match(/^\[([^\]]+)\]$/)?.[1]?.trim() ?? trimmed;
  return unwrapped ? `[${unwrapped}]` : "";
}

async function inferRegionForNode(env: Env, node: ProxyNode, warnings: string[]): Promise<RegionInfo> {
  const server = normalizeServerAddress(node.server);
  const nameRegion = inferRegionFromName(node.originalName ?? node.name);
  if (isKnownRegion(nameRegion)) return nameRegion;
  if (!isIpAddress(server)) return nameRegion;
  try {
    const region = await lookupIpRegion(env, server);
    if (region) return region;
  } catch (error) {
    warnings.push(`${server}: ${error instanceof Error ? error.message : String(error)}`);
    if (isKnownRegion(nameRegion)) return nameRegion;
    return unknownRegion();
  }
  if (isKnownRegion(nameRegion)) return nameRegion;
  warnings.push(`${server}: GeoIP lookup returned no region and original node name has no region`);
  return unknownRegion();
}

function isKnownRegion(region: RegionInfo): boolean {
  return region.name !== UNKNOWN_REGION_NAME;
}

function inferRegionFromName(name: string): RegionInfo {
  const countryNameCode = findRegionAlias(name, COUNTRY_NAME_ALIASES);
  if (countryNameCode) return countryRegion(countryNameCode);
  const cityCountryCode = findRegionAlias(name, CITY_COUNTRY_ALIASES);
  if (cityCountryCode) return countryRegion(cityCountryCode);
  const flagCountryCode = extractFlagCountryCode(name);
  if (flagCountryCode && COUNTRY_CODES.has(flagCountryCode)) return countryRegion(flagCountryCode);
  const countryCode = findRegionAlias(name, COUNTRY_CODE_ALIASES);
  if (countryCode) return countryRegion(countryCode);
  return unknownRegion();
}

function findRegionAlias(name: string, aliases: Map<string, string>): string {
  const tokens = latinRegionTokens(name);
  for (const [alias, code] of aliases) {
    if (aliasMatchesName(name, tokens, alias)) return code;
  }
  return "";
}

function aliasMatchesName(name: string, tokens: string[], alias: string): boolean {
  if (/^[a-z0-9-]+$/.test(alias)) return latinAliasMatches(tokens, alias);
  return name.includes(alias);
}

function latinAliasMatches(tokens: string[], alias: string): boolean {
  const parts = alias.split("-").filter(Boolean);
  if (parts.length === 0) return false;
  if (parts.length === 1) return tokens.includes(parts[0]!);
  return tokens.some((_, index) => parts.every((part, offset) => tokens[index + offset] === part))
    || tokens.includes(parts.join(""));
}

function latinRegionTokens(value: string): string[] {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((token, index, tokens) => !isTrafficUnitToken(token, tokens[index - 1]));
}

function isTrafficUnitToken(token: string, previousToken: string | undefined): boolean {
  return Boolean(previousToken && /^\d+$/.test(previousToken) && /^(kb|mb|gb|tb|kib|mib|gib|tib)$/.test(token));
}

function extractFlagCountryCode(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const first = value.codePointAt(index);
    if (first === undefined || !isRegionalIndicator(first)) continue;
    const secondIndex = index + codePointLength(first);
    const second = value.codePointAt(secondIndex);
    if (second === undefined || !isRegionalIndicator(second)) continue;
    return String.fromCharCode(65 + first - 0x1f1e6, 65 + second - 0x1f1e6);
  }
  return "";
}

function isRegionalIndicator(codePoint: number): boolean {
  return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}

function codePointLength(codePoint: number): number {
  return codePoint > 0xffff ? 2 : 1;
}

function countryRegion(countryCode: string): RegionInfo {
  return { name: countryCode, labels: [countryCode] };
}

function unknownRegion(): RegionInfo {
  return { name: UNKNOWN_REGION_NAME, labels: [UNKNOWN_REGION_NAME] };
}

function normalizeServerAddress(server: string): string {
  const trimmed = server.trim();
  const bracketed = trimmed.match(/^\[([^\]]+)\]$/);
  return bracketed?.[1] ?? trimmed;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function getJsonCache<T>(env: Env, key: string): Promise<T | null> {
  const value = await env.SUBPILOT_CONFIG.get(key);
  if (value === null) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

async function putJsonCache(env: Env, key: string, value: unknown, ttlSeconds: number): Promise<void> {
  await env.SUBPILOT_CONFIG.put(key, JSON.stringify(value), { expirationTtl: Math.max(30, ttlSeconds) });
}

function isIpAddress(value: string): boolean {
  return isIPv4(value) || isIPv6(value);
}

function isIPv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const number = Number(part);
    return number >= 0 && number <= 255;
  });
}

function isIPv6(value: string): boolean {
  return /^[0-9a-f:]+$/i.test(value) && value.includes(":");
}

function dedupeByFingerprint(nodes: ProxyNode[]): ProxyNode[] {
  const selected = new Map<string, ProxyNode>();
  for (const node of nodes) {
    const key = nodeFingerprint(node);
    const existing = selected.get(key);
    if (!existing) {
      selected.set(key, node);
      continue;
    }
    const featureTags = mergeFeatureTags(existing.featureTags, node.featureTags);
    const matchLabels = mergeMatchLabels(existing.matchLabels, node.matchLabels);
    if (nodeConfigWeight(node) > nodeConfigWeight(existing)) {
      selected.set(key, { ...node, featureTags, matchLabels });
    } else {
      selected.set(key, { ...existing, featureTags, matchLabels });
    }
  }
  return [...selected.values()];
}

interface FeatureTagRule {
  tag: string;
  keywords: string[];
}

function parseFeatureTagRules(lines: string[] = []): FeatureTagRule[] {
  return lines.flatMap((line) => {
    const [rawTag, rawKeywords] = line.split(/=(.*)/s);
    const tag = sanitizeFeatureTag(rawTag ?? "");
    if (!tag) return [];
    const keywords = (rawKeywords === undefined ? [rawTag ?? ""] : rawKeywords.split(","))
      .map((item) => item.trim())
      .filter(Boolean);
    return keywords.length > 0 ? [{ tag, keywords }] : [];
  });
}

function extractFeatureTags(name: string, rules: FeatureTagRule[]): string[] {
  return rules
    .filter((rule) => rule.keywords.some((keyword) => featureKeywordMatches(name, keyword)))
    .map((rule) => rule.tag);
}

function nodeTagsForMatching(name: string, matchLabels: string[] | undefined, featureTagRules: FeatureTagRule[]): { featureTags: string[]; matchLabels: string[] } {
  const featureTags = extractFeatureTags(name, featureTagRules);
  return {
    featureTags,
    matchLabels: mergeMatchLabels(matchLabels, [...inferRegionFromName(name).labels, ...featureTags])
  };
}

function featureKeywordMatches(name: string, keyword: string): boolean {
  return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(keyword)}(?:[^a-z0-9]|$)`, "i").test(name);
}

function sanitizeFeatureTag(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mergeFeatureTags(...sets: Array<string[] | undefined>): string[] {
  return [...new Set(sets.flatMap((set) => set ?? []))];
}

function mergeMatchLabels(...sets: Array<string[] | undefined>): string[] {
  return [...new Set(sets.flatMap((set) => set ?? []).map((item) => item.trim()).filter(Boolean))];
}

function nodeFingerprint(node: ProxyNode): string {
  return [
    canonicalProtocol(node.type),
    node.server.toLowerCase(),
    node.port ?? "",
    node.password ?? "",
    node.uuid ?? "",
    node.cipher ?? "",
    stableParamFingerprint(node.params)
  ].join("|");
}

function stableParamFingerprint(value: ProxyNode["params"][string] | ProxyNode["params"]): string {
  if (Array.isArray(value)) return `[${value.map(stableParamFingerprint).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableParamFingerprint(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function canonicalProtocol(type: string): string {
  return type.toLowerCase() === "hy2" ? "hysteria2" : type.toLowerCase();
}

function nodeConfigWeight(node: ProxyNode): number {
  const params = Object.entries(node.params)
    .filter(([key]) => !["name", "type", "server", "port"].includes(key))
    .reduce((total, [, value]) => total + paramWeight(value), 0);
  const password = node.password && node.params.password === undefined ? 1 : 0;
  const uuid = node.uuid && node.params.uuid === undefined && node.params.username === undefined ? 1 : 0;
  const cipher = node.cipher && node.params.cipher === undefined && node.params["encrypt-method"] === undefined ? 1 : 0;
  return params + password + uuid + cipher;
}

function paramWeight(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  if (Array.isArray(value)) return value.reduce((total, item) => total + paramWeight(item), 0);
  if (typeof value === "object") {
    return Object.values(value).reduce((total, item) => total + paramWeight(item), 0);
  }
  return 1;
}

function buildChainNodes(nodes: ProxyNode[], filters: string[]): ProxyNode[] {
  const exit = nodes.find((node) => node.name === CHAIN_EXIT_PROXY_NAME);
  if (!exit) return [];
  return nodes
    .filter((node) => node.name !== CHAIN_EXIT_PROXY_NAME && filters.some((filter) => nodeMatchesFilter(node, filter)))
    .map((node) => ({
      ...exit,
      name: `${node.name} Chain`,
      featureTags: mergeFeatureTags(node.featureTags, ["Chain"]),
      matchLabels: mergeMatchLabels(node.matchLabels, ["Chain"]),
      params: {
        ...exit.params,
        "underlying-proxy": node.name,
        "dialer-proxy": node.name
      }
    }));
}

function buildSurge(config: AppConfig, nodes: ProxyNode[], sourceHostEntries: HostEntry[], requestUrl: string): string {
  return buildSurgeInline(config, nodes, sourceHostEntries, requestUrl);
}

function buildSurgeInline(config: AppConfig, nodes: ProxyNode[], sourceHostEntries: HostEntry[], requestUrl: string): string {
  const proxyLines = nodes.map(toSurgeLine);
  const groupOutputs = buildSurgeGroups(config, nodes);
  const variant = renderSurgeInlineProfile(config, nodes, sourceHostEntries, proxyLines, groupOutputs);
  const managedUrl = buildManagedUrl(config, requestUrl);
  return `#!MANAGED-CONFIG ${managedUrl} interval=${config.surge.managedConfigIntervalSeconds} strict=true\n# Last Updated: ${beijingTimestamp()} (UTC+8)\n${variant}`;
}

function buildClash(config: AppConfig, nodes: ProxyNode[], sourceHostEntries: HostEntry[]): string {
  const data: Record<string, unknown> = {
    port: config.clash.port,
    "socks-port": config.clash.socksPort,
    "mixed-port": config.clash.mixedPort,
    "allow-lan": config.clash.allowLan,
    mode: config.clash.mode,
    "log-level": config.clash.logLevel,
    ipv6: config.clash.ipv6,
    "unified-delay": config.clash.unifiedDelay,
    "tcp-concurrent": config.clash.tcpConcurrent,
    "external-controller": config.clash.externalController
  };
  if (config.clash.tun.enable) {
    data.tun = {
      enable: true,
      stack: config.clash.tun.stack,
      "auto-route": config.clash.tun.autoRoute,
      "auto-detect-interface": config.clash.tun.autoDetectInterface,
      "skip-proxy": config.clash.tun.skipProxy
    };
  }
  if (config.clash.dnsEnabled) {
    const dns: Record<string, unknown> = {
      enable: true,
      listen: config.clash.dnsListen,
      ipv6: config.clash.dnsIpv6,
      "enhanced-mode": config.clash.dnsEnhancedMode
    };
    if (config.clash.dnsEnhancedMode === "fake-ip") {
      dns["fake-ip-range"] = config.clash.dnsFakeIpRange;
      dns["fake-ip-filter"] = config.clash.fakeIpFilter;
    }
    Object.assign(dns, {
      "default-nameserver": config.clash.defaultNameservers,
      nameserver: config.clash.nameservers,
      fallback: config.clash.fallbackNameservers,
      "fallback-filter": {
        geoip: config.clash.fallbackFilterGeoip,
        ipcidr: config.clash.fallbackFilterIpcidr
      }
    });
    data.dns = dns;
  }
  const hosts = hostEntriesToClashHosts(sourceHostEntries);
  if (Object.keys(hosts).length > 0) data.hosts = hosts;
  const ruleProviders = parseClashRuleProvidersYaml(config.clash.ruleProviders);
  if (Object.keys(ruleProviders).length > 0) {
    data["rule-providers"] = ruleProviders;
  }
  data.proxies = nodes.map(toClashProxy);
  const proxyGroups = buildClashGroups(config, nodes);
  data["proxy-groups"] = proxyGroups;
  const rules = addMissingClashRuleProviderRules(
    rewriteUnavailableGroupRuleTargets(config, filterClashRules(config.clash.rules), nodes, new Set(proxyGroups.map((group) => String(group.name)))),
    Object.keys(ruleProviders)
  );
  data.rules = rules;
  return `# Last Updated: ${beijingTimestamp()} (UTC+8)\n${YAML.stringify(data)}`;
}

function buildStash(config: AppConfig, nodes: ProxyNode[], sourceHostEntries: HostEntry[], requestUrl: string, warnings: string[]): string {
  const data: Record<string, unknown> = {
    port: config.stash.port,
    "socks-port": config.stash.socksPort,
    "mixed-port": config.stash.mixedPort,
    "allow-lan": config.stash.allowLan,
    mode: config.stash.mode,
    "log-level": config.stash.logLevel,
    ipv6: config.stash.ipv6,
    "unified-delay": config.stash.unifiedDelay,
    "tcp-concurrent": config.stash.tcpConcurrent,
    "external-controller": config.stash.externalController
  };
  if (config.stash.tun.enable) {
    data.tun = {
      enable: true,
      stack: config.stash.tun.stack,
      "auto-route": config.stash.tun.autoRoute,
      "auto-detect-interface": config.stash.tun.autoDetectInterface,
      "skip-proxy": config.stash.tun.skipProxy
    };
  }
  if (config.stash.dns.enable) {
    const dns: Record<string, unknown> = {
      enable: true,
      listen: config.stash.dns.listen,
      ipv6: config.stash.dns.ipv6,
      "enhanced-mode": config.stash.dns.enhancedMode
    };
    if (config.stash.dns.enhancedMode === "fake-ip") {
      dns["fake-ip-range"] = config.stash.dns.fakeIpRange;
      dns["fake-ip-filter"] = config.stash.dns.fakeIpFilter;
    }
    Object.assign(dns, {
      "default-nameserver": config.stash.dns.defaultNameservers,
      nameserver: config.stash.dns.nameservers,
      fallback: config.stash.dns.fallbackNameservers,
      "fallback-filter": {
        geoip: config.stash.dns.fallbackFilterGeoip,
        ipcidr: config.stash.dns.fallbackFilterIpcidr
      }
    });
    data.dns = dns;
  }
  const hosts = hostEntriesToStashHosts(config.stash.hosts, sourceHostEntries);
  if (Object.keys(hosts).length > 0) data.hosts = hosts;
  const http = buildStashHttp(config, warnings);
  if (Object.keys(http.http).length > 0) data.http = http.http;
  if (Object.keys(http.scriptProviders).length > 0) data["script-providers"] = http.scriptProviders;
  const ruleProviders = parseClashRuleProvidersYaml(config.stash.ruleProviders);
  if (Object.keys(ruleProviders).length > 0) {
    data["rule-providers"] = ruleProviders;
  }
  data.proxies = nodes.map(toClashProxy);
  const proxyGroups = buildClashGroups(config, nodes);
  data["proxy-groups"] = proxyGroups;
  const rules = addMissingClashRuleProviderRules(
    rewriteUnavailableGroupRuleTargets(config, filterClashRules(config.stash.rules), nodes, new Set(proxyGroups.map((group) => String(group.name)))),
    Object.keys(ruleProviders)
  );
  data.rules = rules;
  return `#SUBSCRIBED ${buildManagedUrl(config, requestUrl)}\n# Last Updated: ${beijingTimestamp()} (UTC+8)\n${YAML.stringify(data)}`;
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

interface ParsedStashScript {
  name: string;
  type: "request" | "response";
  match: string;
  requireBody: boolean;
  maxSize: number;
  url: string;
}

function parseStashScriptLine(line: string, lineNumber: number, warnings: string[]): ParsedStashScript | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) return null;
  const separatorIndex = trimmed.indexOf("=");
  const name = separatorIndex > 0 ? trimmed.slice(0, separatorIndex).trim() : "";
  const params = separatorIndex > 0 ? parseStashScriptParams(trimmed.slice(separatorIndex + 1)) : {};
  const typeValue = params.type?.toLowerCase() ?? "";
  const type = typeValue === "http-request"
    ? "request"
    : typeValue === "http-response"
      ? "response"
      : null;
  const match = params.pattern ?? "";
  const url = params["script-path"] ?? "";
  const maxSize = Number(params["max-size"] ?? "0");
  if (!name || !type || !match || !isHttpUrl(url) || !Number.isFinite(maxSize) || maxSize < 0) {
    warnings.push(`Stash script line ${lineNumber}: skipped invalid script definition`);
    return null;
  }
  return {
    name,
    type,
    match,
    requireBody: parseStashBoolean(params["requires-body"]),
    maxSize: Math.floor(maxSize),
    url
  };
}

function parseStashScriptParams(value: string): Record<string, string> {
  const params: Record<string, string> = {};
  const parts: string[] = [];
  for (const rawPart of value.split(",")) {
    const part = rawPart.trim();
    if (!part) continue;
    if (parts.length > 0 && !/^[A-Za-z][\w-]*=/.test(part)) {
      parts[parts.length - 1] = `${parts[parts.length - 1]},${rawPart}`;
      continue;
    }
    parts.push(part);
  }
  for (const part of parts) {
    const [key, raw] = part.split(/=(.*)/s);
    const normalizedKey = key?.trim().toLowerCase();
    const valuePart = raw?.trim();
    if (normalizedKey && valuePart !== undefined) params[normalizedKey] = valuePart;
  }
  return params;
}

function parseStashBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes"].includes(String(value ?? "").trim().toLowerCase());
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function renderHostEntryLine(entry: HostEntry): string {
  return `${entry.host} = ${Array.isArray(entry.value) ? entry.value.join(", ") : entry.value}`;
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

function isSurgeTarget(target: Target): boolean {
  return target === "surge";
}

function buildSurgeGroups(config: AppConfig, nodes: ProxyNode[]): SurgeGroupOutput[] {
  const disabledGroups = new Set(config.disabledGroups);
  return activeGroupEntries(config, "surge").flatMap(([name, spec]) => {
    const [type, ...items] = splitGroupSpec(spec);
    const groupType = type || "select";
    const resolved = groupType === "subnet"
      ? resolveSubnetGroupItems(items, name, disabledGroups)
      : resolveGroupItems(items, nodes).filter((item) => isAllowedGroupItem(item) && !disabledGroups.has(item));
    const outputItems = groupType === "url-test" ? resolved.filter((item) => !item.includes("=")) : resolved;
    if (!shouldEmitPolicyGroup(name, groupType, outputItems)) return [];
    return [{ name, line: `${name} = ${[mapSurgeGroupType(groupType), ...outputItems].join(", ")}` }];
  });
}

function buildClashGroups(config: AppConfig, nodes: ProxyNode[]): Record<string, unknown>[] {
  const disabledGroups = new Set(config.disabledGroups);
  return activeGroupEntries(config, "clash").flatMap(([name, spec]) => {
    const [type, ...items] = splitGroupSpec(spec);
    const groupType = type || "select";
    const proxies = resolveGroupItems(items, nodes).filter((item) => !item.includes("=") && isAllowedGroupItem(item) && !disabledGroups.has(item));
    if (!shouldEmitPolicyGroup(name, groupType, proxies)) return [];
    const options = Object.fromEntries(items.filter((item) => item.includes("=")).map((item) => item.split(/=(.*)/s) as [string, string]));
    return [{
      name,
      type: mapClashGroupType(groupType),
      proxies,
      ...options
    }];
  });
}

function shouldEmitPolicyGroup(name: string, type: string, resolvedItems: string[]): boolean {
  return name === "Proxy" || type === "subnet" || resolvedItems.length > 0;
}

function activeGroupEntries(config: AppConfig, target: "surge" | "clash"): [string, string][] {
  const disabledGroups = new Set(config.disabledGroups);
  return Object.entries(config.groups).filter(([name, spec]) => {
    if (disabledGroups.has(name)) return false;
    return target === "surge" || !isSurgeOnlyGroupSpec(spec);
  });
}

function splitGroupSpec(spec: string): string[] {
  const parts: string[] = [];
  let current = "";
  let braceDepth = 0;
  for (const char of spec) {
    if (char === "{") braceDepth += 1;
    if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
    if (char === "," && braceDepth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function resolveGroupItems(items: string[], nodes: ProxyNode[]): string[] {
  const output: string[] = [];
  for (const item of items) {
    const match = matchExternalPolicyPlaceholder(item);
    if (!match) {
      output.push(item);
      continue;
    }
    const filters = match[1]?.split(",").map((part) => part.trim()).filter(Boolean) ?? [];
    const excludes = match[2]?.split(",").map((part) => part.trim()).filter(Boolean) ?? [];
    output.push(...nodes
      .filter((node) => node.name !== CHAIN_EXIT_PROXY_NAME)
      .filter((node) => filters.length === 0 || filters.some((filter) => nodeMatchesFilter(node, filter)))
      .filter((node) => excludes.every((exclude) => !nodeMatchesFilter(node, exclude)))
      .map((node) => node.name));
  }
  return [...new Set(output)];
}

function matchExternalPolicyPlaceholder(item: string): RegExpMatchArray | null {
  return item.match(/^\{all(?:\s+filter=([^}]*?)(?=\s+exclude=|}))?(?:\s+exclude=([^}]+))?\}$/);
}

function resolveSubnetGroupItems(items: string[], groupName: string, disabledGroups: Set<string>): string[] {
  const output: string[] = [];
  let hasDefault = false;
  for (const item of items) {
    const option = parseGroupOption(item);
    if (!option) continue;
    if (!isSubnetGroupOption(option.key)) continue;
    if (!isAllowedSubnetPolicy(option.value, groupName, disabledGroups)) continue;
    const isDefault = option.key.toLowerCase() === "default";
    if (isDefault) {
      if (hasDefault) continue;
      hasDefault = true;
    }
    const line = `${option.key}=${option.value}`;
    output.push(line);
  }
  if (!hasDefault) {
    output.unshift("default=Proxy");
  }
  return output;
}

function parseGroupOption(item: string): { key: string; value: string } | null {
  const match = item.match(/^([^=,{}]+)=(.*)$/s);
  if (!match) return null;
  const key = (match[1] ?? "").trim();
  const value = (match[2] ?? "").trim();
  if (!key || !value) return null;
  return { key, value };
}

function isSubnetGroupOption(key: string): boolean {
  return key.toLowerCase() === "default" || /^(SSID|BSSID|ROUTER):.+$/i.test(key) || /^TYPE:(WIFI|WIRED|CELLULAR)$/i.test(key);
}

function isAllowedSubnetPolicy(policy: string, groupName: string, disabledGroups: Set<string>): boolean {
  return policy !== groupName
    && policy !== CHAIN_EXIT_PROXY_NAME
    && !disabledGroups.has(policy);
}

function nodeMatchesFilter(node: ProxyNode, filter: string): boolean {
  const normalizedFilter = filter.toLowerCase();
  return [node.name, ...(node.matchLabels ?? [])].some((value) => value.toLowerCase().includes(normalizedFilter));
}

function isAllowedGroupItem(item: string): boolean {
  return item !== CHAIN_EXIT_PROXY_NAME && item !== "Proxy";
}

function mapSurgeGroupType(type: string): string {
  if (type === "url-test") return "smart";
  return type;
}

function mapClashGroupType(type: string): string {
  return type;
}

function renderSurgeInlineProfile(config: AppConfig, nodes: ProxyNode[], sourceHostEntries: HostEntry[], proxyLines: string[], groupOutputs: SurgeGroupOutput[]): string {
  const sections = renderSurgeBaseSections(config);
  const sourceHostLines = sourceHostEntries.map(renderHostEntryLine);
  const hostLines = [...config.surge.hosts, ...sourceHostLines];
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
    `exclude-simple-hostnames = ${config.surge.excludeSimpleHostnames ? "true" : "false"}`,
    `encrypted-dns-follow-outbound-mode = ${config.surge.encryptedDnsFollowOutboundMode ? "true" : "false"}`
  );
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

const BUILT_IN_RULE_POLICIES = new Set([
  "DIRECT",
  "REJECT",
  "REJECT-DROP",
  "REJECT-NO-DROP",
  "REJECT-TINYGIF"
]);

function rewriteUnavailableGroupRuleTargets(config: AppConfig, rules: string[], nodes: ProxyNode[], groupNames: Set<string>): string[] {
  const disabledGroups = new Set(config.disabledGroups);
  const proxyNames = new Set(nodes.map((node) => node.name));
  return rules.map((rule) => {
    const parts = rule.split(",");
    const targetIndex = ruleTargetIndex(parts);
    if (targetIndex === null) return rule;
    const target = parts[targetIndex]?.trim() ?? "";
    if (!target || isAvailableRuleTarget(target, groupNames, disabledGroups, proxyNames)) return rule;
    parts[targetIndex] = "Proxy";
    return parts.join(",");
  });
}

function filterClashRules(rules: string[]): string[] {
  return rules.filter((rule) => !usesSurgeSubnetRule(rule));
}

function addMissingClashRuleProviderRules(rules: string[], providerNames: string[]): string[] {
  if (providerNames.length === 0) return rules;
  const usedProviders = new Set(rules.flatMap((rule) => {
    const parts = rule.split(",");
    return parts[0]?.trim().toUpperCase() === "RULE-SET" && parts[1]?.trim()
      ? [parts[1].trim()]
      : [];
  }));
  const missingRules = providerNames
    .filter((name) => !usedProviders.has(name))
    .map((name) => `RULE-SET,${name},Proxy`);
  if (missingRules.length === 0) return rules;
  const matchIndex = rules.findIndex((rule) => {
    const type = rule.split(",")[0]?.trim().toUpperCase();
    return type === "MATCH" || type === "FINAL";
  });
  if (matchIndex < 0) return [...rules, ...missingRules];
  return [
    ...rules.slice(0, matchIndex),
    ...missingRules,
    ...rules.slice(matchIndex)
  ];
}

function isSurgeOnlyGroupSpec(spec: string): boolean {
  const [type = "select"] = splitGroupSpec(spec);
  return type === "subnet";
}

function usesSurgeSubnetRule(rule: string): boolean {
  return /(?:^|[,(])\s*SUBNET(?:\s*[:,)]|,)/i.test(rule);
}

function ruleTargetIndex(parts: string[]): number | null {
  const type = parts[0]?.trim().toUpperCase();
  if (!type || type.startsWith("#")) return null;
  if (type === "AND" || type === "OR" || type === "NOT") return null;
  if ((type === "FINAL" || type === "MATCH") && parts.length >= 2) return 1;
  if (parts.length >= 3) return 2;
  return null;
}

function isAvailableRuleTarget(target: string, activeGroups: Set<string>, disabledGroups: Set<string>, proxyNames: Set<string>): boolean {
  if (disabledGroups.has(target)) return false;
  return activeGroups.has(target) || proxyNames.has(target) || BUILT_IN_RULE_POLICIES.has(target.toUpperCase());
}

function beijingTimestamp(): string {
  return new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai", hour12: false });
}
