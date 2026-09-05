import { toClashProxy } from "./parsers";
import { toSingboxOutbound } from "./singbox-nodes";
import { isValidSingboxOutbound } from "./singbox-validation";
import { parseAllPolicySelector, parseGroupOption, splitGroupSpec } from "./policy-group-spec";
import { nodeMatchesFilter } from "./node-transforms";
import { effectiveRuleSetOutputs } from "./rule-set-outputs";
import { ensureCompiledRuleSet } from "./rule-set-compiler";
import { planRuleSetArtifacts } from "./rule-set-artifacts";
import { managedRuleSetUrlForRequest } from "./managed-url";
import { convertRule, policyAction, issue, mergeSingboxHosts } from "./singbox-config";
import type { ConfigDiagnostic, HostEntry, ProxyNode, ProxyParamValue, RenderConfig } from "./types";

type JsonObject = Record<string, ProxyParamValue>;
export async function buildSingbox(env: Env, config: RenderConfig, nodes: ProxyNode[], hosts: HostEntry[], requestUrl: string, diagnostics: ConfigDiagnostic[]): Promise<string> {
  const client = config.document!.clients.singbox;
  diagnostics.push(...client.migrationIssues);
  const outbounds: JsonObject[] = [{ type: "direct", tag: "DIRECT" }];
  for (const node of nodes) {
    try {
      const outbound = toSingboxOutbound(node, toClashProxy(node) as JsonObject);
      if (!isValidSingboxOutbound(outbound)) throw new Error("节点字段不符合 sing-box 1.14.0，请检查其原生配置");
      outbounds.push(outbound);
    }
    catch (error) { diagnostics.push(issue(`proxyNodes.${node.name}`, "node-conversion", "warning", `${node.name}：${error instanceof Error ? error.message : "节点无法转换"}`)); }
  }
  const available = new Set(outbounds.map((outbound) => String(outbound.tag)));
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
    }
    for (const key of Object.keys(options)) if (!["url", "interval", "tolerance", "hidden"].includes(key)) diagnostics.push(issue(`groups.${name}`, "group-option", "warning", `${name} 的 ${key} 选项未输出。`));
    outbounds.push(group);
  }
  const route = structuredClone(client.route);
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
          const converted = convertRule(item.direct.rule);
          if (converted.final) {
            const action = policyAction(item.direct.policy || converted.final);
            if (action.action === "reject") { rules.push(action); delete route.final; }
            else if (typeof action.outbound === "string") route.final = action.outbound;
          }
          else if (converted.rule) rules.push({ ...converted.rule, ...policyAction(item.direct.policy) });
        } else {
          if (item.output.surgeOptions.length) throw new Error(`${item.output.name} 的 Surge 规则选项无法等价转换，请在当前客户端规则计划中移除或改写。`);
          const manifest = await ensureCompiledRuleSet(env, config, item.output);
          diagnostics.push(...manifest.warnings.map((message) => issue("clients.singbox.ruleSets", "rule-cache", "warning", message)));
          const compatible = manifest.buckets.reduce((sum, bucket) => sum + (bucket.targetCounts?.["sing-box"] ?? 0), 0);
          if (compatible !== manifest.ruleCount) throw new Error("规则集中存在 sing-box 无法等价表达的规则");
          for (const artifact of planRuleSetArtifacts(manifest.buckets, "sing-box")) {
            const tag = `${item.output.name}-${artifact.bucket}`;
            ruleSets.push({ type: "remote", tag, format: "source", url: managedRuleSetUrlForRequest(config, requestUrl, item.output.name, artifact.bucket, "sing-box"), http_client: { detour: "DIRECT" }, update_interval: "1d" });
            rules.push({ rule_set: [tag], ...policyAction(item.output.policy) });
          }
        }
      } catch (error) { diagnostics.push(issue("clients.singbox.ruleSets", "rule-conversion", "error", error instanceof Error ? error.message : "规则集生成失败")); }
    }
    route.rules = rules; route.rule_set = ruleSets;
  }
  const dns = structuredClone(client.dns);
  mergeSingboxHosts(dns, hosts, diagnostics);
  const { coreVersion: _, migrationIssues: __, ruleSets: ___, ...nativeSettings } = client;
  if ("outbounds" in nativeSettings) diagnostics.push(issue("clients.singbox.outbounds", "managed-outbounds", "error", "出站节点由共享节点和策略组生成，请在共享资源中编辑。"));
  const result = { ...nativeSettings, dns, outbounds, route };
  return JSON.stringify(result, null, 2) + "\n";
}
