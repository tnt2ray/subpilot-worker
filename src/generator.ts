import { Buffer } from "node:buffer";
import { collectClashRuleCoverageWarnings } from "./clash-rules";
import { buildClash, buildStash } from "./clash-like-renderer";
import { loadConfig } from "./config-store";
import { parseHostEntries } from "./host-entries";
import { applyTransforms, buildChainNodes, buildConfiguredProxyNodes, nodeTagsForMatching, parseFeatureTagRules } from "./node-transforms";
import { dedupeHostEntries } from "./output-render";
import { parseSubscription } from "./parsers";
import { buildCompiledRuleSetReferencePlan, type CompiledRuleSetReferencePlan } from "./rule-set-compiler";
import type { RuleSetOutputTarget } from "./rule-set-types";
import { fetchCachedSource, sourceUserAgent } from "./source-cache";
import { buildSurge } from "./surge-renderer";
import { collectSurgeRuleCoverageWarnings } from "./surge-rules";
import type { AppConfig, GenerationResult, HostEntry, ProxyNode, Target } from "./types";

(globalThis as typeof globalThis & { Buffer?: typeof Buffer }).Buffer ??= Buffer;

interface FetchedSources {
  nodes: ProxyNode[];
  hostEntries: HostEntry[];
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

export function inferTarget(request: Request): Target | null {
  const ua = request.headers.get("user-agent")?.toLowerCase() ?? "";
  if (ua.includes("shadowrocket")) return "shadowrocket";
  if (ua.includes("stash")) return "stash";
  if (ua.includes("surge")) return "surge";
  if (ua.includes("clash") || ua.includes("mihomo") || ua.includes("clash.meta")) return "clash";
  return null;
}

export async function generateForRequest(env: Env, request: Request, forcedTarget?: Target, options: GenerationOptions = {}): Promise<GenerationResult> {
  const config = await loadConfig(env);
  const target = forcedTarget ?? inferTarget(request);
  if (!target) throw new Error("Unable to infer target from request");
  return generateConfig(env, config, target, request.url, options);
}

export async function generateConfig(
  env: Env,
  config: AppConfig,
  target: Target,
  requestUrl: string,
  options: GenerationOptions = {}
): Promise<GenerationResult> {
  const renderTarget: RuleSetOutputTarget = target === "shadowrocket" ? "clash" : target;
  const prepared = await prepareOutput(env, config, renderTarget, requestUrl);
  if (options.includeRuleDiagnostics && config.ruleSets.mode !== "compiled") {
    if (renderTarget === "surge") {
      prepared.warnings.push(...await collectSurgeRuleCoverageWarnings(config));
    } else if (renderTarget === "clash" || renderTarget === "stash") {
      prepared.warnings.push(...await collectClashRuleCoverageWarnings(config, renderTarget));
    }
  }
  const content = buildTargetContent(config, renderTarget, prepared.nodes, prepared.hostEntries, requestUrl, prepared.warnings, options, prepared.ruleSetPlan);
  return {
    target,
    content,
    contentType: target === "surge"
      ? "text/plain; charset=utf-8"
      : "text/yaml; charset=utf-8",
    proxyCount: prepared.nodes.length,
    fetchedSources: prepared.fetchedSources,
    warnings: prepared.warnings
  };
}

function buildTargetContent(
  config: AppConfig,
  target: Target,
  nodes: ProxyNode[],
  hostEntries: HostEntry[],
  requestUrl: string,
  warnings: string[],
  options: GenerationOptions,
  ruleSetPlan?: CompiledRuleSetReferencePlan
): string {
  if (target === "surge") return buildSurge(config, nodes, hostEntries, requestUrl, ruleSetPlan);
  if (target === "stash") return buildStash(config, nodes, hostEntries, requestUrl, warnings, ruleSetPlan);
  return buildClash(config, nodes, hostEntries, ruleSetPlan);
}

async function prepareOutput(env: Env, config: AppConfig, target: RuleSetOutputTarget, requestUrl: string): Promise<PreparedOutput> {
  const warnings: string[] = [];
  const fetched = await fetchAllSources(env, config, target, warnings);
  const configuredNodes = buildConfiguredProxyNodes(config);
  const supported = await applyTransforms(env, [...fetched.nodes, ...configuredNodes], config, target, warnings);
  const chainNodes = buildChainNodes(supported);
  const nodes = chainNodes.length > 0 ? [...supported, ...chainNodes] : supported;
  const ruleSetPlan = config.ruleSets.mode === "compiled"
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

async function fetchAllSources(env: Env, config: AppConfig, target: Target, warnings: string[]): Promise<FetchedSources> {
  const enabled = config.sources.filter((source) => source.enabled && source.url);
  const featureTagRules = parseFeatureTagRules(config.settings.featureTagRules);
  const batches = await Promise.all(enabled.map(async (source) => {
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
      return {
        nodes,
        hostEntries
      };
    } catch (error) {
      warnings.push(`${source.name}: ${error instanceof Error ? error.message : String(error)}`);
      return { nodes: [], hostEntries: [] };
    }
  }));
  return {
    nodes: batches.flatMap((batch) => batch.nodes),
    hostEntries: dedupeHostEntries(batches.flatMap((batch) => batch.hostEntries))
  };
}
