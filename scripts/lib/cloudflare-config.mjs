import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const CONFIG_PATH = "cloudflare.local.json";
export const TEMPLATE_PATH = "cloudflare.example.json";
const LEGACY_PATH = "wrangler.jsonc";

export function readConfig(path = CONFIG_PATH) {
  if (!existsSync(path)) throw new Error(`Missing ${path}. Run npm run setup, or use --mode template for a local example build.`);
  const config = JSON.parse(readFileSync(path, "utf8"));
  if (!config?.worker || typeof config.worker.name !== "string" || !config.worker.name.trim()
    || !config.worker.env || typeof config.worker.env !== "object" || Array.isArray(config.worker.env)) {
    throw new Error(`Invalid ${path}: worker.name and worker.env are required.`);
  }
  if (config.worker.env.ASSETS?.type !== "assets" || config.worker.assets?.runWorkerFirst !== true) {
    throw new Error("ASSETS and assets.runWorkerFirst=true are required to protect the admin UI.");
  }
  if (config.worker.env.SUBPILOT_CONFIG?.type !== "kv") throw new Error("SUBPILOT_CONFIG must be a KV binding.");
  for (const name of ["ADMIN_TOKEN_HASH", "CONFIG_ENCRYPTION_KEY"]) {
    if (config.worker.env[name]?.type !== "secret") throw new Error(`${name} must be a Worker Secret binding.`);
  }
  if (config.worker.env.LOGIN_RATE_LIMITER !== undefined && config.worker.env.LOGIN_RATE_LIMITER?.type !== "rate-limit") {
    throw new Error("LOGIN_RATE_LIMITER must be a rate-limit binding.");
  }
  // cf's API commands and deploy currently resolve account overrides differently.
  if (config.accountId && process.env.CLOUDFLARE_ACCOUNT_ID && config.accountId !== process.env.CLOUDFLARE_ACCOUNT_ID) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID conflicts with the local accountId. Use the same account for setup and deployment.");
  }
  return config;
}

export function writeConfig(config) {
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function ensureConfigFile({ existingConfigOnly = false } = {}) {
  if (existsSync(CONFIG_PATH)) {
    readConfig();
    return false;
  }
  if (existsSync(LEGACY_PATH)) {
    const legacy = JSON.parse(normalizeJsonc(readFileSync(LEGACY_PATH, "utf8")));
    const config = migrateWranglerConfig(legacy);
    writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    process.stdout.write(`Migrated local deployment settings to ${CONFIG_PATH}; original ${LEGACY_PATH} preserved.\n`);
    return false;
  }
  if (existingConfigOnly) throw new Error(`Missing ${CONFIG_PATH} and ${LEGACY_PATH}; existing deployment settings are required.`);
  const config = readConfig(TEMPLATE_PATH);
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  process.stdout.write(`Created ${CONFIG_PATH} from ${TEMPLATE_PATH}.\n`);
  return true;
}

function assertKeys(value, supported, label) {
  const unknown = Object.keys(value ?? {}).filter((key) => !supported.includes(key));
  if (unknown.length) throw new Error(`Cannot automatically migrate ${label} fields: ${unknown.join(", ")}. Configure ${CONFIG_PATH} manually; the original file has not been changed.`);
}

function camelKeys(value) {
  if (Array.isArray(value)) return value.map(camelKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.replace(/_([a-z])/g, (_, char) => char.toUpperCase()), camelKeys(item)]));
}

function migrateWranglerConfig(legacy) {
  assertKeys(legacy, ["$schema", "name", "main", "build", "account_id", "compatibility_date", "compatibility_flags", "workers_dev", "preview_urls", "routes", "secrets", "assets", "kv_namespaces", "ratelimits", "triggers", "observability", "vars", "r2_buckets", "limits", "placement", "logpush"], "Wrangler");
  if (legacy.build && (legacy.build.command !== "npm run build:actions" || Object.keys(legacy.build).length !== 1)) {
    throw new Error("Custom build settings require manual migration to vite.config.ts; original configuration preserved.");
  }
  assertKeys(legacy.assets, ["directory", "binding", "not_found_handling", "html_handling", "run_worker_first"], "assets");
  if (!["./public", "public"].includes(legacy.assets?.directory) || legacy.assets?.binding !== "ASSETS" || legacy.assets?.run_worker_first !== true) {
    throw new Error("Automatic migration requires ./public with ASSETS and run_worker_first=true.");
  }
  assertKeys(legacy.triggers, ["crons"], "triggers");
  assertKeys(legacy.secrets, ["required"], "secrets");
  const env = { ASSETS: { type: "assets" } };
  const bind = (name, value) => {
    if (!name || Object.hasOwn(env, name)) throw new Error("Invalid or duplicate binding in legacy deployment configuration.");
    env[name] = value;
  };
  for (const namespace of legacy.kv_namespaces ?? []) {
    assertKeys(namespace, ["binding", "id", "remote"], "KV binding");
    bind(namespace.binding, { type: "kv", id: namespace.id, ...(namespace.remote !== undefined ? { dev: { remote: namespace.remote } } : {}) });
  }
  for (const bucket of legacy.r2_buckets ?? []) {
    assertKeys(bucket, ["binding", "bucket_name", "jurisdiction", "remote"], "R2 binding");
    bind(bucket.binding, { type: "r2", name: bucket.bucket_name, ...(bucket.jurisdiction ? { jurisdiction: bucket.jurisdiction } : {}), ...(bucket.remote !== undefined ? { dev: { remote: bucket.remote } } : {}) });
  }
  for (const limit of legacy.ratelimits ?? []) {
    assertKeys(limit, ["name", "namespace_id", "simple"], "rate limit");
    bind(limit.name, { type: "rate-limit", namespace: limit.namespace_id, simple: limit.simple });
  }
  for (const name of new Set([...(legacy.secrets?.required ?? []), "ADMIN_TOKEN_HASH", "CONFIG_ENCRYPTION_KEY"])) bind(name, { type: "secret" });
  for (const [name, value] of Object.entries(legacy.vars ?? {})) bind(name, { type: typeof value === "string" ? "text" : "json", value });
  const triggers = (legacy.triggers?.crons ?? []).map((schedule) => ({ type: "scheduled", schedule }));
  const domains = [];
  for (const route of legacy.routes ?? []) {
    if (typeof route === "string") { triggers.push({ type: "fetch", pattern: route }); continue; }
    assertKeys(route, ["pattern", "custom_domain", "zone_id", "zone_name"], "route");
    if (route.custom_domain) domains.push(route.pattern);
    else triggers.push({ type: "fetch", pattern: route.pattern, ...(route.zone_id || route.zone_name ? { zone: route.zone_id || route.zone_name } : {}) });
  }
  const { directory, binding, ...assets } = legacy.assets;
  const worker = {
    name: legacy.name, entrypoint: legacy.main, compatibilityDate: legacy.compatibility_date,
    ...(legacy.compatibility_flags ? { compatibilityFlags: legacy.compatibility_flags } : {}),
    env, assets: camelKeys(assets), triggers,
    ...(domains.length ? { domains } : {})
  };
  for (const key of ["workers_dev", "preview_urls", "observability", "limits", "placement", "logpush"]) {
    if (legacy[key] !== undefined) Object.assign(worker, camelKeys({ [key]: legacy[key] }));
  }
  if (worker.env.SUBPILOT_CONFIG?.type !== "kv") throw new Error("Legacy configuration has no SUBPILOT_CONFIG KV binding.");
  return { ...(legacy.account_id ? { accountId: legacy.account_id } : {}), worker };
}

function normalizeJsonc(content) {
  let withoutComments = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    const next = content[index + 1];
    if (lineComment) {
      if (character === "\n" || character === "\r") {
        lineComment = false;
        withoutComments += character;
      } else {
        withoutComments += " ";
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        withoutComments += "  ";
        blockComment = false;
        index += 1;
      } else {
        withoutComments += character === "\n" || character === "\r" ? character : " ";
      }
      continue;
    }
    if (inString) {
      withoutComments += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      withoutComments += character;
    } else if (character === "/" && next === "/") {
      lineComment = true;
      withoutComments += "  ";
      index += 1;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      withoutComments += "  ";
      index += 1;
    } else {
      withoutComments += character;
    }
  }

  let normalized = "";
  inString = false;
  escaped = false;
  for (let index = 0; index < withoutComments.length; index += 1) {
    const character = withoutComments[index];
    if (inString) {
      normalized += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      normalized += character;
      continue;
    }
    if (character === ",") {
      let nextIndex = index + 1;
      while (/\s/.test(withoutComments[nextIndex] ?? "")) nextIndex += 1;
      if (withoutComments[nextIndex] === "}" || withoutComments[nextIndex] === "]") continue;
    }
    normalized += character;
  }
  return normalized;
}
