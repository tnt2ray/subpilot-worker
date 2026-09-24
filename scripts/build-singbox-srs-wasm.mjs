#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = process.cwd();
const MODULE_DIR = join(ROOT, "wasm", "singbox-srs");
const SOURCE = join(MODULE_DIR, "main.go");
const COMPAT = join(MODULE_DIR, "compat", "buffer_unix.go.txt");
const BUFIO_COMPAT = join(MODULE_DIR, "compat", "bufio_wasip1.go.txt");
const GOOS_COMPAT = join(MODULE_DIR, "compat", "goos_wasip1.go.txt");
const OUTPUT = join(ROOT, "src", "vendor", "singbox", "srs-compiler.wasm");
const CHECKSUM = `${OUTPUT}.sha256`;
const REBUILD = process.argv.includes("--rebuild");
const TEMP_OUTPUT = `${OUTPUT}.${process.pid}.tmp`;
const TEMP_DIRECTORY = join(tmpdir(), `subpilot-singbox-wasi-${process.pid}`);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readExpectedChecksum() {
  if (!existsSync(CHECKSUM)) return "";
  return readFileSync(CHECKSUM, "utf8").trim().split(/\s+/, 1)[0] ?? "";
}

if (!REBUILD) {
  if (!existsSync(OUTPUT)) fail("The packaged sing-box WASI module is missing; rebuild it with npm run build:singbox-srs:rebuild.");
  const actual = digest(readFileSync(OUTPUT));
  if (!/^[a-f0-9]{64}$/.test(readExpectedChecksum()) || actual !== readExpectedChecksum()) {
    fail("The packaged sing-box WASI module does not match its checksum.");
  }
  process.stdout.write("Verified the pinned sing-box WASI compiler.\n");
  process.exit(0);
}

if (!existsSync(SOURCE) || !existsSync(COMPAT) || !existsSync(BUFIO_COMPAT) || !existsSync(GOOS_COMPAT)) fail("The pinned sing-box WASI compiler sources are incomplete.");

const goMod = readFileSync(join(MODULE_DIR, "go.mod"), "utf8");
const singBoxVersion = goMod.match(/^\s*github\.com\/sagernet\/sing-box\s+(v\S+)/m)?.[1];
if (!singBoxVersion) fail("The sing-box module version is missing from go.mod.");
const go = spawnSync("go", ["version"], { encoding: "utf8" });
if (go.status !== 0) fail("Go 1.25.5 or newer is required to rebuild the sing-box WASI compiler.");
const goVersion = go.stdout.match(/go version go(\d+\.\d+\.\d+)/)?.[1] ?? "";
if (!goVersion || goVersion.localeCompare("1.25.5", undefined, { numeric: true }) < 0) {
  fail("Go 1.25.5 or newer is required to rebuild the sing-box WASI compiler.");
}

const env = { ...process.env, GOOS: "wasip1", GOARCH: "wasm", CGO_ENABLED: "0", GOTOOLCHAIN: "local" };
const downloadSingBoxModule = spawnSync("go", ["mod", "download", `github.com/sagernet/sing-box@${singBoxVersion}`], {
  cwd: MODULE_DIR, env, encoding: "utf8", stdio: ["ignore", "ignore", "pipe"]
});
if (downloadSingBoxModule.status !== 0) {
  process.stderr.write(downloadSingBoxModule.stderr || "Could not download the pinned sing-box module for the WASI compatibility build.\n");
  process.exit(downloadSingBoxModule.status ?? 1);
}
const packageDirResult = spawnSync("go", ["list", "-f", "{{.Dir}}", "github.com/sagernet/sing/common/buf"], {
  cwd: MODULE_DIR, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]
});
const packageDir = packageDirResult.status === 0 ? packageDirResult.stdout.trim() : "";
if (!packageDir) fail("Could not resolve the pinned sing module for the WASI compatibility build.");
const singBoxModuleResult = spawnSync("go", ["list", "-m", "-f", "{{.Dir}}", "github.com/sagernet/sing-box"], {
  cwd: MODULE_DIR, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]
});
const singBoxModuleRoot = singBoxModuleResult.status === 0 ? singBoxModuleResult.stdout.trim() : "";
if (!singBoxModuleRoot) fail("Could not resolve the pinned sing-box module for the WASI compatibility build.");

const originalModuleRoot = join(packageDir, "..", "..");
const copiedModuleRoot = join(TEMP_DIRECTORY, "sing-module");
const copiedSingBoxModuleRoot = join(TEMP_DIRECTORY, "sing-box-module");
const tempModFile = join(TEMP_DIRECTORY, "srs-compiler.mod");
const tempSumFile = join(TEMP_DIRECTORY, "srs-compiler.sum");
rmSync(TEMP_OUTPUT, { force: true });
rmSync(TEMP_DIRECTORY, { recursive: true, force: true });
mkdirSync(TEMP_DIRECTORY, { recursive: true });
cpSync(originalModuleRoot, copiedModuleRoot, { recursive: true });
cpSync(singBoxModuleRoot, copiedSingBoxModuleRoot, { recursive: true });
cpSync(join(MODULE_DIR, "go.mod"), tempModFile);
cpSync(join(MODULE_DIR, "go.sum"), tempSumFile);
const replaceModule = spawnSync("go", ["mod", "edit", `-modfile=${tempModFile}`,
  `-replace=github.com/sagernet/sing=${copiedModuleRoot}`,
  `-replace=github.com/sagernet/sing-box=${copiedSingBoxModuleRoot}`], {
  cwd: MODULE_DIR, env, encoding: "utf8", stdio: ["ignore", "ignore", "pipe"]
});
if (replaceModule.status !== 0) {
  rmSync(TEMP_DIRECTORY, { recursive: true, force: true });
  process.stderr.write(replaceModule.stderr || "Could not prepare the temporary sing module replacement.\n");
  process.exit(replaceModule.status ?? 1);
}
const copiedBufDirectory = join(copiedModuleRoot, "common", "buf");
const copiedBufioDirectory = join(copiedModuleRoot, "common", "bufio");
const copiedGoosDirectory = join(copiedSingBoxModuleRoot, "constant", "goos");
const compatTargets = [
  [join(copiedBufDirectory, "buffer_unix.go"), readFileSync(COMPAT)],
  [join(copiedBufioDirectory, "copy_direct_posix.go"), "//go:build !wasip1\n\npackage bufio\n"],
  [join(copiedBufioDirectory, "vectorised_unix.go"), "//go:build !wasip1\n\npackage bufio\n"],
  [join(copiedBufioDirectory, "wasip1_stub.go"), readFileSync(BUFIO_COMPAT)],
  [join(copiedGoosDirectory, "zgoos_wasip1.go"), readFileSync(GOOS_COMPAT)]
];
for (const [path, contents] of compatTargets) {
  mkdirSync(dirname(path), { recursive: true });
  chmodSync(dirname(path), 0o755);
  if (existsSync(path)) chmodSync(path, 0o644);
  writeFileSync(path, contents);
}
mkdirSync(dirname(OUTPUT), { recursive: true });
let build;
try {
  build = spawnSync("go", ["build", "-trimpath", "-ldflags=-s -w", `-modfile=${tempModFile}`, "-o", TEMP_OUTPUT, "."], {
    cwd: MODULE_DIR, env, encoding: "utf8", stdio: ["ignore", "ignore", "pipe"]
  });
} finally {
  rmSync(TEMP_DIRECTORY, { recursive: true, force: true });
}
if (build.status !== 0) {
  rmSync(TEMP_OUTPUT, { force: true });
  if (build.stderr) process.stderr.write(build.stderr);
  process.stderr.write("Could not build the sing-box WASI compiler from the pinned source.\n");
  process.exit(build.status ?? 1);
}

try {
  renameSync(TEMP_OUTPUT, OUTPUT);
} catch (error) {
  rmSync(TEMP_OUTPUT, { force: true });
  throw error;
}
chmodSync(OUTPUT, 0o644);
const bytes = readFileSync(OUTPUT);
const checksum = digest(bytes);
writeFileSync(CHECKSUM, `${checksum}  srs-compiler.wasm\n`);
process.stdout.write(`Built sing-box ${singBoxVersion} WASI module (${bytes.byteLength} bytes).\n`);
