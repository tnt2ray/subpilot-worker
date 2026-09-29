import { OUTPUT_TARGETS, renderConfig } from "./config-document";
import { assertSafeConfigText } from "./config-text-safety";
import { validateManagedBaseUrl, validateConfigEntityLimits, validateProxyPolicyNameConflicts, validateRuleSetOutputNames } from "./config-validation";
import type { AppConfig } from "./types";

/** Shared by normal saves and the explicit upgrade tool. */
export function validateDocumentForSave(document: AppConfig): string | null {
  try {
    for (const client of Object.values(document.clients)) for (const name of Object.keys(client.groups)) assertSafeConfigText(name, "Policy name");
    for (const source of document.sources) assertSafeConfigText({ id: source.id, name: source.name, url: source.url, fetchUserAgent: source.fetchUserAgent }, "Source");
    const managedError = validateManagedBaseUrl(document);
    if (managedError) return managedError;
    // Match errors belong to the target generation report; shape/size errors block storage.
    for (const target of OUTPUT_TARGETS) {
      const view = renderConfig(document, target);
      const error = validateConfigEntityLimits(view, { allowUnresolvedPolicies: true }) || validateProxyPolicyNameConflicts(view)
        || validateRuleSetOutputNames({ ruleSets: { ...view.ruleSets, mode: "manual" } });
      if (error) return error;
    }
    if (document.clients.singbox.inbounds.length > 100 || (Array.isArray(document.clients.singbox.route.rules) && document.clients.singbox.route.rules.length > 10_000)) return "sing-box 入站或路由规则超过数量限制。";
    for (const key of ["outbounds", "endpoints", "services", "http_clients", "certificate_providers", "network_namespaces"] as const) {
      if ((document.clients.singbox[key]?.length ?? 0) > 500) return `sing-box ${key} 超过数量限制。`;
    }
    return null;
  } catch { return "配置包含非法内容。"; }
}
