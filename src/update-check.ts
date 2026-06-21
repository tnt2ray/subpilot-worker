import { APP_VERSION, RELEASE_REPOSITORY } from "./version";

const UPDATE_CHECK_KEY = "stats:updateCheck:latest";
const UPDATE_CHECK_NOTIFIED_KEY = "stats:updateCheck:notifiedVersion";
const UPDATE_CHECK_CACHE_SECONDS = 24 * 60 * 60;

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  checkedAt: string | null;
  error: string | null;
}

interface StoredUpdateStatus {
  latestVersion?: unknown;
  releaseUrl?: unknown;
  checkedAt?: unknown;
  error?: unknown;
}

export async function readCachedUpdateStatus(env: Env): Promise<UpdateStatus> {
  return normalizeStoredUpdateStatus(await readStoredUpdateStatus(env));
}

export async function getUpdateStatus(env: Env, options: { force?: boolean } = {}): Promise<UpdateStatus> {
  const cached = await readStoredUpdateStatus(env);
  if (!options.force && cached && isFreshCheck(cached.checkedAt)) {
    return normalizeStoredUpdateStatus(cached);
  }

  const checkedAt = new Date().toISOString();
  try {
    const latest = await fetchLatestRelease();
    const status: UpdateStatus = {
      currentVersion: APP_VERSION,
      latestVersion: latest.version,
      updateAvailable: compareVersions(latest.version, APP_VERSION) > 0,
      releaseUrl: latest.url,
      checkedAt,
      error: null
    };
    await storeUpdateStatus(env, status);
    return status;
  } catch (error) {
    const status: UpdateStatus = {
      currentVersion: APP_VERSION,
      latestVersion: normalizeVersion(cached?.latestVersion),
      updateAvailable: cached ? compareVersions(normalizeVersion(cached.latestVersion) || APP_VERSION, APP_VERSION) > 0 : false,
      releaseUrl: typeof cached?.releaseUrl === "string" ? cached.releaseUrl : null,
      checkedAt,
      error: error instanceof Error ? error.message : String(error)
    };
    await storeUpdateStatus(env, status);
    return status;
  }
}

export async function readNotifiedUpdateVersion(env: Env): Promise<string | null> {
  return env.SUBPILOT_CONFIG.get(UPDATE_CHECK_NOTIFIED_KEY);
}

export async function storeNotifiedUpdateVersion(env: Env, version: string): Promise<void> {
  await env.SUBPILOT_CONFIG.put(UPDATE_CHECK_NOTIFIED_KEY, version);
}

async function readStoredUpdateStatus(env: Env): Promise<StoredUpdateStatus | null> {
  const raw = await env.SUBPILOT_CONFIG.get(UPDATE_CHECK_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredUpdateStatus;
  } catch {
    return null;
  }
}

async function storeUpdateStatus(env: Env, status: UpdateStatus): Promise<void> {
  await env.SUBPILOT_CONFIG.put(UPDATE_CHECK_KEY, JSON.stringify(status));
}

function normalizeStoredUpdateStatus(stored: StoredUpdateStatus | null): UpdateStatus {
  const latestVersion = normalizeVersion(stored?.latestVersion);
  return {
    currentVersion: APP_VERSION,
    latestVersion,
    updateAvailable: latestVersion ? compareVersions(latestVersion, APP_VERSION) > 0 : false,
    releaseUrl: typeof stored?.releaseUrl === "string" ? stored.releaseUrl : null,
    checkedAt: typeof stored?.checkedAt === "string" ? stored.checkedAt : null,
    error: typeof stored?.error === "string" ? stored.error : null
  };
}

function isFreshCheck(checkedAt: unknown): boolean {
  if (typeof checkedAt !== "string") return false;
  const time = Date.parse(checkedAt);
  return Number.isFinite(time) && Date.now() - time < UPDATE_CHECK_CACHE_SECONDS * 1000;
}

async function fetchLatestRelease(): Promise<{ version: string; url: string }> {
  const response = await fetch(`https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": `SubPilot/${APP_VERSION}`
    }
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`GitHub release check failed: HTTP ${response.status}`);
  }
  const body = await response.json() as { tag_name?: unknown; html_url?: unknown };
  const version = normalizeVersion(body.tag_name);
  if (!version) throw new Error("GitHub latest release has no valid tag_name");
  return {
    version,
    url: typeof body.html_url === "string" ? body.html_url : `https://github.com/${RELEASE_REPOSITORY}/releases/latest`
  };
}

function normalizeVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^v/i, "");
  return /^\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?$/.test(trimmed) ? trimmed : null;
}

function compareVersions(left: string, right: string): number {
  const leftParts = numericVersionParts(left);
  const rightParts = numericVersionParts(right);
  for (let index = 0; index < 3; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function numericVersionParts(version: string): number[] {
  return version.split(/[+-]/)[0]!.split(".").map((part) => Number.parseInt(part, 10) || 0);
}
