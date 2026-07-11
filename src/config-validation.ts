import { normalizeManagedBasePath, ruleSetPathName } from "./managed-url";
import { parseConfiguredProxyNode } from "./parsers";
import { effectiveRuleSetOutputs } from "./rule-set-outputs";
import type { AppConfig } from "./types";

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
  "/index.html",
  "/login.html",
  "/mitm-ca.js",
  "/styles.css"
]);

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

export function validateProxyPolicyNameConflicts(config: Partial<Pick<AppConfig, "groups" | "proxyNodes">>): string | null {
  const groupNames = new Set(Object.keys(config.groups || {}).map((name) => name.trim()).filter(Boolean));
  for (const proxyNode of Array.isArray(config.proxyNodes) ? config.proxyNodes : []) {
    const name = parseConfiguredProxyNode(proxyNode)?.name.trim();
    if (name && groupNames.has(name)) {
      return `代理节点名称 ${name} 不能和策略组名称相同`;
    }
  }
  return null;
}

export function validateRuleSetOutputNames(config: Partial<Pick<AppConfig, "ruleSets">>): string | null {
  if (!Array.isArray(config.ruleSets?.outputs)) return "规则集输出配置格式无效";
  const configuredError = validateOutputNameList(config.ruleSets.outputs);
  if (configuredError || config.ruleSets.aggregateByPolicy !== true) return configuredError;
  const ruleSets = {
    mode: config.ruleSets.mode === "compiled" ? "compiled" as const : "manual" as const,
    aggregateByPolicy: config.ruleSets.aggregateByPolicy === true,
    sources: Array.isArray(config.ruleSets.sources) ? config.ruleSets.sources : [],
    outputs: config.ruleSets.outputs,
    directRules: Array.isArray(config.ruleSets.directRules) ? config.ruleSets.directRules : []
  };
  return validateOutputNameList(effectiveRuleSetOutputs(ruleSets));
}

function validateOutputNameList(outputs: AppConfig["ruleSets"]["outputs"]): string | null {
  const names = new Set<string>();
  for (const output of outputs) {
    const name = ruleSetPathName(output?.name);
    if (!name || name === "." || name === "..") return "规则集名称不能为空，也不能使用 . 或 ..";
    if (names.has(name)) return `规则集名称 ${name} 不能重复`;
    names.add(name);
  }
  for (const name of names) {
    for (const suffix of ["-domain", "-ipcidr"]) {
      if (names.has(`${name}${suffix}`)) return `规则集名称 ${name} 与 ${name}${suffix} 会生成冲突文件名`;
    }
  }
  return null;
}
