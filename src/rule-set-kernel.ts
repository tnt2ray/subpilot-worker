import type { ParsedRuleSetRule, CompiledRuleSetRule } from "./rule-set-parser";
import type { RuleSetBucket } from "./rule-set-types";
import type { Target } from "./types";

export type AggregationRule = ParsedRuleSetRule & { asnExpansionKey?: string };
export interface RuleAggregationInput {
  operation: "aggregate";
  version: 1;
  target?: Target;
  rules: AggregationRule[];
  asnExpansions?: Record<string, AggregationRule[]>;
}
export interface RuleAggregationResult {
  version: 1;
  buckets: Record<RuleSetBucket, CompiledRuleSetRule[]>;
  duplicateCount: number;
  warnings: string[];
}
export type RuleSetAggregator = (input: RuleAggregationInput) => Promise<RuleAggregationResult>;
export const RULE_KERNEL_MAX_BYTES = 8 * 1024 * 1024;

/** Host-independent protocol: both runtimes execute the identical WASM bytes. */
export function createRuleSetAggregator(run: (input: Uint8Array) => Promise<Uint8Array>): RuleSetAggregator {
  return async (input) => {
    const bytes = new TextEncoder().encode(JSON.stringify(input));
    if (bytes.byteLength > RULE_KERNEL_MAX_BYTES) throw new Error("Rule aggregation input exceeds the size limit");
    const output = await run(bytes);
    if (output.byteLength > RULE_KERNEL_MAX_BYTES) throw new Error("Rule aggregation output exceeds the size limit");
    const result = JSON.parse(new TextDecoder().decode(output)) as RuleAggregationResult;
    if (result.version !== 1 || !Number.isSafeInteger(result.duplicateCount) || result.duplicateCount < 0
      || !["domain", "ipcidr", "classical"].every((bucket) => Array.isArray(result.buckets?.[bucket as RuleSetBucket]))
      || !Array.isArray(result.warnings) || !result.warnings.every((warning) => typeof warning === "string")) {
      throw new Error("Rule aggregation returned an invalid result");
    }
    return result;
  };
}
