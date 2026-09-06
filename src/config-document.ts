import { DEFAULT_CONFIG } from "./default-config";
import { parseGroupOption, splitGroupSpec } from "./policy-group-spec";
import { normalizeConfig, normalizeSurge, normalizeClash } from "./config-normalize";
import { convertSurgeToSingbox, defaultSingboxConfig } from "./singbox-config";
import type { AppConfig, ClientId, ClientRuleSettings, RenderConfig, SharedConfigDocument, StoredConfigDocument, Target } from "./types";

export const OUTPUT_TARGETS: Target[] = ["surge", "clash", "sing-box"];
export function clientId(target: Target): ClientId {
  return target === "sing-box" ? "singbox" : target;
}

export function migrateConfigDocument(input: RenderConfig): AppConfig {
  const legacy = normalizeConfig(input);
  const { sources, ...plan } = legacy.ruleSets;
  return splitSharedConfigDocument({
    version: 2,
    settings: currentSettings(legacy.settings),
    groups: legacy.groups,
    disabledGroups: legacy.disabledGroups,
    groupTargets: {},
    sources: legacy.sources.map((source) => ({ ...source, fetchUserAgent: resolveLegacyUserAgent(legacy, source.fetchUserAgent) })),
    proxyNodes: legacy.proxyNodes,
    chain: legacy.chain,
    ruleSources: sources,
    clients: {
      surge: { ...legacy.surge, ruleSets: structuredClone(plan) },
      clash: { ...legacy.clash, ruleSets: structuredClone(plan) },
      singbox: { ...convertSurgeToSingbox(legacy), ruleSets: structuredClone(plan) }
    },
    updatedAt: legacy.updatedAt
  });
}

export function defaultConfigDocument(): AppConfig {
  const doc = migrateConfigDocument(DEFAULT_CONFIG);
  doc.clients.singbox = { ...doc.clients.singbox, ...defaultSingboxConfig(), ruleSets: { mode: "manual", aggregateByPolicy: false, sources: [], outputs: [], directRules: [] } };
  return doc;
}

/** Copy shared version-2 resources once; each client owns its subsequent edits. */
function splitSharedConfigDocument(input: SharedConfigDocument): AppConfig {
  const clash = input.clients?.clash ?? input.clients?.mihomo;
  if (!input.clients?.surge || !clash || !input.clients?.singbox || !Array.isArray(input.ruleSources) || !Array.isArray(input.disabledGroups) || !input.groups || typeof input.groups !== "object" || Array.isArray(input.groups) || !input.groupTargets || typeof input.groupTargets !== "object" || Array.isArray(input.groupTargets)) throw new Error("旧版共享配置格式无效。");
  for (const targets of Object.values(input.groupTargets)) if (!Array.isArray(targets) || targets.some((target) => !OUTPUT_TARGETS.includes(target))) throw new Error("策略组包含无效的适用端。");
  // Shared hidden only affected Surge before the split; keep other clients visible.
  const resources = (target: Target, plan: SharedConfigDocument["clients"]["surge"]["ruleSets"]): ClientRuleSettings => {
    const groups = Object.fromEntries(Object.entries(input.groups).filter(([name]) => !input.groupTargets[name] || input.groupTargets[name]!.includes(target)).map(([name, spec]) => [name, target === "surge" ? String(spec).replace(/^\s*url-test\s*(?=,|$)/i, "smart") : splitGroupSpec(String(spec)).filter((part) => parseGroupOption(part)?.key.toLowerCase() !== "hidden").join(", ")]));
    return { groups, disabledGroups: input.disabledGroups.filter((name) => name in groups), ruleSets: structuredClone({ ...plan, sources: input.ruleSources }) };
  };
  const { groups: _, disabledGroups: __, groupTargets: ___, ruleSources: ____, clients: _____, ...shared } = input;
  return {
    ...shared, version: 3,
    clients: {
      surge: { ...structuredClone(input.clients.surge), ...resources("surge", input.clients.surge.ruleSets) },
      clash: { ...structuredClone(clash), ...resources("clash", clash.ruleSets) },
      singbox: { ...structuredClone(input.clients.singbox), ...resources("sing-box", input.clients.singbox.ruleSets) }
    }
  };
}

export function normalizeConfigDocument(stored: StoredConfigDocument): AppConfig {
  const input = stored.version === 2 ? splitSharedConfigDocument(stored) : stored;
  if (input.version !== 3 || !input.clients?.surge || !input.clients?.clash || !input.clients?.singbox) throw new Error("需要版本 3 配置，旧配置请使用迁移入口。");
  for (const key of ["sources", "proxyNodes"] as const) if (!Array.isArray(input[key])) throw new Error(`${key} 必须是数组。`);
  for (const key of ["settings", "chain"] as const) if (!input[key] || typeof input[key] !== "object" || Array.isArray(input[key])) throw new Error(`${key} 必须是对象。`);
  for (const client of Object.values(input.clients)) {
    if (!client.groups || typeof client.groups !== "object" || Array.isArray(client.groups) || !Array.isArray(client.disabledGroups)) throw new Error("客户端策略组格式无效。");
    if (client.disabledGroups.includes("Proxy")) throw new Error("Proxy 策略组不能禁用。");
    if (!client.ruleSets || !Array.isArray(client.ruleSets.sources) || !Array.isArray(client.ruleSets.outputs) || !Array.isArray(client.ruleSets.directRules)) throw new Error("客户端规则编排格式无效。");
  }
  const view = normalizeConfig({ ...DEFAULT_CONFIG, ...input, settings: { ...DEFAULT_CONFIG.settings, ...input.settings }, version: 1, groups: input.clients.surge.groups, disabledGroups: input.clients.surge.disabledGroups, surge: input.clients.surge, clash: input.clients.clash });
  if (view.proxyNodes.length !== input.proxyNodes.length) throw new Error("代理节点配置存在空项或无效内容。");
  const resources = (client: ClientRuleSettings): ClientRuleSettings => {
    const normalized = normalizeConfig({ ...view, groups: client.groups, disabledGroups: client.disabledGroups, ruleSets: client.ruleSets });
    return { groups: normalized.groups, disabledGroups: normalized.disabledGroups, ruleSets: normalized.ruleSets };
  };
  const singbox = input.clients.singbox;
  if (singbox.coreVersion !== "1.14.0" || !Array.isArray(singbox.inbounds)) throw new Error("无效的 sing-box 配置版本或入站配置。");
  for (const key of ["log", "dns", "route", "experimental"] as const) {
    if (!singbox[key] || typeof singbox[key] !== "object" || Array.isArray(singbox[key])) throw new Error(`sing-box ${key} 必须是对象。`);
  }
  for (const [path, items] of [["inbounds", singbox.inbounds], ["dns.servers", singbox.dns.servers], ["dns.rules", singbox.dns.rules], ["route.rules", singbox.route.rules], ["route.rule_set", singbox.route.rule_set]] as const) {
    if (items !== undefined && (!Array.isArray(items) || items.some((item) => !item || typeof item !== "object" || Array.isArray(item)))) throw new Error(`sing-box ${path} 必须是对象数组。`);
  }
  for (const key of ["outbounds", "endpoints", "certificate_providers", "http_clients", "network_namespaces", "services"] as const) {
    const items = singbox[key];
    if (items !== undefined && (!Array.isArray(items) || items.some((item) => !item || typeof item !== "object" || Array.isArray(item)))) throw new Error(`sing-box ${key} 必须是对象数组。`);
  }
  for (const key of ["ntp", "certificate"] as const) {
    const value = singbox[key];
    if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) throw new Error(`sing-box ${key} 必须是对象。`);
  }
  if (singbox.migrationIssues !== undefined && (!Array.isArray(singbox.migrationIssues) || singbox.migrationIssues.some((item) => !item || item.target !== "sing-box" || !["error", "warning"].includes(item.severity) || [item.path, item.code, item.message].some((value) => typeof value !== "string")))) throw new Error("sing-box 迁移诊断格式无效。");
  return {
    version: 3,
    settings: currentSettings(view.settings),
    sources: view.sources.map((source) => ({ ...source, fetchUserAgent: resolveLegacyUserAgent(view, source.fetchUserAgent) })),
    proxyNodes: view.proxyNodes, chain: view.chain,
    clients: {
      surge: { ...normalizeSurge(input.clients.surge), ...resources(input.clients.surge) },
      clash: { ...normalizeClash(input.clients.clash), ...resources(input.clients.clash) },
      singbox: { ...structuredClone(singbox), migrationIssues: Array.isArray(singbox.migrationIssues) ? singbox.migrationIssues : [], ...resources(singbox) }
    },
    updatedAt: input.updatedAt
  };
}

/** A transient projection for existing format-specific renderers. Never persisted. */
export function renderConfig(document: AppConfig, target: Target = "surge"): RenderConfig {
  const id = clientId(target);
  const client = document.clients[id];
  return {
    ...DEFAULT_CONFIG,
    version: 1,
    settings: { ...DEFAULT_CONFIG.settings, ...document.settings }, groups: client.groups, disabledGroups: client.disabledGroups,
    sources: document.sources, proxyNodes: document.proxyNodes, chain: document.chain,
    surge: document.clients.surge, clash: document.clients.clash,
    ruleSets: client.ruleSets,
    document, renderTarget: target, updatedAt: document.updatedAt
  };
}

export function configDocument(config: RenderConfig): AppConfig {
  const document = config.document ?? migrateConfigDocument(config);
  const id = clientId(config.renderTarget ?? "surge");
  return normalizeConfigDocument({
    ...document, settings: config.settings,
    clients: { ...document.clients, [id]: { ...document.clients[id], groups: config.groups, disabledGroups: config.disabledGroups, ruleSets: config.ruleSets } },
    sources: config.sources, proxyNodes: config.proxyNodes, chain: config.chain, updatedAt: config.updatedAt
  });
}

function resolveLegacyUserAgent(config: RenderConfig, value: string): string {
  const presets: Record<string, string> = { surge: config.settings.userAgentSurge, clash: config.settings.userAgentClash,
    stash: config.settings.userAgentStash, shadowrocket: config.settings.userAgentShadowrocket };
  return presets[value] || value || config.settings.userAgentSurge;
}

function currentSettings(settings: RenderConfig["settings"]): AppConfig["settings"] {
  const { userAgentStash: _, userAgentShadowrocket: __, ...current } = settings;
  return current;
}
