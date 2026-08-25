import { isConfigFileName, syncPathForToken } from "./target-files";
import type { RuleSetDownloadBucket, RuleSetOutputTarget } from "./rule-set-types";
import type { AppConfig } from "./types";

export interface SyncPath {
  token: string;
  fileName?: string;
  ruleSet?: RuleSetSyncPath | undefined;
}

export interface RuleSetSyncPath {
  artifactName: string;
  target: RuleSetOutputTarget;
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
  const namedRuleSetMatch = pathname.match(new RegExp(`^${base}/${tokenPattern}/r/([^/]+?)\\.(list|stash\\.yaml|yaml)$`));
  if (namedRuleSetMatch) {
    const artifactName = safeDecodePathSegment(namedRuleSetMatch[2]!);
    if (!artifactName) return null;
    return {
      token: namedRuleSetMatch[1]!,
      ruleSet: {
        artifactName,
        target: ruleSetTargetForExtension(namedRuleSetMatch[3]!)
      }
    };
  }
  return null;
}

export function managedBasePathFromConfig(config: AppConfig, requestUrl: string): string {
  return normalizeManagedBasePath(managedBaseUrl(config, requestUrl).pathname);
}

export function managedSubscriptionUrl(config: AppConfig, requestUrl: string, token: string): string {
  const managed = managedBaseUrl(config, requestUrl);
  managed.pathname = joinManagedRelativePath(managed.pathname, syncPathForToken(token));
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

export function managedRuleSetUrlForRequest(
  config: AppConfig,
  requestUrl: string,
  outputName: string,
  bucket: RuleSetDownloadBucket,
  target: RuleSetOutputTarget
): string {
  const request = new URL(requestUrl);
  const managed = managedBaseUrl(config, requestUrl);
  const token = extractSubscriptionToken(request.pathname, normalizeManagedBasePath(managed.pathname)) ?? "";
  return managedRuleSetUrl(config, requestUrl, token, outputName, bucket, target);
}

export function managedRuleSetUrl(
  config: AppConfig,
  requestUrl: string,
  token: string,
  outputName: string,
  bucket: RuleSetDownloadBucket,
  target: RuleSetOutputTarget
): string {
  const managed = managedBaseUrl(config, requestUrl);
  const artifactName = ruleSetArtifactName(outputName, bucket);
  managed.pathname = joinManagedRelativePath(
    managed.pathname,
    `${token}/r/${encodeURIComponent(artifactName)}.${ruleSetExtension(target)}`
  );
  managed.search = "";
  managed.hash = "";
  return managed.toString();
}

export function ruleSetPathName(outputName: unknown): string {
  return String(outputName || "").normalize("NFC").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

export function ruleSetArtifactName(outputName: string, bucket: RuleSetDownloadBucket): string {
  const suffix = bucket === "domain" ? "-domain" : bucket === "ipcidr" ? "-ipcidr" : "";
  return `${ruleSetPathName(outputName)}${suffix}`;
}

function managedBaseUrl(config: AppConfig, requestUrl: string): URL {
  const request = new URL(requestUrl);
  const base = config.settings.managedBaseUrl || `${request.origin}/sync`;
  return new URL(base, request.origin);
}

function joinManagedRelativePath(pathname: string, relativePath: string): string {
  const basePath = normalizeManagedBasePath(pathname);
  const tokenPath = relativePath.startsWith("/") ? relativePath : `/${relativePath}`;
  return basePath === "/" ? tokenPath : `${basePath}${tokenPath}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeDecodePathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function ruleSetExtension(target: RuleSetOutputTarget): string {
  if (target === "surge") return "list";
  if (target === "stash") return "stash.yaml";
  return "yaml";
}

function ruleSetTargetForExtension(extension: string): RuleSetOutputTarget {
  if (extension === "list") return "surge";
  if (extension === "stash.yaml") return "stash";
  return "clash";
}
