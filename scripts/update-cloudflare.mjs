#!/usr/bin/env node

import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { platform, tmpdir } from "node:os";
import { capture, run } from "./lib/commands.mjs";
import { runCf } from "./lib/cloudflare-cli.mjs";
import { MANAGED_RELEASE_PATHS, assertReleaseFiles, assertReleaseVersions, forbiddenReleasePath, releaseVersionFromTag } from "./lib/release-manifest.mjs";

const RELEASE_REPOSITORY = "tnt2ray/subpilot-worker";
const RELEASE_API_URL = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`;
const RELEASE_ASSET_PREFIX = "subpilot-worker-";
const RELEASE_ASSET_SUFFIX = ".tar.gz";
const args = new Set(process.argv.slice(2));
const npmCommand = platform() === "win32" ? "npm.cmd" : "npm";
const gitCommand = platform() === "win32" ? "git.exe" : "git";

function githubHeaders(extra = {}) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  return {
    "user-agent": "subpilot-worker-updater",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extra
  };
}

function ensureCleanTrackedChanges() {
  const unstaged = spawnSync(gitCommand, ["diff", "--quiet"]);
  const staged = spawnSync(gitCommand, ["diff", "--cached", "--quiet"]);
  if (unstaged.status !== 0 || staged.status !== 0) {
    process.stderr.write("Local tracked files have changes. Commit or stash them before updating.\n");
    process.exit(1);
  }
}

async function downloadLatestReleaseArchive() {
  process.stdout.write(`Downloading latest ${RELEASE_REPOSITORY} release...\n`);
  const releaseResponse = await fetch(RELEASE_API_URL, {
    headers: githubHeaders({ accept: "application/vnd.github+json" })
  });
  if (!releaseResponse.ok) {
    process.stderr.write(`Could not read latest GitHub Release: HTTP ${releaseResponse.status}\n`);
    process.stderr.write("Download the complete release archive and follow the README migration steps, preserving local deployment settings.\n");
    process.exit(1);
  }

  const release = await releaseResponse.json();
  const version = releaseVersionFromTag(release?.tag_name);
  const releaseAsset = trackedReleaseAsset(release);
  const archiveUrl = releaseAsset?.url || (typeof release.tarball_url === "string" ? release.tarball_url : "");
  if (!archiveUrl) {
    process.stderr.write("Latest GitHub Release does not include a source archive URL.\n");
    process.exit(1);
  }

  const archiveResponse = await fetch(archiveUrl, {
    headers: releaseAsset
      ? githubHeaders({ accept: "application/octet-stream" })
      : githubHeaders()
  });
  if (!archiveResponse.ok) {
    process.stderr.write(`Could not download release archive: HTTP ${archiveResponse.status}\n`);
    process.exit(1);
  }

  const tempDirectory = mkdtempSync(join(tmpdir(), "subpilot-update-"));
  try {
    const archivePath = join(tempDirectory, "release.tar.gz");
    writeFileSync(archivePath, Buffer.from(await archiveResponse.arrayBuffer()));
    const listing = spawnSync("tar", ["-tzf", archivePath], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (listing.status !== 0) throw new Error("Could not inspect the release archive. Existing program files were not changed.");
    const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
    if (!entries.length || entries.some((path) => path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path) || path.split("/").includes(".."))) {
      throw new Error("Invalid release archive paths. Existing program files were not changed.");
    }
    const extracted = spawnSync("tar", ["-xzf", archivePath, "-C", tempDirectory], { encoding: "utf8" });
    if (extracted.status !== 0) throw new Error("Could not extract the release archive. Existing program files were not changed.");
    const roots = readdirSync(tempDirectory, { withFileTypes: true }).filter((entry) => entry.name !== "release.tar.gz");
    if (roots.length !== 1 || !roots[0].isDirectory()) {
      throw new Error("Release archive must contain one project directory. Existing program files were not changed.");
    }
    const sourceDirectory = join(tempDirectory, roots[0].name);
    validateReleaseDirectory(sourceDirectory, version);
    return { tempDirectory, sourceDirectory, version: `v${version}` };
  } catch (error) {
    rmSync(tempDirectory, { recursive: true, force: true });
    throw error;
  }
}

function validateReleaseDirectory(sourceDirectory, version) {
  const files = [];
  const visit = (relativeDirectory = "") => {
    for (const entry of readdirSync(join(sourceDirectory, relativeDirectory), { withFileTypes: true })) {
      const path = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (forbiddenReleasePath(path)) throw new Error(`Forbidden release path: ${JSON.stringify(path)}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`Unsupported release entry: ${JSON.stringify(path)}`);
    }
  };
  visit();
  assertReleaseFiles(files);
  assertReleaseVersions((path) => readFileSync(join(sourceDirectory, path), "utf8"), version);
}

function trackedReleaseAsset(release) {
  const tagName = typeof release?.tag_name === "string" ? release.tag_name : "";
  const expectedName = tagName ? `${RELEASE_ASSET_PREFIX}${tagName}${RELEASE_ASSET_SUFFIX}` : "";
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  return assets.find((asset) => (
    asset
    && typeof asset.url === "string"
    && typeof asset.name === "string"
    && asset.name === expectedName
  )) || null;
}

function copyReleaseIntoCurrentDirectory(sourceDirectory) {
  for (const relativePath of MANAGED_RELEASE_PATHS) {
    const sourcePath = join(sourceDirectory, relativePath);
    const targetPath = join(process.cwd(), relativePath);
    rmSync(targetPath, { recursive: true, force: true });
    if (existsSync(sourcePath)) {
      cpSync(sourcePath, targetPath, { recursive: true, force: true });
    }
  }
  rmSync(join(process.cwd(), "wrangler.example.jsonc"), { force: true });
}

if (existsSync(".git")) {
  ensureCleanTrackedChanges();
  const branch = capture(gitCommand, ["branch", "--show-current"]).trim();
  process.stdout.write(branch ? `Updating ${branch}...\n` : "Updating repository...\n");
  run(gitCommand, ["pull", "--ff-only"]);
} else {
  try {
    const release = await downloadLatestReleaseArchive();
    try {
      copyReleaseIntoCurrentDirectory(release.sourceDirectory);
      process.stdout.write(`Installed ${release.version} source files. Local cloudflare.local.json, legacy wrangler.jsonc and secrets were preserved.\n`);
    } finally {
      rmSync(release.tempDirectory, { recursive: true, force: true });
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Release update failed."}\n`);
    process.exit(1);
  }
}

if (!args.has("--no-install")) run(npmCommand, ["install", "--include=dev"]);
run(npmCommand, ["run", "setup", "--", "--no-deploy", "--no-secrets", "--existing-config-only"]);
if (!args.has("--no-deploy")) runCf(["deploy"]);

process.stdout.write("\nSubPilot update complete. Open the admin UI to review your configuration.\n");
