import { createHash } from "node:crypto";
import workflow from "../.github/workflows/singbox-srs.yml" with { type: "text" };
import script from "../scripts/compile-singbox-srs.mjs" with { type: "text" };
import { validateSingboxSrsSettings } from "./config-validation";
import { sealGitHubSecret } from "./github-secret-seal";
import { readSrsCredentials, srsCredentialStatus } from "./singbox-srs-credentials";
import type { SingboxSrsSettings } from "./types";
import { jsonResponse, readRequestJsonWithLimit, readResponseTextWithLimit } from "./util";

class InstallError extends Error {}
const headers = { "cache-control": "no-store, private" };
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);

/** Admin-only installer. The installation token is used only for this request. */
export async function handleSingboxSrsInstall(request: Request, env: Env): Promise<Response> {
  const completed: string[] = [];
  const url = new URL(request.url);
  let token = "";
  let stage = "检查安装配置 / Checking installation settings";
  try {
    const credentials = await readSrsCredentials(env);
    const { sharedSecret } = credentials;
    const status = srsCredentialStatus(credentials);
    if (url.pathname.endsWith("/status") && request.method === "GET") return jsonResponse(status, { headers });
    if (!url.pathname.endsWith("/install") || request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, { status: 405, headers });
    if (url.protocol !== "https:" || (request.headers.has("origin") && request.headers.get("origin") !== url.origin)) {
      throw new InstallError("请从当前 Worker 的 HTTPS 管理页面安装。 / Use this Worker's HTTPS admin page.");
    }
    if (!status.sharedSecretConfigured) throw new InstallError("请先在系统设置的“配置编译凭据”中保存 GitHub Token。 / Save a GitHub token in Configure compilation credentials first.");
    const body = await readRequestJsonWithLimit<{ settings?: SingboxSrsSettings; token?: unknown; replaceExisting?: unknown }>(request, 16 * 1024);
    const settings = { ...body?.settings, enabled: true } as SingboxSrsSettings;
    const invalid = validateSingboxSrsSettings(settings);
    if (invalid) throw new InstallError(invalid);
    if (typeof body.token !== "string" || !/^[A-Za-z0-9_]{20,255}$/.test(body.token)) throw new InstallError("请输入有效的安装 Token。 / Enter a valid installation token.");
    token = body.token;
    delete body.token;
    const base = `https://api.github.com/repos/${settings.repository}`;
    const deadline = Date.now() + 90_000;
    async function api(path: string, method = "GET", payload?: unknown, missing = false): Promise<any> {
      if (Date.now() >= deadline) throw new InstallError("安装超时；请重新安装以继续。 / Installation timed out; retry to continue.");
      const response = await fetch(`${base}${path}`, {
        method, redirect: "error", signal: AbortSignal.timeout(Math.min(15_000, deadline - Date.now())),
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "SubPilot-SRS-installer", "X-GitHub-Api-Version": "2022-11-28", ...(payload ? { "content-type": "application/json" } : {}) },
        ...(payload ? { body: JSON.stringify(payload) } : {})
      });
      if (missing && response.status === 404) { await response.body?.cancel(); return null; }
      if (!response.ok) {
        await response.body?.cancel();
        throw new InstallError(`GitHub HTTP ${response.status}。请检查仓库、Token 权限、Actions 设置和分支保护后重试。 / Check repository access, token permissions, Actions settings and branch protection, then retry.`);
      }
      const text = await readResponseTextWithLimit(response, 1024 * 1024, "GitHub response");
      return text ? JSON.parse(text) : null;
    }
    stage = "检查仓库和文件 / Checking repository and files";
    const repo = await api("");
    if (repo.private !== false || repo.archived || repo.disabled || typeof repo.default_branch !== "string") throw new InstallError("请选择可写的公开仓库。 / Select a writable public repository.");
    const branch = repo.default_branch as string;
    if (![branch, `refs/heads/${branch}`].includes(settings.ref) || settings.outputBranch === branch) throw new InstallError("一键安装要求工作流分支为仓库默认分支，产物使用其他分支。 / Use the repository default branch for the workflow and a different output branch.");
    const key = await api("/actions/secrets/public-key");
    if (typeof key.key !== "string" || typeof key.key_id !== "string") throw new InstallError("无法读取仓库公钥。 / Repository public key unavailable.");
    const ref = await api(`/git/ref/heads/${encodeURIComponent(branch)}`);
    if (!sha(ref.object?.sha)) throw new InstallError("仓库需要已有的默认分支；请先初始化仓库。 / Initialize the repository default branch first.");
    const head = ref.object.sha as string;
    const commit = await api(`/git/commits/${head}`);
    if (!sha(commit.tree?.sha)) throw new InstallError("无法读取默认分支。 / Cannot read the default branch.");
    const files = [{ path: `.github/workflows/${settings.workflow}`, content: workflow }, { path: "scripts/compile-singbox-srs.mjs", content: script }];
    const changed = [];
    for (const file of files) {
      const existing = await api(`/contents/${file.path}?ref=${head}`, "GET", undefined, true);
      const expected = createHash("sha1").update(`blob ${new TextEncoder().encode(file.content).length}\0`).update(file.content).digest("hex");
      if (existing?.type === "file" && !existing.target && !existing.submodule_git_url && existing.sha === expected) continue;
      if (existing && (existing.type !== "file" || existing.target || existing.submodule_git_url || body.replaceExisting !== true)) throw new InstallError("目标文件已存在且内容不同。请检查后勾选允许更新；目录或链接不能覆盖。 / Existing files differ; review and allow replacement. Directories and links cannot be replaced.");
      changed.push({ ...file, mode: "100644", type: "blob" });
    }
    // Encrypt before any mutation so invalid keys fail without a partial install.
    const secrets = [
      { name: "SUBPILOT_URL", encrypted_value: sealGitHubSecret(key.key, url.origin) },
      { name: "SUBPILOT_SRS_SECRET", encrypted_value: sealGitHubSecret(key.key, sharedSecret) }
    ];
    stage = "安装工作流和脚本 / Installing workflow and script";
    if (changed.length) {
      const tree = await api("/git/trees", "POST", { base_tree: commit.tree.sha, tree: changed });
      if (!sha(tree.sha)) throw new InstallError("GitHub 未返回有效文件树。 / Invalid GitHub tree response.");
      const created = await api("/git/commits", "POST", { message: "Install SubPilot sing-box SRS workflow", tree: tree.sha, parents: [head] });
      if (!sha(created.sha)) throw new InstallError("GitHub 未返回有效提交。 / Invalid GitHub commit response.");
      await api(`/git/refs/heads/${encodeURIComponent(branch)}`, "PATCH", { sha: created.sha, force: false });
    }
    completed.push("工作流和脚本已安装 / Workflow and script installed");
    for (const secret of secrets) {
      stage = `配置 ${secret.name} / Configuring ${secret.name}`;
      await api(`/actions/secrets/${secret.name}`, "PUT", { key_id: key.key_id, encrypted_value: secret.encrypted_value });
      completed.push(`${secret.name} 已配置 / configured`);
    }
    return jsonResponse({ ok: true, completed, ...status }, { headers });
  } catch (error) {
    // Never expose or log response bodies, request payloads, tokens or network URLs.
    const detail = error instanceof InstallError ? error.message : "请求无效或 GitHub 暂时不可用，请检查配置后重试。 / Invalid request or GitHub unavailable; check settings and retry.";
    return jsonResponse({ error: `${stage}: ${detail}${completed.length ? ` 已完成 / Completed: ${completed.join("; ")}` : ""} 后续可安全重试。 / You can retry to finish.`, completed }, { status: 400, headers });
  } finally { token = ""; }
}
