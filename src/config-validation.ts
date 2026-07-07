import { parseConfiguredProxyNode } from "./parsers";
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

function normalizeManagedBasePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed || "/";
}
