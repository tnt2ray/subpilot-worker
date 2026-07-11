import YAML from "yaml";
import { isSafeConfigText } from "./config-text-safety";
import { maybeDecodeBase64 } from "./subscription-text";
import type { HostEntry, HostEntryValue } from "./types";

export function parseSurgeHostLines(content: string): string[] {
  return parseSurgeHostEntries(maybeDecodeBase64(content)).map(renderHostEntryLine);
}

export function parseHostEntries(content: string): HostEntry[] {
  const decoded = maybeDecodeBase64(content);
  return dedupeHostEntries([
    ...parseSurgeHostEntries(decoded),
    ...parseClashHostEntries(decoded)
  ]);
}

function parseSurgeHostEntries(content: string): HostEntry[] {
  const lines = content.split(/\r?\n/);
  const entries: HostEntry[] = [];
  let inHost = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^\[host\]$/i.test(line)) {
      inHost = true;
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      inHost = false;
      continue;
    }
    if (inHost && line && !line.startsWith("#") && !line.startsWith(";")) {
      if (!isSafeConfigText(line)) continue;
      const entry = parseHostLine(line);
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

function parseClashHostEntries(content: string): HostEntry[] {
  if (!/^\s*hosts\s*:/m.test(content)) return [];
  try {
    const data = YAML.parse(content) as { hosts?: unknown } | null;
    if (!data?.hosts || typeof data.hosts !== "object" || Array.isArray(data.hosts)) return [];
    return Object.entries(data.hosts as Record<string, unknown>).flatMap(([host, value]) => {
      if (!isSafeConfigText(host) || !isSafeConfigText(value)) return [];
      const normalized = normalizeHostValue(value);
      return host && normalized !== undefined ? [{ host, value: normalized }] : [];
    });
  } catch {
    return [];
  }
}

function parseHostLine(line: string): HostEntry | null {
  const [host, value] = line.split(/=(.*)/s);
  const key = host?.trim();
  const target = value?.trim();
  return key && target ? { host: key, value: target } : null;
}

function normalizeHostValue(value: unknown): HostEntryValue | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const values = value
      .filter((item): item is string | number | boolean => (
        typeof item === "string" || typeof item === "number" || typeof item === "boolean"
      ))
      .map(String);
    return values.length > 0 ? values : undefined;
  }
  return undefined;
}

function renderHostEntryLine(entry: HostEntry): string {
  return `${entry.host} = ${Array.isArray(entry.value) ? entry.value.join(", ") : entry.value}`;
}

function dedupeHostEntries(entries: HostEntry[]): HostEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.host}\0${JSON.stringify(entry.value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
