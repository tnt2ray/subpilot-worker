#!/usr/bin/env node

import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { platform, tmpdir } from "node:os";

const RELEASE_REPOSITORY = "tnt2ray/subpilot-worker";
const RELEASE_API_URL = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`;
const RELEASE_ASSET_PREFIX = "subpilot-worker-";
const RELEASE_ASSET_SUFFIX = ".tar.gz";
const args = new Set(process.argv.slice(2));
const npmCommand = platform() === "win32" ? "npm.cmd" : "npm";
const gitCommand = platform() === "win32" ? "git.exe" : "git";
const wranglerCommand = platform() === "win32" ? "wrangler.cmd" : "wrangler";

const MANAGED_PATHS = [
  ".dev.vars.example",
  ".gitignore",
  "docs",
  "package-lock.json",
  "package.json",
  "public",
  "readme.md",
  "scripts",
  "src",
  "test",
  "tsconfig.json",
  "wrangler.example.jsonc"
];

function githubHeaders(extra = {}) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  return {
    "user-agent": "subpilot-worker-updater",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extra
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.exit(result.status ?? 1);
  }
  return result.stdout ?? "";
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
    process.stderr.write("Download a release archive manually, extract it over this directory, then run npm install --omit=dev && wrangler deploy.\n");
    process.exit(1);
  }

  const release = await releaseResponse.json();
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
  const archivePath = join(tempDirectory, "release.tar.gz");
  writeFileSync(archivePath, Buffer.from(await archiveResponse.arrayBuffer()));
  run("tar", ["-xzf", archivePath, "-C", tempDirectory]);

  const sourceRoot = readdirSync(tempDirectory, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && entry.name !== "__MACOSX");
  if (!sourceRoot) {
    process.stderr.write("Could not find extracted release directory.\n");
    process.exit(1);
  }

  return {
    tempDirectory,
    sourceDirectory: join(tempDirectory, sourceRoot.name),
    version: typeof release.tag_name === "string" ? release.tag_name : "latest"
  };
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
  for (const relativePath of MANAGED_PATHS) {
    const sourcePath = join(sourceDirectory, relativePath);
    const targetPath = join(process.cwd(), relativePath);
    rmSync(targetPath, { recursive: true, force: true });
    if (existsSync(sourcePath)) {
      cpSync(sourcePath, targetPath, { recursive: true, force: true });
    }
  }
}

if (existsSync(".git")) {
  ensureCleanTrackedChanges();
  const branch = capture(gitCommand, ["branch", "--show-current"]).trim();
  process.stdout.write(branch ? `Updating ${branch}...\n` : "Updating repository...\n");
  run(gitCommand, ["pull", "--ff-only"]);
} else {
  const release = await downloadLatestReleaseArchive();
  try {
    copyReleaseIntoCurrentDirectory(release.sourceDirectory);
    process.stdout.write(`Installed ${release.version} source files. Local wrangler.jsonc and secrets were preserved.\n`);
  } finally {
    rmSync(release.tempDirectory, { recursive: true, force: true });
  }
}

if (!args.has("--no-install")) run(npmCommand, ["install", "--omit=dev"]);
if (!args.has("--no-deploy")) run(wranglerCommand, ["deploy"]);

process.stdout.write("\nSubPilot update complete. KV schema updates run automatically when the Worker handles requests.\n");
