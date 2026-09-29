import { ACTIONS_WORKFLOW_FILENAME } from "./actions-compiler-artifacts";
import { normalizeConfigDocument, UnsupportedConfigError } from "./config-document";
import { validateDocumentForSave } from "./config-document-validation";
import { DEFAULT_CONFIG } from "./default-config";
import type { AppConfig } from "./types";

type DocumentRecord = Record<string, unknown>;

function record(value: unknown, path: string): DocumentRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new UnsupportedConfigError(`${path} 必须是配置对象。`);
  }
  return value as DocumentRecord;
}

function knownFields(value: DocumentRecord, fields: readonly string[], path: string): void {
  if (Object.keys(value).some((key) => !fields.includes(key))) {
    throw new UnsupportedConfigError(`${path} 含无法无损迁移的字段，请先在旧版本修正。`);
  }
}

function optionalType(value: DocumentRecord, key: string, type: "string" | "boolean", path: string): void {
  if (Object.hasOwn(value, key) && typeof value[key] !== type) {
    throw new UnsupportedConfigError(`${path}.${key} 的类型无效，请先在旧版本修正。`);
  }
}

function stringList(value: unknown, path: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new UnsupportedConfigError(`${path} 必须是字符串数组。`);
  }
}

function migrateActions(settings: DocumentRecord, changes: string[]): void {
  // v2.3.3 already gave the current field precedence, including enabled: false.
  if (Object.hasOwn(settings, "singboxSrs")) {
    if (!Object.hasOwn(settings, "actionsCompilation")) settings.actionsCompilation = settings.singboxSrs;
    delete settings.singboxSrs;
    changes.push("将旧 Actions 设置归入 settings.actionsCompilation。");
  }
  if (!Object.hasOwn(settings, "actionsCompilation")) return;
  const actions = record(settings.actionsCompilation, "settings.actionsCompilation");
  knownFields(actions, ["enabled", "repository", "ref", "workflow"], "settings.actionsCompilation");
  optionalType(actions, "enabled", "boolean", "settings.actionsCompilation");
  for (const key of ["repository", "ref", "workflow"]) optionalType(actions, key, "string", "settings.actionsCompilation");
  if (Object.hasOwn(actions, "workflow")) {
    const workflow = (actions.workflow as string).trim();
    if (workflow && workflow !== ACTIONS_WORKFLOW_FILENAME) {
      throw new UnsupportedConfigError("settings.actionsCompilation.workflow 使用自定义工作流，请先在旧版本完成工作流迁移。");
    }
    delete actions.workflow;
    changes.push("移除已固定名称的 settings.actionsCompilation.workflow 字段。");
  }
}

function migrateSources(input: unknown, settings: DocumentRecord, legacy: boolean, changes: string[]): void {
  if (!Array.isArray(input)) throw new UnsupportedConfigError("sources 必须是数组。");
  const presets: Record<string, string> = {
    surge: settings.userAgentSurge as string || DEFAULT_CONFIG.settings.userAgentSurge,
    clash: settings.userAgentClash as string || DEFAULT_CONFIG.settings.userAgentClash,
    stash: settings.userAgentStash as string || "Stash/2.7.1",
    shadowrocket: settings.userAgentShadowrocket as string || "Shadowrocket/2.2.68"
  };
  for (let index = 0; index < input.length; index++) {
    const path = `sources.${index}`;
    const source = record(input[index], path);
    // The storage layer must decrypt these with the original key first.
    if (Object.hasOwn(source, "urlEncrypted")) {
      throw new UnsupportedConfigError(`${path}.urlEncrypted 尚未解密，不能迁移。`);
    }
    knownFields(source, ["id", "name", "url", "fetchUserAgent", "enabled"], path);
    for (const key of ["id", "name", "url"]) {
      if (typeof source[key] !== "string" || key === "id" && !source[key]) {
        throw new UnsupportedConfigError(`${path}.${key} 无效，请先在旧版本修正。`);
      }
    }
    optionalType(source, "fetchUserAgent", "string", path);
    optionalType(source, "enabled", "boolean", path);
    if (!legacy) continue;
    const original = source.fetchUserAgent;
    const userAgent = typeof original === "string" ? original.trim() : "";
    // Empty values became the "surge" preset before v2.3.3 resolved them.
    const resolved = userAgent && Object.hasOwn(presets, userAgent)
      ? presets[userAgent]!
      : userAgent || presets.surge!;
    if (resolved !== original) {
      source.fetchUserAgent = resolved;
      changes.push(`${path}.fetchUserAgent 转换为旧版本实际使用的请求标识。`);
    }
  }
}

function migrateProxyNodes(input: unknown, changes: string[]): void {
  if (!Array.isArray(input)) throw new UnsupportedConfigError("proxyNodes 必须是数组。");
  const retired = ["name", "protocol", "server", "port", "username", "password"];
  for (let index = 0; index < input.length; index++) {
    const path = `proxyNodes.${index}`;
    const node = record(input[index], path);
    knownFields(node, ["id", "config", "chainFilter", "enabled", "chainExit", "includeInGroups", ...retired], path);
    if (typeof node.config !== "string" || !node.config.trim()) {
      throw new UnsupportedConfigError(`${path}.config 缺失或为空；不支持猜测旧离散节点字段，请先在旧版本保存节点。`);
    }
    if (typeof node.id !== "string" || !node.id.trim()) {
      throw new UnsupportedConfigError(`${path}.id 无效，请先在旧版本修正。`);
    }
    if (Object.hasOwn(node, "chainFilter")) stringList(node.chainFilter, `${path}.chainFilter`);
    for (const key of ["enabled", "chainExit", "includeInGroups"]) optionalType(node, key, "boolean", path);
    // A nonempty config took precedence over all discrete fields in v2.3.3.
    if (retired.some((key) => Object.hasOwn(node, key))) {
      for (const key of retired) delete node[key];
      changes.push(`${path} 移除已被 config 文本取代的旧离散字段。`);
    }
  }
}

/** Explicit, local conversion of a saved v2.3.3 snapshot, never a runtime fallback. */
export function migrateV233Document(input: unknown): { document: AppConfig; changes: string[] } {
  const original = record(input, "配置文档");
  if (original.version !== 3) throw new UnsupportedConfigError("此工具仅迁移已保存的版本 3 配置文档，不支持更旧文档。");
  let candidate: DocumentRecord;
  try { candidate = structuredClone(original); }
  catch { throw new UnsupportedConfigError("配置文档无法读取，请先在旧版本修正。"); }
  knownFields(candidate, ["version", "settings", "sources", "proxyNodes", "clients", "updatedAt", "chain"], "配置文档");
  const settings = record(candidate.settings, "settings");
  const clients = record(candidate.clients, "clients");
  knownFields(clients, ["surge", "clash", "singbox"], "clients");
  for (const key of ["surge", "clash", "singbox"]) record(clients[key], `clients.${key}`);
  const singbox = record(clients.singbox, "clients.singbox");
  if (singbox.coreVersion !== "1.15.0-alpha.6" && singbox.coreVersion !== "1.15.0-alpha.8") {
    throw new UnsupportedConfigError("此工具仅支持 sing-box 1.15.0-alpha.6 或 1.15.0-alpha.8 的已保存配置。");
  }
  const legacy = singbox.coreVersion === "1.15.0-alpha.6" || Object.hasOwn(candidate, "chain")
    || ["singboxSrs", "userAgentStash", "userAgentShadowrocket"].some((key) => Object.hasOwn(settings, key));
  const changes: string[] = [];
  knownFields(settings, [...Object.keys(DEFAULT_CONFIG.settings), "singboxSrs", "userAgentStash", "userAgentShadowrocket"], "settings");
  for (const [key, fallback] of Object.entries(DEFAULT_CONFIG.settings)) {
    if (!Object.hasOwn(settings, key) || key === "actionsCompilation") continue;
    const fallbackType = typeof fallback;
    if (fallbackType === "string" || fallbackType === "boolean") optionalType(settings, key, fallbackType, "settings");
    else if (Array.isArray(fallback)) stringList(settings[key], `settings.${key}`);
  }
  for (const key of ["userAgentStash", "userAgentShadowrocket"]) optionalType(settings, key, "string", "settings");
  migrateActions(settings, changes);
  migrateSources(candidate.sources, settings, legacy, changes);
  for (const key of ["userAgentStash", "userAgentShadowrocket"]) {
    if (!Object.hasOwn(settings, key)) continue;
    delete settings[key];
    changes.push(`移除已展开为订阅请求标识的 settings.${key} 字段。`);
  }
  if (Object.hasOwn(candidate, "chain")) {
    const chain = record(candidate.chain, "chain");
    knownFields(chain, ["filter"], "chain");
    if (Object.hasOwn(chain, "filter") && (!Array.isArray(chain.filter) || chain.filter.length !== 0)) {
      throw new UnsupportedConfigError("chain.filter 非空或格式无效，请先在旧版本保存并确认链式代理配置。");
    }
    // Saved v2.3.3 documents always normalized this retired section to { filter: [] }.
    delete candidate.chain;
    changes.push("移除已停用的空 chain 配置。");
  }
  migrateProxyNodes(candidate.proxyNodes, changes);
  if (singbox.coreVersion === "1.15.0-alpha.6") {
    singbox.coreVersion = "1.15.0-alpha.8";
    changes.push("将 sing-box 配置版本更新为 1.15.0-alpha.8。");
  }
  if (Object.hasOwn(singbox, "migrationIssues")) {
    delete singbox.migrationIssues;
    changes.push("移除已停用的 sing-box migrationIssues 诊断字段。");
  }
  if (!Array.isArray(singbox.inbounds)) throw new UnsupportedConfigError("clients.singbox.inbounds 必须是数组。");
  for (let index = 0; index < singbox.inbounds.length; index++) {
    const inbound = record(singbox.inbounds[index], `clients.singbox.inbounds.${index}`);
    if (inbound.type !== "tun" || !Object.hasOwn(inbound, "stack")) continue;
    // v2.3.3 removed this field before rendering too; this preserves that behavior.
    delete inbound.stack;
    changes.push(`移除 clients.singbox.inbounds.${index}.stack，继续使用内核默认网络栈。`);
  }
  // Keep native DNS/route ordering, explicit false, and HTTP version omission intact.
  let document: AppConfig;
  try { document = normalizeConfigDocument(candidate as unknown as AppConfig); }
  catch { throw new UnsupportedConfigError("配置无法按当前文档规范验证，请先在旧版本修正。"); }
  if (validateDocumentForSave(document)) {
    throw new UnsupportedConfigError("配置不符合当前保存校验，请先在旧版本修正。");
  }
  try {
    if (JSON.stringify(document) !== JSON.stringify(candidate)) changes.push("按当前配置文档规范整理字段。");
  } catch { throw new UnsupportedConfigError("配置文档无法序列化，请先在旧版本修正。"); }
  return { document, changes };
}
