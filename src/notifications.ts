import type { SourceCacheRefreshResult, SourceCacheStatus } from "./source-cache";
import type { AppConfig } from "./types";
import { getUpdateStatus, readNotifiedUpdateVersion, storeNotifiedUpdateVersion } from "./update-check";
import { formatTimestampInTimeZone } from "./util";

type RefreshTrigger = "manual" | "scheduled";

export interface NotificationDeliveryResult {
  telegram: "disabled" | "sent" | "failed";
  warnings: string[];
}

export async function notifySourceRefreshFailures(
  env: Env,
  config: AppConfig,
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

export async function notifyVersionUpdateAvailable(env: Env, config: AppConfig): Promise<NotificationDeliveryResult> {
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
    ...formatSourceCacheStatusLines(result.sourceCache, timeZone),
    "",
    "失败订阅源：",
    ...formatSourceFailures(result)
  ];
  return lines.join("\n").slice(0, 3500);
}

function formatSourceCacheStatusLines(sourceCache: SourceCacheStatus, timeZone: string): string[] {
  if (sourceCache.expectedCount <= 0) {
    return [
      `上游缓存：${sourceCache.count} 条缓存，没有启用订阅源`,
      `缓存更新时间：${formatNotificationTimestamp(sourceCache.updatedAt, timeZone)}`
    ];
  }
  const missing = sourceCache.expectedCount - sourceCache.cachedSourceCount;
  const coverage = missing > 0
    ? `${sourceCache.cachedSourceCount} / ${sourceCache.expectedCount} 个启用源已缓存，缺 ${missing} 个`
    : `${sourceCache.cachedSourceCount} / ${sourceCache.expectedCount} 个启用源已缓存，全部就绪`;
  return [
    `上游缓存：${coverage}`,
    `协议节点：${formatProtocolCounts(sourceCache)}`,
    `缓存更新时间：${formatNotificationTimestamp(sourceCache.updatedAt, timeZone)}`
  ];
}

function formatProtocolCounts(sourceCache: SourceCacheStatus): string {
  if (sourceCache.totalNodes <= 0 || sourceCache.protocolCounts.length === 0) return "未解析到节点";
  return [
    ...sourceCache.protocolCounts.map((item) => `${item.protocol} ${item.count}`),
    `总计 ${sourceCache.totalNodes}`
  ].join("，");
}

function formatNotificationTimestamp(value: string | null, timeZone: string): string {
  return formatTimestampInTimeZone(value, timeZone);
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
  config: AppConfig,
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
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        disable_web_page_preview: true
      })
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`HTTP ${response.status}`);
    }
    await response.body?.cancel().catch(() => undefined);
    return "sent";
  } catch (error) {
    warnings.push(`Telegram notification failed: ${error instanceof Error ? error.message : String(error)}`);
    return "failed";
  }
}
