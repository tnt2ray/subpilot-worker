import { parseInlineRuleSetLines } from "./rule-set-parser";
import { isNativeClashDirectRule } from "./rule-targets";
import { normalizeManagedBasePath, ruleSetPathName } from "./managed-url";
import { isValidSingboxOutbound } from "./singbox-validation";
import { isIPv4, isIPv6, isProxyNodeSupportedForTarget } from "./node-transforms";
import { parseConfiguredProxyNode } from "./parsers";
import { parseAllPolicySelector, parseGroupOption, splitGroupSpec, validatePolicyPriority } from "./policy-group-spec";
import { effectiveRuleSetOutputs } from "./rule-set-outputs";
import { compiledRuleProviderName } from "./rule-provider-name";
import { splitRuleLine } from "./rule-line";
import {
  CLASH_BUILT_IN_RULE_POLICIES,
  isRulePolicyCompatibleWithTarget,
  STASH_BUILT_IN_RULE_POLICIES,
  SURGE_BUILT_IN_RULE_POLICIES
} from "./rule-targets";
import { RULE_SET_TARGETS, type RuleSetDownloadBucket } from "./rule-set-types";
import type { RenderConfig } from "./types";

const RESERVED_MANAGED_BASE_PATHS = new Set([
  "/api",
  "/app-constants.js",
  "/app-i18n.js",
  "/app-policy-group-spec.js",
  "/app-preview-warnings.js",
  "/app-validation.js",
  "/app-proxy-node-drafts.js",
  "/app-yaml.js",
  "/app.js",
  "/app-model.js",
  "/singbox-ui.js",
  "/tailscale-ui.js",
  "/index.html",
  "/login.html",
  "/mitm-ca.js",
  "/styles.css"
]);

const ALL_BUILT_IN_POLICIES = new Set([
  ...SURGE_BUILT_IN_RULE_POLICIES,
  ...CLASH_BUILT_IN_RULE_POLICIES,
  ...STASH_BUILT_IN_RULE_POLICIES
]);
const MAX_COUNTS = {
  sources: 20,
  proxyNodes: 500,
  groups: 100,
  tailscaleNodes: 100,
  ruleSetOutputs: 40,
  directRules: 2_000,
  targetRules: 10_000
} as const;
const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 256;
const MAX_URL_LENGTH = 8_192;
const MAX_RULE_LENGTH = 16_384;
const MAX_GROUP_SPEC_LENGTH = 32_768;
const MAX_PROXY_CONFIG_LENGTH = 32_768;
const MAX_RULE_PROVIDERS_LENGTH = 512 * 1024;
const MAX_GENERAL_LIST_ITEMS = 2_000;
const MAX_REFERENCE_LIST_ITEMS = 500;
const MAX_INLINE_RULES_PER_OUTPUT = 10_000;
const POLICY_GROUP_TYPES = new Set(["select", "url-test", "fallback", "load-balance", "smart", "subnet"]);
const RESERVED_CLASH_GROUP_OPTION_KEYS = new Set(["name", "type", "proxies"]);
const COMPILED_SURGE_OPTIONS = new Set(["no-resolve", "extended-matching"]);

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
    if (managedPath === "/api" || managedPath.startsWith("/api/")) return `Managed base URL path ${managedPath} is reserved`;
    if (managedPath === "/vendor" || managedPath.startsWith("/vendor/")) return `Managed base URL path ${managedPath} is reserved`;
    if (RESERVED_MANAGED_BASE_PATHS.has(managedPath)) return `Managed base URL path ${managedPath} is reserved`;
  } catch {
    return "Managed base URL must be a valid URL";
  }

  return null;
}

export function validateActionsCompilationSettings(value: RenderConfig["settings"]["actionsCompilation"]): string | null {
  if (!value?.enabled) return null;
  if (typeof value.repository !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/.test(value.repository)
    || [".", ".."].includes(value.repository.split("/")[1]!)) {
    return "Actions 规则编译的 GitHub 仓库必须填写 owner/repo。";
  }
  if (typeof value.ref !== "string" || !value.ref || value.ref.length > 255 || value.ref === "@" || value.ref.startsWith("-")
    || /[\s\u0000-\u001f\u007f~^:?*\[\\]/.test(value.ref) || value.ref.includes("..") || value.ref.includes("@{")
    || value.ref.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))) {
    return "Actions 规则编译的 GitHub 分支或标签无效。";
  }
  if (typeof value.workflow !== "string" || value.workflow.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/.test(value.workflow)) {
    return "Actions 规则编译的工作流必须是 .yml 或 .yaml 文件名，不能包含路径。";
  }
  if (["rules", "refs/heads/rules"].includes(value.ref)) {
    return "工作流分支不能使用固定产物分支 rules。";
  }
  return null;
}

export function validateConfigEntityLimits(config: RenderConfig, options: { allowUnresolvedPolicies?: boolean } = {}): string | null {
  if (!config.settings || typeof config.settings !== "object") return "基础设置格式无效";
  const actionsError = validateActionsCompilationSettings(config.settings.actionsCompilation);
  if (actionsError) return actionsError;
  if (!config.groups || typeof config.groups !== "object" || Array.isArray(config.groups)) return "策略组配置格式无效";
  if (!Array.isArray(config.disabledGroups)) return "禁用策略组配置格式无效";
  if (!Array.isArray(config.sources)) return "订阅源配置格式无效";
  if (!Array.isArray(config.proxyNodes)) return "静态节点配置格式无效";
  if (!config.chain || typeof config.chain !== "object") return "链式代理配置格式无效";
  if (!config.ruleSets || typeof config.ruleSets !== "object") return "规则集配置格式无效";
  if (!Array.isArray(config.ruleSets.sources) || !Array.isArray(config.ruleSets.outputs) || !Array.isArray(config.ruleSets.directRules)) {
    return "规则集实体配置格式无效";
  }
  if (!config.surge || !Array.isArray(config.surge.rules) || !Array.isArray(config.surge.tailscaleNodes)) return "Surge 配置格式无效";
  if (!config.surge.mitm || typeof config.surge.mitm !== "object") return "Surge MITM 配置格式无效";
  if (!config.clash || !Array.isArray(config.clash.rules) || !config.clash.tun || typeof config.clash.tun !== "object") return "Clash 配置格式无效";
  if (!config.stash || !Array.isArray(config.stash.rules) || !config.stash.tun || !config.stash.dns || !config.stash.mitm) return "Stash 配置格式无效";
  if (typeof config.groups.Proxy !== "string") return "内置 Proxy 策略组必须保留";
  if (config.disabledGroups.includes("Proxy")) return "内置 Proxy 策略组不能禁用";

  const countError = firstCountLimit([
    ["订阅源", config.sources.length, MAX_COUNTS.sources],
    ["静态节点", config.proxyNodes.length, MAX_COUNTS.proxyNodes],
    ["策略组", Object.keys(config.groups).length, MAX_COUNTS.groups],
    ["Tailscale 节点", config.surge.tailscaleNodes.length, MAX_COUNTS.tailscaleNodes],
    ["规则输出", config.ruleSets.outputs.length, MAX_COUNTS.ruleSetOutputs],
    ["主配置单条规则", config.ruleSets.directRules.length, MAX_COUNTS.directRules],
    ["Surge 规则", config.surge.rules.length, MAX_COUNTS.targetRules],
    ["Clash 规则", config.clash.rules.length, MAX_COUNTS.targetRules],
    ["Stash 规则", config.stash.rules.length, MAX_COUNTS.targetRules]
  ]);
  if (countError) return countError;

  const listError = validateConfigLists(config);
  if (listError) return listError;

  for (const [name, spec] of Object.entries(config.groups)) {
    const nameError = validatePolicyName(name, "策略组名称");
    if (nameError) return nameError;
    if (ALL_BUILT_IN_POLICIES.has(name.toUpperCase())) return `策略组名称 ${name} 与客户端内置策略冲突`;
    if (typeof spec !== "string" || spec.length > MAX_GROUP_SPEC_LENGTH) return `策略组 ${name} 配置过长或格式无效`;
    const specError = validatePolicyGroupSpec(name, spec, config, options.allowUnresolvedPolicies);
    if (specError) return specError;
  }
  const groupCycleError = options.allowUnresolvedPolicies ? null : validatePolicyGroupCycles(config);
  if (groupCycleError) return groupCycleError;

  const sourceIds = new Set<string>();
  for (const [index, source] of config.sources.entries()) {
    const idError = validateStableId(source?.id, `订阅源第 ${index + 1} 项 ID`);
    if (idError) return idError;
    if (sourceIds.has(source.id)) return `订阅源 ID ${source.id} 不能重复`;
    sourceIds.add(source.id);
    const nameError = validateSizedString(source?.name, MAX_NAME_LENGTH, `订阅源 ${source.id} 名称`);
    if (nameError) return nameError;
    const urlError = validateSizedString(source?.url, MAX_URL_LENGTH, `订阅源 ${source.id} URL`, true);
    if (urlError) return urlError;
    if (source.url && !isHttpUrl(source.url)) return `订阅源 ${source.id} URL 必须使用 http 或 https`;
    const uaError = validateSizedString(source.fetchUserAgent, 512, `订阅源 ${source.id} User-Agent`);
    if (uaError) return uaError;
    if (/[\r\n]/.test(source.fetchUserAgent)) return "User-Agent 不能包含换行";
  }

  const proxyIds = new Set<string>();
  for (const [index, node] of config.proxyNodes.entries()) {
    const idError = validateStableId(node?.id, `静态节点第 ${index + 1} 项 ID`);
    if (idError) return idError;
    if (proxyIds.has(node.id)) return `静态节点 ID ${node.id} 不能重复`;
    proxyIds.add(node.id);
    const configError = validateSizedString(node?.config, MAX_PROXY_CONFIG_LENGTH, `静态节点 ${node.id} 配置`);
    if (configError) return configError;
    const parsedNode = parseConfiguredProxyNode(node);
    if (!parsedNode) return `静态节点 ${node.id} 配置无法解析为受支持的代理节点`;
    const parsedNameError = validatePolicyName(parsedNode.name, `静态节点 ${node.id} 名称`);
    if (parsedNameError) return parsedNameError;
    const chainFilterError = validateStringList(node?.chainFilter, `静态节点 ${node.id} chainFilter`, MAX_REFERENCE_LIST_ITEMS, MAX_NAME_LENGTH);
    if (chainFilterError) return chainFilterError;
  }

  const ruleSourceIds = new Set<string>();
  for (const [index, source] of config.ruleSets.sources.entries()) {
    const idError = validateStableId(source?.id, `规则来源第 ${index + 1} 项 ID`);
    if (idError) return idError;
    if (ruleSourceIds.has(source.id)) return `规则来源 ID ${source.id} 不能重复`;
    ruleSourceIds.add(source.id);
    if (config.renderTarget === "clash" && config.ruleSets.mode === "compiled" && source.enabled && source.format.startsWith("surge-")) return `Clash 规则来源 ${source.name} 不支持 Surge 格式，请选择 Clash YAML 或文本格式。`;
    if (source.format === "sing-box-binary" && config.renderTarget !== "sing-box") return `规则来源 ${source.name} 的 SRS 格式仅适用于 sing-box。`;
    const nameError = validateSizedString(source?.name, MAX_NAME_LENGTH, `规则来源 ${source.id} 名称`);
    if (nameError) return nameError;
    const urlError = validateSizedString(source?.url, MAX_URL_LENGTH, `规则来源 ${source.id} URL`, true);
    if (urlError) return urlError;
    if (source.url && !isHttpUrl(source.url)) return `规则来源 ${source.id} URL 必须使用 http 或 https`;
  }
  for (const output of config.ruleSets.outputs) {
    const dnsError = validateRuleSetDns(config, output);
    if (dnsError) return dnsError;
    if (output.surgeType !== undefined && (config.renderTarget !== "surge" || !["RULE-SET", "DOMAIN-SET"].includes(output.surgeType))) return `规则输出 ${output.name} 的 Surge 类型无效。`;
    if (output.provider !== undefined && config.renderTarget !== "clash") return `规则输出 ${output.name} 的 provider 设置仅适用于 Clash。`;
    if (output.provider !== undefined && (!output.provider || !["domain", "ipcidr", "classical"].includes(output.provider.behavior)
      || !Number.isSafeInteger(output.provider.interval) || output.provider.interval <= 0)) return `规则输出 ${output.name} 的 behavior 或 interval 无效；interval 必须为正整数秒数。`;
    const nameError = validateSizedString(output?.name, MAX_NAME_LENGTH, "规则集下载名称");
    if (nameError) return nameError;
    const policyError = validatePolicyName(output?.policy, `规则输出 ${output.name} 策略`);
    if (policyError) return policyError;
    const sourceIdsError = validateStringList(output?.sourceIds, `规则输出 ${output.name} sourceIds`, null, MAX_ID_LENGTH);
    if (sourceIdsError) return sourceIdsError;
    const inlineCountError = validateArrayLimit(output?.inlineRules, `规则输出 ${output.name} 内联规则`, MAX_INLINE_RULES_PER_OUTPUT);
    if (inlineCountError) return inlineCountError;
    const inlineError = validateRuleLines(output?.inlineRules, `规则输出 ${output.name} 内联规则`);
    if (inlineError) return inlineError;
    const optionsError = validateStringList(output?.surgeOptions, `规则输出 ${output.name} Surge 参数`, 100, 512);
    if (optionsError) return optionsError;
    if (output.surgeType === "DOMAIN-SET" && output.surgeOptions.some((option) => option.toLowerCase() === "no-resolve")) return `DOMAIN-SET ${output.name} 不支持 no-resolve。`;
    if (config.renderTarget === "clash" && config.ruleSets.mode === "compiled" && output.enabled) {
      if (output.surgeOptions.some((option) => option !== "no-resolve")) return `Clash 规则输出 ${output.name} 仅支持 no-resolve 选项。`;
      const parsed = parseInlineRuleSetLines(output.inlineRules, output.name, undefined, true);
      if (parsed.warnings.length) return parsed.warnings[0]!;
    }
    const seenOptions = new Set<string>();
    for (const rawOption of output.surgeOptions) {
      const option = rawOption.trim().toLowerCase();
      if (!COMPILED_SURGE_OPTIONS.has(option)) return `规则输出 ${output.name} Surge 参数 ${rawOption} 不受支持`;
      if (seenOptions.has(option)) return `规则输出 ${output.name} Surge 参数不能重复`;
      seenOptions.add(option);
    }
  }
  const directRuleIds = new Set<string>();
  for (const [index, rule] of config.ruleSets.directRules.entries()) {
    const idError = validateStableId(rule?.id, `主配置单条规则第 ${index + 1} 项 ID`);
    if (idError) return idError;
    if (directRuleIds.has(rule.id)) return `主配置单条规则 ID ${rule.id} 不能重复`;
    directRuleIds.add(rule.id);
    const ruleError = validateSizedString(rule?.rule, MAX_RULE_LENGTH, `主配置单条规则 ${rule.id}`);
    if (ruleError) return ruleError;
    if (/[\r\n]/.test(rule.rule)) return `主配置单条规则 ${rule.id} 不能包含换行`;
    if (config.renderTarget === "clash" && config.ruleSets.mode === "compiled" && rule.enabled && !isNativeClashDirectRule(rule.rule)) return `主配置单条规则 ${rule.id}（${splitRuleLine(rule.rule)[0]}）含有不支持的 Clash 类型或参数。`;
    const policyError = validatePolicyName(rule?.policy, `主配置单条规则 ${rule.id} 策略`);
    if (policyError) return policyError;
  }
  for (const [label, rules] of [["Surge", config.surge.rules], ["Clash", config.clash.rules], ["Stash", config.stash.rules]] as const) {
    const ruleError = validateRuleLines(rules, `${label} 规则`);
    if (ruleError) return ruleError;
  }
  if (typeof config.clash.ruleProviders !== "string" || config.clash.ruleProviders.length > MAX_RULE_PROVIDERS_LENGTH) {
    return "Clash rule-providers 配置过长或格式无效";
  }
  if (typeof config.stash.ruleProviders !== "string" || config.stash.ruleProviders.length > MAX_RULE_PROVIDERS_LENGTH) {
    return "Stash rule-providers 配置过长或格式无效";
  }
  return validateImportantSettings(config);
}

export function validateProxyPolicyNameConflicts(config: Partial<Pick<RenderConfig, "groups" | "proxyNodes">>): string | null {
  const groupNames = new Set(Object.keys(config.groups || {}).map((name) => name.trim()).filter(Boolean));
  const proxyNames = new Set<string>();
  for (const proxyNode of Array.isArray(config.proxyNodes) ? config.proxyNodes : []) {
    const name = parseConfiguredProxyNode(proxyNode)?.name.trim();
    if (name && groupNames.has(name)) {
      return `代理节点名称 ${name} 不能和策略组名称相同`;
    }
    if (name && proxyNames.has(name)) return `代理节点名称 ${name} 不能重复`;
    if (name && ALL_BUILT_IN_POLICIES.has(name.toUpperCase())) return `代理节点名称 ${name} 与客户端内置策略冲突`;
    if (name) proxyNames.add(name);
  }
  return null;
}

export function validateTailscalePolicies(config: RenderConfig): string | null {
  const nodes = config.surge.tailscaleNodes;
  const groupNames = new Set(Object.keys(config.groups));
  const activeGroupNames = new Set(Object.keys(config.groups).filter((name) => !config.disabledGroups.includes(name)));
  const parsedProxyNodes = config.proxyNodes.flatMap((node) => {
    const parsed = parseConfiguredProxyNode(node);
    return parsed ? [{ configured: node, parsed }] : [];
  });
  const configuredProxyNames = new Set(parsedProxyNodes.map(({ parsed }) => parsed.name.trim()).filter(Boolean));
  const activeProxyNames = new Set(parsedProxyNodes
    .filter(({ configured, parsed }) => configured.enabled !== false && isProxyNodeSupportedForTarget(parsed, "surge"))
    .map(({ parsed }) => parsed.name.trim())
    .filter(Boolean));
  const names = new Set<string>();
  const sections = new Set<string>();
  for (const [index, node] of nodes.entries()) {
    const nameError = validatePolicyName(node?.name, `Tailscale 第 ${index + 1} 项名称`);
    if (nameError) return nameError;
    if (/^DEVICE:/i.test(node.name)) return `Tailscale 名称 ${node.name} 不能使用 DEVICE: 前缀`;
    if (names.has(node.name)) return `Tailscale 名称 ${node.name} 不能重复`;
    names.add(node.name);
    if (groupNames.has(node.name) || configuredProxyNames.has(node.name) || ALL_BUILT_IN_POLICIES.has(node.name.toUpperCase())) {
      return `Tailscale 名称 ${node.name} 与已有策略、节点或内置策略冲突`;
    }
    const sectionError = validateSizedString(node?.sectionName, MAX_ID_LENGTH, `Tailscale ${node.name} section-name`);
    if (sectionError || /[\s=,\r\n[\]]/.test(node.sectionName)) return `Tailscale ${node.name} section-name 格式无效`;
    if (sections.has(node.sectionName)) return `Tailscale section-name ${node.sectionName} 不能重复`;
    sections.add(node.sectionName);
    const tailscaleFields: Array<[unknown, number, string, boolean?]> = [
      [node.authKey, 4_096, `Tailscale ${node.name} auth-key`, true],
      [node.controlUrl, MAX_URL_LENGTH, `Tailscale ${node.name} control-url`, true],
      [node.hostname, 255, `Tailscale ${node.name} hostname`, true],
      [node.exitNode, 512, `Tailscale ${node.name} exit-node`, true],
      [node.underlyingProxy, MAX_NAME_LENGTH, `Tailscale ${node.name} underlying-proxy`, true],
      [node.testUrl, MAX_URL_LENGTH, `Tailscale ${node.name} test-url`, true]
    ];
    for (const [value, limit, label, allowEmpty] of tailscaleFields) {
      const error = value === undefined
        ? null
        : validateSizedString(value, limit, label, allowEmpty);
      if (error) return error;
      if (typeof value === "string" && /[\r\n]/.test(value)) return `${label}不能包含换行`;
    }
    const dnsError = node.dnsServer === undefined
      ? null
      : validateStringList(node.dnsServer, `Tailscale ${node.name} dns-server`, MAX_REFERENCE_LIST_ITEMS, MAX_URL_LENGTH);
    if (dnsError) return dnsError;
    if (node.dnsServer?.some((value) => /[,\r\n]/.test(value))) return `Tailscale ${node.name} dns-server 不能包含逗号或换行`;
    const authKey = typeof node.authKey === "string" ? node.authKey.trim() : "";
    for (const key of ["interactiveLogin", "autoAddMagicDnsRule"] as const) {
      if (node[key] !== undefined && typeof node[key] !== "boolean") return `Tailscale ${node.name} ${key} 必须为布尔值`;
    }
    if (node.interactiveLogin && authKey) return `Tailscale ${node.name} interactive-login 与 auth-key 不能同时使用`;
    if (node.enabled && !node.interactiveLogin && !authKey) return `Tailscale ${node.name} 启用时 auth-key 不能为空`;
    if (!Number.isInteger(node.idleKeepalive) || node.idleKeepalive < -1 || node.idleKeepalive > 86_400) {
      return `Tailscale ${node.name} idle-keepalive 必须是 -1 到 86400 的整数`;
    }
    if (node.underlyingProxy) {
      const underlyingError = validatePolicyName(node.underlyingProxy, `Tailscale ${node.name} underlying-proxy`);
      if (underlyingError) return underlyingError;
    }
    const normalizedTestUrl = typeof node.testUrl === "string" ? node.testUrl : "";
    if (normalizedTestUrl.includes(",")) return `Tailscale ${node.name} test-url 不能包含逗号`;
    const controlUrl = typeof node.controlUrl === "string" ? node.controlUrl : "";
    if (controlUrl) {
      try {
        const url = new URL(controlUrl);
        if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("invalid protocol");
      } catch {
        return `Tailscale ${node.name} control-url 必须使用 http 或 https`;
      }
    }
    const testUrl = typeof node.testUrl === "string" ? node.testUrl : "";
    if (testUrl) {
      try {
        const url = new URL(testUrl);
        if (!["http:", "https:"].includes(url.protocol) || !url.hostname) return `Tailscale ${node.name} test-url 必须是有效的 HTTP(S) URL`;
      } catch {
        return `Tailscale ${node.name} test-url 必须是有效的 HTTP(S) URL`;
      }
    }
  }

  const activeTailscaleNames = new Set(nodes
    .filter(tailscaleNodeIsActive)
    .map((node) => node.name));
  const potentiallyAvailableUnderlying = new Set([
    ...activeGroupNames,
    ...activeProxyNames,
    ...SURGE_BUILT_IN_RULE_POLICIES,
    ...activeTailscaleNames
  ]);
  const edges = new Map<string, string>();
  for (const node of nodes.filter(tailscaleNodeIsActive)) {
    const underlying = typeof node.underlyingProxy === "string" ? node.underlyingProxy.trim() : "";
    if (!underlying || underlying.toUpperCase() === "DIRECT") continue;
    if (underlying === node.name) return `Tailscale ${node.name} underlying-proxy 不能引用自身`;
    if (!potentiallyAvailableUnderlying.has(underlying)) return `Tailscale ${node.name} underlying-proxy ${underlying} 不存在或不可用`;
    if (activeTailscaleNames.has(underlying)) edges.set(node.name, underlying);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string): boolean => {
    if (visiting.has(name)) return true;
    if (visited.has(name)) return false;
    visiting.add(name);
    const next = edges.get(name);
    if (next && visit(next)) return true;
    visiting.delete(name);
    visited.add(name);
    return false;
  };
  for (const name of edges.keys()) {
    if (visit(name)) return "Tailscale underlying-proxy 不能形成循环引用";
  }
  const resolved = resolvePotentialSurgePolicies(config, activeProxyNames, configuredProxyNames, activeTailscaleNames);
  for (const node of nodes.filter(tailscaleNodeIsActive)) {
    if (!resolved.tailscale.has(node.name)) {
      return `Tailscale ${node.name} 的 underlying-proxy 最终不可用，不能引用空策略组或不受 Surge 支持的节点`;
    }
  }
  return null;
}

function resolvePotentialSurgePolicies(
  config: RenderConfig,
  activeProxyNames: Set<string>,
  configuredProxyNames: Set<string>,
  activeTailscaleNames: Set<string>
): { groups: Set<string>; tailscale: Set<string> } {
  const disabledGroups = new Set(config.disabledGroups);
  const groupEntries = Object.entries(config.groups).filter(([name]) => !disabledGroups.has(name));
  const configuredGroupNames = new Set(groupEntries.map(([name]) => name));
  const groups = new Set<string>();
  const tailscale = new Set<string>();
  const hasPotentialUpstreamNodes = config.sources.some((source) => source.enabled && Boolean(source.url));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, spec] of groupEntries) {
      if (groups.has(name)) continue;
      if (name === "Proxy" || potentialSurgeGroupHasMember(
        name,
        spec,
        activeProxyNames,
        configuredProxyNames,
        configuredGroupNames,
        groups,
        tailscale,
        hasPotentialUpstreamNodes
      )) {
        groups.add(name);
        changed = true;
      }
    }
    for (const node of config.surge.tailscaleNodes) {
      if (!activeTailscaleNames.has(node.name) || tailscale.has(node.name)) continue;
      const underlying = typeof node.underlyingProxy === "string" ? node.underlyingProxy.trim() : "";
      if (
        !underlying
        || underlying.toUpperCase() === "DIRECT"
        || SURGE_BUILT_IN_RULE_POLICIES.has(underlying)
        || activeProxyNames.has(underlying)
        || groups.has(underlying)
        || tailscale.has(underlying)
      ) {
        tailscale.add(node.name);
        changed = true;
      }
    }
  }
  return { groups, tailscale };
}

function potentialSurgeGroupHasMember(
  groupName: string,
  spec: string,
  activeProxyNames: Set<string>,
  configuredProxyNames: Set<string>,
  configuredGroupNames: Set<string>,
  availableGroups: Set<string>,
  availableTailscale: Set<string>,
  hasPotentialUpstreamNodes: boolean
): boolean {
  const [rawType = "select", ...items] = splitGroupSpec(spec);
  const type = rawType.trim().toLowerCase();
  if (type === "subnet") return true;
  for (const item of items) {
    if (parseAllPolicySelector(item)) {
      if (activeProxyNames.size > 0 || hasPotentialUpstreamNodes) return true;
      continue;
    }
    if (parseGroupOption(item) || item === groupName || item === "Proxy") continue;
    if (
      SURGE_BUILT_IN_RULE_POLICIES.has(item)
      || activeProxyNames.has(item)
      || availableGroups.has(item)
      || availableTailscale.has(item)
    ) return true;
    if (configuredProxyNames.has(item) || configuredGroupNames.has(item)) continue;
    if (hasPotentialUpstreamNodes) return true;
  }
  return false;
}

export function validateRuleSetOutputNames(config: Partial<Pick<RenderConfig, "ruleSets">>): string | null {
  if (!Array.isArray(config.ruleSets?.outputs)) return "规则集输出配置格式无效";
  const configuredError = validateOutputNameList(config.ruleSets.outputs);
  if (configuredError) return configuredError;
  const ruleSets = {
    mode: config.ruleSets.mode === "compiled" ? "compiled" as const : "manual" as const,
    aggregateByPolicy: config.ruleSets.aggregateByPolicy === true,
    sources: Array.isArray(config.ruleSets.sources) ? config.ruleSets.sources : [],
    outputs: config.ruleSets.outputs,
    directRules: Array.isArray(config.ruleSets.directRules) ? config.ruleSets.directRules : []
  };
  const effectiveOutputs = effectiveRuleSetOutputs(ruleSets);
  const effectiveError = config.ruleSets.aggregateByPolicy === true
    ? validateOutputNameList(effectiveOutputs)
    : null;
  return effectiveError || validateRuleProviderNameCollisions(effectiveOutputs) || validateCompiledFallback(ruleSets);
}

export function validateCompiledFallbackTargets(config: RenderConfig): string | null {
  if (config.ruleSets.mode !== "compiled") return null;
  const fallback = config.ruleSets.directRules.find((rule) => {
    if (!rule.enabled) return false;
    const type = (splitRuleLine(rule.rule)[0] || "").trim().toUpperCase();
    return type === "FINAL" || type === "MATCH";
  });
  if (!fallback) return null;
  const policy = fallback.policy.trim();
  if (config.surge.tailscaleNodes.some((node) => node.name === policy)) {
    return `编译规则兜底策略 ${policy} 仅适用于 Surge，不能用于跨目标输出`;
  }
  return RULE_SET_TARGETS.some((target) => !isRulePolicyCompatibleWithTarget(policy, target))
    ? `编译规则兜底策略 ${policy} 不受所有输出目标支持`
    : null;
}

export function validateCompiledRulePolicies(config: RenderConfig): string | null {
  if (config.ruleSets.mode !== "compiled") return null;
  const disabledGroups = new Set(config.disabledGroups);
  const configuredPolicies = new Set([
    ...Object.keys(config.groups).filter((name) => !disabledGroups.has(name)),
    ...SURGE_BUILT_IN_RULE_POLICIES,
    ...CLASH_BUILT_IN_RULE_POLICIES,
    ...STASH_BUILT_IN_RULE_POLICIES,
    ...config.surge.tailscaleNodes
      .filter(tailscaleNodeIsActive)
      .map((node) => node.name)
  ]);
  for (const output of config.ruleSets.outputs.filter((item) => item.enabled)) {
    const policy = output.policy.trim();
    if (/^DEVICE:/i.test(policy) || !configuredPolicies.has(policy)) {
      return `规则输出 ${output.name} 的策略 ${policy} 不存在或不可用`;
    }
  }
  for (const rule of config.ruleSets.directRules.filter((item) => item.enabled)) {
    const policy = rule.policy.trim();
    if (/^DEVICE:/i.test(policy) || !configuredPolicies.has(policy)) {
      return `主配置单条规则 ${rule.id} 的策略 ${policy} 不存在或不可用`;
    }
  }
  return null;
}

function validatePolicyGroupSpec(name: string, spec: string, config: RenderConfig, allowUnresolvedPolicies = false): string | null {
  if (/[\r\n\u0000-\u001f\u007f]/.test(spec)) return `策略组 ${name} 配置不能包含换行或控制字符`;
  const [rawType = "", ...items] = splitGroupSpec(spec);
  const type = rawType.trim().toLowerCase();
  if (!POLICY_GROUP_TYPES.has(type)) return `策略组 ${name} 类型 ${rawType || "(空)"} 不受支持`;

  const configuredPolicies = new Set([
    ...Object.keys(config.groups),
    ...SURGE_BUILT_IN_RULE_POLICIES,
    ...CLASH_BUILT_IN_RULE_POLICIES,
    ...STASH_BUILT_IN_RULE_POLICIES,
    ...config.proxyNodes.flatMap((node) => {
      try {
        const parsed = node && typeof node === "object" ? parseConfiguredProxyNode(node) : null;
        return parsed?.name.trim() ? [parsed.name.trim()] : [];
      } catch {
        return [];
      }
    }),
    ...config.surge.tailscaleNodes.flatMap((node) => typeof node?.name === "string" && node.name.trim() ? [node.name.trim()] : []),
    ...(config.renderTarget === "sing-box" ? [...config.document?.clients.singbox.outbounds ?? [], ...config.document?.clients.singbox.endpoints ?? []].flatMap((node) => typeof node.tag === "string" ? [node.tag] : []) : [])
  ]);
  let defaultCount = 0;
  const optionKeys = new Set<string>();
  for (const item of items) {
    const selector = parseAllPolicySelector(item);
    if (selector) {
      if (type === "subnet") return `策略组 ${name} 类型 ${type} 不能使用 {all} 节点选择器`;
      continue;
    }
    if (item.startsWith("{") || item.endsWith("}")) return `策略组 ${name} 的节点选择器格式无效`;

    const option = parseGroupOption(item);
    if (!option) {
      const policyError = validatePolicyName(item, `策略组 ${name} 成员`);
      if (policyError) return policyError;
      if (type === "subnet") return `策略组 ${name} subnet 成员必须使用 条件=策略 格式`;
      if (!allowUnresolvedPolicies && item === name) return `策略组 ${name} 不能引用自身`;
      if (!allowUnresolvedPolicies && !configuredPolicies.has(item)) return `策略组 ${name} 成员 ${item} 不存在；订阅节点请使用 {all} 选择器`;
      continue;
    }

    const key = option.key.trim();
    const lowerKey = key.toLowerCase();
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key) && !(type === "subnet" && isSubnetConditionKey(key))) {
      return `策略组 ${name} 参数 ${key} 格式无效`;
    }
    if (RESERVED_CLASH_GROUP_OPTION_KEYS.has(lowerKey)) return `策略组 ${name} 参数 ${key} 为保留字段`;
    if (lowerKey === "policy-priority" && config.renderTarget === "surge") {
      if (!["smart", "url-test"].includes(type)) return `策略组 ${name} policy-priority 仅适用于 Smart`;
      if (optionKeys.has(lowerKey)) return `策略组 ${name} 参数 ${key} 不能重复`;
      optionKeys.add(lowerKey);
      const error = validatePolicyPriority(option.value);
      if (error) return `策略组 ${name} ${error}`;
      continue;
    }
    if (!option.value || /[,\r\n{}\u0000-\u001f\u007f]/.test(option.value)) return `策略组 ${name} 参数 ${key} 的值格式无效`;
    if (optionKeys.has(lowerKey) && !(type === "subnet" && isSubnetConditionKey(key))) return `策略组 ${name} 参数 ${key} 不能重复`;
    optionKeys.add(lowerKey);

    if (lowerKey === "category" && config.renderTarget === "surge") {
      if (/[";#]/.test(option.value)) return `策略组 ${name} category 不能包含引号、分号或井号`;
      continue;
    }
    if (lowerKey === "hidden") {
      if (!new Set(["true", "false", "1", "0"]).has(option.value.toLowerCase())) return `策略组 ${name} hidden 参数格式无效`;
      continue;
    }
    if (lowerKey === "underlying-proxy") {
      if (type === "subnet") return `策略组 ${name} subnet 不支持 underlying-proxy`;
      const policyError = validatePolicyName(option.value, `策略组 ${name} underlying-proxy`);
      if (policyError) return policyError;
      continue;
    }
    if (lowerKey === "icon-url") {
      try { if (!["http:", "https:"].includes(new URL(option.value).protocol)) throw new Error(); }
      catch { return `策略组 ${name} icon-url 必须使用 http 或 https`; }
      continue;
    }
    if (config.renderTarget === "sing-box" && ["select", "url-test"].includes(type)) {
      if (key === "interrupt_exist_connections") {
        if (!["true", "false"].includes(option.value)) return `策略组 ${name} interrupt_exist_connections 必须为 true 或 false`;
        continue;
      }
      if (type === "select" && key === "default") {
        const policyError = validatePolicyName(option.value, `策略组 ${name} 默认成员`);
        if (policyError) return policyError;
        continue;
      }
      if (type === "url-test" && key === "idle_timeout") {
        if (!isValidSingboxOutbound({ type: "urltest", outbounds: ["DIRECT"], idle_timeout: option.value })) return `策略组 ${name} idle_timeout 时长格式无效`;
        continue;
      }
    }
    if (config.renderTarget === "clash" && type === "select" && key === "default-selected") {
      const policyError = validatePolicyName(option.value, `策略组 ${name} 默认成员`);
      if (policyError) return policyError;
      continue;
    }
    if (type === "select") return `策略组 ${name} select 类型不支持参数 ${key}`;
    if (type === "subnet") {
      if (lowerKey === "default") defaultCount += 1;
      else if (!isSubnetConditionKey(key)) return `策略组 ${name} subnet 参数 ${key} 不受支持`;
      const policyError = validatePolicyName(option.value, `策略组 ${name} 参数 ${key} 策略`);
      if (policyError) return policyError;
      if (!allowUnresolvedPolicies && option.value === name) return `策略组 ${name} 不能引用自身`;
      if (!allowUnresolvedPolicies && !configuredPolicies.has(option.value)) return `策略组 ${name} 参数 ${key} 引用的策略 ${option.value} 不存在`;
      continue;
    }
    if (lowerKey === "url") {
      try {
        const url = new URL(option.value);
        if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("invalid protocol");
      } catch {
        return `策略组 ${name} url 必须使用 http 或 https`;
      }
      continue;
    }
    if (lowerKey === "interval") {
      const interval = Number(option.value);
      if (!Number.isSafeInteger(interval) || interval < 1 || interval > 604_800) return `策略组 ${name} interval 必须是 1 到 604800 的整数`;
      continue;
    }
    if (lowerKey === "tolerance") {
      const tolerance = Number(option.value);
      if (!Number.isSafeInteger(tolerance) || tolerance < 0 || tolerance > 60_000) return `策略组 ${name} tolerance 必须是 0 到 60000 的整数`;
      continue;
    }
    if (type === "url-test") return `策略组 ${name} url-test 类型不支持参数 ${key}`;
  }
  if (defaultCount > 1) return `策略组 ${name} subnet 只能配置一个 default`;
  return null;
}

function validatePolicyGroupCycles(config: RenderConfig): string | null {
  const disabled = new Set(config.disabledGroups);
  const activeGroups = new Set(Object.keys(config.groups).filter((name) => !disabled.has(name)));
  const edges = new Map<string, string[]>();
  for (const name of activeGroups) {
    const [rawType = "select", ...items] = splitGroupSpec(config.groups[name] ?? "");
    const type = rawType.trim().toLowerCase();
    const references = items.flatMap((item) => {
      if (parseAllPolicySelector(item)) return [];
      const option = parseGroupOption(item, { requireValue: true });
      const policy = type === "subnet" ? (option && (option.key.toLowerCase() === "default" || isSubnetConditionKey(option.key)) ? option.value : "") : option ? "" : item;
      return policy && activeGroups.has(policy) ? [policy] : [];
    });
    edges.set(name, [...new Set(references)]);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  const visit = (name: string): string[] | null => {
    const cycleStart = path.indexOf(name);
    if (cycleStart >= 0) return [...path.slice(cycleStart), name];
    if (visited.has(name)) return null;
    visiting.add(name);
    path.push(name);
    for (const next of edges.get(name) ?? []) {
      if (!visiting.has(next) && visited.has(next)) continue;
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    path.pop();
    visiting.delete(name);
    visited.add(name);
    return null;
  };

  for (const name of activeGroups) {
    const cycle = visit(name);
    if (cycle) return `策略组不能形成循环引用：${cycle.join(" -> ")}`;
  }
  return null;
}

function isSubnetConditionKey(key: string): boolean {
  return /^(SSID|BSSID|ROUTER):[^=,\r\n]+$/i.test(key) || /^TYPE:(WIFI|WIRED|CELLULAR)$/i.test(key);
}

function tailscaleNodeIsActive(node: RenderConfig["surge"]["tailscaleNodes"][number]): boolean {
  return node.enabled === true && (node.interactiveLogin === true || typeof node.authKey === "string" && Boolean(node.authKey.trim()));
}

function validateCompiledFallback(ruleSets: RenderConfig["ruleSets"]): string | null {
  if (ruleSets.mode !== "compiled") return null;
  const finalRules = ruleSets.directRules.filter((rule) => {
    if (!rule.enabled) return false;
    const type = (splitRuleLine(rule.rule)[0] || "").trim().toUpperCase();
    return type === "FINAL" || type === "MATCH";
  });
  if (finalRules.length === 0) return "编译规则模式必须保留一个 FINAL 或 MATCH 兜底规则";
  if (finalRules.length > 1) return "编译规则模式只能保留一个 FINAL 或 MATCH 兜底规则";
  const final = finalRules[0]!;
  if ([...ruleSets.outputs, ...ruleSets.directRules].some((item) => item !== final && item.enabled && item.order >= final.order)) return "兜底规则必须位于所有分流规则的最后";
  return null;
}

function validateOutputNameList(outputs: RenderConfig["ruleSets"]["outputs"]): string | null {
  const names = new Set<string>();
  for (const output of outputs) {
    const name = ruleSetPathName(output?.name);
    if (!name || name === "." || name === "..") return "规则集名称不能为空，也不能使用 . 或 ..";
    if (names.has(name)) return `规则集名称 ${name} 不能重复`;
    names.add(name);
  }
  for (const name of names) {
    for (const suffix of ["-domain", "-ipcidr", "-dns"]) {
      if (suffix === "-dns" && !outputs.some((output) => ruleSetPathName(output.name) === name && output.dnsServer)) continue;
      if (names.has(`${name}${suffix}`)) return `规则集名称 ${name} 与 ${name}${suffix} 会生成冲突文件名`;
    }
  }
  return null;
}

function validateRuleProviderNameCollisions(outputs: RenderConfig["ruleSets"]["outputs"]): string | null {
  const buckets: RuleSetDownloadBucket[] = ["combined", "domain", "ipcidr", "classical"];
  const owners = new Map<string, string>();
  for (const output of outputs) {
    for (const bucket of buckets) {
      const providerName = compiledRuleProviderName(output.name, bucket);
      const owner = owners.get(providerName);
      if (owner && owner !== output.name) {
        return `规则集下载名称 ${owner} 与 ${output.name} 会生成冲突的 Clash rule-provider 名称`;
      }
      owners.set(providerName, output.name);
    }
  }
  return null;
}

function firstCountLimit(entries: ReadonlyArray<readonly [string, number, number]>): string | null {
  const exceeded = entries.find(([, count, limit]) => count > limit);
  return exceeded ? `${exceeded[0]}数量不能超过 ${exceeded[2]}` : null;
}

function validateConfigLists(config: RenderConfig): string | null {
  const lists: Array<readonly [unknown, string, number, number]> = [
    [config.disabledGroups, "禁用策略组", MAX_COUNTS.groups, MAX_NAME_LENGTH],
    [config.settings.excludeKeywords, "排除关键词", MAX_GENERAL_LIST_ITEMS, MAX_NAME_LENGTH],
    [config.settings.featureTagRules, "特征标签规则", MAX_GENERAL_LIST_ITEMS, MAX_RULE_LENGTH],
    [config.chain.filter, "链式代理筛选", MAX_REFERENCE_LIST_ITEMS, MAX_NAME_LENGTH],
    [config.surge.skipProxy, "Surge skip-proxy", MAX_GENERAL_LIST_ITEMS, MAX_URL_LENGTH],
    [config.surge.dnsServer, "Surge dns-server", MAX_GENERAL_LIST_ITEMS, MAX_URL_LENGTH],
    [config.surge.alwaysRealIp, "Surge always-real-ip", MAX_GENERAL_LIST_ITEMS, MAX_URL_LENGTH],
    [config.surge.tunExcludedRoutes, "Surge tun-excluded-routes", MAX_GENERAL_LIST_ITEMS, MAX_URL_LENGTH],
    [config.surge.encryptedDnsServer, "Surge encrypted-dns-server", MAX_GENERAL_LIST_ITEMS, MAX_URL_LENGTH],
    [config.surge.hosts, "Surge Host", MAX_GENERAL_LIST_ITEMS, MAX_RULE_LENGTH],
    [config.surge.urlRewrite, "Surge URL Rewrite", MAX_GENERAL_LIST_ITEMS, MAX_RULE_LENGTH],
    [config.surge.mapLocal, "Surge Map Local", MAX_GENERAL_LIST_ITEMS, MAX_RULE_LENGTH],
    [config.surge.scripts, "Surge Script", MAX_GENERAL_LIST_ITEMS, MAX_RULE_LENGTH],
    [config.surge.mitm.hostname, "Surge MITM hostname", MAX_GENERAL_LIST_ITEMS, MAX_URL_LENGTH],
    [config.clash.tun.skipProxy, "Clash TUN skip-proxy", MAX_GENERAL_LIST_ITEMS, MAX_URL_LENGTH],
    [config.clash.defaultNameservers, "Clash default-nameserver", MAX_GENERAL_LIST_ITEMS, MAX_URL_LENGTH],
    [config.clash.nameservers, "Clash nameserver", MAX_GENERAL_LIST_ITEMS, MAX_URL_LENGTH],
    [config.clash.fallbackNameservers, "Clash fallback", MAX_GENERAL_LIST_ITEMS, MAX_URL_LENGTH],
    [config.clash.fallbackFilterIpcidr, "Clash fallback-filter ipcidr", MAX_GENERAL_LIST_ITEMS, MAX_URL_LENGTH],
    [config.clash.fakeIpFilter, "Clash fake-ip-filter", MAX_GENERAL_LIST_ITEMS, MAX_URL_LENGTH],
    [config.stash.tun.skipProxy, "Stash TUN skip-proxy", MAX_GENERAL_LIST_ITEMS, MAX_URL_LENGTH],
    [config.stash.dns.defaultNameservers, "Stash default-nameserver", MAX_GENERAL_LIST_ITEMS, MAX_URL_LENGTH],
    [config.stash.dns.nameservers, "Stash nameserver", MAX_GENERAL_LIST_ITEMS, MAX_URL_LENGTH],
    [config.stash.dns.fallbackNameservers, "Stash fallback", MAX_GENERAL_LIST_ITEMS, MAX_URL_LENGTH],
    [config.stash.dns.fallbackFilterIpcidr, "Stash fallback-filter ipcidr", MAX_GENERAL_LIST_ITEMS, MAX_URL_LENGTH],
    [config.stash.dns.fakeIpFilter, "Stash fake-ip-filter", MAX_GENERAL_LIST_ITEMS, MAX_URL_LENGTH],
    [config.stash.hosts, "Stash Host", MAX_GENERAL_LIST_ITEMS, MAX_RULE_LENGTH],
    [config.stash.urlRewrite, "Stash URL Rewrite", MAX_GENERAL_LIST_ITEMS, MAX_RULE_LENGTH],
    [config.stash.scripts, "Stash Script", MAX_GENERAL_LIST_ITEMS, MAX_RULE_LENGTH],
    [config.stash.mitm.hostname, "Stash MITM hostname", MAX_GENERAL_LIST_ITEMS, MAX_URL_LENGTH]
  ];
  for (const [value, label, itemLimit, stringLimit] of lists) {
    const error = validateStringList(value, label, itemLimit, stringLimit);
    if (error) return error;
  }
  return null;
}

function validatePolicyName(value: unknown, label: string): string | null {
  const basic = validateSizedString(value, MAX_NAME_LENGTH, label);
  if (basic) return basic;
  const name = value as string;
  if (name !== name.trim() || /[=,\r\n[\]\u0000-\u001f\u007f]/.test(name)) return `${label}格式无效`;
  return null;
}

function validateStableId(value: unknown, label: string): string | null {
  if (typeof value !== "string" || !new RegExp(`^[A-Za-z0-9_-]{1,${MAX_ID_LENGTH}}$`).test(value)) return `${label}格式无效`;
  return null;
}

function validateSizedString(value: unknown, limit: number, label: string, allowEmpty = false): string | null {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) return `${label}不能为空或格式无效`;
  if (value.length > limit) return `${label}长度不能超过 ${limit}`;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return `${label}包含非法控制字符`;
  return null;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function validateArrayLimit(value: unknown, label: string, limit: number): string | null {
  if (!Array.isArray(value)) return `${label}格式无效`;
  return value.length > limit ? `${label}数量不能超过 ${limit}` : null;
}

function validateStringList(value: unknown, label: string, itemLimit: number | null, stringLimit: number): string | null {
  if (!Array.isArray(value)) return `${label}格式无效`;
  if (itemLimit !== null && value.length > itemLimit) return `${label}数量不能超过 ${itemLimit}`;
  for (const [index, item] of (value as unknown[]).entries()) {
    const error = validateSizedString(item, stringLimit, `${label}第 ${index + 1} 项`, true);
    if (error) return error;
    if (typeof item === "string" && /[\r\n]/.test(item)) return `${label}第 ${index + 1} 项不能包含换行`;
  }
  return null;
}

function validateRuleLines(value: unknown, label: string): string | null {
  if (!Array.isArray(value)) return `${label}格式无效`;
  for (const [index, rule] of value.entries()) {
    const error = validateSizedString(rule, MAX_RULE_LENGTH, `${label}第 ${index + 1} 行`, true);
    if (error) return error;
    if (typeof rule === "string" && /[\r\n]/.test(rule)) return `${label}第 ${index + 1} 行不能包含换行`;
  }
  return null;
}

function validateImportantSettings(config: RenderConfig): string | null {
  if (config.renderTarget === "clash") {
    const mark = config.clash.dnsListenRoutingMark;
    if (mark !== undefined && (!Number.isInteger(mark) || mark < 0 || mark > 0xffffffff)) return "Clash DNS 监听路由标记必须是 0 到 4294967295 的整数";
    if (!["system", "gvisor", "mixed", "mips"].includes(config.clash.tun.stack)) return "Clash TUN stack 不受支持";
  }
  const fields: Array<[unknown, number, string, boolean?]> = [
    [config.settings?.managedBaseUrl, MAX_URL_LENGTH, "Managed base URL", true],
    [config.settings?.userAgentSurge, 512, "Surge User-Agent"],
    [config.settings?.userAgentClash, 512, "Clash User-Agent"],
    [config.settings?.userAgentStash, 512, "Stash User-Agent"],
    [config.settings?.userAgentShadowrocket, 512, "Shadowrocket User-Agent"]
  ];
  for (const [value, limit, label, allowEmpty] of fields) {
    const error = validateSizedString(value, limit, label, allowEmpty);
    if (error) return error;
    if (typeof value === "string" && /[\r\n]/.test(value)) return `${label}不能包含换行`;
  }
  return null;
}

function validateRuleSetDns(config: RenderConfig, output: RenderConfig["ruleSets"]["outputs"][number]): string | null {
  const server = output.dnsServer;
  if (server === undefined || server === "") return null;
  const label = `规则集 ${output.name} 的 DNS 解析服务器`;
  if (typeof server !== "string" || server.length > 2048 || /[\u0000-\u001f\u007f\u2028\u2029]/.test(server)) return `${label}无效。`;
  if (config.renderTarget === "sing-box") {
    const servers = config.document?.clients.singbox.dns.servers;
    if (!Array.isArray(servers) || !servers.some((item) => item && typeof item === "object" && !Array.isArray(item) && item.tag === server)) return `${label}不存在，请在 DNS 页添加服务器或重新选择。`;
    return null;
  }
  if (config.renderTarget === "clash") {
    if (output.provider?.behavior === "ipcidr") return `${label}不能用于纯 IP 规则集，请使用 domain 或 classical。`;
    if (output.enabled && config.ruleSets.mode === "compiled" && !config.clash.dnsEnabled) return `请先启用 Clash DNS，再指定规则集解析服务器。`;
  }
  if (/[\s,]/.test(server)) return `${label}只接受一个服务器地址。`;
  if (server === "system") return null;
  if (isIPv4(server) || isIPv6(server)) return null;
  if (!server.includes("://")) {
    const match = server.match(/^(?:\[([a-fA-F0-9:]+)\]|([0-9.]+)):(\d+)$/);
    if (match && (isIPv6(match[1] || "") || isIPv4(match[2] || "")) && Number(match[3]) > 0 && Number(match[3]) <= 65535) return null;
    return `${label}应为 IP、IP:端口、system 或加密 DNS URL。`;
  }
  try {
    const url = new URL(server);
    const schemes = config.renderTarget === "surge" ? ["https:", "h3:", "quic:", "tls:", "tcp:"] : ["https:", "tls:", "quic:", "tcp:", "udp:"];
    if (schemes.includes(url.protocol) && url.hostname && !url.username && !url.password && !url.hash) return null;
  } catch { /* Report only the field, never echo resolver credentials. */ }
  return `${label}的 URL 协议或地址无效。`;
}
