import type { AppConfig } from "./types";

const URL_REWRITE_TYPES = new Set(["header", "302", "reject"]);

export function validateSurgeUrlRewrite(config: Partial<Pick<AppConfig, "surge">>): string | null {
  const lines = Array.isArray(config.surge?.urlRewrite) ? config.surge.urlRewrite : [];
  for (const [index, line] of lines.entries()) {
    const error = validateSurgeUrlRewriteLine(line, index + 1);
    if (error) return error;
  }
  return null;
}

export function inferUrlRewriteMitmHostnames(lines: string[]): string[] {
  const output: string[] = [];
  for (const line of lines) {
    const parsed = parseSurgeUrlRewriteLine(line);
    if (!parsed) continue;
    if (!patternMayMatchHttps(parsed.pattern)) continue;
    output.push(...hostnamesFromUrlPattern(parsed.pattern));
  }
  return [...new Set(output)];
}

function validateSurgeUrlRewriteLine(line: string, lineNumber: number): string | null {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) return null;
  if (/^\[[^\]]+\]$/.test(trimmed)) return `Surge URL Rewrite 第 ${lineNumber} 行不能包含配置段标题`;

  const parsed = parseSurgeUrlRewriteLine(trimmed);
  if (!parsed) return `Surge URL Rewrite 第 ${lineNumber} 行语法应为 正则 替换值 类型`;
  if (!URL_REWRITE_TYPES.has(parsed.type)) return `Surge URL Rewrite 第 ${lineNumber} 行动作类型必须是 header、302 或 reject`;

  try {
    new RegExp(parsed.pattern);
  } catch {
    return `Surge URL Rewrite 第 ${lineNumber} 行正则表达式无效`;
  }

  if (parsed.type !== "reject" && !isValidReplacement(parsed.replacement)) {
    return `Surge URL Rewrite 第 ${lineNumber} 行 ${parsed.type} 动作需要有效替换 URL`;
  }

  return null;
}

function parseSurgeUrlRewriteLine(line: string): { pattern: string; replacement: string; type: string } | null {
  const parts = String(line || "").trim().split(/\s+/);
  if (parts.length !== 3) return null;
  const [pattern, replacement, rawType] = parts;
  const type = rawType?.toLowerCase() ?? "";
  if (!pattern || !replacement || !type) return null;
  return { pattern, replacement, type };
}

function isValidReplacement(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "-" || trimmed === "_") return false;
  return /^https?:\/\//i.test(trimmed);
}

function patternMayMatchHttps(pattern: string): boolean {
  return /^(\^)?https(\?:)?[:\\]/i.test(pattern) || /^(\^)?https\??:/i.test(pattern);
}

function hostnamesFromUrlPattern(pattern: string): string[] {
  const hostPattern = extractHostPattern(pattern);
  if (!hostPattern) return [];
  return expandHostPattern(hostPattern)
    .map((host) => host.replace(/\\\./g, ".").replace(/\.\*/g, ".*"))
    .map((host) => host.replace(/^\.\+\\\./, "*.").replace(/^\.\+?\./, "*."))
    .map((host) => host.replace(/^\.\*\./, "*."))
    .map((host) => host.replace(/\\-/g, "-"))
    .filter(isSafeMitmHostname);
}

function extractHostPattern(pattern: string): string {
  const match = pattern.match(/^(\^)?https\??:\\?\/\\?\/(.+)$/i);
  if (!match) return "";
  const rest = match[2] ?? "";
  let host = "";
  let escaped = false;
  let depth = 0;
  for (const char of rest) {
    if (escaped) {
      if (char === "/" && depth === 0) break;
      host += `\\${char}`;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "/" && depth === 0) break;
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    host += char;
  }
  return host;
}

function expandHostPattern(pattern: string): string[] {
  const wildcardNormalized = pattern
    .replace(/^\.\+\\\./, "*.")
    .replace(/^\.\+\?\\\./, "*.")
    .replace(/^\.\+?\./, "*.");
  return expandAlternatives(wildcardNormalized)
    .flatMap(expandOptionalPrefix)
    .map((item) => item.replace(/\\\./g, "."))
    .map((item) => item.replace(/\./g, "."))
    .map((item) => item.replace(/^\*\.\?/, "*."))
    .map((item) => item.replace(/\?/g, ""))
    .map((item) => item.trim())
    .filter(Boolean);
}

function expandAlternatives(value: string): string[] {
  const match = value.match(/^(.*)\(([^()|]+(?:\|[^()|]+)+)\)(.*)$/);
  if (!match) return [value];
  const prefix = match[1] ?? "";
  const suffix = match[3] ?? "";
  return (match[2] ?? "").split("|").flatMap((part) => expandAlternatives(`${prefix}${part}${suffix}`));
}

function expandOptionalPrefix(value: string): string[] {
  const match = value.match(/^(.*)\(([^()]+)\)\?(.*)$/);
  if (!match) return [value];
  const prefix = match[1] ?? "";
  const optional = match[2] ?? "";
  const suffix = match[3] ?? "";
  return [`${prefix}${suffix}`, `${prefix}${optional}${suffix}`];
}

function isSafeMitmHostname(value: string): boolean {
  if (!value || value.includes("(") || value.includes(")") || value.includes("|") || value.includes("+")) return false;
  if (value.includes("[") || value.includes("]") || value.includes("^") || value.includes("$")) return false;
  return /^(\*\.)?[A-Za-z0-9._-]+$/.test(value) && value.includes(".");
}
