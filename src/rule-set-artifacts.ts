import type {
  RuleSetBucket,
  RuleSetDownloadBucket,
  RuleSetOutputTarget
} from "./rule-set-types";

export const SPECIALIZED_RULE_SET_MIN_RULES = 1000;

export interface RuleSetArtifact {
  bucket: Extract<RuleSetDownloadBucket, "domain" | "ipcidr" | "combined">;
  behavior: RuleSetBucket;
  includesDomains: boolean;
  includesIpCidr: boolean;
}

interface RuleSetBucketCount {
  bucket: RuleSetBucket;
  count: number;
  targets?: RuleSetOutputTarget[];
  targetCounts?: Partial<Record<RuleSetOutputTarget, number>>;
}

export function planRuleSetArtifacts(
  buckets: readonly RuleSetBucketCount[],
  target: RuleSetOutputTarget,
  providerBehavior?: RuleSetBucket,
  surgeType?: "RULE-SET" | "DOMAIN-SET"
): RuleSetArtifact[] {
  const countByBucket = new Map(buckets.map((item) => [
    item.bucket,
    item.targets && !item.targets.includes(target) ? 0 : item.targetCounts?.[target] ?? item.count
  ]));
  const domainCount = countByBucket.get("domain") ?? 0;
  const ipCidrCount = countByBucket.get("ipcidr") ?? 0;
  const classicalCount = countByBucket.get("classical") ?? 0;
  if (target === "surge" && surgeType) {
    if (domainCount + ipCidrCount + classicalCount === 0) return [];
    return [{ bucket: surgeType === "DOMAIN-SET" ? "domain" : "combined", behavior: surgeType === "DOMAIN-SET" ? "domain" : "classical",
      includesDomains: true, includesIpCidr: surgeType === "RULE-SET" && ipCidrCount > 0 }];
  }
  if (target === "clash" && providerBehavior) {
    if (domainCount + ipCidrCount + classicalCount === 0) return [];
    return [{ bucket: providerBehavior === "classical" ? "combined" : providerBehavior, behavior: providerBehavior,
      includesDomains: providerBehavior !== "ipcidr", includesIpCidr: providerBehavior !== "domain" }];
  }
  const useDomainProvider = domainCount > SPECIALIZED_RULE_SET_MIN_RULES;
  const useIpCidrProvider = target !== "surge" && ipCidrCount > SPECIALIZED_RULE_SET_MIN_RULES;
  const artifacts: RuleSetArtifact[] = [];

  if (useDomainProvider) {
    artifacts.push({
      bucket: "domain",
      behavior: "domain",
      includesDomains: true,
      includesIpCidr: false
    });
  }
  if (useIpCidrProvider) {
    artifacts.push({
      bucket: "ipcidr",
      behavior: "ipcidr",
      includesDomains: false,
      includesIpCidr: true
    });
  }
  if (
    classicalCount > 0
    || (domainCount > 0 && !useDomainProvider)
    || (ipCidrCount > 0 && !useIpCidrProvider)
  ) {
    artifacts.push({
      bucket: "combined",
      behavior: "classical",
      includesDomains: domainCount > 0 && !useDomainProvider,
      includesIpCidr: ipCidrCount > 0 && !useIpCidrProvider
    });
  }
  return artifacts;
}
