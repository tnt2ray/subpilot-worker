import { formatSourceCacheStatusLines } from "./source-cache-format";
import type { RuleSetRefreshResult } from "./rule-set-compiler";
import type { SourceCacheRefreshResult } from "./source-cache";
import type { RenderConfig } from "./types";
import { getUpdateStatus, readNotifiedUpdateVersion, storeNotifiedUpdateVersion } from "./update-check";
import { fetchWithTimeout } from "./upstream-fetch";

type RefreshTrigger = "config" | "manual" | "scheduled";
const TELEGRAM_NOTIFICATION_TIMEOUT_MS = 8_000;

export interface NotificationDeliveryResult {
  telegram: "disabled" | "sent" | "failed";
  warnings: string[];
}

export async function notifySourceRefreshFailures(
  env: Env,
  config: RenderConfig,
  result: SourceCacheRefreshResult,
  trigger: RefreshTrigger
): Promise<NotificationDeliveryResult> {
  const delivery: NotificationDeliveryResult = { telegram: "disabled", warnings: [] };
  if (result.failed <= 0) return delivery;

  const message = formatSourceRefreshFailureMessage(result, trigger, config.settings.displayTimeZone);
  console.warn(JSON.stringify({
    level: "warn",
    message: "Upstream source refresh completed with failures",
    trigger,
    refreshed: result.refreshed,
    failed: result.failed,
    cached: result.cached,
    warnings: result.warnings
  }));

  if (config.settings.notificationChannel === "telegram") {
    delivery.telegram = await sendTelegramNotification(env, config, message, delivery.warnings);
  }

  return delivery;
}

export async function notifyRuleSetRefreshFailures(
  env: Env,
  config: RenderConfig,
  result: RuleSetRefreshResult,
  trigger: RefreshTrigger
): Promise<NotificationDeliveryResult> {
  const delivery: NotificationDeliveryResult = { telegram: "disabled", warnings: [] };
  if (result.failed <= 0 && result.failures.length === 0) return delivery;

  const message = formatRuleSetRefreshFailureMessage(result, trigger);
  console.warn(JSON.stringify({
    level: "warn",
    message: "Rule set refresh completed with failures",
    trigger,
    refreshed: result.refreshed,
    failed: result.failed,
    cached: result.cached,
    failures: result.failures,
    warnings: result.warnings
  }));

  if (config.settings.notificationChannel === "telegram") {
    delivery.telegram = await sendTelegramNotification(env, config, message, delivery.warnings);
  }

  return delivery;
}

export async function notifyVersionUpdateAvailable(env: Env, config: RenderConfig): Promise<NotificationDeliveryResult> {
  const delivery: NotificationDeliveryResult = { telegram: "disabled", warnings: [] };
  if (!config.settings.updateCheckEnabled) return delivery;

  const status = await getUpdateStatus(env);
  if (!status.updateAvailable || !status.latestVersion) return delivery;
  if (await readNotifiedUpdateVersion(env) === status.latestVersion) return delivery;

  const message = [
    "SubPilot 有新版本可更新",
    `当前版本：${status.currentVersion}`,
    `最新版本：${status.latestVersion}`,
    status.releaseUrl ? `发布页面：${status.releaseUrl}` : "",
    "",
    "建议先阅读 release notes，再按 README 的更新步骤重新部署。"
  ].filter(Boolean).join("\n");

  if (config.settings.notificationChannel === "telegram") {
    delivery.telegram = await sendTelegramNotification(env, config, message, delivery.warnings);
    if (delivery.telegram === "sent") await storeNotifiedUpdateVersion(env, status.latestVersion);
  }

  return delivery;
}

function formatSourceRefreshFailureMessage(result: SourceCacheRefreshResult, trigger: RefreshTrigger, timeZone: string): string {
  const lines = [
    "SubPilot 上游订阅刷新存在失败",
    `触发方式：${trigger === "scheduled" ? "定时任务" : "手动强制获取"}`,
    `刷新成功：${result.refreshed}`,
    `刷新失败：${result.failed}`,
    `沿用旧缓存：${result.cached}`,
    "失败订阅源：",
    ...formatSourceFailures(result),
    "",
    ...formatSourceCacheStatusLines(result.sourceCache, timeZone)
  ];
  return lines.join("\n").slice(0, 3500);
}

function formatRuleSetRefreshFailureMessage(result: RuleSetRefreshResult, trigger: RefreshTrigger): string {
  const lines = [
    "SubPilot 上游规则集刷新存在失败",
    `触发方式：${refreshTriggerLabel(trigger)}`,
    `输出编译成功：${result.refreshed}`,
    `输出编译失败：${result.failed}`,
    `沿用旧编译缓存：${result.cached}`,
    "失败规则来源：",
    ...formatRuleSetSourceFailures(result),
    ...formatRuleSetOtherErrors(result)
  ];
  return lines.join("\n").slice(0, 3500);
}

function formatRuleSetSourceFailures(result: RuleSetRefreshResult): string[] {
  if (result.failures.length === 0) return ["- 无结构化来源错误"];
  return result.failures.map((failure) => {
    const name = failure.sourceName || "(未命名规则来源)";
    const cacheStatus = failure.usedCachedContent ? "已沿用旧缓存" : "无可用旧缓存";
    return `- 名称：${name}；ID：${failure.sourceId}；原因：${failure.reason}；处理：${cacheStatus}`;
  });
}

function formatRuleSetOtherErrors(result: RuleSetRefreshResult): string[] {
  if (result.failed <= 0 || result.warnings.length === 0) return [];
  const sourceWarnings = new Set(result.failures.map((failure) => `${failure.sourceName}: ${failure.reason}`));
  const otherWarnings = result.warnings.filter((warning) => !sourceWarnings.has(warning));
  return otherWarnings.length > 0 ? ["", "其他错误：", ...otherWarnings.map((warning) => `- ${warning}`)] : [];
}

function refreshTriggerLabel(trigger: RefreshTrigger): string {
  if (trigger === "scheduled") return "定时任务";
  if (trigger === "config") return "配置变更";
  return "手动刷新";
}

function formatSourceFailures(result: SourceCacheRefreshResult): string[] {
  if (result.failures.length === 0) return result.warnings.map((warning) => `- ${warning}`);
  return result.failures.map((failure) => {
    const name = failure.sourceName || "(未命名订阅源)";
    const cacheStatus = failure.usedCachedContent ? "已沿用旧缓存" : "无可用旧缓存";
    return `- 名称：${name}；ID：${failure.sourceId}；原因：${failure.reason}；处理：${cacheStatus}`;
  });
}

async function sendTelegramNotification(
  env: Env,
  config: RenderConfig,
  message: string,
  warnings: string[]
): Promise<NotificationDeliveryResult["telegram"]> {
  const chatId = config.settings.notificationTelegramChatId.trim();
  const token = config.settings.notificationTelegramBotToken.trim();
  if (!chatId || !token) {
    warnings.push("Telegram notification is enabled but chat id or bot token is missing");
    return "failed";
  }

  try {
    await fetchWithTimeout(globalThis.fetch, `https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        disable_web_page_preview: true
      })
    }, TELEGRAM_NOTIFICATION_TIMEOUT_MS, async (response) => {
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    });
    return "sent";
  } catch (error) {
    warnings.push(`Telegram notification failed: ${error instanceof Error ? error.message : String(error)}`);
    return "failed";
  }
}
