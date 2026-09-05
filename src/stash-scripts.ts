import type { RenderConfig } from "./types";

export interface ParsedStashScript {
  name: string;
  type: "request" | "response";
  match: string;
  requireBody: boolean;
  maxSize: number;
  url: string;
}

export function validateStashScripts(config: Partial<Pick<RenderConfig, "stash">>): string | null {
  const lines = Array.isArray(config.stash?.scripts) ? config.stash.scripts : [];
  const scriptNames = new Set<string>();
  for (const [index, line] of lines.entries()) {
    const error = validateStashScriptLine(line, index + 1, scriptNames);
    if (error) return error;
  }
  return null;
}

export function parseStashScriptLine(line: string, lineNumber: number, warnings: string[]): ParsedStashScript | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) return null;
  const separatorIndex = trimmed.indexOf("=");
  const name = separatorIndex > 0 ? trimmed.slice(0, separatorIndex).trim() : "";
  const params = separatorIndex > 0 ? parseStashScriptParams(trimmed.slice(separatorIndex + 1)) : {};
  const typeValue = params.type?.toLowerCase() ?? "";
  const type = typeValue === "http-request"
    ? "request"
    : typeValue === "http-response"
      ? "response"
      : null;
  const match = params.pattern ?? "";
  const url = params["script-path"] ?? "";
  const maxSize = Number(params["max-size"] ?? "0");
  if (!name || !type || !match || !isHttpUrl(url) || !Number.isFinite(maxSize) || maxSize < 0) {
    warnings.push(`Stash script line ${lineNumber}: skipped invalid script definition`);
    return null;
  }
  return {
    name,
    type,
    match,
    requireBody: parseStashBoolean(params["requires-body"]),
    maxSize: Math.floor(maxSize),
    url
  };
}

export function parseStashScriptParams(value: string): Record<string, string> {
  const params: Record<string, string> = {};
  const parts: string[] = [];
  for (const rawPart of value.split(",")) {
    const part = rawPart.trim();
    if (!part) continue;
    if (parts.length > 0 && !/^[A-Za-z][\w-]*=/.test(part)) {
      parts[parts.length - 1] = `${parts[parts.length - 1]},${rawPart}`;
      continue;
    }
    parts.push(part);
  }
  for (const part of parts) {
    const [key, raw] = part.split(/=(.*)/s);
    const normalizedKey = key?.trim().toLowerCase();
    const valuePart = raw?.trim();
    if (normalizedKey && valuePart !== undefined) params[normalizedKey] = valuePart;
  }
  return params;
}

function validateStashScriptLine(line: string, lineNumber: number, scriptNames: Set<string>): string | null {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) return null;
  if (/^\[[^\]]+\]$/.test(trimmed)) return `Stash Script 第 ${lineNumber} 行不能包含配置段标题`;

  const separatorIndex = trimmed.indexOf("=");
  if (separatorIndex <= 0 || !trimmed.slice(separatorIndex + 1).trim()) {
    return `Stash Script 第 ${lineNumber} 行脚本语法应为 名称 = 参数`;
  }

  const name = trimmed.slice(0, separatorIndex).trim();
  const params = parseStashScriptParams(trimmed.slice(separatorIndex + 1));
  if (!name) return `Stash Script 第 ${lineNumber} 行缺少脚本名称`;
  if (scriptNames.has(name)) return `Stash Script 第 ${lineNumber} 行脚本名称 ${name} 重复`;
  scriptNames.add(name);

  const type = (params.type || "").toLowerCase();
  if (!["http-request", "http-response"].includes(type)) {
    return `Stash Script 第 ${lineNumber} 行 type 必须是 http-request 或 http-response`;
  }
  if (!params.pattern) return `Stash Script 第 ${lineNumber} 行缺少 pattern`;
  if (!isHttpUrl(params["script-path"] ?? "")) {
    return `Stash Script 第 ${lineNumber} 行 script-path 必须是 http 或 https URL`;
  }
  if (params["max-size"] !== undefined) {
    const maxSize = Number(params["max-size"]);
    if (!Number.isFinite(maxSize) || maxSize < 0) {
      return `Stash Script 第 ${lineNumber} 行 max-size 必须是非负数字`;
    }
  }
  return null;
}

function parseStashBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes"].includes(String(value ?? "").trim().toLowerCase());
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
