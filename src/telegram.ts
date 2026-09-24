import { ensureActionsCompilation } from "./actions-compiler";
import {
  commitPreparedConfigSave,
  loadConfig,
  prepareConfigSave,
  recoverCommittedPreparedConfigSave,
  saveConfig,
  withInferredManagedBaseUrl
} from "./config-store";
import { readConfigFetchStats } from "./fetch-stats";
import { refreshRuleSetCaches, type RuleSetRefreshResult } from "./rule-set-compiler";
import { allCompiledRuleSetSources, refreshRuleSetSourceCaches } from "./rule-set-cache";
import { configDocument, renderConfig, OUTPUT_TARGETS } from "./config-document";
import { ruleSetEnv } from "./rule-set-scope";
import { refreshSourceCache } from "./source-cache";
import { formatSourceCacheStatusLines } from "./source-cache-format";
import { fetchWithTimeout } from "./upstream-fetch";
import { formatTimestampInTimeZone, badRequest, forbidden, jsonResponse, payloadTooLarge, randomToken, readRequestJsonWithLimit, readResponseTextWithLimit, RequestBodyTooLargeError, sha256Hex, timingSafeEqualString } from "./util";

type LoadedConfig = Awaited<ReturnType<typeof loadConfig>>;

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
const TELEGRAM_RECENT_FETCH_LIMIT = 5;
const MAX_TELEGRAM_BIND_REQUEST_BYTES = 8 * 1024;
const MAX_TELEGRAM_WEBHOOK_REQUEST_BYTES = 256 * 1024;
const MAX_TELEGRAM_RESPONSE_BYTES = 64 * 1024;
const TELEGRAM_REQUEST_TIMEOUT_MS = 8_000;
const WAIT_UNTIL_REFRESH_DEADLINE_MS = 18_000;

export async function handleTelegramBindCode(request: Request, env: Env): Promise<Response> {
  let body: { token?: string };
  try {
    body = await readRequestJsonWithLimit<{ token?: string }>(request, MAX_TELEGRAM_BIND_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return payloadTooLarge("Telegram bind request body is too large");
    body = {};
  }
  const config = await loadConfig(env);
  const token = (typeof body.token === "string" ? body.token.trim() : "") || config.settings.notificationTelegramBotToken.trim();
  if (!token) return badRequest("Telegram bot token is required");

  const saved = await saveConfigWithTelegramWebhook(env, config, {
    ...config,
    settings: {
      ...config.settings,
      notificationChannel: "telegram",
      notificationTelegramBotToken: token
    }
  }, request.url);
  const code = randomTelegramBindCode();
  const expiresAt = new Date(Date.now() + TELEGRAM_BIND_TTL_MS).toISOString();
  await storeTelegramBindCode(env, code, expiresAt, token);
  return jsonResponse({
    code,
    command: `/bind ${code}`,
    expiresAt,
    config: withInferredManagedBaseUrl(saved, request.url)
  });
}

export async function handleTelegramUnbind(request: Request, env: Env): Promise<Response> {
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

export async function handleTelegramWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const config = await loadConfig(env);
  const expectedSecret = config.settings.notificationTelegramWebhookSecret.trim();
  const receivedSecret = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!expectedSecret || !receivedSecret || !await timingSafeEqualString(receivedSecret, expectedSecret)) {
    return forbidden("Invalid Telegram webhook secret");
  }

  let update: unknown;
  try {
    update = await readRequestJsonWithLimit<unknown>(request, MAX_TELEGRAM_WEBHOOK_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return payloadTooLarge("Telegram webhook body is too large");
    update = null;
  }
  const message = telegramTextMessageCandidate(update);
  const code = message ? telegramBindCode(message.text) : "";
  const chat = message ? normalizeTelegramChat(message.chat) : null;
  const command = message ? telegramBotCommand(message.text) : null;
  const boundChatId = config.settings.notificationTelegramChatId.trim();
  if (message && chat && isTelegramBindAttempt(message.text) && boundChatId) {
    return jsonResponse({ ok: true });
  }
  if (message && chat && code && await consumeTelegramBindCode(env, code, config.settings.notificationTelegramBotToken.trim())) {
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
    ctx.waitUntil(handleTelegramCommand(env, ctx, config, chat, command).catch(logTelegramCommandFailure));
  }
  return jsonResponse({ ok: true });
}

export async function saveConfigWithTelegramWebhook(
  env: Env,
  current: LoadedConfig,
  next: LoadedConfig,
  requestUrl: string,
  context?: Pick<ExecutionContext, "waitUntil">
): Promise<LoadedConfig> {
  const currentToken = current.settings.notificationTelegramBotToken.trim();
  const nextToken = next.settings.notificationTelegramBotToken.trim();
  const previousSecret = current.settings.notificationTelegramWebhookSecret.trim();
  const nextSecret = nextToken
    ? next.settings.notificationTelegramWebhookSecret.trim() || randomToken(32)
    : "";
  const previousUrl = telegramWebhookUrlForConfig(current, requestUrl);
  const nextUrl = telegramWebhookUrlForConfig(next, requestUrl);
  const prepared = {
    ...next,
    settings: {
      ...next.settings,
      notificationTelegramChatId: nextToken && nextToken === currentToken
        ? next.settings.notificationTelegramChatId
        : "",
      notificationTelegramWebhookSecret: nextSecret
    }
  };
  const needsSet = Boolean(nextToken) && (
    nextToken !== currentToken
    || nextSecret !== previousSecret
    || nextUrl !== previousUrl
  );
  const needsDeletePrevious = Boolean(currentToken) && (!nextToken || currentToken !== nextToken);

  const staged = await prepareConfigSave(env, prepared);
  if (!needsSet && !needsDeletePrevious) return commitPreparedConfigSave(env, staged, context);

  let commitAttempted = false;
  try {
    if (needsSet) {
      await setTelegramWebhook(nextToken, nextUrl, nextSecret);
    }
    if (needsDeletePrevious) await deleteTelegramWebhook(currentToken);
    commitAttempted = true;
    return await commitPreparedConfigSave(env, staged, context);
  } catch (error) {
    if (commitAttempted) {
      const committed = await recoverCommittedPreparedConfigSave(env, staged).catch((recoveryError) => {
        console.error(JSON.stringify({
          level: "error",
          message: `Failed to verify the Telegram config commit: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`
        }));
        return null;
      });
      if (committed) return committed;
    }
    await compensateTelegramWebhookFailure({
      currentToken,
      nextToken,
      previousSecret,
      previousUrl
    });
    throw error;
  }
}

async function compensateTelegramWebhookFailure(options: {
  currentToken: string;
  nextToken: string;
  previousSecret: string;
  previousUrl: string;
}): Promise<void> {
  const compensations: Array<{ action: string; run: () => Promise<void> }> = [];
  if (options.nextToken && options.nextToken !== options.currentToken) {
    compensations.push({
      action: "delete the replacement webhook",
      run: () => deleteTelegramWebhook(options.nextToken)
    });
  }
  if (options.currentToken) {
    compensations.push({
      action: "restore the previous webhook",
      run: () => setTelegramWebhook(options.currentToken, options.previousUrl, options.previousSecret)
    });
  }
  for (const compensation of compensations) {
    try {
      await compensation.run();
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        message: `Failed to ${compensation.action}: ${error instanceof Error ? error.message : String(error)}`
      }));
    }
  }
}

async function handleTelegramCommand(
  env: Env,
  ctx: ExecutionContext,
  config: LoadedConfig,
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
      await sendTelegramBotMessage(token, chat.id, formatTelegramRecentFetchesMessage(await readConfigFetchStats(env), config.settings.displayTimeZone));
      return;
    case "refresh": {
      const deadline = Date.now() + WAIT_UNTIL_REFRESH_DEADLINE_MS;
      const startMessage = sendTelegramBotMessage(token, chat.id, OUTPUT_TARGETS.some((target) => renderConfig(configDocument(config), target).ruleSets.mode === "compiled")
        ? "开始强制重新拉取上游订阅源；规则集将在后台异步刷新，完成后分别发送结果。"
        : "开始强制重新拉取上游订阅源。完成后会发送结果。").catch(logTelegramCommandFailure);
      scheduleTelegramRuleSetRefresh(env, ctx, config, chat.id, deadline);
      await startMessage;
      await handleTelegramRefreshCommand(env, chat.id, deadline);
      return;
    }
    default:
      await sendTelegramBotMessage(token, chat.id, `未知命令：/${command.name}\n\n${formatTelegramHelpMessage()}`);
  }
}

function scheduleTelegramRuleSetRefresh(
  env: Env,
  ctx: ExecutionContext,
  config: LoadedConfig,
  chatId: string,
  deadline: number
): void {
  const document = configDocument(config);
  const targets = OUTPUT_TARGETS.filter((target) => renderConfig(document, target).ruleSets.mode === "compiled");
  if (!targets.length) return;
  const token = config.settings.notificationTelegramBotToken.trim();
  if (!token) return;
  ctx.waitUntil((async () => {
    try {
      if (config.settings.actionsCompilation?.enabled) {
        try {
          await ensureActionsCompilation(env, config, { force: true, refresh: true, deadline });
          await sendTelegramBotMessage(token, chatId, "已提交 Actions 编译请求；远程产物未就绪的规则由 Worker 处理，请在管理页查看编译进度。");
        } catch {
          await sendTelegramBotMessage(token, chatId, "Actions 请求暂未确认，Worker 将继续处理未就绪的规则，后台会重试 Actions。");
        }
      }
      const sourceRefresh = config.settings.actionsCompilation?.enabled ? undefined
        : await refreshRuleSetSourceCaches(env, config, allCompiledRuleSetSources(config), { deadline, pruneUnexpected: true });
      for (const target of targets) {
        const result = await refreshRuleSetCaches(ruleSetEnv(env, target), renderConfig(document, target), undefined, { deadline, ...(sourceRefresh ? { sourceRefresh } : { skipActionsDispatch: true }) });
        await sendTelegramBotMessage(token, chatId, `${target}\n${formatTelegramRuleSetRefreshResultMessage(result, config.settings.displayTimeZone)}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await sendTelegramBotMessage(token, chatId, `规则集异步刷新失败：${message}`).catch(logTelegramCommandFailure);
    }
  })());
}

async function handleTelegramRefreshCommand(env: Env, chatId: string, deadline: number): Promise<void> {
  const config = await loadConfig(env);
  const token = config.settings.notificationTelegramBotToken.trim();
  if (!token) return;
  try {
    const result = await refreshSourceCache(env, config, { deadline });
    await sendTelegramBotMessage(token, chatId, formatTelegramRefreshResultMessage(result, config.settings.displayTimeZone));
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
    "/refresh - 强制刷新订阅源，并异步刷新统一规则集",
    "/help - 查看命令列表"
  ].join("\n");
}

function formatTelegramStatusMessage(
  config: LoadedConfig,
  stats: Awaited<ReturnType<typeof readConfigFetchStats>>
): string {
  const enabledSources = config.sources.filter((source) => source.enabled && source.url).length;
  const disabledSources = config.sources.filter((source) => !source.enabled || !source.url).length;
  return [
    "SubPilot 状态",
    `订阅源：启用 ${enabledSources} / 停用 ${disabledSources}`,
    ...formatSourceCacheStatusLines(stats.sourceCache, config.settings.displayTimeZone, {
      includeCacheEntryCount: true,
      protocolLinePosition: "afterTimestamp"
    }),
    `最近 Surge 配置获取：${formatTelegramTimestamp(stats.lastFetched.surge, config.settings.displayTimeZone)}`,
    `最近 clash 配置获取：${formatTelegramTimestamp(stats.lastFetched.clash, config.settings.displayTimeZone)}`,
    `最近 sing-box 配置获取：${formatTelegramTimestamp(stats.lastFetched["sing-box"], config.settings.displayTimeZone)}`
  ].join("\n");
}

function formatTelegramSourcesMessage(config: LoadedConfig): string {
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

function formatTelegramRecentFetchesMessage(stats: Awaited<ReturnType<typeof readConfigFetchStats>>, timeZone: string): string {
  if (stats.recentUserAgents.length === 0) return "还没有订阅配置拉取记录。";
  return [
    "最近配置拉取：",
    ...stats.recentUserAgents.slice(0, TELEGRAM_RECENT_FETCH_LIMIT).map((record, index) => {
      const location = record.location.label ? `，${record.location.label}` : "";
      return `${index + 1}. ${formatTelegramFetchTargetLabel(record.target)}，${formatTelegramTimestamp(record.fetchedAt, timeZone)}${location}，UA：${truncateTelegramLine(record.userAgent, 80)}`;
    })
  ].join("\n");
}

function formatTelegramFetchTargetLabel(target: string): string {
  if (target === "surge") return "Surge 配置";
  if (target === "clash") return "Clash 配置";
  if (target === "stash") return "Stash 配置";
  if (target === "shadowrocket") return "Shadowrocket Clash YAML";
  return target;
}

function formatTelegramRefreshResultMessage(result: Awaited<ReturnType<typeof refreshSourceCache>>, timeZone: string): string {
  const lines = [
    "上游订阅源强制获取完成",
    `刷新成功：${result.refreshed}`,
    `刷新失败：${result.failed}`,
    `沿用旧缓存：${result.cached}`,
    `清理非当前启用源缓存：${result.deleted}`,
    `完成时间：${formatTelegramTimestamp(result.updatedAt, timeZone)}`,
    "",
    ...formatSourceCacheStatusLines(result.sourceCache, timeZone, {
      includeCacheEntryCount: true,
      protocolLinePosition: "afterTimestamp"
    })
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

function formatTelegramRuleSetRefreshResultMessage(result: RuleSetRefreshResult, timeZone: string): string {
  const cachedOutputs = result.outputs.filter((output) => output.cached).length;
  const totalRules = result.outputs.reduce((sum, output) => sum + output.ruleCount, 0);
  const lines = [
    "规则集异步刷新完成",
    `刷新成功：${result.refreshed}`,
    `刷新失败：${result.failed}`,
    `沿用旧缓存：${result.cached}`,
    `缓存覆盖：${cachedOutputs} / ${result.outputs.length}`,
    `规则总数：${totalRules}`,
    `完成时间：${formatTelegramTimestamp(result.updatedAt, timeZone)}`
  ];
  if (result.warnings.length > 0) {
    lines.push("", `警告：${result.warnings.length} 条`);
    lines.push(...result.warnings.slice(0, 8).map((warning) => `- ${warning}`));
    if (result.warnings.length > 8) lines.push(`... 还有 ${result.warnings.length - 8} 条警告未显示`);
  }
  return lines.join("\n").slice(0, 3500);
}

function formatTelegramTimestamp(value: string | null | undefined, timeZone: string): string {
  return formatTimestampInTimeZone(value, timeZone);
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

async function storeTelegramBindCode(env: Env, code: string, expiresAt: string, botToken: string): Promise<void> {
  await env.SUBPILOT_CONFIG.put(TELEGRAM_BIND_KEY, JSON.stringify({
    codeHash: await sha256Hex(code),
    botTokenHash: await sha256Hex(botToken),
    expiresAt
  }));
}

async function consumeTelegramBindCode(env: Env, code: string, botToken: string): Promise<boolean> {
  const stored = await env.SUBPILOT_CONFIG.get(TELEGRAM_BIND_KEY, "json") as { codeHash?: unknown; botTokenHash?: unknown; expiresAt?: unknown } | null;
  if (
    !stored
    || typeof stored.codeHash !== "string"
    || typeof stored.expiresAt !== "string"
  ) return false;
  const expiresAt = Date.parse(stored.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    await env.SUBPILOT_CONFIG.delete(TELEGRAM_BIND_KEY);
    return false;
  }
  // Bind codes created before token binding was introduced cannot be proven to
  // belong to the currently configured bot, so invalidate them on first use.
  if (typeof stored.botTokenHash !== "string") {
    await env.SUBPILOT_CONFIG.delete(TELEGRAM_BIND_KEY);
    return false;
  }
  const [codeMatches, tokenMatches] = await Promise.all([
    timingSafeEqualString(await sha256Hex(code), stored.codeHash),
    timingSafeEqualString(await sha256Hex(botToken), stored.botTokenHash)
  ]);
  const ok = codeMatches && tokenMatches;
  if (ok) await env.SUBPILOT_CONFIG.delete(TELEGRAM_BIND_KEY);
  return ok;
}

function telegramWebhookUrl(requestUrl: string): string {
  const url = new URL(requestUrl);
  url.pathname = "/api/telegram/webhook";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function telegramWebhookUrlForConfig(config: LoadedConfig, requestUrl: string): string {
  const configuredBaseUrl = config.settings.managedBaseUrl.trim();
  if (!configuredBaseUrl) return telegramWebhookUrl(requestUrl);
  try {
    return telegramWebhookUrl(new URL(configuredBaseUrl, requestUrl).toString());
  } catch {
    return telegramWebhookUrl(requestUrl);
  }
}

async function setTelegramWebhook(token: string, url: string, secret: string): Promise<void> {
  const body = new URLSearchParams({
    url,
    drop_pending_updates: "true",
    allowed_updates: JSON.stringify(["message", "edited_message", "channel_post", "edited_channel_post"])
  });
  if (secret) body.set("secret_token", secret);
  await requestTelegramApi(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  }, "Telegram setWebhook failed");
}

async function deleteTelegramWebhook(token: string): Promise<void> {
  const body = new URLSearchParams({ drop_pending_updates: "true" });
  await requestTelegramApi(`https://api.telegram.org/bot${token}/deleteWebhook`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  }, "Telegram deleteWebhook failed");
}

async function sendTelegramBotMessage(token: string, chatId: string, text: string): Promise<void> {
  if (!token || !chatId) return;
  await requestTelegramApi(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true
    })
  }, "Telegram sendMessage failed");
}

function logTelegramFeedbackFailure(error: unknown): void {
  console.warn(JSON.stringify({ level: "warn", message: `Telegram binding feedback failed: ${error instanceof Error ? error.message : String(error)}` }));
}

function logTelegramCommandFailure(error: unknown): void {
  console.warn(JSON.stringify({ level: "warn", message: `Telegram command handling failed: ${error instanceof Error ? error.message : String(error)}` }));
}

async function requestTelegramApi(url: string, init: RequestInit, fallback: string): Promise<void> {
  await fetchWithTimeout(globalThis.fetch, url, init, TELEGRAM_REQUEST_TIMEOUT_MS, async (response) => {
    await assertTelegramOk(response, fallback);
  });
}

async function assertTelegramOk(response: Response, fallback: string): Promise<void> {
  const text = await readResponseTextWithLimit(response, MAX_TELEGRAM_RESPONSE_BYTES, "Telegram response");
  let result: { ok?: unknown; description?: unknown } | null = null;
  try {
    result = JSON.parse(text) as { ok?: unknown; description?: unknown };
  } catch {
    result = null;
  }
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
