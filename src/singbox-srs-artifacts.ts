import { createHash } from "node:crypto";
import type { RenderConfig } from "./types";

export type SrsBucket = "domain" | "ipcidr" | "combined" | "dns";

/** Public paths omit output names and stay stable across source revisions. */
export function srsOutputKey(outputName: string): string {
  return createHash("sha256").update(outputName.normalize("NFC")).digest("hex");
}

export function srsArtifactPath(outputName: string, bucket: SrsBucket | "manifest"): string {
  return `rules/${srsOutputKey(outputName)}/${bucket === "manifest" ? "manifest.json" : `${bucket}.srs`}`;
}

export function githubSrsUrl(config: RenderConfig, outputName: string, bucket: SrsBucket | "manifest", ref?: string): string {
  const settings = config.settings.singboxSrs!;
  const repository = settings.repository.split("/").map(encodeURIComponent).join("/");
  const revision = ref ? encodeURIComponent(ref) : `refs/heads/${encodeURIComponent(settings.outputBranch)}`;
  return `https://raw.githubusercontent.com/${repository}/${revision}/${srsArtifactPath(outputName, bucket)}`;
}
