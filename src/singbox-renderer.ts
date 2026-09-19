import { toClashProxy } from "./parsers";
import { toSingboxOutbound } from "./singbox-nodes";
import { isValidSingboxOutbound } from "./singbox-validation";
import { parseAllPolicySelector, parseGroupOption, splitGroupSpec } from "./policy-group-spec";
import { nodeMatchesFilter } from "./node-transforms";
import { effectiveRuleSetOutputs, nativeSingboxRuleSetSources, ruleSetOutputNeedsCompilation } from "./rule-set-outputs";
import type { CompiledRuleSetManifest } from "./rule-set-cache";
import { planRuleSetArtifacts } from "./rule-set-artifacts";
import { managedRuleSetUrlForRequest } from "./managed-url";
import { compiledFinalRuleOptions, splitRuleLine } from "./rule-line";
import { convertRule, policyAction, issue, mergeSingboxHosts } from "./singbox-config";
import type { ConfigDiagnostic, HostEntry, ProxyNode, ProxyParamValue, RenderConfig } from "./types";

type JsonObject = Record<string, ProxyParamValue>;
export function buildSingbox(config: RenderConfig, nodes: ProxyNode[], hosts: HostEntry[], requestUrl: string, diagnostics: ConfigDiagnostic[], manifests: ReadonlyMap<string, CompiledRuleSetManifest>): string {
  const client = config.document!.clients.singbox;
  // Source-only migration notices do not describe the current sing-box output.
  const sourceOnlyNotices = new Set([
    "surge-urlRewrite", "surge-mapLocal", "surge-scripts", "surge-tailscaleNodes",
    "surge-alwaysRealIp", "surge-skipProxy", "surge-mitm"
  ]);
  diagnostics.push(...client.migrationIssues.filter((item) =>
    item.path !== "clients.singbox" || !sourceOnlyNotices.has(item.code)));
  let outbounds: JsonObject[] = [{ type: "direct", tag: "DIRECT" }];
  for (const node of nodes) {
    try {
      const outbound = toSingboxOutbound(node, toClashProxy(node) as JsonObject);
      if (!isValidSingboxOutbound(outbound)) throw new Error("节点字段不符合 sing-box 1.15.0-alpha.6，请检查其原生配置");
      outbounds.push(outbound);
    }
    catch (error) { diagnostics.push(issue(`proxyNodes.${node.name}`, "node-conversion", "warning", `${node.name}：${error instanceof Error ? error.message : "节点无法转换"}`)); }
  }
  // Client-only protocols and dialers need not have a server/port pair.
  // Keep them separate from shared nodes and validate collisions in the final output.
  outbounds.push(...structuredClone(client.outbounds ?? []));
  const available = new Set(outbounds.map((outbound) => String(outbound.tag)));
  for (const endpoint of Array.isArray(client.endpoints) ? client.endpoints : []) {
    if (typeof endpoint?.tag === "string") available.add(endpoint.tag);
  }
  // A generated chain only exists when its selected upstream node survives conversion.
  // Explicit user-authored detours are still checked by the output diagnostics.
  const omittedChains = new Set<string>();
  for (const node of nodes) {
    if (!node.generatedChain || !available.has(node.name)) continue;
    const upstream = node.params["dialer-proxy"] ?? node.params["underlying-proxy"];
    if (typeof upstream === "string" && !available.has(upstream)) {
      omittedChains.add(node.name);
      available.delete(node.name);
      diagnostics.push(issue(`proxyNodes.${node.name}`, "chain-node-omitted", "warning", `${node.name}：前置节点 ${upstream} 未能输出为 sing-box 节点，已跳过此自动生成的链式节点。`));
    }
  }
  outbounds = outbounds.filter((outbound) => !omittedChains.has(String(outbound.tag)));
  const activeGroups = Object.entries(config.groups).filter(([name]) => !config.disabledGroups.includes(name) && (!config.groupTargets?.[name] || config.groupTargets[name]!.includes("sing-box")));
  const groupNames = new Set(activeGroups.map(([name]) => name));
  for (const [name, spec] of activeGroups) {
    const [type, ...parts] = splitGroupSpec(spec);
    if (type !== "select" && type !== "url-test") continue;
    const members: string[] = [];
    const options: Record<string,string> = {};
    for (const part of parts) {
      const selector = parseAllPolicySelector(part);
      if (selector) {
        const filter = selector.filter.split(",").filter(Boolean);
        const exclude = selector.exclude.split(",").filter(Boolean);
        members.push(...nodes.filter((node) => node.includeInGroups !== false && available.has(node.name)
          && (!filter.length || filter.some((value) => nodeMatchesFilter(node, value)))
          && !exclude.some((value) => nodeMatchesFilter(node, value))).map((node) => node.name));
      } else {
        const option = parseGroupOption(part);
        if (option) options[option.key] = option.value;
        else if (available.has(part) || groupNames.has(part)) members.push(part);
      }
    }
    if (!members.length) continue;
    const group: JsonObject = { type: type === "select" ? "selector" : "urltest", tag: name, outbounds: [...new Set(members)] };
    if (type === "url-test") {
      if (options.url) group.url = options.url;
      if (options.interval) group.interval = `${Number(options.interval)}s`;
      if (options.tolerance) group.tolerance = Number(options.tolerance);
      if (options.idle_timeout) group.idle_timeout = options.idle_timeout;
    }
    if (type === "select" && options.default) group.default = options.default;
    if (options.interrupt_exist_connections !== undefined) {
      if (!["true", "false"].includes(options.interrupt_exist_connections)) diagnostics.push(issue(`groups.${name}`, "group-option", "error", "interrupt_exist_connections 必须为 true 或 false。"));
      else group.interrupt_exist_connections = options.interrupt_exist_connections === "true";
    }
    if (options.hidden && ["true", "1"].includes(options.hidden.toLowerCase())) diagnostics.push(issue(`groups.${name}`, "group-hidden-unsupported", "warning", `${name} 的 hidden 未输出：sing-box 不支持原生策略组隐藏。`));
    const supportedOptions = ["hidden", "interrupt_exist_connections", ...(type === "select" ? ["default"] : ["url", "interval", "tolerance", "idle_timeout"])];
    for (const key of Object.keys(options)) if (!supportedOptions.includes(key)) diagnostics.push(issue(`groups.${name}`, "group-option", "warning", `${name} 的 ${key} 选项未输出。`));
    outbounds.push(group);
  }
  const route = structuredClone(client.route);
  const dns = structuredClone(client.dns);
  const dnsRules: JsonObject[] = [];
  if (config.ruleSets.mode === "compiled") {
    const rules: JsonObject[] = [{ protocol: "dns", action: "hijack-dns" }];
    const ruleSets: JsonObject[] = [];
    const items = [
      ...effectiveRuleSetOutputs(config.ruleSets).map((output) => ({ order: output.order, output })),
      ...config.ruleSets.directRules.filter((rule) => rule.enabled).map((direct) => ({ order: direct.order, direct }))
    ].sort((left,right) => left.order - right.order);
    for (const item of items) {
      try {
        if ("direct" in item) {
          const parts = splitRuleLine(item.direct.rule);
          const final = ["FINAL", "MATCH"].includes(parts[0]?.toUpperCase() ?? "");
          const converted = convertRule(final ? [parts[0], item.direct.policy || parts[1], ...compiledFinalRuleOptions(parts)].join(",") : item.direct.rule);
          if (converted.final) {
            const action = policyAction(item.direct.policy || converted.final);
            if (action.action === "reject") { rules.push(action); delete route.final; }
            else if (typeof action.outbound === "string") route.final = action.outbound;
          }
          else if (converted.rule) rules.push({ ...converted.rule, ...policyAction(item.direct.policy) });
        } else {
          if (item.output.surgeOptions.some((option) => option !== "no-resolve")) throw new Error(`${item.output.name} 的 Surge 规则选项无法等价转换，请在当前客户端规则计划中移除或改写。`);
          for (const source of nativeSingboxRuleSetSources(config.ruleSets, item.output)) {
            const tag = `${item.output.name}-srs-${source.id}`;
            ruleSets.push({ type: "remote", tag, format: "binary", url: source.url, http_client: { engine: "go" }, update_interval: "1d" });
            rules.push({ rule_set: [tag], ...policyAction(item.output.policy) });
            if (item.output.dnsServer) dnsRules.push({ rule_set: [tag], action: "route", server: item.output.dnsServer });
          }
          if (!ruleSetOutputNeedsCompilation(config.ruleSets, item.output, "sing-box")) continue;
          const manifest = manifests.get(item.output.name);
          if (!manifest) throw new Error("规则集缓存尚未就绪，请稍后重试更新配置。");
          diagnostics.push(...manifest.warnings.filter((message) => !/^AS\d+ 已展开为 \d+ 条 IPv4\/IPv6 CIDR（RIPE RIS 快照）。$/.test(message)).map((message) => issue("clients.singbox.ruleSets", "rule-cache", "warning", message)));
          const compatible = manifest.buckets.reduce((sum, bucket) => sum + (bucket.targetCounts?.["sing-box"] ?? 0), 0);
          if (compatible !== manifest.ruleCount) throw new Error("规则集中存在 sing-box 无法等价表达的规则");
          if (item.output.dnsServer) {
            if (!manifest.dnsRuleCount) diagnostics.push(issue("clients.singbox.ruleSets", "rule-dns-empty", "warning", `${item.output.name} 没有可用于 DNS 匹配的独立域名规则，未生成 DNS 绑定。`));
            else {
              const tag = `${item.output.name}-dns`;
              ruleSets.push({ type: "remote", tag, format: "source", url: managedRuleSetUrlForRequest(config, requestUrl, item.output.name, "dns", "sing-box"), http_client: { engine: "go" }, update_interval: "1d" });
              dnsRules.push({ rule_set: [tag], action: "route", server: item.output.dnsServer });
            }
          }
          for (const artifact of planRuleSetArtifacts(manifest.buckets, "sing-box")) {
            const tag = `${item.output.name}-${artifact.bucket}`;
            ruleSets.push({ type: "remote", tag, format: "source", url: managedRuleSetUrlForRequest(config, requestUrl, item.output.name, artifact.bucket, "sing-box"), http_client: { engine: "go" }, update_interval: "1d" });
            rules.push({ rule_set: [tag], ...policyAction(item.output.policy) });
          }
        }
      } catch (error) { diagnostics.push(issue("clients.singbox.ruleSets", "rule-conversion", "error", error instanceof Error ? error.message : "规则集生成失败")); }
    }
    // Explicit native rules take priority, just as native DNS rules do for Hosts.
    route.rules = [...(Array.isArray(route.rules) ? route.rules : []), ...rules];
    route.rule_set = [...(Array.isArray(route.rule_set) ? route.rule_set : []), ...ruleSets];
  }
  if (dnsRules.length) dns.rules = [...dnsRules, ...(Array.isArray(dns.rules) ? dns.rules : [])];
  mergeSingboxHosts(dns, hosts, diagnostics);
  const { coreVersion: _, migrationIssues: __, ruleSets: ___, groups: ____, disabledGroups: _____, ...nativeSettings } = client;
  const result = { ...nativeSettings, dns, outbounds, route };
  return JSON.stringify(result, null, 2) + "\n";
}
