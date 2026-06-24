#!/usr/bin/env node

import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const version = typeof packageJson.version === "string" ? packageJson.version.trim() : "";

if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  process.stderr.write("package.json has no valid semantic version.\n");
  process.exit(1);
}

const tag = `v${version}`;
const outputDirectory = "dist";
const outputFile = join(outputDirectory, `subpilot-worker-${tag}.tar.gz`);
mkdirSync(outputDirectory, { recursive: true });

const unstaged = spawnSync("git", ["diff", "--quiet"]);
const staged = spawnSync("git", ["diff", "--cached", "--quiet"]);
if (unstaged.status !== 0 || staged.status !== 0) {
  process.stderr.write("Tracked files have uncommitted changes. Commit before packaging a release.\n");
  process.exit(1);
}

const result = spawnSync("git", [
  "archive",
  "--format=tar.gz",
  `--prefix=subpilot-worker-${tag}/`,
  "-o",
  outputFile,
  "HEAD"
], { stdio: "inherit" });

if (result.status !== 0) process.exit(result.status ?? 1);
process.stdout.write(`${outputFile}\n`);
