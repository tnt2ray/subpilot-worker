import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { generateConfig, inferTarget } from "../src/generator";
import { inferManagedBaseUrl, normalizeConfig, normalizeTarget, validateManagedBaseUrl, withInferredManagedBaseUrl } from "../src/config-store";
import { DEFAULT_CONFIG } from "../src/default-config";
import { makeEnv } from "./helpers/env";
import { mockSubscription, restoreMocksAfterEach } from "./helpers/fetch";

restoreMocksAfterEach();

describe("target inference", () => {
  it("infers targets from user-agent, normalizes preview targets, and keeps key defaults", () => {
    const request = new Request("https://example.com/sync/token?target=clash", {
      headers: { "user-agent": "Surge/5.0" }
    });
    expect(inferTarget(request)).toBe("surge");
    expect(inferTarget(new Request("https://example.com/sync/token?target=unsupported"))).toBeNull();

    expect(inferTarget(new Request("https://example.com/sync/token", { headers: { "user-agent": "Mihomo/1" } }))).toBe("clash");
    expect(inferTarget(new Request("https://example.com/sync/token", { headers: { "user-agent": "Stash/2.0 Clash.Meta" } }))).toBe("stash");
    expect(inferTarget(new Request("https://example.com/sync/token", { headers: { "user-agent": "Surge Mac/11390" } }))).toBe("surge");
    expect(inferTarget(new Request("https://example.com/sync/token", { headers: { "user-agent": "Surge iOS/3727" } }))).toBe("surge");
    expect(inferTarget(new Request("https://example.com/sync/token", { headers: { "user-agent": "TestClient/1" } }))).toBeNull();

    expect(normalizeTarget("surge")).toBe("surge");
    expect(normalizeTarget("clash")).toBe("clash");
    expect(normalizeTarget("stash")).toBe("stash");
    expect(normalizeTarget("unknown")).toBeNull();
    expect(normalizeTarget("surge2")).toBeNull();
    expect(normalizeTarget("mobile")).toBeNull();

    expect(DEFAULT_CONFIG.settings.userAgentSurge).toBe("Surge iOS/3727");
    expect(DEFAULT_CONFIG.settings.userAgentClash).toBe("clash-verge/v2.5.1");
    expect(DEFAULT_CONFIG.settings.excludeKeywords).toEqual(["过期", "剩余", "官网", "直接连接", "购买", "漏洞", "备用", "登陆", "工作室", "客服"]);
    expect(DEFAULT_CONFIG.groups.Auto).toMatch(/^url-test,/);
  });

  it("uses the sanitized Gist-derived Clash feature defaults", async () => {
    const result = await generateConfig(makeEnv(), DEFAULT_CONFIG, "clash", "https://subpilot.example.com/sync/token/");
    const parsed = YAML.parse(result.content) as {
      tun: { "skip-proxy": string[] };
      dns: {
        "fake-ip-range": string;
        "default-nameserver": string[];
        nameserver: string[];
        fallback: string[];
        "fallback-filter": { geoip: boolean; ipcidr: string[] };
        "fake-ip-filter": string[];
      };
      "rule-providers": Record<string, Record<string, unknown>>;
      rules: string[];
      proxies: Record<string, unknown>[];
    };

    expect(parsed.tun["skip-proxy"]).toEqual(["127.0.0.1/8", "192.168.0.0/16", "100.64.0.0/10", "172.16.0.0/12"]);
    expect(parsed).not.toHaveProperty("profile");
    expect(parsed.dns["fake-ip-range"]).toBe("198.18.0.1/16");
    expect(parsed.dns["default-nameserver"]).toEqual(["223.5.5.5", "1.1.1.1"]);
    expect(parsed.dns.nameserver).toContain("quic://223.5.5.5/dns-query");
    expect(parsed.dns.fallback).toContain("https://1.1.1.1/dns-query");
    expect(parsed.dns["fallback-filter"]).toEqual({ geoip: true, ipcidr: ["240.0.0.0/4"] });
    expect(parsed.dns["fake-ip-filter"]).toContain("dns.msftncsi.com");
    expect(parsed["rule-providers"].Advertising).toMatchObject({
      type: "http",
      behavior: "classical",
      path: "./rules/Advertising.yaml",
      interval: 86400
    });
    expect(parsed.rules).toEqual([
      "PROCESS-NAME,Telegram,Proxy",
      "RULE-SET,Advertising,REJECT",
      "RULE-SET,Advertising_Domain,REJECT",
      "RULE-SET,DingTalk,DIRECT",
      "RULE-SET,Google,Proxy",
      "RULE-SET,OpenAI,Proxy",
      "RULE-SET,Gemini,Proxy",
      "RULE-SET,Bing,Proxy",
      "RULE-SET,Twitter,Proxy",
      "RULE-SET,Scholar,Proxy",
      "RULE-SET,YouTube,Proxy",
      "RULE-SET,Telegram,Proxy",
      "RULE-SET,GitHub,Proxy",
      "RULE-SET,Steam,Proxy",
      "RULE-SET,Npmjs,Proxy",
      "RULE-SET,Disney,Proxy",
      "GEOIP,PRIVATE,DIRECT",
      "GEOIP,CN,DIRECT",
      "MATCH,Proxy"
    ]);
    expect(parsed.proxies).toEqual([]);
    expect(result.content).not.toContain("65dd0c38");
    expect(result.content).not.toContain("207.97.145.15");
    expect(result.content).not.toContain("sxVQPhwY");
  });

  it("omits the Clash tun block when TUN mode is disabled", async () => {
    const result = await generateConfig(makeEnv(), {
      ...DEFAULT_CONFIG,
      clash: {
        ...DEFAULT_CONFIG.clash,
        tun: {
          ...DEFAULT_CONFIG.clash.tun,
          enable: false
        }
      }
    }, "clash", "https://subpilot.example.com/sync/token/");
    const parsed = YAML.parse(result.content) as { tun?: unknown };

    expect(parsed).not.toHaveProperty("tun");
  });

  it("omits Clash fake-ip DNS fields when enhanced-mode is not fake-ip", async () => {
    const result = await generateConfig(makeEnv(), {
      ...DEFAULT_CONFIG,
      clash: {
        ...DEFAULT_CONFIG.clash,
        dnsEnhancedMode: "redir-host"
      }
    }, "clash", "https://subpilot.example.com/sync/token/");
    const parsed = YAML.parse(result.content) as { dns: Record<string, unknown> };

    expect(parsed.dns["enhanced-mode"]).toBe("redir-host");
    expect(parsed.dns).not.toHaveProperty("fake-ip-range");
    expect(parsed.dns).not.toHaveProperty("fake-ip-filter");
  });

  it("maps Surge WebSocket headers to Clash output", async () => {
    const fetchMock = mockSubscription("CF 1 = trojan,1.2.3.4,443,password=p,sni=edge.example.com,ws=true,ws-path=/photos/documents/member?ed=2560,ws-headers=Host:\"edge.example.com\",skip-cert-verify=true");
    const env = makeEnv();
    const config = normalizeConfig({
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        geoipRenameEnabled: false
      },
      sources: [{
        id: "source-1",
        name: "CF",
        url: "https://upstream.example.com/sub",
        fetchUserAgent: "surge",
        enabled: true
      }]
    });

    const clash = await generateConfig(env, config, "clash", "https://subpilot.example.com/sync/token/");
    const parsedClash = YAML.parse(clash.content) as { proxies: Record<string, unknown>[] };

    expect(parsedClash.proxies[0]).toMatchObject({
      name: "[CF] CF 1",
      type: "trojan",
      network: "ws",
      "ws-opts": {
        path: "/photos/documents/member?ed=2560",
        headers: {
          Host: "edge.example.com"
        }
      },
      "skip-cert-verify": true
    });
  });

  it("normalizes, infers, and validates managed base URLs", () => {
    const config = normalizeConfig({
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        managedBaseUrl: ""
      }
    });
    expect(config.settings.managedBaseUrl).toBe("");

    const inferred = withInferredManagedBaseUrl(config, "https://subpilot.example.com/api/config");
    const stored = withInferredManagedBaseUrl({
      ...config,
      settings: {
        ...config.settings,
        managedBaseUrl: "https://saved.example.com/sync"
      }
    }, "https://subpilot.example.com/api/config");

    expect(inferManagedBaseUrl("https://subpilot.example.com/api/config")).toBe("https://subpilot.example.com/sync");
    expect(inferred.settings.managedBaseUrl).toBe("https://subpilot.example.com/sync");
    expect(stored.settings.managedBaseUrl).toBe("https://saved.example.com/sync");
    expect(validateManagedBaseUrl({
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        managedBaseUrl: ""
      }
    })).toBe("Managed base URL is required");
    expect(validateManagedBaseUrl({
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        managedBaseUrl: "https://subpilot.example.com/sync"
      }
    })).toBeNull();
    expect(validateManagedBaseUrl({
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        managedBaseUrl: "https://subpilot.example.com"
      }
    })).toBe("Managed base URL path must not be root");
    expect(validateManagedBaseUrl({
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        managedBaseUrl: "https://subpilot.example.com/"
      }
    })).toBe("Managed base URL path must not be root");
    expect(validateManagedBaseUrl({
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        managedBaseUrl: "https://subpilot.example.com/api"
      }
    })).toBe("Managed base URL path /api is reserved");
    expect(validateManagedBaseUrl({
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        managedBaseUrl: "https://subpilot.example.com/app.js/"
      }
    })).toBe("Managed base URL path /app.js is reserved");
    expect(validateManagedBaseUrl({
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        managedBaseUrl: "https://subpilot.example.com/sywwqnc/"
      }
    })).toBeNull();
  });

  it("generates Surge managed config URLs without legacy resource paths", async () => {
    mockSubscription("JP 1 = trojan, jp.example.com, 443, password=p");
    const defaultInterval = await generateConfig(makeEnv(), {
      ...DEFAULT_CONFIG,
      sources: [{
        id: "src1",
        name: "Primary",
        url: "https://example.com/sub",
        fetchUserAgent: "surge",
        enabled: true
      }]
    }, "surge", "https://subpilot.example.com/sync/read-token/");

    expect(defaultInterval.content).toContain("#!MANAGED-CONFIG https://subpilot.example.com/sync/read-token/ interval=43200 strict=true");
    expect(defaultInterval.content).toContain("[Proxy]\n[Primary] JP 01 = trojan, jp.example.com, 443");
    expect(defaultInterval.content).not.toContain("policy-path=");
    expect(defaultInterval.content).not.toContain("surge-resources");
    expect(defaultInterval.content).toContain("[Rule]\nRULE-SET");

    mockSubscription("JP 1 = trojan, jp.example.com, 443, password=p");
    const customInterval = await generateConfig(makeEnv(), {
      ...DEFAULT_CONFIG,
      sources: [{
        id: "src1",
        name: "Primary",
        url: "https://example.com/sub",
        fetchUserAgent: "surge",
        enabled: true
      }],
      surge: {
        ...DEFAULT_CONFIG.surge,
        managedConfigIntervalSeconds: 21600
      }
    }, "surge", "https://subpilot.example.com/sync/read-token/");
    expect(customInterval.content).toContain("#!MANAGED-CONFIG https://subpilot.example.com/sync/read-token/ interval=21600 strict=true");
    expect(customInterval.content).not.toContain("policy-path=");

    const joined = await generateConfig(makeEnv(), {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        managedBaseUrl: "https://subpilot.example.com/sync/"
      }
    }, "surge", "https://subpilot.example.com/sync/read-token/");
    expect(joined.content).toContain("#!MANAGED-CONFIG https://subpilot.example.com/sync/read-token/");
    expect(joined.content).not.toContain("/sync//read-token");

    const multiSegment = await generateConfig(makeEnv(), {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        managedBaseUrl: "https://subpilot.example.com/managed/sync"
      }
    }, "surge", "https://subpilot.example.com/managed/sync/read-token/");
    expect(multiSegment.content).toContain("#!MANAGED-CONFIG https://subpilot.example.com/managed/sync/read-token/");
    expect(multiSegment.content).not.toContain("/managed/sync/sync/surge");

    mockSubscription("JP 1 = trojan, jp.example.com, 443, password=p");
    const stash = await generateConfig(makeEnv(), {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        managedBaseUrl: "https://subpilot.example.com/stash-sync"
      },
      sources: [{
        id: "src1",
        name: "Primary",
        url: "https://example.com/sub",
        fetchUserAgent: "surge",
        enabled: true
      }]
    }, "stash", "https://subpilot.example.com/stash-sync/read-token/");
    expect(stash.content).toContain("#SUBSCRIBED https://subpilot.example.com/stash-sync/read-token/");
    expect(stash.content).not.toContain("/stash-sync//read-token");
  });
});
