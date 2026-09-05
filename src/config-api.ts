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
import { validateSurgeHosts } from "./surge-hosts";
import { validateSurgeUrlRewrite } from "./surge-url-rewrite";
import { validateSurgeMapLocal } from "./surge-map-local";
import { validateSurgeRules } from "./surge-rules";
import type { RenderConfig } from "./types";

export function validateConfigForSave(config: RenderConfig): string | null {
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
      || validateSurgeHosts(config)
      || validateSurgeUrlRewrite(config)
      || validateSurgeMapLocal(config);
  } catch {
    return "配置格式无效";
  }
}

export function mergeConfigPatch(
  config: RenderConfig,
  patch: Partial<RenderConfig>
): RenderConfig {
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
  current: RenderConfig["surge"],
  patch: Partial<RenderConfig["surge"]> | undefined
): RenderConfig["surge"] {
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
  current: RenderConfig["clash"],
  patch: Partial<RenderConfig["clash"]> | undefined
): RenderConfig["clash"] {
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
  config: RenderConfig,
  patch: Partial<RenderConfig>
): RenderConfig {
  return config;
}

function mergeStashPatch(
  current: RenderConfig["stash"],
  patch: Partial<RenderConfig["stash"]> | undefined
): RenderConfig["stash"] {
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
  current: RenderConfig["ruleSets"],
  patch: Partial<RenderConfig["ruleSets"]> | undefined
): RenderConfig["ruleSets"] {
  if (!patch || typeof patch !== "object") return current;
  return {
    mode: patch.mode === "compiled" || patch.mode === "manual" ? patch.mode : current.mode,
    aggregateByPolicy: typeof patch.aggregateByPolicy === "boolean" ? patch.aggregateByPolicy : current.aggregateByPolicy,
    sources: Array.isArray(patch.sources) ? patch.sources : current.sources,
    outputs: Array.isArray(patch.outputs) ? patch.outputs : current.outputs,
    directRules: Array.isArray(patch.directRules) ? patch.directRules : current.directRules
  };
}
