import { DEFAULT_CONFIG } from "./default-config";
import { normalizeConfig, normalizeRuleSets, normalizeSurge, normalizeClash } from "./config-normalize";
import { convertSurgeToSingbox, defaultSingboxConfig } from "./singbox-config";
import type { AppConfig, ClientId, RenderConfig, Target } from "./types";

export const OUTPUT_TARGETS: Target[] = ["surge", "clash", "sing-box"];
export function clientId(target: Target): ClientId {
  return target === "clash" ? "mihomo" : target === "sing-box" ? "singbox" : "surge";
}

export function migrateConfigDocument(input: RenderConfig): AppConfig {
  const legacy = normalizeConfig(input);
  const { sources, ...plan } = legacy.ruleSets;
  return {
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
      mihomo: { ...legacy.clash, ruleSets: structuredClone(plan) },
      singbox: { ...convertSurgeToSingbox(legacy), ruleSets: structuredClone(plan) }
    },
    updatedAt: legacy.updatedAt
  };
}

export function defaultConfigDocument(): AppConfig {
  const doc = migrateConfigDocument(DEFAULT_CONFIG);
  doc.clients.singbox = { ...defaultSingboxConfig(), ruleSets: { mode: "manual", aggregateByPolicy: false, outputs: [], directRules: [] } };
  return doc;
}

export function normalizeConfigDocument(input: AppConfig): AppConfig {
  if (input.version !== 2 || !input.clients?.surge || !input.clients?.mihomo || !input.clients?.singbox) {
    throw new Error("需要版本 2 配置，旧配置请使用迁移入口。");
  }
  for (const key of ["sources", "proxyNodes", "ruleSources", "disabledGroups"] as const) if (!Array.isArray(input[key])) throw new Error(`${key} 必须是数组。`);
  for (const key of ["settings", "groups", "groupTargets", "chain"] as const) if (!input[key] || typeof input[key] !== "object" || Array.isArray(input[key])) throw new Error(`${key} 必须是对象。`);
  if (input.disabledGroups.includes("Proxy")) throw new Error("Proxy 策略组不能禁用。");
  for (const targets of Object.values(input.groupTargets)) if (!Array.isArray(targets) || targets.some((target) => !OUTPUT_TARGETS.includes(target))) throw new Error("策略组包含无效的适用端。");
  for (const client of Object.values(input.clients)) {
    if (!client.ruleSets || !Array.isArray(client.ruleSets.outputs) || !Array.isArray(client.ruleSets.directRules)) throw new Error("客户端规则编排格式无效。");
  }
  const view = normalizeConfig({ ...DEFAULT_CONFIG, ...input, settings: { ...DEFAULT_CONFIG.settings, ...input.settings }, version: 1, surge: input.clients.surge, clash: input.clients.mihomo });
  if (view.proxyNodes.length !== input.proxyNodes.length) throw new Error("代理节点配置存在空项或无效内容。");
  const normalizePlan = (value: AppConfig["clients"]["surge"]["ruleSets"]) => {
    const { sources: _, ...plan } = normalizeRuleSets(value);
    return plan;
  };
  const singbox = input.clients.singbox;
  if (singbox.coreVersion !== "1.14.0" || !Array.isArray(singbox.inbounds)) throw new Error("无效的 sing-box 配置版本或入站配置。");
  for (const key of ["log", "dns", "route", "experimental"] as const) {
    if (!singbox[key] || typeof singbox[key] !== "object" || Array.isArray(singbox[key])) throw new Error(`sing-box ${key} 必须是对象。`);
  }
  for (const [path, items] of [["inbounds", singbox.inbounds], ["dns.servers", singbox.dns.servers], ["dns.rules", singbox.dns.rules], ["route.rules", singbox.route.rules], ["route.rule_set", singbox.route.rule_set]] as const) {
    if (items !== undefined && (!Array.isArray(items) || items.some((item) => !item || typeof item !== "object" || Array.isArray(item)))) throw new Error(`sing-box ${path} 必须是对象数组。`);
  }
  if (singbox.migrationIssues !== undefined && (!Array.isArray(singbox.migrationIssues) || singbox.migrationIssues.some((item) => !item || item.target !== "sing-box" || !["error", "warning"].includes(item.severity) || [item.path, item.code, item.message].some((value) => typeof value !== "string")))) throw new Error("sing-box 迁移诊断格式无效。");
  return {
    version: 2,
    settings: currentSettings(view.settings),
    groups: view.groups, disabledGroups: view.disabledGroups,
    groupTargets: Object.fromEntries(Object.entries(input.groupTargets ?? {}).filter(([name]) => name in view.groups).map(([name, targets]) => [name, Array.isArray(targets) ? targets.filter((target) => OUTPUT_TARGETS.includes(target)) : OUTPUT_TARGETS])),
    sources: view.sources.map((source) => ({ ...source, fetchUserAgent: resolveLegacyUserAgent(view, source.fetchUserAgent) })),
    proxyNodes: view.proxyNodes, chain: view.chain,
    ruleSources: normalizeRuleSets({ sources: input.ruleSources }).sources,
    clients: {
      surge: { ...normalizeSurge(input.clients.surge), ruleSets: normalizePlan(input.clients.surge.ruleSets) },
      mihomo: { ...normalizeClash(input.clients.mihomo), ruleSets: normalizePlan(input.clients.mihomo.ruleSets) },
      singbox: { ...structuredClone(singbox), migrationIssues: Array.isArray(singbox.migrationIssues) ? singbox.migrationIssues : [], ruleSets: normalizePlan(singbox.ruleSets) }
    },
    updatedAt: input.updatedAt
  };
}

/** A transient projection for existing format-specific renderers. Never persisted. */
export function renderConfig(document: AppConfig, target: Target = "surge"): RenderConfig {
  const id = clientId(target);
  return {
    ...DEFAULT_CONFIG,
    version: 1,
    settings: { ...DEFAULT_CONFIG.settings, ...document.settings }, groups: document.groups, disabledGroups: document.disabledGroups,
    groupTargets: document.groupTargets,
    sources: document.sources, proxyNodes: document.proxyNodes, chain: document.chain,
    surge: document.clients.surge, clash: document.clients.mihomo,
    ruleSets: { ...document.clients[id].ruleSets, sources: document.ruleSources },
    document, renderTarget: target, updatedAt: document.updatedAt
  };
}

export function configDocument(config: RenderConfig): AppConfig {
  const document = config.document ?? migrateConfigDocument(config);
  return normalizeConfigDocument({
    ...document, settings: config.settings, groups: config.groups, disabledGroups: config.disabledGroups,
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
