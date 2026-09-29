import { DEFAULT_CONFIG } from "./default-config";
import { migrateClashRouting } from "./clash-routing-migration";
import { normalizeConfig, normalizeSurge, normalizeClash, withDefaultConfigSettings } from "./config-normalize";
import { defaultSingboxConfig } from "./singbox-config";
import type { AppConfig, ClientId, ClientRuleSettings, RenderConfig, Target } from "./types";

export const OUTPUT_TARGETS: Target[] = ["surge", "clash", "sing-box"];
export function clientId(target: Target): ClientId {
  return target === "sing-box" ? "singbox" : target;
}

export class UnsupportedConfigError extends Error {}

export function defaultConfigDocument(): AppConfig {
  const defaults = structuredClone(DEFAULT_CONFIG);
  const doc: AppConfig = {
    version: 3,
    settings: defaults.settings,
    sources: [], proxyNodes: [],
    clients: {
      surge: { ...defaults.surge, groups: Object.fromEntries(Object.entries(defaults.groups).map(([name, spec]) => [name, spec.replace(/^url-test(?=,|$)/, "smart")])), disabledGroups: [], ruleSets: structuredClone(defaults.ruleSets) },
      clash: { ...defaults.clash, groups: structuredClone(defaults.groups), disabledGroups: [], ruleSets: structuredClone(defaults.ruleSets) },
      singbox: defaultSingboxConfig()
    },
    updatedAt: defaults.updatedAt
  };
  const clash = migrateClashRouting(doc.clients.clash);
  if (clash.issues.length) throw new Error("默认 Clash 分流配置无法转换。");
  doc.clients.clash = clash.client;
  doc.clients.clash.ruleSets.aggregateByPolicy = false;
  return doc;
}

export function normalizeConfigDocument(input: AppConfig): AppConfig {
  if (input?.version !== 3) throw new UnsupportedConfigError("仅支持版本 3 配置文档。");
  if (!input.clients?.surge || !input.clients?.clash || !input.clients?.singbox) throw new Error("客户端配置格式无效。");
  for (const key of ["sources", "proxyNodes"] as const) if (!Array.isArray(input[key])) throw new Error(`${key} 必须是数组。`);
  if (!input.settings || typeof input.settings !== "object" || Array.isArray(input.settings)) throw new Error("settings 必须是对象。");
  if (Object.hasOwn(input.settings, "singboxSrs") || input.settings.actionsCompilation && Object.hasOwn(input.settings.actionsCompilation, "workflow")) {
    throw new UnsupportedConfigError("不支持旧 Actions 配置字段，请使用当前 actionsCompilation 配置格式。");
  }
  if (input.sources.some((source) => source && Object.hasOwn(source, "urlEncrypted"))) throw new UnsupportedConfigError("不支持单独加密的旧订阅源字段。");
  if (input.proxyNodes.some((node) => node && typeof node.config !== "string")) throw new UnsupportedConfigError("代理节点必须使用当前 config 文本字段。");
  for (const client of Object.values(input.clients)) {
    if (!client.groups || typeof client.groups !== "object" || Array.isArray(client.groups) || !Array.isArray(client.disabledGroups)) throw new Error("客户端策略组格式无效。");
    if (client.disabledGroups.includes("Proxy")) throw new Error("Proxy 策略组不能禁用。");
    if (!client.ruleSets || !Array.isArray(client.ruleSets.sources) || !Array.isArray(client.ruleSets.outputs) || !Array.isArray(client.ruleSets.directRules)) throw new Error("客户端规则编排格式无效。");
  }
  const view = normalizeConfig({ ...DEFAULT_CONFIG, ...input, settings: withDefaultConfigSettings(input.settings), groups: input.clients.surge.groups, disabledGroups: input.clients.surge.disabledGroups, surge: input.clients.surge, clash: input.clients.clash });
  if (view.proxyNodes.length !== input.proxyNodes.length) throw new Error("代理节点配置存在空项或无效内容。");
  const resources = (client: ClientRuleSettings, allowPolicyAggregation = true): ClientRuleSettings => {
    const normalized = normalizeConfig({ ...view, groups: client.groups, disabledGroups: client.disabledGroups, ruleSets: client.ruleSets });
    return { groups: normalized.groups, disabledGroups: normalized.disabledGroups, ruleSets: { ...normalized.ruleSets, aggregateByPolicy: allowPolicyAggregation && normalized.ruleSets.aggregateByPolicy } };
  };
  const singbox = input.clients.singbox;
  if (singbox.coreVersion !== "1.15.0-alpha.8") throw new UnsupportedConfigError("仅支持 sing-box 1.15.0-alpha.8 配置。");
  if (!Array.isArray(singbox.inbounds)) throw new Error("sing-box 入站配置必须是数组。");
  if (Object.hasOwn(singbox, "migrationIssues") || singbox.inbounds.some((inbound) => inbound?.type === "tun" && Object.hasOwn(inbound, "stack"))) {
    throw new UnsupportedConfigError("sing-box 配置包含不再支持的 migrationIssues 或 TUN stack 字段。");
  }
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
  const normalizedSingbox = structuredClone(singbox);
  return {
    version: 3,
    settings: view.settings,
    sources: view.sources,
    proxyNodes: view.proxyNodes,
    clients: {
      surge: { ...normalizeSurge(input.clients.surge), ...resources(input.clients.surge) },
      clash: { ...normalizeClash(input.clients.clash), ...resources(input.clients.clash, false) },
      singbox: { ...normalizedSingbox, ...resources(singbox, false) }
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
    settings: withDefaultConfigSettings(document.settings), groups: client.groups, disabledGroups: client.disabledGroups,
    sources: document.sources, proxyNodes: document.proxyNodes,
    surge: document.clients.surge, clash: document.clients.clash,
    ruleSets: target === "surge" ? client.ruleSets : { ...client.ruleSets, aggregateByPolicy: false },
    document, renderTarget: target, updatedAt: document.updatedAt
  };
}

export function configDocument(config: RenderConfig): AppConfig {
  const document = config.document;
  if (!document) throw new Error("Configuration document is required");
  const id = clientId(config.renderTarget ?? "surge");
  return normalizeConfigDocument({
    ...document, settings: config.settings,
    clients: { ...document.clients, [id]: { ...document.clients[id], groups: config.groups, disabledGroups: config.disabledGroups, ruleSets: config.ruleSets } },
    sources: config.sources, proxyNodes: config.proxyNodes, updatedAt: config.updatedAt
  });
}
