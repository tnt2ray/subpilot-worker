import { clearSessionCookie, createSession, getOrCreateReadToken, isAdminRequest, rotateReadToken, sessionCookie, validateAdminToken, validateReadToken } from "./auth";
import { readKvSchemaStatus, runKvMigrations } from "./config-schema";
import { loadConfig, normalizeTarget, saveConfig, validateManagedBaseUrl, withInferredManagedBaseUrl } from "./config-store";
import { readConfigFetchStats, recordConfigFetch } from "./fetch-stats";
import { generateConfig, generateForRequest, generateSurgeValidationConfig, inferTarget } from "./generator";
import { createGeoIpCountryReader, GEOIP_MMDB_KV_KEY, GEOIP_MMDB_META_KV_KEY, resetGeoIpCountryReader } from "./geoip";
import { LOGIN_PAGE_HTML } from "./login-page";
import { notifySourceRefreshFailures, notifyVersionUpdateAvailable } from "./notifications";
import { refreshSourceCache } from "./source-cache";
import { sanitizeSurgeValidationContent } from "./surge-validation-sanitize";
import { configFileNameForTarget, syncPathForToken } from "./target-files";
import { validateSurgeHosts } from "./surge-hosts";
import { SURGE_BUILT_IN_POLICIES, validateSurgeRules } from "./surge-rules";
import { validateSurgeUrlRewrite } from "./surge-url-rewrite";
import { readCachedUpdateStatus, getUpdateStatus } from "./update-check";
import { APP_VERSION, RELEASE_REPOSITORY } from "./version";
import { badRequest, forbidden, jsonResponse, notFound, randomToken, sha256Hex, textResponse, timingSafeEqualString, unauthorized } from "./util";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      console.error(JSON.stringify({ level: "error", message: error instanceof Error ? error.message : String(error) }));
      return jsonResponse({ error: "Internal server error" }, { status: 500 });
    }
  },
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const config = await loadConfig(env);
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
    return jsonResponse({
      app: {
        version: APP_VERSION,
        releaseRepository: RELEASE_REPOSITORY
      },
      schema: await readKvSchemaStatus(env),
      update: await readCachedUpdateStatus(env)
    });
  }
  if (url.pathname === "/api/system/migrate" && request.method === "POST") {
    return jsonResponse({ schema: await runKvMigrations(env) });
  }
  if (url.pathname === "/api/update-check" && request.method === "POST") {
    return jsonResponse({ update: await getUpdateStatus(env, { force: true }) });
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
    const error = validateManagedBaseUrl(next);
    if (error) return badRequest(error);
    const surgeRuleError = validateSurgeRules(next);
    if (surgeRuleError) return badRequest(surgeRuleError);
    const surgeHostError = validateSurgeHosts(next);
    if (surgeHostError) return badRequest(surgeHostError);
    const surgeUrlRewriteError = validateSurgeUrlRewrite(next);
    if (surgeUrlRewriteError) return badRequest(surgeUrlRewriteError);
    return jsonResponse(await saveConfig(env, await reconcileTelegramWebhook(current, next, request.url)));
  }
  if (url.pathname === "/api/config" && request.method === "PATCH") {
    const patch = await request.json().catch(() => null);
    if (!patch || typeof patch !== "object") return badRequest("Invalid config patch");
    const current = await loadConfig(env);
    const config = withInferredManagedBaseUrl(current, request.url);
    const normalizedPatch = patch as Partial<Awaited<ReturnType<typeof loadConfig>>>;
    const next = sanitizeConfigAfterPatch(mergeConfigPatch(config, normalizedPatch), normalizedPatch);
    const error = validateManagedBaseUrl(next);
    if (error) return badRequest(error);
    const surgeRuleError = validateSurgeRules(next);
    if (surgeRuleError) return badRequest(surgeRuleError);
    const surgeHostError = validateSurgeHosts(next);
    if (surgeHostError) return badRequest(surgeHostError);
    const surgeUrlRewriteError = validateSurgeUrlRewrite(next);
    if (surgeUrlRewriteError) return badRequest(surgeUrlRewriteError);
    return jsonResponse(await saveConfig(env, await reconcileTelegramWebhook(current, next, request.url)));
  }
  if (url.pathname === "/api/preview" && request.method === "POST") {
    const config = await loadConfig(env);
    const targetParam = url.searchParams.get("target");
    const normalizedTarget = normalizeTarget(targetParam);
    if (targetParam !== null && !normalizedTarget) return badRequest("Invalid target");
    const target = normalizedTarget ?? inferTarget(request);
    if (!target) return badRequest("Missing target");
    const previewRequestUrl = buildManagedRequestUrl(config, request.url, await getOrCreateReadToken(env));
    const result = await generateConfig(env, config, target, previewRequestUrl);
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
  ctx.waitUntil(Promise.resolve());
  return notFound();
}

interface TelegramChatOption {
  id: string;
  type: string;
  label: string;
  title?: string | undefined;
  username?: string | undefined;
  firstName?: string | undefined;
  lastName?: string | undefined;
}

interface TelegramCommand {
  name: string;
  args: string;
}

const TELEGRAM_BIND_KEY = "auth:telegram_bind";
const TELEGRAM_BIND_TTL_MS = 10 * 60 * 1000;
const MAX_MMDB_BYTES = 25 * 1024 * 1024;

interface GeoIpMmdbMeta {
  fileName: string;
  size: number;
  updatedAt: string;
}

async function readGeoIpMmdbStatus(env: Env): Promise<{ uploaded: boolean } & Partial<GeoIpMmdbMeta>> {
  const [meta, hasData] = await Promise.all([
    env.SUBPILOT_CONFIG.get(GEOIP_MMDB_META_KV_KEY, "json") as Promise<Partial<GeoIpMmdbMeta> | null>,
    hasKvKey(env, GEOIP_MMDB_KV_KEY)
  ]);
  if (!hasData) return { uploaded: false };
  if (!meta || typeof meta !== "object") return { uploaded: false };
  const fileName = typeof meta.fileName === "string" ? meta.fileName : "";
  const size = typeof meta.size === "number" && Number.isFinite(meta.size) ? meta.size : 0;
  const updatedAt = typeof meta.updatedAt === "string" ? meta.updatedAt : "";
  return { uploaded: true, fileName, size, updatedAt };
}

async function handleGeoIpMmdbUpload(request: Request, env: Env): Promise<Response> {
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return badRequest("Missing MMDB file");
  if (file.size <= 0) return badRequest("MMDB file is empty");
  if (file.size > MAX_MMDB_BYTES) return badRequest("MMDB file exceeds 25 MiB KV value limit");

  const data = await file.arrayBuffer();
  try {
    createGeoIpCountryReader(data);
  } catch {
    return badRequest("Invalid MMDB file");
  }

  const meta: GeoIpMmdbMeta = {
    fileName: file.name || "GeoIP.mmdb",
    size: file.size,
    updatedAt: new Date().toISOString()
  };
  await env.SUBPILOT_CONFIG.put(GEOIP_MMDB_KV_KEY, data);
  await env.SUBPILOT_CONFIG.put(GEOIP_MMDB_META_KV_KEY, JSON.stringify(meta));
  await deleteGeoIpLocationCache(env);
  resetGeoIpCountryReader();
  return jsonResponse({ uploaded: true, ...meta });
}

async function hasKvKey(env: Env, key: string): Promise<boolean> {
  const page = await env.SUBPILOT_CONFIG.list({ prefix: key });
  return page.keys.some((entry) => entry.name === key);
}

async function deleteGeoIpLocationCache(env: Env): Promise<void> {
  let cursor: string | undefined;
  do {
    const options: KVNamespaceListOptions = cursor
      ? { prefix: "cache:geoip:location:", cursor }
      : { prefix: "cache:geoip:location:" };
    const page = await env.SUBPILOT_CONFIG.list(options);
    await Promise.all(page.keys.map((key) => env.SUBPILOT_CONFIG.delete(key.name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

async function handleTelegramBindCode(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ token?: string }>().catch((): { token?: string } => ({}));
  const config = await loadConfig(env);
  const token = (typeof body.token === "string" ? body.token.trim() : "") || config.settings.notificationTelegramBotToken.trim();
  if (!token) return badRequest("Telegram bot token is required");

  const next = await reconcileTelegramWebhook(config, {
    ...config,
    settings: {
      ...config.settings,
      notificationChannel: "telegram",
      notificationTelegramBotToken: token
    }
  }, request.url);
  const saved = await saveConfig(env, next);
  const code = randomTelegramBindCode();
  const expiresAt = new Date(Date.now() + TELEGRAM_BIND_TTL_MS).toISOString();
  await storeTelegramBindCode(env, code, expiresAt);
  return jsonResponse({
    code,
    command: `/bind ${code}`,
    expiresAt,
    config: withInferredManagedBaseUrl(saved, request.url)
  });
}

async function handleTelegramUnbind(request: Request, env: Env): Promise<Response> {
  const config = await loadConfig(env);
  await env.SUBPILOT_CONFIG.delete(TELEGRAM_BIND_KEY);
  const saved = await saveConfig(env, {
    ...config,
    settings: {
      ...config.settings,
      notificationTelegramChatId: ""
    }
  });
  return jsonResponse(withInferredManagedBaseUrl(saved, request.url));
}

async function handleTelegramWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const config = await loadConfig(env);
  const expectedSecret = config.settings.notificationTelegramWebhookSecret.trim();
  const receivedSecret = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!expectedSecret || !receivedSecret || !await timingSafeEqualString(receivedSecret, expectedSecret)) {
    return forbidden("Invalid Telegram webhook secret");
  }

  const update = await request.json().catch(() => null);
  const message = telegramTextMessageCandidate(update);
  const code = message ? telegramBindCode(message.text) : "";
  const chat = message ? normalizeTelegramChat(message.chat) : null;
  const command = message ? telegramBotCommand(message.text) : null;
  const boundChatId = config.settings.notificationTelegramChatId.trim();
  if (message && chat && isTelegramBindAttempt(message.text) && boundChatId) {
    return jsonResponse({ ok: true });
  }
  if (message && chat && code && await consumeTelegramBindCode(env, code)) {
    await saveConfig(env, {
      ...config,
      settings: {
        ...config.settings,
        notificationChannel: "telegram",
        notificationTelegramChatId: chat.id
      }
    });
    await sendTelegramBotMessage(config.settings.notificationTelegramBotToken.trim(), chat.id, "SubPilot Telegram 通知已绑定成功。").catch(logTelegramFeedbackFailure);
  } else if (message && chat && isTelegramBindAttempt(message.text)) {
    await sendTelegramBotMessage(config.settings.notificationTelegramBotToken.trim(), chat.id, "绑定失败：请在 SubPilot 后台重新生成绑定命令，并在 10 分钟内发送完整的 /bind 命令。").catch(logTelegramFeedbackFailure);
  } else if (chat && command) {
    if (!boundChatId || !await timingSafeEqualString(chat.id, boundChatId)) {
      return jsonResponse({ ok: true });
    }
    ctx.waitUntil(handleTelegramCommand(env, config, chat, command).catch(logTelegramCommandFailure));
  }
  return jsonResponse({ ok: true });
}

async function handleTelegramCommand(
  env: Env,
  config: Awaited<ReturnType<typeof loadConfig>>,
  chat: TelegramChatOption,
  command: TelegramCommand
): Promise<void> {
  const token = config.settings.notificationTelegramBotToken.trim();
  if (!token) return;

  switch (command.name) {
    case "help":
    case "start":
      await sendTelegramBotMessage(token, chat.id, formatTelegramHelpMessage());
      return;
    case "status":
      await sendTelegramBotMessage(token, chat.id, formatTelegramStatusMessage(config, await readConfigFetchStats(env, config)));
      return;
    case "sources":
      await sendTelegramBotMessage(token, chat.id, formatTelegramSourcesMessage(config));
      return;
    case "recent":
      await sendTelegramBotMessage(token, chat.id, formatTelegramRecentFetchesMessage(await readConfigFetchStats(env)));
      return;
    case "refresh":
      await sendTelegramBotMessage(token, chat.id, "开始强制重新拉取上游订阅源。完成后会发送结果。").catch(logTelegramCommandFailure);
      await handleTelegramRefreshCommand(env, chat.id);
      return;
    default:
      await sendTelegramBotMessage(token, chat.id, `未知命令：/${command.name}\n\n${formatTelegramHelpMessage()}`);
  }
}

async function handleTelegramRefreshCommand(env: Env, chatId: string): Promise<void> {
  const config = await loadConfig(env);
  const token = config.settings.notificationTelegramBotToken.trim();
  if (!token) return;
  try {
    const result = await refreshSourceCache(env, config);
    await sendTelegramBotMessage(token, chatId, formatTelegramRefreshResultMessage(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sendTelegramBotMessage(token, chatId, `上游订阅源强制获取失败：${message}`).catch(logTelegramCommandFailure);
  }
}

function formatTelegramHelpMessage(): string {
  return [
    "SubPilot bot 命令：",
    "/status - 查看订阅与缓存概览",
    "/sources - 查看订阅源启用状态",
    "/recent - 查看最近配置拉取记录",
    "/refresh - 强制重新拉取上游订阅源",
    "/help - 查看命令列表"
  ].join("\n");
}

function formatTelegramStatusMessage(
  config: Awaited<ReturnType<typeof loadConfig>>,
  stats: Awaited<ReturnType<typeof readConfigFetchStats>>
): string {
  const enabledSources = config.sources.filter((source) => source.enabled && source.url).length;
  const disabledSources = config.sources.filter((source) => !source.enabled || !source.url).length;
  return [
    "SubPilot 状态",
    `订阅源：启用 ${enabledSources} / 停用 ${disabledSources}`,
    ...formatTelegramSourceCacheLines(stats.sourceCache),
    `最近 Surge 配置获取：${formatTelegramTimestamp(stats.lastFetched.surge)}`,
    `最近 Clash 配置获取：${formatTelegramTimestamp(stats.lastFetched.clash)}`
  ].join("\n");
}

function formatTelegramSourceCacheLines(sourceCache: Awaited<ReturnType<typeof readConfigFetchStats>>["sourceCache"]): string[] {
  if (sourceCache.expectedCount <= 0) {
    return [
      `上游缓存：${sourceCache.count} 条缓存，没有启用订阅源`,
      `缓存更新时间：${formatTelegramTimestamp(sourceCache.updatedAt)}`
    ];
  }
  const missing = sourceCache.expectedCount - sourceCache.cachedSourceCount;
  const sourceSummary = missing > 0
    ? `${sourceCache.cachedSourceCount} / ${sourceCache.expectedCount} 个启用源已缓存，缺 ${missing} 个`
    : `${sourceCache.cachedSourceCount} / ${sourceCache.expectedCount} 个启用源已缓存，全部就绪`;
  return [
    `上游缓存：${sourceSummary}`,
    `缓存条目：${sourceCache.count} 条`,
    `缓存更新时间：${formatTelegramTimestamp(sourceCache.updatedAt)}`,
    `协议节点：${formatTelegramProtocolCounts(sourceCache)}`,
    "订阅源缓存：",
    ...sourceCache.sources.slice(0, 12).map(formatTelegramSourceCacheStatus),
    ...(sourceCache.sources.length > 12 ? [`... 还有 ${sourceCache.sources.length - 12} 个订阅源未显示`] : [])
  ];
}

function formatTelegramProtocolCounts(sourceCache: Awaited<ReturnType<typeof readConfigFetchStats>>["sourceCache"]): string {
  if (sourceCache.totalNodes <= 0 || sourceCache.protocolCounts.length === 0) return "未解析到节点";
  return [
    ...sourceCache.protocolCounts.map((item) => `${item.protocol} ${item.count}`),
    `总计 ${sourceCache.totalNodes}`
  ].join("，");
}

function formatTelegramSourceCacheStatus(source: Awaited<ReturnType<typeof readConfigFetchStats>>["sourceCache"]["sources"][number]): string {
  const name = source.sourceName || source.sourceId || "(未命名订阅源)";
  if (!source.cached) return `- ${name}：未缓存`;
  return `- ${name}：已缓存，${source.nodeCount} 个节点，${formatTelegramTimestamp(source.fetchedAt)}`;
}

function formatTelegramSourcesMessage(config: Awaited<ReturnType<typeof loadConfig>>): string {
  const sources = config.sources;
  if (sources.length === 0) return "当前没有配置订阅源。";
  const lines = sources.slice(0, 25).map((source, index) => {
    const enabled = source.enabled && source.url ? "启用" : "停用";
    const name = source.name.trim() || source.id || `订阅源 ${index + 1}`;
    return `${index + 1}. ${name}：${enabled}，UA ${source.fetchUserAgent}`;
  });
  if (sources.length > lines.length) lines.push(`... 还有 ${sources.length - lines.length} 个订阅源未显示`);
  return ["订阅源状态：", ...lines].join("\n");
}

function formatTelegramRecentFetchesMessage(stats: Awaited<ReturnType<typeof readConfigFetchStats>>): string {
  if (stats.recentUserAgents.length === 0) return "还没有订阅配置拉取记录。";
  return [
    "最近配置拉取：",
    ...stats.recentUserAgents.map((record, index) => {
      const location = record.location.label ? `，${record.location.label}` : "";
      return `${index + 1}. ${formatTelegramFetchTargetLabel(record.target)}，${formatTelegramTimestamp(record.fetchedAt)}${location}，UA：${truncateTelegramLine(record.userAgent, 80)}`;
    })
  ].join("\n");
}

function formatTelegramFetchTargetLabel(target: string): string {
  if (target === "surge") return "Surge 配置";
  if (target === "clash") return "Clash 配置";
  return target;
}

function formatTelegramRefreshResultMessage(result: Awaited<ReturnType<typeof refreshSourceCache>>): string {
  const lines = [
    "上游订阅源强制获取完成",
    `刷新成功：${result.refreshed}`,
    `刷新失败：${result.failed}`,
    `沿用旧缓存：${result.cached}`,
    `清理非当前启用源缓存：${result.deleted}`,
    `完成时间：${formatTelegramTimestamp(result.updatedAt)}`,
    "",
    ...formatTelegramSourceCacheLines(result.sourceCache)
  ];
  if (result.failures.length > 0) {
    lines.push("", "失败订阅源：");
    lines.push(...result.failures.slice(0, 10).map((failure) => {
      const cacheStatus = failure.usedCachedContent ? "已沿用旧缓存" : "无可用旧缓存";
      return `- ${failure.sourceName || failure.sourceId || "(未命名订阅源)"}：${failure.reason}；${cacheStatus}`;
    }));
    if (result.failures.length > 10) lines.push(`... 还有 ${result.failures.length - 10} 个失败项未显示`);
  }
  return lines.join("\n").slice(0, 3500);
}

function formatTelegramTimestamp(value: string | null | undefined): string {
  if (!value) return "无";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace(".000Z", "Z");
}

function truncateTelegramLine(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function randomTelegramBindCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

async function storeTelegramBindCode(env: Env, code: string, expiresAt: string): Promise<void> {
  await env.SUBPILOT_CONFIG.put(TELEGRAM_BIND_KEY, JSON.stringify({
    codeHash: await sha256Hex(code),
    expiresAt
  }));
}

async function consumeTelegramBindCode(env: Env, code: string): Promise<boolean> {
  const stored = await env.SUBPILOT_CONFIG.get(TELEGRAM_BIND_KEY, "json") as { codeHash?: unknown; expiresAt?: unknown } | null;
  if (!stored || typeof stored.codeHash !== "string" || typeof stored.expiresAt !== "string") return false;
  if (Date.parse(stored.expiresAt) <= Date.now()) {
    await env.SUBPILOT_CONFIG.delete(TELEGRAM_BIND_KEY);
    return false;
  }
  const ok = await timingSafeEqualString(await sha256Hex(code), stored.codeHash);
  if (ok) await env.SUBPILOT_CONFIG.delete(TELEGRAM_BIND_KEY);
  return ok;
}

async function reconcileTelegramWebhook(
  current: Awaited<ReturnType<typeof loadConfig>>,
  next: Awaited<ReturnType<typeof loadConfig>>,
  requestUrl: string
): Promise<Awaited<ReturnType<typeof loadConfig>>> {
  const currentToken = current.settings.notificationTelegramBotToken.trim();
  const nextToken = next.settings.notificationTelegramBotToken.trim();
  const shouldEnableWebhook = Boolean(nextToken);

  if (!shouldEnableWebhook) {
    if (currentToken && current.settings.notificationTelegramWebhookSecret.trim()) {
      await deleteTelegramWebhook(currentToken);
    }
    return {
      ...next,
      settings: {
        ...next.settings,
        notificationTelegramWebhookSecret: ""
      }
    };
  }

  const currentSecret = next.settings.notificationTelegramWebhookSecret.trim();
  const secret = currentSecret || randomToken(32);
  await setTelegramWebhook(nextToken, telegramWebhookUrl(requestUrl), secret);
  if (currentToken && currentToken !== nextToken) {
    await deleteTelegramWebhook(currentToken).catch((error) => {
      console.warn(JSON.stringify({ level: "warn", message: `Failed to delete previous Telegram webhook: ${error instanceof Error ? error.message : String(error)}` }));
    });
  }
  return {
    ...next,
    settings: {
      ...next.settings,
      notificationTelegramWebhookSecret: secret
    }
  };
}

function telegramWebhookUrl(requestUrl: string): string {
  const url = new URL(requestUrl);
  url.pathname = "/api/telegram/webhook";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function setTelegramWebhook(token: string, url: string, secret: string): Promise<void> {
  const body = new URLSearchParams({
    url,
    secret_token: secret,
    drop_pending_updates: "true",
    allowed_updates: JSON.stringify(["message", "edited_message", "channel_post", "edited_channel_post"])
  });
  const response = await globalThis.fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  await assertTelegramOk(response, "Telegram setWebhook failed");
}

async function deleteTelegramWebhook(token: string): Promise<void> {
  const body = new URLSearchParams({ drop_pending_updates: "true" });
  const response = await globalThis.fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  await assertTelegramOk(response, "Telegram deleteWebhook failed");
}

async function sendTelegramBotMessage(token: string, chatId: string, text: string): Promise<void> {
  if (!token || !chatId) return;
  const response = await globalThis.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true
    })
  });
  await assertTelegramOk(response, "Telegram sendMessage failed");
}

function logTelegramFeedbackFailure(error: unknown): void {
  console.warn(JSON.stringify({ level: "warn", message: `Telegram binding feedback failed: ${error instanceof Error ? error.message : String(error)}` }));
}

function logTelegramCommandFailure(error: unknown): void {
  console.warn(JSON.stringify({ level: "warn", message: `Telegram command handling failed: ${error instanceof Error ? error.message : String(error)}` }));
}

async function assertTelegramOk(response: Response, fallback: string): Promise<void> {
  const result = await response.json<{ ok?: unknown; description?: unknown }>().catch(() => null);
  if (response.ok && result?.ok === true) return;
  const description = typeof result?.description === "string" ? result.description : `HTTP ${response.status}`;
  throw new Error(`${fallback}: ${description}`);
}

function telegramTextMessageCandidate(update: unknown): { chat: unknown; text: string } | null {
  const record = objectRecord(update);
  if (!record) return null;
  for (const key of ["message", "edited_message", "channel_post", "edited_channel_post"]) {
    const message = objectRecord(record[key]);
    if (!message) continue;
    const chat = message.chat;
    const text = [stringProperty(message, "text"), stringProperty(message, "caption")].filter(Boolean).join("\n");
    if (chat !== undefined && text) return { chat, text };
  }
  return null;
}

function telegramBindCode(text: string): string {
  return text.trim().match(/^\/bind(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9_-]{6,32})$/i)?.[1]?.toUpperCase() ?? "";
}

function isTelegramBindAttempt(text: string): boolean {
  return /^\/bind(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text.trim());
}

function telegramBotCommand(text: string): TelegramCommand | null {
  const match = text.trim().match(/^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return {
    name: match[1]!.toLowerCase(),
    args: (match[2] ?? "").trim()
  };
}

function normalizeTelegramChat(value: unknown): TelegramChatOption | null {
  const chat = objectRecord(value);
  if (!chat) return null;
  const idValue = chat.id;
  if (typeof idValue !== "number" && typeof idValue !== "string") return null;
  const id = String(idValue);
  const type = stringProperty(chat, "type") || "unknown";
  const title = stringProperty(chat, "title");
  const username = stringProperty(chat, "username");
  const firstName = stringProperty(chat, "first_name");
  const lastName = stringProperty(chat, "last_name");
  const displayName = title || [firstName, lastName].filter(Boolean).join(" ") || username || id;
  const usernameSuffix = username ? ` @${username}` : "";
  return {
    id,
    type,
    label: `${displayName}${usernameSuffix} (${type}, ${id})`,
    ...(title ? { title } : {}),
    ...(username ? { username } : {}),
    ...(firstName ? { firstName } : {}),
    ...(lastName ? { lastName } : {})
  };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringProperty(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
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
  const target = inferTarget(request);
  if (!target) return unauthorized();
  const result = await generateForRequest(env, request, target);
  ctx.waitUntil(recordConfigFetch(env, result.target, request).catch((error) => {
    console.error(JSON.stringify({ level: "error", message: error instanceof Error ? error.message : String(error) }));
  }));
  return textResponse(result.content, result.contentType, {
    "content-disposition": `inline; filename=${configFileNameForTarget(result.target)}`
  });
}

async function currentManagedBasePath(env: Env, requestUrl: string): Promise<string> {
  const config = withInferredManagedBaseUrl(await loadConfig(env), requestUrl);
  return currentManagedBasePathFromConfig(config, requestUrl);
}

function currentManagedBasePathFromConfig(config: Awaited<ReturnType<typeof loadConfig>>, requestUrl: string): string {
  const inferred = withInferredManagedBaseUrl(config, requestUrl);
  return normalizeManagedBasePath(new URL(inferred.settings.managedBaseUrl).pathname);
}

function buildManagedRequestUrl(config: Awaited<ReturnType<typeof loadConfig>>, requestUrl: string, token: string): string {
  const inferred = withInferredManagedBaseUrl(config, requestUrl);
  const managed = new URL(inferred.settings.managedBaseUrl);
  managed.pathname = `${normalizeManagedBasePath(managed.pathname)}${syncPathForToken(token)}`;
  managed.search = "";
  managed.hash = "";
  return managed.toString();
}

function normalizeManagedBasePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed || "/";
}

function isUnderManagedBasePath(pathname: string, managedBasePath: string): boolean {
  return pathname === managedBasePath || pathname.startsWith(`${managedBasePath}/`);
}

function extractSubscriptionToken(pathname: string, managedBasePath: string): string | null {
  const basePath = managedBasePath.replace(/\/+$/, "") || "/";
  const remainder = basePath === "/"
    ? pathname
    : pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : "";
  return remainder.split("/").filter(Boolean)[0] ?? null;
}

function parseSyncPath(pathname: string, managedBasePath: string): { token: string } | null {
  const base = managedBasePath === "/" ? "" : escapeRegExp(managedBasePath);
  const tokenPattern = "([A-Za-z0-9_-]+)";
  const mainMatch = pathname.match(new RegExp(`^${base}/${tokenPattern}/$`));
  if (mainMatch) return { token: mainMatch[1]! };
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mergeConfigPatch(
  config: Awaited<ReturnType<typeof loadConfig>>,
  patch: Partial<Awaited<ReturnType<typeof loadConfig>>>
): Awaited<ReturnType<typeof loadConfig>> {
  return {
    ...config,
    settings: patch.settings && typeof patch.settings === "object"
      ? { ...config.settings, ...patch.settings }
      : config.settings,
    groups: patch.groups && typeof patch.groups === "object"
      ? patch.groups
      : config.groups,
    disabledGroups: Array.isArray(patch.disabledGroups)
      ? patch.disabledGroups
      : config.disabledGroups,
    sources: Array.isArray(patch.sources) ? patch.sources : config.sources,
    chain: patch.chain && typeof patch.chain === "object"
      ? { ...config.chain, ...patch.chain }
      : config.chain,
    surge: patch.surge && typeof patch.surge === "object"
      ? { ...config.surge, ...patch.surge }
      : config.surge,
    clash: patch.clash && typeof patch.clash === "object"
      ? { ...config.clash, ...patch.clash }
      : config.clash
  };
}

function sanitizeConfigAfterPatch(
  config: Awaited<ReturnType<typeof loadConfig>>,
  patch: Partial<Awaited<ReturnType<typeof loadConfig>>>
): Awaited<ReturnType<typeof loadConfig>> {
  if (!("groups" in patch) && !("disabledGroups" in patch)) return config;
  const rules = sanitizeRuleTargets(config);
  return {
    ...config,
    surge: { ...config.surge, rules: rules.surge },
    clash: { ...config.clash, rules: rules.clash }
  };
}

function sanitizeRuleTargets(config: Awaited<ReturnType<typeof loadConfig>>): { surge: string[]; clash: string[] } {
  const disabledGroups = new Set(config.disabledGroups);
  const availablePolicies = new Set([
    ...Object.keys(config.groups).filter((name) => !disabledGroups.has(name)),
    ...SURGE_BUILT_IN_POLICIES
  ]);
  return {
    surge: rewriteRulesToAvailablePolicies(config.surge.rules, availablePolicies),
    clash: rewriteRulesToAvailablePolicies(config.clash.rules, availablePolicies)
  };
}

function rewriteRulesToAvailablePolicies(rules: string[], availablePolicies: Set<string>): string[] {
  return rules.map((rule) => {
    const parts = rule.split(",");
    const targetIndex = ruleTargetIndex(parts);
    if (targetIndex === null) return rule;
    const target = parts[targetIndex]?.trim() ?? "";
    if (!target || availablePolicies.has(target) || isDevicePolicy(target)) return rule;
    parts[targetIndex] = "Proxy";
    return parts.join(",");
  });
}

function ruleTargetIndex(parts: string[]): number | null {
  const type = parts[0]?.trim().toUpperCase();
  if (!type || type.startsWith("#")) return null;
  if (type === "AND" || type === "OR" || type === "NOT") return null;
  if ((type === "FINAL" || type === "MATCH") && parts.length >= 2) return 1;
  if (parts.length >= 3) return 2;
  return null;
}

function isDevicePolicy(policy: string): boolean {
  return /^DEVICE:[^,\r\n[\]]+$/i.test(policy);
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
