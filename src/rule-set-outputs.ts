import type { RuleSetConfig, RuleSetOutput, RuleSetOutputTarget, RuleSetSource } from "./rule-set-types";

export interface PlannedRuleSetOutput {
  output: RuleSetOutput;
  includedOutputNames: string[];
}

export function planRuleSetOutputs(ruleSets: RuleSetConfig, enabledOnly = true): PlannedRuleSetOutput[] {
  const outputs = ruleSets.outputs
    .filter((output) => !enabledOnly || output.enabled)
    .map((output, index) => ({ output, index }))
    .sort((left, right) => left.output.order - right.output.order || left.index - right.index);
  if (!ruleSets.aggregateByPolicy) {
    return outputs.map(({ output }) => ({ output, includedOutputNames: [output.name] }));
  }

  const plans = new Map<string, PlannedRuleSetOutput>();
  for (const { output } of outputs) {
    // Explicit providers merge URLs within their own row, retaining behavior,
    // refresh interval and matching position even when legacy aggregation is on.
    if (output.provider || output.surgeType || output.dnsServer) {
      plans.set(`provider\0${output.name}`, { output, includedOutputNames: [output.name] });
      continue;
    }
    const policy = output.policy.trim();
    const existing = plans.get(`policy\0${policy}`);
    if (!existing) {
      plans.set(`policy\0${policy}`, {
        output: {
          name: policy,
          enabled: true,
          policy,
          sourceIds: [...output.sourceIds],
          inlineRules: [...output.inlineRules],
          order: output.order,
          surgeOptions: [...output.surgeOptions]
        },
        includedOutputNames: [output.name]
      });
      continue;
    }
    existing.output.sourceIds = appendUnique(existing.output.sourceIds, output.sourceIds);
    for (const rule of output.inlineRules) existing.output.inlineRules.push(rule);
    existing.output.surgeOptions = appendUnique(existing.output.surgeOptions, output.surgeOptions);
    existing.includedOutputNames.push(output.name);
  }
  return [...plans.values()];
}

export function effectiveRuleSetOutputs(ruleSets: RuleSetConfig, enabledOnly = true): RuleSetOutput[] {
  return planRuleSetOutputs(ruleSets, enabledOnly).map((plan) => plan.output);
}

function appendUnique(current: string[], additions: string[]): string[] {
  const values = [...current];
  const seen = new Set(values);
  for (const value of additions) {
    if (seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  return values;
}

/** A single native source can be downloaded and refreshed by the client itself. */
export function directRuleSetSource(ruleSets: RuleSetConfig, output: RuleSetOutput, target: RuleSetOutputTarget): { url: string; format: "yaml" | "text"; surgeType?: "RULE-SET" | "DOMAIN-SET" } | null {
  if (output.inlineRules.length || !output.sourceIds.length) return null;
  const sources = output.sourceIds.map((id) => ruleSets.sources.find((source) => source.id === id));
  if (sources.some((source) => !source?.enabled || !source.url)) return null;
  const urls = new Set(sources.map((source) => source!.url));
  const formats = new Set(sources.map((source) => source!.format));
  if (urls.size !== 1 || formats.size !== 1) return null;
  const source = sources[0]!;
  if (target === "clash" && output.provider) {
    // Automatic sources must pass through content detection and compilation;
    // URL extensions do not establish the provider's actual format.
    if (source.format === "clash-yaml") return { url: source.url, format: "yaml" };
    const behavior = source.format.replace(/^plain-/, "");
    if (source.format.startsWith("plain-") && behavior === output.provider.behavior) return { url: source.url, format: "text" };
  }
  if (target === "surge" && !/[,\r\n]/.test(source.url)) {
    const surgeType = output.surgeType ?? (source.format === "surge-domain-set" ? "DOMAIN-SET" : source.format === "surge-rule-set" ? "RULE-SET" : undefined);
    if (surgeType && (source.format.startsWith("surge-") || source.format === "auto")) return { url: source.url, format: "text", surgeType };
  }
  return null;
}

export function compiledRuleSetSources(ruleSets: RuleSetConfig, target: RuleSetOutputTarget): RuleSetConfig["sources"] {
  if (ruleSets.mode !== "compiled") return [];
  const ids = new Set(effectiveRuleSetOutputs(ruleSets).filter((output) => ruleSetOutputNeedsCompilation(ruleSets, output, target)).flatMap((output) => output.sourceIds));
  return ruleSets.sources.filter((source) => source.enabled && source.url && ids.has(source.id)
    && !(target === "sing-box" && isSingboxBinarySource(source)));
}

export function isSingboxBinarySource(source: RuleSetSource): boolean {
  if (source.format === "sing-box-binary") return true;
  if (source.format !== "auto") return false;
  try { return /\.srs$/i.test(new URL(source.url).pathname); }
  catch { return false; }
}

/** Binary sets retain their native semantics and are never read by the compiler. */
export function nativeSingboxRuleSetSources(ruleSets: RuleSetConfig, output: RuleSetOutput): RuleSetSource[] {
  const sources = output.sourceIds.flatMap((id) => {
    const source = ruleSets.sources.find((item) => item.id === id);
    return source?.enabled && source.url && isSingboxBinarySource(source) ? [source] : [];
  });
  return [...new Map(sources.map((source) => [source.url, source])).values()];
}

export function ruleSetOutputNeedsCompilation(ruleSets: RuleSetConfig, output: RuleSetOutput, target: RuleSetOutputTarget): boolean {
  if (target !== "sing-box") return !directRuleSetSource(ruleSets, output, target);
  if (output.inlineRules.length || !output.sourceIds.length) return true;
  return output.sourceIds.some((id) => {
    const source = ruleSets.sources.find((item) => item.id === id);
    return !source?.enabled || !source.url || !isSingboxBinarySource(source);
  });
}
