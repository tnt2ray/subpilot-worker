export const ACTIONS_CREDENTIALS_KEY = "integration:actions-compiler:credentials:v1";
export const ACTIONS_CALLBACK_ORIGIN_KEY = "integration:actions-compiler:callback-origin:v1";

const RECORD_KEYS = {
  credentials: {
    current: ACTIONS_CREDENTIALS_KEY,
    migratedV233: "integration:actions-compiler:migrated-v233-credentials:v1",
    migrated: "integration:actions-compiler:migrated-credentials:v1",
    legacy: "integration:singbox-srs:credentials:v1"
  },
  callbackOrigin: {
    current: ACTIONS_CALLBACK_ORIGIN_KEY,
    migratedV233: "integration:actions-compiler:migrated-v233-callback-origin:v1",
    migrated: "integration:actions-compiler:migrated-callback-origin:v1",
    legacy: "integration:singbox-srs:callback-origin:v1"
  }
} as const;

/** Read existing encrypted records without copying, deleting, or returning their contents to the client. */
export async function readActionsIntegrationRecord(env: Env, kind: keyof typeof RECORD_KEYS): Promise<string | null> {
  const keys = RECORD_KEYS[kind];
  for (const key of [keys.current, keys.migratedV233, keys.migrated]) {
    const stored = await env.SUBPILOT_CONFIG.get(key);
    // A present record is authoritative, including cleared or invalid credentials.
    // The caller validates it; only absence permits trying an older location.
    if (stored !== null) return stored;
  }
  const rawState = await env.SUBPILOT_CONFIG.get("integration:actions-compiler:migration:v1");
  if (rawState !== null) {
    let state: unknown;
    try { state = JSON.parse(rawState); }
    catch { throw new Error("旧 Actions 迁移状态无法读取，请检查存储后重试。"); }
    if (!state || typeof state !== "object" || Array.isArray(state)
      || !("version" in state) || state.version !== 1
      || !("phase" in state) || typeof state.phase !== "string"
      || !["copy", "grace", "cleanup", "done"].includes(state.phase)) {
      throw new Error("旧 Actions 迁移状态无效，请检查存储后重试。");
    }
    if (state.phase === "done") return null;
  }
  return env.SUBPILOT_CONFIG.get(keys.legacy);
}
