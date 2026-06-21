import type { Target } from "./types";

export function configFileNameForTarget(target: Target): string {
  switch (target) {
    case "surge":
      return "SubPilot.conf";
    case "clash":
      return "SubPilot.yaml";
  }
}

export function syncPathForToken(token: string): string {
  const encodedToken = encodeURIComponent(token);
  return `/${encodedToken}/`;
}
