import type { AppConfig } from "./types";

const ENCRYPTED_DNS_PROTOCOLS = new Set(["https:", "h3:", "quic:", "tls:"]);

export function validateSurgeHosts(config: Partial<Pick<AppConfig, "surge">>): string | null {
  const hosts = Array.isArray(config.surge?.hosts) ? config.surge.hosts : [];
  for (const [index, line] of hosts.entries()) {
    const error = validateSurgeHostLine(line, index + 1);
    if (error) return error;
  }
  return null;
}

function validateSurgeHostLine(line: string, lineNumber: number): string | null {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) return null;
  if (/^\[[^\]]+\]$/.test(trimmed)) return `Surge Host 第 ${lineNumber} 行不能包含配置段标题`;

  const separatorIndex = trimmed.indexOf("=");
  if (separatorIndex <= 0 || !trimmed.slice(separatorIndex + 1).trim()) {
    return `Surge Host 第 ${lineNumber} 行语法应为 主机名 = 解析值`;
  }

  const host = trimmed.slice(0, separatorIndex).trim();
  const value = trimmed.slice(separatorIndex + 1).trim();
  if (!isValidHostKey(host)) return `Surge Host 第 ${lineNumber} 行主机名格式无效`;

  const values = value.split(",").map((item) => item.trim());
  if (values.length === 0 || values.some((item) => !item)) return `Surge Host 第 ${lineNumber} 行解析值存在空项`;
  const invalidValue = values.find((item) => !isValidHostValue(item));
  if (invalidValue) return `Surge Host 第 ${lineNumber} 行解析值格式无效：${invalidValue}`;

  return null;
}

function isValidHostKey(value: string): boolean {
  return Boolean(value)
    && !/[\s=,[\]]/.test(value)
    && !value.includes("://");
}

function isValidHostValue(value: string): boolean {
  if (!value || /[\s,[\]]/.test(value)) return false;
  if (!value.startsWith("server:")) return !value.includes("=");

  const server = value.slice("server:".length);
  if (!server) return false;
  if (server === "system") return true;
  if (server.includes("=") || /[\s,[\]]/.test(server)) return false;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(server)) {
    try {
      return ENCRYPTED_DNS_PROTOCOLS.has(new URL(server).protocol);
    } catch {
      return false;
    }
  }

  return true;
}
