#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";

const entry = "scripts/codemirror6-entry.js";
const outfile = "public/vendor/codemirror/codemirror.js";

mkdirSync(dirname(outfile), { recursive: true });

const result = spawnSync("node_modules/.bin/esbuild", [
  entry,
  "--bundle",
  "--format=iife",
  "--target=es2022",
  "--legal-comments=none",
  "--minify",
  `--outfile=${outfile}`
], {
  stdio: "inherit"
});

if (result.status !== 0) process.exit(result.status ?? 1);

writeFileSync(
  "public/vendor/codemirror/codemirror.css",
  "/* CodeMirror 6 injects its base styles from JavaScript. Project-specific editor styles live in /styles.css. */\n"
);
