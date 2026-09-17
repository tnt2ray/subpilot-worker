import YAML from "yaml";
import { compiledRuleProviderName } from "./rule-provider-name";

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

function defaultRuleProviderPath(name: string, usedPaths: Set<string>): string {
  const stem = `./rules/${compiledRuleProviderName(name, "combined")}`;
  let path = `${stem}.yaml`;
  let suffix = 2;
  while (usedPaths.has(path)) path = `${stem}_${suffix++}.yaml`;
  usedPaths.add(path);
  return path;
}

export function parseClashRuleProvidersYaml(value: string): ClashRuleProviderMap {
  const trimmed = value.trim();
  if (!trimmed) return {};
  const parsed = providerSection(YAML.parse(trimmed));
  if (!isPlainRecord(parsed)) return {};
  const output: ClashRuleProviderMap = {};
  const usedPaths = new Set(Object.values(parsed).flatMap((provider) => (
    isPlainRecord(provider) && typeof provider.path === "string" && provider.path.trim()
      ? [provider.path.trim()]
      : []
  )));
  for (const [name, provider] of Object.entries(parsed)) {
    const providerName = name.trim();
    if (!providerName || !isPlainRecord(provider)) continue;
    output[providerName] = {
      ...provider,
      path: typeof provider.path === "string" && provider.path.trim()
        ? provider.path.trim()
        : defaultRuleProviderPath(providerName, usedPaths)
    };
  }
  return output;
}

export function validateClashRuleProvidersYaml(value: string, targetName: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = providerSection(YAML.parse(trimmed));
  } catch {
    return `${targetName} rule-providers YAML 格式无效`;
  }
  if (!isPlainRecord(parsed)) return `${targetName} rule-providers 必须是对象映射`;
  for (const [rawName, provider] of Object.entries(parsed)) {
    const name = rawName.trim();
    if (!name || name !== rawName || /[,\r\n[\]]/.test(name)) return `${targetName} rule-provider 名称格式无效`;
    if (!isPlainRecord(provider)) return `${targetName} rule-provider ${name} 配置必须是对象`;
    const type = typeof provider.type === "string" ? provider.type.trim().toLowerCase() : "";
    if (!new Set(["http", "file", "inline"]).has(type)) return `${targetName} rule-provider ${name} type 不受支持`;
    const behavior = typeof provider.behavior === "string" ? provider.behavior.trim().toLowerCase() : "";
    if (!new Set(["domain", "ipcidr", "classical"]).has(behavior)) return `${targetName} rule-provider ${name} behavior 不受支持`;
    if (type === "http") {
      const url = typeof provider.url === "string" ? provider.url.trim() : "";
      try {
        const parsedUrl = new URL(url);
        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") throw new Error("invalid protocol");
      } catch {
        return `${targetName} rule-provider ${name} URL 必须使用 http 或 https`;
      }
    }
  }
  return null;
}
