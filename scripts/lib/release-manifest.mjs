export const MANAGED_RELEASE_PATHS = [
  ".dev.vars.example",
  ".gitignore",
  "cloudflare.config.ts",
  "cloudflare.example.json",
  "docs",
  "LICENSE",
  "package-lock.json",
  "package.json",
  "public",
  "README.en.md",
  "readme.md",
  "scripts",
  "src",
  "test",
  "tsconfig.json",
  "vite.config.ts"
];

export const REQUIRED_RELEASE_FILES = [
  ".dev.vars.example",
  ".gitignore",
  "cloudflare.config.ts",
  "cloudflare.example.json",
  "LICENSE",
  "package.json",
  "package-lock.json",
  "public/index.html",
  "public/app.js",
  "readme.md",
  "README.en.md",
  "scripts/build-actions-compiler.mjs",
  "scripts/compile-rule-sets.mjs",
  "scripts/compile-rule-sets.yml",
  "scripts/generate-worker-types.mjs",
  "scripts/migrate-v233.mjs",
  "scripts/package-release.mjs",
  "scripts/setup-cloudflare.mjs",
  "scripts/update-cloudflare.mjs",
  "scripts/lib/cloudflare-cli.mjs",
  "scripts/lib/cloudflare-config.mjs",
  "scripts/lib/cloudflare-config.d.mts",
  "scripts/lib/commands.mjs",
  "scripts/lib/release-manifest.mjs",
  "src/actions-compiler-runtime.ts",
  "src/config-document-validation.ts",
  "src/config-migration-api.ts",
  "src/config-migration-store.ts",
  "src/config-migration-v233.ts",
  "src/index.ts",
  "src/version.ts",
  "tsconfig.json",
  "vite.config.ts"
];

const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function forbiddenReleasePath(path) {
  const normalized = path.replaceAll("\\", "/");
  const basename = normalized.split("/").filter(Boolean).at(-1) ?? "";
  return /(?:^|\/)(?:\.git|node_modules|\.wrangler|\.cloudflare|\.subpilot-build|dist)(?:\/|$)/.test(normalized)
    || /(?:^|\/)docs\/agents\.local(?:\/|$)/.test(normalized)
    || ["AGENTS.md", "wrangler.jsonc", "cloudflare.local.json", "worker-configuration.d.ts"].includes(basename)
    || /^(?:\.dev\.vars|\.env)(?:\..*)?$/.test(basename) && ![".dev.vars.example", ".env.example"].includes(basename);
}

export function assertReleaseFiles(files) {
  const names = new Set(files);
  const forbidden = files.filter(forbiddenReleasePath);
  if (forbidden.length) {
    throw new Error(`Forbidden release paths: ${forbidden.map((path) => JSON.stringify(path)).join(", ")}`);
  }
  const missing = REQUIRED_RELEASE_FILES.filter((path) => !names.has(path));
  if (missing.length) throw new Error(`Missing required release files: ${missing.join(", ")}`);
}

export function releaseVersionFromTag(tag) {
  if (typeof tag !== "string" || !tag.startsWith("v") || !VERSION_PATTERN.test(tag.slice(1))) {
    throw new Error("Release metadata has no valid v<version> tag. Existing program files were not changed.");
  }
  return tag.slice(1);
}

export function assertReleaseVersions(readText, expectedVersion) {
  const readJson = (path) => {
    try {
      return JSON.parse(readText(path));
    } catch {
      throw new Error(`Cannot read valid release JSON: ${path}`);
    }
  };
  const packageJson = readJson("package.json");
  const lock = readJson("package-lock.json");
  const version = packageJson?.version;
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    throw new Error("package.json has no valid release version.");
  }
  let sourceVersion;
  try {
    sourceVersion = readText("src/version.ts").match(/^\s*export\s+const\s+APP_VERSION\s*=\s*(["'])([^"']+)\1\s*;/m)?.[2];
  } catch {
    throw new Error("Cannot read release file: src/version.ts");
  }
  if (lock?.version !== version || lock?.packages?.[""]?.version !== version || sourceVersion !== version) {
    throw new Error("Release versions disagree: package.json, package-lock.json and src/version.ts must match.");
  }
  if (expectedVersion !== undefined && version !== expectedVersion) {
    throw new Error("Archive version does not match the GitHub Release tag. Existing program files were not changed.");
  }
  return version;
}
