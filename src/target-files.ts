import type { Target } from "./types";
const FILES: Record<Target, string> = { surge: "SubPilot.conf", clash: "SubPilot.yaml", "sing-box": "SubPilot.json" };
export function configFileNameForTarget(target: Target): string { return FILES[target]; }
