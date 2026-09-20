#!/usr/bin/env node

const args = process.argv.slice(2);
if (args.some((arg) => arg === "--backup" || arg.startsWith("--backup=")) || process.env.SUBPILOT_BACKUP_PATH) {
  process.stderr.write("Configuration export has been removed. Remove --backup and SUBPILOT_BACKUP_PATH; use --apply to confirm migration.\n");
  process.exit(1);
}

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
if (!response.ok) throw new Error(`Migration check failed: HTTP ${response.status}`);
const preview = await response.json();
if (!preview.required) {
  process.stdout.write("Configuration does not require legacy migration.\n");
  process.exit(0);
}
if (!args.includes("--apply")) {
  process.stdout.write("Document upgrade is pending. Existing client settings are preserved; sing-box starts with independent defaults. No configuration was written. Review the draft in the admin UI, then add --apply to confirm.\n");
  process.exit(0);
}
const applied = await fetch(`${baseUrl}/api/config/migration`, {
  method: "POST", headers: { cookie, "content-type": "application/json" },
  body: JSON.stringify({ config: preview.config, fingerprint: preview.fingerprint })
});
if (!applied.ok) throw new Error(`Migration was not completed: HTTP ${applied.status}. Inspect the admin UI and review migration again.`);
await applied.json();
process.stdout.write("Document upgrade committed. Client settings remain independent. Review each client's configuration before use.\n");
