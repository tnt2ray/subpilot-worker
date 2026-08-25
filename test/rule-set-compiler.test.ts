import YAML from "yaml";
import { describe, expect, it, vi } from "vitest";
import { createSession, sessionCookie } from "../src/auth";
import { validateRuleSetOutputNames } from "../src/config-validation";
import { compileRuleSetOutput, ensureCompiledRuleSet, refreshChangedRuleSetCaches, refreshRuleSetCaches } from "../src/rule-set-compiler";
import {
  compiledRuleSetContentKey,
  compiledRuleSetMetaKey,
  fetchCachedRuleSetSource,
  pruneCompiledRuleSetCaches,
  readCompiledRuleSetBucket,
  readCompiledRuleSetManifest,
  ruleSetSourceCacheKey
} from "../src/rule-set-cache";
import { normalizeConfig, saveConfig } from "../src/config-store";
import { DEFAULT_CONFIG } from "../src/default-config";
import { generateConfig } from "../src/generator";
import { planRuleSetArtifacts } from "../src/rule-set-artifacts";
import { compiledRuleProviderName } from "../src/rule-provider-name";
import worker from "../src/index";
import { sha256Hex } from "../src/util";
import { makeEnv, makeTestEnv } from "./helpers/env";
import { ctx, makeExecutionContext } from "./helpers/worker";
import { restoreMocksAfterEach } from "./helpers/fetch";

restoreMocksAfterEach();

const ENCRYPTED_CACHE_STORAGE_PREFIX = "\u001fsubpilot-encrypted-cache:";

function compiledConfig() {
  return normalizeConfig({
    ...DEFAULT_CONFIG,
    groups: {
      Proxy: "select",
      Static: "select",
      DIRECT: "select"
    },
    surge: {
      ...DEFAULT_CONFIG.surge,
      rules: ["DOMAIN-SUFFIX,manual.example,Proxy", "FINAL,Proxy"]
    },
    clash: {
      ...DEFAULT_CONFIG.clash,
      ruleProviders: "Legacy:\n  type: http\n  behavior: classical\n  url: https://legacy.example/rules.yaml",
      rules: ["DOMAIN-SUFFIX,manual.example,Proxy", "MATCH,Proxy"]
    },
    stash: {
      ...DEFAULT_CONFIG.stash,
      ruleProviders: "Legacy:\n  type: http\n  behavior: classical\n  url: https://legacy.example/rules.yaml",
      rules: ["DOMAIN-SUFFIX,manual.example,Proxy", "MATCH,Proxy"]
    },
    ruleSets: {
      mode: "compiled",
      aggregateByPolicy: false,
      sources: [{
        id: "surge-source",
        name: "Surge Source",
        url: "https://rules.example/surge.list",
        enabled: true,
        format: "surge-rule-set",
        order: 1
      }, {
        id: "clash-source",
        name: "Clash Source",
        url: "https://rules.example/clash.yaml",
        enabled: true,
        format: "clash-yaml",
        order: 2
      }],
      outputs: [{
        name: "AI",
        enabled: true,
        policy: "Proxy",
        sourceIds: ["surge-source", "clash-source"],
        inlineRules: [
          "DOMAIN-SUFFIX,inline.example,Proxy",
          "IP-CIDR6,2001:db8::/32,Proxy,no-resolve",
          "MATCH,Proxy"
        ],
        order: 10,
        surgeOptions: []
      }],
      directRules: [{
        id: "geoip-cn",
        name: "CN",
        enabled: true,
        rule: "GEOIP,CN,DIRECT",
        policy: "DIRECT",
        order: 1
      }, {
        id: "final",
        name: "Final",
        enabled: true,
        rule: "FINAL,Proxy",
        policy: "DIRECT",
        order: 0
      }]
    }
  });
}

function mockRuleSetFetches() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (String(url) === "https://rules.example/surge.list") {
      return new Response([
        "DOMAIN-SUFFIX,example.com,Proxy",
        "IP-CIDR,1.1.1.0/24,no-resolve",
        "PROCESS-NAME,Telegram,DIRECT",
        "DOMAIN-SUFFIX,dup.example"
      ].join("\n"));
    }
    if (String(url) === "https://rules.example/clash.yaml") {
      return new Response([
        "payload:",
        "  - DOMAIN-SUFFIX,example.com",
        "  - DOMAIN,api.example.com",
        "  - IP-CIDR,8.8.8.0/24"
      ].join("\n"));
    }
    return new Response("not found", { status: 404 });
  });
}

function installFakeWorkerCache() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "caches");
  const store = new Map<string, Response>();
  const cache = {
    match: vi.fn(async (request: RequestInfo | URL) => {
      const cached = store.get(new Request(request).url);
      return cached ? cached.clone() : undefined;
    }),
    put: vi.fn(async (request: RequestInfo | URL, response: Response) => {
      store.set(new Request(request).url, response.clone());
    })
  };
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: cache }
  });
  return {
    store,
    match: cache.match,
    put: cache.put,
    restore: () => {
      if (previous) {
        Object.defineProperty(globalThis, "caches", previous);
      } else {
        delete (globalThis as { caches?: CacheStorage }).caches;
      }
    }
  };
}

function enforceSameKeyMutationInterval(env: Env, now: () => number = Date.now): {
  mutations: Array<{ key: string; kind: "put" | "delete"; at: number }>;
} {
  const originalPut = env.SUBPILOT_CONFIG.put.bind(env.SUBPILOT_CONFIG);
  const originalDelete = env.SUBPILOT_CONFIG.delete.bind(env.SUBPILOT_CONFIG);
  const lastMutation = new Map<string, number>();
  const mutations: Array<{ key: string; kind: "put" | "delete"; at: number }> = [];
  const record = (key: string, kind: "put" | "delete") => {
    const at = now();
    const previous = lastMutation.get(key);
    if (previous !== undefined && at - previous < 1_000) {
      throw new Error(`KV same-key mutation limit for ${key}`);
    }
    lastMutation.set(key, at);
    mutations.push({ key, kind, at });
  };
  vi.spyOn(env.SUBPILOT_CONFIG, "put").mockImplementation(async (...args) => {
    record(String(args[0]), "put");
    return originalPut(...args);
  });
  vi.spyOn(env.SUBPILOT_CONFIG, "delete").mockImplementation(async (key) => {
    record(String(key), "delete");
    return originalDelete(key);
  });
  return { mutations };
}

describe("rule set compiler", () => {
  it("self-heals corrupt encrypted rule-source cache content with one same-key write", async () => {
    const env = makeEnv();
    const source = {
      id: "corrupt",
      name: "Corrupt",
      url: "https://rules.example/corrupt.list",
      enabled: true,
      format: "surge-rule-set" as const,
      order: 1
    };
    const key = await ruleSetSourceCacheKey(source.url);
    await env.SUBPILOT_CONFIG.put(key, `${ENCRYPTED_CACHE_STORAGE_PREFIX}not-an-envelope`);
    const content = "DOMAIN-SUFFIX,fresh.example";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(content));
    const deleteSpy = vi.spyOn(env.SUBPILOT_CONFIG, "delete");
    const putSpy = vi.spyOn(env.SUBPILOT_CONFIG, "put");

    await expect(fetchCachedRuleSetSource(env, source)).resolves.toMatchObject({
      content,
      usedCachedContent: false
    });

    expect(deleteSpy).not.toHaveBeenCalledWith(key);
    expect(putSpy.mock.calls.filter(([storedKey]) => storedKey === key)).toHaveLength(1);
  });

  it("force-refreshes legacy plaintext source cache with only one same-key write", async () => {
    const { env, kv } = makeTestEnv();
    const source = {
      id: "legacy-plaintext",
      name: "Legacy plaintext",
      url: "https://rules.example/legacy-plaintext.list",
      enabled: true,
      format: "surge-rule-set" as const,
      order: 1
    };
    const key = await ruleSetSourceCacheKey(source.url);
    kv.set(key, "DOMAIN-SUFFIX,stale.example");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("DOMAIN-SUFFIX,fresh.example"));
    const guard = enforceSameKeyMutationInterval(env);

    await expect(fetchCachedRuleSetSource(env, source, { forceRefresh: true })).resolves.toMatchObject({
      content: "DOMAIN-SUFFIX,fresh.example",
      usedCachedContent: false
    });

    expect(guard.mutations.filter((mutation) => mutation.key === key)).toEqual([
      expect.objectContaining({ key, kind: "put" })
    ]);
    expect(String(kv.get(key))).toMatch(new RegExp(`^${ENCRYPTED_CACHE_STORAGE_PREFIX}`));
  });

  it("rejects HTML rule source responses without retrying or parsing page content", async () => {
    const base = compiledConfig();
    const source = base.ruleSets.sources[0]!;
    const config = normalizeConfig({
      ...base,
      ruleSets: {
        ...base.ruleSets,
        sources: [source],
        outputs: [{
          ...base.ruleSets.outputs[0]!,
          sourceIds: [source.id],
          inlineRules: []
        }],
        directRules: []
      }
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html><body>GitHub</body></html>", {
      headers: { "content-type": "text/html; charset=utf-8" }
    }));

    await expect(compileRuleSetOutput(makeEnv(), config, config.ruleSets.outputs[0]!))
      .rejects.toThrow("规则来源返回了 HTML 页面，请改用原始规则文件 URL");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("merges sources and inline rules, dedupes exactly, buckets by type, and caches rendered outputs", async () => {
    const fetchMock = mockRuleSetFetches();
    const env = makeEnv();
    const config = compiledConfig();
    const output = config.ruleSets.outputs[0]!;

    const result = await compileRuleSetOutput(env, config, output);

    expect(fetchMock.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true);
    expect(result.stale).toBe(false);
    expect(result.manifest.ruleCount).toBe(8);
    expect(result.manifest.duplicateCount).toBe(1);
    expect(result.manifest.buckets.map((bucket) => [bucket.bucket, bucket.count])).toEqual([
      ["domain", 4],
      ["ipcidr", 3],
      ["classical", 1]
    ]);
    expect(result.manifest.warnings.join("\n")).toContain("MATCH 应作为主配置规则保存");
    expect(result.manifest.warnings.join("\n")).toContain("可能已被前面的 DOMAIN-SUFFIX 覆盖");

    await expect(readCompiledRuleSetBucket(env, "AI", "domain", "surge")).resolves.toContain(".example.com");
    const clashDomain = YAML.parse(String(await readCompiledRuleSetBucket(env, "AI", "domain", "clash"))) as { payload: string[] };
    expect(clashDomain.payload).toContain("+.example.com");
    expect(clashDomain.payload).toContain("api.example.com");
    const clashClassical = YAML.parse(String(await readCompiledRuleSetBucket(env, "AI", "classical", "clash"))) as { payload: string[] };
    expect(clashClassical.payload).toContain("PROCESS-NAME,Telegram");
    const surgeCombined = String(await readCompiledRuleSetBucket(env, "AI", "combined", "surge"));
    expect(surgeCombined).toContain("DOMAIN-SUFFIX,example.com");
    expect(surgeCombined).toContain("IP-CIDR,1.1.1.0/24,no-resolve");
    expect(surgeCombined).toContain("PROCESS-NAME,Telegram");
    const clashCombined = YAML.parse(String(await readCompiledRuleSetBucket(env, "AI", "combined", "clash"))) as { payload: string[] };
    expect(clashCombined.payload).toContain("DOMAIN-SUFFIX,example.com");
    expect(clashCombined.payload).toContain("IP-CIDR,1.1.1.0/24,no-resolve");
    expect(clashCombined.payload).toContain("PROCESS-NAME,Telegram");
    expect(planRuleSetArtifacts([
      { bucket: "domain", count: 1001 },
      { bucket: "ipcidr", count: 1 },
      { bucket: "classical", count: 0 }
    ], "surge")).toEqual([
      { bucket: "domain", behavior: "domain", includesDomains: true, includesIpCidr: false },
      { bucket: "combined", behavior: "classical", includesDomains: false, includesIpCidr: true }
    ]);
    expect(planRuleSetArtifacts([
      { bucket: "domain", count: 1001 },
      { bucket: "ipcidr", count: 1001 },
      { bucket: "classical", count: 1 }
    ], "stash")).toEqual([
      { bucket: "domain", behavior: "domain", includesDomains: true, includesIpCidr: false },
      { bucket: "ipcidr", behavior: "ipcidr", includesDomains: false, includesIpCidr: true },
      { bucket: "combined", behavior: "classical", includesDomains: false, includesIpCidr: false }
    ]);
  });

  it("preserves Clash domain-provider wildcard semantics and diagnoses Surge filtering", async () => {
    const base = compiledConfig();
    const source = {
      id: "clash-domain-patterns",
      name: "Clash domain patterns",
      url: "https://rules.example/clash-domain-patterns.yaml",
      enabled: true,
      format: "clash-yaml" as const,
      order: 1
    };
    const config = normalizeConfig({
      ...base,
      ruleSets: {
        ...base.ruleSets,
        sources: [source],
        outputs: [{
          ...base.ruleSets.outputs[0]!,
          sourceIds: [source.id],
          inlineRules: []
        }],
        directRules: []
      }
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(YAML.stringify({
      behavior: "domain",
      payload: ["example.com", ".example.com", "+.example.com", "*.example.com"]
    })));
    const env = makeEnv();

    const result = await compileRuleSetOutput(env, config, config.ruleSets.outputs[0]!);

    expect(result.manifest.buckets).toEqual([
      expect.objectContaining({
        bucket: "domain",
        count: 4,
        targetCounts: { surge: 2, clash: 4, stash: 4 }
      })
    ]);
    expect(result.manifest.warnings.join("\n")).toContain(
      "Clash domain-provider 模式 不受 Surge 支持，已从该目标规则集过滤（共 2 条）"
    );

    const clashDomain = YAML.parse(String(await readCompiledRuleSetBucket(env, "AI", "domain", "clash"))) as { payload: string[] };
    expect(clashDomain.payload).toEqual(["example.com", ".example.com", "+.example.com", "*.example.com"]);
    const stashDomain = YAML.parse(String(await readCompiledRuleSetBucket(env, "AI", "domain", "stash"))) as { payload: string[] };
    expect(stashDomain.payload).toEqual(clashDomain.payload);

    const surgeCombined = String(await readCompiledRuleSetBucket(env, "AI", "combined", "surge"));
    expect(surgeCombined).toBe("DOMAIN,example.com\nDOMAIN-SUFFIX,example.com\n");
    const clashCombined = YAML.parse(String(await readCompiledRuleSetBucket(env, "AI", "combined", "clash"))) as { payload: string[] };
    expect(clashCombined.payload).toEqual([
      "DOMAIN,example.com",
      "DOMAIN-REGEX,^([^.]+\\.)+example\\.com$",
      "DOMAIN-SUFFIX,example.com",
      "DOMAIN-REGEX,^[^.]+\\.example\\.com$"
    ]);
  });

  it("recompiles legacy manifests when compiler semantics change", async () => {
    const env = makeEnv();
    const base = compiledConfig();
    const output = {
      ...base.ruleSets.outputs[0]!,
      sourceIds: [],
      inlineRules: ["example.com"]
    };
    const config = normalizeConfig({
      ...base,
      ruleSets: {
        ...base.ruleSets,
        sources: [],
        outputs: [output]
      }
    });
    const normalizedOutput = config.ruleSets.outputs[0]!;
    const legacyFingerprint = JSON.stringify({
      policy: normalizedOutput.policy,
      sourceIds: normalizedOutput.sourceIds,
      inlineRules: normalizedOutput.inlineRules,
      surgeOptions: normalizedOutput.surgeOptions
    });
    await env.SUBPILOT_CONFIG.put(compiledRuleSetMetaKey("AI"), JSON.stringify({
      outputName: "AI",
      outputFingerprint: legacyFingerprint,
      policy: "Proxy",
      updatedAt: "2026-07-10T12:00:00.000Z",
      sourceIds: [],
      ruleCount: 1,
      duplicateCount: 0,
      buckets: [{ bucket: "domain", count: 1, targets: ["surge", "clash", "stash"] }],
      warnings: []
    }));
    await env.SUBPILOT_CONFIG.put(compiledRuleSetContentKey("AI", "domain", "surge"), ".example.com\n");

    const manifest = await ensureCompiledRuleSet(env, config, normalizedOutput);

    expect(manifest.outputFingerprint).not.toBe(legacyFingerprint);
    await expect(readCompiledRuleSetBucket(env, "AI", "domain", "surge")).resolves.toBe("example.com\n");
  });

  it("round-trips versioned manifests when reading compiled buckets", async () => {
    const env = makeEnv();
    const base = compiledConfig();
    const config = normalizeConfig({
      ...base,
      ruleSets: {
        ...base.ruleSets,
        sources: [],
        outputs: [{
          ...base.ruleSets.outputs[0]!,
          sourceIds: [],
          inlineRules: ["DOMAIN,versioned.example"]
        }]
      }
    });

    const compiled = await compileRuleSetOutput(env, config, config.ruleSets.outputs[0]!);
    const manifest = await readCompiledRuleSetManifest(env, "AI");

    expect(compiled.manifest.storageId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(manifest?.storageId).toBe(compiled.manifest.storageId);
    await expect(readCompiledRuleSetBucket(env, "AI", "combined", "clash")).resolves.toContain("DOMAIN,versioned.example");
  });

  it("falls back to the previous complete manifest while a newer version is only partially visible", async () => {
    const { env, kv } = makeTestEnv();
    const base = compiledConfig();
    const firstOutput = {
      ...base.ruleSets.outputs[0]!,
      sourceIds: [],
      inlineRules: ["DOMAIN,first-visible.example"]
    };
    const firstConfig = normalizeConfig({
      ...base,
      ruleSets: { ...base.ruleSets, sources: [], outputs: [firstOutput] }
    });
    let now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const first = await compileRuleSetOutput(env, firstConfig, firstConfig.ruleSets.outputs[0]!);

    now += 1_000;
    const secondOutput = {
      ...firstConfig.ruleSets.outputs[0]!,
      inlineRules: ["DOMAIN,partially-visible.example"]
    };
    const secondConfig = normalizeConfig({
      ...firstConfig,
      ruleSets: { ...firstConfig.ruleSets, outputs: [secondOutput] }
    });
    const second = await compileRuleSetOutput(env, secondConfig, secondConfig.ruleSets.outputs[0]!);
    const missingKey = compiledRuleSetContentKey("AI", "combined", "clash", second.manifest.storageId);
    kv.delete(missingKey);

    const selected = await readCompiledRuleSetManifest(env, "AI");

    expect(selected?.storageId).toBe(first.manifest.storageId);
    await expect(readCompiledRuleSetBucket(env, "AI", "combined", "clash", selected!))
      .resolves.toContain("DOMAIN,first-visible.example");
  });

  it("leaves a failed publish append-only and garbage-collects its orphan after the grace period", async () => {
    const { env, kv } = makeTestEnv();
    const base = compiledConfig();
    const output = {
      ...base.ruleSets.outputs[0]!,
      sourceIds: [],
      inlineRules: ["DOMAIN,orphaned.example"]
    };
    const config = normalizeConfig({
      ...base,
      ruleSets: { ...base.ruleSets, sources: [], outputs: [output] }
    });
    let now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const originalPut = env.SUBPILOT_CONFIG.put.bind(env.SUBPILOT_CONFIG);
    const putSpy = vi.spyOn(env.SUBPILOT_CONFIG, "put").mockImplementation(async (...args) => {
      if (String(args[0]).startsWith(`${compiledRuleSetMetaKey("AI")}:v:`)) {
        throw new Error("injected manifest publish failure");
      }
      return originalPut(...args);
    });
    const deleteSpy = vi.spyOn(env.SUBPILOT_CONFIG, "delete");

    await expect(compileRuleSetOutput(env, config, config.ruleSets.outputs[0]!))
      .rejects.toThrow("injected manifest publish failure");
    expect(deleteSpy).not.toHaveBeenCalled();
    const contentPrefix = "cache:compiledRuleSet:AI:";
    const orphanKeys = [...kv.keys()].filter((key) => key.startsWith(contentPrefix));
    expect(orphanKeys.length).toBeGreaterThan(0);
    const orphanStorageId = orphanKeys[0]!.slice(contentPrefix.length).split(":", 1)[0]!;

    putSpy.mockRestore();
    now += 10 * 60 * 1000;
    await pruneCompiledRuleSetCaches(env, config);

    expect([...kv.keys()].some((key) => key.startsWith(`${contentPrefix}${orphanStorageId}:`))).toBe(false);
    expect(deleteSpy).toHaveBeenCalled();
  });

  it("does not delete recently published versions inside KV's same-key mutation window", async () => {
    const env = makeEnv();
    const base = compiledConfig();
    const output = {
      ...base.ruleSets.outputs[0]!,
      sourceIds: [],
      inlineRules: ["DOMAIN,recent.example"]
    };
    const config = normalizeConfig({
      ...base,
      ruleSets: { ...base.ruleSets, sources: [], outputs: [output] }
    });
    let now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const guard = enforceSameKeyMutationInterval(env, () => now);

    for (let index = 0; index < 6; index += 1) {
      await compileRuleSetOutput(env, config, config.ruleSets.outputs[0]!);
    }
    await pruneCompiledRuleSetCaches(env, config);

    expect(guard.mutations.filter((mutation) => mutation.kind === "delete")).toEqual([]);
  });

  it("bounds old compiled-version cleanup work per publish", async () => {
    const { env, kv } = makeTestEnv();
    const oldMetaKeys: string[] = [];
    for (let index = 0; index < 100; index += 1) {
      const timestamp = Date.now() - 24 * 60 * 60 * 1000 - index;
      const storageId = `${String(timestamp).padStart(16, "0")}-old${String(index).padStart(3, "0")}`;
      const metaKey = `${compiledRuleSetMetaKey("AI")}:v:${storageId}`;
      oldMetaKeys.push(metaKey);
      kv.set(metaKey, "{}");
      kv.set(compiledRuleSetContentKey("AI", "domain", "surge", storageId), "old");
    }
    const base = compiledConfig();
    const output = {
      ...base.ruleSets.outputs[0]!,
      sourceIds: [],
      inlineRules: ["DOMAIN,bounded-gc.example"]
    };
    const config = normalizeConfig({
      ...base,
      ruleSets: { ...base.ruleSets, sources: [], outputs: [output] }
    });
    const deleteSpy = vi.spyOn(env.SUBPILOT_CONFIG, "delete");

    await pruneCompiledRuleSetCaches(env, config);

    expect(deleteSpy.mock.calls.length).toBeLessThanOrEqual(4);
    expect(oldMetaKeys.filter((key) => kv.has(key))).toHaveLength(98);
  });

  it("garbage-collects repeated output-specific refreshes and bounds manifest listing", async () => {
    const { env, kv } = makeTestEnv();
    const base = compiledConfig();
    const config = normalizeConfig({
      ...base,
      ruleSets: {
        ...base.ruleSets,
        sources: [],
        outputs: [{
          ...base.ruleSets.outputs[0]!,
          sourceIds: [],
          inlineRules: ["DOMAIN,manual-refresh-0.example"]
        }]
      }
    });
    let now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const listSpy = vi.spyOn(env.SUBPILOT_CONFIG, "list");

    for (let index = 0; index < 8; index += 1) {
      now += 10 * 60 * 1000;
      config.ruleSets.outputs[0]!.inlineRules = [`DOMAIN,manual-refresh-${index}.example`];
      const result = await refreshRuleSetCaches(env, config, "AI");
      expect(result).toMatchObject({ refreshed: 1, failed: 0 });
    }

    const metaPrefix = `${compiledRuleSetMetaKey("AI")}:v:`;
    const headPrefix = `${compiledRuleSetMetaKey("AI")}:h:`;
    expect([...kv.keys()].filter((key) => key.startsWith(metaPrefix))).toHaveLength(3);
    expect([...kv.keys()].filter((key) => key.startsWith(headPrefix))).toHaveLength(3);

    const selected = await readCompiledRuleSetManifest(env, "AI");
    expect(selected).not.toBeNull();
    await expect(readCompiledRuleSetBucket(env, "AI", "combined", "clash", selected!))
      .resolves.toContain("DOMAIN,manual-refresh-7.example");

    const headListCalls = listSpy.mock.calls.filter(([options]) => (
      (options as { prefix?: string } | undefined)?.prefix === headPrefix
    ));
    expect(headListCalls.length).toBeGreaterThan(0);
    expect(headListCalls.every(([options]) => (
      (options as { limit?: number } | undefined)?.limit === 8
    ))).toBe(true);
  });

  it("uses compiled references for Surge, Clash, Stash, and Shadowrocket while leaving manual mode unchanged", async () => {
    mockRuleSetFetches();
    const env = makeEnv();
    const config = compiledConfig();
    config.ruleSets.outputs[0]!.name = "AI Rules";
    config.ruleSets.outputs[0]!.surgeOptions = ["extended-matching", "update-interval=60"];

    const surge = await generateConfig(env, config, "surge", "https://subpilot.example.com/sync/read-token/");
    expect(surge.warnings.join("\n")).toContain("MATCH 应作为主配置规则保存");
    expect(surge.content).toContain("[Rule]\nGEOIP,CN,DIRECT");
    expect(surge.content).toContain("RULE-SET,https://subpilot.example.com/sync/read-token/r/AI%20Rules.list,Proxy,no-resolve,extended-matching,update-interval=86400");
    expect(surge.content).not.toContain("update-interval=60");
    expect(surge.content).not.toContain("/AI%20Rules-domain.list");
    expect(surge.content).not.toContain("/AI%20Rules-ipcidr.list");
    expect(surge.content).not.toContain("# Rule Set:");
    expect(surge.content.trimEnd().endsWith("FINAL,DIRECT")).toBe(true);
    expect(surge.content).not.toContain("manual.example");

    const clash = YAML.parse((await generateConfig(env, config, "clash", "https://subpilot.example.com/sync/read-token/")).content) as {
      "rule-providers": Record<string, Record<string, unknown>>;
      rules: string[];
    };
    const providerName = compiledRuleProviderName("AI Rules", "combined");
    expect(clash["rule-providers"][providerName]).toMatchObject({
      type: "http",
      behavior: "classical",
      url: "https://subpilot.example.com/sync/read-token/r/AI%20Rules.yaml",
      interval: 86400
    });
    expect(clash.rules).toContain("GEOIP,CN,DIRECT");
    expect(clash.rules).toContain(`RULE-SET,${providerName},Proxy`);
    expect(clash.rules.at(-1)).toBe("MATCH,DIRECT");
    expect(clash.rules).not.toContain("DOMAIN-SUFFIX,manual.example,Proxy");

    const stash = YAML.parse((await generateConfig(env, config, "stash", "https://subpilot.example.com/sync/read-token/")).content) as {
      "rule-providers": Record<string, Record<string, unknown>>;
      rules: string[];
    };
    expect(stash["rule-providers"][providerName]?.url).toBe("https://subpilot.example.com/sync/read-token/r/AI%20Rules.stash.yaml");
    expect(stash.rules.at(-1)).toBe("MATCH,DIRECT");

    const shadowrocket = await generateConfig(env, config, "shadowrocket", "https://subpilot.example.com/sync/read-token/");
    const shadowrocketYaml = YAML.parse(shadowrocket.content) as { "rule-providers": Record<string, Record<string, unknown>> };
    expect(shadowrocket.target).toBe("shadowrocket");
    expect(shadowrocketYaml["rule-providers"][providerName]?.url).toContain("/AI%20Rules.yaml");

    const manual = await generateConfig(env, {
      ...config,
      ruleSets: {
        ...config.ruleSets,
        mode: "manual"
      }
    }, "surge", "https://subpilot.example.com/sync/read-token/");
    expect(manual.content).toContain("DOMAIN-SUFFIX,manual.example,Proxy");
    expect(manual.content).not.toContain("/r/AI/");
  });

  it("emits unified Tailscale rules only for Surge", async () => {
    const base = compiledConfig();
    const config = normalizeConfig({
      ...base,
      surge: {
        ...base.surge,
        tailscaleNodes: [{
          name: "Tailnet Exit",
          sectionName: "tailnet-exit",
          authKey: "tskey-auth-test",
          controlUrl: "",
          hostname: "",
          derpOnly: false,
          exitNode: "none",
          idleKeepalive: 600,
          preferIpv6: false,
          dnsServer: [],
          mtu: 1280,
          underlyingProxy: "",
          testUrl: "",
          testTimeout: 5,
          enabled: true
        }]
      },
      ruleSets: {
        mode: "compiled",
        aggregateByPolicy: false,
        sources: [],
        outputs: [{
          name: "Tailnet Rules",
          enabled: true,
          policy: "Tailnet Exit",
          sourceIds: [],
          inlineRules: ["DOMAIN-SUFFIX,tailnet.example"],
          order: 1,
          surgeOptions: []
        }],
        directRules: [{
          id: "tailnet-direct",
          name: "Tailnet direct",
          enabled: true,
          rule: "DOMAIN-SUFFIX,direct.tailnet.example,Tailnet Exit",
          policy: "Tailnet Exit",
          order: 2
        }, {
          id: "final",
          name: "Final",
          enabled: true,
          rule: "FINAL,Proxy",
          policy: "Proxy",
          order: 3
        }]
      }
    });
    const env = makeEnv();

    const surge = (await generateConfig(env, config, "surge", "https://subpilot.example.com/sync/read-token/")).content;
    expect(surge).toContain("/r/Tailnet%20Rules.list,Tailnet Exit");
    expect(surge).toContain("DOMAIN-SUFFIX,direct.tailnet.example,Tailnet Exit");

    for (const target of ["clash", "stash", "shadowrocket"] as const) {
      const yaml = YAML.parse((await generateConfig(
        env,
        config,
        target,
        "https://subpilot.example.com/sync/read-token/"
      )).content) as { "rule-providers"?: Record<string, unknown>; rules: string[] };
      expect(Object.keys(yaml["rule-providers"] || {})).not.toContain(compiledRuleProviderName("Tailnet Rules", "combined"));
      expect(yaml.rules.join("\n")).not.toContain("Tailnet Exit");
      expect(yaml.rules).not.toContain("DOMAIN-SUFFIX,direct.tailnet.example,Proxy");
      expect(yaml.rules).toContain("MATCH,Proxy");
    }
  });

  it("groups compiled outputs by policy and annotates their original rule set names", async () => {
    mockRuleSetFetches();
    const env = makeEnv();
    const config = compiledConfig();
    config.ruleSets.aggregateByPolicy = true;
    config.ruleSets.outputs = [{
      ...config.ruleSets.outputs[0]!,
      name: "AI",
      sourceIds: ["surge-source"],
      order: 10
    }, {
      ...config.ruleSets.outputs[0]!,
      name: "Media",
      sourceIds: ["clash-source"],
      inlineRules: [],
      order: 20
    }];

    await refreshRuleSetCaches(env, config);
    const surge = (await generateConfig(env, config, "surge", "https://subpilot.example.com/sync/read-token/")).content;
    expect(surge).toContain("# 策略组 Proxy 包含规则集：AI、Media");
    expect(surge).toContain("/r/Proxy.list,Proxy");
    expect(surge).not.toContain("/r/AI.list");
    expect(surge).not.toContain("/r/Media.list");

    const clash = (await generateConfig(env, config, "clash", "https://subpilot.example.com/sync/read-token/")).content;
    expect(clash).toContain("# 策略组 Proxy 包含规则集：AI、Media");
    expect(clash).toContain("/r/Proxy.yaml");
    expect(clash).not.toContain("/r/AI.yaml");

    const stash = (await generateConfig(env, config, "stash", "https://subpilot.example.com/sync/read-token/")).content;
    expect(stash).toContain("# 策略组 Proxy 包含规则集：AI、Media");
    expect(stash).toContain("/r/Proxy.stash.yaml");

    await env.SUBPILOT_CONFIG.put("auth:read_token_hash", await sha256Hex("read-token"));
    await saveConfig(env, config);
    const mergedDownload = await worker.fetch(new Request(
      "https://subpilot.example.com/sync/read-token/r/Proxy.yaml"
    ), env, ctx);
    expect(mergedDownload.status).toBe(200);
    await expect(worker.fetch(new Request(
      "https://subpilot.example.com/sync/read-token/r/AI.yaml"
    ), env, ctx).then((response) => response.status)).resolves.toBe(404);
  });

  it("keeps Clash rule-provider names distinct for Unicode and punctuation-colliding output names", async () => {
    const names = ["广告", "隐私", "Foo-Bar", "Foo Bar"];
    const config = normalizeConfig({
      ...DEFAULT_CONFIG,
      ruleSets: {
        mode: "compiled",
        aggregateByPolicy: false,
        sources: [],
        outputs: names.map((name, index) => ({
          name,
          enabled: true,
          policy: "Proxy",
          sourceIds: [],
          inlineRules: [`DOMAIN-SUFFIX,provider-${index}.example,Proxy`],
          order: index,
          surgeOptions: []
        })),
        directRules: [{
          id: "final",
          name: "Final",
          enabled: true,
          rule: "FINAL,Proxy",
          policy: "Proxy",
          order: 999
        }]
      }
    });

    expect(validateRuleSetOutputNames(config)).toBeNull();
    const clash = YAML.parse((await generateConfig(
      makeEnv(),
      config,
      "clash",
      "https://subpilot.example.com/sync/read-token/"
    )).content) as { "rule-providers": Record<string, unknown>; rules: string[] };
    const providerNames = names.map((name) => compiledRuleProviderName(name, "combined"));

    expect(new Set(providerNames).size).toBe(names.length);
    expect(Object.keys(clash["rule-providers"]).sort()).toEqual([...providerNames].sort());
    for (const providerName of providerNames) {
      expect(clash.rules).toContain(`RULE-SET,${providerName},Proxy`);
    }
  });

  it("does not diagnose legacy target rules that are omitted in compiled mode", async () => {
    mockRuleSetFetches();
    const env = makeEnv();
    const base = compiledConfig();
    const config = normalizeConfig({
      ...base,
      surge: {
        ...base.surge,
        rules: [
          "DOMAIN-SUFFIX,legacy.example,DIRECT",
          "DOMAIN,www.legacy.example,Proxy",
          "FINAL,Proxy"
        ]
      },
      clash: {
        ...base.clash,
        rules: [
          "DOMAIN-SUFFIX,legacy.example,DIRECT",
          "DOMAIN,www.legacy.example,Proxy",
          "MATCH,Proxy"
        ]
      },
      stash: {
        ...base.stash,
        rules: [
          "DOMAIN-SUFFIX,legacy.example,DIRECT",
          "DOMAIN,www.legacy.example,Proxy",
          "MATCH,Proxy"
        ]
      }
    });

    for (const target of ["surge", "clash", "stash"] as const) {
      const result = await generateConfig(
        env,
        config,
        target,
        "https://subpilot.example.com/sync/read-token/",
        { includeRuleDiagnostics: true }
      );

      expect(result.content).not.toContain("legacy.example");
      expect(result.warnings.some((warning) => warning.startsWith(`${target === "surge" ? "Surge" : target === "clash" ? "Clash" : "Stash"} Rule`))).toBe(false);
      expect(result.warnings.join("\n")).toContain("MATCH 应作为主配置规则保存");
    }
  });

  it("does not emit references for empty buckets", async () => {
    const env = makeEnv();
    const config = normalizeConfig({
      ...DEFAULT_CONFIG,
      ruleSets: {
        mode: "compiled",
        aggregateByPolicy: false,
        sources: [],
        outputs: [{
          name: "DomainOnly",
          enabled: true,
          policy: "Proxy",
          sourceIds: [],
          inlineRules: ["DOMAIN-SUFFIX,only.example,Proxy"],
          order: 1,
          surgeOptions: []
        }],
        directRules: []
      }
    });

    const surge = await generateConfig(env, config, "surge", "https://subpilot.example.com/sync/read-token/");
    expect(surge.content).toContain("/r/DomainOnly.list");
    expect(surge.content).toContain(",Proxy,update-interval=86400");
    expect(surge.content).not.toContain("/r/DomainOnly-domain.list");
    expect(surge.content).not.toContain("/r/DomainOnly-ipcidr.list");

    const clash = YAML.parse((await generateConfig(env, config, "clash", "https://subpilot.example.com/sync/read-token/")).content) as {
      "rule-providers": Record<string, unknown>;
    };
    expect(Object.keys(clash["rule-providers"])).toEqual([compiledRuleProviderName("DomainOnly", "combined")]);
  });

  it("refetches upstream sources when refreshing compiled caches", async () => {
    const fetchMock = mockRuleSetFetches();
    const kv = new Map<string, string>([
      ["cache:ruleSetSource:stale", "stale"],
      ["cache:ruleSetSourceMeta:stale", JSON.stringify({
        key: "cache:ruleSetSource:stale",
        fetchedAt: "2026-06-20T01:00:00.000Z",
        sourceId: "stale",
        sourceName: "Stale",
        contentAvailable: true
      })],
      ["cache:ruleSetSourceMeta:index", JSON.stringify([{
        key: "cache:ruleSetSource:stale",
        fetchedAt: "2026-06-20T01:00:00.000Z",
        sourceId: "stale",
        sourceName: "Stale",
        contentAvailable: true
      }])]
    ]);
    const env = makeEnv(kv);
    const config = compiledConfig();
    await compileRuleSetOutput(env, config, config.ruleSets.outputs[0]!);
    const initialFetches = fetchMock.mock.calls.length;

    const result = await refreshRuleSetCaches(env, config);

    expect(fetchMock.mock.calls.length).toBeGreaterThan(initialFetches);
    expect(result.deleted).toBe(1);
    expect(kv.has("cache:ruleSetSource:stale")).toBe(false);
    expect(kv.has("cache:ruleSetSourceMeta:stale")).toBe(false);
    expect(JSON.parse(kv.get("cache:ruleSetSourceMeta:index") ?? "[]")).not.toContainEqual(expect.objectContaining({ key: "cache:ruleSetSource:stale" }));
  });

  it("keeps previous rule set source cache when upstream refresh fails", async () => {
    const fetchMock = mockRuleSetFetches();
    const env = makeEnv();
    const config = compiledConfig();
    await compileRuleSetOutput(env, config, config.ruleSets.outputs[0]!);
    const initialFetches = fetchMock.mock.calls.length;
    fetchMock.mockResolvedValue(new Response("fail", { status: 500 }));

    const result = await refreshRuleSetCaches(env, config);

    expect(fetchMock.mock.calls.length).toBe(initialFetches + 4);
    expect(result.cached).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.warnings.join("\n")).toContain("继续使用旧规则集源缓存");
    await expect(readCompiledRuleSetBucket(env, "AI", "domain", "surge")).resolves.toContain(".example.com");
  });

  it("refreshes only changed rule set sources after config changes", async () => {
    const env = makeEnv();
    const previous = normalizeConfig({
      ...DEFAULT_CONFIG,
      ruleSets: {
        mode: "compiled",
        aggregateByPolicy: false,
        sources: [{
          id: "stable",
          name: "Stable",
          url: "https://rules.example/stable.list",
          enabled: true,
          format: "surge-rule-set",
          order: 1
        }, {
          id: "changed",
          name: "Changed",
          url: "https://rules.example/old.list",
          enabled: true,
          format: "surge-rule-set",
          order: 2
        }],
        outputs: [{
          name: "Stable",
          enabled: true,
          policy: "Proxy",
          sourceIds: ["stable"],
          inlineRules: [],
          order: 1,
          surgeOptions: []
        }, {
          name: "Changed",
          enabled: true,
          policy: "Proxy",
          sourceIds: ["changed"],
          inlineRules: [],
          order: 2,
          surgeOptions: []
        }],
        directRules: []
      }
    });
    const next = normalizeConfig({
      ...previous,
      ruleSets: {
        ...previous.ruleSets,
        sources: previous.ruleSets.sources.map((source) => source.id === "changed"
          ? { ...source, url: "https://rules.example/new.list" }
          : source)
      }
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const target = String(url);
      if (target === "https://rules.example/stable.list") {
        return new Response("DOMAIN-SUFFIX,stable.example,Proxy");
      }
      if (target === "https://rules.example/new.list") {
        return new Response("DOMAIN-SUFFIX,changed.example,Proxy");
      }
      return new Response("unexpected", { status: 500 });
    });
    await compileRuleSetOutput(env, previous, previous.ruleSets.outputs[0]!);

    const result = await refreshChangedRuleSetCaches(env, previous, next);

    expect(result).toMatchObject({ refreshed: 1, failed: 0, cached: 0 });
    expect(fetchMock.mock.calls.some(([url]) => String(url) === "https://rules.example/stable.list")).toBe(true);
    const callsAfterInitialCompile = fetchMock.mock.calls.slice(1).map(([url]) => String(url));
    expect(callsAfterInitialCompile).toEqual(["https://rules.example/new.list"]);
    await expect(readCompiledRuleSetBucket(env, "Changed", "domain", "surge")).resolves.toContain(".changed.example");
  });

  it("serves public compiled rule set buckets with read token validation and lazy compilation", async () => {
    const fetchMock = mockRuleSetFetches();
    const kv = new Map<string, string>([
      ["auth:read_token_hash", await sha256Hex("read-token")]
    ]);
    const env = makeEnv(kv);
    await saveConfig(env, compiledConfig());

    const ruleSetUrl = "https://subpilot.example.com/sync/read-token/r/AI.yaml";
    const response = await worker.fetch(new Request(ruleSetUrl), env, ctx);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/yaml; charset=utf-8");
    expect(YAML.parse(body)).toMatchObject({ payload: expect.arrayContaining(["DOMAIN-SUFFIX,example.com"]) });
    const fetchCount = fetchMock.mock.calls.length;
    await worker.fetch(new Request(ruleSetUrl), env, ctx);
    expect(fetchMock).toHaveBeenCalledTimes(fetchCount);
    const surgeCombinedResponse = await worker.fetch(new Request(
      "https://subpilot.example.com/sync/read-token/r/AI.list"
    ), env, ctx);
    expect(surgeCombinedResponse.status).toBe(200);
    await expect(surgeCombinedResponse.text()).resolves.toContain("DOMAIN-SUFFIX,example.com");
    const compiledManifest = await readCompiledRuleSetManifest(env, "AI");
    expect(compiledManifest?.storageId).toBeTruthy();
    await env.SUBPILOT_CONFIG.delete(compiledRuleSetContentKey(
      "AI",
      "combined",
      "clash",
      compiledManifest!.storageId
    ));
    const restoredResponse = await worker.fetch(new Request(ruleSetUrl), env, ctx);
    expect(restoredResponse.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(fetchCount);

    await expect(worker.fetch(new Request("https://subpilot.example.com/sync/bad-token/r/AI.yaml"), env, ctx)
      .then((item) => item.status)).resolves.toBe(400);
    await expect(worker.fetch(new Request(`${ruleSetUrl}?target=surge`), env, ctx)
      .then((item) => item.status)).resolves.toBe(403);
    await expect(worker.fetch(new Request("https://subpilot.example.com/sync/read-token/r/AI.bad"), env, ctx)
      .then((item) => item.status)).resolves.toBe(403);
    await expect(worker.fetch(new Request("https://subpilot.example.com/sync/read-token/r/%E0%A4%A.yaml"), env, ctx)
      .then((item) => item.status)).resolves.toBe(403);
    await expect(worker.fetch(new Request("https://subpilot.example.com/sync/read-token/r/Wrong.yaml"), env, ctx)
      .then((item) => item.status)).resolves.toBe(404);
    const clashCombinedResponse = await worker.fetch(new Request(
      "https://subpilot.example.com/sync/read-token/r/AI.yaml"
    ), env, ctx);
    expect(clashCombinedResponse.status).toBe(200);
    expect(YAML.parse(await clashCombinedResponse.text())).toMatchObject({
      payload: expect.arrayContaining(["DOMAIN-SUFFIX,example.com", "IP-CIDR,1.1.1.0/24,no-resolve"])
    });
    await expect(worker.fetch(new Request("https://subpilot.example.com/sync/read-token/r/AI/c/clash.yaml"), env, ctx)
      .then((item) => item.status)).resolves.toBe(403);
  });

  it("serves distinct Clash and Stash rule-set artifacts", async () => {
    const kv = new Map<string, string>([["auth:read_token_hash", await sha256Hex("read-token")]]);
    const env = makeEnv(kv);
    const base = compiledConfig();
    const config = normalizeConfig({
      ...base,
      ruleSets: {
        ...base.ruleSets,
        sources: [],
        outputs: [{
          ...base.ruleSets.outputs[0]!,
          sourceIds: [],
          inlineRules: ["IP-CIDR,192.0.2.0/24,src,no-resolve"]
        }]
      }
    });
    await saveConfig(env, config);

    const clashResponse = await worker.fetch(new Request(
      "https://subpilot.example.com/sync/read-token/r/AI.yaml"
    ), env, ctx);
    const stashResponse = await worker.fetch(new Request(
      "https://subpilot.example.com/sync/read-token/r/AI.stash.yaml"
    ), env, ctx);
    const clash = YAML.parse(await clashResponse.text()) as { payload: string[] };
    const stash = YAML.parse(await stashResponse.text()) as { payload: string[] };

    expect(clashResponse.status).toBe(200);
    expect(stashResponse.status).toBe(200);
    expect(clash.payload).toEqual(["IP-CIDR,192.0.2.0/24,src,no-resolve"]);
    expect(stash.payload).toEqual(["IP-CIDR,192.0.2.0/24,no-resolve"]);
  });

  it("serves specialized artifacts with readable filename suffixes", async () => {
    const kv = new Map<string, string>([["auth:read_token_hash", await sha256Hex("read-token")]]);
    const env = makeEnv(kv);
    const config = compiledConfig();
    await saveConfig(env, config);
    const output = config.ruleSets.outputs[0]!;
    const manifest = {
      outputName: "AI",
      outputFingerprint: JSON.stringify({
        compilerRevision: 4,
        policy: output.policy,
        sourceIds: output.sourceIds,
        inlineRules: output.inlineRules,
        surgeOptions: output.surgeOptions
      }),
      policy: "Proxy",
      updatedAt: "2026-07-10T12:00:00.000Z",
      sourceIds: [],
      ruleCount: 1001,
      duplicateCount: 0,
      buckets: [{ bucket: "domain", count: 1001, targets: ["surge", "clash", "stash"] }],
      warnings: []
    };
    kv.set(compiledRuleSetMetaKey("AI"), JSON.stringify(manifest));
    kv.set(compiledRuleSetContentKey("AI", "domain", "surge"), ".example.com\n");
    kv.set(compiledRuleSetContentKey("AI", "domain", "clash"), YAML.stringify({ payload: ["+.example.com"] }));

    const surgeResponse = await worker.fetch(new Request(
      "https://subpilot.example.com/sync/read-token/r/AI-domain.list"
    ), env, ctx);
    const clashResponse = await worker.fetch(new Request(
      "https://subpilot.example.com/sync/read-token/r/AI-domain.yaml"
    ), env, ctx);

    expect(surgeResponse.status).toBe(200);
    await expect(surgeResponse.text()).resolves.toBe(".example.com\n");
    expect(clashResponse.status).toBe(200);
    await expect(clashResponse.text().then((content) => YAML.parse(content))).resolves.toEqual({ payload: ["+.example.com"] });
    await expect(worker.fetch(new Request("https://subpilot.example.com/sync/read-token/r/AI.list"), env, ctx)
      .then((response) => response.status)).resolves.toBe(404);
  });

  it("stores compiled rule set downloads in Worker cache after validation", async () => {
    const workerCache = installFakeWorkerCache();
    try {
      const fetchMock = mockRuleSetFetches();
      const kv = new Map<string, string>([
        ["auth:read_token_hash", await sha256Hex("read-token")]
      ]);
      const env = makeEnv(kv);
      await saveConfig(env, compiledConfig());
      const request = new Request("https://subpilot.example.com/sync/read-token/r/AI.yaml");
      const firstContext = makeExecutionContext();

      const response = await worker.fetch(request, env, firstContext.ctx);
      const body = await response.text();
      await Promise.all(firstContext.waitUntil);

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(response.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/);
      expect(workerCache.put).toHaveBeenCalledTimes(1);
      expect([...workerCache.store.keys()].some((key) => key.startsWith(`${request.url}?__subpilot_version=`))).toBe(true);
      const fetchCount = fetchMock.mock.calls.length;

      const notModified = await worker.fetch(new Request(request.url, {
        headers: { "if-none-match": String(response.headers.get("etag")) }
      }), env, makeExecutionContext().ctx);
      expect(notModified.status).toBe(304);

      const manifestEntry = [...kv.entries()].find(([key]) => key.startsWith(`${compiledRuleSetMetaKey("AI")}:v:`));
      expect(manifestEntry).toBeDefined();
      const manifest = JSON.parse(String(manifestEntry![1])) as { storageId: string; updatedAt: string };
      kv.set(manifestEntry![0], JSON.stringify({ ...manifest, updatedAt: "2026-07-10T12:00:00.000Z" }));
      const versionedContext = makeExecutionContext();
      const versionedResponse = await worker.fetch(new Request(request.url, {
        headers: { "if-none-match": String(response.headers.get("etag")) }
      }), env, versionedContext.ctx);
      await Promise.all(versionedContext.waitUntil);
      expect(versionedResponse.status).toBe(304);
      expect(workerCache.put).toHaveBeenCalledTimes(2);
      expect(workerCache.store.size).toBe(2);

      await env.SUBPILOT_CONFIG.delete(compiledRuleSetContentKey("AI", "combined", "clash", manifest.storageId));
      const cachedResponse = await worker.fetch(request, env, makeExecutionContext().ctx);

      expect(cachedResponse.status).toBe(200);
      await expect(cachedResponse.text()).resolves.toBe(body);
      expect(workerCache.match).toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(fetchCount);
    } finally {
      workerCache.restore();
    }
  });

  it("prewarms Worker cache for every compiled target after refresh", async () => {
    const workerCache = installFakeWorkerCache();
    try {
      mockRuleSetFetches();
      const env = makeEnv();
      await saveConfig(env, compiledConfig());
      const session = await createSession(env);
      const execution = makeExecutionContext();

      const response = await worker.fetch(new Request("https://subpilot.example.com/api/rule-sets/refresh", {
        method: "POST",
        headers: { cookie: sessionCookie(session, true) }
      }), env, execution.ctx);
      await Promise.all(execution.waitUntil);

      expect(response.status).toBe(200);
      expect(workerCache.put).toHaveBeenCalledTimes(3);
      const cacheKeys = [...workerCache.store.keys()];
      expect(cacheKeys.some((key) => key.includes("/r/AI.list"))).toBe(true);
      expect(cacheKeys.some((key) => key.includes("/r/AI.yaml"))).toBe(true);
      expect(cacheKeys.some((key) => key.includes("/r/AI.stash.yaml"))).toBe(true);
      const cachedClashCombined = [...workerCache.store.entries()]
        .find(([key]) => key.includes("/r/AI.yaml"))?.[1];
      expect(cachedClashCombined?.headers.get("cache-control")).toBe("public, max-age=43200");
      expect(YAML.parse(await cachedClashCombined!.text())).toMatchObject({
        payload: expect.arrayContaining(["DOMAIN-SUFFIX,example.com", "IP-CIDR,1.1.1.0/24,no-resolve"])
      });
    } finally {
      workerCache.restore();
    }
  });

  it("keeps old compiled cache when refresh fails", async () => {
    mockRuleSetFetches();
    const env = makeEnv();
    const config = compiledConfig();
    await compileRuleSetOutput(env, config, config.ruleSets.outputs[0]!);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("fail", { status: 500 }));
    const changed = normalizeConfig({
      ...config,
      ruleSets: {
        ...config.ruleSets,
        sources: config.ruleSets.sources.map((source) => ({ ...source, url: "https://rules.example/down.list" }))
      }
    });
    const result = await refreshRuleSetCaches(env, changed);

    expect(result.cached).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.warnings.join("\n")).toContain("继续使用旧编译缓存");
    await expect(readCompiledRuleSetBucket(env, "AI", "domain", "surge")).resolves.toContain(".example.com");
  });

  it("requires admin session for rule set management APIs", async () => {
    mockRuleSetFetches();
    const env = makeEnv();
    await saveConfig(env, compiledConfig());
    await expect(worker.fetch(new Request("https://subpilot.example.com/api/rule-sets/status"), env, ctx)
      .then((response) => response.status)).resolves.toBe(401);

    const session = await createSession(env);
    const response = await worker.fetch(new Request("https://subpilot.example.com/api/rule-sets/status", {
      headers: { cookie: sessionCookie(session, true) }
    }), env, ctx);
    const body = await response.json<{ mode: string; outputs: Array<{ outputName: string }> }>();

    expect(response.status).toBe(200);
    expect(body.mode).toBe("compiled");
    expect(body.outputs[0]?.outputName).toBe("AI");
    expect(body.outputs[0]).not.toHaveProperty("outputId");

    const refreshResponse = await worker.fetch(new Request("https://subpilot.example.com/api/rule-sets/refresh/AI", {
      method: "POST",
      headers: { cookie: sessionCookie(session, true) }
    }), env, ctx);
    expect(refreshResponse.status).toBe(200);

    const compiledResponse = await worker.fetch(new Request("https://subpilot.example.com/api/rule-sets/compiled/AI", {
      headers: { cookie: sessionCookie(session, true) }
    }), env, ctx);
    const compiled = await compiledResponse.json<{ manifest: { outputName: string } }>();
    expect(compiledResponse.status).toBe(200);
    expect(compiled.manifest.outputName).toBe("AI");
    expect(compiled.manifest).not.toHaveProperty("outputId");
  });

  it("maps or filters classical rules per target and records compatibility warnings", async () => {
    const env = makeEnv();
    const base = compiledConfig();
    const config = normalizeConfig({
      ...base,
      ruleSets: {
        ...base.ruleSets,
        sources: [],
        outputs: [{
          ...base.ruleSets.outputs[0]!,
          sourceIds: [],
          inlineRules: [
            'USER-AGENT,"Example, App"',
            'URL-REGEX,"^https://example\\.com/(foo,bar)$"',
            "DEST-PORT,443",
            "DOMAIN-REGEX,^api[0-9]+\\.example\\.com$",
            "PROCESS-PATH,/Applications/Example.app"
          ]
        }]
      }
    });

    const result = await compileRuleSetOutput(env, config, config.ruleSets.outputs[0]!);
    const meta = result.manifest.buckets.find((bucket) => bucket.bucket === "classical");
    expect(meta?.targetCounts).toEqual({ surge: 3, clash: 3, stash: 5 });
    expect(result.manifest.warnings.join("\n")).toContain("不受 Clash 支持");
    expect(result.manifest.warnings.join("\n")).toContain("映射为 DST-PORT");

    const surge = String(await readCompiledRuleSetBucket(env, "AI", "combined", "surge"));
    expect(surge).toContain('USER-AGENT,"Example, App"');
    expect(surge).toContain('URL-REGEX,"^https://example\\.com/(foo,bar)$"');
    expect(surge).toContain("DEST-PORT,443");
    expect(surge).not.toContain("DOMAIN-REGEX");
    expect(surge).not.toContain("PROCESS-PATH");

    const clash = YAML.parse(String(await readCompiledRuleSetBucket(env, "AI", "combined", "clash"))) as { payload: string[] };
    expect(clash.payload).toContain("DST-PORT,443");
    expect(clash.payload).toContain("DOMAIN-REGEX,^api[0-9]+\\.example\\.com$");
    expect(clash.payload).toContain("PROCESS-PATH,/Applications/Example.app");
    expect(clash.payload.some((rule) => rule.startsWith("USER-AGENT,"))).toBe(false);
    expect(clash.payload.some((rule) => rule.startsWith("URL-REGEX,"))).toBe(false);
  });

  it("stops starting refresh work after an absolute deadline and keeps usable caches", async () => {
    const fetchMock = mockRuleSetFetches();
    const env = makeEnv();
    const config = compiledConfig();
    await compileRuleSetOutput(env, config, config.ruleSets.outputs[0]!);
    fetchMock.mockClear();

    const result = await refreshRuleSetCaches(env, config, undefined, { deadline: Date.now() - 1 });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.failures).toHaveLength(2);
    expect(result.failures.every((failure) => !failure.usedCachedContent)).toBe(true);
    expect(result.failures.every((failure) => failure.reason.includes("截止时间"))).toBe(true);
    expect(result.outputFailures).toEqual([{
      outputName: "AI",
      reason: "规则集刷新已超过截止时间",
      usedCachedManifest: false
    }]);
    expect(result.warnings.join("\n")).toContain("跳过过期编译缓存清理");
    await expect(readCompiledRuleSetBucket(env, "AI", "combined", "surge")).resolves.toContain("example.com");
  });

  it("rejects inline rule counts above the per-output compilation limit", async () => {
    const env = makeEnv();
    const config = compiledConfig();
    const output = {
      ...config.ruleSets.outputs[0]!,
      sourceIds: [],
      inlineRules: Array.from({ length: 50_001 }, (_, index) => `DOMAIN,rule-${index}.example`)
    };
    config.ruleSets = {
      ...config.ruleSets,
      sources: [],
      outputs: [output]
    };

    await expect(compileRuleSetOutput(env, config, output)).rejects.toThrow("编译规则数量超过 50000 条限制");
    await expect(readCompiledRuleSetManifest(env, output.name)).resolves.toBeNull();
  });
});
