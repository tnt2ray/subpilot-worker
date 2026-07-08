import { lookupIpRegion, type RegionInfo } from "./geoip";
import { parseConfiguredProxyNode } from "./parsers";
import { CHAIN_EXIT_PROXY_NAME, type AppConfig, type ProxyNode, type Target } from "./types";

const SURGE_PROTOCOLS = new Set(["http", "https", "socks5", "socks5-tls", "ss", "snell", "trojan", "vmess", "hysteria2", "hy2", "tuic", "anytls", "trust-tunnel", "ssh"]);
const CLASH_PROTOCOLS = new Set([...SURGE_PROTOCOLS, "vless"]);
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

export interface FeatureTagRule {
  tag: string;
  keywords: string[];
}

export function buildConfiguredProxyNodes(config: AppConfig): ProxyNode[] {
  const featureTagRules = parseFeatureTagRules(config.settings.featureTagRules);
  return config.proxyNodes
    .filter((node) => node.enabled)
    .flatMap((proxyNode) => {
      const parsedNode = parseConfiguredProxyNode(proxyNode);
      if (!parsedNode) return [];
      return [{
        ...parsedNode,
        originalName: parsedNode.name,
        manual: true,
        chainExit: proxyNode.chainExit,
        chainFilter: proxyNode.chainFilter,
        includeInGroups: proxyNode.includeInGroups,
        ...nodeTagsForMatching(parsedNode.name, parsedNode.matchLabels, featureTagRules)
      }];
    });
}

export async function applyTransforms(
  env: Env,
  nodes: ProxyNode[],
  config: AppConfig,
  target: Target,
  warnings: string[]
): Promise<ProxyNode[]> {
  const filtered = nodes.filter((node) => node.manual || !config.settings.excludeKeywords.some((keyword) => node.name.includes(keyword)));
  const deduped = dedupeByFingerprint(filtered);
  const supported = filterNodesForTarget(deduped, target);
  return config.settings.geoipRenameEnabled
    ? await renameByNodeRegion(env, supported, config.settings.featureTagRules, warnings)
    : supported.map((node) => ({ ...node, name: prependSourceNameTag(node.name, node.sourceName) }));
}

export function buildChainNodes(nodes: ProxyNode[]): ProxyNode[] {
  const exits = nodes.filter((node) => node.chainExit && node.chainFilter && node.chainFilter.length > 0);
  if (exits.length === 0) return [];
  return exits.flatMap((exit) => {
    const bases = nodes.filter((node) => !node.chainExit && exit.chainFilter?.some((filter) => nodeMatchesFilter(node, filter)));
    return bases.map((node) => ({
      ...exit,
      name: chainNodeName(node, exit),
      originalName: chainNodeName(node, exit),
      manual: false,
      chainExit: false,
      includeInGroups: true,
      surgeDetail: undefined,
      featureTags: node.featureTags,
      matchLabels: mergeMatchLabels(node.matchLabels, ["via", exit.name]),
      params: {
        ...exit.params,
        "underlying-proxy": node.name,
        "dialer-proxy": node.name
      }
    }));
  });
}

export function parseFeatureTagRules(lines: string[] = []): FeatureTagRule[] {
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

export function nodeTagsForMatching(name: string, matchLabels: string[] | undefined, featureTagRules: FeatureTagRule[]): { featureTags: string[]; matchLabels: string[] } {
  const featureTags = extractFeatureTags(name, featureTagRules);
  return {
    featureTags,
    matchLabels: mergeMatchLabels(matchLabels, [...inferRegionFromName(name).labels, ...featureTags])
  };
}

export function nodeMatchesFilter(node: ProxyNode, filter: string): boolean {
  const normalizedFilter = filter.toLowerCase();
  return [node.name, ...(node.matchLabels ?? [])].some((value) => value.toLowerCase().includes(normalizedFilter));
}

export function isIPv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const number = Number(part);
    return number >= 0 && number <= 255;
  });
}

export function isIPv6(value: string): boolean {
  return /^[0-9a-f:]+$/i.test(value) && value.includes(":");
}

function filterNodesForTarget(nodes: ProxyNode[], target: Target): ProxyNode[] {
  const supported = target === "surge" ? SURGE_PROTOCOLS : CLASH_PROTOCOLS;
  return nodes.filter((node) => supported.has(node.type.toLowerCase()));
}

async function renameByNodeRegion(env: Env, nodes: ProxyNode[], featureTagRuleLines: string[], warnings: string[]): Promise<ProxyNode[]> {
  const featureTagRules = parseFeatureTagRules(featureTagRuleLines);
  const counters = new Map<string, number>();
  const renamed: ProxyNode[] = [];
  for (const node of nodes) {
    if (node.manual || node.name === CHAIN_EXIT_PROXY_NAME) {
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

function isIpAddress(value: string): boolean {
  return isIPv4(value) || isIPv6(value);
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
    const mergedBase = {
      manual: existing.manual || node.manual || undefined,
      chainExit: existing.chainExit || node.chainExit || undefined,
      chainFilter: existing.chainFilter?.length ? existing.chainFilter : node.chainFilter,
      includeInGroups: existing.includeInGroups === true || node.includeInGroups === true
        ? true
        : existing.includeInGroups === false || node.includeInGroups === false
          ? false
          : undefined
    };
    if (node.manual && !existing.manual) {
      selected.set(key, { ...node, ...mergedBase, featureTags, matchLabels });
    } else if (!node.manual && existing.manual) {
      selected.set(key, { ...existing, ...mergedBase, featureTags, matchLabels });
    } else if (nodeConfigWeight(node) > nodeConfigWeight(existing)) {
      selected.set(key, { ...node, ...mergedBase, featureTags, matchLabels });
    } else {
      selected.set(key, { ...existing, ...mergedBase, featureTags, matchLabels });
    }
  }
  return [...selected.values()];
}

function extractFeatureTags(name: string, rules: FeatureTagRule[]): string[] {
  return rules
    .filter((rule) => rule.keywords.some((keyword) => featureKeywordMatches(name, keyword)))
    .map((rule) => rule.tag);
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

function chainNodeName(node: ProxyNode, exit: ProxyNode): string {
  return `${node.name} via ${exit.name}`;
}
