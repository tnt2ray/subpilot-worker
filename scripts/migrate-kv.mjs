#!/usr/bin/env node

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

const migrateResponse = await fetch(`${baseUrl}/api/system/migrate`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    cookie
  },
  body: "{}"
});

const text = await migrateResponse.text();
if (!migrateResponse.ok) {
  process.stderr.write(`Migration failed: HTTP ${migrateResponse.status}\n${text}\n`);
  process.exit(1);
}

process.stdout.write(`${text}\n`);
