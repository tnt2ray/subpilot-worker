import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { generateConfig } from "../src/generator";
import { loadConfig, normalizeConfig, saveConfig } from "../src/config-store";
import { DEFAULT_CONFIG } from "../src/default-config";
import { validateSurgeHosts } from "../src/surge-hosts";
import { validateSurgeRules } from "../src/surge-rules";
import { inferUrlRewriteMitmHostnames, validateSurgeUrlRewrite } from "../src/surge-url-rewrite";
import { sha256Hex } from "../src/util";
import { makeEnv } from "./helpers/env";
import { mockSubscription, restoreMocksAfterEach } from "./helpers/fetch";

restoreMocksAfterEach();

describe("KV config storage", () => {
  it("derives Telegram notification channel from the bot token", () => {
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
  });

  it("stores settings, groups, sources, and client features as separate KV values", async () => {
    const kv = new Map<string, string>();
    const env = makeEnv(kv);
    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        userAgentSurge: "Surge iOS/3727",
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
        fetchUserAgent: "surge",
        enabled: true
      }],
      chain: {
        exitProxy: {
          protocol: "socks5",
          server: "1.1.1.1",
          port: 1080,
          username: "u",
          password: "p"
        },
        filter: ["JP"]
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
      }
    });

    expect(JSON.parse(kv.get("config:settings:userAgentSurge") ?? "null")).toBe("Surge iOS/3727");
    expect(JSON.parse(kv.get("config:settings:notificationChannel") ?? "null")).toBe("telegram");
    expect(JSON.parse(kv.get("config:settings:notificationTelegramChatId") ?? "null")).toBe("123456");
    expect(kv.get("config:settings:notificationTelegramBotToken")).toMatch(/^v1\./);
    expect(kv.get("config:settings:notificationTelegramBotToken")).not.toContain("telegram-token");
    expect(kv.has("config:settings:notificationEmailFrom")).toBe(false);
    expect(kv.has("config:settings:notificationEmailFromName")).toBe(false);
    expect(kv.has("config:settings:notificationEmailTo")).toBe(false);
    await expect(loadConfig(env).then((config) => config.settings.notificationTelegramBotToken)).resolves.toBe("telegram-token");
    expect(kv.has(`config:settings:${["userAgent", "Sing", "Box"].join("")}`)).toBe(false);
    expect(kv.has("config:settings:cacheTtlSeconds")).toBe(false);
    expect(kv.get("config:groups:Proxy")).toBe("select, Auto");
    expect(kv.get("config:groups:Auto")).toBe("url-test, {all}, url=https://www.gstatic.com/generate_204, interval=600");
    expect(JSON.parse(kv.get("config:groups:disabled") ?? "[]")).toEqual(["Auto"]);
    expect(JSON.parse(kv.get("config:chain:exitProxy") ?? "{}")).toEqual({
      protocol: "socks5",
      server: "1.1.1.1",
      port: 1080,
      username: "u",
      password: "p"
    });
    expect(JSON.parse(kv.get("config:chain:filter") ?? "[]")).toEqual(["JP"]);
    expect(kv.has("config:surge:loglevel")).toBe(false);
    expect(JSON.parse(kv.get("config:surge:skipProxy") ?? "[]")).toEqual([
      "127.0.0.1",
      "192.168.0.0/16",
      "10.0.0.0/8",
      "172.16.0.0/12",
      "100.64.0.0/10",
      "localhost",
      "*.local",
      "e.crashlytics.com",
      "captive.apple.com",
      "::ffff:0:0:0:0/1",
      "::ffff:128:0:0:0/1"
    ]);
    expect(JSON.parse(kv.get("config:surge:dnsServer") ?? "[]")).toEqual(["223.5.5.5", "223.6.6.6", "1.1.1.1", "8.8.8.8", "1.0.0.1", "8.8.4.4"]);
    expect(JSON.parse(kv.get("config:surge:alwaysRealIp") ?? "[]")).toContain("%APPEND% dns.msftncsi.com");
    expect(JSON.parse(kv.get("config:surge:managedConfigIntervalSeconds") ?? "null")).toBe(43200);
    expect(JSON.parse(kv.get("config:surge:proxyTestUrl") ?? "null")).toBe("http://cp.cloudflare.com/generate_204");
    expect(JSON.parse(kv.get("config:surge:showErrorPageForReject") ?? "null")).toBe(true);
    expect(JSON.parse(kv.get("config:surge:ipv6Vif") ?? "null")).toBe("auto");
    expect(JSON.parse(kv.get("config:surge:allowWifiAccess") ?? "null")).toBe(false);
    expect(JSON.parse(kv.get("config:surge:tunExcludedRoutes") ?? "[]")).toEqual([
      "192.168.0.0/16",
      "10.0.0.0/8",
      "172.16.0.0/12",
      "239.255.255.250/32"
    ]);
    expect(JSON.parse(kv.get("config:surge:encryptedDnsServer") ?? "[]")).toEqual([
      "https://1.1.1.1/dns-query",
      "quic://223.5.5.5",
      "quic://223.6.6.6",
      "https://223.5.5.5/dns-query"
    ]);
    expect(JSON.parse(kv.get("config:surge:wifiAssist") ?? "null")).toBe(false);
    expect(JSON.parse(kv.get("config:surge:excludeSimpleHostnames") ?? "null")).toBe(true);
    expect(JSON.parse(kv.get("config:surge:encryptedDnsFollowOutboundMode") ?? "null")).toBe(true);
    expect(JSON.parse(kv.get("config:surge:ponteDeviceNames") ?? "[]")).toEqual(["Air", "iPhone"]);
    expect(kv.has("config:surge:chainEnabled")).toBe(false);
    await expect(loadConfig(env).then((config) => config.surge.ponteDeviceNames)).resolves.toEqual(["Air", "iPhone"]);
    expect(JSON.parse(kv.get("config:surge:hosts") ?? "[]")).toEqual([
      "example.com = 1.2.3.4",
      "dns.example.com = server:8.8.8.8"
    ]);
    expect(JSON.parse(kv.get("config:surge:urlRewrite") ?? "[]")).toEqual([
      "^https?:\\/\\/example\\.com\\/ad - reject",
      "^https?:\\/\\/old\\.example\\.com https://new.example.com 302"
    ]);
    expect(JSON.parse(kv.get("config:surge:scripts") ?? "[]")).toEqual(["Test Script = type=http-response,pattern=^https://example.com,script-path=https://example.com/script.js"]);
    expect(JSON.parse(kv.get("config:surge:mitm") ?? "{}")).toEqual({
      skipServerCertVerify: true,
      h2: true,
      hostname: ["api.m.jd.com", "example.com", "old.example.com"],
      caPassphrase: "test-passphrase",
      caP12: "BASE64P12"
    });
    expect(JSON.parse(kv.get("config:surge:rules") ?? "[]")).toEqual(["FINAL,Proxy"]);
    expect(JSON.parse(kv.get("config:clash:mixedPort") ?? "0")).toBe(7899);
    expect(kv.has("config:clash:chainEnabled")).toBe(false);
    expect(JSON.parse(kv.get("config:clash:unifiedDelay") ?? "null")).toBe(true);
    expect(JSON.parse(kv.get("config:clash:tcpConcurrent") ?? "null")).toBe(true);
    expect(JSON.parse(kv.get("config:clash:externalController") ?? "null")).toBe("0.0.0.0:9090");
    expect(kv.has("config:clash:profile")).toBe(false);
    expect(JSON.parse(kv.get("config:clash:tun") ?? "{}")).toEqual({
      enable: true,
      stack: "system",
      autoRoute: true,
      autoDetectInterface: true,
      skipProxy: ["127.0.0.1/8", "192.168.0.0/16", "100.64.0.0/10", "172.16.0.0/12"]
    });
    expect(JSON.parse(kv.get("config:clash:defaultNameservers") ?? "[]")).toEqual(["223.5.5.5", "1.1.1.1"]);
    expect(JSON.parse(kv.get("config:clash:fallbackNameservers") ?? "[]")).toContain("https://1.1.1.1/dns-query");
    expect(JSON.parse(kv.get("config:clash:fakeIpFilter") ?? "[]")).toContain("dns.msftncsi.com");
    expect(JSON.parse(kv.get("config:clash:ruleProviders") ?? "\"\"")).toContain("rule-providers:");
    expect(JSON.parse(kv.get("config:clash:rules") ?? "[]")).toEqual(["MATCH,Proxy"]);
    expect(JSON.parse(kv.get("config:sources:index") ?? "[]")).toEqual(["src1"]);
    const storedSource = JSON.parse(kv.get("config:sources:src1") ?? "{}") as { url?: string; urlEncrypted?: string; fetchUserAgent?: string };
    expect(storedSource).toMatchObject({ url: "", fetchUserAgent: "surge" });
    expect(storedSource.urlEncrypted).toMatch(/^v1\./);
    expect(kv.get("config:sources:src1")).not.toContain("https://example.com/sub");
    const loaded = await loadConfig(env);
    expect(loaded.sources[0]).toMatchObject({ id: "src1", url: "https://example.com/sub", fetchUserAgent: "surge" });
  });

  it("clears source caches immediately when sources are disabled or deleted", async () => {
    const kv = new Map<string, string>();
    const env = makeEnv(kv);
    const fetchedAt = "2026-06-20T01:00:00.000Z";
    const disabledKey = `cache:source:${await sha256Hex("https://example.com/disabled|Surge iOS/3727")}`;
    const deletedKey = `cache:source:${await sha256Hex("https://example.com/deleted|Surge iOS/3727")}`;
    const orphanDeletedKey = `cache:source:${await sha256Hex("https://example.com/orphan-deleted|Surge iOS/3727")}`;
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
    expect(kv.get(enabledKey)).toBe("enabled-content");
    expect(JSON.parse(kv.get("cache:sourceMeta:index") ?? "[]")).toEqual([cacheEntries[2]]);
  });

  it("clears orphan source cache content even when metadata is missing", async () => {
    const kv = new Map<string, string>();
    const env = makeEnv(kv);
    const orphanKey = `cache:source:${await sha256Hex("https://example.com/orphan|Surge iOS/3727")}`;
    kv.set(orphanKey, "orphan-content");

    await saveConfig(env, {
      ...DEFAULT_CONFIG,
      sources: []
    });

    expect(kv.has(orphanKey)).toBe(false);
    expect(JSON.parse(kv.get("cache:sourceMeta:index") ?? "[]")).toEqual([]);
  });

  it("loads defaults when stored config has not been initialized", async () => {
    const env = makeEnv();
    const loaded = await loadConfig(env);
    expect(loaded).toMatchObject(DEFAULT_CONFIG);
  });

  it("keeps explicitly cleared chain filter and client feature lists empty", () => {
    const config = normalizeConfig({
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
      }
    });

    expect(config.chain.filter).toEqual([]);
    expect(config.surge.rules).toEqual([]);
    expect(config.clash.nameservers).toEqual([]);
    expect(config.clash.ruleProviders).toBe("");
    expect(config.clash.rules).toEqual([]);
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

  it("validates Surge rule syntax and rejects unknown policies", () => {
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

    const invalidCases: Array<[string[], string]> = [
      [["DOMAIN-SUFFIX,example.com,CustomPolicy"], "策略出口必须是已配置策略组或 Surge 内置策略"],
      [["DOMAIN-SUFFIX,example.com,PASS", "FINAL,Proxy"], "策略出口必须是已配置策略组或 Surge 内置策略"],
      [["DOMAIN-SUFFIX,example.com,REJECT-200", "FINAL,Proxy"], "策略出口必须是已配置策略组或 Surge 内置策略"],
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

    for (const [rules, message] of invalidCases) {
      expect(validateSurgeRules({
        ...baseConfig,
        surge: {
          ...baseConfig.surge,
          rules
        }
      })).toContain(message);
    }
  });

  it("validates Surge host syntax", () => {
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

    const invalidCases: Array<[string[], string]> = [
      [["[Host]"], "不能包含配置段标题"],
      [["abc.com 1.2.3.4"], "语法应为"],
      [["abc.com = "], "语法应为"],
      [["abc com = 1.2.3.4"], "主机名格式无效"],
      [["abc.com = server:"], "解析值格式无效"],
      [["abc.com = 1.2.3.4,"], "解析值存在空项"],
      [["abc.com = server:ftp://dns.example.com"], "解析值格式无效"]
    ];

    for (const [hosts, message] of invalidCases) {
      expect(validateSurgeHosts({
        surge: {
          ...DEFAULT_CONFIG.surge,
          hosts
        }
      })).toContain(message);
    }
  });

  it("validates Surge URL Rewrite syntax", () => {
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

    const invalidCases: Array<[string[], string]> = [
      [["[URL Rewrite]"], "不能包含配置段标题"],
      [["^http:\\/\\/ad\\.com -"], "语法应为"],
      [["^http:\\/\\/( - reject"], "正则表达式无效"],
      [["^http:\\/\\/ad\\.com - block"], "动作类型必须是"],
      [["^http:\\/\\/old\\.example\\.com - 302"], "需要有效替换 URL"]
    ];

    for (const [urlRewrite, message] of invalidCases) {
      expect(validateSurgeUrlRewrite({
        surge: {
          ...DEFAULT_CONFIG.surge,
          urlRewrite
        }
      })).toContain(message);
    }
  });

  it("infers MITM hostnames from HTTPS URL Rewrite patterns", () => {
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

  it("preserves subnet mapping options during normalization", () => {
    const config = normalizeConfig({
      ...DEFAULT_CONFIG,
      groups: {
        Proxy: "select, Auto",
        Auto: "url-test, {all}, url=https://www.gstatic.com/generate_204, interval=600",
        Network: "subnet, default=Proxy, default=Auto, TYPE:WIFI=Proxy, TYPE:WIFI=Proxy, SSID:Office=DIRECT, BSSID:Self=Network, Proxy, {all}, url=https://example.com"
      }
    });

    expect(config.groups.Network).toBe("subnet, default=Proxy, TYPE:WIFI=Proxy, TYPE:WIFI=Proxy, SSID:Office=DIRECT");
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

  it("does not expose client chain switches in normalized config", () => {
    const config = normalizeConfig({
      ...DEFAULT_CONFIG,
      chain: {
        exitProxy: {
          ...DEFAULT_CONFIG.chain.exitProxy,
          server: ""
        },
        filter: DEFAULT_CONFIG.chain.filter
      }
    });

    expect("chainEnabled" in config.surge).toBe(false);
    expect("chainEnabled" in config.clash).toBe(false);
  });

  it("normalizes unsupported Clash DNS enhanced modes to the default", () => {
    const config = normalizeConfig({
      ...DEFAULT_CONFIG,
      clash: {
        ...DEFAULT_CONFIG.clash,
        dnsEnhancedMode: "normal"
      }
    });

    expect(config.clash.dnsEnhancedMode).toBe(DEFAULT_CONFIG.clash.dnsEnhancedMode);
  });
});
