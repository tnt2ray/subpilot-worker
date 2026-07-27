import { DEFAULT_CONFIG } from "./default-config";
import { ensureKvSchema } from "./config-schema";
import { normalizeChain, normalizeClash, normalizeConfig, normalizeRuleSets, normalizeStash, normalizeSurge } from "./config-normalize";
import { decryptText, encryptText, sealSources, unsealSources } from "./crypto-store";
import { pruneRuleSetCaches } from "./rule-set-cache";
import type { RuleSetConfig, RuleSetDirectRule, RuleSetOutput, RuleSetSource } from "./rule-set-types";
import { getSecret, requireSecret } from "./secrets";
import { pruneSourceCache } from "./source-cache";
import type { AppConfig, SourceConfig, StaticProxyNodeConfig } from "./types";
import { sha256Hex } from "./util";

export { inferManagedBaseUrl, normalizeConfig, normalizeTarget, withInferredManagedBaseUrl } from "./config-normalize";
export { validateManagedBaseUrl, validateProxyPolicyNameConflicts } from "./config-validation";

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
const PROXY_NODE_INDEX_KEY = "config:proxyNodes:index";
const PROXY_NODE_PREFIX = "config:proxyNodes:";
const CHAIN_PREFIX = "config:chain:";
const RULE_SET_MODE_KEY = "config:ruleSets:mode";
const RULE_SET_AGGREGATE_BY_POLICY_KEY = "config:ruleSets:aggregateByPolicy";
const RULE_SET_SOURCE_INDEX_KEY = "config:ruleSetSources:index";
const RULE_SET_SOURCE_PREFIX = "config:ruleSetSources:";
const RULE_SET_OUTPUT_INDEX_KEY = "config:ruleSetOutputs:index";
const RULE_SET_OUTPUT_PREFIX = "config:ruleSetOutputs:";
const RULE_SET_DIRECT_RULE_INDEX_KEY = "config:ruleSetDirectRules:index";
const RULE_SET_DIRECT_RULE_PREFIX = "config:ruleSetDirectRules:";
const SURGE_PREFIX = "config:surge:";
const CLASH_PREFIX = "config:clash:";
const STASH_PREFIX = "config:stash:";
const READ_TOKEN_KEY = "auth:read_token";

const SETTING_KEYS = [
  "managedBaseUrl",
  "userAgentSurge",
  "userAgentClash",
  "userAgentStash",
  "userAgentShadowrocket",
  "excludeKeywords",
  "geoipRenameEnabled",
  "featureTagRules",
  "updateCheckEnabled",
  "displayTimeZone",
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
  "tailscaleNodes",
  "hosts",
  "urlRewrite",
  "mapLocal",
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

const STASH_KEYS = [
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
  "dns",
  "ruleProviders",
  "rules",
  "hosts",
  "urlRewrite",
  "scripts",
  "mitm"
] as const satisfies readonly (keyof AppConfig["stash"])[];

export async function loadConfig(env: Env): Promise<AppConfig> {
  const config = await loadStoredConfig(env);
  return unsealConfig(env, config);
}

export async function saveConfig(env: Env, config: AppConfig): Promise<AppConfig> {
  await ensureKvSchema(env);
  const normalized = normalizeConfig({ ...config, updatedAt: new Date().toISOString() });
  const sealedSources = await sealSources(normalized.sources, requireSecret(env, "CONFIG_ENCRYPTION_KEY"));

  await Promise.all([
    putJson(env, CONFIG_UPDATED_AT_KEY, normalized.updatedAt),
    saveSettings(env, normalized.settings),
    saveGroups(env, normalized.groups),
    saveDisabledGroups(env, normalized.disabledGroups),
    saveSources(env, sealedSources),
    saveProxyNodes(env, normalized.proxyNodes),
    saveChain(env, normalized.chain),
    saveRuleSets(env, normalized.ruleSets),
    saveSurge(env, normalized.surge),
    saveClash(env, normalized.clash),
    saveStash(env, normalized.stash)
  ]);

  await Promise.all([
    pruneSourceCache(env, normalized),
    pruneRuleSetCaches(env, normalized)
  ]);

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

async function loadStoredConfig(env: Env): Promise<AppConfig> {
  await ensureKvSchema(env);
  const [settings, groups, disabledGroups, sources, proxyNodes, chain, ruleSets, surge, clash, stash, updatedAt] = await Promise.all([
    loadSettings(env),
    loadGroups(env),
    loadDisabledGroups(env),
    loadSources(env),
    loadProxyNodes(env),
    loadChain(env),
    loadRuleSets(env),
    loadSurge(env),
    loadClash(env),
    loadStash(env),
    getJson<string>(env, CONFIG_UPDATED_AT_KEY)
  ]);

  return normalizeConfig({
    version: 1,
    settings: { ...DEFAULT_CONFIG.settings, ...settings },
    groups,
    disabledGroups,
    sources,
    proxyNodes,
    chain,
    ruleSets,
    surge,
    clash,
    stash,
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

async function loadProxyNodes(env: Env): Promise<StaticProxyNodeConfig[]> {
  const ids = await getJson<string[]>(env, PROXY_NODE_INDEX_KEY);
  if (!ids) return DEFAULT_CONFIG.proxyNodes;

  const nodes = await Promise.all(ids.map((id) => getJson<StaticProxyNodeConfig>(env, `${PROXY_NODE_PREFIX}${encodeKey(id)}`)));
  return nodes.filter((node): node is StaticProxyNodeConfig => Boolean(node));
}

async function saveProxyNodes(env: Env, nodes: StaticProxyNodeConfig[]): Promise<void> {
  const previous = await getJson<string[]>(env, PROXY_NODE_INDEX_KEY) ?? [];
  const ids = nodes.map((node) => node.id);
  const nextIds = new Set(ids);
  await Promise.all([
    putJson(env, PROXY_NODE_INDEX_KEY, ids),
    ...nodes.map((node) => putJson(env, `${PROXY_NODE_PREFIX}${encodeKey(node.id)}`, node)),
    ...previous
      .filter((id) => !nextIds.has(id))
      .map((id) => env.SUBPILOT_CONFIG.delete(`${PROXY_NODE_PREFIX}${encodeKey(id)}`))
  ]);
}

async function loadChain(_env: Env): Promise<AppConfig["chain"]> {
  return normalizeChain(undefined);
}

async function saveChain(env: Env, _chain: AppConfig["chain"]): Promise<void> {
  await env.SUBPILOT_CONFIG.delete(`${CHAIN_PREFIX}filter`);
}

async function loadRuleSets(env: Env): Promise<RuleSetConfig> {
  const [mode, aggregateByPolicy, sources, outputs, directRules] = await Promise.all([
    getJson<unknown>(env, RULE_SET_MODE_KEY),
    getJson<unknown>(env, RULE_SET_AGGREGATE_BY_POLICY_KEY),
    loadRuleSetSources(env),
    loadRuleSetOutputs(env),
    loadRuleSetDirectRules(env)
  ]);
  return normalizeRuleSets({
    mode: mode === "compiled" ? "compiled" : "manual",
    aggregateByPolicy: aggregateByPolicy === true,
    sources,
    outputs,
    directRules
  });
}

async function saveRuleSets(env: Env, ruleSets: RuleSetConfig): Promise<void> {
  await Promise.all([
    putJson(env, RULE_SET_MODE_KEY, ruleSets.mode),
    putJson(env, RULE_SET_AGGREGATE_BY_POLICY_KEY, ruleSets.aggregateByPolicy),
    saveRuleSetSources(env, ruleSets.sources),
    saveRuleSetOutputs(env, ruleSets.outputs),
    saveRuleSetDirectRules(env, ruleSets.directRules)
  ]);
}

async function loadRuleSetSources(env: Env): Promise<RuleSetSource[]> {
  const ids = await getJson<string[]>(env, RULE_SET_SOURCE_INDEX_KEY);
  if (!ids) return DEFAULT_CONFIG.ruleSets.sources;

  const sources = await Promise.all(ids.map((id) => getJson<RuleSetSource>(env, `${RULE_SET_SOURCE_PREFIX}${encodeKey(id)}`)));
  return sources.filter((source): source is RuleSetSource => Boolean(source));
}

async function saveRuleSetSources(env: Env, sources: RuleSetSource[]): Promise<void> {
  const previous = await getJson<string[]>(env, RULE_SET_SOURCE_INDEX_KEY) ?? [];
  const ids = sources.map((source) => source.id);
  const nextIds = new Set(ids);
  await Promise.all([
    putJson(env, RULE_SET_SOURCE_INDEX_KEY, ids),
    ...sources.map((source) => putJson(env, `${RULE_SET_SOURCE_PREFIX}${encodeKey(source.id)}`, source)),
    ...previous
      .filter((id) => !nextIds.has(id))
      .map((id) => env.SUBPILOT_CONFIG.delete(`${RULE_SET_SOURCE_PREFIX}${encodeKey(id)}`))
  ]);
}

async function loadRuleSetOutputs(env: Env): Promise<RuleSetOutput[]> {
  const names = await getJson<string[]>(env, RULE_SET_OUTPUT_INDEX_KEY);
  if (!names) return DEFAULT_CONFIG.ruleSets.outputs;

  const outputs = await Promise.all(names.map((name) => getJson<RuleSetOutput>(env, `${RULE_SET_OUTPUT_PREFIX}${encodeKey(name)}`)));
  return outputs.filter((output): output is RuleSetOutput => Boolean(output));
}

async function saveRuleSetOutputs(env: Env, outputs: RuleSetOutput[]): Promise<void> {
  const previous = await getJson<string[]>(env, RULE_SET_OUTPUT_INDEX_KEY) ?? [];
  const names = outputs.map((output) => output.name);
  const nextNames = new Set(names);
  await Promise.all([
    putJson(env, RULE_SET_OUTPUT_INDEX_KEY, names),
    ...outputs.map((output) => putJson(env, `${RULE_SET_OUTPUT_PREFIX}${encodeKey(output.name)}`, output)),
    ...previous
      .filter((name) => !nextNames.has(name))
      .map((name) => env.SUBPILOT_CONFIG.delete(`${RULE_SET_OUTPUT_PREFIX}${encodeKey(name)}`))
  ]);
}

async function loadRuleSetDirectRules(env: Env): Promise<RuleSetDirectRule[]> {
  const ids = await getJson<string[]>(env, RULE_SET_DIRECT_RULE_INDEX_KEY);
  if (!ids) return DEFAULT_CONFIG.ruleSets.directRules;

  const rules = await Promise.all(ids.map((id) => getJson<RuleSetDirectRule>(env, `${RULE_SET_DIRECT_RULE_PREFIX}${encodeKey(id)}`)));
  return rules.filter((rule): rule is RuleSetDirectRule => Boolean(rule));
}

async function saveRuleSetDirectRules(env: Env, rules: RuleSetDirectRule[]): Promise<void> {
  const previous = await getJson<string[]>(env, RULE_SET_DIRECT_RULE_INDEX_KEY) ?? [];
  const ids = rules.map((rule) => rule.id);
  const nextIds = new Set(ids);
  await Promise.all([
    putJson(env, RULE_SET_DIRECT_RULE_INDEX_KEY, ids),
    ...rules.map((rule) => putJson(env, `${RULE_SET_DIRECT_RULE_PREFIX}${encodeKey(rule.id)}`, rule)),
    ...previous
      .filter((id) => !nextIds.has(id))
      .map((id) => env.SUBPILOT_CONFIG.delete(`${RULE_SET_DIRECT_RULE_PREFIX}${encodeKey(id)}`))
  ]);
}

async function loadSurge(env: Env): Promise<AppConfig["surge"]> {
  return loadConfigSection(env, SURGE_PREFIX, SURGE_KEYS, DEFAULT_CONFIG.surge, normalizeSurge);
}

async function saveSurge(env: Env, surge: AppConfig["surge"]): Promise<void> {
  await saveConfigSection(env, SURGE_PREFIX, SURGE_KEYS, surge);
}

async function loadClash(env: Env): Promise<AppConfig["clash"]> {
  return loadConfigSection(env, CLASH_PREFIX, CLASH_KEYS, DEFAULT_CONFIG.clash, normalizeClash);
}

async function saveClash(env: Env, clash: AppConfig["clash"]): Promise<void> {
  await saveConfigSection(env, CLASH_PREFIX, CLASH_KEYS, clash);
}

async function loadStash(env: Env): Promise<AppConfig["stash"]> {
  return loadConfigSection(env, STASH_PREFIX, STASH_KEYS, DEFAULT_CONFIG.stash, normalizeStash);
}

async function saveStash(env: Env, stash: AppConfig["stash"]): Promise<void> {
  await saveConfigSection(env, STASH_PREFIX, STASH_KEYS, stash);
}

async function loadConfigSection<T extends object, K extends keyof T>(
  env: Env,
  prefix: string,
  keys: readonly K[],
  defaults: T,
  normalize: (input: Partial<T>) => T
): Promise<T> {
  const entries = await Promise.all(keys.map(async (key): Promise<[K, unknown]> => {
    const value = await getJson<unknown>(env, `${prefix}${String(key)}`);
    return [key, value ?? defaults[key]];
  }));
  return normalize(Object.fromEntries(entries) as Partial<T>);
}

async function saveConfigSection<T extends object, K extends keyof T>(
  env: Env,
  prefix: string,
  keys: readonly K[],
  value: T
): Promise<void> {
  await Promise.all(keys.map((key) => putJson(env, `${prefix}${String(key)}`, value[key])));
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
