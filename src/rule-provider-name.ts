import type { RuleSetDownloadBucket } from "./rule-set-types";

const PROVIDER_NAME_MAX_PREFIX_CHARS = 48;
const FNV64_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

export function compiledRuleProviderName(outputName: string, bucket: RuleSetDownloadBucket): string {
  const normalizedName = outputName.normalize("NFC").trim();
  const readable = Array.from(normalizedName.normalize("NFKC")
    .replace(/[^\p{L}\p{N}_]+/gu, "_")
    .replace(/^_+|_+$/g, "") || "RuleSet")
    .slice(0, PROVIDER_NAME_MAX_PREFIX_CHARS)
    .join("");
  return `${readable}_${stableNameHash(normalizedName)}_${providerBucketSuffix(bucket)}`;
}

function providerBucketSuffix(bucket: RuleSetDownloadBucket): string {
  if (bucket === "domain") return "Domain";
  if (bucket === "ipcidr") return "IPCIDR";
  if (bucket === "combined") return "Combined";
  return "Classical";
}

function stableNameHash(value: string): string {
  let hash = FNV64_OFFSET_BASIS;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV64_PRIME) & UINT64_MASK;
  }
  return hash.toString(36).padStart(13, "0");
}
