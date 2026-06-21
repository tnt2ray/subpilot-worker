#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const forbidden = [
  { label: "tracked local Wrangler config", filePattern: /^wrangler\.jsonc$/ },
  { label: "tracked local dev secret file", filePattern: /^\.dev\.vars$/ },
  { label: "private key material", pattern: /BEGIN (RSA |EC |OPENSSH |PRIVATE )?PRIVATE KEY/ },
  { label: "OpenAI-style API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { label: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/ }
];

const listed = spawnSync("git", ["ls-files"], { encoding: "utf8" });
if (listed.status !== 0) {
  process.stderr.write(listed.stderr || "Failed to list tracked files.\n");
  process.exit(listed.status ?? 1);
}

const findings = [];
for (const file of listed.stdout.split("\n").filter(Boolean)) {
  for (const item of forbidden) {
    if (item.filePattern?.test(file)) {
      findings.push(`${file}: ${item.label}`);
    }
  }
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const lines = content.split(/\r?\n/);
  for (const item of forbidden.filter((entry) => entry.pattern)) {
    lines.forEach((line, index) => {
      if (item.pattern.test(line)) {
        findings.push(`${file}:${index + 1}: ${item.label}`);
      }
    });
  }
}

if (findings.length > 0) {
  process.stderr.write(`Public safety scan failed:\n${findings.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write("Public safety scan passed.\n");
