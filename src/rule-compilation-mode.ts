import type { RenderConfig, RuleCompilationMode } from "./types";

/** Resolve legacy Actions settings without requiring a persisted migration. */
export function ruleCompilationMode(config: {
  settings?: {
    ruleCompilationMode?: RuleCompilationMode;
    actionsCompilation?: { enabled?: boolean };
  };
}): RuleCompilationMode {
  const mode = config.settings?.ruleCompilationMode;
  if (mode === "worker" || mode === "wasm" || mode === "actions") return mode;
  return config.settings?.actionsCompilation?.enabled === true ? "actions" : "worker";
}

/** An in-memory execution view; the saved preferred compiler remains unchanged. */
export function workerFallbackConfig(config: RenderConfig): RenderConfig {
  return {
    ...config,
    settings: {
      ...config.settings,
      ruleCompilationMode: "worker",
      ...(config.settings.actionsCompilation ? {
        actionsCompilation: { ...config.settings.actionsCompilation, enabled: false }
      } : {})
    }
  };
}
