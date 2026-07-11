import { describe, expect, it } from "vitest";
import { planRuleSetOutputs } from "../src/rule-set-outputs";
import type { RuleSetConfig, RuleSetOutput } from "../src/rule-set-types";

function output(name: string, policy: string, order: number, sourceIds: string[], surgeOptions: string[] = []): RuleSetOutput {
  return {
    name,
    enabled: true,
    policy,
    sourceIds,
    inlineRules: [`DOMAIN-SUFFIX,${name.toLowerCase()}.example`],
    order,
    surgeOptions
  };
}

describe("rule set output planning", () => {
  it("groups outputs by policy at their first position while preserving member order", () => {
    const ruleSets: RuleSetConfig = {
      mode: "compiled",
      aggregateByPolicy: true,
      sources: [],
      outputs: [
        output("AI", "Proxy", 4, ["ai"], ["extended-matching"]),
        output("Domestic", "DIRECT", 2, ["domestic"]),
        output("Media", "Proxy", 6, ["media", "ai"], ["no-resolve"]),
        { ...output("Disabled", "Proxy", 1, ["disabled"]), enabled: false }
      ],
      directRules: []
    };

    expect(planRuleSetOutputs(ruleSets)).toEqual([
      {
        output: {
          name: "DIRECT",
          enabled: true,
          policy: "DIRECT",
          sourceIds: ["domestic"],
          inlineRules: ["DOMAIN-SUFFIX,domestic.example"],
          order: 2,
          surgeOptions: []
        },
        includedOutputNames: ["Domestic"]
      },
      {
        output: {
          name: "Proxy",
          enabled: true,
          policy: "Proxy",
          sourceIds: ["ai", "media"],
          inlineRules: ["DOMAIN-SUFFIX,ai.example", "DOMAIN-SUFFIX,media.example"],
          order: 4,
          surgeOptions: ["extended-matching", "no-resolve"]
        },
        includedOutputNames: ["AI", "Media"]
      }
    ]);
  });
});
