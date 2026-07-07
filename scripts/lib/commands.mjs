import { spawnSync } from "node:child_process";

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

export function capture(command, args, options = {}) {
  const { includeStderr = false, ...spawnOptions } = options;
  const result = spawnSync(command, args, { encoding: "utf8", ...spawnOptions });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.exit(result.status ?? 1);
  }
  return includeStderr ? `${result.stdout ?? ""}\n${result.stderr ?? ""}` : result.stdout ?? "";
}
