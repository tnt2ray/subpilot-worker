import type { RuleSetDownloadBucket, RuleSetOutputTarget } from "./rule-set-types";
import type { RenderConfig, Target } from "./types";
import type { SurgeProfileTag } from "./surge-capabilities";

export type SyncPath = { token: string } & (
  | { target: Target; surgeProfile?: SurgeProfileTag; ruleSet?: never }
  | { ruleSet: RuleSetSyncPath; target?: never; surgeProfile?: never }
);

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
  const surgeMatch = pathname.match(new RegExp(`^${base}/${tokenPattern}/surge/(stable|tf)/$`));
  if (surgeMatch) return { token: surgeMatch[1]!, target: "surge", surgeProfile: surgeMatch[2] as SurgeProfileTag };
  const targetMatch = pathname.match(new RegExp(`^${base}/${tokenPattern}/(surge|clash|sing-box)/$`));
  if (targetMatch) return { token: targetMatch[1]!, target: targetMatch[2] as Target };
  const namedRuleSetMatch = pathname.match(new RegExp(`^${base}/${tokenPattern}/r/([^/]+?)\\.(list|json|yaml)$`));
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

export function managedBasePathFromConfig(config: RenderConfig, requestUrl: string): string {
  return normalizeManagedBasePath(managedBaseUrl(config, requestUrl).pathname);
}

export function managedSubscriptionUrl(config: RenderConfig, requestUrl: string, token: string, target: Target, surgeProfile: SurgeProfileTag = "stable"): string {
  const managed = managedBaseUrl(config, requestUrl);
  const targetPath = target === "surge" ? `surge/${surgeProfile}/` : `${target}/`;
  managed.pathname = joinManagedRelativePath(managed.pathname, `${encodeURIComponent(token)}/${targetPath}`);
  managed.search = "";
  managed.hash = "";
  return managed.toString();
}

export function managedSubscriptionUrlForRequest(config: RenderConfig, requestUrl: string, target: Target, surgeProfile: SurgeProfileTag = "stable"): string {
  const request = new URL(requestUrl);
  const managed = managedBaseUrl(config, requestUrl);
  const token = extractSubscriptionToken(request.pathname, normalizeManagedBasePath(managed.pathname)) ?? "";
  return managedSubscriptionUrl(config, requestUrl, token, target, surgeProfile);
}

export function managedRuleSetUrlForRequest(
  config: RenderConfig,
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
  config: RenderConfig,
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

function managedBaseUrl(config: RenderConfig, requestUrl: string): URL {
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
  if (target === "sing-box") return "json";
  return "yaml";
}

function ruleSetTargetForExtension(extension: string): RuleSetOutputTarget {
  if (extension === "list") return "surge";
  if (extension === "json") return "sing-box";
  return "clash";
}
