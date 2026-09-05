import { refreshRuleSetSourceCaches } from "./rule-set-cache";
import { configDocument, normalizeConfigDocument, renderConfig, OUTPUT_TARGETS } from "./config-document";
import { exportConfigBeforeMigration, completeDocumentMigration } from "./config-store";
import { ruleSetEnv } from "./rule-set-scope";
import { validateManagedBaseUrl, validateConfigEntityLimits, validateProxyPolicyNameConflicts, validateRuleSetOutputNames } from "./config-validation";
import { assertSafeConfigText } from "./config-text-safety";
import type { AppConfig, RenderConfig } from "./types";
import { clearSessionCookie, createSession, getOrCreateReadToken, isAdminRequest, rotateReadToken, sessionCookie, validateAdminToken, validateReadToken } from "./auth";
import { loadConfig, normalizeTarget, saveConfig, withInferredManagedBaseUrl } from "./config-store";
import { readConfigFetchStats, recordConfigFetch } from "./fetch-stats";
import { generateConfig, generateForRequest } from "./generator";
import { resolveSurgeProfileTag } from "./surge-capabilities";
import { handleGeoIpMmdbUpload, readGeoIpMmdbStatus } from "./geoip-admin";
import { LOGIN_PAGE_HTML } from "./login-page";
import { extractSubscriptionToken, isUnderManagedBasePath, managedBasePathFromConfig, managedSubscriptionUrl, parseSyncPath } from "./managed-url";
import { notifyRuleSetRefreshFailures, notifySourceRefreshFailures, notifyVersionUpdateAvailable } from "./notifications";
import { refreshChangedRuleSetCaches, refreshRuleSetCaches } from "./rule-set-compiler";
import { handleRuleSetApi, handleRuleSetDownload } from "./rule-set-endpoints";
import { warmCompiledRuleSetWorkerCache } from "./rule-set-worker-cache";
import { refreshChangedSourceCache, refreshSourceCache } from "./source-cache";
import { configFileNameForTarget } from "./target-files";
import { handleTelegramBindCode, handleTelegramUnbind, handleTelegramWebhook, saveConfigWithTelegramWebhook } from "./telegram";
import { readCachedUpdateStatus, getUpdateStatus } from "./update-check";
import { APP_VERSION, RELEASE_REPOSITORY } from "./version";
import { badRequest, forbidden, jsonResponse, notFound, payloadTooLarge, readRequestJsonWithLimit, RequestBodyTooLargeError, sha256Hex, textResponse, tooManyRequests, unauthorized } from "./util";

const RULE_SET_REFRESH_CRON = "0 16 * * *";
const MAX_LOGIN_REQUEST_BYTES = 4 * 1024;
const MAX_CONFIG_REQUEST_BYTES = 2 * 1024 * 1024;
const LOGIN_RATE_LIMIT = 10;
const LOGIN_RATE_LIMIT_PERIOD_SECONDS = 60;
const MAX_FALLBACK_LOGIN_KEYS = 1_024;
const WAIT_UNTIL_REFRESH_DEADLINE_MS = 18_000;
const MANUAL_REFRESH_DEADLINE_MS = 20_000;
const SCHEDULED_REFRESH_DEADLINE_MS = 12 * 60 * 1000;
const fallbackLoginAttempts = new WeakMap<object, Map<string, { count: number; startedAt: number }>>();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      console.error(JSON.stringify({ level: "error", message: error instanceof Error ? error.message : String(error) }));
      if (isKvWriteRateLimitError(error)) return tooManyRequests("Configuration storage is busy; retry shortly", 2);
      return jsonResponse({ error: "Internal server error" }, { status: 500 });
    }
  },
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const config = await loadConfig(env);
    if (controller.cron === RULE_SET_REFRESH_CRON) {
      const deadline = Date.now() + SCHEDULED_REFRESH_DEADLINE_MS;
      if (!OUTPUT_TARGETS.some((target) => renderConfig(configDocument(config), target).ruleSets.mode === "compiled")) return;
      const sourceRefresh = await refreshRuleSetSourceCaches(env, config, config.ruleSets.sources.filter((source) => source.enabled && source.url), { deadline, pruneUnexpected: true });
      for (const target of OUTPUT_TARGETS) {
        const selected = renderConfig(configDocument(config), target);
        if (selected.ruleSets.mode !== "compiled") continue;
        const scoped = ruleSetEnv(env, target);
        const result = await refreshRuleSetCaches(scoped, selected, undefined, { deadline, sourceRefresh });
        await notifyRuleSetRefreshFailures(env, selected, result, "scheduled");
        await warmScheduledRuleSetWorkerCache(scoped, selected);
      }
      return;
    }
    // The installer allows custom upstream schedules; the other trigger is
    // reserved for rule sets above.
    const result = await refreshSourceCache(env, config, {
      deadline: Date.now() + SCHEDULED_REFRESH_DEADLINE_MS
    });
    await notifySourceRefreshFailures(env, config, result, "scheduled");
    await notifyVersionUpdateAvailable(env, config);
  }
} satisfies ExportedHandler<Env>;

function isKvWriteRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:KV|put|write|rate)[^\n]{0,120}(?:429|too many|rate.?limit)/i.test(message)
    || /(?:429|too many|rate.?limit)[^\n]{0,120}(?:KV|put|write)/i.test(message);
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });

  if (url.pathname === "/api/login" && request.method === "POST") return handleLogin(request, env);
  if (url.pathname === "/api/logout" && request.method === "POST") return handleLogout(request);
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
  if (!await consumeLoginAttempt(env, loginRateKey(request))) {
    await request.body?.cancel().catch(() => undefined);
    return tooManyRequests("Too many login attempts", LOGIN_RATE_LIMIT_PERIOD_SECONDS);
  }
  let body: unknown;
  try {
    body = await readRequestJsonWithLimit<unknown>(request, MAX_LOGIN_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return payloadTooLarge("Login request body is too large");
    body = {};
  }
  const tokenValue = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).token
    : undefined;
  const token = typeof tokenValue === "string" ? tokenValue : "";
  if (!await validateAdminToken(env, token)) return unauthorized();
  const session = await createSession(env);
  return jsonResponse({ ok: true }, { headers: { "set-cookie": sessionCookie(session, new URL(request.url).protocol === "https:") } });
}

function handleLogout(request: Request): Response {
  return jsonResponse({ ok: true }, {
    headers: { "set-cookie": clearSessionCookie(new URL(request.url).protocol === "https:") }
  });
}

async function handleApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!await isAdminRequest(env, request)) return unauthorized();
  const url = new URL(request.url);

  if (url.pathname === "/api/config" && request.method === "GET") {
    const loaded = withInferredManagedBaseUrl(await loadConfig(env), request.url);
    return jsonResponse({ ...configDocument(loaded), migrationRequired: Boolean(loaded.migrationRequired) });
  }
  if (url.pathname === "/api/config/export" && request.method === "GET") {
    const backup = await exportConfigBeforeMigration(env);
    const content = JSON.stringify(backup, null, 2);
    return textResponse(content, "application/json; charset=utf-8", { "content-disposition": 'attachment; filename="subpilot-config-backup.json"', "cache-control": "no-store" });
  }
  if (url.pathname === "/api/config/migration" && request.method === "GET") {
    const backup = await exportConfigBeforeMigration(env);
    const loaded = await loadConfig(env);
    return jsonResponse({ required: Boolean(loaded.migrationRequired), fingerprint: await sha256Hex(JSON.stringify(backup)), config: configDocument(withInferredManagedBaseUrl(loaded, request.url)) });
  }
  if (url.pathname === "/api/config/migration" && request.method === "POST") {
    const body = await readRequestJsonWithLimit<{ config: AppConfig; fingerprint: string; backupDownloaded: boolean }>(request, MAX_CONFIG_REQUEST_BYTES);
    if (body.backupDownloaded !== true) return badRequest("请先下载旧配置备份。");
    const current = await exportConfigBeforeMigration(env);
    if (await sha256Hex(JSON.stringify(current)) !== body.fingerprint) return jsonResponse({ error: "旧配置已变化，请重新导出并预览迁移。" }, { status: 409 });
    try {
      const document = normalizeConfigDocument(body.config);
      const error = validateDocumentForSave(document);
      if (error) return badRequest(error);
      const saved = await completeDocumentMigration(env, document);
      return jsonResponse(configDocument(saved));
    } catch { return badRequest("迁移未完成，请检查配置或重试；旧数据尚未清理。"); }
  }
  if (url.pathname === "/api/stats" && request.method === "GET") {
    const config = await loadConfig(env);
    return jsonResponse(await readConfigFetchStats(env, config));
  }
  if (url.pathname === "/api/system/status" && request.method === "GET") {
    return jsonResponse({
      app: {
        version: APP_VERSION,
        releaseRepository: RELEASE_REPOSITORY
      },
      update: await readCachedUpdateStatus(env)
    });
  }
  if (url.pathname === "/api/system/migrate" && request.method === "POST") {
    return jsonResponse({ error: "请通过配置迁移页面导出备份并确认迁移。" }, { status: 409 });
  }
  if (url.pathname === "/api/update-check" && request.method === "POST") {
    return jsonResponse({ update: await getUpdateStatus(env, { force: true }) });
  }
  {
    const config = await loadConfig(env);
    const targetParam = url.searchParams.get("target");
    const target = normalizeTarget(targetParam) ?? "surge";
    if (targetParam && !normalizeTarget(targetParam)) return badRequest("Invalid target");
    const selected = renderConfig(configDocument(config), target);
    const response = await handleRuleSetApi(request, ruleSetEnv(env, target), ctx, selected);
    if (response) return response;
  }
  if (url.pathname === "/api/cache/source/refresh" && request.method === "POST") {
    const config = await loadConfig(env);
    const result = await refreshSourceCache(env, config, {
      deadline: Date.now() + MANUAL_REFRESH_DEADLINE_MS
    });
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
  if (url.pathname === "/api/config" && (request.method === "PUT" || request.method === "PATCH")) {
    const current = await loadConfig(env);
    if (current.migrationRequired) return jsonResponse({ error: "请先导出旧配置并完成迁移。" }, { status: 409 });
    let document: AppConfig;
    try {
      const body = await readRequestJsonWithLimit<AppConfig>(request, MAX_CONFIG_REQUEST_BYTES);
      const existing = configDocument(current);
      const input = request.method === "PATCH" ? { ...existing, ...body, settings: { ...existing.settings, ...body.settings }, clients: { ...existing.clients, ...body.clients } } : body;
      document = normalizeConfigDocument(input);
      const error = validateDocumentForSave(document);
      if (error) return badRequest(error);
    } catch { return badRequest("配置格式无效或超过大小限制。"); }
    const saved = await saveConfigWithTelegramWebhook(env, current, renderConfig(document), request.url);
    scheduleChangedCacheRefresh(env, ctx, current, saved, request.url);
    return jsonResponse(configDocument(saved));
  }
  if (url.pathname === "/api/preview" && request.method === "POST") {
    const target = normalizeTarget(url.searchParams.get("target"));
    if (!target) return badRequest("Missing or invalid target");
    const profileParam = url.searchParams.get("profile");
    const surgeProfile = resolveSurgeProfileTag(profileParam ?? "stable");
    if (!surgeProfile || target !== "surge" && profileParam !== null) return badRequest("无效的 Surge 兼容档位。");
    const loaded = await loadConfig(env);
    let document = configDocument(loaded);
    if (request.headers.get("content-type")?.includes("application/json")) {
      try {
        const body = await readRequestJsonWithLimit<AppConfig>(request, MAX_CONFIG_REQUEST_BYTES);
        document = normalizeConfigDocument(body);
        const error = validateDocumentForSave(document);
        if (error) return badRequest(error);
      } catch { return badRequest("预览配置格式无效。"); }
    }
    const selected = renderConfig(document, target);
    const previewRequestUrl = managedSubscriptionUrl(selected, request.url, await getOrCreateReadToken(env), target, surgeProfile);
    return jsonResponse(await generateConfig(env, selected, target, previewRequestUrl, { includeRuleDiagnostics: true, surgeProfile }));
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

async function consumeLoginAttempt(env: Env, key: string): Promise<boolean> {
  const limiter = (env as Env & { LOGIN_RATE_LIMITER?: RateLimit }).LOGIN_RATE_LIMITER;
  if (limiter) {
    try {
      return (await limiter.limit({ key })).success;
    } catch (error) {
      console.warn(JSON.stringify({
        level: "warn",
        message: `Login rate limiter failed; using isolate fallback: ${error instanceof Error ? error.message : String(error)}`
      }));
    }
  }

  const now = Date.now();
  let attempts = fallbackLoginAttempts.get(env);
  if (!attempts) {
    attempts = new Map();
    fallbackLoginAttempts.set(env, attempts);
  }
  const current = attempts.get(key);
  if (!current || now - current.startedAt >= LOGIN_RATE_LIMIT_PERIOD_SECONDS * 1000) {
    if (attempts.size >= MAX_FALLBACK_LOGIN_KEYS) {
      for (const [storedKey, value] of attempts) {
        if (now - value.startedAt >= LOGIN_RATE_LIMIT_PERIOD_SECONDS * 1000) attempts.delete(storedKey);
      }
      if (attempts.size >= MAX_FALLBACK_LOGIN_KEYS) {
        const oldestKey = attempts.keys().next().value as string | undefined;
        if (oldestKey) attempts.delete(oldestKey);
      }
    }
    attempts.set(key, { count: 1, startedAt: now });
    return true;
  }
  current.count += 1;
  return current.count <= LOGIN_RATE_LIMIT;
}

function loginRateKey(request: Request): string {
  const clientIp = request.headers.get("cf-connecting-ip")?.trim() ?? "";
  return `admin-login:${clientIp && clientIp.length <= 64 ? clientIp : "unknown"}`;
}

async function handleSync(request: Request, env: Env, ctx: ExecutionContext, managedBasePath: string): Promise<Response> {
  const url = new URL(request.url);
  const token = extractSubscriptionToken(url.pathname, managedBasePath);
  if (!token || !(await validateReadToken(env, token))) return badRequest("Invalid subscription token");
  const syncPath = parseSyncPath(url.pathname, managedBasePath);
  if (!syncPath) return forbidden("Invalid subscription path");
  if (url.search) return forbidden("Invalid subscription path");
  if (syncPath.ruleSet) {
    if (syncPath.ruleSet.target === "stash") return notFound();
    const target = syncPath.ruleSet.target;
    return handleRuleSetDownload(request, ruleSetEnv(env, target), ctx, renderConfig(configDocument(await loadConfig(env)), target), syncPath.ruleSet);
  }
  const target = syncPath.target;
  const result = await generateForRequest(env, request, target, { surgeProfile: syncPath.surgeProfile ?? "stable" });
  if (!result.canDownload) return jsonResponse({ error: "Configuration is not ready for this target" }, { status: 422 });
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

function scheduleChangedCacheRefresh(
  env: Env,
  ctx: ExecutionContext,
  previousConfig: Awaited<ReturnType<typeof loadConfig>>,
  config: Awaited<ReturnType<typeof loadConfig>>,
  requestUrl: string
): void {
  const deadline = Date.now() + WAIT_UNTIL_REFRESH_DEADLINE_MS;
  ctx.waitUntil((async () => {
    const sourceResult = await refreshChangedSourceCache(env, previousConfig, config, { deadline });
    if (sourceResult) await notifySourceRefreshFailures(env, config, sourceResult, "config");
    const oldSources = new Map(previousConfig.ruleSets.sources.map((source) => [source.id, JSON.stringify(source)]));
    const changedSources = config.ruleSets.sources.filter((source) => oldSources.get(source.id) !== JSON.stringify(source));
    const sourceRefresh = await refreshRuleSetSourceCaches(env, config, changedSources, { deadline, pruneUnexpected: false });
    for (const target of OUTPUT_TARGETS) {
      if (Date.now() >= deadline) break;
      const scoped = ruleSetEnv(env, target);
      const selected = renderConfig(configDocument(config), target);
      const previous = renderConfig(configDocument(previousConfig), target);
      const result = await refreshChangedRuleSetCaches(scoped, previous, selected, { deadline, sourceRefresh });
      if (result) {
        await notifyRuleSetRefreshFailures(env, selected, result, "config");
        await warmCompiledRuleSetWorkerCache(scoped, selected, requestUrl, await getOrCreateReadToken(env), undefined, { deadline });
      }
    }
  })().catch(() => console.error(JSON.stringify({ level: "error", message: "Background cache refresh failed" }))));
}

async function warmScheduledRuleSetWorkerCache(env: Env, config: Awaited<ReturnType<typeof loadConfig>>): Promise<void> {
  const token = await getOrCreateReadToken(env);
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

function validateDocumentForSave(document: AppConfig): string | null {
  try {
    for (const name of Object.keys(document.groups)) assertSafeConfigText(name, "Policy name");
    for (const source of document.sources) assertSafeConfigText({ id: source.id, name: source.name, url: source.url, fetchUserAgent: source.fetchUserAgent }, "Source");
    const managedError = validateManagedBaseUrl(document);
    if (managedError) return managedError;
    // Match errors belong to the target generation report; shape/size errors block storage.
    for (const target of OUTPUT_TARGETS) {
      const view = renderConfig(document, target);
      const error = validateConfigEntityLimits(view, { allowUnresolvedPolicies: true }) || validateProxyPolicyNameConflicts(view)
        || validateRuleSetOutputNames({ ruleSets: { ...view.ruleSets, mode: "manual" } });
      if (error) return error;
    }
    if (document.clients.singbox.inbounds.length > 100 || (Array.isArray(document.clients.singbox.route.rules) && document.clients.singbox.route.rules.length > 10_000)) return "sing-box 入站或路由规则超过数量限制。";
    return null;
  } catch { return "配置包含非法内容。"; }
}
