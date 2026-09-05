import YAML from "yaml";
import { splitRuleLine } from "./rule-line";
import { splitGroupSpec, parseAllPolicySelector, parseGroupOption } from "./policy-group-spec";
import { ruleTargetIndex, builtInPoliciesForTarget } from "./rule-targets";
import type { ConfigDiagnostic, RenderConfig, Target } from "./types";

export function collectOutputDiagnostics(config: RenderConfig, target: Target, content: string): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];
  const add = (path: string, code: string, message: string) => diagnostics.push({ target, severity: "error", path, code, message });
  const nodes = new Set<string>();
  const groups = new Map<string,string[]>();
  const surgeGroupTypes = new Map<string, string>();
  const roots = new Set<string>();
  const detours = new Map<string,string>();
  const builtins = new Set(builtInPoliciesForTarget(target));
  if (config.ruleSets.mode === "compiled") {
    const items = [...config.ruleSets.outputs.filter((item) => item.enabled), ...config.ruleSets.directRules.filter((item) => item.enabled)].sort((a,b) => a.order - b.order);
    const finals = items.filter((item) => "rule" in item && ["FINAL", "MATCH"].includes(splitRuleLine(item.rule)[0]?.toUpperCase() ?? ""));
    if (finals.length > 1 || !finals.length && target !== "sing-box") add("ruleSets.directRules", "final-count", "编译规则必须且只能包含一个兜底规则。");
    if (finals.length === 1 && items.at(-1) !== finals[0]) add("ruleSets.directRules", "final-order", "兜底规则必须位于最后。");
  }
  if (target === "sing-box") {
    builtins.clear();
    const data = JSON.parse(content);
    for (const [path, items] of [["outbounds", [...data.outbounds ?? [], ...data.endpoints ?? []]], ["inbounds", data.inbounds], ["http_clients", data.http_clients], ["dns.servers", data.dns?.servers], ["route.rule_set", data.route?.rule_set]] as const) {
      const tags = new Set<string>();
      for (const item of items ?? []) {
        if (!item.tag) continue;
        for (const tag of Array.isArray(item.tag) ? item.tag : [item.tag]) {
          if (tags.has(tag)) add(`clients.singbox.${path}`, "duplicate-tag", `${tag} 标签重复。`);
          tags.add(tag);
        }
      }
    }
    for (const outbound of data.outbounds ?? []) {
      if (Array.isArray(outbound.outbounds)) groups.set(outbound.tag, outbound.outbounds);
      else nodes.add(outbound.tag);
      if (outbound.detour) detours.set(outbound.tag, outbound.detour);
    }
    for (const endpoint of data.endpoints ?? []) if (endpoint.tag) nodes.add(endpoint.tag);
    collectJsonReferences(data.route?.rules, roots);
    if (data.route?.final) roots.add(data.route.final);
    else if (!hasTerminalRule(data.route?.rules)) add("clients.singbox.route.final", "missing-final", "请显式设置默认出站，或在最后添加无条件的路由/拒绝规则。");
    const ruleSets = new Set((data.route?.rule_set ?? []).flatMap((item: { tag: string | string[] }) => item.tag));
    const dnsTags = new Set((data.dns?.servers ?? []).map((item: { tag: string }) => item.tag));
    const httpTags = new Set((data.http_clients ?? []).map((item: { tag: string }) => item.tag));
    const inboundTags = new Set((data.inbounds ?? []).map((item: { tag: string }) => item.tag));
    const inboundEdges = new Map<string, string>();
    for (const inbound of data.inbounds ?? []) {
      if (!inbound.detour) continue;
      if (!inboundTags.has(inbound.detour)) add("clients.singbox.inbounds", "missing-inbound", `入站 ${inbound.tag || "(未命名)"} 引用的入站不存在。`);
      if (inbound.tag) inboundEdges.set(inbound.tag, inbound.detour);
    }
    for (const tag of inboundEdges.keys()) {
      const seen = new Set<string>(); let next: string | undefined = tag;
      while (next) {
        if (seen.has(next)) { add("clients.singbox.inbounds", "inbound-cycle", `入站 ${next} 存在循环依赖。`); break; }
        seen.add(next); next = inboundEdges.get(next);
      }
    }
    const walk = (value: unknown, path: string) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach((item,index) => walk(item, `${path}.${index}`)); return; }
      for (const [key,item] of Object.entries(value)) {
        if (key === "rule_set" && (typeof item === "string" || Array.isArray(item) && item.every((part) => typeof part === "string"))) {
          for (const tag of Array.isArray(item) ? item : [item]) if (!ruleSets.has(tag)) add(path, "missing-rule-set", `规则集 ${tag} 不存在。`);
        }
        if ((key === "detour" || key === "download_detour") && !/^clients\.singbox\.inbounds\.\d+$/.test(path)) { if (typeof item === "string") roots.add(item); }
        if ((key === "http_client" || key === "default_http_client") && typeof item === "string" && !httpTags.has(item)) add(path, "missing-http-client", `HTTP 客户端 ${item} 不存在。`);
        if (key === "domain_resolver" || key === "default_domain_resolver") {
          const tag = typeof item === "string" ? item : (item as {server?: string})?.server;
          if (tag && !dnsTags.has(tag)) add(path, "missing-dns", `DNS 解析器 ${tag} 不存在。`);
        }
        if (key === "preferred_by" && path.startsWith("clients.singbox.route.rules")) {
          for (const tag of Array.isArray(item) ? item : [item]) if (typeof tag === "string") roots.add(tag);
        }
        if (key === "preferred_by" && path.startsWith("clients.singbox.dns.rules") || key === "server" && (path.startsWith("clients.singbox.dns.rules") || (value as {action?: string}).action === "resolve")) {
          for (const tag of Array.isArray(item) ? item : [item]) if (typeof tag === "string" && !dnsTags.has(tag)) add(path, "missing-dns", `DNS 规则引用的 ${tag} 不存在。`);
        }
        walk(item, `${path}.${key}`);
      }
    };
    walk(data, "clients.singbox");
    if (data.dns?.final && !dnsTags.has(data.dns.final)) add("clients.singbox.dns.final", "missing-dns", "默认 DNS 解析器不存在。");
    const dnsEdges = new Map<string, string>();
    for (const server of data.dns?.servers ?? []) {
      const resolver = typeof server.domain_resolver === "string" ? server.domain_resolver : server.domain_resolver?.server;
      if (server.tag && resolver) dnsEdges.set(server.tag, resolver);
    }
    for (const tag of dnsEdges.keys()) {
      const seen = new Set<string>(); let next: string | undefined = tag;
      while (next) {
        if (seen.has(next)) { add("clients.singbox.dns.servers", "dns-cycle", `DNS 解析器 ${next} 存在循环依赖。`); break; }
        seen.add(next); next = dnsEdges.get(next);
      }
    }
  } else if (target === "clash") {
    const data = YAML.parse(content);
    for (const node of data.proxies ?? []) { nodes.add(node.name); if (node["dialer-proxy"]) detours.set(node.name, node["dialer-proxy"]); }
    for (const group of data["proxy-groups"] ?? []) groups.set(group.name, group.proxies ?? []);
    for (const line of data.rules ?? []) collectLineReference(line, roots);
  } else {
    let section = "";
    for (const line of content.split(/\r?\n/)) {
      if (line.startsWith("[")) { section = line.toLowerCase(); continue; }
      if (section === "[rule]") collectLineReference(line, roots);
      if (section === "[proxy]" && line.includes("=")) {
        const at = line.indexOf("="); const name = line.slice(0,at).trim(); nodes.add(name);
        const match = line.slice(at + 1).match(/(?:^|,)\s*underlying-proxy\s*=\s*([^,]+)/);
        if (match) detours.set(name, match[1]!.trim());
      }
      if (section === "[proxy group]" && line.includes("=")) {
        const at = line.indexOf("="); const [type,...parts] = splitGroupSpec(line.slice(at+1));
        const name = line.slice(0,at).trim();
        surgeGroupTypes.set(name, type!);
        groups.set(name, parts.flatMap((part) => { const option = parseGroupOption(part); return type === "subnet" ? option && !["hidden", "icon-url"].includes(option.key.toLowerCase()) ? [option.value] : [] : option ? [] : [part]; }));
        const underlying = parts.map((part) => parseGroupOption(part)).find((option) => option?.key.toLowerCase() === "underlying-proxy");
        if (underlying) detours.set(name, underlying.value);
      }
    }
  }
  if (target !== "sing-box") {
    const configured = config.ruleSets.mode === "compiled" ? []
      : target === "surge" ? config.surge.rules : config.clash.rules;
    for (const line of configured) collectLineReference(line, roots);
    if (config.ruleSets.mode === "compiled") for (const output of config.ruleSets.outputs) if (output.enabled) roots.add(output.policy);
    if (config.ruleSets.mode === "compiled") for (const rule of config.ruleSets.directRules) if (rule.enabled) roots.add(rule.policy);
  }
  for (const [name] of groups) roots.add(name);
  for (const [name, spec] of Object.entries(config.groups)) {
    if (config.disabledGroups.includes(name) || config.groupTargets?.[name] && !config.groupTargets[name]!.includes(target)) continue;
    const type = splitGroupSpec(spec)[0]!;
    if (target !== "surge" && splitGroupSpec(spec).some((part) => parseGroupOption(part)?.key.toLowerCase() === "underlying-proxy")) add(`groups.${name}`, "group-chain-unsupported", `${name} 的组级链式出口仅适用于 Surge，请将此组的适用端限制为 Surge，或配置共享链式节点。`);
    const supported = target === "sing-box" ? ["select", "url-test"] : target === "clash" ? ["select", "url-test", "fallback", "load-balance"] : ["select", "url-test", "fallback", "load-balance", "subnet", "smart"];
    if (!supported.includes(type)) diagnostics.push({ target, severity: "warning", path: `groups.${name}`, code: "group-type", message: `${name} 的 ${type} 类型不适用于当前输出端，已跳过。` });
    if (target === "surge" && type === "url-test" && surgeGroupTypes.get(name) === "smart") diagnostics.push({ target, severity: "info", path: `groups.${name}`, code: "group-type-adapted", message: `${name} 的 url-test 已自动转换为 Surge smart；smart 使用自身测速周期，interval 不生效。` });
    if (target === "surge" && type === "url-test" && splitGroupSpec(spec).some((part) => parseGroupOption(part)?.key === "url")) diagnostics.push({ target, severity: "warning", path: `groups.${name}`, code: "group-url", message: `${name} 的组级 url 不被当前 Surge 使用，请设置 Surge 的代理测速 URL。` });
  }
  const available = new Set([...nodes, ...groups.keys(), ...builtins]);
  for (const [name, dependency] of detours) if (!available.has(dependency)) add(`proxyNodes.${name}`, "missing-detour", `${name} 的链式出口 ${dependency} 不存在。`);
  const checked = new Set<string>();
  const visit = (name: string, stack: Set<string>) => {
    if (target === "surge" && /^DEVICE:[^,\r\n[\]]+$/i.test(name)) return;
    if (!available.has(name)) { add("rules", "missing-policy", `策略 ${name} 不存在或不适用于当前输出端。`); return; }
    if (stack.has(name)) { add(`groups.${name}`, "policy-cycle", `策略 ${name} 存在循环引用。`); return; }
    if (checked.has(name)) return;
    checked.add(name);
    const members = groups.get(name);
    if (members) {
      if (!members.length) add(`groups.${name}`, "empty-group", `${name} 没有可用成员。`);
      const original = config.groups[name];
      if (original) for (const part of splitGroupSpec(original).slice(1)) {
        const option = parseGroupOption(part);
        const member = splitGroupSpec(original)[0] === "subnet" && option && !["hidden", "icon-url"].includes(option.key.toLowerCase()) ? option.value : !option ? part : undefined;
        if (!parseAllPolicySelector(part) && member && !available.has(member)) add(`groups.${name}`, "missing-member", `${name} 引用的 ${member} 不可用。`);
        else if (target === "sing-box" && !parseAllPolicySelector(part) && member && !members.includes(member)) add(`groups.${name}`, "omitted-member", `${name} 引用的 ${member} 未保留在输出策略组中。`);
      }
      if (original && splitGroupSpec(original)[0] === "subnet" && !splitGroupSpec(original).some((part) => parseGroupOption(part)?.key === "default")) add(`groups.${name}`, "missing-default", `${name} 必须显式设置 default 策略。`);
      if (target === "surge" && surgeGroupTypes.get(name) === "smart") {
        for (const member of members) if (groups.has(member) || builtins.has(member)) add(`groups.${name}`, "smart-member", `${name} 的 smart 类型只支持代理节点成员，不能包含 ${member}。`);
      }
      for (const member of members) visit(member, new Set([...stack,name]));
    }
    const detour = detours.get(name); if (detour) visit(detour, new Set([...stack,name]));
  };
  for (const root of roots) visit(root, new Set());
  for (const name of detours.keys()) visit(name, new Set());
  return diagnostics;
}

function hasTerminalRule(rules: unknown): boolean {
  const last = Array.isArray(rules) ? rules.at(-1) : undefined;
  if (!last || typeof last !== "object") return false;
  const action = last.action ?? "route";
  return (action === "reject" || action === "route" && Boolean(last.outbound))
    && Object.keys(last).every((key) => ["type", "action", "outbound", "method", "no_drop"].includes(key))
    && (!last.type || last.type === "default");
}

function collectLineReference(line: string, roots: Set<string>): void {
  if (!line.trim() || /^\s*[#;]/.test(line)) return;
  const parts = splitRuleLine(line); const index = ruleTargetIndex(parts);
  if (index !== null && parts[index]) roots.add(parts[index]!);
}
function collectJsonReferences(value: unknown, roots: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { value.forEach((item) => collectJsonReferences(item, roots)); return; }
  for (const [key,item] of Object.entries(value)) {
    if (key === "outbound" && typeof item === "string") roots.add(item);
    else collectJsonReferences(item, roots);
  }
}
