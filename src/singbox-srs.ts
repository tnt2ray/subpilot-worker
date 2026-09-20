import { configDocument, renderConfig } from "./config-document";
import { loadConfig } from "./config-store";
import { decryptJson, decryptText, encryptJson, encryptText } from "./crypto-store";
import { planRuleSetArtifacts } from "./rule-set-artifacts";
import { compiledRuleSetContentKey, readCompiledRuleSetBucket, readCompiledRuleSetManifest, type CompiledRuleSetManifest } from "./rule-set-cache";
import { ruleSetOutputFingerprint } from "./rule-set-compiler";
import { effectiveRuleSetOutputs, ruleSetOutputNeedsCompilation } from "./rule-set-outputs";
import { ruleSetEnv } from "./rule-set-scope";
import { requireSecret } from "./secrets";
import { readSrsCredentials } from "./singbox-srs-credentials";
import { githubSrsUrl, srsArtifactPath, srsOutputKey, type SrsBucket } from "./singbox-srs-artifacts";
import type { RenderConfig } from "./types";
import { jsonResponse, notFound, readRequestJsonWithLimit, readResponseTextWithLimit, RequestBodyTooLargeError, sha256Hex, timingSafeEqualString, unauthorized } from "./util";

interface SrsJob {
  id: string;
  createdAt: number;
  integration: string;
  manifest: CompiledRuleSetManifest;
  artifacts: { bucket: SrsBucket; path: string }[];
}

const JOB_PREFIX = "cache:singboxSrs:job:";
const DISPATCH_PREFIX = "cache:singboxSrs:dispatch:";
const SNAPSHOT_TTL = 24 * 60 * 60;
const RETRY_MS = 15 * 60_000;
const NO_STORE = { "cache-control": "no-store, private" };

export async function validateSingboxSrsCredentials(env: Env, config: { settings: Pick<RenderConfig["settings"], "singboxSrs"> }): Promise<string | null> {
  if (!config.settings.singboxSrs?.enabled) return null;
  const credentials = await readSrsCredentials(env);
  if (!credentials.token || !credentials.sharedSecret) return "启用 SRS 前请在系统设置的“配置编译凭据”中保存 GitHub Token，再安装工作流。 / Save a GitHub token in Configure compilation credentials, then install the workflow.";
  return null;
}

export function usesSingboxSrs(config: RenderConfig): boolean {
  return config.renderTarget === "sing-box" && config.ruleSets.mode === "compiled" && config.settings.singboxSrs?.enabled === true;
}

async function integrationFingerprint(config: RenderConfig): Promise<string> {
  // Keep the binary toolchain and workflow configuration in the artifact identity.
  return sha256Hex(JSON.stringify({ revision: 2, compiler: "1.15.0-alpha.6", ...config.settings.singboxSrs }));
}

async function jobForManifest(config: RenderConfig, manifest: CompiledRuleSetManifest): Promise<SrsJob> {
  const integration = await integrationFingerprint(config);
  const id = await sha256Hex(JSON.stringify([integration, manifest.outputName, manifest.outputFingerprint, manifest.storageId]));
  const artifacts: SrsJob["artifacts"] = planRuleSetArtifacts(manifest.buckets, "sing-box").map(({ bucket }) => ({ bucket, path: srsArtifactPath(manifest.outputName, bucket) }));
  if (manifest.dnsRuleCount) artifacts.push({ bucket: "dns", path: srsArtifactPath(manifest.outputName, "dns") });
  return { id, createdAt: Date.now(), integration, manifest, artifacts };
}

function completeKey(job: SrsJob): string {
  // Existing version garbage collection also removes the publication receipt.
  return `${compiledRuleSetContentKey(job.manifest.outputName, "combined", "sing-box", job.manifest.storageId)}:srs:${job.integration}:complete`;
}

export async function singboxSrsReady(env: Env, config: RenderConfig, manifest: CompiledRuleSetManifest): Promise<boolean> {
  if (!usesSingboxSrs(config)) return true;
  const job = await jobForManifest(config, manifest);
  return !job.artifacts.length || Boolean(await env.SUBPILOT_CONFIG.get(completeKey(job)));
}

/** Called by the existing compiler, including its unchanged-source fast path. */
export async function ensureSingboxSrsJob(env: Env, config: RenderConfig, manifest: CompiledRuleSetManifest, deadline?: number): Promise<void> {
  if (!usesSingboxSrs(config) || await singboxSrsReady(env, config, manifest)) return;
  const credentials = await readSrsCredentials(env);
  if (!credentials.token || !credentials.sharedSecret) throw new Error("请在系统设置中配置 SRS 编译凭据。 / Configure SRS compilation credentials in system settings.");
  if (!manifest.storageId) throw new Error("SRS 需要完整的规则集缓存，请刷新后重试。");
  if (deadline && deadline - Date.now() < 2_000) return;
  const job = await jobForManifest(config, manifest);
  const lastDispatch = await env.SUBPILOT_CONFIG.get<number>(`${DISPATCH_PREFIX}${job.id}`, "json");
  if (lastDispatch && Date.now() - lastDispatch < RETRY_MS) return;
  const secret = requireSecret(env, "CONFIG_ENCRYPTION_KEY");
  // Immutable snapshots let an Action finish even if source caches are pruned.
  if (!await env.SUBPILOT_CONFIG.get(`${JOB_PREFIX}${job.id}`)) {
    for (const { bucket } of job.artifacts) {
      const content = await readCompiledRuleSetBucket(env, manifest.outputName, bucket, "sing-box", manifest);
      if (content === null) throw new Error("SRS 编译源缓存不可用，请刷新规则集。");
      await env.SUBPILOT_CONFIG.put(`${JOB_PREFIX}${job.id}:${bucket}`, await encryptText(secret, content), { expirationTtl: SNAPSHOT_TTL });
    }
    await env.SUBPILOT_CONFIG.put(`${JOB_PREFIX}${job.id}`, await encryptJson(secret, job), { expirationTtl: SNAPSHOT_TTL });
  }
  // This marker also bounds retries after timeouts with an uncertain dispatch result.
  await env.SUBPILOT_CONFIG.put(`${DISPATCH_PREFIX}${job.id}`, JSON.stringify(Date.now()), { expirationTtl: SNAPSHOT_TTL });
  const settings = config.settings.singboxSrs!;
  const repository = settings.repository.split("/").map(encodeURIComponent).join("/");
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/${encodeURIComponent(settings.workflow)}/dispatches`, {
      method: "POST", redirect: "error",
      headers: {
        accept: "application/vnd.github+json", "content-type": "application/json",
        authorization: `Bearer ${credentials.token}`,
        "user-agent": "SubPilot-SRS", "x-github-api-version": "2022-11-28"
      },
      body: JSON.stringify({ ref: settings.ref, inputs: { job_id: job.id, output_key: srsOutputKey(manifest.outputName) } }),
      signal: AbortSignal.timeout(Math.max(1, Math.min(8_000, (deadline ?? Date.now() + 8_000) - Date.now())))
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error("dispatch");
  } catch {
    // Never expose GitHub response bodies, private repository names or tokens.
    throw new Error("GitHub Actions SRS 编译触发失败，请检查仓库、工作流及凭据；后台会自动重试。");
  }
}

/** Reuse the existing five-minute maintenance trigger for dispatch recovery. */
export async function retrySingboxSrsJobs(env: Env, config: RenderConfig, deadline: number): Promise<void> {
  const selected = renderConfig(configDocument(config), "sing-box");
  if (!usesSingboxSrs(selected)) return;
  const scoped = ruleSetEnv(env, "sing-box");
  for (const output of effectiveRuleSetOutputs(selected.ruleSets)) {
    if (Date.now() + 2_000 >= deadline) break;
    if (!ruleSetOutputNeedsCompilation(selected.ruleSets, output, "sing-box")) continue;
    try {
      const manifest = await readCompiledRuleSetManifest(scoped, output.name, { allowLegacy: false });
      if (manifest?.outputFingerprint === await ruleSetOutputFingerprint(selected, output)) await ensureSingboxSrsJob(scoped, selected, manifest, deadline);
    } catch { logSrsFailure(); }
  }
}

export async function handleSingboxSrsJobApi(request: Request, env: Env): Promise<Response> {
  const bearer = request.headers.get("authorization") ?? "";
  if (!/^Bearer [\x21-\x7e]{32,256}$/.test(bearer)) return unauthorized();
  const { sharedSecret: secret } = await readSrsCredentials(env);
  if (!secret || !/^[\x21-\x7e]{32,256}$/.test(secret) || !await timingSafeEqualString(bearer, `Bearer ${secret}`)) return unauthorized();
  const match = new URL(request.url).pathname.match(/^\/api\/internal\/singbox-srs\/jobs\/([a-f0-9]{64})(?:\/(complete|(?:combined|domain|ipcidr|dns)\.json))?$/);
  if (!match) return notFound();
  const stored = await env.SUBPILOT_CONFIG.get(`${JOB_PREFIX}${match[1]}`);
  if (!stored) return notFound();
  const encryptionKey = requireSecret(env, "CONFIG_ENCRYPTION_KEY");
  const job = await decryptJson<SrsJob>(encryptionKey, stored);
  const config = renderConfig(configDocument(await loadConfig(env)), "sing-box");
  const scoped = ruleSetEnv(env, "sing-box");
  if (!await jobIsCurrent(scoped, config, job)) {
    // KV can expose the immutable job before the saved config or source version.
    if (Date.now() - job.createdAt < 5 * 60_000) return preparingResponse();
    return jsonResponse({ error: "SRS job is obsolete" }, { status: 409 });
  }
  const artifact = match[2];
  if (!artifact && request.method === "GET") return jsonResponse({
    artifacts: job.artifacts, repository: config.settings.singboxSrs!.repository,
    outputBranch: config.settings.singboxSrs!.outputBranch,
    manifestPath: srsArtifactPath(job.manifest.outputName, "manifest")
  });
  if (artifact === "complete" && request.method === "POST") {
    let body: { commit?: unknown };
    try { body = await readRequestJsonWithLimit(request, 1024); }
    catch (error) { return jsonResponse({ error: "Invalid publication receipt" }, { status: error instanceof RequestBodyTooLargeError ? 413 : 400 }); }
    if (!body || typeof body.commit !== "string" || !/^[a-f0-9]{40}$/.test(body.commit)) return jsonResponse({ error: "Invalid commit" }, { status: 400 });
    // Verify the public receipt from the immutable commit. Every binary and the
    // receipt are published in one Git tree before the branch is advanced.
    try {
      const response = await fetch(githubSrsUrl(config, job.manifest.outputName, "manifest", body.commit), {
        redirect: "error", signal: AbortSignal.timeout(8_000)
      });
      if (!response.ok) { await response.body?.cancel(); return preparingResponse(); }
      const receipt: { jobId?: unknown; artifacts?: Array<{ bucket?: unknown; path?: unknown; sha256?: unknown }> } = JSON.parse(await readResponseTextWithLimit(response, 16 * 1024, "Publication receipt"));
      if (receipt.jobId !== job.id || !Array.isArray(receipt.artifacts) || receipt.artifacts.length !== job.artifacts.length
        || !job.artifacts.every(({ bucket, path }) => receipt.artifacts!.some((item) => item.bucket === bucket && item.path === path && typeof item.sha256 === "string" && /^[a-f0-9]{64}$/.test(item.sha256)))) return preparingResponse();
    } catch { return preparingResponse(); }
    if (!await jobIsCurrent(scoped, renderConfig(configDocument(await loadConfig(env)), "sing-box"), job)) return preparingResponse();
    if (!await scoped.SUBPILOT_CONFIG.get(completeKey(job))) await scoped.SUBPILOT_CONFIG.put(completeKey(job), body.commit);
    return jsonResponse({ ok: true });
  }
  const bucket = job.artifacts.find((entry) => artifact === `${entry.bucket}.json`)?.bucket;
  if (bucket && request.method === "GET") {
    const snapshot = await env.SUBPILOT_CONFIG.get(`${JOB_PREFIX}${job.id}:${bucket}`);
    if (!snapshot) return notFound();
    return new Response(await decryptText(encryptionKey, snapshot), { headers: { ...NO_STORE, "content-type": "application/json" } });
  }
  return notFound();
}

async function jobIsCurrent(env: Env, config: RenderConfig, job: SrsJob): Promise<boolean> {
  if (!usesSingboxSrs(config) || await integrationFingerprint(config) !== job.integration) return false;
  const output = effectiveRuleSetOutputs(config.ruleSets).find((entry) => entry.name === job.manifest.outputName);
  if (!output || !ruleSetOutputNeedsCompilation(config.ruleSets, output, "sing-box") || await ruleSetOutputFingerprint(config, output) !== job.manifest.outputFingerprint) return false;
  const current = await readCompiledRuleSetManifest(env, output.name, { allowLegacy: false });
  return current?.storageId === job.manifest.storageId;
}

function preparingResponse(): Response {
  return jsonResponse({ error: "SRS 规则集正在等待 GitHub Actions 编译，请稍后重试。" }, { status: 503, headers: { "retry-after": "30" } });
}

function logSrsFailure(): void {
  console.warn(JSON.stringify({ level: "warn", message: "SRS compilation is pending; check GitHub Actions configuration." }));
}
