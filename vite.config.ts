import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { buildActionsCompiler } from "./scripts/build-actions-compiler.mjs";

export default defineConfig(async () => {
  await buildActionsCompiler();
  return {
    plugins: [cloudflare({ remoteBindings: false, inspectorPort: false })],
    server: { fs: { deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/cloudflare.local.json", "**/wrangler.jsonc"] } },
  };
});
