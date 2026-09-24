import { configDocument, renderConfig } from "./config-document";
import { loadConfig } from "./config-store";
import { ruleCompilationMode, workerFallbackConfig } from "./rule-compilation-mode";
import { ruleSetOutputFingerprint } from "./rule-set-compiler-core";
import { effectiveRuleSetOutputs, ruleSetOutputNeedsCompilation } from "./rule-set-outputs";
import type { RuleSetOutput } from "./rule-set-types";
import type { RenderConfig } from "./types";

/** Saved-config callers must revalidate their snapshot before publishing artifacts. */
export function createRuleSetPublicationGuard(
  env: Env,
  config: RenderConfig,
  options: { workerFallback?: boolean } = {}
): (output: RuleSetOutput) => Promise<boolean> {
  const selected = options.workerFallback ? workerFallbackConfig(config) : config;
  const target = selected.renderTarget ?? "surge";
  const mode = ruleCompilationMode(selected);
  return async (output) => {
    if (mode === "actions" || selected.ruleSets.mode !== "compiled") return false;
    const fingerprint = await ruleSetOutputFingerprint(selected, output);
    const saved = renderConfig(configDocument(await loadConfig(env)), target);
    const latest = options.workerFallback ? workerFallbackConfig(saved) : saved;
    if (latest.ruleSets.mode !== "compiled" || ruleCompilationMode(latest) !== mode) return false;
    const current = effectiveRuleSetOutputs(latest.ruleSets).find((item) => item.name === output.name);
    return Boolean(current && ruleSetOutputNeedsCompilation(latest.ruleSets, current, target)
      && await ruleSetOutputFingerprint(latest, current) === fingerprint);
  };
}
