import type { HostEntry } from "./types";

export function renderSection(name: string, lines: string[]): string {
  return [`[${name}]`, ...lines].join("\n");
}

export function beijingTimestamp(): string {
  return new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai", hour12: false });
}

export function renderHostEntryLine(entry: HostEntry): string {
  return `${entry.host} = ${Array.isArray(entry.value) ? entry.value.join(", ") : entry.value}`;
}

export function dedupeHostEntries(entries: HostEntry[]): HostEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.host}\0${JSON.stringify(entry.value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
