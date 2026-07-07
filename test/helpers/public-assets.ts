import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");

export function readPublicFile(name: string): string {
  return readFileSync(join(root, "public", name), "utf8");
}

export function readAdminAppBundle(): string {
  return [
    readPublicFile("app-constants.js"),
    readPublicFile("app-i18n.js"),
    readPublicFile("app-policy-group-spec.js"),
    readPublicFile("app-preview-warnings.js"),
    readPublicFile("app-validation.js"),
    readPublicFile("app-proxy-node-drafts.js"),
    readPublicFile("app-yaml.js"),
    readPublicFile("app.js")
  ].join("\n");
}

export function extractFunctionSource(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`Function ${name} not found`);
  const bodyStart = source.indexOf("{", start);
  if (bodyStart < 0) throw new Error(`Function ${name} body not found`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Function ${name} body is incomplete`);
}
