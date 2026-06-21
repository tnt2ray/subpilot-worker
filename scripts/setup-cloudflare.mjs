#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const CONFIG_PATH = "wrangler.jsonc";
const TEMPLATE_PATH = "wrangler.example.jsonc";
const PLACEHOLDER_KV_ID = "00000000000000000000000000000000";
const args = new Set(process.argv.slice(2));

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit", ...options });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function capture(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.exit(result.status ?? 1);
  }
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

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

function replaceWorkerName(name) {
  if (!name) return;
  const content = readConfig();
  writeConfig(content.replace(/"name"\s*:\s*"[^"]+"/, `"name": "${name}"`));
}

function replaceKvNamespaceId(id) {
  const content = readConfig();
  if (!content.includes(PLACEHOLDER_KV_ID)) return;
  writeConfig(content.replace(PLACEHOLDER_KV_ID, id));
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

  const outputText = capture("wrangler", ["kv", "namespace", "create", "SUBPILOT_CONFIG"]);
  const namespaceId = extractNamespaceId(outputText);
  if (!namespaceId) {
    process.stderr.write("Could not parse KV namespace id from Wrangler output.\n");
    process.stderr.write(outputText);
    process.exit(1);
  }
  replaceKvNamespaceId(namespaceId);
  process.stdout.write("KV namespace id written to local wrangler.jsonc.\n");
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function randomSecret() {
  return randomBytes(32).toString("base64url");
}

async function readAdminToken() {
  const envToken = process.env.SUBPILOT_ADMIN_TOKEN?.trim();
  if (envToken) return envToken;

  if (!input.isTTY) {
    process.stderr.write("SUBPILOT_ADMIN_TOKEN is required when setup writes secrets in a non-interactive shell.\n");
    process.exit(1);
  }

  const token = await prompt("Enter admin login token: ");
  if (!token) {
    process.stderr.write("Admin login token is required.\n");
    process.exit(1);
  }
  return token;
}

function writeTempSecrets(adminToken, encryptionKey) {
  const directory = mkdtempSync(join(tmpdir(), "subpilot-secrets-"));
  const file = join(directory, "secrets.json");
  writeFileSync(file, JSON.stringify({
    ADMIN_TOKEN_HASH: sha256Hex(adminToken),
    CONFIG_ENCRYPTION_KEY: encryptionKey
  }, null, 2), { mode: 0o600 });
  return { directory, file };
}

function deployWorker() {
  run("wrangler", ["deploy", "--config", CONFIG_PATH]);
}

function putSecrets(adminToken, encryptionKey) {
  const { directory, file } = writeTempSecrets(adminToken, encryptionKey);
  try {
    run("wrangler", ["secret", "bulk", file, "--config", CONFIG_PATH]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

capture("wrangler", ["--version"]);
const createdConfig = ensureConfigFile();
replaceWorkerName(process.env.SUBPILOT_WORKER_NAME);
await ensureKvNamespace();

const shouldWriteSecrets = !args.has("--no-secrets") && (createdConfig || args.has("--force-secrets"));
const adminToken = shouldWriteSecrets ? await readAdminToken() : "";
const encryptionKey = shouldWriteSecrets ? (process.env.SUBPILOT_CONFIG_ENCRYPTION_KEY || randomSecret()) : "";

if (!args.has("--no-deploy")) deployWorker();
if (shouldWriteSecrets) {
  putSecrets(adminToken, encryptionKey);
} else if (!args.has("--no-secrets")) {
  process.stdout.write("Existing wrangler.jsonc detected; skipped secret writes to avoid rotating production secrets.\n");
  process.stdout.write("Pass --force-secrets only when you intentionally want to replace ADMIN_TOKEN_HASH and CONFIG_ENCRYPTION_KEY.\n");
}

process.stdout.write("\nSubPilot setup complete.\n");
if (shouldWriteSecrets) {
  process.stdout.write("The admin token you entered was hashed into ADMIN_TOKEN_HASH.\n");
  process.stdout.write("Store the original admin token in your password manager. It is not written to the repository or KV in plaintext.\n");
}
process.stdout.write("Use the URL printed by Wrangler, or attach a custom domain in Cloudflare and update wrangler.jsonc locally.\n");
