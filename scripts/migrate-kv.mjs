#!/usr/bin/env node
import { writeFile } from "node:fs/promises";

const args = process.argv.slice(2);

function argValue(name, envName) {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1] || "";
  return process.env[envName] || "";
}

const baseUrl = argValue("--url", "SUBPILOT_BASE_URL").replace(/\/+$/, "");
const token = argValue("--token", "SUBPILOT_ADMIN_TOKEN");

if (!baseUrl || !token) {
  process.stderr.write("Usage: npm run migrate -- --url https://your-worker.example --token <admin-token>\n");
  process.stderr.write("You can also set SUBPILOT_BASE_URL and SUBPILOT_ADMIN_TOKEN.\n");
  process.exit(1);
}

const loginResponse = await fetch(`${baseUrl}/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token })
});

if (!loginResponse.ok) {
  process.stderr.write(`Login failed: HTTP ${loginResponse.status}\n`);
  process.exit(1);
}

const cookie = loginResponse.headers.get("set-cookie")?.split(";")[0] || "";
if (!cookie) {
  process.stderr.write("Login did not return a session cookie.\n");
  process.exit(1);
}

const response = await fetch(`${baseUrl}/api/config/migration`, { headers: { cookie } });
if (!response.ok) throw new Error(`Migration preview failed: HTTP ${response.status}`);
const preview = await response.json();
if (!preview.required) {
  process.stdout.write("Configuration already uses schema v2.\n");
  process.exit(0);
}
const backupPath = argValue("--backup", "SUBPILOT_BACKUP_PATH");
if (!backupPath) {
  process.stdout.write("Migration is pending. Open the admin UI, or provide --backup <private-file.json> to export before migration. Add --apply to confirm migration after export.\n");
  process.exit(0);
}
const backup = await fetch(`${baseUrl}/api/config/export`, { headers: { cookie } });
if (!backup.ok) throw new Error(`Backup export failed: HTTP ${backup.status}`);
await writeFile(backupPath, await backup.text(), { encoding: "utf8", flag: "wx", mode: 0o600 });
process.stdout.write("Private configuration backup saved. Keep it outside the repository.\n");
if (!args.includes("--apply")) {
  process.stdout.write("No migration applied. Review and confirm in the admin UI, or rerun with --apply and a new backup file path.\n");
  process.exit(0);
}
const applied = await fetch(`${baseUrl}/api/config/migration`, {
  method: "POST", headers: { cookie, "content-type": "application/json" },
  body: JSON.stringify({ config: preview.config, fingerprint: preview.fingerprint, backupDownloaded: true })
});
if (!applied.ok) throw new Error(`Migration was not completed: HTTP ${applied.status}. Inspect the admin UI; the exported backup is retained.`);
const config = await applied.json();
const pending = config.clients.singbox.migrationIssues.filter((issue) => issue.severity === "error").length;
process.stdout.write(`Migration committed. sing-box has ${pending} conversion items to review in the admin UI.\n`);
