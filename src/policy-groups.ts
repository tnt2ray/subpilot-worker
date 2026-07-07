import { nodeMatchesFilter } from "./node-transforms";
import { parseAllPolicySelector, parseGroupOption, splitGroupSpec } from "./policy-group-spec";
import { CHAIN_EXIT_PROXY_NAME, type AppConfig, type ProxyNode } from "./types";

export interface SurgeGroupOutput {
  name: string;
  line: string;
}

export function buildSurgeGroups(config: AppConfig, nodes: ProxyNode[]): SurgeGroupOutput[] {
  const disabledGroups = new Set(config.disabledGroups);
  return activeGroupEntries(config, "surge").flatMap(([name, spec]) => {
    const [type, ...items] = splitGroupSpec(spec);
    const groupType = type || "select";
    const resolved = groupType === "subnet"
      ? resolveSubnetGroupItems(items, name, disabledGroups, nodes)
      : resolveGroupItems(items, nodes).filter((item) => isAllowedGroupItem(item) && !disabledGroups.has(item));
    const outputItems = groupType === "url-test" ? resolved.filter((item) => !item.includes("=")) : resolved;
    if (!shouldEmitPolicyGroup(name, groupType, outputItems)) return [];
    return [{ name, line: `${name} = ${[mapSurgeGroupType(groupType), ...outputItems].join(", ")}` }];
  });
}

export function buildClashGroups(config: AppConfig, nodes: ProxyNode[]): Record<string, unknown>[] {
  const disabledGroups = new Set(config.disabledGroups);
  return activeGroupEntries(config, "clash").flatMap(([name, spec]) => {
    const [type, ...items] = splitGroupSpec(spec);
    const groupType = type || "select";
    const proxies = resolveGroupItems(items, nodes).filter((item) => !item.includes("=") && isAllowedGroupItem(item) && !disabledGroups.has(item));
    if (!shouldEmitPolicyGroup(name, groupType, proxies)) return [];
    const options = Object.fromEntries(items.filter((item) => item.includes("=")).map((item) => item.split(/=(.*)/s) as [string, string]));
    return [{
      name,
      type: mapClashGroupType(groupType),
      proxies,
      ...options
    }];
  });
}

export function isSurgeOnlyGroupSpec(spec: string): boolean {
  const [type = "select"] = splitGroupSpec(spec);
  return type === "subnet";
}

function shouldEmitPolicyGroup(name: string, type: string, resolvedItems: string[]): boolean {
  return name === "Proxy" || type === "subnet" || resolvedItems.length > 0;
}

function activeGroupEntries(config: AppConfig, target: "surge" | "clash"): [string, string][] {
  const disabledGroups = new Set(config.disabledGroups);
  return Object.entries(config.groups).filter(([name, spec]) => {
    if (disabledGroups.has(name)) return false;
    return target === "surge" || !isSurgeOnlyGroupSpec(spec);
  });
}

function resolveGroupItems(items: string[], nodes: ProxyNode[]): string[] {
  const output: string[] = [];
  const excludedChainExitNames = new Set(nodes.filter((node) => isChainExitExcludedFromGroups(node)).map((node) => node.name));
  const includableNodeNames = new Set(nodes.filter(nodeCanEnterGroups).map((node) => node.name));
  for (const item of items) {
    const selector = parseAllPolicySelector(item);
    if (!selector) {
      if (excludedChainExitNames.has(item)) continue;
      if (item === CHAIN_EXIT_PROXY_NAME && !includableNodeNames.has(item)) continue;
      output.push(item);
      continue;
    }
    const filters = selector.filter.split(",").map((part) => part.trim()).filter(Boolean);
    const excludes = selector.exclude.split(",").map((part) => part.trim()).filter(Boolean);
    output.push(...nodes
      .filter(nodeCanEnterGroups)
      .filter((node) => filters.length === 0 || filters.some((filter) => nodeMatchesFilter(node, filter)))
      .filter((node) => excludes.every((exclude) => !nodeMatchesFilter(node, exclude)))
      .map((node) => node.name));
  }
  return [...new Set(output)];
}

function nodeCanEnterGroups(node: ProxyNode): boolean {
  return !node.chainExit || node.includeInGroups === true;
}

function isChainExitExcludedFromGroups(node: ProxyNode): boolean {
  return node.chainExit === true && node.includeInGroups !== true;
}

function resolveSubnetGroupItems(items: string[], groupName: string, disabledGroups: Set<string>, nodes: ProxyNode[]): string[] {
  const output: string[] = [];
  let hasDefault = false;
  const excludedChainExitNames = new Set(nodes.filter((node) => isChainExitExcludedFromGroups(node)).map((node) => node.name));
  const includableNodeNames = new Set(nodes.filter(nodeCanEnterGroups).map((node) => node.name));
  for (const item of items) {
    const option = parseGroupOption(item, { requireValue: true });
    if (!option) continue;
    if (!isSubnetGroupOption(option.key)) continue;
    if (!isAllowedSubnetPolicy(option.value, groupName, disabledGroups, excludedChainExitNames, includableNodeNames)) continue;
    const isDefault = option.key.toLowerCase() === "default";
    if (isDefault) {
      if (hasDefault) continue;
      hasDefault = true;
    }
    const line = `${option.key}=${option.value}`;
    output.push(line);
  }
  if (!hasDefault) {
    output.unshift("default=Proxy");
  }
  return output;
}

function isSubnetGroupOption(key: string): boolean {
  return key.toLowerCase() === "default" || /^(SSID|BSSID|ROUTER):.+$/i.test(key) || /^TYPE:(WIFI|WIRED|CELLULAR)$/i.test(key);
}

function isAllowedSubnetPolicy(
  policy: string,
  groupName: string,
  disabledGroups: Set<string>,
  excludedChainExitNames: Set<string>,
  includableNodeNames: Set<string>
): boolean {
  return policy !== groupName
    && !excludedChainExitNames.has(policy)
    && (policy !== CHAIN_EXIT_PROXY_NAME || includableNodeNames.has(policy))
    && !disabledGroups.has(policy);
}

function isAllowedGroupItem(item: string): boolean {
  return item !== "Proxy";
}

function mapSurgeGroupType(type: string): string {
  if (type === "url-test") return "smart";
  return type;
}

function mapClashGroupType(type: string): string {
  return type;
}
