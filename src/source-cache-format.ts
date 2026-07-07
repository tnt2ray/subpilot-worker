import type { SourceCacheProtocolCount, SourceCacheStatus } from "./source-cache";
import { formatTimestampInTimeZone } from "./util";

interface SourceCacheStatusLineOptions {
  includeCacheEntryCount?: boolean;
  protocolLinePosition?: "beforeTimestamp" | "afterTimestamp";
}

export function formatSourceCacheStatusLines(
  sourceCache: SourceCacheStatus,
  timeZone: string,
  options: SourceCacheStatusLineOptions = {}
): string[] {
  if (sourceCache.expectedCount <= 0) {
    return [
      `上游缓存：${sourceCache.count} 条缓存，没有启用订阅源`,
      `缓存更新时间：${formatTimestampInTimeZone(sourceCache.updatedAt, timeZone)}`
    ];
  }

  const missing = sourceCache.expectedCount - sourceCache.cachedSourceCount;
  const coverage = missing > 0
    ? `${sourceCache.cachedSourceCount} / ${sourceCache.expectedCount} 个启用源已缓存，缺 ${missing} 个`
    : `${sourceCache.cachedSourceCount} / ${sourceCache.expectedCount} 个启用源已缓存，全部就绪`;
  const cacheEntryLine = options.includeCacheEntryCount ? [`缓存条目：${sourceCache.count} 条`] : [];
  const protocolLine = `协议节点：${formatSourceCacheProtocolCounts(sourceCache)}`;
  const timestampLine = `缓存更新时间：${formatTimestampInTimeZone(sourceCache.updatedAt, timeZone)}`;
  const statusLines = options.protocolLinePosition === "afterTimestamp"
    ? [timestampLine, protocolLine]
    : [protocolLine, timestampLine];

  return [
    `上游缓存：${coverage}`,
    ...cacheEntryLine,
    ...statusLines,
    "订阅源缓存：",
    ...sourceCache.sources.slice(0, 12).map((source) => formatSourceCacheSourceStatus(source, timeZone)),
    ...(sourceCache.sources.length > 12 ? [`... 还有 ${sourceCache.sources.length - 12} 个订阅源未显示`] : [])
  ];
}

function formatSourceCacheProtocolCounts(sourceCache: SourceCacheStatus): string {
  return formatSourceCacheProtocolCountList(sourceCache.totalNodes, sourceCache.protocolCounts, true);
}

function formatSourceCacheProtocolCountList(
  totalNodes: number,
  protocolCounts: SourceCacheProtocolCount[],
  includeTotal: boolean
): string {
  if (totalNodes <= 0 || protocolCounts.length === 0) return "未解析到节点";
  const parts = protocolCounts
    .filter((item) => item.count > 0)
    .map((item) => `${item.protocol} ${item.count}`);
  if (includeTotal) parts.push(`总计 ${totalNodes}`);
  return parts.length > 0 ? parts.join("，") : "未解析到节点";
}

function formatSourceCacheSourceStatus(source: SourceCacheStatus["sources"][number], timeZone: string): string {
  const name = source.sourceName || source.sourceId || "(未命名订阅源)";
  if (!source.cached) return `- ${name}：未缓存`;
  return `- ${name}：已缓存，${source.nodeCount} 个节点；协议 ${formatSourceCacheProtocolCountList(source.nodeCount, source.protocolCounts, false)}；${formatTimestampInTimeZone(source.fetchedAt, timeZone)}`;
}
