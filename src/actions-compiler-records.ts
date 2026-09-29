export const ACTIONS_CREDENTIALS_KEY = "integration:actions-compiler:credentials:v1";
export const ACTIONS_CALLBACK_ORIGIN_KEY = "integration:actions-compiler:callback-origin:v1";

const RECORD_KEYS = {
  credentials: ACTIONS_CREDENTIALS_KEY,
  callbackOrigin: ACTIONS_CALLBACK_ORIGIN_KEY
} as const;

/** Legacy records are moved by the explicit migration tool, never by ordinary reads. */
export async function readActionsIntegrationRecord(env: Env, kind: keyof typeof RECORD_KEYS): Promise<string | null> {
  return env.SUBPILOT_CONFIG.get(RECORD_KEYS[kind]);
}
