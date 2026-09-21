#!/usr/bin/env node
import { build } from "esbuild";
await build({
  entryPoints: ["src/actions-compiler-runtime.ts"], outfile: "dist/actions-compiler-runtime.mjs",
  bundle: true, platform: "node", format: "esm", target: "node22", minify: true, legalComments: "inline",
  // Bundled CommonJS dependencies still load Node built-ins through require.
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' }
});
