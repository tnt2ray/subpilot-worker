#!/usr/bin/env node
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const kernel = await readFile("src/vendor/singbox/srs-compiler.wasm");
const kernelSha256 = (await readFile("src/vendor/singbox/srs-compiler.wasm.sha256", "utf8")).trim().split(/\s+/, 1)[0];
if (!/^[a-f0-9]{64}$/.test(kernelSha256 ?? "") || createHash("sha256").update(kernel).digest("hex") !== kernelSha256) {
  throw new Error("The packaged rule kernel does not match its checksum.");
}
if (kernel.byteLength > 25 * 1024 * 1024) throw new Error("The rule kernel exceeds the static asset size limit.");
await build({
  entryPoints: ["src/actions-compiler-runtime.ts"], outfile: "dist/actions-compiler-runtime.mjs",
  bundle: true, platform: "node", format: "esm", target: "node22", minify: true, legalComments: "inline",
  define: { __RULE_KERNEL_SHA256__: JSON.stringify(kernelSha256) },
  // Bundled CommonJS dependencies still load Node built-ins through require.
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' }
});
await mkdir("public/vendor", { recursive: true });
await writeFile("public/vendor/rule-kernel.wasm", kernel);
