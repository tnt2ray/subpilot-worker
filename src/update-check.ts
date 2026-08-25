import { APP_VERSION, RELEASE_REPOSITORY } from "./version";
import { fetchWithTimeout } from "./upstream-fetch";
import { readResponseTextWithLimit } from "./util";

const UPDATE_CHECK_KEY = "stats:updateCheck:latest";
const UPDATE_CHECK_NOTIFIED_KEY = "stats:updateCheck:notifiedVersion";
const UPDATE_CHECK_CACHE_SECONDS = 24 * 60 * 60;
const UPDATE_CHECK_TIMEOUT_MS = 5_000;
const MAX_UPDATE_RESPONSE_BYTES = 64 * 1024;
const RELEASE_BASE_URL = `https://github.com/${RELEASE_REPOSITORY}/releases/`;

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
  let status: UpdateStatus;
  try {
    const latest = await fetchLatestRelease();
    status = {
      currentVersion: APP_VERSION,
      latestVersion: latest.version,
      updateAvailable: compareVersions(latest.version, APP_VERSION) > 0,
      releaseUrl: latest.url,
      checkedAt,
      error: null
    };
  } catch (error) {
    status = {
      currentVersion: APP_VERSION,
      latestVersion: normalizeVersion(cached?.latestVersion),
      updateAvailable: cached ? compareVersions(normalizeVersion(cached.latestVersion) || APP_VERSION, APP_VERSION) > 0 : false,
      releaseUrl: normalizeReleaseUrl(cached?.releaseUrl),
      checkedAt,
      error: error instanceof Error ? error.message : String(error)
    };
  }
  // The update result is still useful if the non-critical cache write fails.
  // Keeping the write outside the fetch try/catch also prevents an immediate
  // retry to the same KV key, which would violate KV's one-write-per-second
  // limit and obscure a successful GitHub response as a fetch error.
  await storeUpdateStatus(env, status).catch(logUpdateCacheWriteFailure);
  return status;
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
    releaseUrl: normalizeReleaseUrl(stored?.releaseUrl),
    checkedAt: typeof stored?.checkedAt === "string" ? stored.checkedAt : null,
    error: typeof stored?.error === "string" ? stored.error : null
  };
}

function isFreshCheck(checkedAt: unknown): boolean {
  if (typeof checkedAt !== "string") return false;
  const time = Date.parse(checkedAt);
  const age = Date.now() - time;
  return Number.isFinite(time) && age >= 0 && age < UPDATE_CHECK_CACHE_SECONDS * 1000;
}

function logUpdateCacheWriteFailure(error: unknown): void {
  console.warn(JSON.stringify({
    level: "warn",
    message: `Update status cache write failed: ${error instanceof Error ? error.message : String(error)}`
  }));
}

async function fetchLatestRelease(): Promise<{ version: string; url: string }> {
  try {
    return await fetchLatestReleaseFromApi();
  } catch (apiError) {
    try {
      return await fetchLatestReleaseFromRedirect();
    } catch (fallbackError) {
      throw new Error([
        apiError instanceof Error ? apiError.message : String(apiError),
        fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
      ].join("; "));
    }
  }
}

async function fetchLatestReleaseFromApi(): Promise<{ version: string; url: string }> {
  return fetchWithTimeout(globalThis.fetch, `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": `SubPilot/${APP_VERSION}`
    }
  }, UPDATE_CHECK_TIMEOUT_MS, async (response) => {
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`GitHub release check failed: HTTP ${response.status}`);
    }
    const text = await readResponseTextWithLimit(response, MAX_UPDATE_RESPONSE_BYTES, "GitHub release response");
    let body: { tag_name?: unknown; html_url?: unknown };
    try {
      body = JSON.parse(text) as { tag_name?: unknown; html_url?: unknown };
    } catch {
      throw new Error("GitHub latest release returned invalid JSON");
    }
    const version = normalizeVersion(body.tag_name);
    if (!version) throw new Error("GitHub latest release has no valid tag_name");
    return {
      version,
      url: normalizeReleaseUrl(body.html_url) ?? `${RELEASE_BASE_URL}latest`
    };
  });
}

async function fetchLatestReleaseFromRedirect(): Promise<{ version: string; url: string }> {
  return fetchWithTimeout(globalThis.fetch, `${RELEASE_BASE_URL}latest`, {
    redirect: "follow",
    headers: {
      accept: "text/html",
      "user-agent": `SubPilot/${APP_VERSION}`
    }
  }, UPDATE_CHECK_TIMEOUT_MS, async (response) => {
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) throw new Error(`GitHub release redirect check failed: HTTP ${response.status}`);

    const releaseUrl = normalizeReleaseUrl(response.url);
    if (!releaseUrl) throw new Error("GitHub release redirect returned an untrusted URL");
    const version = normalizeVersion(releaseUrl.match(/\/releases\/tag\/([^/?#]+)/)?.[1]);
    if (!version) throw new Error("GitHub release redirect has no valid tag");
    return { version, url: releaseUrl };
  });
}

function normalizeReleaseUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const expectedPrefix = `/${RELEASE_REPOSITORY}/releases/`;
    if (url.protocol !== "https:" || url.hostname !== "github.com" || !url.pathname.startsWith(expectedPrefix)) return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
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
