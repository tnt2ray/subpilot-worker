import type { Target } from "./types";

const CONFIG_FILE_NAMES = new Set([
  "SubPilot.conf",
  "SubPilot.yaml",
  "subpilot-stash.yaml"
]);

export function configFileNameForTarget(target: Target): string {
  switch (target) {
    case "surge":
      return "SubPilot.conf";
    case "clash":
      return "SubPilot.yaml";
    case "stash":
      return "subpilot-stash.yaml";
    case "shadowrocket":
      return "SubPilot.yaml";
  }
}

export function isConfigFileName(value: string): boolean {
  return CONFIG_FILE_NAMES.has(value);
}

export function syncPathForToken(token: string): string {
  const encodedToken = encodeURIComponent(token);
  return `/${encodedToken}/`;
}
