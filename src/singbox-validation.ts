import { Validator, type Schema } from "@cfworker/json-schema";
import schema from "./vendor/singbox/schema-1.14.0.json";
import type { ConfigDiagnostic } from "./types";

// Immutable schema only; the validator allocates validation results per invocation.
const validator = new Validator(schema as Schema, "2020-12", true);
const headlessValidator = new Validator({ $defs: schema.$defs, $ref: "#/$defs/HeadlessRule" } as Schema, "2020-12", false);
const outboundValidator = new Validator({ $defs: schema.$defs, $ref: "#/$defs/Outbound" } as Schema, "2020-12", false);

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
