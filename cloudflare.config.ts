import { defineConfig } from "cf/config";
import { readConfig, CONFIG_PATH, TEMPLATE_PATH } from "./scripts/lib/cloudflare-config.mjs";
import type { SubPilotCloudflareConfig } from "./scripts/lib/cloudflare-config.mjs";

// "example" would also load .dev.vars.example as real local secrets.
export default defineConfig(({ mode }): SubPilotCloudflareConfig => readConfig(mode === "template" ? TEMPLATE_PATH : CONFIG_PATH));
