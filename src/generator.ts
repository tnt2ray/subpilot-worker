import { validateSingboxOutput } from "./singbox-validation";
import { validateSurgeRules } from "./surge-rules";
import { validateClashLikeRules } from "./clash-rules";
import { validateTailscalePolicies } from "./config-validation";
import { validateSurgeHosts } from "./surge-hosts";
import { validateSurgeMapLocal } from "./surge-map-local";
import { validateSurgeUrlRewrite } from "./surge-url-rewrite";
import { configDocument, renderConfig } from "./config-document";
import { ruleSetEnv } from "./rule-set-scope";
import { buildSingbox } from "./singbox-renderer";
import { omitEmptyPolicyGroups } from "./empty-policy-groups";
import { collectOutputDiagnostics } from "./output-diagnostics";
import type { ConfigDiagnostic } from "./types";
import { Buffer } from "node:buffer";
import { collectClashRuleCoverageWarnings } from "./clash-rules";
import { buildClash } from "./clash-like-renderer";
import { loadConfig } from "./config-store";
import { parseHostEntries } from "./host-entries";
import { applyTransforms, buildChainNodes, buildConfiguredProxyNodes, ensureUniqueProxyPolicyNames, nodeTagsForMatching, parseFeatureTagRules, resolveProxyNodeReferences } from "./node-transforms";
import { dedupeHostEntries } from "./output-render";
import { parseSubscription } from "./parsers";
import { buildCompiledRuleSetReferencePlan, type CompiledRuleSetReferencePlan } from "./rule-set-compiler";
import type { RuleSetOutputTarget } from "./rule-set-types";
import { fetchCachedSource, sourceUserAgent } from "./source-cache";
import { buildSurge } from "./surge-renderer";
import { collectSurgeRuleCoverageWarnings } from "./surge-rules";
import type { RenderConfig, GenerationResult, HostEntry, ProxyNode, Target } from "./types";
import { mapWithConcurrency } from "./util";

(globalThis as typeof globalThis & { Buffer?: typeof Buffer }).Buffer ??= Buffer;

interface FetchedSources {
  nodes: ProxyNode[];
  hostEntries: HostEntry[];
}

interface FetchedSourceBatch extends FetchedSources {
  warning?: string | undefined;
}

interface PreparedOutput {
  nodes: ProxyNode[];
  hostEntries: HostEntry[];
  fetchedSources: number;
  warnings: string[];
  ruleSetPlan?: CompiledRuleSetReferencePlan | undefined;
}

interface GenerationOptions {
  includeRuleDiagnostics?: boolean;
}

const SOURCE_FETCH_CONCURRENCY = 2;
const MAX_NODES_PER_SOURCE = 2_500;
const MAX_HOST_ENTRIES_PER_SOURCE = 5_000;
const MAX_TOTAL_SOURCE_NODES = 10_000;
const MAX_TOTAL_HOST_ENTRIES = 20_000;
const MAX_TOTAL_OUTPUT_NODES = 15_000;
const MAX_RENDERED_CONFIG_CHARACTERS = 8 * 1024 * 1024;

/** The universal subscription selects the client family, never its version. */
export function inferTarget(request: Request): Target | null {
  const ua = request.headers.get("user-agent")?.toLowerCase() ?? "";
  if (ua.includes("shadowrocket") || ua.includes("stash")) return null;
  const targets: Target[] = [];
  if (ua.includes("surge")) targets.push("surge");
  if (ua.includes("clash") || ua.includes("mihomo")) targets.push("clash");
  if (ua.includes("sing-box") || ua.includes("singbox")) targets.push("sing-box");
  return targets.length === 1 ? targets[0]! : null;
}

export async function generateForRequest(env: Env, request: Request, target: Target, options: GenerationOptions = {}): Promise<GenerationResult> {
  const config = await loadConfig(env);
  return generateConfig(env, config, target, request.url, options);
}

export async function generateConfig(
  env: Env,
  config: RenderConfig,
  target: Target,
  requestUrl: string,
  options: GenerationOptions = {}
): Promise<GenerationResult> {
  config = renderConfig(configDocument(config), target);
  env = ruleSetEnv(env, target);
  const renderTarget = target;
  const diagnostics: ConfigDiagnostic[] = [];
  let prepared: PreparedOutput;
  try { prepared = await prepareOutput(env, config, target, requestUrl); }
  catch { return { target, content: "", contentType: "text/plain; charset=utf-8", proxyCount: 0, fetchedSources: 0, warnings: [], canDownload: false,
    diagnostics: [...diagnostics, { target, severity: "error", code: "preparation-failed", path: "ruleSets", message: "生成准备失败，请检查规则来源和配置引用。" }] }; }
  if (options.includeRuleDiagnostics && config.ruleSets.mode !== "compiled") {
    if (renderTarget === "surge") {
      prepared.warnings.push(...await collectSurgeRuleCoverageWarnings(config));
    } else if (renderTarget === "clash") {
      prepared.warnings.push(...await collectClashRuleCoverageWarnings(config, renderTarget));
    }
  }
  diagnostics.push(...(prepared.ruleSetPlan?.errors ?? []).map((message): ConfigDiagnostic => ({ target, severity: "error", code: "rule-set-incompatible", path: "ruleSets", message })));
  let content = "";
  let proxyCount = prepared.nodes.length;
  try {
    content = target === "sing-box"
      ? await buildSingbox(env, config, prepared.nodes, prepared.hostEntries, requestUrl, diagnostics)
      : buildTargetContent(config, target, prepared.nodes, prepared.hostEntries, requestUrl, prepared.ruleSetPlan);
    const resolved = omitEmptyPolicyGroups(config, target, content);
    config = resolved.config;
    content = resolved.content;
    diagnostics.push(...resolved.diagnostics);
    diagnostics.push(...collectOutputDiagnostics(config, target, content));
    if (target === "sing-box") {
      const output = JSON.parse(content);
      proxyCount = output.outbounds.filter((item: { type: string }) => !["direct", "selector", "urltest"].includes(item.type)).length;
      diagnostics.push(...validateSingboxOutput(output));
    }
    else if (config.ruleSets.mode !== "compiled") {
      const nodePolicies = prepared.nodes.map((node) => node.name);
      const message = target === "surge" ? validateSurgeRules(config, nodePolicies) : validateClashLikeRules(config, "clash", nodePolicies);
      if (message) diagnostics.push({ target, severity: "error", code: "rule-validation", path: "rules", message });
    }
    if (target === "surge") {
      const message = validateTailscalePolicies(config) || validateSurgeHosts(config) || validateSurgeMapLocal(config) || validateSurgeUrlRewrite(config);
      if (message) diagnostics.push({ target, severity: "error", code: "surge-validation", path: "clients.surge", message });
    }
  } catch {
    diagnostics.push({ target, severity: "error", code: "render-failed", path: "clients", message: "配置无法生成，请检查节点、策略组和规则格式。" });
  }
  const canDownload = !diagnostics.some((item) => item.severity === "error");
  if (content.length > MAX_RENDERED_CONFIG_CHARACTERS) {
    throw new Error(`Generated configuration exceeds ${MAX_RENDERED_CONFIG_CHARACTERS} character limit`);
  }
  return {
    target,
    content: canDownload ? content : "",
    canDownload, diagnostics,
    contentType: target === "surge"
      ? "text/plain; charset=utf-8"
      : target === "sing-box" ? "application/json; charset=utf-8" : "text/yaml; charset=utf-8",
    proxyCount,
    fetchedSources: prepared.fetchedSources,
    warnings: prepared.warnings
  };
}

function buildTargetContent(
  config: RenderConfig,
  target: Target,
  nodes: ProxyNode[],
  hostEntries: HostEntry[],
  requestUrl: string,
  ruleSetPlan?: CompiledRuleSetReferencePlan
): string {
  if (target === "surge") return buildSurge(config, nodes, hostEntries, requestUrl, ruleSetPlan);
  return buildClash(config, nodes, hostEntries, ruleSetPlan);
}

async function prepareOutput(env: Env, config: RenderConfig, target: Target, requestUrl: string): Promise<PreparedOutput> {
  const warnings: string[] = [];
  const fetched = await fetchAllSources(env, config, target, warnings);
  const configuredNodes = buildConfiguredProxyNodes(config);
  const transformed = await applyTransforms(env, [...fetched.nodes, ...configuredNodes], config, target, warnings);
  const supported = resolveProxyNodeReferences(ensureUniqueProxyPolicyNames(transformed, config, warnings));
  const chainNodes = buildChainNodes(supported);
  const uniqueChainNodes = ensureUniqueProxyPolicyNames(chainNodes, config, warnings, supported.map((node) => node.name));
  const nodes = uniqueChainNodes.length > 0 ? [...supported, ...uniqueChainNodes] : supported;
  if (nodes.length > MAX_TOTAL_OUTPUT_NODES) {
    throw new Error(`Generated configuration contains ${nodes.length} proxy nodes; maximum is ${MAX_TOTAL_OUTPUT_NODES}`);
  }
  const ruleSetPlan = target !== "sing-box" && config.ruleSets.mode === "compiled"
    ? await buildCompiledRuleSetReferencePlan(env, config, target, requestUrl)
    : undefined;
  if (ruleSetPlan) warnings.push(...ruleSetPlan.warnings);
  return {
    nodes,
    hostEntries: fetched.hostEntries,
    fetchedSources: config.sources.filter((source) => source.enabled && source.url).length,
    warnings,
    ruleSetPlan
  };
}

async function fetchAllSources(env: Env, config: RenderConfig, target: Target, warnings: string[]): Promise<FetchedSources> {
  const enabled = config.sources.filter((source) => source.enabled && source.url);
  const featureTagRules = parseFeatureTagRules(config.settings.featureTagRules);
  const batches: FetchedSourceBatch[] = Array.from({ length: enabled.length }, () => ({ nodes: [], hostEntries: [] }));
  let retainedNodes = 0;
  let retainedHostEntries = 0;
  await mapWithConcurrency(enabled.map((source, index) => ({ source, index })), SOURCE_FETCH_CONCURRENCY, async ({ source, index }) => {
    try {
      const content = await fetchCachedSource(env, source, sourceUserAgent(config, source));
      const hostEntries = parseHostEntries(content);
      const nodes = parseSubscription(content, source.id).map((node) => ({
        ...node,
        name: node.name,
        originalName: node.name,
        sourceName: source.name,
        ...nodeTagsForMatching(node.name, node.matchLabels, featureTagRules)
      }));
      if (nodes.length > MAX_NODES_PER_SOURCE) {
        throw new Error(`Source contains ${nodes.length} nodes; maximum is ${MAX_NODES_PER_SOURCE}`);
      }
      if (hostEntries.length > MAX_HOST_ENTRIES_PER_SOURCE) {
        throw new Error(`Source contains ${hostEntries.length} host entries; maximum is ${MAX_HOST_ENTRIES_PER_SOURCE}`);
      }
      if (retainedNodes + nodes.length > MAX_TOTAL_SOURCE_NODES) {
        throw new Error(`All sources exceed the ${MAX_TOTAL_SOURCE_NODES} node request limit`);
      }
      if (retainedHostEntries + hostEntries.length > MAX_TOTAL_HOST_ENTRIES) {
        throw new Error(`All sources exceed the ${MAX_TOTAL_HOST_ENTRIES} host-entry request limit`);
      }
      retainedNodes += nodes.length;
      retainedHostEntries += hostEntries.length;
      batches[index] = {
        nodes,
        hostEntries
      };
    } catch (error) {
      batches[index] = {
        nodes: [],
        hostEntries: [],
        warning: `${source.name}: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  });
  warnings.push(...batches.flatMap((batch) => batch.warning ? [batch.warning] : []));
  return {
    nodes: batches.flatMap((batch) => batch.nodes),
    hostEntries: dedupeHostEntries(batches.flatMap((batch) => batch.hostEntries))
  };
}
