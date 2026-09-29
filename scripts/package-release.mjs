#!/usr/bin/env node

import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { assertReleaseFiles, assertReleaseVersions } from "./lib/release-manifest.mjs";

function readGit(args, label) {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Could not read ${label}.`);
  return result.stdout;
}

try {
  const unstaged = spawnSync("git", ["diff", "--quiet"], { stdio: "pipe" });
  const staged = spawnSync("git", ["diff", "--cached", "--quiet"], { stdio: "pipe" });
  if (unstaged.status !== 0 || staged.status !== 0) {
    throw new Error("Tracked files have uncommitted changes or Git status could not be checked. Commit before packaging a release.");
  }

  const files = readGit(["ls-tree", "-r", "-z", "--full-tree", "HEAD"], "the HEAD file list")
    .split("\0").filter(Boolean).map((entry) => {
      const separator = entry.indexOf("\t");
      const metadata = entry.slice(0, separator);
      const path = entry.slice(separator + 1);
      if (separator < 0 || !/^100(?:644|755) blob [a-f0-9]+$/.test(metadata)) {
        throw new Error(`Unsupported release entry: ${JSON.stringify(path)}`);
      }
      return path;
    });
  assertReleaseFiles(files);
  const version = assertReleaseVersions((path) => readGit(["show", `HEAD:${path}`], `HEAD:${path}`));
  const tag = `v${version}`;
  const outputDirectory = "dist";
  const outputFile = join(outputDirectory, `subpilot-worker-${tag}.tar.gz`);
  mkdirSync(outputDirectory, { recursive: true });

  const result = spawnSync("git", [
    "archive", "--format=tar.gz", `--prefix=subpilot-worker-${tag}/`, "-o", outputFile, "HEAD"
  ], { stdio: "pipe" });
  if (result.status !== 0) throw new Error(`Could not create release archive: ${outputFile}`);
  process.stdout.write(`${outputFile}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Release packaging failed."}\n`);
  process.exit(1);
}
