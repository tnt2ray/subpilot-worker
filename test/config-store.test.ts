import YAML from "yaml";
import { describe, expect, it, vi } from "vitest";
import { generateConfig } from "../src/generator";
import { CONFIG_MIGRATED_SNAPSHOT_PREFIX, CONFIG_SNAPSHOT_KEY, CONFIG_SNAPSHOT_VERSION_PREFIX, loadConfig, normalizeConfig, saveConfig } from "../src/config-store";
import { CONFIG_SCHEMA_VERSION_KEY, CURRENT_KV_SCHEMA_VERSION } from "../src/config-schema";
import { decryptText, encryptText } from "../src/crypto-store";
import { DEFAULT_CONFIG } from "../src/default-config";
import { compiledRuleSetContentKey, compiledRuleSetMetaKey } from "../src/rule-set-cache";
import { fetchCachedSource, refreshSourceCache } from "../src/source-cache";
import { validateSurgeHosts } from "../src/surge-hosts";
import { validateSurgeMapLocal } from "../src/surge-map-local";
import { validateSurgeRules } from "../src/surge-rules";
import { inferUrlRewriteMitmHostnames, validateSurgeUrlRewrite } from "../src/surge-url-rewrite";
import type { AppConfig } from "../src/types";
import { sha256Hex } from "../src/util";
import { makeEnv } from "./helpers/env";
import { mockSubscription, restoreMocksAfterEach } from "./helpers/fetch";

restoreMocksAfterEach();

const ENCRYPTED_CACHE_STORAGE_PREFIX = "\u001fsubpilot-encrypted-cache:";
const CONFIG_CLEANUP_PENDING_PREFIX = "config:snapshot:legacyCleanupPending:";
const CONFIG_CLEANUP_COMPLETE_PREFIX = `config:snapshot:legacyCleanupComplete:${CURRENT_KV_SCHEMA_VERSION}:`;

function rejectRapidDuplicateWrites(env: Env) {
  const originalPut = env.SUBPILOT_CONFIG.put.bind(env.SUBPILOT_CONFIG);
  const lastWrites = new Map<string, number>();
  return vi.spyOn(env.SUBPILOT_CONFIG, "put").mockImplementation(async (...args) => {
    const key = String(args[0]);
    const now = Date.now();
    const previous = lastWrites.get(key);
    if (previous !== undefined && now - previous < 1_000) throw new Error(`KV PUT rate limit for ${key}`);
    lastWrites.set(key, now);
    return originalPut(...args);
  });
}

describe("KV config storage", () => {
  it("normalizes default config, notification settings, empty lists, subnet groups, and removed client switches", async () => {
    const env = makeEnv();
    const loaded = await loadConfig(env);
    expect(loaded).toMatchObject({
      ...DEFAULT_CONFIG,
      ruleSets: {
        ...DEFAULT_CONFIG.ruleSets,
        mode: "compiled",
        directRules: [{
          id: "subpilot-default-final",
          name: "Final",
          enabled: true,
          rule: "FINAL,Proxy",
          policy: "Proxy",
          order: 0
        }]
      }
    });

    const config = normalizeConfig({
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationChannel: "off",
        notificationTelegramBotToken: "telegram-token"
      }
    });

    expect(config.settings.notificationChannel).toBe("telegram");

    const disabled = normalizeConfig({
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        notificationChannel: "telegram",
        notificationTelegramBotToken: "",
        notificationTelegramChatId: "123456",
        notificationTelegramWebhookSecret: "webhook-secret"
      }
    });

    expect(disabled.settings.notificationChannel).toBe("off");
    expect(disabled.settings.notificationTelegramChatId).toBe("");
    expect(disabled.settings.notificationTelegramWebhookSecret).toBe("");

    const invalidTimeZone = normalizeConfig({
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        displayTimeZone: "Invalid/Zone"
      }
    });

    expect(invalidTimeZone.settings.displayTimeZone).toBe("Asia/Shanghai");

    const cleared = normalizeConfig({
      ...DEFAULT_CONFIG,
      chain: {
        ...DEFAULT_CONFIG.chain,
        filter: []
      },
      surge: {
        ...DEFAULT_CONFIG.surge,
        rules: []
      },
      clash: {
        ...DEFAULT_CONFIG.clash,
        nameservers: [],
        ruleProviders: "",
        rules: []
      },
      stash: {
        ...DEFAULT_CONFIG.stash,
        dns: {
          ...DEFAULT_CONFIG.stash.dns,
          nameservers: []
        },
        hosts: [],
        urlRewrite: [],
        scripts: [],
        rules: []
      }
    });
    expect(cleared.chain.filter).toEqual([]);
    expect(cleared.surge.rules).toEqual([]);
    expect(cleared.clash.nameservers).toEqual([]);
    expect(cleared.clash.ruleProviders).toBe("");
    expect(cleared.clash.rules).toEqual([]);
    expect(cleared.stash.dns.nameservers).toEqual([]);
    expect(cleared.stash.hosts).toEqual([]);
    expect(cleared.stash.urlRewrite).toEqual([]);
    expect(cleared.stash.scripts).toEqual([]);
    expect(cleared.stash.rules).toEqual([]);
    expect("shadowrocket" in cleared).toBe(false);

    const noEncryptedDns = normalizeConfig({
      ...DEFAULT_CONFIG,
      surge: {
        ...DEFAULT_CONFIG.surge,
        encryptedDnsServer: [],
        encryptedDnsFollowOutboundMode: true
      }
    });
    expect(noEncryptedDns.surge.encryptedDnsServer).toEqual([]);
    expect(noEncryptedDns.surge.encryptedDnsFollowOutboundMode).toBe(false);

    const subnet = normalizeConfig({
      ...DEFAULT_CONFIG,
      groups: {
        Proxy: "select, Auto",
        Auto: "url-test, {all}, url=https://www.gstatic.com/generate_204, interval=600",
        Network: "subnet, default=Proxy, default=Auto, TYPE:WIFI=Proxy, TYPE:WIFI=Proxy, SSID:Office=DIRECT, BSSID:Self=Network, Proxy, {all}, url=https://example.com"
      }
    });
    expect(subnet.groups.Network).toBe("subnet, default=Proxy, TYPE:WIFI=Proxy, TYPE:WIFI=Proxy, SSID:Office=DIRECT");

    const chainSwitches = normalizeConfig(DEFAULT_CONFIG);
    expect("chainEnabled" in chainSwitches.surge).toBe(false);
    expect("chainEnabled" in chainSwitches.clash).toBe(false);

    const directTailscaleUnderlyingProxy = normalizeConfig({
      ...DEFAULT_CONFIG,
      surge: {
        ...DEFAULT_CONFIG.surge,
        tailscaleNodes: [{
          name: "Home Tailnet",
          sectionName: "home-tailnet",
          authKey: "tskey-auth-test",
          controlUrl: "",
          hostname: "",
          derpOnly: false,
          exitNode: "none",
          idleKeepalive: 600,
          preferIpv6: false,
          dnsServer: [],
          mtu: 1280,
          underlyingProxy: "direct",
          testUrl: "",
          testTimeout: 5,
          enabled: true
        }]
      }
    });
    expect(directTailscaleUnderlyingProxy.surge.tailscaleNodes[0]?.underlyingProxy).toBe("");

    const unsupportedDnsMode = normalizeConfig({
      ...DEFAULT_CONFIG,
      clash: {
        ...DEFAULT_CONFIG.clash,
        dnsEnhancedMode: "normal"
      }
    });
    expect(unsupportedDnsMode.clash.dnsEnhancedMode).toBe(DEFAULT_CONFIG.clash.dnsEnhancedMode);

    const legacyTargetOverrides = normalizeConfig({
      ...DEFAULT_CONFIG,
      ruleSets: {
        ...DEFAULT_CONFIG.ruleSets,
        directRules: [{
          id: "legacy-targets",
          name: "Legacy Targets",
          enabled: true,
          rule: "DOMAIN-SUFFIX,example.com,Proxy",
          policy: "Proxy",
          targetMode: "explicit",
          targets: ["clash"],
          rawByTarget: { clash: "DOMAIN-SUFFIX,example.com,DIRECT" },
          order: 1
        }] as unknown as AppConfig["ruleSets"]["directRules"]
      }
    });
    expect(legacyTargetOverrides.ruleSets.directRules).toEqual([{
      id: "legacy-targets",
      name: "Legacy Targets",
      enabled: true,
      rule: "DOMAIN-SUFFIX,example.com,Proxy",
      policy: "Proxy",
      order: 1
    }]);
  });

  it("stores the complete config as one versioned encrypted snapshot", async () => {
    const kv = new Map<string, string>([[CONFIG_SCHEMA_VERSION_KEY, String(CURRENT_KV_SCHEMA_VERSION)]]);
    const env = makeEnv(kv);
    const saved = await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        userAgentSurge: "Surge iOS/3727",
        userAgentStash: "Stash/Test",
        userAgentShadowrocket: "Shadowrocket/Test",
        displayTimeZone: "UTC",
        notificationChannel: "telegram",
        notificationTelegramChatId: "123456",
        notificationTelegramBotToken: "telegram-token"
      },
      groups: {
        Proxy: "select, Auto",
        Auto: "url-test, Proxy, {all}, url=https://www.gstatic.com/generate_204, interval=600"
      },
      disabledGroups: ["Auto"],
      sources: [{
        id: "src1",
        name: "Primary",
        url: "https://example.com/sub",
        fetchUserAgent: "shadowrocket",
        enabled: true
      }],
      proxyNodes: [{
        id: "exit",
        config: "Chain Exit = socks5, 1.1.1.1, 1080, username=u, password=p",
        chainFilter: ["JP"],
        enabled: true,
        chainExit: true,
        includeInGroups: true
      }, {
        id: "snell",
        config: [
          "# user maintained Clash YAML",
          "name: Snell Exit",
          "type: snell",
          "server: snell.example.com",
          "port: 44046",
          "psk: secret",
          "version: 4"
        ].join("\n"),
        chainFilter: [],
        enabled: true,
        chainExit: false,
        includeInGroups: true
      }],
      chain: {
        filter: ["JP"]
      },
      ruleSets: {
        mode: "compiled",
        aggregateByPolicy: false,
        sources: [{
          id: "rules",
          name: "Rules",
          url: "https://example.com/rules.list",
          enabled: true,
          format: "surge-rule-set",
          order: 1
        }],
        outputs: [{
          name: "AI",
          enabled: true,
          policy: "Proxy",
          sourceIds: ["rules"],
          inlineRules: ["DOMAIN-SUFFIX,example.com,Proxy"],
          order: 2,
          surgeOptions: ["extended-matching"]
        }],
        directRules: [{
          id: "final",
          name: "Final",
          enabled: true,
          rule: "FINAL,Proxy",
          policy: "Proxy",
          order: 99
        }]
      },
      surge: {
        ...DEFAULT_CONFIG.surge,
        hosts: [
          "example.com = 1.2.3.4",
          "dns.example.com = server:8.8.8.8"
        ],
        ponteDeviceNames: ["Air", "DEVICE:iPhone", "Air", "bad,name"],
        urlRewrite: [
          "^https?:\\/\\/example\\.com\\/ad - reject",
          "^https?:\\/\\/old\\.example\\.com https://new.example.com 302"
        ],
        mapLocal: ['^https?:\\/\\/example\\.com\\/api data-type=text data="{\\"ok\\":true}" status-code=200 header="Content-Type:application/json"'],
        scripts: ["Test Script = type=http-response,pattern=^https://example.com,script-path=https://example.com/script.js"],
        mitm: {
          ...DEFAULT_CONFIG.surge.mitm,
          hostname: ["api.m.jd.com"],
          caPassphrase: "test-passphrase",
          caP12: "BASE64P12"
        },
        rules: ["FINAL,Proxy"]
      },
      clash: {
        ...DEFAULT_CONFIG.clash,
        mixedPort: 7899,
        rules: ["MATCH,Proxy"]
      },
      stash: {
        ...DEFAULT_CONFIG.stash,
        port: 7900,
        hosts: ["stash.example.com = 4.4.4.4"],
        urlRewrite: ["^https?:\\/\\/stash\\.example\\.com\\/ad - reject"],
        scripts: ["Stash Script = type=http-response,requires-body=1,max-size=0,pattern=^https://stash.example.com,script-path=https://stash.example.com/script.js"],
        mitm: {
          hostname: ["stash.example.com"]
        },
        dns: {
          ...DEFAULT_CONFIG.stash.dns,
          nameservers: ["9.9.9.9"]
        },
        rules: ["MATCH,Proxy"]
      }
    });

    const snapshotKeys = [...kv.keys()].filter((key) => key.startsWith(CONFIG_SNAPSHOT_VERSION_PREFIX));
    expect(snapshotKeys).toHaveLength(1);
    const stored = String(kv.get(snapshotKeys[0]!));
    expect(stored).toMatch(/^v1\./);
    const configKeys = [...kv.keys()].filter((key) => key.startsWith("config:"));
    expect(configKeys).toContain(CONFIG_SCHEMA_VERSION_KEY);
    expect(configKeys).not.toContain(CONFIG_SNAPSHOT_KEY);
    expect(configKeys.filter((key) => key !== CONFIG_SCHEMA_VERSION_KEY && !key.startsWith(CONFIG_SNAPSHOT_VERSION_PREFIX))
      .every((key) => key.startsWith(CONFIG_CLEANUP_COMPLETE_PREFIX))).toBe(true);
    const allStoredValues = [...kv.values()].map(String).join("\n");
    for (const sentinel of [
      "https://example.com/sub",
      "telegram-token",
      "password=p",
      "psk: secret",
      "test-passphrase",
      "BASE64P12"
    ]) {
      expect(allStoredValues).not.toContain(sentinel);
    }
    const snapshot = JSON.parse(await decryptText("config-secret", stored)) as { version: number; config: AppConfig };
    expect(snapshot.version).toBe(1);
    expect(snapshot.config).toMatchObject({
      settings: {
        userAgentSurge: "Surge iOS/3727",
        userAgentStash: "Stash/Test",
        displayTimeZone: "UTC",
        notificationTelegramBotToken: "telegram-token"
      },
      disabledGroups: ["Auto"],
      proxyNodes: [{ id: "exit" }, { id: "snell" }],
      ruleSets: { mode: "compiled" },
      surge: { ponteDeviceNames: ["Air", "iPhone"] },
      clash: { mixedPort: 7899 },
      stash: { port: 7900 }
    });

    const loaded = await loadConfig(env);
    expect(loaded).toEqual(saved);
    expect(loaded.sources[0]).toMatchObject({ id: "src1", url: "https://example.com/sub", fetchUserAgent: "shadowrocket" });
    expect(loaded.stash.port).toBe(7900);
    expect(loaded.stash.mitm).toEqual({ hostname: ["stash.example.com"] });
    expect("shadowrocket" in loaded).toBe(false);
  });

  it("orders concurrent same-millisecond saves by issuance instead of put completion", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const kv = new Map<string, string>([[CONFIG_SCHEMA_VERSION_KEY, String(CURRENT_KV_SCHEMA_VERSION)]]);
    const env = makeEnv(kv);
    const originalPut = env.SUBPILOT_CONFIG.put.bind(env.SUBPILOT_CONFIG);
    let releaseFirstPut: (() => void) | undefined;
    let reportFirstPut: (() => void) | undefined;
    const firstPutStarted = new Promise<void>((resolve) => {
      reportFirstPut = resolve;
    });
    const firstPutGate = new Promise<void>((resolve) => {
      releaseFirstPut = resolve;
    });
    let blockedFirstSnapshot = false;
    vi.spyOn(env.SUBPILOT_CONFIG, "put").mockImplementation(async (...args) => {
      if (String(args[0]).startsWith(CONFIG_SNAPSHOT_VERSION_PREFIX) && !blockedFirstSnapshot) {
        blockedFirstSnapshot = true;
        reportFirstPut?.();
        await firstPutGate;
      }
      return originalPut(...args);
    });

    const firstSave = saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: { ...DEFAULT_CONFIG.settings, userAgentSurge: "First" }
    });
    await firstPutStarted;
    const secondSave = saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: { ...DEFAULT_CONFIG.settings, userAgentSurge: "Second" }
    });
    await expect(secondSave).resolves.toMatchObject({ settings: { userAgentSurge: "Second" } });
    releaseFirstPut?.();
    await expect(firstSave).resolves.toMatchObject({ settings: { userAgentSurge: "First" } });

    expect([...kv.keys()].filter((key) => key.startsWith(CONFIG_SNAPSHOT_VERSION_PREFIX))).toHaveLength(2);
    await expect(loadConfig(env)).resolves.toMatchObject({ settings: { userAgentSurge: "Second" } });
  });

  it("falls back from a corrupt newest snapshot and fails closed when none are valid", async () => {
    const kv = new Map<string, string>([[CONFIG_SCHEMA_VERSION_KEY, String(CURRENT_KV_SCHEMA_VERSION)]]);
    const env = makeEnv(kv);
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: { ...DEFAULT_CONFIG.settings, userAgentSurge: "Older valid" }
    });
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: { ...DEFAULT_CONFIG.settings, userAgentSurge: "Newest" }
    });
    const keys = [...kv.keys()].filter((key) => key.startsWith(CONFIG_SNAPSHOT_VERSION_PREFIX)).sort();
    kv.set(keys[0]!, "corrupt-newest-snapshot");

    await expect(loadConfig(env)).resolves.toMatchObject({ settings: { userAgentSurge: "Older valid" } });
    for (const key of keys) kv.set(key, "corrupt-snapshot");
    await expect(loadConfig(env)).rejects.toThrow("No valid encrypted config snapshot is available");
  });

  it("bounds version discovery while reading the newest snapshot", async () => {
    const env = makeEnv();
    await saveConfig(env, DEFAULT_CONFIG);
    const listSpy = vi.spyOn(env.SUBPILOT_CONFIG, "list");

    await expect(loadConfig(env)).resolves.toMatchObject({ version: 1 });

    expect(listSpy).toHaveBeenCalledWith({
      prefix: CONFIG_SNAPSHOT_VERSION_PREFIX,
      limit: 64
    });
  });

  it("continues to read the legacy fixed encrypted snapshot", async () => {
    const kv = new Map<string, string>([[CONFIG_SCHEMA_VERSION_KEY, String(CURRENT_KV_SCHEMA_VERSION)]]);
    const env = makeEnv(kv);
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: { ...DEFAULT_CONFIG.settings, userAgentSurge: "Legacy fixed" }
    });
    const versionKey = [...kv.keys()].find((key) => key.startsWith(CONFIG_SNAPSHOT_VERSION_PREFIX));
    expect(versionKey).toBeDefined();
    kv.set(CONFIG_SNAPSHOT_KEY, kv.get(versionKey!)!);
    kv.delete(versionKey!);

    await expect(loadConfig(env)).resolves.toMatchObject({ settings: { userAgentSurge: "Legacy fixed" } });
  });

  it("prunes old snapshot versions in bounded batches while retaining a readable head", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const kv = new Map<string, string>([[CONFIG_SCHEMA_VERSION_KEY, String(CURRENT_KV_SCHEMA_VERSION)]]);
    const env = makeEnv(kv);
    for (let index = 0; index < 25; index += 1) {
      await saveConfig(env, {
        ...DEFAULT_CONFIG,
        clash: { ...DEFAULT_CONFIG.clash, port: 8_000 + index }
      });
    }
    now += 5 * 60 * 1_000 + 1;
    const deleteSpy = vi.spyOn(env.SUBPILOT_CONFIG, "delete");
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      clash: { ...DEFAULT_CONFIG.clash, port: 9_999 }
    });

    const versionDeletes = deleteSpy.mock.calls.filter(([key]) => String(key).startsWith(CONFIG_SNAPSHOT_VERSION_PREFIX));
    expect(versionDeletes).toHaveLength(20);
    expect([...kv.keys()].filter((key) => key.startsWith(CONFIG_SNAPSHOT_VERSION_PREFIX)).length).toBeGreaterThanOrEqual(3);
    await expect(loadConfig(env)).resolves.toMatchObject({ clash: { port: 9_999 } });
  });

  it("migrates legacy split config into an encrypted append-only snapshot and removes plaintext after the grace period", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-20T00:00:00.000Z"));
    const sourceUrl = "https://legacy.example/sub?token=source-sentinel";
    const proxySecret = "proxy-password-sentinel";
    const tailscaleSecret = "tskey-auth-sentinel";
    const p12Secret = "P12-SENTINEL";
    const botSecret = "telegram-bot-sentinel";
    const kv = new Map<string, string>([
      [CONFIG_SCHEMA_VERSION_KEY, String(CURRENT_KV_SCHEMA_VERSION)],
      ["config:settings:managedBaseUrl", JSON.stringify("https://legacy.example/sync")],
      ["config:settings:notificationTelegramBotToken", await encryptText("config-secret", botSecret)],
      ["config:sources:index", JSON.stringify(["legacy-source"])],
      ["config:sources:legacy-source", JSON.stringify({
        id: "legacy-source",
        name: "Legacy",
        url: "",
        urlEncrypted: await encryptText("config-secret", sourceUrl),
        fetchUserAgent: "surge",
        enabled: true
      })],
      ["config:proxyNodes:index", JSON.stringify(["legacy-proxy"])],
      ["config:proxyNodes:legacy-proxy", JSON.stringify({
        id: "legacy-proxy",
        config: `Legacy = socks5, proxy.example, 1080, password=${proxySecret}`,
        chainFilter: [],
        enabled: true,
        chainExit: false,
        includeInGroups: true
      })],
      ["config:surge:tailscaleNodes", JSON.stringify([{
        name: "Legacy Tailnet",
        sectionName: "legacy-tailnet",
        authKey: tailscaleSecret,
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
      }])],
      ["config:surge:mitm", JSON.stringify({
        ...DEFAULT_CONFIG.surge.mitm,
        caPassphrase: "p12-passphrase-sentinel",
        caP12: p12Secret
      })]
    ]);
    const env = makeEnv(kv);

    const loaded = await loadConfig(env);

    expect(loaded.sources[0]?.url).toBe(sourceUrl);
    expect(loaded.proxyNodes[0]?.config).toContain(proxySecret);
    expect(loaded.surge.tailscaleNodes[0]?.authKey).toBe(tailscaleSecret);
    expect(loaded.surge.mitm.caP12).toBe(p12Secret);
    expect(loaded.settings.notificationTelegramBotToken).toBe(botSecret);
    expect(kv.has(CONFIG_SNAPSHOT_KEY)).toBe(false);
    expect([...kv.keys()].filter((key) => key.startsWith(CONFIG_MIGRATED_SNAPSHOT_PREFIX))).toHaveLength(1);
    expect([...kv.keys()].some((key) => key.startsWith(CONFIG_CLEANUP_PENDING_PREFIX))).toBe(true);
    expect(kv.has("config:settings:managedBaseUrl")).toBe(true);

    vi.advanceTimersByTime(5 * 60 * 1_000 + 1);
    await expect(loadConfig(env)).resolves.toEqual(loaded);

    expect(kv.has("config:settings:managedBaseUrl")).toBe(false);
    expect([...kv.keys()].some((key) => key.startsWith(CONFIG_CLEANUP_COMPLETE_PREFIX))).toBe(true);
    const storedValues = [...kv.values()].map(String).join("\n");
    for (const sentinel of [sourceUrl, proxySecret, tailscaleSecret, p12Secret, "p12-passphrase-sentinel", botSecret]) {
      expect(storedValues).not.toContain(sentinel);
    }
    await expect(loadConfig(env)).resolves.toEqual(loaded);
  });

  it("uses append-only migration records for concurrent first loads without same-key write throttling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-20T00:00:00.000Z"));
    const kv = new Map<string, string>([
      [CONFIG_SCHEMA_VERSION_KEY, String(CURRENT_KV_SCHEMA_VERSION)],
      ["config:settings:managedBaseUrl", JSON.stringify("https://legacy.example/sync")],
      ["config:settings:userAgentSurge", JSON.stringify("Legacy Surge")],
      ["config:clash:port", JSON.stringify(9876)]
    ]);
    const env = makeEnv(kv);
    const putSpy = rejectRapidDuplicateWrites(env);

    const loaded = await Promise.all(Array.from({ length: 8 }, () => loadConfig(env)));

    expect(loaded.map((config) => [config.settings.managedBaseUrl, config.settings.userAgentSurge, config.clash.port]))
      .toEqual(Array.from({ length: 8 }, () => ["https://legacy.example/sync", "Legacy Surge", 9876]));
    expect(putSpy.mock.calls.filter(([key]) => key === CONFIG_SNAPSHOT_KEY)).toHaveLength(0);
    expect([...kv.keys()].filter((key) => key.startsWith(CONFIG_MIGRATED_SNAPSHOT_PREFIX)).length).toBeGreaterThan(0);
  });

  it("cleans large legacy config layouts in bounded batches before marking completion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-20T00:00:00.000Z"));
    const kv = new Map<string, string>([[CONFIG_SCHEMA_VERSION_KEY, String(CURRENT_KV_SCHEMA_VERSION)]]);
    for (let index = 0; index < 450; index += 1) {
      kv.set(`config:obsolete:${String(index).padStart(4, "0")}`, JSON.stringify(index));
    }
    const env = makeEnv(kv);
    const obsoleteKeyCount = () => [...kv.keys()].filter((key) => key.startsWith("config:obsolete:")).length;
    const cleanupCompleteCount = () => [...kv.keys()].filter((key) => key.startsWith(CONFIG_CLEANUP_COMPLETE_PREFIX)).length;

    await loadConfig(env);
    expect(obsoleteKeyCount()).toBe(450);
    vi.advanceTimersByTime(5 * 60 * 1_000 + 1);

    await loadConfig(env);
    expect(obsoleteKeyCount()).toBe(250);
    expect(cleanupCompleteCount()).toBe(0);
    await loadConfig(env);
    expect(obsoleteKeyCount()).toBe(50);
    expect(cleanupCompleteCount()).toBe(0);
    await loadConfig(env);
    expect(obsoleteKeyCount()).toBe(0);
    expect(cleanupCompleteCount()).toBe(1);
  });

  it("leaves either the complete old or complete new snapshot when the atomic KV put fails", async () => {
    for (const commitBeforeFailure of [false, true]) {
      const env = makeEnv();
      await saveConfig(env, {
        ...DEFAULT_CONFIG,
        settings: { ...DEFAULT_CONFIG.settings, userAgentSurge: "Old Surge" },
        clash: { ...DEFAULT_CONFIG.clash, port: 7001 }
      });
      const originalPut = env.SUBPILOT_CONFIG.put.bind(env.SUBPILOT_CONFIG);
      const putSpy = vi.spyOn(env.SUBPILOT_CONFIG, "put").mockImplementation(async (...args) => {
        if (!String(args[0]).startsWith(CONFIG_SNAPSHOT_VERSION_PREFIX)) return originalPut(...args);
        if (commitBeforeFailure) await originalPut(...args);
        throw new Error("injected snapshot put failure");
      });

      await expect(saveConfig(env, {
        ...DEFAULT_CONFIG,
        settings: { ...DEFAULT_CONFIG.settings, userAgentSurge: "New Surge" },
        clash: { ...DEFAULT_CONFIG.clash, port: 7002 }
      })).rejects.toThrow("injected snapshot put failure");
      putSpy.mockRestore();

      const loaded = await loadConfig(env);
      expect([loaded.settings.userAgentSurge, loaded.clash.port]).toEqual(commitBeforeFailure
        ? ["New Surge", 7002]
        : ["Old Surge", 7001]);
    }
  });

  it("keeps a committed snapshot when post-commit derived cache pruning fails", async () => {
    const kv = new Map<string, string>();
    const env = makeEnv(kv);
    const sourceUrl = "https://example.com/old";
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      sources: [{ id: "old", name: "Old", url: sourceUrl, fetchUserAgent: "surge", enabled: true }]
    });
    const sourceKey = `cache:source:${await sha256Hex(`${sourceUrl}|Surge iOS/3727`)}`;
    const meta = { key: sourceKey, fetchedAt: "2026-06-20T01:00:00.000Z", sourceId: "old", sourceName: "Old" };
    kv.set(sourceKey, "legacy cache");
    kv.set(`cache:sourceMeta:${sourceKey.slice("cache:source:".length)}`, JSON.stringify(meta));
    kv.set("cache:sourceMeta:index", JSON.stringify([meta]));
    const originalDelete = env.SUBPILOT_CONFIG.delete.bind(env.SUBPILOT_CONFIG);
    const deleteSpy = vi.spyOn(env.SUBPILOT_CONFIG, "delete").mockImplementation(async (key) => {
      if (key === sourceKey) throw new Error("injected cache prune failure");
      return originalDelete(key);
    });

    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(saveConfig(env, { ...DEFAULT_CONFIG, sources: [] })).resolves.toMatchObject({ sources: [] });
    deleteSpy.mockRestore();

    expect((await loadConfig(env)).sources).toEqual([]);
    expect(kv.has(sourceKey)).toBe(true);
  });

  it("encrypts new source cache content and lazily migrates legacy plaintext", async () => {
    const kv = new Map<string, string>();
    const env = makeEnv(kv);
    const source = {
      id: "secure-source",
      name: "Secure",
      url: "https://example.com/secure",
      fetchUserAgent: "surge" as const,
      enabled: true
    };
    const userAgent = "Surge iOS/3727";
    const sourceKey = `cache:source:${await sha256Hex(`${source.url}|${userAgent}`)}`;
    const freshContent = "Fresh = trojan, fresh.example.com, 443, password=fresh-cache-sentinel";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(freshContent));

    await expect(fetchCachedSource(env, source, userAgent)).resolves.toBe(freshContent);
    const encryptedFresh = String(kv.get(sourceKey));
    expect(encryptedFresh.startsWith(ENCRYPTED_CACHE_STORAGE_PREFIX)).toBe(true);
    expect(encryptedFresh).not.toContain("fresh-cache-sentinel");
    expect(await decryptText("config-secret", encryptedFresh.slice(ENCRYPTED_CACHE_STORAGE_PREFIX.length))).toBe(freshContent);
    await expect(fetchCachedSource(env, source, userAgent)).resolves.toBe(freshContent);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const legacyContent = "Legacy = trojan, legacy.example.com, 443, password=legacy-cache-sentinel";
    kv.set(sourceKey, legacyContent);
    await expect(fetchCachedSource(env, source, userAgent)).resolves.toBe(legacyContent);
    const migrated = String(kv.get(sourceKey));
    expect(migrated.startsWith(ENCRYPTED_CACHE_STORAGE_PREFIX)).toBe(true);
    expect(migrated).not.toContain("legacy-cache-sentinel");
    expect(await decryptText("config-secret", migrated.slice(ENCRYPTED_CACHE_STORAGE_PREFIX.length))).toBe(legacyContent);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("self-heals corrupt encrypted source cache content with one same-key write", async () => {
    const kv = new Map<string, string>();
    const env = makeEnv(kv);
    const source = {
      id: "corrupt-source",
      name: "Corrupt",
      url: "https://example.com/corrupt",
      fetchUserAgent: "surge" as const,
      enabled: true
    };
    const userAgent = "Surge iOS/3727";
    const sourceKey = `cache:source:${await sha256Hex(`${source.url}|${userAgent}`)}`;
    kv.set(sourceKey, `${ENCRYPTED_CACHE_STORAGE_PREFIX}not-an-envelope`);
    const freshContent = "Fresh = trojan, fresh.example.com, 443, password=p";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(freshContent));
    const deleteSpy = vi.spyOn(env.SUBPILOT_CONFIG, "delete");
    const putSpy = vi.spyOn(env.SUBPILOT_CONFIG, "put");

    await expect(fetchCachedSource(env, source, userAgent)).resolves.toBe(freshContent);

    expect(deleteSpy).not.toHaveBeenCalledWith(sourceKey);
    expect(putSpy.mock.calls.filter(([key]) => key === sourceKey)).toHaveLength(1);
    const stored = String(kv.get(sourceKey));
    expect(await decryptText("config-secret", stored.slice(ENCRYPTED_CACHE_STORAGE_PREFIX.length))).toBe(freshContent);
  });

  it("returns structured failures for sources left after an absolute refresh deadline", async () => {
    const kv = new Map<string, string>();
    const env = makeEnv(kv);
    const cachedUrl = "https://example.com/cached";
    const cachedKey = `cache:source:${await sha256Hex(`${cachedUrl}|Surge iOS/3727`)}`;
    const cachedMeta = {
      key: cachedKey,
      fetchedAt: "2026-06-20T01:00:00.000Z",
      sourceId: "cached",
      sourceName: "Cached",
      contentAvailable: true,
      nodeCount: 1,
      protocolCounts: [{ protocol: "trojan", count: 1 }]
    };
    kv.set(cachedKey, "Cached = trojan, cached.example.com, 443, password=p");
    kv.set(`cache:sourceMeta:${cachedKey.slice("cache:source:".length)}`, JSON.stringify(cachedMeta));
    kv.set("cache:sourceMeta:index", JSON.stringify([cachedMeta]));
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const config = {
      ...DEFAULT_CONFIG,
      sources: [
        { id: "cached", name: "Cached", url: cachedUrl, fetchUserAgent: "surge" as const, enabled: true },
        { id: "missing", name: "Missing", url: "https://example.com/missing", fetchUserAgent: "surge" as const, enabled: true }
      ]
    };

    const result = await refreshSourceCache(env, config, { deadline: Date.now() - 1 });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ refreshed: 0, failed: 2, cached: 1 });
    expect(result.failures).toEqual([
      {
        sourceId: "cached",
        sourceName: "Cached",
        reason: "Source cache refresh deadline exceeded",
        usedCachedContent: true
      },
      {
        sourceId: "missing",
        sourceName: "Missing",
        reason: "Source cache refresh deadline exceeded",
        usedCachedContent: false
      }
    ]);
  });

  it("clears source caches immediately when sources are disabled, deleted, or orphaned", async () => {
    const kv = new Map<string, string>();
    const env = makeEnv(kv);
    const fetchedAt = "2026-06-20T01:00:00.000Z";
    const disabledKey = `cache:source:${await sha256Hex("https://example.com/disabled|Surge iOS/3727")}`;
    const deletedKey = `cache:source:${await sha256Hex("https://example.com/deleted|Surge iOS/3727")}`;
    const orphanDeletedKey = `cache:source:${await sha256Hex("https://example.com/orphan-deleted|Surge iOS/3727")}`;
    const orphanKey = `cache:source:${await sha256Hex("https://example.com/orphan|Surge iOS/3727")}`;
    const enabledKey = `cache:source:${await sha256Hex("https://example.com/enabled|Surge iOS/3727")}`;
    const cacheEntries = [
      { key: disabledKey, fetchedAt, sourceId: "disabled", sourceName: "Disabled" },
      { key: deletedKey, fetchedAt, sourceId: "deleted", sourceName: "Deleted" },
      { key: enabledKey, fetchedAt, sourceId: "enabled", sourceName: "Enabled" }
    ];
    for (const entry of cacheEntries) {
      kv.set(entry.key, `${entry.sourceId}-content`);
      kv.set(`cache:sourceMeta:${entry.key.slice("cache:source:".length)}`, JSON.stringify(entry));
    }
    kv.set(orphanDeletedKey, "orphan-deleted-content");
    kv.set(orphanKey, "orphan-content");
    kv.set("cache:sourceMeta:index", JSON.stringify(cacheEntries));

    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      sources: [
        {
          id: "disabled",
          name: "Disabled",
          url: "https://example.com/disabled",
          fetchUserAgent: "surge",
          enabled: false
        },
        {
          id: "enabled",
          name: "Enabled",
          url: "https://example.com/enabled",
          fetchUserAgent: "surge",
          enabled: true
        }
      ]
    });

    expect(kv.has(disabledKey)).toBe(false);
    expect(kv.has(`cache:sourceMeta:${disabledKey.slice("cache:source:".length)}`)).toBe(false);
    expect(kv.has(deletedKey)).toBe(false);
    expect(kv.has(`cache:sourceMeta:${deletedKey.slice("cache:source:".length)}`)).toBe(false);
    expect(kv.has(orphanDeletedKey)).toBe(false);
    expect(kv.has(orphanKey)).toBe(false);
    const retained = String(kv.get(enabledKey));
    expect(retained.startsWith(ENCRYPTED_CACHE_STORAGE_PREFIX)).toBe(true);
    expect(retained).not.toContain("enabled-content");
    expect(await decryptText("config-secret", retained.slice(ENCRYPTED_CACHE_STORAGE_PREFIX.length))).toBe("enabled-content");
    expect(JSON.parse(kv.get("cache:sourceMeta:index") ?? "[]")).toEqual([{
      ...cacheEntries[2],
      contentAvailable: true,
      nodeCount: 0,
      protocolCounts: []
    }]);
  });

  it("clears stale rule set caches in bounded batches when sources or outputs are disabled, deleted, or orphaned", async () => {
    const kv = new Map<string, string>([[CONFIG_SCHEMA_VERSION_KEY, String(CURRENT_KV_SCHEMA_VERSION)]]);
    const env = makeEnv(kv);
    const fetchedAt = "2026-06-20T01:00:00.000Z";
    const disabledSourceKey = `cache:ruleSetSource:${await sha256Hex("https://rules.example/disabled")}`;
    const deletedSourceKey = `cache:ruleSetSource:${await sha256Hex("https://rules.example/deleted")}`;
    const orphanSourceKey = `cache:ruleSetSource:${await sha256Hex("https://rules.example/orphan")}`;
    const enabledSourceKey = `cache:ruleSetSource:${await sha256Hex("https://rules.example/enabled")}`;
    const sourceEntries = [
      { key: disabledSourceKey, fetchedAt, sourceId: "disabled", sourceName: "Disabled", contentAvailable: true },
      { key: deletedSourceKey, fetchedAt, sourceId: "deleted", sourceName: "Deleted", contentAvailable: true },
      { key: enabledSourceKey, fetchedAt, sourceId: "enabled", sourceName: "Enabled", contentAvailable: true }
    ];
    for (const entry of sourceEntries) {
      kv.set(entry.key, `${entry.sourceId}-rules`);
      kv.set(`cache:ruleSetSourceMeta:${entry.key.slice("cache:ruleSetSource:".length)}`, JSON.stringify(entry));
    }
    kv.set(orphanSourceKey, "orphan-rules");
    kv.set("cache:ruleSetSourceMeta:index", JSON.stringify(sourceEntries));
    kv.set(compiledRuleSetMetaKey("Disabled"), JSON.stringify({ outputName: "Disabled", updatedAt: fetchedAt }));
    kv.set(compiledRuleSetContentKey("Disabled", "domain", "surge"), ".disabled.example");
    kv.set(compiledRuleSetMetaKey("Deleted"), JSON.stringify({ outputName: "Deleted", updatedAt: fetchedAt }));
    kv.set(compiledRuleSetContentKey("Deleted", "domain", "surge"), ".deleted.example");
    kv.set(compiledRuleSetContentKey("Orphan", "domain", "surge"), ".orphan.example");
    kv.set(compiledRuleSetMetaKey("Enabled"), JSON.stringify({ outputName: "Enabled", updatedAt: fetchedAt }));
    kv.set(compiledRuleSetContentKey("Enabled", "domain", "surge"), ".enabled.example");

    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      ruleSets: {
        mode: "compiled",
        aggregateByPolicy: false,
        sources: [{
          id: "disabled",
          name: "Disabled",
          url: "https://rules.example/disabled",
          enabled: false,
          format: "surge-rule-set",
          order: 1
        }, {
          id: "enabled",
          name: "Enabled",
          url: "https://rules.example/enabled",
          enabled: true,
          format: "surge-rule-set",
          order: 2
        }],
        outputs: [{
          name: "Disabled",
          enabled: false,
          policy: "Proxy",
          sourceIds: ["disabled"],
          inlineRules: [],
          order: 1,
          surgeOptions: []
        }, {
          name: "Enabled",
          enabled: true,
          policy: "Proxy",
          sourceIds: ["enabled"],
          inlineRules: [],
          order: 2,
          surgeOptions: []
        }],
        directRules: []
      }
    });

    expect(kv.has(disabledSourceKey)).toBe(false);
    expect(kv.has(`cache:ruleSetSourceMeta:${disabledSourceKey.slice("cache:ruleSetSource:".length)}`)).toBe(false);
    expect(kv.has(deletedSourceKey)).toBe(false);
    expect(kv.has(`cache:ruleSetSourceMeta:${deletedSourceKey.slice("cache:ruleSetSource:".length)}`)).toBe(false);
    expect(kv.has(orphanSourceKey)).toBe(false);
    const enabledSourceContent = String(kv.get(enabledSourceKey));
    expect(enabledSourceContent.startsWith(ENCRYPTED_CACHE_STORAGE_PREFIX)).toBe(true);
    expect(await decryptText("config-secret", enabledSourceContent.slice(ENCRYPTED_CACHE_STORAGE_PREFIX.length))).toBe("enabled-rules");
    expect(JSON.parse(kv.get("cache:ruleSetSourceMeta:index") ?? "[]")).toEqual([sourceEntries[2]]);
    expect(kv.has(compiledRuleSetMetaKey("Disabled"))).toBe(false);
    expect(kv.has(compiledRuleSetContentKey("Disabled", "domain", "surge"))).toBe(false);
    expect(kv.has(compiledRuleSetMetaKey("Deleted"))).toBe(false);
    expect(kv.has(compiledRuleSetContentKey("Deleted", "domain", "surge"))).toBe(false);
    expect(kv.has(compiledRuleSetContentKey("Orphan", "domain", "surge"))).toBe(true);
    expect(kv.has(compiledRuleSetMetaKey("Enabled"))).toBe(true);
    expect(kv.get(compiledRuleSetContentKey("Enabled", "domain", "surge"))).toBe(".enabled.example");

    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      ruleSets: {
        mode: "compiled",
        aggregateByPolicy: false,
        sources: [{
          id: "enabled",
          name: "Enabled",
          url: "https://rules.example/enabled",
          enabled: true,
          format: "surge-rule-set",
          order: 2
        }],
        outputs: [{
          name: "Enabled",
          enabled: true,
          policy: "Proxy",
          sourceIds: ["enabled"],
          inlineRules: [],
          order: 2,
          surgeOptions: []
        }],
        directRules: []
      }
    });

    expect(kv.has(compiledRuleSetContentKey("Orphan", "domain", "surge"))).toBe(false);
  });

  it("omits disabled groups while keeping their definitions stored", async () => {
    const fetchMock = mockSubscription("JP 1 = trojan, jp.example.com, 443, password=p");
    const env = makeEnv();
    const config = {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        geoipRenameEnabled: false
      },
      groups: {
        Proxy: "select, Auto, {all}",
        Auto: "url-test, {all}, url=https://www.gstatic.com/generate_204, interval=600"
      },
      disabledGroups: ["Auto"],
      sources: [{
        id: "src1",
        name: "Primary",
        url: "https://example.com/sub",
        fetchUserAgent: "surge" as const,
        enabled: true
      }],
      surge: {
        ...DEFAULT_CONFIG.surge,
        rules: [
          "RULE-SET,LAN,DIRECT",
          "AND,((IP-CIDR,192.0.2.0/24,no-resolve),(SUBNET,SSID:OfficeWiFi)),DIRECT",
          "RULE-SET,AutoRules,Auto",
          "DOMAIN-SUFFIX,removed.example,Removed",
          "FINAL,Auto,dns-failed"
        ]
      },
      clash: {
        ...DEFAULT_CONFIG.clash,
        rules: [
          "RULE-SET,LAN,DIRECT",
          "AND,((IP-CIDR,192.0.2.0/24,no-resolve),(SUBNET,SSID:OfficeWiFi)),DIRECT",
          "SUBNET,SSID:OfficeWiFi,DIRECT",
          "RULE-SET,AutoRules,Auto",
          "DOMAIN-SUFFIX,removed.example,Removed",
          "MATCH,Auto"
        ]
      }
    };

    const surge = await generateConfig(env, config, "surge", "https://subpilot.example.com/sync/token/");
    const clash = await generateConfig(env, config, "clash", "https://subpilot.example.com/sync/token/");

    expect(surge.content).toContain("[Primary] JP 1 = trojan, jp.example.com, 443");
    expect(surge.content).not.toContain("Auto = url-test");
    expect(surge.content).toContain("Proxy = select, [Primary] JP 1");
    expect(surge.content).not.toContain("policy-path=");
    expect(surge.content).toContain("RULE-SET,LAN,DIRECT");
    expect(surge.content).toContain("AND,((IP-CIDR,192.0.2.0/24,no-resolve),(SUBNET,SSID:OfficeWiFi)),DIRECT");
    expect(surge.content).toContain("RULE-SET,AutoRules,Proxy");
    expect(surge.content).toContain("DOMAIN-SUFFIX,removed.example,Proxy");
    expect(surge.content).toContain("FINAL,Proxy,dns-failed");
    expect(surge.content).not.toContain("FINAL,Auto");

    const parsed = YAML.parse(clash.content) as { "proxy-groups": Array<{ name: string; proxies: string[] }> };
    expect(parsed["proxy-groups"].map((group) => group.name)).toEqual(["Proxy"]);
    expect(parsed["proxy-groups"][0]?.proxies).toEqual(["[Primary] JP 1"]);
    const rules = (YAML.parse(clash.content) as { rules: string[] }).rules;
    expect(rules).toContain("RULE-SET,LAN,DIRECT");
    expect(rules).not.toContain("AND,((IP-CIDR,192.0.2.0/24,no-resolve),(SUBNET,SSID:OfficeWiFi)),DIRECT");
    expect(rules).not.toContain("SUBNET,SSID:OfficeWiFi,DIRECT");
    expect(rules).toContain("RULE-SET,AutoRules,Proxy");
    expect(rules).toContain("DOMAIN-SUFFIX,removed.example,Proxy");
    expect(rules).toContain("MATCH,Proxy");
    expect(rules).not.toContain("MATCH,Auto");
  });

  it("validates Surge rules, hosts, URL Rewrite entries, and inferred MITM hostnames", () => {
    expect(validateSurgeRules(DEFAULT_CONFIG)).toBeNull();

    const baseConfig = {
      groups: { Proxy: "select, {all}" },
      surge: {
        ...DEFAULT_CONFIG.surge,
        rules: [
          "RULE-SET,LAN,DIRECT",
          "RULE-SET,Remote,Proxy,no-resolve,extended-matching",
          "DOMAIN-SET,https://example.com/domain-set.txt,Proxy,extended-matching",
          "DOMAIN-SUFFIX,example.com,Proxy,extended-matching",
          "IP-CIDR,192.0.2.0/24,DEVICE:ExampleDevice,no-resolve",
          "GEOIP,CN,DIRECT,no-resolve",
          "FINAL,Proxy,dns-failed"
        ]
      }
    };

    expect(validateSurgeRules(baseConfig)).toBeNull();
    expect(validateSurgeRules({
      ...baseConfig,
      surge: {
        ...baseConfig.surge,
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
        }],
        rules: [
          "DOMAIN-SUFFIX,tailnet.example,Tailnet Exit",
          "FINAL,Proxy"
        ]
      }
    })).toBeNull();

    const invalidRuleCases: Array<[string[], string]> = [
      [["DOMAIN-SUFFIX,example.com,CustomPolicy"], "策略出口必须是已配置策略组、Tailscale 节点或 Surge 内置策略"],
      [["DOMAIN-SUFFIX,example.com,PASS", "FINAL,Proxy"], "策略出口必须是已配置策略组、Tailscale 节点或 Surge 内置策略"],
      [["DOMAIN-SUFFIX,example.com,REJECT-200", "FINAL,Proxy"], "策略出口必须是已配置策略组、Tailscale 节点或 Surge 内置策略"],
      [["RULE-SET,LAN"], "规则集语法"],
      [["DOMAIN-SUFFIX,example.com,Proxy,no-resolve", "FINAL,Proxy"], "附加参数"],
      [["IP-CIDR,192.0.2.0/24,Proxy,extended-matching", "FINAL,Proxy"], "附加参数"],
      [["DOMAIN-SET,https://example.com/domain-set.txt,Proxy,no-resolve", "FINAL,Proxy"], "附加参数"],
      [["FINAL,Proxy,extended-matching"], "附加参数"],
      [["RULE-SET,LAN,DIRECT,no-resolve,no-resolve", "FINAL,Proxy"], "附加参数不能重复"],
      [["DOMAIN-SUFFIX,example.com,Proxy"], "必须保留一个 FINAL"],
      [["FINAL,Proxy", "DOMAIN-SUFFIX,example.com,Proxy"], "FINAL 兜底规则必须位于最后"],
      [["FINAL,Proxy", "FINAL,DIRECT"], "只能保留一个 FINAL"]
    ];

    for (const [rules, message] of invalidRuleCases) {
      expect(validateSurgeRules({
        ...baseConfig,
        surge: {
          ...baseConfig.surge,
          rules
        }
      })).toContain(message);
    }

    expect(validateSurgeHosts({
      surge: {
        ...DEFAULT_CONFIG.surge,
        hosts: [
          "abc.com = 1.2.3.4",
          "*.dev = 6.7.8.9",
          "foo.com = bar.com",
          "bar.com = server:8.8.8.8",
          "Macbook = server:system",
          "example.com = server:https://cloudflare-dns.com/dns-query"
        ]
      }
    })).toBeNull();

    const invalidHostCases: Array<[string[], string]> = [
      [["[Host]"], "不能包含配置段标题"],
      [["abc.com 1.2.3.4"], "语法应为"],
      [["abc.com = "], "语法应为"],
      [["abc com = 1.2.3.4"], "主机名格式无效"],
      [["abc.com = server:"], "解析值格式无效"],
      [["abc.com = 1.2.3.4,"], "解析值存在空项"],
      [["abc.com = server:ftp://dns.example.com"], "解析值格式无效"]
    ];

    for (const [hosts, message] of invalidHostCases) {
      expect(validateSurgeHosts({
        surge: {
          ...DEFAULT_CONFIG.surge,
          hosts
        }
      })).toContain(message);
    }

    expect(validateSurgeUrlRewrite({
      surge: {
        ...DEFAULT_CONFIG.surge,
        urlRewrite: [
          "^https?:\\/\\/example\\.com\\/ad - reject",
          "^http:\\/\\/old\\.example\\.com https://new.example.com 302",
          "^http:\\/\\/www\\.example\\.com https://www2.example.com header"
        ]
      }
    })).toBeNull();

    const invalidUrlRewriteCases: Array<[string[], string]> = [
      [["[URL Rewrite]"], "不能包含配置段标题"],
      [["^http:\\/\\/ad\\.com -"], "语法应为"],
      [["^http:\\/\\/( - reject"], "正则表达式无效"],
      [["^http:\\/\\/ad\\.com - block"], "动作类型必须是"],
      [["^http:\\/\\/old\\.example\\.com - 302"], "需要有效替换 URL"]
    ];

    for (const [urlRewrite, message] of invalidUrlRewriteCases) {
      expect(validateSurgeUrlRewrite({
        surge: {
          ...DEFAULT_CONFIG.surge,
          urlRewrite
        }
      })).toContain(message);
    }

    expect(validateSurgeMapLocal({
      surge: {
        ...DEFAULT_CONFIG.surge,
        mapLocal: [
          '^http://surgetest\\.com/json data-type=text data="{}" status-code=500',
          '^http://surgetest\\.com/gif data-type=tiny-gif status-code=200',
          '^http://surgetest\\.com/file data-type=file data="data/map-local.json" header="a:b|foo:bar"',
          '^http://surgetest\\.com/base64 data-type=base64 data="dGVzdA=="'
        ]
      }
    })).toBeNull();

    const invalidMapLocalCases: Array<[string[], string]> = [
      [["[Map Local]"], "不能包含配置段标题"],
      [["^http://example\\.com data=\"{}\""], "data-type"],
      [["^http://example\\.com data-type=json data=\"{}\""], "data-type 必须是"],
      [["^http://example\\.com data-type=file"], "缺少 data"],
      [["^http://example\\.com data-type=text data=\"{}\" status-code=999"], "status-code"],
      [["^http://( data-type=text data=\"{}\""], "正则表达式无效"],
      [["^http://example\\.com data-type=text data=\"{}\" unknown=true"], "未知参数"]
    ];

    for (const [mapLocal, message] of invalidMapLocalCases) {
      expect(validateSurgeMapLocal({
        surge: {
          ...DEFAULT_CONFIG.surge,
          mapLocal
        }
      })).toContain(message);
    }

    expect(inferUrlRewriteMitmHostnames([
      "^https?:\\/\\/.+\\.pangolin-sdk-toutiao\\.com\\/api\\/ad - reject",
      "^https?:\\/\\/.+\\.(pglstatp-toutiao|pstatp)\\.com\\/obj\\/ad - reject",
      "^https?:\\/\\/gurd\\.snssdk\\.com\\/src\\/server - reject",
      "^https?:\\/\\/(ditu|maps).google\\.cn https://maps.google.com 302",
      "^http:\\/\\/.+\\.byteimg\\.com\\/ad - reject"
    ])).toEqual([
      "*.pangolin-sdk-toutiao.com",
      "*.pglstatp-toutiao.com",
      "*.pstatp.com",
      "gurd.snssdk.com",
      "ditu.google.cn",
      "maps.google.cn"
    ]);
  });

  it("removes Proxy fixed-group references from non-Proxy groups during generation", async () => {
    const fetchMock = mockSubscription("JP 1 = trojan, jp.example.com, 443, password=p");
    const env = makeEnv();
    const config = {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        geoipRenameEnabled: false
      },
      groups: {
        Proxy: "select, Auto, {all}",
        Auto: "select, Proxy, {all}"
      },
      sources: [{
        id: "src1",
        name: "Primary",
        url: "https://example.com/sub",
        fetchUserAgent: "surge" as const,
        enabled: true
      }]
    };

    const surge = await generateConfig(env, config, "surge", "https://subpilot.example.com/sync/token/");
    const clash = await generateConfig(env, config, "clash", "https://subpilot.example.com/sync/token/");

    expect(surge.content).toContain("[Primary] JP 1 = trojan, jp.example.com, 443");
    expect(surge.content).toContain("Auto = select, [Primary] JP 1");
    expect(surge.content).not.toContain("policy-path=");
    expect(surge.content).not.toContain("Auto = select, Proxy");
    const clashGroups = (YAML.parse(clash.content) as { "proxy-groups": Array<{ name: string; proxies: string[] }> })["proxy-groups"];
    expect(clashGroups.find((group) => group.name === "Auto")?.proxies).toEqual(["[Primary] JP 1"]);
  });

  it("outputs automatic selection as smart for Surge and url-test for Clash", async () => {
    const fetchMock = mockSubscription("JP 1 = trojan, jp.example.com, 443, password=p");
    const env = makeEnv();
    const config = {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        geoipRenameEnabled: false
      },
      groups: {
        Proxy: "select, Auto, {all}",
        Auto: "url-test, {all}, url=https://www.gstatic.com/generate_204, interval=600"
      },
      sources: [{
        id: "src1",
        name: "Primary",
        url: "https://example.com/sub",
        fetchUserAgent: "surge" as const,
        enabled: true
      }]
    };

    const surge = await generateConfig(env, config, "surge", "https://subpilot.example.com/sync/token/");
    const clash = await generateConfig(env, config, "clash", "https://subpilot.example.com/sync/token/");

    expect(surge.content).toContain("[Primary] JP 1 = trojan, jp.example.com, 443");
    expect(surge.content).toContain("Auto = smart, [Primary] JP 1");
    expect(surge.content).not.toContain("policy-path=");
    expect(surge.content).not.toContain("url=https://www.gstatic.com/generate_204, interval=600");

    const parsed = YAML.parse(clash.content) as { "proxy-groups": Array<{ name: string; type: string; url?: string; interval?: string | number }> };
    const autoGroup = parsed["proxy-groups"].find((group) => group.name === "Auto");
    expect(autoGroup?.type).toBe("url-test");
    expect(autoGroup?.url).toBe("https://www.gstatic.com/generate_204");
    expect(String(autoGroup?.interval)).toBe("600");
  });

  it("outputs hidden policy group options only for Surge", async () => {
    const fetchMock = mockSubscription("JP 1 = trojan, jp.example.com, 443, password=p");
    const env = makeEnv();
    const config = {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        geoipRenameEnabled: false
      },
      groups: {
        Proxy: "select, Manual, Auto, {all}",
        Manual: "select, Auto, hidden=true",
        Auto: "url-test, {all}, hidden=true, url=https://www.gstatic.com/generate_204, interval=600",
        Network: "subnet, default=Proxy, TYPE:WIFI=Auto, hidden=1"
      },
      sources: [{
        id: "src1",
        name: "Primary",
        url: "https://example.com/sub",
        fetchUserAgent: "surge" as const,
        enabled: true
      }]
    };

    const surge = await generateConfig(env, config, "surge", "https://subpilot.example.com/sync/token/");
    const clash = await generateConfig(env, config, "clash", "https://subpilot.example.com/sync/token/");

    expect(surge.content).toContain("Manual = select, Auto, hidden=true");
    expect(surge.content).toContain("Auto = smart, [Primary] JP 1, hidden=true");
    expect(surge.content).toContain("Network = subnet, default=Proxy, TYPE:WIFI=Auto, hidden=true");

    const groups = (YAML.parse(clash.content) as { "proxy-groups": Array<Record<string, unknown>> })["proxy-groups"];
    expect(groups.find((group) => group.name === "Manual")).not.toHaveProperty("hidden");
    expect(groups.find((group) => group.name === "Auto")).not.toHaveProperty("hidden");
    expect(groups.some((group) => group.name === "Network")).toBe(false);
  });

  it("outputs subnet policy groups only for Surge and rewrites Clash rule targets to Proxy", async () => {
    const fetchMock = mockSubscription("JP 1 = trojan, jp.example.com, 443, password=p");
    const env = makeEnv();
    const config = {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        geoipRenameEnabled: false
      },
      groups: {
        Proxy: "select, Auto, {all}",
        Auto: "url-test, {all}, url=https://www.gstatic.com/generate_204, interval=600",
        Network: "subnet, default=Proxy, default=Auto, TYPE:WIFI=Proxy, TYPE:WIFI=Proxy, SSID:Office=DIRECT"
      },
      sources: [{
        id: "src1",
        name: "Primary",
        url: "https://example.com/sub",
        fetchUserAgent: "surge" as const,
        enabled: true
      }],
      surge: {
        ...DEFAULT_CONFIG.surge,
        rules: ["DOMAIN-SUFFIX,network.example,Network"]
      },
      clash: {
        ...DEFAULT_CONFIG.clash,
        rules: ["DOMAIN-SUFFIX,network.example,Network"]
      }
    };

    const surge = await generateConfig(env, config, "surge", "https://subpilot.example.com/sync/token/");
    const clash = await generateConfig(env, config, "clash", "https://subpilot.example.com/sync/token/");

    expect(surge.content).toContain("[Primary] JP 1 = trojan, jp.example.com, 443");
    expect(surge.content).toContain("Network = subnet, default=Proxy, TYPE:WIFI=Proxy, TYPE:WIFI=Proxy, SSID:Office=DIRECT");
    expect(surge.content).toContain("Proxy = select, Auto, [Primary] JP 1");
    expect(surge.content).not.toContain("policy-path=");
    expect(surge.content).toContain("DOMAIN-SUFFIX,network.example,Network");

    const parsed = YAML.parse(clash.content) as { "proxy-groups": Array<{ name: string; type: string }>; rules: string[] };
    expect(parsed["proxy-groups"].map((group) => group.name)).toEqual(["Proxy", "Auto"]);
    expect(parsed["proxy-groups"].some((group) => group.type === "subnet")).toBe(false);
    expect(parsed.rules).toContain("DOMAIN-SUFFIX,network.example,Proxy");
    expect(parsed.rules).not.toContain("DOMAIN-SUFFIX,network.example,Network");
  });

});
