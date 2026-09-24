const SURGE_DNS_PROTOCOLS = new Set(["https:", "h3:", "quic:", "tls:", "tcp:"]);
const URL_REWRITE_TYPES = new Set(["header", "302", "reject"]);
const MAP_LOCAL_DATA_TYPES = new Set(["file", "text", "tiny-gif", "base64"]);
const STASH_SCRIPT_TYPES = new Set(["http-request", "http-response"]);

export function validateActionsCompilationSettings(value, language = "zh", mode = value?.enabled ? "actions" : "worker") {
  if (mode !== "actions") return null;
  const message = (zh, en) => language === "zh" ? zh : en;
  if (typeof value?.repository !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/.test(value.repository.trim())
    || [".", ".."].includes(value.repository.trim().split("/")[1])) {
    return message("Actions 规则编译的 GitHub 仓库必须填写 owner/repo。", "Enter the GitHub repository for Actions rule compilation as owner/repo.");
  }
  const ref = typeof value.ref === "string" ? value.ref.trim() : "";
  if (!ref || ref.length > 255 || ref === "@" || ref.startsWith("-") || /[\s\u0000-\u001f\u007f~^:?*\[\\]/.test(ref)
    || ref.includes("..") || ref.includes("@{") || ref.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))) {
    return message("Actions 规则编译的 GitHub 分支或标签无效。", "Enter a valid GitHub branch or tag for Actions rule compilation.");
  }
  if (["rules", "refs/heads/rules"].includes(ref)) {
    return message("工作流分支不能使用固定产物分支 rules。", "The workflow branch must differ from the fixed output branch rules.");
  }
  return null;
}

function emptyValidation() {
  return { errors: [], warnings: [] };
}

function validateLines(lines, validateLine) {
  const validation = emptyValidation();
  (lines || []).forEach((line, index) => {
    const result = validateLine(line, index + 1);
    validation.errors.push(...result.errors);
    validation.warnings.push(...result.warnings);
  });
  return validation;
}

export function splitSurgeHostLine(line) {
  const trimmed = String(line || "").trim();
  const separatorIndex = trimmed.indexOf("=");
  if (separatorIndex < 0) return { host: trimmed, value: "" };
  return {
    host: trimmed.slice(0, separatorIndex).trim(),
    value: trimmed.slice(separatorIndex + 1).trim()
  };
}

function isValidSurgeHostName(value) {
  return Boolean(value)
    && !/[\s=,[\]]/.test(value)
    && !value.includes("://");
}

function isValidSurgeHostValue(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || /[\s,[\]]/.test(trimmed)) return false;
  if (!trimmed.startsWith("server:")) return !trimmed.includes("=");

  const server = trimmed.slice("server:".length);
  if (!server) return false;
  if (server === "system") return true;
  if (server.includes("=") || /[\s,[\]]/.test(server)) return false;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(server)) {
    try {
      return SURGE_DNS_PROTOCOLS.has(new URL(server).protocol);
    } catch {
      return false;
    }
  }
  return true;
}

function validateSurgeHostLine(line, lineNumber) {
  const trimmed = String(line || "").trim();
  const result = emptyValidation();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) return result;
  if (/^\[[^\]]+\]$/.test(trimmed)) {
    result.errors.push(`第 ${lineNumber} 行不能包含配置段标题`);
    return result;
  }

  const separatorIndex = trimmed.indexOf("=");
  if (separatorIndex <= 0 || !trimmed.slice(separatorIndex + 1).trim()) {
    result.errors.push(`第 ${lineNumber} 行语法应为 主机名 = 解析值`);
    return result;
  }

  const { host, value } = splitSurgeHostLine(trimmed);
  if (!isValidSurgeHostName(host)) {
    result.errors.push(`第 ${lineNumber} 行主机名格式无效`);
  }
  const values = value.split(",").map((item) => item.trim());
  if (values.some((item) => !item)) {
    result.errors.push(`第 ${lineNumber} 行解析值存在空项`);
  }
  const invalidValue = values.find((item) => item && !isValidSurgeHostValue(item));
  if (invalidValue) {
    result.errors.push(`第 ${lineNumber} 行解析值格式无效：${invalidValue}`);
  }
  return result;
}

export function validateSurgeHostLines(lines) {
  return validateLines(lines, validateSurgeHostLine);
}

export function splitSurgeUrlRewriteLine(line) {
  const parts = String(line || "").trim().split(/\s+/);
  return {
    pattern: parts[0] || "",
    replacement: parts[1] || "",
    type: (parts[2] || "").toLowerCase()
  };
}

function isValidUrlRewriteReplacement(type, replacement) {
  const trimmed = String(replacement || "").trim();
  if (!trimmed) return false;
  if (type === "reject") return true;
  return /^https?:\/\//i.test(trimmed);
}

function validateSurgeUrlRewriteLine(line, lineNumber) {
  const trimmed = String(line || "").trim();
  const result = emptyValidation();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) return result;
  if (/^\[[^\]]+\]$/.test(trimmed)) {
    result.errors.push(`第 ${lineNumber} 行不能包含配置段标题`);
    return result;
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 3) {
    result.errors.push(`第 ${lineNumber} 行语法应为 正则 替换值 类型`);
    return result;
  }

  const { pattern, replacement, type } = splitSurgeUrlRewriteLine(trimmed);
  if (!URL_REWRITE_TYPES.has(type)) {
    result.errors.push(`第 ${lineNumber} 行动作类型必须是 header、302 或 reject`);
  }
  try {
    new RegExp(pattern);
  } catch {
    result.errors.push(`第 ${lineNumber} 行正则表达式无效`);
  }
  if (!isValidUrlRewriteReplacement(type, replacement)) {
    result.errors.push(`第 ${lineNumber} 行 ${type || "该"} 动作需要有效替换 URL`);
  }
  return result;
}

export function validateSurgeUrlRewriteLines(lines) {
  return validateLines(lines, validateSurgeUrlRewriteLine);
}

export function splitSurgeMapLocalLine(line) {
  const trimmed = String(line || "").trim();
  const separator = trimmed.search(/\s/);
  if (separator <= 0) return null;
  const pattern = trimmed.slice(0, separator);
  const rest = trimmed.slice(separator).trim();
  const options = {};
  const optionPattern = /([A-Za-z][\w-]*)=(?:"((?:\\.|[^"])*)"|(\S+))/gy;
  let cursor = 0;
  while (cursor < rest.length) {
    optionPattern.lastIndex = cursor;
    const match = optionPattern.exec(rest);
    if (!match || match.index !== cursor) return null;
    const key = String(match[1] || "").toLowerCase();
    if (key in options) return null;
    const rawValue = match[2] !== undefined ? unescapeMapLocalValue(match[2]) : (match[3] || "");
    options[key] = rawValue;
    cursor = optionPattern.lastIndex;
    while (cursor < rest.length && /\s/.test(rest[cursor] || "")) cursor += 1;
  }
  return Object.keys(options).length > 0 ? { pattern, options } : null;
}

function unescapeMapLocalValue(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value;
  }
}

function validateSurgeMapLocalLine(line, lineNumber) {
  const trimmed = String(line || "").trim();
  const result = emptyValidation();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) return result;
  if (/^\[[^\]]+\]$/.test(trimmed)) {
    result.errors.push(`第 ${lineNumber} 行不能包含配置段标题`);
    return result;
  }
  const parsed = splitSurgeMapLocalLine(trimmed);
  if (!parsed) {
    result.errors.push(`第 ${lineNumber} 行语法无效`);
    return result;
  }
  try {
    new RegExp(parsed.pattern);
  } catch {
    result.errors.push(`第 ${lineNumber} 行正则表达式无效`);
  }
  const dataType = parsed.options["data-type"] || "";
  if (!MAP_LOCAL_DATA_TYPES.has(dataType)) {
    result.errors.push(`第 ${lineNumber} 行 data-type 必须是 file、text、tiny-gif 或 base64`);
  }
  if (dataType !== "tiny-gif" && !Object.hasOwn(parsed.options, "data")) {
    result.errors.push(`第 ${lineNumber} 行缺少 data 参数`);
  }
  const statusCode = parsed.options["status-code"];
  if (statusCode !== undefined && (!/^\d{3}$/.test(statusCode) || Number(statusCode) < 100 || Number(statusCode) > 599)) {
    result.errors.push(`第 ${lineNumber} 行 status-code 必须是 100 到 599`);
  }
  const allowed = new Set(["data-type", "data", "status-code", "header"]);
  const unknown = Object.keys(parsed.options).find((key) => !allowed.has(key));
  if (unknown) result.errors.push(`第 ${lineNumber} 行包含未知参数 ${unknown}`);
  return result;
}

export function validateSurgeMapLocalLines(lines) {
  return validateLines(lines, validateSurgeMapLocalLine);
}

export function parseStashScriptParams(value) {
  const params = {};
  const parts = [];
  for (const rawPart of String(value || "").split(",")) {
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

function isHttpScriptUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function validateStashScriptLine(line, lineNumber, scriptNames) {
  const trimmed = String(line || "").trim();
  const result = emptyValidation();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) return result;
  if (/^\[[^\]]+\]$/.test(trimmed)) {
    result.errors.push(`第 ${lineNumber} 行不能包含配置段标题`);
    return result;
  }

  const separatorIndex = trimmed.indexOf("=");
  if (separatorIndex <= 0 || !trimmed.slice(separatorIndex + 1).trim()) {
    result.errors.push(`第 ${lineNumber} 行脚本语法应为 名称 = 参数`);
    return result;
  }

  const name = trimmed.slice(0, separatorIndex).trim();
  const params = parseStashScriptParams(trimmed.slice(separatorIndex + 1));
  if (!name) {
    result.errors.push(`第 ${lineNumber} 行缺少脚本名称`);
  } else if (scriptNames.has(name)) {
    result.errors.push(`第 ${lineNumber} 行脚本名称 ${name} 重复`);
  } else {
    scriptNames.add(name);
  }

  const type = (params.type || "").toLowerCase();
  if (!STASH_SCRIPT_TYPES.has(type)) {
    result.errors.push(`第 ${lineNumber} 行 type 必须是 http-request 或 http-response`);
  }
  if (!params.pattern) {
    result.errors.push(`第 ${lineNumber} 行缺少 pattern`);
  }
  if (!isHttpScriptUrl(params["script-path"])) {
    result.errors.push(`第 ${lineNumber} 行 script-path 必须是 http 或 https URL`);
  }
  if (params["max-size"] !== undefined) {
    const maxSize = Number(params["max-size"]);
    if (!Number.isFinite(maxSize) || maxSize < 0) {
      result.errors.push(`第 ${lineNumber} 行 max-size 必须是非负数字`);
    }
  }
  return result;
}

export function validateStashScriptLines(lines) {
  const validation = emptyValidation();
  const scriptNames = new Set();
  (lines || []).forEach((line, index) => {
    const result = validateStashScriptLine(line, index + 1, scriptNames);
    validation.errors.push(...result.errors);
    validation.warnings.push(...result.warnings);
  });
  return validation;
}
