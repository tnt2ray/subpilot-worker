import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../../node_modules/cf/bin/cf", import.meta.url));

export function spawnCf(args, options = {}) {
  if (!existsSync(CLI_PATH)) {
    process.stderr.write("The project Cloudflare CLI is missing. Run npm install --include=dev first.\n");
    process.exit(1);
  }
  const { env, ...spawnOptions } = options;
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    ...spawnOptions,
    env: { ...process.env, ...env, NO_COLOR: "1" },
    shell: false
  });
}

function checkResult(result) {
  if (result.status === 0) return;
  if (result.error) process.stderr.write(`Could not start cf: ${result.error.message}\n`);
  process.stderr.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  process.exit(result.status ?? 1);
}

export function runCf(args, options = {}) {
  const result = spawnCf(args, { stdio: "inherit", ...options });
  checkResult(result);
}

export function captureCf(args, options = {}) {
  const { includeStderr = false, ...spawnOptions } = options;
  const result = spawnCf(args, spawnOptions);
  checkResult(result);
  return includeStderr ? `${result.stdout ?? ""}\n${result.stderr ?? ""}` : result.stdout ?? "";
}
