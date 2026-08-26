import { nodeMatchesFilter } from "./node-transforms";
import { parseConfiguredProxyNode } from "./parsers";
import { parseAllPolicySelector, parseGroupOption, splitGroupSpec } from "./policy-group-spec";
import { isRulePolicyCompatibleWithTarget } from "./rule-targets";
import type { RuleSetOutputTarget } from "./rule-set-types";
import { CHAIN_EXIT_PROXY_NAME, type AppConfig, type ProxyNode } from "./types";

export interface SurgeGroupOutput {
  name: string;
  line: string;
}

export interface SurgeGroupBuildOptions {
  configuredTailscalePolicies?: ReadonlySet<string>;
  availableTailscalePolicies?: ReadonlySet<string>;
}

interface ResolvedPolicyGroup {
  name: string;
  type: string;
  items: string[];
}

export function buildSurgeGroups(
  config: AppConfig,
  nodes: ProxyNode[],
  buildOptions: SurgeGroupBuildOptions = {}
): SurgeGroupOutput[] {
  const disabledGroups = new Set(config.disabledGroups);
  const unavailableConfiguredProxyNames = configuredProxyNamesUnavailableIn(nodes, config);
  const groups = activeGroupEntries(config, "surge").map(([name, spec]) => {
    const [type, ...rawItems] = splitGroupSpec(spec);
    const groupType = (type || "select").trim().toLowerCase();
    const surgeHidden = surgeHiddenValue(rawItems);
    const groupItems = rawItems.filter((item) => !isSurgeHiddenOption(item));
    const resolved = groupType === "subnet"
      ? resolveSubnetGroupItems(groupItems, name, disabledGroups, nodes)
      : resolveGroupItems(groupItems, nodes).filter((item) => (
        isAllowedGroupItem(item)
        && !disabledGroups.has(item)
        && isRulePolicyCompatibleWithTarget(item, "surge")
      ));
    const targetAvailable = filterUnavailableConfiguredPolicies(groupType, resolved, unavailableConfiguredProxyNames);
    const available = filterUnavailableTailscalePolicies(groupType, targetAvailable, buildOptions);
    const items = groupType === "subnet" ? available : available.filter((item) => !parseGroupOption(item));
    const groupOptions = groupType === "subnet" || groupType === "url-test"
      ? []
      : resolved.filter((item) => parseGroupOption(item));
    return { name, type: groupType, items, options: groupOptions, surgeHidden };
  });
  const emittedNames = emittedPolicyGroupNames(config, groups);
  return groups.flatMap(({ name, type, items, options, surgeHidden }) => {
    if (!emittedNames.has(name)) return [];
    const outputItems = ensureUsableRootProxyItems(
      name,
      ensureSubnetDefault(type, pruneUnavailableGroupReferences(config, type, items, emittedNames))
    );
    const surgeOptions = surgeHidden ? ["hidden=true"] : [];
    return [{ name, line: `${name} = ${[mapSurgeGroupType(type), ...outputItems, ...options, ...surgeOptions].join(", ")}` }];
  });
}

function filterUnavailableTailscalePolicies(
  groupType: string,
  items: string[],
  options: SurgeGroupBuildOptions
): string[] {
  const configured = options.configuredTailscalePolicies;
  if (!configured || configured.size === 0) return items;
  const available = options.availableTailscalePolicies ?? new Set<string>();
  return items.filter((item) => {
    const policy = groupType === "subnet" ? parseGroupOption(item, { requireValue: true })?.value : item;
    return !policy || !configured.has(policy) || available.has(policy);
  });
}

export function buildClashGroups(
  config: AppConfig,
  nodes: ProxyNode[],
  target: Extract<RuleSetOutputTarget, "clash" | "stash"> = "clash"
): Record<string, unknown>[] {
  const disabledGroups = new Set(config.disabledGroups);
  const unavailableConfiguredPolicies = configuredProxyNamesUnavailableIn(nodes, config);
  for (const node of config.surge.tailscaleNodes) unavailableConfiguredPolicies.add(node.name);
  const groups = activeGroupEntries(config, "clash").map(([name, spec]) => {
    const [type, ...items] = splitGroupSpec(spec);
    const groupType = (type || "select").trim().toLowerCase();
    const proxies = resolveGroupItems(items, nodes).filter((item) => (
      !item.includes("=")
      && isAllowedGroupItem(item)
      && !disabledGroups.has(item)
      && isRulePolicyCompatibleWithTarget(item, target)
      && !unavailableConfiguredPolicies.has(item)
    ));
    const options = Object.fromEntries(items
      .filter((item) => !parseAllPolicySelector(item) && !isSurgeHiddenOption(item) && item.includes("="))
      .map((item) => item.split(/=(.*)/s) as [string, string]));
    return { name, type: groupType, items: proxies, options };
  });
  const emittedNames = emittedPolicyGroupNames(config, groups);
  return groups.flatMap(({ name, type, items, options }) => {
    if (!emittedNames.has(name)) return [];
    const proxies = ensureUsableRootProxyItems(
      name,
      pruneUnavailableGroupReferences(config, type, items, emittedNames)
    );
    return [{
      name,
      type: mapClashGroupType(type),
      proxies,
      ...options
    }];
  });
}

function configuredProxyNamesUnavailableIn(nodes: ProxyNode[], config: AppConfig): Set<string> {
  const available = new Set(nodes.filter((node) => node.manual).map((node) => node.name));
  const unavailable = new Set<string>();
  for (const proxyNode of config.proxyNodes) {
    const name = parseConfiguredProxyNode(proxyNode)?.name.trim();
    if (name && !available.has(name)) unavailable.add(name);
  }
  return unavailable;
}

function filterUnavailableConfiguredPolicies(groupType: string, items: string[], unavailable: ReadonlySet<string>): string[] {
  if (unavailable.size === 0) return items;
  return items.filter((item) => {
    const policy = groupType === "subnet" ? parseGroupOption(item, { requireValue: true })?.value : item;
    return !policy || !unavailable.has(policy);
  });
}

export function isSurgeOnlyGroupSpec(spec: string): boolean {
  const [type = "select"] = splitGroupSpec(spec);
  return type.trim().toLowerCase() === "subnet";
}

function shouldEmitPolicyGroup(name: string, type: string, resolvedItems: string[]): boolean {
  return name === "Proxy" || type === "subnet" || resolvedItems.length > 0;
}

function emittedPolicyGroupNames(config: AppConfig, groups: ResolvedPolicyGroup[]): Set<string> {
  const emittedNames = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of groups) {
      if (emittedNames.has(group.name)) continue;
      const availableItems = pruneUnavailableGroupReferences(config, group.type, group.items, emittedNames);
      if (!shouldEmitPolicyGroup(group.name, group.type, availableItems)) continue;
      emittedNames.add(group.name);
      changed = true;
    }
  }
  return emittedNames;
}

function pruneUnavailableGroupReferences(
  config: AppConfig,
  groupType: string,
  items: string[],
  emittedNames: Set<string>
): string[] {
  const configuredNames = new Set(Object.keys(config.groups));
  return items.filter((item) => {
    const policy = groupType === "subnet"
      ? parseGroupOption(item, { requireValue: true })?.value
      : item;
    return !policy || !configuredNames.has(policy) || emittedNames.has(policy);
  });
}

function ensureSubnetDefault(groupType: string, items: string[]): string[] {
  if (groupType !== "subnet" || items.some((item) => parseGroupOption(item)?.key.toLowerCase() === "default")) {
    return items;
  }
  return ["default=Proxy", ...items];
}

function ensureUsableRootProxyItems(name: string, items: string[]): string[] {
  return name === "Proxy" && items.length === 0 ? ["DIRECT"] : items;
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
    && !disabledGroups.has(policy)
    && isRulePolicyCompatibleWithTarget(policy, "surge");
}

function isAllowedGroupItem(item: string): boolean {
  return item !== "Proxy";
}

function surgeHiddenValue(items: string[]): boolean {
  let hidden = false;
  for (const item of items) {
    const option = parseGroupOption(item);
    if (option?.key.toLowerCase() !== "hidden") continue;
    hidden = option.value.toLowerCase() === "true" || option.value === "1";
  }
  return hidden;
}

function isSurgeHiddenOption(item: string): boolean {
  return parseGroupOption(item)?.key.toLowerCase() === "hidden";
}

function mapSurgeGroupType(type: string): string {
  if (type === "url-test") return "smart";
  return type;
}

function mapClashGroupType(type: string): string {
  return type;
}
