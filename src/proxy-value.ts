import type { ProxyParamValue } from "./types";

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function isProxyParamValue(value: unknown): value is ProxyParamValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isProxyParamValue);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every(isProxyParamValue);
  }
  return false;
}

export function sanitizeProxyRecord(record: Record<string, unknown>): Record<string, ProxyParamValue> {
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, ProxyParamValue] => isProxyParamValue(entry[1]))
  );
}

export function toPort(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : undefined;
}
