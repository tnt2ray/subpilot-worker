#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { captureCf, runCf, spawnCf } from "./lib/cloudflare-cli.mjs";
import { CONFIG_PATH, ensureConfigFile, readConfig, writeConfig } from "./lib/cloudflare-config.mjs";

const PLACEHOLDER_KV_ID = "00000000000000000000000000000000";
const DEFAULT_SOURCE_REFRESH_HOURS = 12;
const RULE_SET_REFRESH_CRON = "0 16 * * *";
const RULE_SET_REBUILD_CRON = "*/5 * * * *";
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

function replaceWorkerName(name) {
  const workerName = typeof name === "string" ? name.trim() : "";
  if (!workerName) return;
  const config = readConfig();
  config.worker.name = workerName;
  writeConfig(config);
}

function replaceKvNamespaceId(id) {
  const config = readConfig();
  const binding = config.worker.env.SUBPILOT_CONFIG;
  config.worker.env.SUBPILOT_CONFIG = { ...binding, type: "kv", id };
  writeConfig(config);
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

  const config = readConfig();
  const otherTriggers = (config.worker.triggers ?? []).filter((trigger) => trigger.type !== "scheduled");
  config.worker.triggers = [...otherTriggers, ...[refreshCronForHours(hours), RULE_SET_REFRESH_CRON, RULE_SET_REBUILD_CRON]
    .map((schedule) => ({ type: "scheduled", schedule }))];
  writeConfig(config);
  process.stdout.write(`Configured upstream auto-refresh: every ${hours} hour${hours === 1 ? "" : "s"}.\n`);
}

function ensureRuleSetRebuildSchedule() {
  const config = readConfig();
  const triggers = config.worker.triggers ?? [];
  if (triggers.some((trigger) => trigger.type === "scheduled" && trigger.schedule === RULE_SET_REBUILD_CRON)) return;
  config.worker.triggers = [...triggers, { type: "scheduled", schedule: RULE_SET_REBUILD_CRON }];
  writeConfig(config);
  process.stdout.write("Configured pending rule-set rebuilds: every 5 minutes.\n");
}

function ensureLoginRateLimitBinding(createdConfig) {
  const config = readConfig();
  const namespaceId = loginRateLimitNamespaceId(config);
  const existing = config.worker.env[LOGIN_RATE_LIMIT_BINDING_NAME];
  if (existing) {
    const explicitlyConfigured = Boolean(process.env.SUBPILOT_LOGIN_RATE_LIMIT_NAMESPACE_ID);
    if (!createdConfig && !explicitlyConfigured && existing.namespace !== "1001") return;
    config.worker.env[LOGIN_RATE_LIMIT_BINDING_NAME] = { ...existing, namespace: namespaceId };
  } else {
    config.worker.env[LOGIN_RATE_LIMIT_BINDING_NAME] = {
      type: "rate-limit",
      namespace: namespaceId,
      simple: { limit: 10, period: 60 }
    };
  }
  writeConfig(config);
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
  const workerName = config.worker.name;
  const value = createHash("sha256").update(`subpilot:${workerName}:login-rate-limit`).digest().readUInt32BE(0);
  return String(value || 1);
}

async function ensureKvNamespace() {
  const currentId = readConfig().worker.env.SUBPILOT_CONFIG?.id;
  if (currentId && currentId !== PLACEHOLDER_KV_ID) return;

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

  const title = `${readConfig().worker.name}-SUBPILOT_CONFIG`;
  const outputText = captureCf(["kv", "namespaces", "create", "--title", title]);
  let namespaceId;
  try {
    namespaceId = JSON.parse(outputText).id;
  } catch {
    // Never write an unverified namespace ID into the local configuration.
  }
  if (!/^[a-f0-9]{32}$/i.test(namespaceId ?? "")) {
    process.stderr.write("Could not parse the KV namespace id from cf output.\n");
    process.exit(1);
  }
  replaceKvNamespaceId(namespaceId);
  process.stdout.write(`KV namespace id written to local ${CONFIG_PATH}.\n`);
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function randomSecret() {
  return randomBytes(32).toString("base64url");
}

function readRemoteSecretNames() {
  const result = spawnCf(["workers", "secrets", "list", "--worker", readConfig().worker.name]);
  if (result.status !== 0) {
    const message = stripAnsi(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    // A new Worker has no secrets yet. Other failures must not be mistaken for
    // missing secrets: doing so could replace an existing encryption key.
    if (result.status !== null && /\[10007\]/.test(message)) return new Set();
    process.stderr.write("Could not verify existing Worker Secrets. Check cf authentication and the configured Worker and account, then retry. No Secrets were written.\n");
    process.exit(1);
  }
  try {
    const secrets = JSON.parse(result.stdout);
    if (!Array.isArray(secrets) || secrets.some((secret) => !secret || typeof secret.name !== "string")) throw Error("Invalid secret list");
    return new Set(secrets.map((secret) => secret.name));
  } catch {
    process.stderr.write("cf returned an invalid Secrets list. No Secrets were written.\n");
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
  runCf(["deploy"]);
}

function runWithSecrets(command, secrets) {
  const payload = command === "deploy" ? secrets : {
    secrets: Object.fromEntries(Object.entries(secrets).map(([name, text]) => [name, { name, type: "secret_text", text }]))
  };
  const { directory, file } = writeTempSecrets(payload);
  let result;
  try {
    const commandArgs = command === "deploy"
      ? ["deploy", "--secrets-file", file]
      : ["workers", "secrets", "bulk", "--worker", readConfig().worker.name, "--file", file];
    result = spawnCf(commandArgs, { stdio: command === "deploy" ? "inherit" : ["inherit", "ignore", "inherit"] });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

captureCf(["--version"]);
const createdConfig = ensureConfigFile({ existingConfigOnly });
replaceWorkerName(process.env.SUBPILOT_WORKER_NAME);
if (!existingConfigOnly) await ensureKvNamespace();
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
process.stdout.write(`Use the URL printed by cf, or attach a custom domain in Cloudflare and update ${CONFIG_PATH} locally.\n`);
