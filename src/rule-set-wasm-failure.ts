import type { CompiledRuleSetManifest } from "./rule-set-cache";
import type { Target } from "./types";

const FAILURE_PREFIX = "cache:ruleSetWasmFailure:";
const FAILURE_EXPIRATION_SECONDS = 24 * 60 * 60;

function failureKey(target: Target, fingerprint: string): string {
  // Fingerprints are SHA-256 digests; no output names or source URLs are stored.
  return `${FAILURE_PREFIX}${target}:${fingerprint}`;
}

export async function readWasmCompilationFailure(env: Env, target: Target, fingerprint: string): Promise<number> {
  const failedAt = Number(await env.SUBPILOT_CONFIG.get(failureKey(target, fingerprint), "json"));
  return Number.isFinite(failedAt) && failedAt > 0 && Date.now() - failedAt < FAILURE_EXPIRATION_SECONDS * 1000
    ? failedAt : 0;
}

export function wasmCompilationFailureUnresolved(
  failedAt: number,
  manifest: Pick<CompiledRuleSetManifest, "updatedAt"> | null
): boolean {
  return failedAt > 0 && !(manifest && Date.parse(manifest.updatedAt) > failedAt);
}

export async function recordWasmCompilationFailure(env: Env, target: Target, fingerprint: string): Promise<void> {
  try {
    await env.SUBPILOT_CONFIG.put(failureKey(target, fingerprint), JSON.stringify(Date.now()), {
      expirationTtl: FAILURE_EXPIRATION_SECONDS
    });
  } catch {
    console.warn(JSON.stringify({ level: "warn", message: "WASM compilation failure state could not be persisted." }));
  }
}
