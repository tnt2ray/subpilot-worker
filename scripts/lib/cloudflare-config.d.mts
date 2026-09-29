import type {
  AssetsBinding,
  CloudflareConfig,
  KvBinding,
  RateLimitBinding,
  SecretBinding,
  WorkerConfig,
} from "cf/config";

/** Known SubPilot bindings, preserving their types for cf's generated Env. */
export type SubPilotWorkerConfig = Omit<WorkerConfig, "env"> & {
  env: {
    ASSETS: AssetsBinding;
    SUBPILOT_CONFIG: KvBinding;
    LOGIN_RATE_LIMITER?: RateLimitBinding;
    ADMIN_TOKEN_HASH: SecretBinding;
    CONFIG_ENCRYPTION_KEY: SecretBinding;
  };
};

export type SubPilotCloudflareConfig = Omit<CloudflareConfig, "worker"> & {
  worker: SubPilotWorkerConfig;
};

export const CONFIG_PATH: "cloudflare.local.json";
export const TEMPLATE_PATH: "cloudflare.example.json";

export function readConfig(path?: string): SubPilotCloudflareConfig;
export function writeConfig(config: SubPilotCloudflareConfig): void;
export function ensureConfigFile(options?: { existingConfigOnly?: boolean }): boolean;
