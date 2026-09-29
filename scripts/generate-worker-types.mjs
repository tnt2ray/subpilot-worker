#!/usr/bin/env node

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { runCf } from "./lib/cloudflare-cli.mjs";
import { CONFIG_PATH } from "./lib/cloudflare-config.mjs";

const outputFile = ".cloudflare/types/index.d.ts";

rmSync(outputFile, { force: true });

runCf(["workers", "types", ...(!existsSync(CONFIG_PATH) ? ["--mode", "template"] : [])]);

const generatedTypes = readFileSync(outputFile, "utf8");
writeFileSync(outputFile, generatedTypes.replace(/[ \t]+$/gm, ""));
