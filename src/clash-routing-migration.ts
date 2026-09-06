import { parseClashRuleProvidersYaml, validateClashRuleProvidersYaml } from "./clash-rule-providers";
import { parseRuleSetContent } from "./rule-set-parser";
import { splitRuleLine } from "./rule-line";
import type { AppConfig } from "./types";
import type { RuleSetSourceFormat, RuleSetOutput, RuleSetBucket } from "./rule-set-types";

/** Build a draft only. Unconvertible providers never disappear from saved configuration. */
export function migrateClashRouting(original: AppConfig["clients"]["clash"]): {
  client: AppConfig["clients"]["clash"];
  issues: string[];
} {
  const client = structuredClone(original);
  const issues: string[] = [];
  if (client.ruleSets.mode === "compiled") return { client, issues };
  const invalid = validateClashRuleProvidersYaml(client.ruleProviders, "Clash");
  if (invalid) return { client, issues: [invalid] };
  const providers = parseClashRuleProvidersYaml(client.ruleProviders);
  const plan = client.ruleSets;
  const ids = new Set([...plan.sources, ...plan.directRules].map((item) => item.id));
  const nextId = (kind: string): string => {
    let index = 1;
    while (ids.has(`clash-${kind}-${index}`)) index += 1;
    const id = `clash-${kind}-${index}`;
    ids.add(id);
    return id;
  };
  // Preserve dormant compiled entries without making them part of the active native rules.
  plan.outputs.forEach((item) => { item.enabled = false; });
  plan.directRules.forEach((item) => { item.enabled = false; });
  // Reserve native provider names before parking dormant entries. Legacy client
  // splits copied Surge outputs here; they must not force active Clash URLs to
  // gain a numeric suffix merely because the inactive copy has the same name.
  const providerNames = new Set(Object.keys(providers));
  const names = new Set([...providerNames, ...plan.outputs.map((item) => item.name)]);
  const uniqueName = (base: string): string => {
    let name = base;
    for (let i = 2; names.has(name); i += 1) name = `${base} ${i}`;
    names.add(name);
    return name;
  };
  for (const output of plan.outputs) {
    if (providerNames.has(output.name)) output.name = uniqueName(`${output.name}-inactive`);
  }
  names.clear();
  for (const output of plan.outputs) names.add(output.name);
  const resources = new Map<string, { sourceIds: string[]; inlineRules: string[]; provider: NonNullable<RuleSetOutput["provider"]> }>();
  for (const [name, provider] of Object.entries(providers)) {
    const type = String(provider.type).trim().toLowerCase();
    const behavior = String(provider.behavior).trim().toLowerCase();
    const format = String(provider.format || "yaml").trim().toLowerCase();
    const interval = provider.interval ?? 86400;
    if (typeof interval !== "number" || !Number.isSafeInteger(interval) || interval <= 0) {
      issues.push(`${name}: interval 必须为正整数秒数。`);
      continue;
    }
    const settings = { behavior: behavior as RuleSetBucket, interval };
    const extra = Object.keys(provider).filter((key) => !["type", "behavior", "format", "url", "path", "interval", "payload"].includes(key));
    if (type === "file" || !["yaml", "text"].includes(format) || extra.length) {
      issues.push(`${name}: ${type === "file" ? "本地文件需要替换为 HTTP(S) 地址或内联规则" : !["yaml", "text"].includes(format) ? "请替换为 YAML 或文本来源，不支持 MRS 二进制来源" : `请处理无法转换的参数：${extra.join("、")}`}。`);
      continue;
    }
    if (type === "http") {
      const url = String(provider.url || "").trim();
      const selectedFormat: RuleSetSourceFormat = format === "yaml" ? "clash-yaml" : behavior === "domain" ? "plain-domain" : behavior === "ipcidr" ? "plain-ipcidr" : "plain-classical";
      let source = plan.sources.find((item) => item.url === url && item.format === selectedFormat && item.enabled);
      if (!source) {
        source = { id: nextId("source"), name, url, enabled: true, format: selectedFormat, order: plan.sources.length };
        plan.sources.push(source);
      }
      resources.set(name, { sourceIds: [source.id], inlineRules: [], provider: settings });
    } else if (type === "inline") {
      if (!Array.isArray(provider.payload) || provider.payload.some((item) => typeof item !== "string")) {
        issues.push(`${name}: 内联 payload 必须是字符串数组。`);
        continue;
      }
      const parsed = parseRuleSetContent(provider.payload.join("\n"), behavior === "domain" ? "plain-domain" : behavior === "ipcidr" ? "plain-ipcidr" : "plain-classical", name, undefined, true);
      issues.push(...parsed.warnings);
      resources.set(name, { sourceIds: [], inlineRules: parsed.rules.map((item) => item.raw), provider: settings });
    }
  }
  const used = new Set<string>();
  let order = 0;
  for (const [index, raw] of original.rules.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = splitRuleLine(line);
    const type = (parts[0] || "").toUpperCase();
    if (type === "RULE-SET") {
      const name = parts[1] || "";
      const resource = resources.get(name);
      if (!resource) { issues.push(`第 ${index + 1} 条规则引用的 ${name} 尚不可编译。`); continue; }
      const options = parts.slice(3).map((option) => option.toLowerCase());
      if (!parts[2] || options.some((option) => option !== "no-resolve")) {
        issues.push(`${name}: 出口缺失或含有无法转换的规则选项。`);
        continue;
      }
      used.add(name);
      plan.outputs.push({ name: uniqueName(name), ...resource, policy: parts[2], enabled: true, order: order++, surgeOptions: options });
    } else {
      if (["AND", "OR", "NOT"].includes(type) && /\bRULE-SET\s*,/i.test(parts[1] || "")) {
        issues.push(`第 ${index + 1} 条逻辑规则包含原生 RULE-SET 引用，请改写为可编译的匹配条件。`);
        continue;
      }
      const policyIndex = ["MATCH", "FINAL"].includes(type) ? 1 : 2;
      const policy = parts[policyIndex];
      if (!policy) { issues.push(`第 ${index + 1} 条规则缺少出口。`); continue; }
      parts.splice(policyIndex, 1);
      plan.directRules.push({ id: nextId("rule"), rule: parts.join(","), policy, enabled: true, order: order++ });
    }
  }
  // Unreferenced providers remain editable, but do not start matching traffic.
  for (const [name, resource] of resources) if (!used.has(name)) {
    plan.outputs.push({ name: uniqueName(name), ...resource, policy: "Proxy", enabled: false, order: order++, surgeOptions: [] });
  }
  for (const item of [...plan.outputs, ...plan.directRules]) if (!item.enabled) item.order = order++;
  const finals = plan.directRules.filter((item) => item.enabled && /^(MATCH|FINAL)(,|$)/i.test(item.rule));
  if (finals.length !== 1) issues.push("必须保留唯一的 MATCH 或 FINAL 兜底规则。");
  const last = original.rules.filter((line) => line.trim() && !line.trim().startsWith("#")).at(-1) || "";
  if (!/^(MATCH|FINAL)\s*,/i.test(last.trim())) issues.push("兜底规则必须位于最后，请先修正原生规则顺序。");
  if (issues.length) return { client: structuredClone(original), issues };
  plan.mode = "compiled";
  client.rules = [];
  client.ruleProviders = "";
  return { client, issues };
}
