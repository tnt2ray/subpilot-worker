import YAML from "yaml";
import { splitGroupSpec, parseAllPolicySelector, parseGroupOption } from "./policy-group-spec";
import { splitRuleLine } from "./rule-line";
import { ruleTargetIndex } from "./rule-targets";
import type { ConfigDiagnostic, RenderConfig, Target } from "./types";

type OutputGroup = { name?: string; tag?: string; type?: string; default?: string; proxies?: string[]; outbounds?: string[] };

/** Resolve runtime-empty selectors only in the generated subscription, never in saved settings. */
export function omitEmptyPolicyGroups(config: RenderConfig, target: Target, content: string): { config: RenderConfig; content: string; diagnostics: ConfigDiagnostic[] } {
  const document = target === "clash" ? YAML.parseDocument(content) : null;
  const json = target === "sing-box" ? JSON.parse(content) as { outbounds: OutputGroup[]; route?: Record<string, unknown> } : null;
  const members = new Map<string, string[]>();
  if (document) for (const group of (document.toJS() as { "proxy-groups"?: OutputGroup[] })["proxy-groups"] ?? []) members.set(group.name!, group.proxies ?? []);
  if (json) for (const group of json.outbounds) if (["selector", "urltest"].includes(group.type ?? "")) members.set(group.tag!, group.outbounds ?? []);
  let section = "";
  if (target === "surge") for (const line of content.split(/\r?\n/)) {
    if (/^\[[^\[\]\r\n]+\]$/.test(line.trim())) section = line.trim().toLowerCase();
    if (section !== "[proxy group]" || !line.includes("=")) continue;
    const at = line.indexOf("=");
    const parts = splitGroupSpec(line.slice(at + 1));
    if (parts[0] !== "subnet") members.set(line.slice(0, at).trim(), parts.slice(1).filter((part) => !parseGroupOption(part)));
  }
  const supported = target === "sing-box" ? ["select", "url-test"] : target === "clash" ? ["select", "url-test", "fallback", "load-balance"] : ["select", "url-test", "fallback", "load-balance", "smart"];
  const candidates = Object.entries(config.groups).filter(([name, spec]) => name !== "Proxy" && !config.disabledGroups.includes(name)
    && supported.includes(splitGroupSpec(spec)[0]!));
  const omitted = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, spec] of candidates) {
      if (omitted.has(name)) continue;
      const parts = splitGroupSpec(spec).slice(1).filter((part) => !parseGroupOption(part) || parseAllPolicySelector(part));
      const resolved = (members.get(name) ?? []).filter((member) => !omitted.has(member));
      // Unknown explicit references and unsupported groups must still produce errors.
      if (resolved.length || !parts.length || !parts.every((part) => parseAllPolicySelector(part) || omitted.has(part))) continue;
      omitted.add(name); changed = true;
    }
  }
  if (!omitted.size) return { config, content, diagnostics: [] };
  const fallback = (policy: string): string => omitted.has(policy) ? "Proxy" : policy;
  const rewriteRule = (line: string): string => {
    const parts = splitRuleLine(line), index = ruleTargetIndex(parts);
    if (index === null || !omitted.has(parts[index]!)) return line;
    parts[index] = "Proxy"; return parts.join(",");
  };
  const rewriteRoute = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(rewriteRoute); return; }
    if (!value || typeof value !== "object") return;
    const rule = value as Record<string, unknown>;
    if (typeof rule.outbound === "string") rule.outbound = fallback(rule.outbound);
    if (Array.isArray(rule.rules)) rule.rules.forEach(rewriteRoute);
  };
  if (document) {
    const data = document.toJS() as { "proxy-groups": OutputGroup[]; rules?: string[] };
    document.set("proxy-groups", data["proxy-groups"].filter((group) => !omitted.has(group.name!)).map((group) => ({ ...group, proxies: (group.proxies ?? []).filter((member) => !omitted.has(member)) })));
    for (const [index, line] of (data.rules ?? []).entries()) if (rewriteRule(line) !== line) document.setIn(["rules", index], rewriteRule(line));
    content = document.toString();
  } else if (json) {
    json.outbounds = json.outbounds.filter((group) => !omitted.has(group.tag!)).map((group) => {
      if (!members.has(group.tag!)) return group;
      const resolved = { ...group, outbounds: (group.outbounds ?? []).filter((member) => !omitted.has(member)) };
      if (resolved.default && omitted.has(resolved.default)) delete resolved.default;
      return resolved;
    });
    if (json.route) {
      rewriteRoute(json.route.rules);
      if (typeof json.route.final === "string") json.route.final = fallback(json.route.final);
    }
    content = JSON.stringify(json, null, 2);
  } else {
    section = "";
    content = content.split(/\r?\n/).flatMap((line) => {
      if (/^\[[^\[\]\r\n]+\]$/.test(line.trim())) section = line.trim().toLowerCase();
      if (section === "[rule]") return [rewriteRule(line)];
      if (section !== "[proxy group]" || !line.includes("=")) return [line];
      const at = line.indexOf("="), name = line.slice(0, at).trim();
      if (omitted.has(name)) return [];
      const parts = splitGroupSpec(line.slice(at + 1));
      if (parts[0] === "subnet") return [line];
      return [`${name} = ${parts.filter((part, index) => index === 0 || !omitted.has(part)).join(", ")}`];
    }).join("\n");
  }
  const view: RenderConfig = { ...config,
    groups: Object.fromEntries(Object.entries(config.groups).filter(([name]) => !omitted.has(name)).map(([name, spec]) => [name, splitGroupSpec(spec).filter((part, index) => index === 0 || !omitted.has(part)).join(", ")])),
    surge: { ...config.surge, rules: config.surge.rules.map(rewriteRule) },
    clash: { ...config.clash, rules: config.clash.rules.map(rewriteRule) },
    ruleSets: { ...config.ruleSets, outputs: config.ruleSets.outputs.map((output) => ({ ...output, policy: fallback(output.policy) })), directRules: config.ruleSets.directRules.map((rule) => ({ ...rule, policy: fallback(rule.policy), rule: rewriteRule(rule.rule) })) }
  };
  return { config: view, content, diagnostics: [...omitted].map((name) => ({ target, path: `groups.${name}`, severity: "warning", code: "empty-group-omitted", message: `${name} 筛选后无可用成员，已省略；分流规则引用回落到 Proxy。` })) };
}
