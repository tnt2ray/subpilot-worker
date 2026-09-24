import { Validator, type Schema } from "@cfworker/json-schema";
import upstreamSchema from "./vendor/singbox/schema-1.15.0-alpha.7.json";
import type { ConfigDiagnostic } from "./types";

// Keep the upstream schema intact while hiding and rejecting the retired TUN option.
const schema = structuredClone(upstreamSchema);
for (const inbound of schema.$defs.Inbound.oneOf) {
  if (inbound.properties?.type.const === "tun") delete (inbound.properties as { stack?: unknown }).stack;
}

// The upstream schema omits some runtime requirements and reference annotations.
for (const [definition, required] of [["Inbound", ["private_key"]], ["Outbound", ["server_public_key", "server_disco_key"]]] as const) {
  for (const branch of schema.$defs[definition].oneOf) {
    const entry = branch as unknown as { required?: string[]; properties?: Record<string, { const?: string; minLength?: number }> };
    if (entry.properties?.type?.const !== "tailcat") continue;
    entry.required = [...new Set([...(entry.required ?? []), ...required])];
    for (const key of required) entry.properties[key]!.minLength = 1;
  }
}
for (const branch of schema.$defs.Service.oneOf) {
  const entry = branch as unknown as { properties?: Record<string, unknown> };
  if ((entry.properties?.type as { const?: string } | undefined)?.const !== "derp") continue;
  entry.properties!.verify_client_inbound = { anyOf: [
    { type: "string", "x-tag-reference": "inbound" },
    { type: "array", items: { type: "string", "x-tag-reference": "inbound" } }
  ] };
}

// The library annotates schema objects with absolute URIs. All validators sharing
// definitions must use the same base ID so nested references resolve consistently.
const validator = new Validator(schema as Schema, "2020-12", true);
const headlessValidator = new Validator({ $id: schema.$id, $defs: schema.$defs, $ref: "#/$defs/HeadlessRule" } as Schema, "2020-12", false);
const outboundValidator = new Validator({ $id: schema.$id, $defs: schema.$defs, $ref: "#/$defs/Outbound" } as Schema, "2020-12", false);

export { schema as singboxSchema };

type FormSchema = { $ref?: string; type?: string; const?: unknown; enum?: unknown[]; required?: string[]; properties?: Record<string, FormSchema>; items?: FormSchema; additionalProperties?: boolean | FormSchema; oneOf?: FormSchema[]; anyOf?: FormSchema[]; allOf?: FormSchema[]; "x-tag-reference"?: string };
const definitions = schema.$defs as Record<string, FormSchema>;
const resolve = (node: FormSchema): FormSchema => node.$ref ? { ...definitions[node.$ref.split("/").at(-1)!], ...node, $ref: "" } : node;

/** Follow schema annotations, not arbitrary keys inside headers or user maps. */
export function singboxReferences(value: unknown): { kind: string; tag: string; path: string }[] {
  const references = new Map<string, { kind: string; tag: string; path: string }>();
  const accepts = (raw: FormSchema, value: unknown): boolean => {
    const node = resolve(raw);
    if (Object.hasOwn(node, "const") && node.const !== value || node.enum && !node.enum.includes(value)) return false;
    if (node.type && node.type !== (Array.isArray(value) ? "array" : typeof value) && !(node.type === "integer" && Number.isInteger(value))) return false;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (node.required?.some((key) => !Object.hasOwn(record, key))) return false;
      for (const key of ["type", "action", "version"]) if (node.properties?.[key] && Object.hasOwn(record, key) && !accepts(node.properties[key], record[key])) return false;
    }
    if (node.allOf?.some((part) => !accepts(part, value))) return false;
    const alternatives = node.oneOf ?? node.anyOf;
    return !alternatives || alternatives.some((part) => accepts(part, value));
  };
  const walk = (raw: FormSchema, value: unknown, path: string): void => {
    const node = resolve(raw);
    if (node["x-tag-reference"] && typeof value === "string" && value) {
      const kind = node["x-tag-reference"];
      references.set(`${path}:${kind}:${value}`, { kind, tag: value, path });
    }
    for (const part of node.oneOf ?? node.anyOf ?? []) if (accepts(part, value)) walk(part, value, path);
    for (const part of node.allOf ?? []) walk(part, value, path);
    if (Array.isArray(value) && node.items) value.forEach((item, index) => walk(node.items!, item, `${path}.${index}`));
    else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
      const child = node.properties?.[key] ?? (typeof node.additionalProperties === "object" ? node.additionalProperties : undefined);
      if (child) walk(child, item, `${path}.${key}`);
    }
  };
  walk(schema as FormSchema, value, "clients.singbox");
  return [...references.values()];
}

/** Validate a form section without persisting a partial configuration. */
export function validateSingboxSection(section: string, value: unknown): string[] {
  if (!Object.hasOwn(schema.properties, section)) return ["Unknown sing-box section"];
  const property = schema.properties[section as keyof typeof schema.properties];
  const result = new Validator({ $id: schema.$id, $defs: schema.$defs, ...property } as Schema, "2020-12", true).validate(value);
  if (result.valid) {
    return [
      ...(section === "outbounds" && Array.isArray(value)
        ? value.flatMap((item, index) => unsupportedAnyTlsFastOpen(item) ? [`outbounds/${index}/tcp_fast_open: AnyTLS 不支持启用 TCP Fast Open。`] : []) : []),
      ...tailcatDiagnostics({ [section]: value }).map((item) => `${item.path}: ${item.message}`)
    ];
  }
  return [...new Set([...result.errors].reverse().map((error) => `${section}${error.instanceLocation.replace(/^#/, "")}: ${error.keyword}`))].slice(0, 12);
}

export function isValidSingboxHeadlessRule(value: unknown): boolean {
  return headlessValidator.validate(value).valid;
}

function unsupportedAnyTlsFastOpen(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const outbound = value as Record<string, unknown>;
  return outbound.type === "anytls" && outbound.tcp_fast_open === true;
}

export function isValidSingboxOutbound(value: unknown): boolean {
  return outboundValidator.validate(value).valid && !unsupportedAnyTlsFastOpen(value) && tailcatDiagnostics({ outbounds: [value] }).length === 0;
}

export function validateSingboxOutput(value: unknown): ConfigDiagnostic[] {
  const result = validator.validate(value);
  if (result.valid) {
    const outbounds = (value as { outbounds?: unknown[] }).outbounds ?? [];
    return [...tailcatDiagnostics(value), ...outbounds.flatMap((outbound, index): ConfigDiagnostic[] => unsupportedAnyTlsFastOpen(outbound) ? [{
      target: "sing-box", severity: "error", code: "anytls-fast-open", path: `clients.singbox.outbounds.${index}.tcp_fast_open`,
      message: "AnyTLS 不支持启用 TCP Fast Open，请关闭此选项。"
    }] : [])];
  }
  const locations = new Set<string>();
  return [...result.errors].reverse().flatMap((error): ConfigDiagnostic[] => {
    const path = `clients.singbox${error.instanceLocation.replace(/^#/, "").replaceAll("/", ".")}`;
    if (locations.has(path) || locations.size >= 12) return [];
    locations.add(path);
    return [{ target: "sing-box", severity: "error", code: "singbox-schema", path,
      message: `sing-box 1.15.0-alpha.7 字段校验失败（${error.keyword}），请检查此处的原生配置。` }];
  });
}

function tailcatDiagnostics(value: unknown): ConfigDiagnostic[] {
  if (!value || typeof value !== "object") return [];
  const config = value as Record<string, unknown>;
  const result: ConfigDiagnostic[] = [];
  for (const section of ["inbounds", "outbounds"] as const) {
    const entries = config[section];
    if (!Array.isArray(entries)) continue;
    entries.forEach((item: Record<string, unknown>, index) => {
      if (item?.type !== "tailcat") return;
      const add = (field: string, message: string) => result.push({ target: "sing-box", severity: "error", code: "tailcat-options", path: `clients.singbox.${section}.${index}.${field}`, message });
      const servers = Array.isArray(item.derp_servers) ? item.derp_servers.length > 0 : Boolean(item.derp_servers);
      if (servers && (item.derp_map_url || item.derp_region)) add("derp_servers", "自定义 DERP 服务器不能与 DERP 映射地址或区域同时使用。");
      if (Array.isArray(item.users) && item.users.some((user) => !user || typeof user.public_key !== "string" || !user.public_key.trim())) add("users", "Tailcat 用户必须填写客户端公钥。");
    });
  }
  return result;
}
