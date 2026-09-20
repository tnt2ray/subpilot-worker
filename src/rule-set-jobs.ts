import { configDocument, OUTPUT_TARGETS, renderConfig } from "./config-document";
import { deleteKvKeys, readKvJson } from "./kv-helpers";
import { compileRuleSetOutput, ruleSetOutputFingerprint } from "./rule-set-compiler";
import { effectiveRuleSetOutputs, ruleSetOutputNeedsCompilation } from "./rule-set-outputs";
import { ruleSetEnv } from "./rule-set-scope";
import type { RuleSetOutput } from "./rule-set-types";
import { createSingboxAsnResolver } from "./singbox-asn";
import type { RenderConfig, Target } from "./types";

export const RULE_SET_REBUILD_CRON = "*/5 * * * *";
const JOB_PREFIX = "cache:ruleSetJob:";
const RETRY_PREFIX = "cache:ruleSetJobRetry:";
const MIN_REMAINING_MS = 15_000;
const CONFIG_VISIBILITY_GRACE_MS = 5 * 60_000;

export interface RuleSetRebuildJob {
  key: string;
  target: Target;
  outputName: string;
  fingerprint: string;
  createdAt: number;
}

interface JobRetry {
  attempts: number;
  nextAttemptAt: number;
}

/** Persist work before starting it, so closing the client cannot lose a batch. */
export async function queueChangedRuleSetUpdates(
  env: Env,
  previousConfig: RenderConfig,
  config: RenderConfig
): Promise<RuleSetRebuildJob[]> {
  const jobs: RuleSetRebuildJob[] = [];
  for (const target of OUTPUT_TARGETS) {
    const previous = renderConfig(configDocument(previousConfig), target);
    const selected = renderConfig(configDocument(config), target);
    const previousOutputs = new Map(compilationOutputs(previous).map((output) => [output.name, output]));
    for (const output of compilationOutputs(selected)) {
      const fingerprint = await ruleSetOutputFingerprint(selected, output);
      const old = previousOutputs.get(output.name);
      const srsChanged = target === "sing-box" && selected.settings.singboxSrs?.enabled
        && JSON.stringify(previous.settings.singboxSrs) !== JSON.stringify(selected.settings.singboxSrs);
      if (old && !srsChanged && await ruleSetOutputFingerprint(previous, old) === fingerprint) continue;
      jobs.push(await writeJob(env, target, output.name, fingerprint));
    }
  }
  return jobs;
}

/** A scheduled refresh that runs out of time leaves its remaining outputs here. */
export async function queueRuleSetUpdates(
  env: Env,
  config: RenderConfig,
  outputNames: string[]
): Promise<void> {
  const names = new Set(outputNames);
  for (const output of compilationOutputs(config)) {
    if (names.has(output.name)) {
      await writeJob(env, config.renderTarget ?? "surge", output.name, await ruleSetOutputFingerprint(config, output));
    }
  }
}

export async function runRuleSetUpdateJobs(
  env: Env,
  config: RenderConfig,
  options: { deadline: number; jobs?: RuleSetRebuildJob[]; loadCurrentConfig: () => Promise<RenderConfig> }
): Promise<void> {
  const jobs = options.jobs ?? readJobs(env, options.deadline);
  let first = true;
  for await (const job of jobs) {
    if (options.deadline - Date.now() < MIN_REMAINING_MS) break;
    try {
      // The save path already has its verified snapshot; later jobs reload it.
      const current = first && options.jobs ? config : await options.loadCurrentConfig();
      first = false;
      const selected = renderConfig(configDocument(current), job.target);
      const output = compilationOutputs(selected).find((item) => item.name === job.outputName);
      if (!output || await ruleSetOutputFingerprint(selected, output) !== job.fingerprint) {
        // A cron location can briefly observe the job before the saved config.
        if (Date.now() - job.createdAt >= CONFIG_VISIBILITY_GRACE_MS) await removeJob(env, job);
        continue;
      }
      const retry = await readKvJson<JobRetry>(env, retryKey(job));
      if (retry && retry.nextAttemptAt > Date.now()) continue;
      if (options.deadline - Date.now() < MIN_REMAINING_MS) break;
      const scoped = ruleSetEnv(env, job.target);
      const resolveAsn = createSingboxAsnResolver(scoped, options.deadline);
      const result = await compileRuleSetOutput(scoped, selected, output, {
        allowStaleFallback: true,
        forceSourceRefresh: true,
        skipUnchangedSources: true,
        canPublish: async () => jobMatchesConfig(job, await options.loadCurrentConfig()),
        deadline: options.deadline,
        asnResolver: async (value) => {
          const resolved = await resolveAsn(value);
          if (!resolved.prefixes.length && resolved.warning) throw new Error("Rule-set ASN data is unavailable.");
          return resolved;
        }
      });
      const latest = await options.loadCurrentConfig();
      if (!await jobMatchesConfig(job, latest)) {
        // Cover a save racing the final publication check. New work is durable
        // before the old invocation acknowledges completion.
        await queueRuleSetUpdates(env, renderConfig(configDocument(latest), job.target), [job.outputName]);
        await removeJob(env, job);
        continue;
      }
      if (result.stale || result.manifest.outputFingerprint !== job.fingerprint
        || (result.manifest.asnExpiresAt !== undefined && result.manifest.asnExpiresAt <= Date.now())) {
        await deferJob(env, job, retry);
      } else {
        await removeJob(env, job);
      }
    } catch {
      // Store only timing; compiler errors can contain private source addresses.
      await deferJob(env, job).catch(logJobFailure);
    }
  }
}

async function jobMatchesConfig(job: RuleSetRebuildJob, config: RenderConfig): Promise<boolean> {
  const selected = renderConfig(configDocument(config), job.target);
  const output = compilationOutputs(selected).find((item) => item.name === job.outputName);
  return Boolean(output && await ruleSetOutputFingerprint(selected, output) === job.fingerprint);
}

function compilationOutputs(config: RenderConfig): RuleSetOutput[] {
  if (config.ruleSets.mode !== "compiled") return [];
  return effectiveRuleSetOutputs(config.ruleSets).filter((output) => output.enabled
    && ruleSetOutputNeedsCompilation(config.ruleSets, output, config.renderTarget ?? "surge"));
}

async function writeJob(env: Env, target: Target, outputName: string, fingerprint: string): Promise<RuleSetRebuildJob> {
  const createdAt = Date.now();
  // Unique immutable keys prevent a completing invocation from deleting new work.
  const key = `${JOB_PREFIX}${createdAt}:${crypto.randomUUID()}`;
  const job: RuleSetRebuildJob = { key, target, outputName, fingerprint, createdAt };
  await env.SUBPILOT_CONFIG.put(key, JSON.stringify(job));
  return job;
}

async function* readJobs(env: Env, deadline: number): AsyncGenerator<RuleSetRebuildJob> {
  let cursor: string | undefined;
  do {
    if (deadline - Date.now() < MIN_REMAINING_MS) break;
    const page = await env.SUBPILOT_CONFIG.list({ prefix: JOB_PREFIX, limit: 100, ...(cursor ? { cursor } : {}) });
    for (const entry of page.keys) {
      if (deadline - Date.now() < MIN_REMAINING_MS) return;
      const job = await readKvJson<RuleSetRebuildJob>(env, entry.name);
      if (job && job.key === entry.name && OUTPUT_TARGETS.includes(job.target)
        && typeof job.outputName === "string" && /^[a-f0-9]{64}$/.test(job.fingerprint)
        && Number.isFinite(job.createdAt)) yield job;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

function retryKey(job: RuleSetRebuildJob): string {
  return `${RETRY_PREFIX}${job.key.slice(JOB_PREFIX.length)}`;
}

async function deferJob(env: Env, job: RuleSetRebuildJob, previous?: JobRetry | null): Promise<void> {
  const retry = previous ?? await readKvJson<JobRetry>(env, retryKey(job));
  const attempts = Math.min(10, Math.max(0, retry?.attempts ?? 0) + 1);
  const delay = Math.min(60 * 60_000, 60_000 * 2 ** (attempts - 1));
  await env.SUBPILOT_CONFIG.put(retryKey(job), JSON.stringify({ attempts, nextAttemptAt: Date.now() + delay }));
  logJobFailure();
}

async function removeJob(env: Env, job: RuleSetRebuildJob): Promise<void> {
  await deleteKvKeys(env, [job.key, retryKey(job)]);
}

function logJobFailure(): void {
  console.warn(JSON.stringify({ level: "warn", message: "Rule-set update remains pending; a scheduled retry will follow." }));
}
