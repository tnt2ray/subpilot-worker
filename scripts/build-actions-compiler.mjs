#!/usr/bin/env node
import { build } from "esbuild";
import { pathToFileURL } from "node:url";

export async function buildActionsCompiler() {
  await build({
    entryPoints: ["src/actions-compiler-runtime.ts"], outfile: ".subpilot-build/actions-compiler-runtime.mjs",
    bundle: true, platform: "node", format: "esm", target: "node22", minify: true, legalComments: "inline",
    // Bundled CommonJS dependencies still load Node built-ins through require.
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await buildActionsCompiler();
