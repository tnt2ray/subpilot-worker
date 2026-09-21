import { ACTIONS_OUTPUT_BRANCH, ACTIONS_COMPILER_PROTOCOL, actionsCompilerProtocolKey } from "./actions-compiler-artifacts";
import { createHash } from "node:crypto";
import workflow from "../scripts/compile-rule-sets.yml" with { type: "text" };
import compiler from "../dist/actions-compiler-runtime.mjs" with { type: "text" };
import script from "../scripts/compile-rule-sets.mjs" with { type: "text" };
import { validateActionsCompilationSettings } from "./config-validation";
import { normalizeActionsWorkflowFilename } from "./config-normalize";
import { decryptJson, encryptJson } from "./crypto-store";
import { sealGitHubSecret } from "./github-secret-seal";
import { requireSecret } from "./secrets";
import { readActionsCredentials, actionsCredentialStatus } from "./actions-compiler-credentials";
import { ACTIONS_CALLBACK_ORIGIN_KEY, expireSupersededActionsRecord, readActionsIntegrationRecord } from "./actions-compiler-migration";
import type { ActionsCompilationSettings } from "./types";
import { jsonResponse, readRequestJsonWithLimit, readResponseTextWithLimit } from "./util";

class InstallError extends Error {}
const headers = { "cache-control": "no-store, private" };
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);

async function readCallbackOrigin(env: Env): Promise<string | null> {
  const stored = await readActionsIntegrationRecord(env, "callbackOrigin");
  if (stored === null) return null;
  try {
    const value = await decryptJson<{ version?: unknown; origin?: unknown }>(requireSecret(env, "CONFIG_ENCRYPTION_KEY"), stored);
    if (value?.version !== 1 || typeof value.origin !== "string") throw new Error();
    const origin = new URL(value.origin);
    if (origin.protocol !== "https:" || origin.origin !== value.origin || origin.username || origin.password || origin.port) throw new Error();
    return value.origin;
  } catch {
    throw new InstallError("上次保存的工作流访问地址暂时无法读取，请检查加密密钥和存储后重试。 / The saved callback address is unavailable; check encryption and storage, then retry.");
  }
}

/** Admin-only installer. Reuses encrypted credentials when no replacement is supplied. */
export async function handleActionsCompilationInstall(request: Request, env: Env): Promise<Response> {
  const completed: string[] = [];
  const url = new URL(request.url);
  let token = "";
  let stage = "检查安装配置 / Checking installation settings";
  try {
    const credentials = await readActionsCredentials(env);
    const { sharedSecret } = credentials;
    const status = actionsCredentialStatus(credentials);
    if (url.pathname.endsWith("/status") && request.method === "GET") return jsonResponse({ ...status, callbackOrigin: await readCallbackOrigin(env) }, { headers });
    if (!url.pathname.endsWith("/install") || request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, { status: 405, headers });
    if (url.protocol !== "https:" || (request.headers.has("origin") && request.headers.get("origin") !== url.origin)) {
      throw new InstallError("请从当前 Worker 的 HTTPS 管理页面安装。 / Use this Worker's HTTPS admin page.");
    }
    if (!status.sharedSecretConfigured) throw new InstallError("请先在系统设置的“配置编译凭据”中保存 GitHub Token。 / Save a GitHub token in Configure compilation credentials first.");
    const body = await readRequestJsonWithLimit<{ settings?: ActionsCompilationSettings; token?: unknown; replaceExisting?: unknown; callbackOrigin?: unknown }>(request, 16 * 1024);
    const settings = { ...body?.settings, enabled: true } as ActionsCompilationSettings;
    const invalid = validateActionsCompilationSettings(settings);
    if (invalid) throw new InstallError(invalid);
    settings.workflow = normalizeActionsWorkflowFilename(settings.workflow);
    const suppliedToken = body.token === undefined || body.token === "" ? credentials.token : body.token;
    if (typeof suppliedToken !== "string" || !/^[A-Za-z0-9_]{20,255}$/.test(suppliedToken)) throw new InstallError("请输入有效的安装 Token。 / Enter a valid installation token.");
    token = suppliedToken;
    delete body.token;
    const base = `https://api.github.com/repos/${settings.repository}`;
    const deadline = Date.now() + 90_000;
    async function api(path: string, method = "GET", payload?: unknown, missing = false, authToken = token): Promise<any> {
      if (Date.now() >= deadline) throw new InstallError("安装超时；请重新安装以继续。 / Installation timed out; retry to continue.");
      let response: Response;
      try { response = await fetch(`${base}${path}`, {
        method, redirect: "manual", signal: AbortSignal.timeout(Math.min(15_000, deadline - Date.now())),
        headers: { authorization: `Bearer ${authToken}`, accept: "application/vnd.github+json", "user-agent": "SubPilot-Actions-installer", "X-GitHub-Api-Version": "2022-11-28", ...(payload ? { "content-type": "application/json" } : {}) },
        ...(payload ? { body: JSON.stringify(payload) } : {})
      }); } catch (error) {
        const timeout = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
        throw new InstallError(timeout
          ? "连接 GitHub 超时，请稍后重试。 / GitHub request timed out; retry shortly."
          : "无法连接 GitHub API，请稍后重试。 / Could not connect to GitHub API; retry shortly.");
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        throw new InstallError("仓库地址发生重定向，请填写仓库当前的 owner/repo。 / Repository moved; use its current owner/repo.");
      }
      if (missing && response.status === 404) { await response.body?.cancel().catch(() => undefined); return null; }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 409 && path.startsWith("/git/ref/")) throw new InstallError("仓库尚无首次提交，请在 GitHub 添加 README。 / Repository has no initial commit; add a README on GitHub.");
        throw new InstallError(`GitHub HTTP ${response.status}。请检查仓库、Token 权限、Actions 设置和分支保护后重试。 / Check repository access, token permissions, Actions settings and branch protection, then retry.`);
      }
      // Secret creation returns 201 without a result object; updates return 204.
      if (response.status === 204 || (response.status === 201 && method === "PUT" && path.startsWith("/actions/secrets/"))) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      let text: string;
      try { text = await readResponseTextWithLimit(response, 1024 * 1024, "GitHub response"); }
      catch { throw new InstallError("读取 GitHub 响应失败或响应超过大小限制，请重试。 / Could not read GitHub response or response exceeded the size limit; retry."); }
      try {
        const value = JSON.parse(text);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        return value;
      } catch { throw new InstallError("GitHub 返回了无效数据，请稍后重试。 / GitHub returned invalid response data; retry shortly."); }
    }
    stage = "检查工作流访问地址 / Checking callback address";
    let callbackOrigin: string;
    const savedCallbackOrigin = await readCallbackOrigin(env);
    try {
      const candidate = new URL(typeof body.callbackOrigin === "string" && body.callbackOrigin ? body.callbackOrigin : savedCallbackOrigin || "");
      if (candidate.protocol !== "https:" || candidate.username || candidate.password || candidate.search || candidate.hash || candidate.pathname !== "/" || candidate.port
        || (candidate.origin !== url.origin && !/^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(candidate.hostname))) throw new Error();
      callbackOrigin = candidate.origin;
    } catch { throw new InstallError("请填写当前管理地址或本部署的 workers.dev HTTPS 地址，不含路径或参数。 / Enter the current admin origin or your deployment's workers.dev HTTPS origin without paths or parameters."); }
    completed.push("访问地址格式正确（未检查连通性） / Callback format valid; connectivity not checked");
    stage = "读取仓库信息 / Reading repository information";
    const repo = await api("");
    if (repo.private !== false || repo.archived || repo.disabled || typeof repo.default_branch !== "string") throw new InstallError("请选择可写的公开仓库。 / Select a writable public repository.");
    const branch = repo.default_branch as string;
    completed.push("公开仓库可访问 / Public repository accessible");
    if (![branch, `refs/heads/${branch}`].includes(settings.ref) || ACTIONS_OUTPUT_BRANCH === branch) throw new InstallError("一键安装要求工作流分支为仓库默认分支，产物使用其他分支。 / Use the repository default branch for the workflow and a different output branch.");
    stage = "检查编译 Token 的仓库访问 / Checking compilation token access";
    if (!credentials.token) throw new InstallError("尚未配置长期编译 Token，请先保存凭据。 / Configure the persistent compilation token first.");
    await api("/actions/workflows?per_page=1", "GET", undefined, false, credentials.token);
    completed.push("编译 Token 可读取 Actions（写入权限由首次触发验证） / Actions readable; first dispatch verifies write permission");
    stage = "读取仓库 Secrets 公钥 / Reading repository Secrets public key";
    const key = await api("/actions/secrets/public-key");
    if (typeof key.key !== "string" || typeof key.key_id !== "string") throw new InstallError("无法读取仓库公钥。 / Repository public key unavailable.");
    stage = "读取默认分支 / Reading default branch";
    const ref = await api(`/git/ref/heads/${encodeURIComponent(branch)}`);
    if (!sha(ref.object?.sha)) throw new InstallError("仓库需要已有的默认分支；请先初始化仓库。 / Initialize the repository default branch first.");
    const head = ref.object.sha as string;
    stage = "读取默认分支提交 / Reading default branch commit";
    const commit = await api(`/git/commits/${head}`);
    if (!sha(commit.tree?.sha)) throw new InstallError("无法读取默认分支。 / Cannot read the default branch.");
    const files = [{ path: `.github/workflows/${settings.workflow}`, content: workflow }, { path: "scripts/compile-rule-sets.mjs", content: script }, { path: "scripts/actions-compiler-runtime.mjs", content: compiler }];
    const changed = [];
    for (const file of files) {
      stage = `检查文件 ${file.path} / Checking file ${file.path}`;
      const existing = await api(`/contents/${file.path}?ref=${head}`, "GET", undefined, true);
      const expected = createHash("sha1").update(`blob ${new TextEncoder().encode(file.content).length}\0`).update(file.content).digest("hex");
      if (existing?.type === "file" && !existing.target && !existing.submodule_git_url && existing.sha === expected) continue;
      if (existing && (existing.type !== "file" || existing.target || existing.submodule_git_url || body.replaceExisting !== true)) throw new InstallError("目标文件已存在且内容不同。请检查后勾选允许更新；目录或链接不能覆盖。 / Existing files differ; review and allow replacement. Directories and links cannot be replaced.");
      changed.push({ ...file, mode: "100644", type: "blob" });
    }
    // Encrypt before any mutation so invalid keys fail without a partial install.
    stage = "加密工作流凭据 / Encrypting workflow credentials";
    const secrets = [
      { name: "SUBPILOT_URL", encrypted_value: sealGitHubSecret(key.key, callbackOrigin) },
      { name: "SUBPILOT_ACTIONS_SECRET", encrypted_value: sealGitHubSecret(key.key, sharedSecret) }
    ];
    stage = "安装工作流和脚本 / Installing workflow and script";
    if (changed.length) {
      const tree = await api("/git/trees", "POST", { base_tree: commit.tree.sha, tree: changed });
      if (!sha(tree.sha)) throw new InstallError("GitHub 未返回有效文件树。 / Invalid GitHub tree response.");
      const created = await api("/git/commits", "POST", { message: "Install SubPilot rule compilation workflow", tree: tree.sha, parents: [head] });
      if (!sha(created.sha)) throw new InstallError("GitHub 未返回有效提交。 / Invalid GitHub commit response.");
      await api(`/git/refs/heads/${encodeURIComponent(branch)}`, "PATCH", { sha: created.sha, force: false });
    }
    completed.push("工作流和脚本已安装 / Workflow and script installed");
    for (const secret of secrets) {
      stage = `配置 ${secret.name} / Configuring ${secret.name}`;
      await api(`/actions/secrets/${secret.name}`, "PUT", { key_id: key.key_id, encrypted_value: secret.encrypted_value });
      completed.push(`${secret.name} 已配置 / configured`);
    }
    stage = "保存工作流访问地址 / Saving callback address";
    const encryptedCallbackOrigin = await encryptJson(requireSecret(env, "CONFIG_ENCRYPTION_KEY"), { version: 1, origin: callbackOrigin });
    await env.SUBPILOT_CONFIG.put(ACTIONS_CALLBACK_ORIGIN_KEY, encryptedCallbackOrigin);
    await expireSupersededActionsRecord(env, "callbackOrigin", encryptedCallbackOrigin);
    await env.SUBPILOT_CONFIG.put(actionsCompilerProtocolKey(settings), ACTIONS_COMPILER_PROTOCOL);
    return jsonResponse({ ok: true, completed, ...status, callbackOrigin }, { headers });
  } catch (error) {
    // Never expose or log response bodies, request payloads, tokens or network URLs.
    const detail = error instanceof InstallError ? error.message : "安装器处理失败，请报告当前步骤以便排查。 / Installer processing failed; report the current step for diagnosis.";
    return jsonResponse({ error: `${stage}: ${detail}${completed.length ? ` 已完成 / Completed: ${completed.join("; ")}` : ""} 后续可安全重试。 / You can retry to finish.`, completed }, { status: 400, headers });
  } finally { token = ""; }
}
