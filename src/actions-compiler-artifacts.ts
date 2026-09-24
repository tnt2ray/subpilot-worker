import { createHash } from "node:crypto";
import type { RenderConfig, ActionsCompilationSettings, Target } from "./types";

export type ActionsBucket = "domain" | "ipcidr" | "combined" | "dns";
export const ACTIONS_COMPILER_PROTOCOL = "2";
export const ACTIONS_OUTPUT_BRANCH = "rules";
export const ACTIONS_WORKFLOW_FILENAME = "compile-rule-sets.yml";
export const ACTIONS_CLIENT_DIRECTORIES: Record<Target, string> = { surge: "Surge", clash: "Clash", "sing-box": "Sing-Box" };

export function actionsOutputKey(target: Target, outputName: string): string {
  return createHash("sha256").update(JSON.stringify([target, outputName.normalize("NFC")])).digest("hex");
}

/** Preserve readable names while isolating clients and disambiguating unsafe names. */
export function actionsArtifactDirectory(target: Target, outputName: string): string {
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
  if (!name || name !== normalized || name.toLowerCase() === "readme.md") name = `${name || "rule-set"}~${actionsOutputKey(target, outputName).slice(0, 12)}`;
  return `${ACTIONS_CLIENT_DIRECTORIES[target]}/${name}`;
}

export function actionsArtifactPath(target: Target, outputName: string, bucket: ActionsBucket | "manifest"): string {
  const names: Record<ActionsBucket, string> = { combined: "routing", domain: "domains", ipcidr: "ip-ranges", dns: "dns-domains" };
  const extension = target === "sing-box" ? "srs" : target === "clash" ? "yaml" : "list";
  return `${actionsArtifactDirectory(target, outputName)}/${bucket === "manifest" ? "manifest.json" : `${names[bucket]}.${extension}`}`;
}

/** Client rule URLs follow the output branch across recompilations. */
export function githubActionsArtifactUrl(config: RenderConfig, outputName: string, bucket: ActionsBucket): string {
  return githubActionsUrl(config, outputName, bucket, ACTIONS_OUTPUT_BRANCH);
}

/** Publication verification still reads the exact commit reported by Actions. */
export function githubActionsManifestUrl(config: RenderConfig, outputName: string, commit: string): string {
  return githubActionsUrl(config, outputName, "manifest", commit);
}

function githubActionsUrl(config: RenderConfig, outputName: string, bucket: ActionsBucket | "manifest", ref: string): string {
  const repository = config.settings.actionsCompilation!.repository.split("/").map(encodeURIComponent).join("/");
  const path = actionsArtifactPath(config.renderTarget ?? "surge", outputName, bucket).split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${repository}/${encodeURIComponent(ref)}/${path}`;
}

export function actionsCompilerProtocolKey(settings: ActionsCompilationSettings): string {
  const identity = createHash("sha256").update(JSON.stringify([settings.repository.toLowerCase(), settings.ref, ACTIONS_WORKFLOW_FILENAME])).digest("hex");
  return `integration:actions-compiler:protocol:${identity}`;
}
