import { validateManagedBaseUrl, validateProxyPolicyNameConflicts, validateRuleSetOutputNames } from "./config-validation";
import { ruleTargetIndex } from "./rule-targets";
import { splitRuleLine } from "./rule-line";
import { validateSurgeHosts } from "./surge-hosts";
import { validateStashScripts } from "./stash-scripts";
import { validateSurgeUrlRewrite } from "./surge-url-rewrite";
import { validateSurgeMapLocal } from "./surge-map-local";
import { SURGE_BUILT_IN_POLICIES, validateSurgeRules } from "./surge-rules";
import type { AppConfig } from "./types";

export function validateConfigForSave(config: AppConfig): string | null {
  return validateProxyPolicyNameConflicts(config)
    || validateManagedBaseUrl(config)
    || validateRuleSetOutputNames(config)
    || validateSurgeRules(config)
    || validateSurgeHosts(config)
    || validateSurgeUrlRewrite(config)
    || validateSurgeMapLocal(config)
    || validateStashScripts(config);
}

export function mergeConfigPatch(
  config: AppConfig,
  patch: Partial<AppConfig>
): AppConfig {
  return {
    ...config,
    settings: patch.settings && typeof patch.settings === "object"
      ? { ...config.settings, ...patch.settings }
      : config.settings,
    groups: patch.groups && typeof patch.groups === "object"
      ? patch.groups
      : config.groups,
    disabledGroups: Array.isArray(patch.disabledGroups)
      ? patch.disabledGroups
      : config.disabledGroups,
    sources: Array.isArray(patch.sources) ? patch.sources : config.sources,
    proxyNodes: Array.isArray(patch.proxyNodes) ? patch.proxyNodes : config.proxyNodes,
    chain: patch.chain && typeof patch.chain === "object"
      ? { ...config.chain, ...patch.chain }
      : config.chain,
    ruleSets: mergeRuleSetsPatch(config.ruleSets, patch.ruleSets),
    surge: patch.surge && typeof patch.surge === "object"
      ? { ...config.surge, ...patch.surge }
      : config.surge,
    clash: patch.clash && typeof patch.clash === "object"
      ? { ...config.clash, ...patch.clash }
      : config.clash,
    stash: mergeStashPatch(config.stash, patch.stash)
  };
}

export function sanitizeConfigAfterPatch(
  config: AppConfig,
  patch: Partial<AppConfig>
): AppConfig {
  if (!("groups" in patch) && !("disabledGroups" in patch)) return config;
  const rules = sanitizeRuleTargets(config);
  return {
    ...config,
    ruleSets: sanitizeRuleSetTargets(config, rules.availablePolicies),
    surge: { ...config.surge, rules: rules.surge },
    clash: { ...config.clash, rules: rules.clash },
    stash: { ...config.stash, rules: rules.stash }
  };
}

function mergeStashPatch(
  current: AppConfig["stash"],
  patch: Partial<AppConfig["stash"]> | undefined
): AppConfig["stash"] {
  if (!patch || typeof patch !== "object") return current;
  return {
    ...current,
    ...patch,
    tun: patch.tun && typeof patch.tun === "object"
      ? { ...current.tun, ...patch.tun }
      : current.tun,
    dns: patch.dns && typeof patch.dns === "object"
      ? { ...current.dns, ...patch.dns }
      : current.dns,
    mitm: patch.mitm && typeof patch.mitm === "object"
      ? { ...current.mitm, ...patch.mitm }
      : current.mitm
  };
}

function mergeRuleSetsPatch(
  current: AppConfig["ruleSets"],
  patch: Partial<AppConfig["ruleSets"]> | undefined
): AppConfig["ruleSets"] {
  if (!patch || typeof patch !== "object") return current;
  return {
    mode: patch.mode === "compiled" || patch.mode === "manual" ? patch.mode : current.mode,
    aggregateByPolicy: typeof patch.aggregateByPolicy === "boolean" ? patch.aggregateByPolicy : current.aggregateByPolicy,
    sources: Array.isArray(patch.sources) ? patch.sources : current.sources,
    outputs: Array.isArray(patch.outputs) ? patch.outputs : current.outputs,
    directRules: Array.isArray(patch.directRules) ? patch.directRules : current.directRules
  };
}

function sanitizeRuleTargets(config: AppConfig): { surge: string[]; clash: string[]; stash: string[]; availablePolicies: Set<string> } {
  const disabledGroups = new Set(config.disabledGroups);
  const groupNames = Object.keys(config.groups).filter((name) => !disabledGroups.has(name));
  const availablePolicies = new Set([
    ...groupNames,
    ...SURGE_BUILT_IN_POLICIES
  ]);
  return {
    surge: rewriteRulesToAvailablePolicies(config.surge.rules, availablePolicies),
    clash: rewriteRulesToAvailablePolicies(config.clash.rules, availablePolicies),
    stash: rewriteRulesToAvailablePolicies(config.stash.rules, availablePolicies),
    availablePolicies
  };
}

function sanitizeRuleSetTargets(config: AppConfig, availablePolicies: Set<string>): AppConfig["ruleSets"] {
  return {
    ...config.ruleSets,
    outputs: config.ruleSets.outputs.map((output) => ({
      ...output,
      policy: rewritePolicyToAvailable(output.policy, availablePolicies)
    })),
    directRules: config.ruleSets.directRules.map((rule) => ({
      ...rule,
      policy: rewritePolicyToAvailable(rule.policy, availablePolicies)
    }))
  };
}

function rewritePolicyToAvailable(policy: string, availablePolicies: Set<string>): string {
  return policy && (availablePolicies.has(policy) || isDevicePolicy(policy)) ? policy : "Proxy";
}

function rewriteRulesToAvailablePolicies(
  rules: string[],
  availablePolicies: Set<string>,
  options: { allowDevicePolicy?: boolean } = {}
): string[] {
  return rules.map((rule) => {
    const parts = splitRuleLine(rule);
    const targetIndex = ruleTargetIndex(parts);
    if (targetIndex === null) return rule;
    const target = parts[targetIndex]?.trim() ?? "";
    if (!target || availablePolicies.has(target) || (options.allowDevicePolicy !== false && isDevicePolicy(target))) return rule;
    parts[targetIndex] = "Proxy";
    return parts.join(",");
  });
}

function isDevicePolicy(policy: string): boolean {
  return /^DEVICE:[^,\r\n[\]]+$/i.test(policy);
}
