import type { AppConfig, SourceFetchUserAgent } from "./types";

export function fetchUserAgentValue(config: AppConfig, userAgent: SourceFetchUserAgent): string {
  if (userAgent === "clash") return config.settings.userAgentClash;
  if (userAgent === "stash") return config.settings.userAgentStash;
  if (userAgent === "shadowrocket") return config.settings.userAgentShadowrocket;
  return config.settings.userAgentSurge;
}
