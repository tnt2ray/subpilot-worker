import { configDocument, OUTPUT_TARGETS, renderConfig } from "./config-document";
import { loadConfig } from "./config-store";
import { decryptJson, encryptJson } from "./crypto-store";
import { planRuleSetArtifacts } from "./rule-set-artifacts";
import { readCompiledRuleSetManifest, type CompiledRuleSetManifest } from "./rule-set-cache";
import { ruleSetOutputFingerprint, type RuleCompilationConfig } from "./rule-set-compiler-core";
import { effectiveRuleSetOutputs, planRuleSetOutputs, ruleSetOutputNeedsCompilation } from "./rule-set-outputs";
import type { RuleSetOutput } from "./rule-set-types";
import { requireSecret } from "./secrets";
import { readActionsCredentials } from "./actions-compiler-credentials";
import { githubActionsManifestUrl, ACTIONS_COMPILER_PROTOCOL, ACTIONS_WORKFLOW_FILENAME, actionsCompilerProtocolKey, actionsArtifactDirectory, actionsArtifactPath, actionsOutputKey, type ActionsBucket } from "./actions-compiler-artifacts";
import type { RenderConfig, Target } from "./types";
import { jsonResponse, notFound, readRequestJsonWithLimit, readResponseTextWithLimit, sha256Hex, timingSafeEqualString, unauthorized } from "./util";
import { ruleCompilationMode, workerFallbackConfig } from "./rule-compilation-mode";
import { ruleSetEnv, workerFallbackEnv } from "./rule-set-scope";
import kernelChecksum from "./vendor/singbox/srs-compiler.wasm.sha256" with { type: "text" };

interface CompilationJob {
  id: string;
  integration: string;
  createdAt: number;
  target: Target;
  fingerprint: string;
  output: RuleSetOutput;
  config: RuleCompilationConfig;
}
interface CompilationBatch { id: string; integration: string; jobs: CompilationJob[] }
interface DispatchResult { attemptedAt: number; accepted: boolean; httpStatus?: number }
const JOB_PREFIX = "cache:actionsCompiler:job:";
const BATCH_PREFIX = "cache:actionsCompiler:batch:";
const DISPATCH_PREFIX = "cache:actionsCompiler:dispatch:";
const RESULT_PREFIX = "cache:actionsCompiler:dispatchResult:";
const COMPLETE_PREFIX = "cache:actionsCompiler:published:";
const SNAPSHOT_TTL = 24 * 60 * 60;
const RETRY_MS = 60 * 60_000;
const NO_STORE = { "cache-control": "no-store, private" };

export function usesActionsCompilation(config: RenderConfig): boolean {
  return config.ruleSets.mode === "compiled" && ruleCompilationMode(config) === "actions";
}
export async function validateActionsCompilationCredentials(env: Env, config: { settings: Pick<RenderConfig["settings"], "actionsCompilation" | "ruleCompilationMode"> }): Promise<string | null> {
  if (ruleCompilationMode(config) !== "actions") return null;
  const credentials = await readActionsCredentials(env);
  if (!credentials.token || !credentials.sharedSecret) return "请先通过 Actions 规则编译配置向导保存 GitHub Token 并安装工作流。 / Save a GitHub token and install the workflow through the Actions rule compilation setup wizard.";
  return null;
}
async function integrationFingerprint(config: RenderConfig): Promise<string> {
  const settings = config.settings.actionsCompilation;
  return sha256Hex(JSON.stringify([ACTIONS_COMPILER_PROTOCOL, settings && {
    enabled: ruleCompilationMode(config) === "actions", repository: settings.repository, ref: settings.ref, workflow: ACTIONS_WORKFLOW_FILENAME
  }]));
}
async function jobForOutput(config: RenderConfig, output: RuleSetOutput): Promise<CompilationJob> {
  const target = config.renderTarget ?? "surge";
  const integration = await integrationFingerprint(config);
  const fingerprint = await ruleSetOutputFingerprint(config, output);
  const id = await sha256Hex(JSON.stringify([integration, target, output.name, fingerprint]));
  const members = planRuleSetOutputs(config.ruleSets).find((item) => item.output.name === output.name)?.includedOutputNames ?? [output.name];
  const sources = new Set(output.sourceIds);
  return { id, integration, fingerprint, target, createdAt: Date.now(), output,
    config: { renderTarget: target, settings: { ruleCompilationMode: "actions" }, ruleSets: { ...config.ruleSets, directRules: [],
      sources: config.ruleSets.sources.filter((source) => sources.has(source.id)),
      outputs: config.ruleSets.outputs.filter((member) => members.includes(member.name)) } } };
}
async function batchForConfig(config: RenderConfig): Promise<CompilationBatch> {
  const jobs: CompilationJob[] = [];
  const document = configDocument(config);
  for (const target of OUTPUT_TARGETS) {
    const selected = renderConfig(document, target);
    if (!usesActionsCompilation(selected)) continue;
    for (const output of effectiveRuleSetOutputs(selected.ruleSets)) {
      if (output.enabled && ruleSetOutputNeedsCompilation(selected.ruleSets, output, target)) jobs.push(await jobForOutput(selected, output));
    }
  }
  const integration = await integrationFingerprint(config);
  return { id: await sha256Hex(JSON.stringify([integration, jobs.map((job) => job.id)])), integration, jobs };
}
async function publishedManifest(env: Env, job: CompilationJob): Promise<CompiledRuleSetManifest | null> {
  const manifest = await env.SUBPILOT_CONFIG.get<CompiledRuleSetManifest>(`${COMPLETE_PREFIX}${job.id}`, "json");
  return manifest?.publication?.jobId === job.id && manifest.publication.integration === job.integration
    && manifest.publication.target === job.target && /^[a-f0-9]{40}$/.test(manifest.publication.commit)
    && manifest.outputFingerprint === job.fingerprint ? manifest : null;
}
export async function readActionsManifest(env: Env, config: RenderConfig, output: RuleSetOutput): Promise<CompiledRuleSetManifest | null> {
  return (await createActionsManifestReader(env, config))(output);
}
/** Reuse one request-local batch snapshot across all outputs of a client. */
export async function createActionsManifestReader(env: Env, config: RenderConfig): Promise<(output: RuleSetOutput) => Promise<CompiledRuleSetManifest | null>> {
  const unavailable = async () => null;
  if (!usesActionsCompilation(config)) return unavailable;
  try {
    const batch = await batchForConfig(config);
    const last = await env.SUBPILOT_CONFIG.get<number>(`${DISPATCH_PREFIX}${batch.id}`, "json");
    const jobs = new Map(batch.jobs.filter((job) => job.target === (config.renderTarget ?? "surge")).map((job) => [job.output.name, job]));
    return async (output) => {
      try {
        const job = jobs.get(output.name);
        const manifest = job ? await publishedManifest(env, job) : null;
        return manifest && (!last || manifest.publication!.confirmedAt >= last)
          && (!manifest.asnExpiresAt || manifest.asnExpiresAt > Date.now()) ? manifest : null;
      } catch {
        console.warn(JSON.stringify({ level: "warn", message: "Actions metadata is unavailable; publication remains pending." }));
        return null;
      }
    };
  } catch {
    console.warn(JSON.stringify({ level: "warn", message: "Actions metadata is unavailable; publication remains pending." }));
    return unavailable;
  }
}

/** Persist only rule-plan snapshots; all source fetching and compilation run in Actions. */
export async function ensureActionsCompilation(env: Env, config: RenderConfig, options: { force?: boolean; refresh?: boolean; deadline?: number } = {}): Promise<void> {
  if (ruleCompilationMode(config) !== "actions") return;
  const batch = await batchForConfig(config);
  if (!batch.jobs.length) return;
  const last = await env.SUBPILOT_CONFIG.get<number>(`${DISPATCH_PREFIX}${batch.id}`, "json");
  if (!options.refresh) {
    const ready = await Promise.all(batch.jobs.map((job) => publishedManifest(env, job)));
    if (ready.every((manifest) => manifest && (!last || manifest.publication!.confirmedAt >= last) && (!manifest.asnExpiresAt || manifest.asnExpiresAt > Date.now()))) return;
  }
  const settings = config.settings.actionsCompilation;
  if (!settings) throw new Error("Configure Actions compilation settings first");
  if (await env.SUBPILOT_CONFIG.get(actionsCompilerProtocolKey(settings)) !== ACTIONS_COMPILER_PROTOCOL) throw new Error("请通过配置向导安装当前 Actions 规则编译工作流。 / Install the current Actions rule compilation workflow through the setup wizard.");
  if (!options.force && last && Date.now() - last < RETRY_MS) return;
  if (options.deadline && options.deadline - Date.now() < 2_000) return;
  const credentials = await readActionsCredentials(env);
  if (!credentials.token || !credentials.sharedSecret) throw new Error("Configure Actions compilation credentials first");
  const encryptionKey = requireSecret(env, "CONFIG_ENCRYPTION_KEY");
  async function saveSnapshot(key: string, snapshot: object): Promise<void> {
    if (options.deadline && options.deadline - Date.now() < 2_000) throw new Error("Actions snapshot preparation is pending");
    const stored = await env.SUBPILOT_CONFIG.get(key);
    const previous = stored ? await decryptJson<{ createdAt?: number }>(encryptionKey, stored) : null;
    // Renew before expiry so a dispatched runner retains a full execution window.
    if (!previous?.createdAt || Date.now() - previous.createdAt > SNAPSHOT_TTL * 500) {
      await env.SUBPILOT_CONFIG.put(key, await encryptJson(encryptionKey, { ...snapshot, createdAt: Date.now() }), { expirationTtl: SNAPSHOT_TTL });
    }
  }
  for (const job of batch.jobs) await saveSnapshot(`${JOB_PREFIX}${job.id}`, job);
  await saveSnapshot(`${BATCH_PREFIX}${batch.id}`, { integration: batch.integration, jobs: batch.jobs.map(({ id, target, output }) => ({ jobId: id, target, outputKey: actionsOutputKey(target, output.name) })) });
  const attemptedAt = Date.now();
  await env.SUBPILOT_CONFIG.put(`${DISPATCH_PREFIX}${batch.id}`, JSON.stringify(attemptedAt), { expirationTtl: SNAPSHOT_TTL });
  const repository = settings.repository.split("/").map(encodeURIComponent).join("/");
  let httpStatus: number | undefined, accepted = false;
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/${ACTIONS_WORKFLOW_FILENAME}/dispatches`, {
      method: "POST", redirect: "manual", headers: { accept: "application/vnd.github+json", "content-type": "application/json", authorization: `Bearer ${credentials.token}`, "user-agent": "SubPilot-Actions", "x-github-api-version": "2022-11-28" },
      body: JSON.stringify({ ref: settings.ref, inputs: { job_id: batch.id } }),
      signal: AbortSignal.timeout(Math.max(1, Math.min(8_000, (options.deadline ?? Date.now() + 8_000) - Date.now())))
    });
    httpStatus = response.status; accepted = response.ok;
    await response.body?.cancel().catch(() => undefined);
  } catch { /* A timeout does not prove that GitHub rejected the dispatch. */ }
  await env.SUBPILOT_CONFIG.put(`${RESULT_PREFIX}${batch.id}`, JSON.stringify({ attemptedAt, accepted, ...(httpStatus !== undefined ? { httpStatus } : {}) } satisfies DispatchResult), { expirationTtl: SNAPSHOT_TTL });
  if (!accepted) throw new Error("Actions 编译请求未确认，请查看编译进度；后台会重试。 / Actions compilation request was not confirmed; check compilation progress. Background retries remain enabled.");
}
export async function retryActionsCompilationJobs(env: Env, config: RenderConfig, deadline: number): Promise<void> {
  try { await ensureActionsCompilation(env, config, { deadline }); }
  catch { console.warn(JSON.stringify({ level: "warn", message: "Actions rule compilation remains pending." })); }
}
export async function handleActionsCompilationStatus(env: Env): Promise<Response> {
  try {
    const config = await loadConfig(env);
    const batch = await batchForConfig(config);
    const enabled = ruleCompilationMode(config) === "actions";
    const workflowReady = enabled && await env.SUBPILOT_CONFIG.get(actionsCompilerProtocolKey(config.settings.actionsCompilation!)) === ACTIONS_COMPILER_PROTOCOL;
    const attempt = await env.SUBPILOT_CONFIG.get<number>(`${DISPATCH_PREFIX}${batch.id}`, "json");
    const lastAttemptAt = typeof attempt === "number" && Number.isFinite(attempt) && attempt > 0 ? attempt : undefined;
    const result = await env.SUBPILOT_CONFIG.get<DispatchResult>(`${RESULT_PREFIX}${batch.id}`, "json");
    const current = result?.attemptedAt === lastAttemptAt ? result : null;
    const outputs = await Promise.all(batch.jobs.map(async (job) => {
      const manifest = await publishedManifest(env, job);
      const state = manifest && (!lastAttemptAt || manifest.publication!.confirmedAt >= lastAttemptAt) && (!manifest.asnExpiresAt || manifest.asnExpiresAt > Date.now()) ? "complete" : !workflowReady ? "workflow_update_required" : current ? current.accepted ? "accepted" : "dispatch_failed"
        : !lastAttemptAt ? "pending" : Date.now() - lastAttemptAt >= RETRY_MS ? "retrying" : "awaiting";
      const fallbackConfig = workerFallbackConfig(renderConfig(configDocument(config), job.target));
      const fallback = state !== "complete" ? await readCompiledRuleSetManifest(workerFallbackEnv(ruleSetEnv(env, job.target), job.target), job.output.name, { allowLegacy: false }).catch(() => null) : null;
      const workerFallbackReady = Boolean(fallback && fallback.outputFingerprint === await ruleSetOutputFingerprint(fallbackConfig, job.output));
      return { name: job.output.name, target: job.target, state,
        workerFallbackReady,
        hasPublishedVersion: Boolean(manifest), ...(manifest ? { publishedAt: manifest.updatedAt } : {}),
        ...(lastAttemptAt ? { lastAttemptAt } : {}), ...(current?.httpStatus ? { httpStatus: current.httpStatus } : {}) };
    }));
    return jsonResponse({ enabled, workflowReady, total: outputs.length, completed: outputs.filter((output) => output.state === "complete").length, outputs }, { headers: NO_STORE });
  } catch { return jsonResponse({ error: "暂时无法读取 Actions 编译状态，请稍后重试。 / Actions compilation status is unavailable; retry shortly." }, { status: 503, headers: NO_STORE }); }
}
export async function handleActionsCompilationRetry(request: Request, env: Env): Promise<Response> {
  if (request.headers.has("origin") && request.headers.get("origin") !== new URL(request.url).origin) return jsonResponse({ error: "Invalid origin" }, { status: 403, headers: NO_STORE });
  try {
    const body = await readRequestJsonWithLimit<{ name?: unknown; target?: unknown }>(request, 4096);
    if (!body || typeof body.name !== "string" || !OUTPUT_TARGETS.includes(body.target as Target)) return jsonResponse({ error: "Invalid rule-set identity" }, { status: 400 });
    const config = await loadConfig(env);
    const batch = await batchForConfig(config);
    if (!batch.jobs.some((job) => job.target === body.target && job.output.name === body.name)) return jsonResponse({ error: "请先启用 Actions 编译并保存规则配置。 / Enable Actions compilation and save the rule plan first." }, { status: 409 });
    await ensureActionsCompilation(env, config, { force: true, deadline: Date.now() + 25_000 });
    return jsonResponse({ ok: true }, { headers: NO_STORE });
  } catch { return jsonResponse({ error: "重试未成功，请刷新编译进度查看请求结果。 / Retry failed; refresh compilation progress for details." }, { status: 502, headers: NO_STORE }); }
}
async function currentJobConfig(env: Env, job: CompilationJob): Promise<RenderConfig | null> {
  const config = renderConfig(configDocument(await loadConfig(env)), job.target);
  if (!usesActionsCompilation(config) || await integrationFingerprint(config) !== job.integration) return null;
  const output = effectiveRuleSetOutputs(config.ruleSets).find((item) => item.name === job.output.name);
  return output && output.enabled && ruleSetOutputNeedsCompilation(config.ruleSets, output, job.target)
    && await ruleSetOutputFingerprint(config, output) === job.fingerprint ? config : null;
}
function preparingResponse(code: string): Response {
  return jsonResponse({ error: "Actions 产物尚未确认，请稍后重试。 / Actions publication is not confirmed; retry shortly.", code }, { status: 503, headers: { ...NO_STORE, "retry-after": "30" } });
}

export async function handleActionsCompilationJobApi(request: Request, env: Env): Promise<Response> {
  const bearer = request.headers.get("authorization") ?? "";
  if (!/^Bearer [\x21-\x7e]{32,256}$/.test(bearer)) return unauthorized();
  const { sharedSecret } = await readActionsCredentials(env);
  if (!sharedSecret || !await timingSafeEqualString(bearer, `Bearer ${sharedSecret}`)) return unauthorized();
  const url = new URL(request.url), key = requireSecret(env, "CONFIG_ENCRYPTION_KEY");
  if (url.pathname === "/api/internal/actions-compiler/kernel" && request.method === "GET") {
    const checksum = kernelChecksum.trim().split(/\s+/, 1)[0] ?? "";
    if (!/^[a-f0-9]{64}$/.test(checksum)) return preparingResponse("kernel_unavailable");
    const asset = await env.ASSETS.fetch(new Request(new URL("/vendor/rule-kernel.wasm", url.origin)));
    if (!asset.ok || !["application/wasm", "application/octet-stream"].includes((asset.headers.get("content-type") ?? "").split(";", 1)[0]!)) {
      await asset.body?.cancel();
      return preparingResponse("kernel_unavailable");
    }
    const headers = new Headers(asset.headers);
    headers.set("content-type", "application/wasm");
    headers.set("cache-control", "no-store, private");
    headers.set("x-subpilot-kernel-sha256", checksum);
    return new Response(asset.body, { headers });
  }
  if (url.pathname === "/api/internal/actions-compiler/batch" && request.method === "GET") {
    const id = url.searchParams.get("batch") ?? "";
    if (!/^[a-f0-9]{64}$/.test(id)) return notFound();
    const stored = await env.SUBPILOT_CONFIG.get(`${BATCH_PREFIX}${id}`);
    if (!stored) return notFound();
    const batch = await decryptJson<{ integration: string; jobs: { jobId: string; target: Target; outputKey: string }[] }>(key, stored);
    const config = await loadConfig(env);
    if (ruleCompilationMode(config) !== "actions" || await integrationFingerprint(config) !== batch.integration) return jsonResponse({ error: "Batch configuration changed" }, { status: 409, headers: NO_STORE });
    const offset = Number(url.searchParams.get("offset") || 0);
    if (!Number.isSafeInteger(offset) || offset < 0) return jsonResponse({ error: "Invalid offset" }, { status: 400 });
    return jsonResponse({ jobs: batch.jobs.slice(offset, offset + 5), nextOffset: offset + 5 < batch.jobs.length ? offset + 5 : null }, { headers: NO_STORE });
  }
  const match = url.pathname.match(/^\/api\/internal\/actions-compiler\/jobs\/([a-f0-9]{64})(?:\/(complete|current))?$/);
  if (!match) return notFound();
  const stored = await env.SUBPILOT_CONFIG.get(`${JOB_PREFIX}${match[1]}`);
  if (!stored) return notFound();
  const job = await decryptJson<CompilationJob>(key, stored);
  const config = await currentJobConfig(env, job);
  if (!config) return Date.now() - job.createdAt < 5 * 60_000 ? preparingResponse("job_not_visible") : jsonResponse({ error: "Compilation job is obsolete" }, { status: 409, headers: NO_STORE });
  if (match[2] === "current" && request.method === "GET") return jsonResponse({ ok: true }, { headers: NO_STORE });
  if (!match[2] && request.method === "GET") return jsonResponse({ protocol: ACTIONS_COMPILER_PROTOCOL, jobId: job.id, target: job.target, outputName: job.output.name,
    output: job.output, config: job.config, fingerprint: job.fingerprint,
    repository: config.settings.actionsCompilation!.repository, directory: actionsArtifactDirectory(job.target, job.output.name),
    manifestPath: actionsArtifactPath(job.target, job.output.name, "manifest") }, { headers: NO_STORE });
  if (match[2] !== "complete" || request.method !== "POST") return notFound();
  let body: { commit?: unknown };
  try { body = await readRequestJsonWithLimit(request, 1024); }
  catch { return jsonResponse({ error: "Invalid publication receipt" }, { status: 400 }); }
  if (!body || typeof body.commit !== "string" || !/^[a-f0-9]{40}$/.test(body.commit)) return jsonResponse({ error: "Invalid commit" }, { status: 400 });
  let receiptText: string | undefined;
  const repository = config.settings.actionsCompilation!.repository.split("/").map(encodeURIComponent).join("/");
  const path = actionsArtifactPath(job.target, job.output.name, "manifest").split("/").map(encodeURIComponent).join("/");
  for (const address of [githubActionsManifestUrl(config, job.output.name, body.commit), `https://api.github.com/repos/${repository}/contents/${path}?ref=${body.commit}`]) {
    try {
      const response = await fetch(address, { redirect: "manual", signal: AbortSignal.timeout(8_000), headers: { accept: "application/vnd.github.raw+json", "user-agent": "SubPilot-Actions" } });
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); continue; }
      receiptText = await readResponseTextWithLimit(response, 256 * 1024, "Publication receipt"); break;
    } catch { /* Public immutable receipt may not have propagated yet. */ }
  }
  if (!receiptText) return preparingResponse("receipt_unavailable");
  let manifest: CompiledRuleSetManifest;
  try {
    const receipt = JSON.parse(receiptText);
    manifest = validateReceipt(receipt, job);
  } catch { return preparingResponse("receipt_invalid"); }
  if (!await currentJobConfig(env, job)) return preparingResponse("job_changed");
  manifest.publication = { confirmedAt: Date.now(), commit: body.commit, jobId: job.id, integration: job.integration, target: job.target };
  await env.SUBPILOT_CONFIG.put(`${COMPLETE_PREFIX}${job.id}`, JSON.stringify(manifest), { expirationTtl: 30 * SNAPSHOT_TTL });
  return jsonResponse({ ok: true }, { headers: NO_STORE });
}
function receiptObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid receipt object");
  return value as Record<string, unknown>;
}
function validateReceipt(input: unknown, job: CompilationJob): CompiledRuleSetManifest {
  const receipt = receiptObject(input), value = receiptObject(receipt.manifest);
  const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= 10_000_000;
  if (receipt.protocol !== ACTIONS_COMPILER_PROTOCOL || receipt.jobId !== job.id || receipt.target !== job.target || receipt.outputName !== job.output.name
    || value.outputFingerprint !== job.fingerprint || !count(value.ruleCount) || !count(value.duplicateCount) || !count(value.warningCount)
    || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))
    || !Array.isArray(value.buckets) || value.buckets.length > 3
    || (value.dnsRuleCount !== undefined && (!count(value.dnsRuleCount) || value.dnsRuleCount > value.ruleCount || job.target !== "sing-box" || !job.output.dnsServer))
    || (value.asnExpiresAt !== undefined && (typeof value.asnExpiresAt !== "number" || !Number.isFinite(value.asnExpiresAt) || value.asnExpiresAt < Date.now() || value.asnExpiresAt > Date.now() + 2 * SNAPSHOT_TTL * 1000))) throw new Error("Invalid receipt metadata");
  const manifestBuckets: CompiledRuleSetManifest["buckets"] = value.buckets.map((input: unknown) => {
    const bucket = receiptObject(input);
    if ((bucket.bucket !== "domain" && bucket.bucket !== "ipcidr" && bucket.bucket !== "classical") || !count(bucket.count)
      || !Array.isArray(bucket.targets) || bucket.targets.length !== 1 || bucket.targets[0] !== job.target
      || receiptObject(bucket.targetCounts)[job.target] !== bucket.count) throw new Error("Invalid receipt bucket");
    return { bucket: bucket.bucket, count: bucket.count, targets: [job.target], targetCounts: { [job.target]: bucket.count } };
  });
  if (new Set(manifestBuckets.map(({ bucket }) => bucket)).size !== manifestBuckets.length
    || manifestBuckets.reduce((sum, bucket) => sum + bucket.count, 0) !== value.ruleCount) throw new Error("Invalid receipt counts");
  const manifest: CompiledRuleSetManifest = { outputName: job.output.name, outputFingerprint: job.fingerprint, policy: job.output.policy, sourceIds: [],
    updatedAt: value.updatedAt, ruleCount: value.ruleCount, duplicateCount: value.duplicateCount, buckets: manifestBuckets,
    warnings: value.warningCount ? ["部分规则产生兼容性提示，请检查规则来源与当前客户端支持的格式。"] : [],
    ...(job.target === "surge" && job.output.surgeType ? { surgeType: job.output.surgeType } : {}),
    ...(job.target === "clash" && job.output.provider ? { provider: job.output.provider } : {}),
    ...(typeof value.dnsRuleCount === "number" ? { dnsRuleCount: value.dnsRuleCount } : {}),
    ...(typeof value.asnExpiresAt === "number" ? { asnExpiresAt: value.asnExpiresAt } : {}) };
  const buckets: ActionsBucket[] = planRuleSetArtifacts(manifest.buckets, job.target, manifest.provider?.behavior, manifest.surgeType).map(({ bucket }) => bucket);
  if (manifest.dnsRuleCount) buckets.push("dns");
  const artifacts = Array.isArray(receipt.artifacts) ? receipt.artifacts.map(receiptObject) : [];
  if (!Array.isArray(receipt.artifacts) || artifacts.length !== buckets.length || !buckets.every((bucket) => artifacts.some((artifact) => artifact.bucket === bucket
    && artifact.path === actionsArtifactPath(job.target, job.output.name, bucket) && typeof artifact.sha256 === "string" && /^[a-f0-9]{64}$/.test(artifact.sha256)))) throw new Error("Invalid receipt artifacts");
  return manifest;
}
