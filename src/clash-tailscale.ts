import { isSafeConfigText } from "./config-text-safety";
import { CLASH_BUILT_IN_RULE_POLICIES } from "./rule-targets";
import type { ClashTailscaleNodeConfig } from "./types";

const STRING_FIELDS = ["hostname", "auth-key", "control-url", "state-dir", "exit-node", "dialer-proxy", "interface-name", "ip-version"] as const;
const BOOLEAN_FIELDS = ["ephemeral", "udp", "accept-routes", "exit-node-allow-lan-access"] as const;
const IP_VERSIONS = new Set(["", "dual", "ipv4", "ipv6", "ipv4-prefer", "ipv6-prefer"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!Array.isArray(value) && !isRecord(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const items = Array.isArray(value) ? value : Object.values(value);
  for (const item of items) {
    if (!isJsonValue(item, seen)) return false;
  }
  seen.delete(value);
  return true;
}

function structureError(value: unknown): string | null {
  if (!Array.isArray(value)) return "Clash Tailscale 节点必须为数组";
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) return `Clash Tailscale 第 ${index + 1} 项必须为节点对象`;
    if (!isJsonValue(item)) return `Clash Tailscale 第 ${index + 1} 项只能包含有效的 JSON 值`;
  }
  return null;
}

/** Preserve native fields and explicit false values; only an omitted list defaults. */
export function normalizeClashTailscaleNodes(value: unknown): ClashTailscaleNodeConfig[] {
  if (value === undefined) return [];
  const error = structureError(value);
  if (error) throw new Error(error);
  return structuredClone(value) as ClashTailscaleNodeConfig[];
}

/** Compare lexical directory aliases without assuming the client's working directory. */
function stateDirectoryKey(value: string | undefined): string {
  const path = (value || "tailscale").replaceAll("\\", "/");
  const drive = path.match(/^([a-z]):/i)?.[0].toLowerCase() || "";
  const rest = path.slice(drive.length);
  const absolute = rest.startsWith("/");
  const prefix = drive + (absolute ? !drive && rest.startsWith("//") ? "//" : "/" : "");
  const parts: string[] = [];
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length && parts.at(-1) !== "..") parts.pop();
      else if (!absolute) parts.push(part);
    } else parts.push(part);
  }
  return prefix + parts.join("/") || ".";
}

export function validateClashTailscaleNodes(value: unknown): string | null {
  if (value === undefined) return null;
  const error = structureError(value);
  if (error) return error;
  const names = new Set<string>();
  const directories = new Map<string, number>();
  for (const [index, node] of (value as Record<string, unknown>[]).entries()) {
    const label = `Clash Tailscale 第 ${index + 1} 项`;
    const name = node.name;
    if (typeof name !== "string" || !name.trim() || name !== name.trim() || /[=,\[\]]/.test(name) || !isSafeConfigText(name)) {
      return `${label}名称不能为空、含首尾空格、控制字符或 = , [ ]`;
    }
    if (CLASH_BUILT_IN_RULE_POLICIES.has(name.toUpperCase())) return `${label}名称不能与内置策略重名`;
    if (names.has(name)) return `${label}名称与其他 Tailscale 节点重复`;
    names.add(name);
    if (node.type !== "tailscale") return `${label} type 必须为 tailscale`;
    for (const field of STRING_FIELDS) {
      if (node[field] !== undefined && (typeof node[field] !== "string" || !isSafeConfigText(node[field]))) {
        return `${label} ${field} 必须为不含控制字符的字符串`;
      }
    }
    for (const field of BOOLEAN_FIELDS) {
      if (node[field] !== undefined && typeof node[field] !== "boolean") return `${label} ${field} 必须为布尔值`;
    }
    const mark = node["routing-mark"];
    if (mark !== undefined && (typeof mark !== "number" || !Number.isInteger(mark) || mark < 0 || mark > 0xffffffff)) {
      return `${label} routing-mark 必须为 0 至 4294967295 的整数`;
    }
    const ipVersion = node["ip-version"];
    if (ipVersion !== undefined && !IP_VERSIONS.has(ipVersion as string)) return `${label} ip-version 取值无效`;
    const controlUrl = node["control-url"] as string | undefined;
    if (controlUrl) {
      try {
        const url = new URL(controlUrl);
        if (controlUrl !== controlUrl.trim() || !/^https?:\/\//i.test(controlUrl) || !["http:", "https:"].includes(url.protocol) || !url.hostname) {
          return `${label} control-url 必须为有效的 HTTP 或 HTTPS 地址`;
        }
      } catch {
        return `${label} control-url 必须为有效的 HTTP 或 HTTPS 地址`;
      }
    }
    const directory = stateDirectoryKey(node["state-dir"] as string | undefined);
    const previous = directories.get(directory);
    if (previous !== undefined) return `${label}与第 ${previous + 1} 项使用相同的状态目录，请为各节点设置独立的 state-dir`;
    directories.set(directory, index);
  }
  return null;
}
