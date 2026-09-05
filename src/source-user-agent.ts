import type { RenderConfig, SourceFetchUserAgent } from "./types";

export function fetchUserAgentValue(config: RenderConfig, userAgent: SourceFetchUserAgent): string {
  if (userAgent === "clash") return config.settings.userAgentClash;
  if (userAgent === "stash") return config.settings.userAgentStash;
  if (userAgent === "shadowrocket") return config.settings.userAgentShadowrocket;
  return userAgent === "surge" ? config.settings.userAgentSurge : userAgent || config.settings.userAgentSurge;
}
