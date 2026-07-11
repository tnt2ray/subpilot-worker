import { clearSessionCookie, createSession, getOrCreateReadToken, isAdminRequest, rotateReadToken, sessionCookie, validateAdminToken, validateReadToken } from "./auth";
import { mergeConfigPatch, sanitizeConfigAfterPatch, validateConfigForSave } from "./config-api";
import { runKvMigrations } from "./config-schema";
import { loadConfig, normalizeTarget, readStoredReadToken, saveConfig, withInferredManagedBaseUrl } from "./config-store";
import { readConfigFetchStats, recordConfigFetch } from "./fetch-stats";
import { generateConfig, generateForRequest, generateSurgeValidationConfig, inferTarget } from "./generator";
import { handleGeoIpMmdbUpload, readGeoIpMmdbStatus } from "./geoip-admin";
import { LOGIN_PAGE_HTML } from "./login-page";
import { extractSubscriptionToken, isUnderManagedBasePath, managedBasePathFromConfig, managedSubscriptionUrl, parseSyncPath } from "./managed-url";
import { notifyRuleSetRefreshFailures, notifySourceRefreshFailures, notifyVersionUpdateAvailable } from "./notifications";
import { refreshChangedRuleSetCaches, refreshRuleSetCaches } from "./rule-set-compiler";
import { handleRuleSetApi, handleRuleSetDownload } from "./rule-set-endpoints";
import { warmCompiledRuleSetWorkerCache } from "./rule-set-worker-cache";
import { refreshChangedSourceCache, refreshSourceCache } from "./source-cache";
import { sanitizeSurgeValidationContent } from "./surge-validation-sanitize";
import { configFileNameForTarget } from "./target-files";
import { handleTelegramBindCode, handleTelegramUnbind, handleTelegramWebhook, reconcileTelegramWebhook } from "./telegram";
import { readCachedUpdateStatus, getUpdateStatus } from "./update-check";
import { APP_VERSION, RELEASE_REPOSITORY } from "./version";
import { badRequest, forbidden, jsonResponse, notFound, sha256Hex, textResponse, unauthorized } from "./util";

const SOURCE_REFRESH_CRON = "0 */12 * * *";
const RULE_SET_REFRESH_CRON = "0 16 * * *";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      console.error(JSON.stringify({ level: "error", message: error instanceof Error ? error.message : String(error) }));
      return jsonResponse({ error: "Internal server error" }, { status: 500 });
    }
  },
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const config = await loadConfig(env);
    if (controller.cron === RULE_SET_REFRESH_CRON) {
      if (config.ruleSets.mode !== "compiled") return;
      const ruleSetResult = await refreshRuleSetCaches(env, config);
      await notifyRuleSetRefreshFailures(env, config, ruleSetResult, "scheduled");
      await warmScheduledRuleSetWorkerCache(env, config);
      return;
    }
    if (controller.cron !== SOURCE_REFRESH_CRON) return;
    const result = await refreshSourceCache(env, config);
    await notifySourceRefreshFailures(env, config, result, "scheduled");
    await notifyVersionUpdateAvailable(env, config);
  }
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });

  if (url.pathname === "/api/login" && request.method === "POST") return handleLogin(request, env);
  if (url.pathname === "/api/logout" && request.method === "POST") return handleLogout();
  if (url.pathname === "/api/session" && request.method === "GET") {
    return jsonResponse({ ok: await isAdminRequest(env, request) });
  }
  if (url.pathname === "/api/telegram/webhook" && request.method === "POST") {
    return handleTelegramWebhook(request, env, ctx);
  }
  if (url.pathname.startsWith("/api/")) return handleApi(request, env, ctx);

  const managedBasePath = await currentManagedBasePath(env, request.url);
  if (isUnderManagedBasePath(url.pathname, managedBasePath)) {
    return handleSync(request, env, ctx, managedBasePath);
  }
  if (managedBasePath !== "/sync" && url.pathname.startsWith("/sync/")) {
    const token = extractSubscriptionToken(url.pathname, "/sync");
    if (!token || !(await validateReadToken(env, token))) return badRequest("Invalid subscription token");
    return forbidden("Invalid subscription path");
  }

  if (!await isAdminRequest(env, request)) {
    return wantsHtml(request, url) ? textResponse(LOGIN_PAGE_HTML, "text/html; charset=utf-8") : unauthorized();
  }
  return env.ASSETS.fetch(request);
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ token?: string }>().catch((): { token?: string } => ({}));
  if (!await validateAdminToken(env, body.token ?? "")) return unauthorized();
  const session = await createSession(env);
  return jsonResponse({ ok: true }, { headers: { "set-cookie": sessionCookie(session, new URL(request.url).protocol === "https:") } });
}

function handleLogout(): Response {
  return jsonResponse({ ok: true }, { headers: { "set-cookie": clearSessionCookie() } });
}

async function handleApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!await isAdminRequest(env, request)) return unauthorized();
  const url = new URL(request.url);

  if (url.pathname === "/api/config" && request.method === "GET") {
    return jsonResponse(withInferredManagedBaseUrl(await loadConfig(env), request.url));
  }
  if (url.pathname === "/api/stats" && request.method === "GET") {
    const config = await loadConfig(env);
    return jsonResponse(await readConfigFetchStats(env, config));
  }
  if (url.pathname === "/api/system/status" && request.method === "GET") {
    await runKvMigrations(env);
    return jsonResponse({
      app: {
        version: APP_VERSION,
        releaseRepository: RELEASE_REPOSITORY
      },
      update: await readCachedUpdateStatus(env)
    });
  }
  if (url.pathname === "/api/system/migrate" && request.method === "POST") {
    return jsonResponse({ schema: await runKvMigrations(env) });
  }
  if (url.pathname === "/api/update-check" && request.method === "POST") {
    return jsonResponse({ update: await getUpdateStatus(env, { force: true }) });
  }
  {
    const config = await loadConfig(env);
    const response = await handleRuleSetApi(request, env, ctx, config);
    if (response) return response;
  }
  if (url.pathname === "/api/cache/source/refresh" && request.method === "POST") {
    const config = await loadConfig(env);
    const result = await refreshSourceCache(env, config);
    return jsonResponse({
      ...result,
      notification: await notifySourceRefreshFailures(env, config, result, "manual")
    });
  }
  if (url.pathname === "/api/geoip/mmdb" && request.method === "GET") {
    return jsonResponse(await readGeoIpMmdbStatus(env));
  }
  if (url.pathname === "/api/geoip/mmdb" && request.method === "POST") {
    return handleGeoIpMmdbUpload(request, env);
  }
  if (url.pathname === "/api/telegram/bind-code" && request.method === "POST") {
    return handleTelegramBindCode(request, env);
  }
  if (url.pathname === "/api/telegram/unbind" && request.method === "POST") {
    return handleTelegramUnbind(request, env);
  }
  if (url.pathname === "/api/config" && request.method === "PUT") {
    const config = await request.json().catch(() => null);
    if (!config || typeof config !== "object") return badRequest("Invalid config body");
    const current = await loadConfig(env);
    const next = config as Awaited<ReturnType<typeof loadConfig>>;
    const validationError = validateConfigForSave(next);
    if (validationError) return badRequest(validationError);
    const saved = await saveConfig(env, await reconcileTelegramWebhook(current, next, request.url));
    await refreshChangedSourceCache(env, current, saved);
    scheduleRuleSetRefresh(env, ctx, current, saved, request.url);
    return jsonResponse(saved);
  }
  if (url.pathname === "/api/config" && request.method === "PATCH") {
    const patch = await request.json().catch(() => null);
    if (!patch || typeof patch !== "object") return badRequest("Invalid config patch");
    const current = await loadConfig(env);
    const config = withInferredManagedBaseUrl(current, request.url);
    const normalizedPatch = patch as Partial<Awaited<ReturnType<typeof loadConfig>>>;
    const next = sanitizeConfigAfterPatch(mergeConfigPatch(config, normalizedPatch), normalizedPatch);
    const validationError = validateConfigForSave(next);
    if (validationError) return badRequest(validationError);
    const saved = await saveConfig(env, await reconcileTelegramWebhook(current, next, request.url));
    await refreshChangedSourceCache(env, current, saved);
    scheduleRuleSetRefresh(env, ctx, current, saved, request.url);
    return jsonResponse(saved);
  }
  if (url.pathname === "/api/preview" && request.method === "POST") {
    const config = await loadConfig(env);
    const targetParam = url.searchParams.get("target");
    const normalizedTarget = normalizeTarget(targetParam);
    if (targetParam !== null && !normalizedTarget) return badRequest("Invalid target");
    const target = normalizedTarget ?? inferTarget(request);
    if (!target) return badRequest("Missing target");
    const previewRequestUrl = buildManagedRequestUrl(config, request.url, await getOrCreateReadToken(env));
    const result = await generateConfig(env, config, target, previewRequestUrl, { includeRuleDiagnostics: true });
    return jsonResponse(result);
  }
  if (url.pathname === "/api/surge/validate-online" && request.method === "POST") {
    const body = await request.json().catch(() => ({})) as { content?: string; acknowledgeRisk?: boolean };
    if (body.acknowledgeRisk !== true) return badRequest("Surge online validation risk acknowledgement is required");
    if (typeof body.content !== "string" || !body.content.trim()) return badRequest("Missing Surge config content");
    if (body.content.length > 1_000_000) return badRequest("Surge config content is too large");
    let validationContent = body.content;
    if (hasDetachedProfileInclude(body.content)) {
      const config = await loadConfig(env);
      validationContent = await generateSurgeValidationConfig(env, config, buildManagedRequestUrl(config, request.url, "validation"));
    }
    if (validationContent.length > 1_000_000) return badRequest("Surge config content is too large");
    return jsonResponse(await validateSurgeOnline(sanitizeSurgeValidationContent(validationContent)));
  }
  if (url.pathname === "/api/read-token" && request.method === "GET") {
    const token = await getOrCreateReadToken(env);
    return jsonResponse({ token, hash: await sha256Hex(token) });
  }
  if (url.pathname === "/api/read-token/rotate" && request.method === "POST") {
    const token = await rotateReadToken(env);
    return jsonResponse({ token, hash: await sha256Hex(token) });
  }
  return notFound();
}

async function validateSurgeOnline(content: string): Promise<{ valid: boolean; error?: string }> {
  const response = await globalThis.fetch("https://services.nssurge.com/v1/config/validate", {
    method: "POST",
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: content
  });
  if (!response.ok) throw new Error(`Surge online validator returned HTTP ${response.status}`);
  const result = await response.json<{ valid?: unknown; error?: { message?: unknown } }>().catch(() => null);
  if (!result || typeof result.valid !== "boolean") throw new Error("Invalid Surge online validator response");
  return {
    valid: result.valid,
    ...(result.valid ? {} : { error: String(result.error?.message || "Unknown validation error") })
  };
}

function hasDetachedProfileInclude(content: string): boolean {
  return content.split(/\r?\n/).some((line) => line.trim().startsWith("#!include"));
}

async function handleSync(request: Request, env: Env, ctx: ExecutionContext, managedBasePath: string): Promise<Response> {
  const url = new URL(request.url);
  const token = extractSubscriptionToken(url.pathname, managedBasePath);
  if (!token || !(await validateReadToken(env, token))) return badRequest("Invalid subscription token");
  const syncPath = parseSyncPath(url.pathname, managedBasePath);
  if (!syncPath) return forbidden("Invalid subscription path");
  if (url.search) return forbidden("Invalid subscription path");
  if (syncPath.ruleSet) {
    return handleRuleSetDownload(request, env, ctx, await loadConfig(env), syncPath.ruleSet);
  }
  const target = inferTarget(request);
  if (!target) return unauthorized();
  const result = await generateForRequest(env, request, target);
  ctx.waitUntil(recordConfigFetch(env, result.target, request).catch((error) => {
    console.error(JSON.stringify({ level: "error", message: error instanceof Error ? error.message : String(error) }));
  }));
  return textResponse(result.content, result.contentType, {
    "content-disposition": contentDispositionForFileName(configFileNameForTarget(result.target))
  });
}

function contentDispositionForFileName(fileName: string): string {
  return `inline; filename="${fileName}"`;
}

async function currentManagedBasePath(env: Env, requestUrl: string): Promise<string> {
  return managedBasePathFromConfig(await loadConfig(env), requestUrl);
}

function buildManagedRequestUrl(config: Awaited<ReturnType<typeof loadConfig>>, requestUrl: string, token: string): string {
  return managedSubscriptionUrl(config, requestUrl, token);
}

function scheduleRuleSetRefresh(
  env: Env,
  ctx: ExecutionContext,
  previousConfig: Awaited<ReturnType<typeof loadConfig>>,
  config: Awaited<ReturnType<typeof loadConfig>>,
  requestUrl: string
): void {
  if (config.ruleSets.mode !== "compiled") return;
  ctx.waitUntil((async () => {
    const result = await refreshChangedRuleSetCaches(env, previousConfig, config);
    if (result) {
      await notifyRuleSetRefreshFailures(env, config, result, "config");
      await warmCompiledRuleSetWorkerCache(env, config, requestUrl, await getOrCreateReadToken(env));
    }
  })().catch((error) => {
    console.error(JSON.stringify({ level: "error", message: error instanceof Error ? error.message : String(error) }));
  }));
}

async function warmScheduledRuleSetWorkerCache(env: Env, config: Awaited<ReturnType<typeof loadConfig>>): Promise<void> {
  const token = await readStoredReadToken(env);
  if (!token || !config.settings.managedBaseUrl) return;
  await warmCompiledRuleSetWorkerCache(env, config, config.settings.managedBaseUrl, token);
}

function corsHeaders(): HeadersInit {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,OPTIONS",
    "access-control-allow-headers": "content-type,authorization"
  };
}

function wantsHtml(request: Request, url: URL): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (url.pathname === "/" || !url.pathname.includes(".")) return true;
  return request.headers.get("accept")?.includes("text/html") === true;
}
