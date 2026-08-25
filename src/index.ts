import { clearSessionCookie, createSession, getOrCreateReadToken, isAdminRequest, rotateReadToken, sessionCookie, validateAdminToken, validateReadToken } from "./auth";
import { mergeConfigPatch, sanitizeConfigAfterPatch, validateConfigForSave } from "./config-api";
import { runKvMigrations } from "./config-schema";
import { loadConfig, normalizeTarget, saveConfig, withInferredManagedBaseUrl } from "./config-store";
import { readConfigFetchStats, recordConfigFetch } from "./fetch-stats";
import { generateConfig, generateForRequest, inferTarget } from "./generator";
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

const SOURCE_REFRESH_CRON = "0 */12 * * *";
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
      if (config.ruleSets.mode !== "compiled") return;
      const ruleSetResult = await refreshRuleSetCaches(env, config, undefined, {
        deadline: Date.now() + SCHEDULED_REFRESH_DEADLINE_MS
      });
      await notifyRuleSetRefreshFailures(env, config, ruleSetResult, "scheduled");
      await warmScheduledRuleSetWorkerCache(env, config);
      return;
    }
    if (controller.cron !== SOURCE_REFRESH_CRON) return;
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
  if (url.pathname === "/api/config" && request.method === "PUT") {
    let config: unknown;
    try {
      config = await readRequestJsonWithLimit<unknown>(request, MAX_CONFIG_REQUEST_BYTES);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) return payloadTooLarge("Config request body is too large");
      config = null;
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) return badRequest("Invalid config body");
    const current = await loadConfig(env);
    const next = config as Awaited<ReturnType<typeof loadConfig>>;
    const validationError = validateConfigForSave(next);
    if (validationError) return badRequest(validationError);
    const saved = await saveConfigWithTelegramWebhook(env, current, next, request.url);
    scheduleChangedCacheRefresh(env, ctx, current, saved, request.url);
    return jsonResponse(saved);
  }
  if (url.pathname === "/api/config" && request.method === "PATCH") {
    let patch: unknown;
    try {
      patch = await readRequestJsonWithLimit<unknown>(request, MAX_CONFIG_REQUEST_BYTES);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) return payloadTooLarge("Config request body is too large");
      patch = null;
    }
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return badRequest("Invalid config patch");
    const current = await loadConfig(env);
    const config = withInferredManagedBaseUrl(current, request.url);
    const normalizedPatch = patch as Partial<Awaited<ReturnType<typeof loadConfig>>>;
    let next: Awaited<ReturnType<typeof loadConfig>>;
    try {
      next = sanitizeConfigAfterPatch(mergeConfigPatch(config, normalizedPatch), normalizedPatch);
    } catch {
      return badRequest("Invalid config patch");
    }
    const validationError = validateConfigForSave(next);
    if (validationError) return badRequest(validationError);
    const saved = await saveConfigWithTelegramWebhook(env, current, next, request.url);
    scheduleChangedCacheRefresh(env, ctx, current, saved, request.url);
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

function scheduleChangedCacheRefresh(
  env: Env,
  ctx: ExecutionContext,
  previousConfig: Awaited<ReturnType<typeof loadConfig>>,
  config: Awaited<ReturnType<typeof loadConfig>>,
  requestUrl: string
): void {
  const deadline = Date.now() + WAIT_UNTIL_REFRESH_DEADLINE_MS;
  ctx.waitUntil((async () => {
    const [sourceResult, ruleSetResult] = await Promise.all([
      refreshChangedSourceCache(env, previousConfig, config, { deadline }),
      refreshChangedRuleSetCaches(env, previousConfig, config, { deadline })
    ]);
    if (ruleSetResult) {
      if (Date.now() < deadline) {
        await warmCompiledRuleSetWorkerCache(
          env,
          config,
          requestUrl,
          await getOrCreateReadToken(env),
          undefined,
          { deadline }
        );
      }
    }
    await Promise.all([
      sourceResult ? notifySourceRefreshFailures(env, config, sourceResult, "config") : Promise.resolve(null),
      ruleSetResult ? notifyRuleSetRefreshFailures(env, config, ruleSetResult, "config") : Promise.resolve(null)
    ]);
  })().catch((error) => {
    console.error(JSON.stringify({ level: "error", message: error instanceof Error ? error.message : String(error) }));
  }));
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
