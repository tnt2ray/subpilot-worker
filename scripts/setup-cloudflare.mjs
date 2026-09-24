#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { capture, run } from "./lib/commands.mjs";

const CONFIG_PATH = "wrangler.jsonc";
const TEMPLATE_PATH = "wrangler.example.jsonc";
const PLACEHOLDER_KV_ID = "00000000000000000000000000000000";
const DEFAULT_SOURCE_REFRESH_HOURS = 12;
const RULE_SET_REFRESH_CRON = "0 16 * * *";
const RULE_SET_REBUILD_CRON = "*/5 * * * *";
const RULE_SET_ARTIFACTS_BINDING_NAME = "RULE_SET_ARTIFACTS";
const PLACEHOLDER_RULE_SET_ARTIFACTS_BUCKET = "subpilot-rule-set-artifacts";
const MIN_ADMIN_TOKEN_LENGTH = 24;
const LOGIN_RATE_LIMIT_BINDING_NAME = "LOGIN_RATE_LIMITER";
const REQUIRED_SECRET_NAMES = ["ADMIN_TOKEN_HASH", "CONFIG_ENCRYPTION_KEY"];
const args = new Set(process.argv.slice(2));
const existingConfigOnly = args.has("--existing-config-only");

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

async function prompt(question, fallback = "") {
  if (!input.isTTY) return fallback;
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(question);
    return answer.trim() || fallback;
  } finally {
    rl.close();
  }
}

function ensureConfigFile() {
  if (!existsSync(CONFIG_PATH)) {
    copyFileSync(TEMPLATE_PATH, CONFIG_PATH);
    process.stdout.write(`Created ${CONFIG_PATH} from ${TEMPLATE_PATH}.\n`);
    return true;
  }
  process.stdout.write(`Using existing local ${CONFIG_PATH}.\n`);
  return false;
}

function readConfig() {
  return readFileSync(CONFIG_PATH, "utf8");
}

function writeConfig(content) {
  writeFileSync(CONFIG_PATH, content);
}

function readJsonConfig() {
  return JSON.parse(normalizeJsonc(readConfig()));
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

function writeJsonConfig(config) {
  writeConfig(`${JSON.stringify(config, null, 2)}\n`);
}

function replaceWorkerName(name) {
  const workerName = typeof name === "string" ? name.trim() : "";
  if (!workerName) return;
  const config = readJsonConfig();
  config.name = workerName;
  writeJsonConfig(config);
}

function replaceKvNamespaceId(id) {
  const content = readConfig();
  if (!content.includes(PLACEHOLDER_KV_ID)) return;
  writeConfig(content.replace(PLACEHOLDER_KV_ID, id));
}

function parseRefreshHours(value) {
  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 24 ? parsed : null;
}

function refreshCronForHours(hours) {
  return hours >= 24 ? "0 0 * * *" : `0 */${hours} * * *`;
}

async function configureSourceRefreshSchedule(createdConfig) {
  const envHours = process.env.SUBPILOT_SOURCE_REFRESH_HOURS;
  let hours = parseRefreshHours(envHours ?? "");

  if (hours === null && createdConfig) {
    const answer = await prompt(
      `Auto-refresh upstream subscriptions every how many hours? [${DEFAULT_SOURCE_REFRESH_HOURS}] `,
      String(DEFAULT_SOURCE_REFRESH_HOURS)
    );
    hours = parseRefreshHours(answer);
    if (hours === null) {
      process.stderr.write("Refresh interval must be an integer from 1 to 24 hours.\n");
      process.exit(1);
    }
  }

  if (hours === null) {
    if (envHours) {
      process.stderr.write("SUBPILOT_SOURCE_REFRESH_HOURS must be an integer from 1 to 24.\n");
      process.exit(1);
    }
    return;
  }

  const config = readJsonConfig();
  config.triggers = { ...(config.triggers ?? {}), crons: [refreshCronForHours(hours), RULE_SET_REFRESH_CRON, RULE_SET_REBUILD_CRON] };
  writeJsonConfig(config);
  process.stdout.write(`Configured upstream auto-refresh: every ${hours} hour${hours === 1 ? "" : "s"}.\n`);
}

function ensureRuleSetRebuildSchedule() {
  const config = readJsonConfig();
  const crons = Array.isArray(config.triggers?.crons) ? config.triggers.crons : [];
  if (crons.includes(RULE_SET_REBUILD_CRON)) return;
  config.triggers = { ...(config.triggers ?? {}), crons: [...crons, RULE_SET_REBUILD_CRON] };
  writeJsonConfig(config);
  process.stdout.write("Configured pending rule-set rebuilds: every 5 minutes.\n");
}

function ensureLoginRateLimitBinding(createdConfig) {
  const config = readJsonConfig();
  const rateLimits = Array.isArray(config.ratelimits) ? config.ratelimits : [];
  const namespaceId = loginRateLimitNamespaceId(config);
  const existingIndex = rateLimits.findIndex((binding) => binding?.name === LOGIN_RATE_LIMIT_BINDING_NAME);
  if (existingIndex >= 0) {
    const existing = rateLimits[existingIndex];
    const explicitlyConfigured = Boolean(process.env.SUBPILOT_LOGIN_RATE_LIMIT_NAMESPACE_ID);
    if (!createdConfig && !explicitlyConfigured && existing?.namespace_id !== "1001") return;
    rateLimits[existingIndex] = { ...existing, namespace_id: namespaceId };
    config.ratelimits = rateLimits;
  } else {
    config.ratelimits = [...rateLimits, {
      name: LOGIN_RATE_LIMIT_BINDING_NAME,
      namespace_id: namespaceId,
      simple: { limit: 10, period: 60 }
    }];
  }
  writeJsonConfig(config);
  process.stdout.write("Configured LOGIN_RATE_LIMITER: 10 attempts per minute per Cloudflare location.\n");
}

function loginRateLimitNamespaceId(config) {
  const override = String(process.env.SUBPILOT_LOGIN_RATE_LIMIT_NAMESPACE_ID ?? "").trim();
  if (override) {
    const parsed = Number(override);
    if (!/^\d+$/.test(override) || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > 4_294_967_295) {
      process.stderr.write("SUBPILOT_LOGIN_RATE_LIMIT_NAMESPACE_ID must be an integer from 1 to 4294967295.\n");
      process.exit(1);
    }
    return override;
  }
  const workerName = typeof config.name === "string" && config.name.trim() ? config.name.trim() : "subpilot-worker";
  const value = createHash("sha256").update(`subpilot:${workerName}:login-rate-limit`).digest().readUInt32BE(0);
  return String(value || 1);
}

function extractNamespaceId(outputText) {
  const clean = stripAnsi(outputText);
  return clean.match(/["']?id["']?\s*[:=]\s*["']([a-f0-9]{32})["']/i)?.[1]
    ?? clean.match(/\bid\b[^a-f0-9]*([a-f0-9]{32})/i)?.[1]
    ?? null;
}

async function ensureKvNamespace() {
  const current = readConfig();
  if (!current.includes(PLACEHOLDER_KV_ID)) return;

  const envNamespaceId = process.env.SUBPILOT_KV_NAMESPACE_ID;
  if (/^[a-f0-9]{32}$/i.test(envNamespaceId ?? "")) {
    replaceKvNamespaceId(envNamespaceId);
    return;
  }

  const answer = await prompt("Create a new Cloudflare KV namespace for SUBPILOT_CONFIG? [Y/n] ", "Y");
  if (/^n/i.test(answer)) {
    const manualId = await prompt("Enter an existing KV namespace id: ");
    if (!/^[a-f0-9]{32}$/i.test(manualId)) {
      process.stderr.write("A 32-character hex KV namespace id is required.\n");
      process.exit(1);
    }
    replaceKvNamespaceId(manualId);
    return;
  }

  const outputText = capture("wrangler", ["kv", "namespace", "create", "SUBPILOT_CONFIG"], { includeStderr: true });
  const namespaceId = extractNamespaceId(outputText);
  if (!namespaceId) {
    process.stderr.write("Could not parse KV namespace id from Wrangler output.\n");
    process.stderr.write(outputText);
    process.exit(1);
  }
  replaceKvNamespaceId(namespaceId);
  process.stdout.write("KV namespace id written to local wrangler.jsonc.\n");
}

function validR2BucketName(value) {
  return typeof value === "string" && value.length >= 3 && value.length <= 63
    && /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(value);
}

function defaultRuleSetBucketName(workerName) {
  const normalized = String(workerName || "subpilot-worker").toLowerCase();
  const stem = normalized.replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/g, "") || "worker";
  const suffix = sha256Hex(`subpilot:${normalized}:rule-set-artifacts`).slice(0, 10);
  return `subpilot-${stem}-${suffix}-artifacts`;
}

function createRuleSetR2Bucket(bucketName) {
  const result = spawnSync("wrangler", ["r2", "bucket", "create", bucketName, "--config", CONFIG_PATH], { encoding: "utf8" });
  if (result.status === 0) return;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (/already exists|already been created|bucket[^\n]*exists/i.test(output)) return;
  process.stderr.write("Could not create the R2 bucket for compiled rule artifacts. Check Wrangler authentication and R2 permissions; no Worker Secrets were changed.\n");
  process.exit(result.status ?? 1);
}

function ensureRuleSetArtifactBucket(createdConfig) {
  const config = readJsonConfig();
  const configured = Array.isArray(config.r2_buckets) ? config.r2_buckets : [];
  const existing = configured.find((binding) => binding?.binding === RULE_SET_ARTIFACTS_BINDING_NAME);
  const requested = String(process.env.SUBPILOT_RULE_SET_ARTIFACTS_BUCKET ?? "").trim();
  const existingBucketName = typeof existing?.bucket_name === "string" ? existing.bucket_name.trim() : "";
  const isTemplatePlaceholder = existingBucketName === PLACEHOLDER_RULE_SET_ARTIFACTS_BUCKET;
  const explicitlyEnabled = args.has("--enable-r2") || Boolean(requested);
  if (!existing && !explicitlyEnabled) return;
  if (isTemplatePlaceholder && !explicitlyEnabled) {
    config.r2_buckets = configured.filter((binding) => binding?.binding !== RULE_SET_ARTIFACTS_BINDING_NAME);
    writeJsonConfig(config);
    process.stdout.write("R2 artifact storage is optional and remains disabled.\n");
    return;
  }
  const bucketName = requested || (createdConfig || !existing || isTemplatePlaceholder
    ? defaultRuleSetBucketName(config.name)
    : existingBucketName);
  if (!validR2BucketName(bucketName)) {
    process.stderr.write("SUBPILOT_RULE_SET_ARTIFACTS_BUCKET must be a 3–63 character lowercase R2 bucket name.\n");
    process.exit(1);
  }
  // Always ensure the selected bucket exists. This also completes setup after
  // an earlier run failed while creating the bucket, without replacing a
  // custom bucket already selected in local wrangler.jsonc.
  createRuleSetR2Bucket(bucketName);
  if (existingBucketName === bucketName) return;
  config.r2_buckets = [
    ...configured.filter((binding) => binding?.binding !== RULE_SET_ARTIFACTS_BINDING_NAME),
    { ...(existing ?? {}), binding: RULE_SET_ARTIFACTS_BINDING_NAME, bucket_name: bucketName }
  ];
  writeJsonConfig(config);
  process.stdout.write("Configured persistent R2 storage for compiled rule artifacts.\n");
}

function ensureWorkerBuildCommand() {
  const config = readJsonConfig();
  const current = config.build?.command;
  if (current !== "npm run build:actions") return;
  config.build = { ...config.build, command: "npm run build:worker" };
  writeJsonConfig(config);
  process.stdout.write("Updated Worker build command to include the sing-box WASI compiler check.\n");
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function randomSecret() {
  return randomBytes(32).toString("base64url");
}

function readRemoteSecretNames() {
  const result = spawnSync("wrangler", ["secret", "list", "--format", "json", "--config", CONFIG_PATH], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    const message = stripAnsi(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    const name = readJsonConfig().name;
    // A new Worker has no secrets yet. Other failures must not be mistaken for
    // missing secrets: doing so could replace an existing encryption key.
    if (result.status !== null && (typeof name === "string" && message.includes(`Worker "${name}" not found.`)
      || /\[code:\s*10007\]/.test(message))) return new Set();
    process.stderr.write("Could not verify existing Worker Secrets. Check Wrangler authentication and the configured Worker, then retry. No Secrets were written.\n");
    process.exit(1);
  }
  try {
    const secrets = JSON.parse(result.stdout);
    if (!Array.isArray(secrets) || secrets.some((secret) => !secret || typeof secret.name !== "string")) throw Error("Invalid secret list");
    return new Set(secrets.map((secret) => secret.name));
  } catch {
    process.stderr.write("Wrangler returned an invalid Secrets list. No Secrets were written.\n");
    process.exit(1);
  }
}

async function readAdminToken() {
  const envToken = process.env.SUBPILOT_ADMIN_TOKEN?.trim();
  if (envToken) return validateAdminToken(envToken);

  if (!input.isTTY) {
    process.stderr.write("SUBPILOT_ADMIN_TOKEN is required when setup writes secrets in a non-interactive shell.\n");
    process.exit(1);
  }

  const token = await prompt("Enter admin login token: ");
  if (!token) {
    process.stderr.write("Admin login token is required.\n");
    process.exit(1);
  }
  return validateAdminToken(token);
}

function validateAdminToken(token) {
  if (token.length < MIN_ADMIN_TOKEN_LENGTH) {
    process.stderr.write(`Admin login token must contain at least ${MIN_ADMIN_TOKEN_LENGTH} characters.\n`);
    process.exit(1);
  }
  return token;
}

function writeTempSecrets(secrets) {
  const directory = mkdtempSync(join(tmpdir(), "subpilot-secrets-"));
  const file = join(directory, "secrets.json");
  writeFileSync(file, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  return { directory, file };
}

function deployWorker() {
  run("wrangler", ["deploy", "--config", CONFIG_PATH]);
}

function runWithSecrets(command, secrets) {
  const { directory, file } = writeTempSecrets(secrets);
  let result;
  try {
    const commandArgs = command === "deploy"
      ? ["deploy", "--secrets-file", file, "--config", CONFIG_PATH]
      : ["secret", "bulk", file, "--config", CONFIG_PATH];
    result = spawnSync("wrangler", commandArgs, { stdio: "inherit" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

capture("wrangler", ["--version"], { includeStderr: true });
if (existingConfigOnly && !existsSync(CONFIG_PATH)) {
  process.stderr.write(`${CONFIG_PATH} is required for --existing-config-only. Run npm run setup first.\n`);
  process.exit(1);
}
const createdConfig = ensureConfigFile();
replaceWorkerName(process.env.SUBPILOT_WORKER_NAME);
if (!existingConfigOnly) await ensureKvNamespace();
ensureRuleSetArtifactBucket(createdConfig);
ensureWorkerBuildCommand();
ensureLoginRateLimitBinding(createdConfig);
await configureSourceRefreshSchedule(createdConfig);
ensureRuleSetRebuildSchedule();

const existingSecrets = args.has("--no-secrets") || args.has("--force-secrets") ? new Set() : readRemoteSecretNames();
const secretNamesToWrite = args.has("--no-secrets") ? [] : REQUIRED_SECRET_NAMES.filter((name) => !existingSecrets.has(name));
const secrets = {};
if (secretNamesToWrite.includes("ADMIN_TOKEN_HASH")) secrets.ADMIN_TOKEN_HASH = sha256Hex(await readAdminToken());
if (secretNamesToWrite.includes("CONFIG_ENCRYPTION_KEY")) secrets.CONFIG_ENCRYPTION_KEY = process.env.SUBPILOT_CONFIG_ENCRYPTION_KEY || randomSecret();

const shouldDeploy = !args.has("--no-deploy") && !existingConfigOnly;
if (secretNamesToWrite.length) {
  runWithSecrets(shouldDeploy ? "deploy" : "bulk", secrets);
} else {
  if (shouldDeploy) deployWorker();
  if (!args.has("--no-secrets")) {
    process.stdout.write("Required Worker Secrets already exist; preserved their values.\n");
    process.stdout.write("Pass --force-secrets only when you intentionally want to replace ADMIN_TOKEN_HASH and CONFIG_ENCRYPTION_KEY.\n");
  }
}

process.stdout.write("\nSubPilot setup complete.\n");
if (secretNamesToWrite.includes("ADMIN_TOKEN_HASH")) {
  process.stdout.write("The admin token you entered was hashed into ADMIN_TOKEN_HASH.\n");
  process.stdout.write("Store the original admin token in your password manager. It is not written to the repository or KV in plaintext.\n");
}
process.stdout.write("Use the URL printed by Wrangler, or attach a custom domain in Cloudflare and update wrangler.jsonc locally.\n");
