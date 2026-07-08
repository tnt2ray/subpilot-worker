import { isConfigFileName, syncPathForToken } from "./target-files";
import type { AppConfig } from "./types";

export interface SyncPath {
  token: string;
  fileName?: string;
}

export function normalizeManagedBasePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed || "/";
}

export function isUnderManagedBasePath(pathname: string, managedBasePath: string): boolean {
  const basePath = normalizeManagedBasePath(managedBasePath);
  return pathname === basePath || pathname.startsWith(`${basePath}/`);
}

export function extractSubscriptionToken(pathname: string, managedBasePath: string): string | null {
  const basePath = normalizeManagedBasePath(managedBasePath);
  const remainder = basePath === "/"
    ? pathname
    : pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : "";
  return remainder.split("/").filter(Boolean)[0] ?? null;
}

export function parseSyncPath(pathname: string, managedBasePath: string): SyncPath | null {
  const basePath = normalizeManagedBasePath(managedBasePath);
  const base = basePath === "/" ? "" : escapeRegExp(basePath);
  const tokenPattern = "([A-Za-z0-9_-]+)";
  const mainMatch = pathname.match(new RegExp(`^${base}/${tokenPattern}/$`));
  if (mainMatch) return { token: mainMatch[1]! };
  const fileMatch = pathname.match(new RegExp(`^${base}/${tokenPattern}/([^/]+)$`));
  if (fileMatch && isConfigFileName(fileMatch[2]!)) return { token: fileMatch[1]!, fileName: fileMatch[2]! };
  return null;
}

export function managedBasePathFromConfig(config: AppConfig, requestUrl: string): string {
  return normalizeManagedBasePath(managedBaseUrl(config, requestUrl).pathname);
}

export function managedSubscriptionUrl(config: AppConfig, requestUrl: string, token: string): string {
  const managed = managedBaseUrl(config, requestUrl);
  managed.pathname = joinManagedBasePath(managed.pathname, token);
  managed.search = "";
  managed.hash = "";
  return managed.toString();
}

export function managedSubscriptionUrlForRequest(config: AppConfig, requestUrl: string): string {
  const request = new URL(requestUrl);
  const managed = managedBaseUrl(config, requestUrl);
  const token = extractSubscriptionToken(request.pathname, normalizeManagedBasePath(managed.pathname)) ?? "";
  return managedSubscriptionUrl(config, requestUrl, token);
}

function managedBaseUrl(config: AppConfig, requestUrl: string): URL {
  const request = new URL(requestUrl);
  const base = config.settings.managedBaseUrl || `${request.origin}/sync`;
  return new URL(base, request.origin);
}

function joinManagedBasePath(pathname: string, token: string): string {
  const basePath = normalizeManagedBasePath(pathname);
  const tokenPath = syncPathForToken(token);
  return basePath === "/" ? tokenPath : `${basePath}${tokenPath}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
