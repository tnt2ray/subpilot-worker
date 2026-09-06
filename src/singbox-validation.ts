import { Validator, type Schema } from "@cfworker/json-schema";
import schema from "./vendor/singbox/schema-1.14.0.json";
import type { ConfigDiagnostic } from "./types";

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
  if (result.valid) return [];
  return [...new Set([...result.errors].reverse().map((error) => `${section}${error.instanceLocation.replace(/^#/, "")}: ${error.keyword}`))].slice(0, 12);
}

export function isValidSingboxHeadlessRule(value: unknown): boolean {
  return headlessValidator.validate(value).valid;
}

export function isValidSingboxOutbound(value: unknown): boolean {
  return outboundValidator.validate(value).valid;
}

export function validateSingboxOutput(value: unknown): ConfigDiagnostic[] {
  const result = validator.validate(value);
  if (result.valid) return [];
  const locations = new Set<string>();
  return [...result.errors].reverse().flatMap((error): ConfigDiagnostic[] => {
    const path = `clients.singbox${error.instanceLocation.replace(/^#/, "").replaceAll("/", ".")}`;
    if (locations.has(path) || locations.size >= 12) return [];
    locations.add(path);
    return [{ target: "sing-box", severity: "error", code: "singbox-schema", path,
      message: `sing-box 1.14.0 字段校验失败（${error.keyword}），请检查此处的原生配置。` }];
  });
}
