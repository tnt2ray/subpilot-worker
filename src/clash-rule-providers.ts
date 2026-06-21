import YAML from "yaml";

export type ClashRuleProviderMap = Record<string, Record<string, unknown>>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function providerSection(value: unknown): unknown {
  if (!isPlainRecord(value)) return {};
  return Object.prototype.hasOwnProperty.call(value, "rule-providers")
    ? value["rule-providers"]
    : value;
}

function defaultRuleProviderPath(name: string): string {
  const slug = name
    .trim()
    .replace(/[\\/:*?"<>|#\s]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `./rules/${slug || "provider"}.yaml`;
}

export function parseClashRuleProvidersYaml(value: string): ClashRuleProviderMap {
  const trimmed = value.trim();
  if (!trimmed) return {};
  const parsed = providerSection(YAML.parse(trimmed));
  if (!isPlainRecord(parsed)) return {};
  const output: ClashRuleProviderMap = {};
  for (const [name, provider] of Object.entries(parsed)) {
    const providerName = name.trim();
    if (!providerName || !isPlainRecord(provider)) continue;
    output[providerName] = {
      ...provider,
      path: typeof provider.path === "string" && provider.path.trim()
        ? provider.path.trim()
        : defaultRuleProviderPath(providerName)
    };
  }
  return output;
}
