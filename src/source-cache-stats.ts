import { parseSubscription } from "./parsers";

export interface SourceCacheProtocolCount {
  protocol: string;
  count: number;
}

export interface SourceCacheContentStats {
  nodeCount: number;
  protocolCounts: SourceCacheProtocolCount[];
}

export function sourceCacheContentStats(content: string, sourceId: string): SourceCacheContentStats {
  const protocols = parseProtocols(content, sourceId);
  return {
    nodeCount: protocols.length,
    protocolCounts: countProtocols(protocols)
  };
}

function parseProtocols(content: string, sourceId: string): string[] {
  try {
    return parseSubscription(content, sourceId).map((node) => normalizeSourceCacheProtocol(node.type));
  } catch {
    return [];
  }
}

function countProtocols(protocols: string[]): SourceCacheProtocolCount[] {
  const counts = new Map<string, number>();
  for (const protocol of protocols) {
    counts.set(protocol, (counts.get(protocol) ?? 0) + 1);
  }
  return sortProtocolCounts(counts);
}

export function normalizeSourceCacheNodeCount(value: unknown, protocolCounts: SourceCacheProtocolCount[]): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  return protocolCounts.reduce((total, item) => total + item.count, 0);
}

export function normalizeSourceCacheProtocolCounts(value: unknown): SourceCacheProtocolCount[] {
  if (!Array.isArray(value)) return [];
  const counts = new Map<string, number>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Partial<SourceCacheProtocolCount>;
    if (typeof record.protocol !== "string") continue;
    if (typeof record.count !== "number" || !Number.isFinite(record.count) || record.count <= 0) continue;
    const protocol = normalizeSourceCacheProtocol(record.protocol);
    counts.set(protocol, (counts.get(protocol) ?? 0) + Math.floor(record.count));
  }
  return sortProtocolCounts(counts);
}

function normalizeSourceCacheProtocol(value: string): string {
  const protocol = value.trim().toLowerCase();
  if (protocol === "hy2") return "hysteria2";
  return protocol || "unknown";
}

function sortProtocolCounts(counts: Map<string, number>): SourceCacheProtocolCount[] {
  return [...counts.entries()]
    .map(([protocol, count]) => ({ protocol, count }))
    .sort((left, right) => right.count - left.count || left.protocol.localeCompare(right.protocol));
}
