import type { Target } from "./types";

export const RULE_SET_BUCKETS = ["domain", "ipcidr", "classical"] as const;
export const RULE_SET_TARGETS = ["surge", "clash", "sing-box"] as const;
export const RULE_SET_SOURCE_FORMATS = [
  "auto",
  "surge-rule-set",
  "surge-domain-set",
  "clash-yaml",
  "sing-box-binary",
  "plain-domain",
  "plain-ipcidr",
  "plain-classical"
] as const;

export type RuleSetBucket = typeof RULE_SET_BUCKETS[number];
export type RuleSetDownloadBucket = RuleSetBucket | "combined" | "dns";
export type RuleSetOutputTarget = Target | "stash";
export type RuleSetMode = "manual" | "compiled";
export type RuleSetSourceFormat = typeof RULE_SET_SOURCE_FORMATS[number];

export interface RuleSetSource {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  format: RuleSetSourceFormat;
  order: number;
}

export interface RuleSetOutput {
  /** Resolver address for Surge/Mihomo; existing DNS server tag for sing-box. */
  dnsServer?: string;
  surgeType?: "RULE-SET" | "DOMAIN-SET";
  /** Explicit Clash provider settings; all URLs in this row share one artifact. */
  provider?: { behavior: RuleSetBucket; interval: number };
  /** Stable download name used by published URLs and compiled caches. */
  name: string;
  enabled: boolean;
  policy: string;
  sourceIds: string[];
  inlineRules: string[];
  order: number;
  surgeOptions: string[];
  updatedAt?: string | undefined;
}

export interface RuleSetDirectRule {
  id: string;
  enabled: boolean;
  rule: string;
  policy: string;
  order: number;
}

export interface RuleSetConfig {
  mode: RuleSetMode;
  aggregateByPolicy: boolean;
  sources: RuleSetSource[];
  outputs: RuleSetOutput[];
  directRules: RuleSetDirectRule[];
}
