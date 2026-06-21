#!/usr/bin/env node

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const outputFile = "worker-configuration.d.ts";
const configPath = existsSync("wrangler.jsonc") ? "wrangler.jsonc" : "wrangler.example.jsonc";

rmSync(outputFile, { force: true });

const result = spawnSync("wrangler", ["types", outputFile, "--config", configPath], {
  stdio: "inherit"
});

if (result.status !== 0) process.exit(result.status ?? 1);

const generatedTypes = readFileSync(outputFile, "utf8");
writeFileSync(outputFile, generatedTypes.replace(/[ \t]+$/gm, ""));
