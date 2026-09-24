import { sha256Hex } from "./util";
import { compileRuleSetContent, ruleSetOutputFingerprint, type RuleCompilationConfig } from "./rule-set-compiler-core";
import { planRuleSetArtifacts } from "./rule-set-artifacts";
import { renderCombinedRuleSet, renderCompiledRuleSetBucket, renderSingboxRules } from "./rule-set-renderer";
import { renderRuleSetRuleForTarget } from "./rule-targets";
import { createSingboxAsnResolver } from "./singbox-asn";
import type { RuleSetOutput, RuleSetSource } from "./rule-set-types";
import type { RuleSetSourceFetchResult } from "./rule-set-cache";
import type { Target } from "./types";
import type { RuleSetAggregator } from "./rule-set-kernel";
export { actionsArtifactDirectory, actionsArtifactPath, actionsOutputKey, ACTIONS_CLIENT_DIRECTORIES, ACTIONS_OUTPUT_BRANCH, ACTIONS_COMPILER_PROTOCOL } from "./actions-compiler-artifacts";
export { ruleSetOutputFingerprint } from "./rule-set-compiler-core";
export { createRuleSetAggregator, RULE_KERNEL_MAX_BYTES } from "./rule-set-kernel";
declare const __RULE_KERNEL_SHA256__: string;
export const RULE_KERNEL_SHA256 = __RULE_KERNEL_SHA256__;

/** Runner-local cache for public ASN responses; no Worker bindings or credentials. */
export function createActionAsnResolver() {
  const values = new Map<string, string>();
  const environment = { SUBPILOT_CONFIG: {
    async get<T>(key: string, _type: "json"): Promise<T | null> { return values.has(key) ? JSON.parse(values.get(key)!) as T : null; },
    async put(key: string, value: string) { values.set(key, value); }
  } };
  let resolver: ReturnType<typeof createSingboxAsnResolver> | undefined;
  return (value: string) => (resolver ??= createSingboxAsnResolver(environment))(value);
}
export async function compileActionRuleSet(
  config: RuleCompilationConfig,
  output: RuleSetOutput,
  fingerprint: string,
  loadSource: (source: RuleSetSource) => Promise<RuleSetSourceFetchResult>,
  asnResolver: ReturnType<typeof createSingboxAsnResolver>,
  aggregateRules: RuleSetAggregator
) {
  if (await ruleSetOutputFingerprint(config, output) !== fingerprint) throw new Error("Compiler inputs do not match the job fingerprint");
  const { manifest, buckets, stale } = await compileRuleSetContent(config, output, { loadSource, asnResolver, aggregateRules });
  if (stale) throw new Error("Compilation requires complete current source data");
  const target = config.renderTarget as Target;
  if (manifest.buckets.some((bucket) => bucket.targetCounts?.[target] !== bucket.count)) throw new Error("Rules cannot be represented by the target client");
  const artifacts = planRuleSetArtifacts(manifest.buckets, target, manifest.provider?.behavior, manifest.surgeType).map((artifact) => ({
    bucket: artifact.bucket as "combined" | "domain" | "ipcidr" | "dns",
    content: artifact.bucket === "combined" ? renderCombinedRuleSet(buckets, target, artifact, false) : renderCompiledRuleSetBucket(buckets[artifact.bucket], artifact.bucket, target, false)
  }));
  if (manifest.dnsRuleCount !== undefined) {
    const rules = [...buckets.domain, ...buckets.classical].filter((rule) => ["DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "DOMAIN-REGEX", "DOMAIN-WILDCARD"].includes(rule.type) && renderRuleSetRuleForTarget(rule.raw, "sing-box") !== null);
    manifest.dnsRuleCount = rules.length;
    if (rules.length) artifacts.push({ bucket: "dns", content: renderSingboxRules(rules, false) });
  }
  const hashes = manifest.sourceContentHashes ?? {};
  const sourceContentFingerprint = await sha256Hex(JSON.stringify(Object.keys(hashes).sort().map((key) => [key, hashes[key]])));
  // Publication metadata must not disclose source addresses, credentials or raw diagnostic text.
  return { artifacts, manifest: { outputFingerprint: fingerprint, updatedAt: manifest.updatedAt, ruleCount: manifest.ruleCount,
    duplicateCount: manifest.duplicateCount, buckets: manifest.buckets, sourceContentFingerprint,
    warningCount: manifest.warnings.length,
    ...(manifest.dnsRuleCount !== undefined ? { dnsRuleCount: manifest.dnsRuleCount } : {}),
    ...(manifest.asnExpiresAt !== undefined ? { asnExpiresAt: manifest.asnExpiresAt } : {}) } };
}
