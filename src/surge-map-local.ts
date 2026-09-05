import type { RenderConfig } from "./types";

const DATA_TYPES = new Set(["file", "text", "tiny-gif", "base64"]);
const OPTION_PATTERN = /([A-Za-z][\w-]*)=(?:"((?:\\.|[^"])*)"|(\S+))/gy;

export function validateSurgeMapLocal(config: Partial<Pick<RenderConfig, "surge">>): string | null {
  const lines = Array.isArray(config.surge?.mapLocal) ? config.surge.mapLocal : [];
  for (const [index, line] of lines.entries()) {
    const error = validateSurgeMapLocalLine(line, index + 1);
    if (error) return error;
  }
  return null;
}

function validateSurgeMapLocalLine(line: string, lineNumber: number): string | null {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) return null;
  if (/^\[[^\]]+\]$/.test(trimmed)) return `Surge Map Local 第 ${lineNumber} 行不能包含配置段标题`;

  const parsed = parseSurgeMapLocalLine(trimmed);
  if (!parsed) return `Surge Map Local 第 ${lineNumber} 行语法无效`;
  try {
    new RegExp(parsed.pattern);
  } catch {
    return `Surge Map Local 第 ${lineNumber} 行正则表达式无效`;
  }

  const dataType = parsed.options.get("data-type") ?? "";
  if (!DATA_TYPES.has(dataType)) return `Surge Map Local 第 ${lineNumber} 行 data-type 必须是 file、text、tiny-gif 或 base64`;
  if (dataType !== "tiny-gif" && !parsed.options.has("data")) {
    return `Surge Map Local 第 ${lineNumber} 行缺少 data 参数`;
  }
  const statusCode = parsed.options.get("status-code");
  if (statusCode !== undefined && (!/^\d{3}$/.test(statusCode) || Number(statusCode) < 100 || Number(statusCode) > 599)) {
    return `Surge Map Local 第 ${lineNumber} 行 status-code 必须是 100 到 599`;
  }
  const allowed = new Set(["data-type", "data", "status-code", "header"]);
  const unknown = [...parsed.options.keys()].find((key) => !allowed.has(key));
  if (unknown) return `Surge Map Local 第 ${lineNumber} 行包含未知参数 ${unknown}`;
  return null;
}

function parseSurgeMapLocalLine(line: string): { pattern: string; options: Map<string, string> } | null {
  const separator = line.search(/\s/);
  if (separator <= 0) return null;
  const pattern = line.slice(0, separator);
  const rest = line.slice(separator).trim();
  const options = new Map<string, string>();
  let cursor = 0;
  while (cursor < rest.length) {
    OPTION_PATTERN.lastIndex = cursor;
    const match = OPTION_PATTERN.exec(rest);
    if (!match || match.index !== cursor) return null;
    const key = (match[1] ?? "").toLowerCase();
    if (options.has(key)) return null;
    const rawValue = match[2] !== undefined ? unescapeQuotedValue(match[2]) : (match[3] ?? "");
    options.set(key, rawValue);
    cursor = OPTION_PATTERN.lastIndex;
    while (cursor < rest.length && /\s/.test(rest[cursor] ?? "")) cursor += 1;
  }
  return options.size > 0 ? { pattern, options } : null;
}

function unescapeQuotedValue(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value;
  }
}
