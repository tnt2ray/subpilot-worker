import { parseGroupOption, splitGroupSpec } from "./policy-group-spec";
import type { ConfigDiagnostic, ProxyNode, RenderConfig } from "./types";

export type SurgeProfileTag = "stable" | "tf";

export interface SurgeClientProfile {
  tag: SurgeProfileTag;
  ios: { version: string | null; build: number | null };
  mac: { version: string | null; build: number | null };
}

const PROFILES: Record<SurgeProfileTag, SurgeClientProfile> = {
  stable: { tag: "stable", ios: { version: "5.22.0", build: null }, mac: { version: "6.9.0", build: null } },
  tf: { tag: "tf", ios: { version: null, build: 3823 }, mac: { version: null, build: 12250 } }
};

export function resolveSurgeProfileTag(value: string | null | undefined): SurgeProfileTag | null {
  return value === "stable" || value === "tf" ? value : null;
}

export function surgeClientProfile(tag: SurgeProfileTag = "stable"): SurgeClientProfile {
  return structuredClone(PROFILES[tag]);
}

interface FeatureRequirement {
  label: string;
  ios: { version: string | null; build: number };
  mac: { version: string | null; build: number };
}

// Conservative, observed build floors, not a conversion of the TestFlight marketing version.
// See docs/surge-compatibility.md for sources, limits and maintenance instructions.
const REQUIREMENTS = {
  smart: { label: "Smart 策略组", ios: { version: "5.11.0", build: 3730 }, mac: { version: "5.7.0", build: 7210 } },
  snell5: { label: "Snell 5", ios: { version: "5.15.0", build: 3730 }, mac: { version: "6.0.0", build: 7210 } },
  anytls: { label: "AnyTLS", ios: { version: "5.17.0", build: 3730 }, mac: { version: "6.4.3", build: 10320 } },
  trustTunnel: { label: "TrustTunnel", ios: { version: "5.18.0", build: 3730 }, mac: { version: "6.4.4", build: 10661 } },
  http2: { label: "HTTP/2 CONNECT 与自定义请求头", ios: { version: "5.20.0", build: 3765 }, mac: { version: "6.6.0", build: 11270 } },
  snell6: { label: "Snell 6", ios: { version: "5.20.0", build: 3765 }, mac: { version: "6.7.0", build: 11730 } },
  tailscale: { label: "Tailscale", ios: { version: "5.20.0", build: 3765 }, mac: { version: "6.7.0", build: 11730 } },
  tailscaleSession: { label: "Tailscale idle-keepalive", ios: { version: "5.21.0", build: 3791 }, mac: { version: "6.8.0", build: 11990 } },
  modernProtocols: { label: "MASQUE / HTTP/2 UDP / TrustTunnel HTTP/3", ios: { version: "5.22.0", build: 3813 }, mac: { version: "6.9.0", build: 12040 } },
  groupChain: { label: "策略组 underlying-proxy", ios: { version: "5.22.0", build: 3813 }, mac: { version: "6.9.0", build: 12040 } },
  groupIcon: { label: "策略组 icon-url", ios: { version: "5.20.0", build: 3765 }, mac: { version: "6.5.0", build: 10960 } },
  hostAliasDns: { label: "域名别名的独立 DNS", ios: { version: "5.22.0", build: 3820 }, mac: { version: "6.9.0", build: 12080 } },
  engineEvents: { label: "engine-started / profile-reloaded 事件脚本", ios: { version: "5.22.0", build: 3823 }, mac: { version: "6.9.0", build: 12250 } }
} satisfies Record<string, FeatureRequirement>;

export type SurgeFeature = keyof typeof REQUIREMENTS;
export function supportsSurgeFeature(profile: SurgeClientProfile, feature: SurgeFeature): boolean {
  const minimum: FeatureRequirement = REQUIREMENTS[feature];
  return (["ios", "mac"] as const).every((platform) => {
    const client = profile[platform];
    if (profile.tag === "tf") return client.build !== null && client.build >= minimum[platform].build;
    const version = minimum[platform].version;
    return client.version !== null && version !== null && compareVersions(client.version, version) >= 0;
  });
}

export function surgeFeatureDiagnostic(profile: SurgeClientProfile, feature: SurgeFeature, path: string, severity: "warning" | "error" = "warning"): ConfigDiagnostic {
  const requirement = REQUIREMENTS[feature];
  return { target: "surge", severity, path, code: `surge-capability-${feature}`, message: `${requirement.label} 未输出：${profile.tag} 档位未启用此功能。请选用支持此功能的兼容档位。` };
}

/** Project a request-specific view. Stored client settings are left intact. */
export function projectSurgeConfig(config: RenderConfig, profile: SurgeClientProfile, diagnostics: ConfigDiagnostic[]): RenderConfig {
  const surge = { ...config.surge };
  const groups = { ...config.groups };
  const disabledGroups = [...config.disabledGroups];
  if (!supportsSurgeFeature(profile, "tailscale")) {
    if (surge.tailscaleNodes.some((node) => node.enabled)) diagnostics.push(surgeFeatureDiagnostic(profile, "tailscale", "clients.surge.tailscaleNodes"));
    surge.tailscaleNodes = [];
  } else if (!supportsSurgeFeature(profile, "tailscaleSession") && surge.tailscaleNodes.some((node) => node.enabled)) {
    diagnostics.push(surgeFeatureDiagnostic(profile, "tailscaleSession", "clients.surge.tailscaleNodes"));
  }
  for (const [name, spec] of Object.entries(groups)) {
    if (disabledGroups.includes(name) || config.groupTargets?.[name] && !config.groupTargets[name]!.includes("surge")) continue;
    const parts = splitGroupSpec(spec);
    if (parts[0]?.toLowerCase() === "smart" && !supportsSurgeFeature(profile, "smart")) {
      disabledGroups.push(name); diagnostics.push(surgeFeatureDiagnostic(profile, "smart", `groups.${name}`));
    }
    if (parts.some((part) => parseGroupOption(part)?.key.toLowerCase() === "underlying-proxy") && !supportsSurgeFeature(profile, "groupChain")) {
      disabledGroups.push(name); diagnostics.push(surgeFeatureDiagnostic(profile, "groupChain", `groups.${name}`, "error"));
    }
    if (parts.some((part) => parseGroupOption(part)?.key.toLowerCase() === "icon-url") && !supportsSurgeFeature(profile, "groupIcon")) {
      groups[name] = parts.filter((part) => parseGroupOption(part)?.key.toLowerCase() !== "icon-url").join(", ");
      diagnostics.push(surgeFeatureDiagnostic(profile, "groupIcon", `groups.${name}`));
    }
  }
  if (!supportsSurgeFeature(profile, "engineEvents")) surge.scripts = surge.scripts.filter((line, index) => {
    if (!/\bevent\s*=\s*(?:engine-started|profile-reloaded)\b/i.test(line)) return true;
    diagnostics.push(surgeFeatureDiagnostic(profile, "engineEvents", `clients.surge.scripts.${index}`)); return false;
  });
  if (!supportsSurgeFeature(profile, "hostAliasDns")) surge.hosts = surge.hosts.filter((line, index) => {
    if (!/^\s*[^#;=]+\s*=\s*[^,=]+,\s*server:/i.test(line)) return true;
    diagnostics.push(surgeFeatureDiagnostic(profile, "hostAliasDns", `clients.surge.hosts.${index}`, "error")); return false;
  });
  return { ...config, surge, groups, disabledGroups };
}

export function filterSurgeNodes(nodes: ProxyNode[], profile: SurgeClientProfile, diagnostics: ConfigDiagnostic[]): ProxyNode[] {
  return nodes.filter((node) => {
    const requirements: SurgeFeature[] = [];
    const type = node.type.toLowerCase();
    if (type === "anytls") requirements.push("anytls");
    if (type === "trust-tunnel") requirements.push("trustTunnel");
    if (type === "h2-connect") requirements.push("http2");
    if (type === "masque") requirements.push("modernProtocols");
    if (type === "snell" && Number(node.params.version) >= 5) requirements.push(Number(node.params.version) >= 6 ? "snell6" : "snell5");
    if (["http", "https", "h2-connect", "trust-tunnel"].includes(type) && (node.params.headers !== undefined || node.params["max-streams"] !== undefined)) requirements.push("http2");
    if (type === "trust-tunnel" && node.params.h3 !== undefined || type === "h2-connect" && node.params["udp-relay"] !== undefined) requirements.push("modernProtocols");
    const missing = [...new Set(requirements)].filter((feature) => !supportsSurgeFeature(profile, feature));
    for (const feature of missing) diagnostics.push(surgeFeatureDiagnostic(profile, feature, `proxyNodes.${node.name}`));
    return missing.length === 0;
  });
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number), b = right.split(".").map(Number);
  for (let index = 0; index < 3; index++) if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  return 0;
}
