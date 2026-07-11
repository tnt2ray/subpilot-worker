import type { RuleSetConfig, RuleSetOutput } from "./rule-set-types";

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
    const policy = output.policy.trim() || "Proxy";
    const existing = plans.get(policy);
    if (!existing) {
      plans.set(policy, {
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
    existing.output.inlineRules.push(...output.inlineRules);
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
