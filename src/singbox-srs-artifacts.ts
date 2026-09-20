import { createHash } from "node:crypto";
import type { RenderConfig, SingboxSrsSettings } from "./types";

export type SrsBucket = "domain" | "ipcidr" | "combined" | "dns";
export const SRS_BATCH_PROTOCOL = "3";

/** Internal output identity; public paths use the rule-set name. */
export function srsOutputKey(outputName: string): string {
  return createHash("sha256").update(outputName.normalize("NFC")).digest("hex");
}

/** Preserve common names, including Chinese; reserve ~ for disambiguation. */
export function srsArtifactDirectory(outputName: string): string {
  const normalized = outputName.normalize("NFC");
  let cleaned = normalized.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^[.-]+|[.-]+$/g, "");
  if (/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(cleaned)) cleaned = `rule-set-${cleaned}`;
  const encoder = new TextEncoder();
  let name = "";
  for (const character of cleaned) {
    if (encoder.encode(name + character).length > 120) break;
    name += character;
  }
  name = name.replace(/[.-]+$/g, "");
  if (!name || name !== normalized || name.toLowerCase() === "readme.md") {
    name = `${name || "rule-set"}~${srsOutputKey(outputName).slice(0, 12)}`;
  }
  return `rule-sets/${name}`;
}

export function srsArtifactPath(outputName: string, bucket: SrsBucket | "manifest"): string {
  const filenames: Record<SrsBucket, string> = {
    combined: "routing.srs", domain: "domains.srs", ipcidr: "ip-ranges.srs", dns: "dns-domains.srs"
  };
  return `${srsArtifactDirectory(outputName)}/${bucket === "manifest" ? "manifest.json" : filenames[bucket]}`;
}

export function githubSrsUrl(config: RenderConfig, outputName: string, bucket: SrsBucket | "manifest", ref?: string): string {
  const settings = config.settings.singboxSrs!;
  const repository = settings.repository.split("/").map(encodeURIComponent).join("/");
  const revision = ref ? encodeURIComponent(ref) : `refs/heads/${encodeURIComponent(settings.outputBranch)}`;
  const path = srsArtifactPath(outputName, bucket).split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${repository}/${revision}/${path}`;
}

export function srsBatchProtocolKey(settings: SingboxSrsSettings): string {
  const identity = createHash("sha256").update(JSON.stringify([settings.repository.toLowerCase(), settings.ref, settings.workflow])).digest("hex");
  return `integration:singbox-srs:batch-protocol:${identity}`;
}
