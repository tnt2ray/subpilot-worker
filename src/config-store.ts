import { DEFAULT_CONFIG } from "./default-config";
import { ensureKvSchema } from "./config-schema";
import { decryptText, encryptText, sealSources, unsealSources } from "./crypto-store";
import { getSecret, requireSecret } from "./secrets";
import { pruneSourceCache } from "./source-cache";
import { inferUrlRewriteMitmHostnames } from "./surge-url-rewrite";
import { CHAIN_EXIT_PROTOCOLS, type AppConfig, type ChainExitProtocol, type NotificationChannel, type SourceConfig, type SurgeIpv6VifMode, type Target } from "./types";
import { sha256Hex } from "./util";

const CONFIG_UPDATED_AT_KEY = "config:updatedAt";
const READ_TOKEN_HASH_KEY = "auth:read_token_hash";
const SETTINGS_PREFIX = "config:settings:";
const TELEGRAM_BOT_TOKEN_KEY = `${SETTINGS_PREFIX}notificationTelegramBotToken`;
const TELEGRAM_WEBHOOK_SECRET_KEY = `${SETTINGS_PREFIX}notificationTelegramWebhookSecret`;
const GROUP_INDEX_KEY = "config:groups:index";
const GROUP_DISABLED_KEY = "config:groups:disabled";
const GROUP_PREFIX = "config:groups:";
const SOURCE_INDEX_KEY = "config:sources:index";
const SOURCE_PREFIX = "config:sources:";
const CHAIN_PREFIX = "config:chain:";
const SURGE_PREFIX = "config:surge:";
const CLASH_PREFIX = "config:clash:";
const READ_TOKEN_KEY = "auth:read_token";
const SURGE_IPV6_VIF_MODES = ["off", "auto", "always"] as const satisfies readonly SurgeIpv6VifMode[];
const RESERVED_MANAGED_BASE_PATHS = new Set([
  "/api",
  "/app.js",
  "/index.html",
  "/login.html",
  "/mitm-ca.js",
  "/styles.css"
]);

const SETTING_KEYS = [
  "managedBaseUrl",
  "userAgentSurge",
  "userAgentClash",
  "excludeKeywords",
  "geoipRenameEnabled",
  "featureTagRules",
  "updateCheckEnabled",
  "notificationChannel",
  "notificationTelegramChatId"
] as const satisfies readonly (keyof AppConfig["settings"])[];

const SURGE_KEYS = [
  "skipProxy",
  "dnsServer",
  "alwaysRealIp",
  "managedConfigIntervalSeconds",
  "internetTestUrl",
  "proxyTestUrl",
  "showErrorPageForReject",
  "ipv6",
  "ipv6Vif",
  "allowWifiAccess",
  "tunExcludedRoutes",
  "encryptedDnsServer",
  "wifiAssist",
  "excludeSimpleHostnames",
  "encryptedDnsFollowOutboundMode",
  "ponteDeviceNames",
  "hosts",
  "urlRewrite",
  "scripts",
  "mitm",
  "rules",
] as const satisfies readonly (keyof AppConfig["surge"])[];

const CLASH_KEYS = [
  "port",
  "socksPort",
  "mixedPort",
  "allowLan",
  "mode",
  "logLevel",
  "ipv6",
  "unifiedDelay",
  "tcpConcurrent",
  "externalController",
  "tun",
  "dnsEnabled",
  "dnsListen",
  "dnsIpv6",
  "dnsEnhancedMode",
  "dnsFakeIpRange",
  "defaultNameservers",
  "nameservers",
  "fallbackNameservers",
  "fallbackFilterGeoip",
  "fallbackFilterIpcidr",
  "fakeIpFilter",
  "ruleProviders",
  "rules"
] as const satisfies readonly (keyof AppConfig["clash"])[];

export async function loadConfig(env: Env): Promise<AppConfig> {
  const config = await loadStoredConfig(env);
  return unsealConfig(env, config);
}

export async function saveConfig(env: Env, config: AppConfig): Promise<AppConfig> {
  const normalized = normalizeConfig({ ...config, updatedAt: new Date().toISOString() });
  const sealedSources = await sealSources(normalized.sources, requireSecret(env, "CONFIG_ENCRYPTION_KEY"));

  await Promise.all([
    putJson(env, CONFIG_UPDATED_AT_KEY, normalized.updatedAt),
    saveSettings(env, normalized.settings),
    saveGroups(env, normalized.groups),
    saveDisabledGroups(env, normalized.disabledGroups),
    saveSources(env, sealedSources),
    saveChain(env, normalized.chain),
    saveSurge(env, normalized.surge),
    saveClash(env, normalized.clash)
  ]);

  await pruneSourceCache(env, normalized);

  return normalized;
}

export async function readStoredReadTokenHash(env: Env): Promise<string | null> {
  return env.SUBPILOT_CONFIG.get(READ_TOKEN_HASH_KEY);
}

export async function readStoredReadToken(env: Env): Promise<string | null> {
  const stored = await env.SUBPILOT_CONFIG.get(READ_TOKEN_KEY);
  if (!stored) return null;
  const secret = getSecret(env, "CONFIG_ENCRYPTION_KEY");
  if (!stored.startsWith("v1.")) return null;
  if (!secret) throw new Error("CONFIG_ENCRYPTION_KEY secret is required");
  try {
    return await decryptText(secret, stored);
  } catch {
    return null;
  }
}

export async function storeReadToken(env: Env, token: string): Promise<void> {
  const value = await encryptText(requireSecret(env, "CONFIG_ENCRYPTION_KEY"), token);
  await Promise.all([
    env.SUBPILOT_CONFIG.put(READ_TOKEN_KEY, value),
    storeReadTokenHash(env, await sha256Hex(token))
  ]);
}

export async function storeReadTokenHash(env: Env, hash: string): Promise<void> {
  await env.SUBPILOT_CONFIG.put(READ_TOKEN_HASH_KEY, hash);
}

function notificationChannelFromTelegramToken(token: string): NotificationChannel {
  return token.trim() ? "telegram" : "off";
}

export function normalizeTarget(value: string | null | undefined): Target | null {
  const lowered = String(value ?? "").toLowerCase();
  if (lowered === "surge" || lowered === "clash") return lowered;
  return null;
}

export function normalizeConfig(input: AppConfig): AppConfig {
  const chain = normalizeChain(input.chain);
  const groups = normalizeGroups(typeof input.groups === "object" && input.groups ? input.groups : DEFAULT_CONFIG.groups);
  const notificationTelegramBotToken = stringValue(input.settings?.notificationTelegramBotToken, "");
  return {
    version: 1,
    settings: {
      managedBaseUrl: stringValue(input.settings?.managedBaseUrl, DEFAULT_CONFIG.settings.managedBaseUrl),
      userAgentSurge: input.settings?.userAgentSurge || DEFAULT_CONFIG.settings.userAgentSurge,
      userAgentClash: input.settings?.userAgentClash || DEFAULT_CONFIG.settings.userAgentClash,
      excludeKeywords: Array.isArray(input.settings?.excludeKeywords) ? input.settings.excludeKeywords : [],
      geoipRenameEnabled: input.settings?.geoipRenameEnabled !== false,
      featureTagRules: stringArray(input.settings?.featureTagRules, DEFAULT_CONFIG.settings.featureTagRules),
      updateCheckEnabled: input.settings?.updateCheckEnabled === true,
      notificationChannel: notificationChannelFromTelegramToken(notificationTelegramBotToken),
      notificationTelegramChatId: notificationTelegramBotToken ? stringValue(input.settings?.notificationTelegramChatId, "") : "",
      notificationTelegramBotToken,
      notificationTelegramWebhookSecret: notificationTelegramBotToken ? stringValue(input.settings?.notificationTelegramWebhookSecret, "") : ""
    },
    groups,
    disabledGroups: normalizeDisabledGroups(input.disabledGroups, groups),
    sources: Array.isArray(input.sources) ? input.sources.map(normalizeSource) : [],
    chain,
    surge: normalizeSurge(input.surge),
    clash: normalizeClash(input.clash),
    updatedAt: input.updatedAt
  };
}

function normalizeGroups(input: Record<string, string>): Record<string, string> {
  const groupNames = new Set(Object.keys(input));
  return Object.fromEntries(Object.entries(input).map(([name, spec]) => [
    name,
    normalizeGroupSpec(name, spec, groupNames)
  ]));
}

function normalizeGroupSpec(name: string, spec: string, groupNames: Set<string>): string {
  const [type = "select", ...items] = splitGroupSpec(String(spec));
  if (isSubnetGroupType(type)) {
    const filtered: string[] = [];
    let hasDefault = false;
    for (const item of items) {
      if (!isSubnetGroupOption(item, name)) continue;
      const isDefault = parseGroupOption(item)?.key.toLowerCase() === "default";
      if (isDefault) {
        if (hasDefault) continue;
        hasDefault = true;
      }
      filtered.push(item);
    }
    if (!hasDefault) {
      filtered.unshift("default=Proxy");
    }
    return [type, ...filtered].join(", ");
  }
  const filtered = items.filter((item, index) => {
    if (item === "Proxy" || item === name) return false;
    if (groupNames.has(item)) return items.indexOf(item) === index;
    return isGroupOption(item) || isAllSelector(item);
  });
  return [type, ...filtered].join(", ");
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

function isAllSelector(item: string): boolean {
  return /^\{all(?:\s+filter=([^}]*?)(?=\s+exclude=|}))?(?:\s+exclude=([^}]+))?\}$/.test(item);
}

function isGroupOption(item: string): boolean {
  const option = parseGroupOption(item);
  return Boolean(option);
}

function parseGroupOption(item: string): { key: string; value: string } | null {
  const match = item.match(/^([^=,{}]+)=(.*)$/s);
  if (!match) return null;
  const key = (match[1] ?? "").trim();
  if (!key) return null;
  return { key, value: (match[2] ?? "").trim() };
}

function isSubnetGroupType(type: string): boolean {
  return type === "subnet";
}

function isSubnetGroupOption(item: string, groupName: string): boolean {
  const option = parseGroupOption(item);
  if (!option) return false;
  const key = option.key;
  const value = option.value;
  if (!value || value === groupName) return false;
  return key.toLowerCase() === "default" || isSubnetConditionKey(key);
}

function isSubnetConditionKey(key: string): boolean {
  return /^(SSID|BSSID|ROUTER):.+$/i.test(key) || /^TYPE:(WIFI|WIRED|CELLULAR)$/i.test(key);
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

export function withInferredManagedBaseUrl(config: AppConfig, requestUrl: string): AppConfig {
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

export function validateManagedBaseUrl(config: { settings?: { managedBaseUrl?: unknown } }): string | null {
  const managedBaseUrl = typeof config.settings?.managedBaseUrl === "string"
    ? config.settings.managedBaseUrl.trim()
    : "";
  if (!managedBaseUrl) return "Managed base URL is required";

  try {
    const url = new URL(managedBaseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "Managed base URL must use http or https";
    const managedPath = normalizeManagedBasePath(url.pathname);
    if (managedPath === "/") return "Managed base URL path must not be root";
    if (RESERVED_MANAGED_BASE_PATHS.has(managedPath)) return `Managed base URL path ${managedPath} is reserved`;
  } catch {
    return "Managed base URL must be a valid URL";
  }

  return null;
}

function normalizeManagedBasePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed || "/";
}

async function loadStoredConfig(env: Env): Promise<AppConfig> {
  await ensureKvSchema(env);
  const [settings, groups, disabledGroups, sources, chain, surge, clash, updatedAt] = await Promise.all([
    loadSettings(env),
    loadGroups(env),
    loadDisabledGroups(env),
    loadSources(env),
    loadChain(env),
    loadSurge(env),
    loadClash(env),
    getJson<string>(env, CONFIG_UPDATED_AT_KEY)
  ]);

  return normalizeConfig({
    version: 1,
    settings: { ...DEFAULT_CONFIG.settings, ...settings },
    groups,
    disabledGroups,
    sources,
    chain,
    surge,
    clash,
    updatedAt
  });
}

async function unsealConfig(env: Env, config: AppConfig): Promise<AppConfig> {
  return {
    ...config,
    sources: await unsealSources(config.sources, getSecret(env, "CONFIG_ENCRYPTION_KEY"))
  };
}

async function loadSettings(env: Env): Promise<Partial<AppConfig["settings"]>> {
  const output: Partial<AppConfig["settings"]> = {};
  await Promise.all(SETTING_KEYS.map(async (key) => {
    const value = await getJson<unknown>(env, `${SETTINGS_PREFIX}${key}`);
    if (value !== undefined) (output as Record<string, unknown>)[key] = value;
  }));
  const telegramBotToken = await loadEncryptedSetting(env, TELEGRAM_BOT_TOKEN_KEY);
  if (telegramBotToken !== null) output.notificationTelegramBotToken = telegramBotToken;
  const telegramWebhookSecret = await loadEncryptedSetting(env, TELEGRAM_WEBHOOK_SECRET_KEY);
  if (telegramWebhookSecret !== null) output.notificationTelegramWebhookSecret = telegramWebhookSecret;
  return output;
}

async function saveSettings(env: Env, settings: AppConfig["settings"]): Promise<void> {
  const telegramBotToken = settings.notificationTelegramBotToken.trim();
  const telegramWebhookSecret = settings.notificationTelegramWebhookSecret.trim();
  await Promise.all([
    ...SETTING_KEYS.map((key) => putJson(env, `${SETTINGS_PREFIX}${key}`, settings[key])),
    telegramBotToken
      ? env.SUBPILOT_CONFIG.put(TELEGRAM_BOT_TOKEN_KEY, await encryptText(requireSecret(env, "CONFIG_ENCRYPTION_KEY"), telegramBotToken))
      : env.SUBPILOT_CONFIG.delete(TELEGRAM_BOT_TOKEN_KEY),
    telegramWebhookSecret
      ? env.SUBPILOT_CONFIG.put(TELEGRAM_WEBHOOK_SECRET_KEY, await encryptText(requireSecret(env, "CONFIG_ENCRYPTION_KEY"), telegramWebhookSecret))
      : env.SUBPILOT_CONFIG.delete(TELEGRAM_WEBHOOK_SECRET_KEY)
  ]);
}

async function loadEncryptedSetting(env: Env, key: string): Promise<string | null> {
  const stored = await env.SUBPILOT_CONFIG.get(key);
  if (!stored) return null;
  return decryptText(requireSecret(env, "CONFIG_ENCRYPTION_KEY"), stored);
}

async function loadGroups(env: Env): Promise<Record<string, string>> {
  const names = await getJson<string[]>(env, GROUP_INDEX_KEY);
  if (!names) return DEFAULT_CONFIG.groups;

  const entries = await Promise.all(names.map(async (name): Promise<[string, string] | null> => {
    const value = await env.SUBPILOT_CONFIG.get(`${GROUP_PREFIX}${encodeKey(name)}`);
    return value === null ? null : [name, value];
  }));
  return Object.fromEntries(entries.filter((entry): entry is [string, string] => entry !== null));
}

async function saveGroups(env: Env, groups: Record<string, string>): Promise<void> {
  const previous = await getJson<string[]>(env, GROUP_INDEX_KEY) ?? [];
  const names = Object.keys(groups);
  const nextKeys = new Set(names.map(encodeKey));
  await Promise.all([
    putJson(env, GROUP_INDEX_KEY, names),
    ...names.map((name) => env.SUBPILOT_CONFIG.put(`${GROUP_PREFIX}${encodeKey(name)}`, groups[name]!)),
    ...previous
      .filter((name) => !nextKeys.has(encodeKey(name)))
      .map((name) => env.SUBPILOT_CONFIG.delete(`${GROUP_PREFIX}${encodeKey(name)}`))
  ]);
}

async function loadDisabledGroups(env: Env): Promise<string[]> {
  return await getJson<string[]>(env, GROUP_DISABLED_KEY) ?? DEFAULT_CONFIG.disabledGroups;
}

async function saveDisabledGroups(env: Env, disabledGroups: string[]): Promise<void> {
  await putJson(env, GROUP_DISABLED_KEY, disabledGroups);
}

async function loadSources(env: Env): Promise<SourceConfig[]> {
  const ids = await getJson<string[]>(env, SOURCE_INDEX_KEY);
  if (!ids) return [];

  const sources = await Promise.all(ids.map((id) => getJson<SourceConfig>(env, `${SOURCE_PREFIX}${encodeKey(id)}`)));
  return sources.filter((source): source is SourceConfig => Boolean(source));
}

async function saveSources(env: Env, sources: SourceConfig[]): Promise<void> {
  const previous = await getJson<string[]>(env, SOURCE_INDEX_KEY) ?? [];
  const ids = sources.map((source) => source.id);
  const nextIds = new Set(ids);
  await Promise.all([
    putJson(env, SOURCE_INDEX_KEY, ids),
    ...sources.map((source) => putJson(env, `${SOURCE_PREFIX}${encodeKey(source.id)}`, source)),
    ...previous
      .filter((id) => !nextIds.has(id))
      .map((id) => env.SUBPILOT_CONFIG.delete(`${SOURCE_PREFIX}${encodeKey(id)}`))
  ]);
}

async function loadChain(env: Env): Promise<AppConfig["chain"]> {
  const [exitProxy, filter] = await Promise.all([
    getJson<unknown>(env, `${CHAIN_PREFIX}exitProxy`),
    getJson<unknown>(env, `${CHAIN_PREFIX}filter`)
  ]);
  return normalizeChain({ exitProxy, filter });
}

async function saveChain(env: Env, chain: AppConfig["chain"]): Promise<void> {
  await Promise.all([
    putJson(env, `${CHAIN_PREFIX}exitProxy`, chain.exitProxy),
    putJson(env, `${CHAIN_PREFIX}filter`, chain.filter)
  ]);
}

async function loadSurge(env: Env): Promise<AppConfig["surge"]> {
  const entries = await Promise.all(SURGE_KEYS.map(async (key): Promise<[keyof AppConfig["surge"], unknown]> => {
    const value = await getJson<unknown>(env, `${SURGE_PREFIX}${key}`);
    return [key, value ?? DEFAULT_CONFIG.surge[key]];
  }));
  return normalizeSurge(Object.fromEntries(entries) as Partial<AppConfig["surge"]>);
}

async function saveSurge(env: Env, surge: AppConfig["surge"]): Promise<void> {
  await Promise.all(SURGE_KEYS.map((key) => putJson(env, `${SURGE_PREFIX}${key}`, surge[key])));
}

async function loadClash(env: Env): Promise<AppConfig["clash"]> {
  const entries = await Promise.all(CLASH_KEYS.map(async (key): Promise<[keyof AppConfig["clash"], unknown]> => {
    const value = await getJson<unknown>(env, `${CLASH_PREFIX}${key}`);
    return [key, value ?? DEFAULT_CONFIG.clash[key]];
  }));
  return normalizeClash(Object.fromEntries(entries) as Partial<AppConfig["clash"]>);
}

async function saveClash(env: Env, clash: AppConfig["clash"]): Promise<void> {
  await Promise.all(CLASH_KEYS.map((key) => putJson(env, `${CLASH_PREFIX}${key}`, clash[key])));
}

async function getJson<T>(env: Env, key: string): Promise<T | undefined> {
  const value = await env.SUBPILOT_CONFIG.get(key);
  if (value === null) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function putJson(env: Env, key: string, value: unknown): Promise<void> {
  return env.SUBPILOT_CONFIG.put(key, JSON.stringify(value));
}

function encodeKey(value: string): string {
  return encodeURIComponent(value);
}

function normalizeSource(source: SourceConfig): SourceConfig {
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
  return value === "clash" ? value : "surge";
}

function normalizeSurge(input: Partial<AppConfig["surge"]> | undefined): AppConfig["surge"] {
  const surge = input ?? {};
  const urlRewrite = stringArray(surge.urlRewrite, DEFAULT_CONFIG.surge.urlRewrite);
  const mitm = normalizeSurgeMitm(surge.mitm);
  const inferredMitmHosts = inferUrlRewriteMitmHostnames(urlRewrite);
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
    encryptedDnsServer: stringArray(surge.encryptedDnsServer, DEFAULT_CONFIG.surge.encryptedDnsServer),
    wifiAssist: surge.wifiAssist === true,
    excludeSimpleHostnames: surge.excludeSimpleHostnames !== false,
    encryptedDnsFollowOutboundMode: surge.encryptedDnsFollowOutboundMode !== false,
    ponteDeviceNames: normalizePonteDeviceNames(surge.ponteDeviceNames),
    hosts: stringArray(surge.hosts, DEFAULT_CONFIG.surge.hosts),
    urlRewrite,
    scripts: stringArray(surge.scripts, DEFAULT_CONFIG.surge.scripts),
    mitm: {
      ...mitm,
      hostname: [...new Set([...mitm.hostname, ...inferredMitmHosts])]
    },
    rules: stringArray(surge.rules, DEFAULT_CONFIG.surge.rules)
  };
}

function normalizeSurgeMitm(input: Partial<AppConfig["surge"]["mitm"]> | undefined): AppConfig["surge"]["mitm"] {
  const mitm = input ?? {};
  return {
    skipServerCertVerify: mitm.skipServerCertVerify !== false,
    h2: mitm.h2 !== false,
    hostname: stringArray(mitm.hostname, DEFAULT_CONFIG.surge.mitm.hostname),
    caPassphrase: typeof mitm.caPassphrase === "string" ? mitm.caPassphrase.trim() : DEFAULT_CONFIG.surge.mitm.caPassphrase,
    caP12: typeof mitm.caP12 === "string" ? mitm.caP12.trim() : DEFAULT_CONFIG.surge.mitm.caP12
  };
}

function normalizePonteDeviceNames(value: unknown): string[] {
  if (!Array.isArray(value)) return DEFAULT_CONFIG.surge.ponteDeviceNames;
  return [...new Set(value
    .map((item) => String(item).trim().replace(/^DEVICE:/i, "").trim())
    .filter((item) => item && !/[,\r\n[\]]/.test(item)))];
}

function normalizeClash(input: Partial<AppConfig["clash"]> | undefined): AppConfig["clash"] {
  const clash = input ?? {};
  return {
    port: clampNumber(clash.port, 1, 65535, DEFAULT_CONFIG.clash.port),
    socksPort: clampNumber(clash.socksPort, 1, 65535, DEFAULT_CONFIG.clash.socksPort),
    mixedPort: clampNumber(clash.mixedPort, 1, 65535, DEFAULT_CONFIG.clash.mixedPort),
    allowLan: clash.allowLan === true,
    mode: stringValue(clash.mode, DEFAULT_CONFIG.clash.mode),
    logLevel: stringValue(clash.logLevel, DEFAULT_CONFIG.clash.logLevel),
    ipv6: clash.ipv6 !== false,
    unifiedDelay: clash.unifiedDelay !== false,
    tcpConcurrent: clash.tcpConcurrent !== false,
    externalController: stringValue(clash.externalController, DEFAULT_CONFIG.clash.externalController),
    tun: normalizeClashTun(clash.tun),
    dnsEnabled: clash.dnsEnabled !== false,
    dnsListen: stringValue(clash.dnsListen, DEFAULT_CONFIG.clash.dnsListen),
    dnsIpv6: clash.dnsIpv6 !== false,
    dnsEnhancedMode: normalizeClashDnsEnhancedMode(clash.dnsEnhancedMode),
    dnsFakeIpRange: stringValue(clash.dnsFakeIpRange, DEFAULT_CONFIG.clash.dnsFakeIpRange),
    defaultNameservers: stringArray(clash.defaultNameservers, DEFAULT_CONFIG.clash.defaultNameservers),
    nameservers: stringArray(clash.nameservers, DEFAULT_CONFIG.clash.nameservers),
    fallbackNameservers: stringArray(clash.fallbackNameservers, DEFAULT_CONFIG.clash.fallbackNameservers),
    fallbackFilterGeoip: clash.fallbackFilterGeoip !== false,
    fallbackFilterIpcidr: stringArray(clash.fallbackFilterIpcidr, DEFAULT_CONFIG.clash.fallbackFilterIpcidr),
    fakeIpFilter: stringArray(clash.fakeIpFilter, DEFAULT_CONFIG.clash.fakeIpFilter),
    ruleProviders: normalizeClashRuleProviders(clash.ruleProviders),
    rules: stringArray(clash.rules, DEFAULT_CONFIG.clash.rules)
  };
}

function normalizeClashTun(input: Partial<AppConfig["clash"]["tun"]> | undefined): AppConfig["clash"]["tun"] {
  const tun = input ?? {};
  return {
    enable: tun.enable !== false,
    stack: stringValue(tun.stack, DEFAULT_CONFIG.clash.tun.stack),
    autoRoute: tun.autoRoute !== false,
    autoDetectInterface: tun.autoDetectInterface !== false,
    skipProxy: stringArray(tun.skipProxy, DEFAULT_CONFIG.clash.tun.skipProxy)
  };
}

function normalizeClashDnsEnhancedMode(value: unknown): AppConfig["clash"]["dnsEnhancedMode"] {
  return value === "fake-ip" || value === "redir-host" ? value : DEFAULT_CONFIG.clash.dnsEnhancedMode;
}

function normalizeClashRuleProviders(input: unknown): AppConfig["clash"]["ruleProviders"] {
  if (input === undefined || input === null) return DEFAULT_CONFIG.clash.ruleProviders;
  return typeof input === "string" ? input.trimEnd() : DEFAULT_CONFIG.clash.ruleProviders;
}

function normalizeChain(input: { exitProxy?: unknown; filter?: unknown } | undefined): AppConfig["chain"] {
  const chain = input ?? {};
  return {
    exitProxy: normalizeExitProxy(chain.exitProxy, DEFAULT_CONFIG.chain.exitProxy),
    filter: filterArray(chain.filter, DEFAULT_CONFIG.chain.filter)
  };
}

function normalizeExitProxy(value: unknown, fallback: AppConfig["chain"]["exitProxy"]): AppConfig["chain"]["exitProxy"] {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    protocol: chainExitProtocol(record.protocol, fallback.protocol),
    server: typeof record.server === "string" ? record.server.trim() : fallback.server,
    port: clampNumber(record.port, 1, 65535, fallback.port),
    username: typeof record.username === "string" ? record.username.trim() : fallback.username,
    password: typeof record.password === "string" ? record.password.trim() : fallback.password
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
