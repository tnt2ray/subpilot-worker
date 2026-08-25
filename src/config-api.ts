import {
  validateCompiledFallbackTargets,
  validateCompiledRulePolicies,
  validateConfigEntityLimits,
  validateManagedBaseUrl,
  validateProxyPolicyNameConflicts,
  validateRuleSetOutputNames,
  validateTailscalePolicies
} from "./config-validation";
import { validateClashLikeRules } from "./clash-rules";
import {
  CLASH_BUILT_IN_RULE_POLICIES,
  ruleTargetIndex,
  STASH_BUILT_IN_RULE_POLICIES,
  SURGE_BUILT_IN_RULE_POLICIES
} from "./rule-targets";
import { splitRuleLine } from "./rule-line";
import { validateSurgeHosts } from "./surge-hosts";
import { validateStashScripts } from "./stash-scripts";
import { validateSurgeUrlRewrite } from "./surge-url-rewrite";
import { validateSurgeMapLocal } from "./surge-map-local";
import { validateSurgeRules } from "./surge-rules";
import type { AppConfig } from "./types";

export function validateConfigForSave(config: AppConfig): string | null {
  try {
    return validateConfigEntityLimits(config)
      || validateProxyPolicyNameConflicts(config)
      || validateTailscalePolicies(config)
      || validateManagedBaseUrl(config)
      || validateRuleSetOutputNames(config)
      || validateCompiledRulePolicies(config)
      || validateCompiledFallbackTargets(config)
      || validateSurgeRules(config)
      || validateClashLikeRules(config, "clash")
      || validateClashLikeRules(config, "stash")
      || validateSurgeHosts(config)
      || validateSurgeUrlRewrite(config)
      || validateSurgeMapLocal(config)
      || validateStashScripts(config);
  } catch {
    return "配置格式无效";
  }
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
    surge: mergeSurgePatch(config.surge, patch.surge),
    clash: mergeClashPatch(config.clash, patch.clash),
    stash: mergeStashPatch(config.stash, patch.stash)
  };
}

function mergeSurgePatch(
  current: AppConfig["surge"],
  patch: Partial<AppConfig["surge"]> | undefined
): AppConfig["surge"] {
  if (!patch || typeof patch !== "object") return current;
  return {
    ...current,
    ...patch,
    mitm: patch.mitm && typeof patch.mitm === "object"
      ? { ...current.mitm, ...patch.mitm }
      : current.mitm
  };
}

function mergeClashPatch(
  current: AppConfig["clash"],
  patch: Partial<AppConfig["clash"]> | undefined
): AppConfig["clash"] {
  if (!patch || typeof patch !== "object") return current;
  return {
    ...current,
    ...patch,
    tun: patch.tun && typeof patch.tun === "object"
      ? { ...current.tun, ...patch.tun }
      : current.tun
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
  const surgePolicies = new Set([
    ...groupNames,
    ...SURGE_BUILT_IN_RULE_POLICIES,
    ...config.surge.tailscaleNodes
      .filter((node) => node.enabled && typeof node.authKey === "string" && Boolean(node.authKey.trim()))
      .map((node) => node.name)
  ]);
  const clashPolicies = new Set([...groupNames, ...CLASH_BUILT_IN_RULE_POLICIES]);
  const stashPolicies = new Set([...groupNames, ...STASH_BUILT_IN_RULE_POLICIES]);
  const availablePolicies = new Set([
    ...surgePolicies,
    ...clashPolicies,
    ...stashPolicies
  ]);
  return {
    surge: rewriteRulesToAvailablePolicies(config.surge.rules, surgePolicies, { allowDevicePolicy: true }),
    clash: rewriteRulesToAvailablePolicies(config.clash.rules, clashPolicies, { allowDevicePolicy: false }),
    stash: rewriteRulesToAvailablePolicies(config.stash.rules, stashPolicies, { allowDevicePolicy: false }),
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
