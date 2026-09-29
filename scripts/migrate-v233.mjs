#!/usr/bin/env node

import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

const MIGRATION_PATH = "/api/maintenance/migrate-v2.3.3";
const REQUEST_TIMEOUT_MS = 30_000;
const APPLY_TIMEOUT_MS = 5 * 60_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

class MigrationError extends Error {}

function printHelp() {
  process.stdout.write(`Usage: npm run migrate:v2.3.3 -- --url https://your-worker.example [--apply]

Preview the supported v2.3.3 configuration migration without writing data.
Use --apply to preview again and apply the current revision explicitly.

Options:
  --url ORIGIN  Existing Worker HTTPS origin; HTTP is allowed only on localhost.
  --apply       Apply the current revision; wait up to 5 minutes for cleanup.
  --help        Show this help without making requests.

Environment:
  SUBPILOT_URL          Worker origin, used when --url is omitted.
  SUBPILOT_ADMIN_TOKEN  Admin login token; otherwise prompted without echo in a TTY.

Deploy the new program first and close old admin pages before migration.
Worker Secrets remain on the Worker. Configuration and credentials are not printed.
`);
}

function parseArgs(args) {
  let url = process.env.SUBPILOT_URL || "", apply = false, help = false, urlSeen = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help") help = true;
    else if (arg === "--apply") apply = true;
    else if (arg === "--url" || arg.startsWith("--url=")) {
      if (urlSeen) throw new MigrationError("Provide --url only once.");
      urlSeen = true;
      url = arg === "--url" ? args[++index] : arg.slice("--url=".length);
      if (!url || url.startsWith("--")) throw new MigrationError("--url requires a Worker origin.");
    } else throw new MigrationError("Unknown argument. Use --help; admin tokens must not be passed as arguments.");
  }
  return { url, apply, help };
}

function workerOrigin(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new MigrationError("Provide a valid Worker origin with --url or SUBPILOT_URL."); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new MigrationError("Use HTTPS for the Worker origin. HTTP is permitted only on localhost.");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new MigrationError("The Worker URL must be an origin without credentials, a path, query parameters, or a fragment.");
  }
  return url.origin;
}

function promptToken() {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new MigrationError("Set SUBPILOT_ADMIN_TOKEN in a non-interactive environment.");
  }
  return new Promise((resolve, reject) => {
    let muted = false, settled = false;
    const originalRaw = Boolean(process.stdin.isRaw);
    const output = new Writable({ write(chunk, encoding, done) {
      if (!muted) process.stderr.write(chunk, encoding);
      done();
    } });
    const input = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
    const finish = (error, token) => {
      if (settled) return;
      settled = true;
      input.close();
      process.stdin.setRawMode(originalRaw);
      process.stdin.pause();
      process.stderr.write("\n");
      if (error) reject(error); else resolve(token.trim());
    };
    input.once("SIGINT", () => finish(new MigrationError("Migration cancelled.")));
    input.once("close", () => finish(new MigrationError("Admin token input was closed.")));
    input.question("Admin token (hidden): ", (token) => finish(null, token));
    muted = true;
  });
}

async function readJson(response) {
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json") || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new MigrationError("The Worker returned an unexpected response format.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new MigrationError("The Worker response exceeds the migration response limit.");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    try { return JSON.parse(text); }
    catch { throw new MigrationError("The Worker returned invalid migration metadata."); }
  } finally { reader.releaseLock(); }
}

function plainString(value, limit) {
  return typeof value === "string" && value.length > 0 && value.length <= limit
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value);
}

function previewMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !["ready", "current", "empty", "blocked", "pending"].includes(value.status)) {
    throw new MigrationError("The Worker returned invalid migration status metadata.");
  }
  for (const field of ["changes", "blockers"]) {
    if (!Array.isArray(value[field]) || value[field].length > 2000
      || value[field].some((message) => !plainString(message, 2000))) {
      throw new MigrationError("The Worker returned invalid migration summary metadata.");
    }
  }
  if (value.revision !== undefined && (typeof value.revision !== "string" || !/^[a-f0-9]{64}$/.test(value.revision))
    || value.status === "ready" && (!value.revision || value.blockers.length)) {
    throw new MigrationError("The Worker returned an invalid migration revision.");
  }
  if (value.retryAfterSeconds !== undefined && (!Number.isSafeInteger(value.retryAfterSeconds) || value.retryAfterSeconds < 0)
    || value.status === "pending" && (value.retryAfterSeconds === undefined || value.blockers.length)) {
    throw new MigrationError("The Worker returned invalid migration retry metadata.");
  }
  return value;
}

function remainingApplyTime(deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new MigrationError("Migration cleanup is not yet confirmed after 5 minutes. Run preview again shortly, then use --apply if cleanup is still required.");
  }
  return remaining;
}

async function waitForCleanup(seconds, deadline) {
  const retryAt = Date.now() + Math.min(Math.max(seconds, 1) * 1000, APPLY_TIMEOUT_MS);
  while (Date.now() < retryAt) {
    const wait = Math.min(retryAt - Date.now(), remainingApplyTime(deadline));
    process.stdout.write(`Actions cleanup is pending. Next status check in ${Math.ceil(wait / 1000)} seconds.\n`);
    await delay(Math.min(wait, 10_000));
  }
  remainingApplyTime(deadline);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { printHelp(); return; }
  const origin = workerOrigin(options.url);
  let token = process.env.SUBPILOT_ADMIN_TOKEN?.trim() || await promptToken();
  if (!token || Buffer.byteLength(token, "utf8") > 2048 || /[\r\n]/.test(token)) {
    throw new MigrationError("The admin token is empty or has an invalid length or format.");
  }
  let cookie = "", applyDeadline = 0;
  const request = async (path, method = "GET", body) => {
    const timeout = applyDeadline ? Math.min(REQUEST_TIMEOUT_MS, remainingApplyTime(applyDeadline)) : REQUEST_TIMEOUT_MS;
    const response = await fetch(new URL(path, origin), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
      headers: { accept: "application/json", ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const hint = response.status === 401 ? "Check the admin token and sign in again."
        : response.status === 404 ? "Deploy the program containing the migration endpoint first."
          : response.status === 409 ? "The source revision changed or migration is blocked. Run preview again."
            : response.status === 429 ? "Wait before trying again."
              : "Run preview again before attempting to apply.";
      throw new MigrationError(`Worker request failed (HTTP ${response.status}). ${hint}`);
    }
    return response;
  };
  try {
    const login = await request("/api/login", "POST", { token });
    token = "";
    const session = login.headers.getSetCookie().map((value) => value.split(";", 1)[0])
      .filter((value) => value.startsWith("subpilot_session="));
    await login.body?.cancel().catch(() => {});
    if (session.length !== 1 || !plainString(session[0], 4096) || session[0] === "subpilot_session=") {
      throw new MigrationError("Login did not return a valid admin session.");
    }
    cookie = session[0];
    let preview = previewMetadata(await readJson(await request(MIGRATION_PATH)));
    const summaries = {
      ready: "Migration is ready. Existing client settings will be preserved except for the listed changes.",
      current: "Configuration already uses the current format. No migration was written.",
      empty: "No existing configuration requires migration. No migration was written.",
      blocked: "Migration is blocked. No migration was written.",
      pending: "Migration cleanup is pending. Legacy Actions records have not been fully removed."
    };
    process.stdout.write(`${summaries[preview.status]}\n`);
    for (const change of preview.changes) process.stdout.write(`Change: ${change}\n`);
    for (const blocker of preview.blockers) process.stdout.write(`Blocked: ${blocker}\n`);
    if (preview.status === "blocked") { process.exitCode = 1; return; }
    if (!["ready", "pending"].includes(preview.status)) return;
    if (!options.apply) {
      if (preview.status === "pending") process.stdout.write(`Cleanup can be checked again in ${preview.retryAfterSeconds} seconds.\n`);
      process.stdout.write("Preview only: no data was written. Review the changes, then rerun with --apply.\n");
      return;
    }
    applyDeadline = Date.now() + APPLY_TIMEOUT_MS;
    while (true) {
      if (preview.status === "pending") {
        await waitForCleanup(preview.retryAfterSeconds, applyDeadline);
        preview = previewMetadata(await readJson(await request(MIGRATION_PATH)));
        if (preview.status === "pending") continue;
      }
      if (preview.status === "blocked") {
        process.stdout.write("Migration is blocked; cleanup is not confirmed.\n");
        for (const blocker of preview.blockers) process.stdout.write(`Blocked: ${blocker}\n`);
        process.exitCode = 1;
        return;
      }
      if (preview.status === "current") {
        if (preview.blockers.length) throw new MigrationError("The Worker returned conflicting migration status metadata.");
        process.stdout.write("Configuration is current and no legacy Actions migration remains. No duplicate migration was written.\n");
        break;
      }
      if (preview.status !== "ready") {
        throw new MigrationError("The migration status changed unexpectedly. Run preview again before attempting another apply.");
      }
      const applied = await readJson(await request(MIGRATION_PATH, "POST", { revision: preview.revision }));
      if (["current", "pending"].includes(applied?.status)) {
        preview = previewMetadata(applied);
        continue;
      }
      if (!applied || typeof applied !== "object" || applied.status !== "applied" || !plainString(applied.backupKey, 1024)) {
        throw new MigrationError("The apply result could not be confirmed. Run preview again before attempting another apply.");
      }
      process.stdout.write("Migration applied. The recoverable encrypted backup, original configuration snapshots, and subscription-token records were retained. Obsolete Actions credentials and callback records were removed only after their current records were written and verified. Worker Secrets were not changed.\n");
      break;
    }
    applyDeadline = 0;
    try {
      const current = await request("/api/config");
      await current.body?.cancel().catch(() => {});
      if (current.status !== 200) throw new MigrationError("Configuration verification did not return HTTP 200.");
      process.stdout.write("Configuration is readable. Reopen the admin page and check subscriptions before updating clients.\n");
    } catch {
      process.exitCode = 1;
      process.stderr.write("Migration was applied, but configuration readability is not yet confirmed. KV propagation may take time; retry preview and reopen the admin page shortly. Do not repeat --apply without checking the status.\n");
    }
  } finally { token = ""; cookie = ""; }
}

main().catch((error) => {
  process.exitCode = 1;
  process.stderr.write(`${error instanceof MigrationError ? error.message : "Migration request failed or timed out. An apply may already have completed; run preview again before retrying. No response body or credentials were printed."}\n`);
});
