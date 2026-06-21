import YAML from "yaml";
import { describe, expect, it, vi } from "vitest";
import { generateConfig } from "../src/generator";
import { DEFAULT_CONFIG } from "../src/default-config";
import { CHAIN_EXIT_PROTOCOLS, CHAIN_EXIT_PROXY_NAME, STATIC_EXIT_GROUP_NAME, type ChainExitProtocol } from "../src/types";
import { makeEnv } from "./helpers/env";
import { mockSubscription, restoreMocksAfterEach } from "./helpers/fetch";

restoreMocksAfterEach();

function configWithExitProtocol(protocol: ChainExitProtocol) {
  return {
    ...DEFAULT_CONFIG,
    chain: {
      exitProxy: {
        protocol,
        server: "1.2.3.4",
        port: 443,
        username: protocol === "ss" ? "chacha20-ietf-poly1305" : "user-id",
        password: "secret"
      },
      filter: DEFAULT_CONFIG.chain.filter
    }
  };
}

describe("generation", () => {
  it("fetches every enabled source with its configured user-agent", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => (
      new Response("JP 1 = trojan, jp.example.com, 443, password=p")
    ));
    const env = makeEnv();
    const config = {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        userAgentSurge: "Surge/Test",
        userAgentClash: "Clash/Test",
        geoipRenameEnabled: false
      },
      sources: [
        {
          id: "src1",
          name: "Surge UA Source",
          url: "https://example.com/surge-sub",
          fetchUserAgent: "surge" as const,
          enabled: true
        },
        {
          id: "src2",
          name: "Clash UA Source",
          url: "https://example.com/clash-sub",
          fetchUserAgent: "clash" as const,
          enabled: true
        }
      ]
    };

    await generateConfig(env, config, "surge", "https://subpilot.example.com/sync/token/");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const headersByUrl = new Map(fetchMock.mock.calls.map(([url, init]) => [url, (init as RequestInit).headers]));
    expect(headersByUrl.get("https://example.com/surge-sub")).toEqual({ "user-agent": "Surge/Test" });
    expect(headersByUrl.get("https://example.com/clash-sub")).toEqual({ "user-agent": "Clash/Test" });
  });

  it("skips source subscriptions that exceed the bounded read limit", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("too large", {
      headers: { "content-length": String(11 * 1024 * 1024) }
    }));
    const env = makeEnv();
    const config = {
      ...DEFAULT_CONFIG,
      sources: [{
        id: "src1",
        name: "Big Source",
        url: "https://example.com/big-sub",
        fetchUserAgent: "surge" as const,
        enabled: true
      }]
    };

    const result = await generateConfig(env, config, "surge", "https://subpilot.example.com/sync/token/");

    expect(result.proxyCount).toBe(0);
    expect(result.warnings).toContain("Big Source: Source subscription exceeds 10 MiB limit");
  });

  it("filters candidate nodes by the final output target", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => (
      new Response([
        "proxies:",
        "  - name: VM 1",
        "    type: vmess",
        "    server: vm.example.com",
        "    port: 443",
        "    uuid: 00000000-0000-0000-0000-000000000001",
        "  - name: VL 1",
        "    type: vless",
        "    server: vl.example.com",
        "    port: 443",
        "    uuid: 00000000-0000-0000-0000-000000000002",
        "  - name: TR 1",
        "    type: trojan",
        "    server: tr.example.com",
        "    port: 443",
        "    password: p"
      ].join("\n"))
    ));
    const env = makeEnv();
    const config = {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        geoipRenameEnabled: false
      },
      groups: {
        Proxy: "select, {all}"
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

    expect(surge.content).toContain("[Primary] VM 1 = vmess");
    expect(surge.content).toContain("username=00000000-0000-0000-0000-000000000001");
    expect(surge.content).not.toContain("VL 1 = vless");
    expect(surge.content).toContain("[Primary] TR 1 = trojan");
    const clashProxies = (YAML.parse(clash.content) as { proxies: Record<string, unknown>[] }).proxies;
    expect(clashProxies.some((proxy) => proxy.name === "[Primary] VM 1" && proxy.type === "vmess")).toBe(true);
    expect(clashProxies.some((proxy) => proxy.name === "[Primary] VL 1" && proxy.type === "vless")).toBe(true);
    expect(clashProxies.some((proxy) => proxy.name === "[Primary] TR 1" && proxy.type === "trojan")).toBe(true);
  });

  it("preserves clash node extension options and source name tags", async () => {
    const fetchMock = mockSubscription([
      "proxies:",
      "  - name: JP 1",
      "    type: vmess",
      "    server: jp.example.com",
      "    port: 443",
      "    uuid: 00000000-0000-0000-0000-000000000001",
      "    cipher: auto",
      "    network: ws",
      "    udp: true",
      "    client-fingerprint: chrome",
      "    ws-opts:",
      "      path: /ws",
      "      headers:",
      "        Host: edge.example.com",
      "    reality-opts:",
      "      public-key: pubkey",
      "      short-id: sid"
    ].join("\n"));
    const env = makeEnv();
    const config = {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        geoipRenameEnabled: false
      },
      sources: [{
        id: "src1",
        name: "NFcloud",
        url: "https://example.com/sub",
        fetchUserAgent: "clash" as const,
        enabled: true
      }]
    };

    const result = await generateConfig(env, config, "clash", "https://subpilot.example.com/sync/token/");

    const [proxy] = (YAML.parse(result.content) as { proxies: Record<string, unknown>[] }).proxies;
    expect(proxy).toMatchObject({
      name: "[NFcloud] JP 1",
      type: "vmess",
      server: "jp.example.com",
      port: 443,
      uuid: "00000000-0000-0000-0000-000000000001",
      cipher: "auto",
      network: "ws",
      udp: true,
      "client-fingerprint": "chrome",
      "ws-opts": {
        path: "/ws",
        headers: {
          Host: "edge.example.com"
        }
      },
      "reality-opts": {
        "public-key": "pubkey",
        "short-id": "sid"
      }
    });
  });

  it("keeps same protocol server and port nodes when their proxy parameters differ", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (url === "https://example.com/simple") {
        return new Response([
          "proxies:",
          "  - name: Simple",
          "    type: trojan",
          "    server: dup.example.com",
          "    port: 443",
          "    password: p"
        ].join("\n"));
      }
      return new Response([
        "proxies:",
        "  - name: Rich",
        "    type: trojan",
        "    server: dup.example.com",
        "    port: 443",
        "    password: p",
        "    network: ws",
        "    ws-opts:",
        "      path: /ws",
        "      headers:",
        "        Host: edge.example.com"
      ].join("\n"));
    });
    const env = makeEnv();
    const config = {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        geoipRenameEnabled: false
      },
      groups: {
        Proxy: "select, {all}"
      },
      sources: [
        {
          id: "simple",
          name: "SimpleSource",
          url: "https://example.com/simple",
          fetchUserAgent: "clash" as const,
          enabled: true
        },
        {
          id: "rich",
          name: "RichSource",
          url: "https://example.com/rich",
          fetchUserAgent: "clash" as const,
          enabled: true
        }
      ]
    };

    const result = await generateConfig(env, config, "clash", "https://subpilot.example.com/sync/token/");

    const parsed = YAML.parse(result.content) as { proxies: Record<string, unknown>[]; "proxy-groups": Array<{ proxies: string[] }> };
    expect(parsed.proxies).toHaveLength(2);
    expect(parsed.proxies[0]).toMatchObject({
      name: "[SimpleSource] Simple",
      type: "trojan",
      server: "dup.example.com",
      port: 443
    });
    expect(parsed.proxies[1]).toMatchObject({
      name: "[RichSource] Rich",
      type: "trojan",
      server: "dup.example.com",
      port: 443,
      network: "ws",
      "ws-opts": {
        path: "/ws",
        headers: {
          Host: "edge.example.com"
        }
      }
    });
    expect(parsed["proxy-groups"][0]?.proxies).toEqual(["[SimpleSource] Simple", "[RichSource] Rich"]);
  });

  it("renames nodes by region extracted from original node names", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const textUrl = String(url);
      if (textUrl === "https://example.com/sub") {
        return new Response([
          "JP 1 = trojan, shared.example.com, 10001, password=p",
          "0 GB | 150 GB = trojan, shared.example.com, 10002, password=p",
          "🇨🇳 Taiwan 0 GB | 150 GB = trojan, 8.8.8.8, 443, password=p"
        ].join("\n"));
      }
      return new Response("{}", { status: 404 });
    });
    const kv = new Map<string, string>([
      ["geoip:ip:8.8.8.8", JSON.stringify({ country: { iso_code: "CN" } })]
    ]);
    const env = makeEnv(kv);
    const config = {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        geoipRenameEnabled: true
      },
      groups: {
        Proxy: "select, {all}"
      },
      sources: [{
        id: "src1",
        name: "机场 A",
        url: "https://example.com/sub",
        fetchUserAgent: "surge" as const,
        enabled: true
      }]
    };

    const result = await generateConfig(env, config, "surge", "https://subpilot.example.com/sync/token/");

    expect(result.content).toContain("[机场 A] JP 01 = trojan, shared.example.com, 10001");
    expect(result.content).toContain("[机场 A] ZZ 01 = trojan, shared.example.com, 10002");
    expect(result.content).not.toContain("[机场 A] GB 01 = trojan, shared.example.com, 10002");
    expect(result.content).toContain("[机场 A] TW 01 = trojan, 8.8.8.8, 443");
    expect(result.content).not.toContain("[机场 A] CN 01 = trojan, 8.8.8.8, 443");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("numbers renamed nodes separately for each source name", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (url === "https://example.com/source-a") {
        return new Response([
          "Taiwan A1 = trojan, a1.example.com, 443, password=p",
          "Taiwan A2 = trojan, a2.example.com, 443, password=p"
        ].join("\n"));
      }
      if (url === "https://example.com/source-b") {
        return new Response([
          "Taiwan B1 = trojan, b1.example.com, 443, password=p",
          "Taiwan B2 = trojan, b2.example.com, 443, password=p"
        ].join("\n"));
      }
      return new Response("{}", { status: 404 });
    });
    const env = makeEnv();
    const config = {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        geoipRenameEnabled: true
      },
      groups: {
        Proxy: "select, {all}"
      },
      sources: [
        {
          id: "src1",
          name: "机场 A",
          url: "https://example.com/source-a",
          fetchUserAgent: "surge" as const,
          enabled: true
        },
        {
          id: "src2",
          name: "机场 B",
          url: "https://example.com/source-b",
          fetchUserAgent: "surge" as const,
          enabled: true
        }
      ]
    };

    const result = await generateConfig(env, config, "surge", "https://subpilot.example.com/sync/token/");

    expect(result.content).toContain("[机场 A] TW 01 = trojan, a1.example.com, 443");
    expect(result.content).toContain("[机场 A] TW 02 = trojan, a2.example.com, 443");
    expect(result.content).toContain("[机场 B] TW 01 = trojan, b1.example.com, 443");
    expect(result.content).toContain("[机场 B] TW 02 = trojan, b2.example.com, 443");
    expect(result.content).not.toContain("[机场 B] TW 03");
    expect(result.content).not.toContain("[机场 B] TW 04");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("filters policy group nodes by renamed final names and internal region labels", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const textUrl = String(url);
      if (textUrl === "https://example.com/sub") {
        return new Response([
          "Tokyo Alpha = trojan, shared.example.com, 10001, password=p",
          "Singapore Beta = trojan, shared.example.com, 10002, password=p"
        ].join("\n"));
      }
      return new Response("{}", { status: 404 });
    });
    const env = makeEnv();
    const config = {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        geoipRenameEnabled: true
      },
      groups: {
        Proxy: "select, {all filter=JP}",
        NoSingapore: "select, {all exclude=SG}"
      },
      sources: [{
        id: "src1",
        name: "",
        url: "https://example.com/sub",
        fetchUserAgent: "surge" as const,
        enabled: true
      }]
    };

    const result = await generateConfig(env, config, "surge", "https://subpilot.example.com/sync/token/");
    const main = await generateConfig(env, config, "surge", "https://subpilot.example.com/sync/token/");

    expect(result.content).toContain("JP 01 = trojan, shared.example.com, 10001");
    expect(result.content).toContain("SG 01 = trojan, shared.example.com, 10002");
    expect(main.content).toContain("Proxy = select, JP 01");
    expect(main.content).toContain("NoSingapore = select, JP 01");
    expect(main.content).not.toContain("policy-path=");
    expect(main.content).not.toContain("policy-regex-filter=");
  });

  it("builds chain nodes from the renamed candidate pool using the shared chain filter", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const textUrl = String(url);
      if (textUrl === "https://example.com/sub") {
        return new Response([
          "Tokyo Alpha = trojan, shared.example.com, 10001, password=p",
          "Singapore Beta = trojan, shared.example.com, 10002, password=p"
        ].join("\n"));
      }
      return new Response("{}", { status: 404 });
    });
    const env = makeEnv();
    const config = {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        geoipRenameEnabled: true
      },
      groups: {
        Proxy: "select, {all exclude=Chain}",
        [STATIC_EXIT_GROUP_NAME]: "select, {all filter=Chain}"
      },
      sources: [{
        id: "src1",
        name: "",
        url: "https://example.com/sub",
        fetchUserAgent: "surge" as const,
        enabled: true
      }],
      chain: {
        exitProxy: {
          protocol: "socks5" as const,
          server: "1.1.1.1",
          port: 1080,
          username: "",
          password: ""
        },
        filter: ["JP"]
      },
      surge: {
        ...DEFAULT_CONFIG.surge
      }
    };

    const result = await generateConfig(env, config, "surge", "https://subpilot.example.com/sync/token/");
    const main = await generateConfig(env, config, "surge", "https://subpilot.example.com/sync/token/");

    expect(result.content).toContain("JP 01 = trojan, shared.example.com, 10001");
    expect(result.content).toContain("SG 01 = trojan, shared.example.com, 10002");
    expect(result.content).toContain("JP 01 Chain = socks5, 1.1.1.1, 1080");
    expect(result.content).toContain("underlying-proxy=JP 01");
    expect(main.content).toContain("[Proxy]\nJP 01 = trojan, shared.example.com, 10001");
    expect(main.content).toContain(`${CHAIN_EXIT_PROXY_NAME} = socks5, 1.1.1.1, 1080`);
    expect(main.content).toContain("JP 01 Chain = socks5, 1.1.1.1, 1080");
    expect(main.content).toContain("underlying-proxy=JP 01");
    expect(main.content).toContain(`${STATIC_EXIT_GROUP_NAME} = select, JP 01 Chain`);
    expect(main.content).not.toContain("policy-path=");
    expect(result.content).not.toContain("SG 01 Chain");
    expect(result.content).not.toContain("Alpha Chain");
  });

  it("maps city names in original node names to country region codes", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const textUrl = String(url);
      if (textUrl === "https://example.com/sub") {
        return new Response([
          "Sao Paulo 1 = trojan, shared.example.com, 10001, password=p",
          "Singapore 1 = trojan, shared.example.com, 10002, password=p",
          "Los Angeles 1 = trojan, shared.example.com, 10003, password=p",
          "Hong Kong 1 = trojan, shared.example.com, 10004, password=p"
        ].join("\n"));
      }
      return new Response("{}", { status: 404 });
    });
    const env = makeEnv();
    const config = {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        geoipRenameEnabled: true
      },
      groups: {
        Proxy: "select, {all}"
      },
      sources: [{
        id: "src1",
        name: "机场 A",
        url: "https://example.com/sub",
        fetchUserAgent: "surge" as const,
        enabled: true
      }]
    };

    const result = await generateConfig(env, config, "surge", "https://subpilot.example.com/sync/token/");
    const main = await generateConfig(env, config, "surge", "https://subpilot.example.com/sync/token/");

    expect(result.content).toContain("[机场 A] BR 01 = trojan, shared.example.com, 10001");
    expect(result.content).toContain("[机场 A] SG 01 = trojan, shared.example.com, 10002");
    expect(result.content).toContain("[机场 A] US 01 = trojan, shared.example.com, 10003");
    expect(result.content).toContain("[机场 A] HK 01 = trojan, shared.example.com, 10004");
    expect(main.content).toContain("Proxy = select, [机场 A] BR 01");
    expect(main.content).not.toContain("policy-path=");
    expect(main.content).not.toContain("policy-regex-filter=");
  });

  it("merges feature tags for exact duplicate configs while keeping different params separate", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const textUrl = String(url);
      if (textUrl === "https://example.com/sub") {
        return new Response([
          "Singapore Netflix Disney = trojan, dup.example.com, 443, password=p",
          "Singapore YouTube = trojan, dup.example.com, 443, password=p",
          "Singapore ChatGPT AI = trojan, dup.example.com, 443, password=p, ws=true"
        ].join("\n"));
      }
      return new Response("{}", { status: 404 });
    });
    const env = makeEnv();
    const config = {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        geoipRenameEnabled: true
      },
      groups: {
        Proxy: "select, {all}"
      },
      sources: [{
        id: "src1",
        name: "Primary",
        url: "https://example.com/sub",
        fetchUserAgent: "surge" as const,
        enabled: true
      }]
    };

    const result = await generateConfig(env, config, "surge", "https://subpilot.example.com/sync/token/");
    const main = await generateConfig(env, config, "surge", "https://subpilot.example.com/sync/token/");

    expect(result.content).toContain("[Primary] SG 01 Netflix Disney YouTube = trojan, dup.example.com, 443, password=p");
    expect(result.content).toContain("[Primary] SG 02 AI = trojan, dup.example.com, 443, password=p, ws=true");
    expect(main.content).toContain("Proxy = select, [Primary] SG 01 Netflix Disney YouTube, [Primary] SG 02 AI");
    expect(main.content).not.toContain("policy-path=");
    expect(main.content).not.toContain("policy-regex-filter=");
  });

  it("builds Disney policy groups from feature labels across output targets", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const textUrl = String(url);
      if (textUrl === "https://example.com/sub") {
        return new Response([
          "Singapore disney+ = trojan, disney.example.com, 443, password=p",
          "Singapore Normal = trojan, normal.example.com, 443, password=p"
        ].join("\n"));
      }
      return new Response("{}", { status: 404 });
    });
    const env = makeEnv();
    const config = {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        geoipRenameEnabled: true
      },
      groups: {
        Proxy: "select, {all}",
        Disney: "select, {all filter=disney}"
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
    const clashGroups = (YAML.parse(clash.content) as { "proxy-groups": Array<{ name: string; proxies: string[] }> })["proxy-groups"];

    expect(surge.content).toContain("Disney = select, [Primary] SG 01 Disney");
    expect(surge.content).not.toContain("policy-path=");
    expect(surge.content).not.toContain("policy-regex-filter=");
    expect(clashGroups.find((group) => group.name === "Disney")?.proxies).toEqual(["[Primary] SG 01 Disney"]);
  });

  it("rewrites empty Surge policy group rule targets to Proxy", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const textUrl = String(url);
      if (textUrl === "https://example.com/sub") {
        return new Response("Singapore Normal = trojan, normal.example.com, 443, password=p");
      }
      return new Response("{}", { status: 404 });
    });
    const env = makeEnv();
    const config = {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        geoipRenameEnabled: true
      },
      groups: {
        Proxy: "select, {all}",
        Disney: "select, {all filter=Disney}"
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
        rules: ["RULE-SET,https://example.com/disney.list,Disney", "FINAL,Proxy"]
      },
      clash: {
        ...DEFAULT_CONFIG.clash,
        rules: ["RULE-SET,Disney,Disney", "MATCH,Proxy"]
      }
    };

    const surge = await generateConfig(env, config, "surge", "https://subpilot.example.com/sync/token/");
    const clash = await generateConfig(env, config, "clash", "https://subpilot.example.com/sync/token/");
    const clashParsed = YAML.parse(clash.content) as { "proxy-groups": Array<{ name: string }>; rules: string[] };

    expect(surge.content).not.toContain("Disney = select");
    expect(surge.content).not.toContain("policy-path=");
    expect(surge.content).toContain("RULE-SET,https://example.com/disney.list,Proxy");
    expect(clashParsed["proxy-groups"].some((group) => group.name === "Disney")).toBe(false);
    expect(clashParsed.rules).toContain("RULE-SET,Disney,Proxy");
  });

  it("adds Proxy fallback rules for Clash rule providers missing from rules", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("JP 1 = trojan, jp.example.com, 443, password=p"));
    const env = makeEnv();
    const config = {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        geoipRenameEnabled: false
      },
      sources: [{
        id: "src1",
        name: "Primary",
        url: "https://example.com/sub",
        fetchUserAgent: "surge" as const,
        enabled: true
      }],
      clash: {
        ...DEFAULT_CONFIG.clash,
        ruleProviders: [
          "rule-providers:",
          "  YouTube:",
          "    type: http",
          "    behavior: classical",
          "    url: https://example.com/youtube.yaml",
          "    interval: 86400"
        ].join("\n"),
        rules: ["DOMAIN-SUFFIX,example.com,DIRECT", "MATCH,Proxy"]
      }
    };

    const clash = await generateConfig(env, config, "clash", "https://subpilot.example.com/sync/token/");
    const parsed = YAML.parse(clash.content) as { rules: string[]; "rule-providers": Record<string, Record<string, unknown>> };

    expect(parsed["rule-providers"].YouTube).toMatchObject({ path: "./rules/YouTube.yaml" });
    expect(parsed.rules).toEqual([
      "DOMAIN-SUFFIX,example.com,DIRECT",
      "RULE-SET,YouTube,Proxy",
      "MATCH,Proxy"
    ]);
  });

  it("uses custom feature tag rules when renaming nodes", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const textUrl = String(url);
      if (textUrl === "https://example.com/sub") {
        return new Response("Singapore Netflix Copilot = trojan, custom.example.com, 443, password=p");
      }
      return new Response("{}", { status: 404 });
    });
    const env = makeEnv();
    const config = {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        geoipRenameEnabled: true,
        featureTagRules: ["Copilot=copilot,github-ai"]
      },
      groups: {
        Proxy: "select, {all}"
      },
      sources: [{
        id: "src1",
        name: "Primary",
        url: "https://example.com/sub",
        fetchUserAgent: "surge" as const,
        enabled: true
      }]
    };

    const result = await generateConfig(env, config, "surge", "https://subpilot.example.com/sync/token/");

    expect(result.content).toContain("[Primary] SG 01 Copilot = trojan, custom.example.com, 443, password=p");
    expect(result.content).not.toContain("[Primary] SG 01 Netflix");
  });

  it("renames IP address nodes from local GeoIP, original names, or the unknown fallback", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const textUrl = String(url);
      if (textUrl === "https://example.com/sub") {
        return new Response([
          "Edge 1 = trojan, 8.8.8.8, 443, password=p",
          "Singapore Backup = trojan, 10.0.0.1, 443, password=p",
          "Node 1 = trojan, 10.0.0.2, 443, password=p"
        ].join("\n"));
      }
      return new Response("{}", { status: 404 });
    });
    const kv = new Map<string, string>([
      ["geoip:ip:8.8.8.8", JSON.stringify({ city: { names: { en: "Singapore" } }, country: { iso_code: "SG" } })]
    ]);
    const env = makeEnv(kv);
    const config = {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        geoipRenameEnabled: true
      },
      groups: {
        Proxy: "select, {all}"
      },
      sources: [{
        id: "src1",
        name: "机场 A",
        url: "https://example.com/sub",
        fetchUserAgent: "surge" as const,
        enabled: true
      }]
    };

    const result = await generateConfig(env, config, "surge", "https://subpilot.example.com/sync/token/");

    expect(result.content).toContain("[机场 A] SG 01 = trojan, 8.8.8.8, 443");
    expect(result.content).toContain("[机场 A] SG 02 = trojan, 10.0.0.1, 443");
    expect(result.content).toContain("[机场 A] ZZ 01 = trojan, 10.0.0.2, 443");
    expect(result.warnings.some((warning) => warning.includes("10.0.0.1"))).toBe(false);
    expect(result.warnings.some((warning) => warning.includes("10.0.0.2"))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps source Host private DNS rules without using them for domain region renaming", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const textUrl = String(url);
      if (textUrl === "https://example.com/sub") {
        return new Response([
          "[Host]",
          "*.bilivideo.cv = server:191.101.132.202:1066",
          "*.bilivideo.cv = server:194.156.162.182:1066",
          "",
          "[Proxy]",
          "SG Bili 1 = trojan, edge.bilivideo.cv, 443, password=p"
        ].join("\n"));
      }
      return new Response("{}", { status: 404 });
    });
    const env = makeEnv();
    const config = {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        geoipRenameEnabled: true
      },
      groups: {
        Proxy: "select, {all}"
      },
      sources: [{
        id: "src1",
        name: "NFcloud",
        url: "https://example.com/sub",
        fetchUserAgent: "surge" as const,
        enabled: true
      }]
    };

    const result = await generateConfig(env, config, "surge", "https://subpilot.example.com/sync/token/");
    const main = await generateConfig(env, config, "surge", "https://subpilot.example.com/sync/token/");

    expect(main.content).toContain("[Host]\n*.bilivideo.cv = server:191.101.132.202:1066\n*.bilivideo.cv = server:194.156.162.182:1066");
    expect(result.content).toContain("[NFcloud] SG 01 = trojan, edge.bilivideo.cv, 443");
    expect(main.content).toContain("Proxy = select, [NFcloud] SG 01");
    expect(main.content).not.toContain("policy-path=");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("cloudflare-dns.com"))).toBe(false);
  });

  it("keeps comma-separated filters inside group placeholders", async () => {
    const fetchMock = mockSubscription("JP 1 = trojan, jp.example.com, 443, password=p");
    const kv = new Map<string, string>();
    const env = {
      SUBPILOT_CONFIG: {
        get: async (key: string) => kv.get(key) ?? null,
        put: async (key: string, value: string) => { kv.set(key, value); },
        delete: async (key: string) => { kv.delete(key); },
        list: async () => ({ keys: [], list_complete: true, cursor: undefined }),
        getWithMetadata: async () => ({ value: null, metadata: null })
      },
      ASSETS: { fetch: async () => new Response() }
    } as unknown as Env;
    const result = await generateConfig(env, {
      version: 1,
      settings: {
        ...DEFAULT_CONFIG.settings,
        managedBaseUrl: "https://subpilot.example.com/sync",
        userAgentSurge: "Surge/5",
        userAgentClash: "Clash/1",
        excludeKeywords: [],
        geoipRenameEnabled: false,
        featureTagRules: DEFAULT_CONFIG.settings.featureTagRules
      },
      groups: {
        Proxy: "select, Auto, {all exclude=Chain}"
      },
      disabledGroups: [],
      sources: [{
        id: "src1",
        name: "Primary",
        url: "https://example.com/sub",
        fetchUserAgent: "surge" as const,
        enabled: true
      }],
      chain: {
        exitProxy: {
          protocol: "socks5" as const,
          server: "1.1.1.1",
          port: 1080,
          username: "",
          password: ""
        },
        filter: DEFAULT_CONFIG.chain.filter
      },
      surge: {
        ...DEFAULT_CONFIG.surge,
        rules: ["FINAL,Auto"]
      },
      clash: {
        ...DEFAULT_CONFIG.clash,
        rules: ["MATCH,Auto"]
      }
    }, "surge", "https://subpilot.example.com/sync/token/");
    expect(result.content).toContain("Proxy = select, Auto, [Primary] JP 1");
    expect(result.content).not.toContain("policy-path=");
    expect(result.content).not.toContain("policy-regex-filter=");
    expect(result.content).not.toContain(`${CHAIN_EXIT_PROXY_NAME}}`);
  });

  it("omits ipv6-vif when Surge IPv6 is disabled", async () => {
    const env = makeEnv();
    const result = await generateConfig(env, {
      ...DEFAULT_CONFIG,
      sources: [],
      surge: {
        ...DEFAULT_CONFIG.surge,
        ipv6: false,
        ipv6Vif: "always"
      }
    }, "surge", "https://subpilot.example.com/sync/token");

    expect(result.content).toContain("ipv6 = false");
    expect(result.content).not.toContain("ipv6-vif =");
  });

  it("outputs configured Surge scripts before rules", async () => {
    const env = makeEnv();
    const result = await generateConfig(env, {
      ...DEFAULT_CONFIG,
      sources: [],
      surge: {
        ...DEFAULT_CONFIG.surge,
        scripts: [
          "京东_开屏去广告 = type=http-response,requires-body=1,max-size=0,pattern=^https?:\\/\\/api\\.m\\.jd\\.com\\/client\\.action\\?functionId=start,script-path=https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/script/startup/startup.js"
        ],
        rules: ["FINAL,Proxy"]
      }
    }, "surge", "https://subpilot.example.com/sync/token");

    expect(result.content).toContain("[Script]\n京东_开屏去广告 = type=http-response");
    expect(result.content.indexOf("[Script]")).toBeGreaterThan(result.content.indexOf("[Proxy Group]"));
    expect(result.content.indexOf("[Script]")).toBeLessThan(result.content.indexOf("[Rule]"));
  });

  it("outputs configured Surge MITM options before rules", async () => {
    const env = makeEnv();
    const result = await generateConfig(env, {
      ...DEFAULT_CONFIG,
      sources: [],
      surge: {
        ...DEFAULT_CONFIG.surge,
        mitm: {
          skipServerCertVerify: true,
          h2: true,
          hostname: ["wmapi.meituan.com", "api.m.jd.com"],
          caPassphrase: "test-passphrase",
          caP12: "BASE64P12"
        },
        rules: ["FINAL,Proxy"]
      }
    }, "surge", "https://subpilot.example.com/sync/token");

    expect(result.content).toContain("[MITM]\nskip-server-cert-verify = true\nh2 = true\nhostname = wmapi.meituan.com, api.m.jd.com\nca-passphrase = test-passphrase\nca-p12 = BASE64P12");
    expect(result.content.indexOf("[MITM]")).toBeLessThan(result.content.indexOf("[Rule]"));
  });

  it("outputs configured Surge hosts after General and keeps source hosts in the external resource", async () => {
    const fetchMock = mockSubscription([
      "[Host]",
      "source.example.test = 1.2.3.4",
      "custom.example.test = server:system",
      "",
      "[Proxy]",
      "JP 1 = trojan, jp.example.com, 443, password=p"
    ].join("\n"));
    const env = makeEnv();
    const config = {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        geoipRenameEnabled: false
      },
      groups: {
        Proxy: "select, {all}"
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
        hosts: [
          "custom.example.test = server:system",
          "alias.example.test = target.example.test"
        ],
        rules: ["FINAL,Proxy"]
      }
    };
    const result = await generateConfig(env, config, "surge", "https://subpilot.example.com/sync/token");

    expect(result.content).toContain("[Host]\ncustom.example.test = server:system\nalias.example.test = target.example.test");
    expect(result.content).not.toContain("#!include https://subpilot.example.com/sync/token/surge-resources/");
    expect(result.content).not.toContain("policy-path=");
    expect(result.content.match(/custom\.example\.test = server:system/g)).toHaveLength(1);
    expect(result.content).toContain("source.example.test = 1.2.3.4");
    expect(result.content.indexOf("[Host]")).toBeGreaterThan(result.content.indexOf("[General]"));
    expect(result.content.indexOf("[Host]")).toBeLessThan(result.content.indexOf("[Proxy Group]"));
  });

  it("outputs configured Surge URL Rewrite before scripts and rules", async () => {
    const env = makeEnv();
    const result = await generateConfig(env, {
      ...DEFAULT_CONFIG,
      sources: [],
      surge: {
        ...DEFAULT_CONFIG.surge,
        urlRewrite: [
          "^https?:\\/\\/example\\.com\\/ad - reject",
          "^https?:\\/\\/old\\.example\\.com https://new.example.com 302"
        ],
        scripts: [
          "Test Script = type=http-response,pattern=^https://example.com,script-path=https://example.com/script.js"
        ],
        rules: ["FINAL,Proxy"]
      }
    }, "surge", "https://subpilot.example.com/sync/token");

    expect(result.content).toContain("[URL Rewrite]\n^https?:\\/\\/example\\.com\\/ad - reject\n^https?:\\/\\/old\\.example\\.com https://new.example.com 302");
    expect(result.content.indexOf("[URL Rewrite]")).toBeGreaterThan(result.content.indexOf("[Proxy Group]"));
    expect(result.content.indexOf("[URL Rewrite]")).toBeLessThan(result.content.indexOf("[Script]"));
    expect(result.content.indexOf("[URL Rewrite]")).toBeLessThan(result.content.indexOf("[Rule]"));
  });

  it("keeps host lines from source subscriptions in surge and clash outputs", async () => {
    const fetchMock = mockSubscription([
      "[Host]",
      "source.example.test = 1.2.3.4",
      "",
      "[Proxy]",
      "JP 1 = trojan, jp.example.com, 443, password=p"
    ].join("\n"));
    const env = makeEnv();
    const config = {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        geoipRenameEnabled: false
      },
      groups: {
        Proxy: "select, {all}"
      },
      sources: [{
        id: "src1",
        name: "Primary",
        url: "https://example.com/sub",
        fetchUserAgent: "surge" as const,
        enabled: true
      }],
      surge: DEFAULT_CONFIG.surge
    };

    const surge = await generateConfig(env, config, "surge", "https://subpilot.example.com/sync/token/");
    const clash = await generateConfig(env, config, "clash", "https://subpilot.example.com/sync/token/");

    expect(surge.content).toContain("[Host]\nsource.example.test = 1.2.3.4");
    const clashHosts = (YAML.parse(clash.content) as { hosts: Record<string, string> }).hosts;
    expect(clashHosts).toMatchObject({ "source.example.test": "1.2.3.4" });
  });

  it("keeps clash hosts from source subscriptions in surge and clash outputs", async () => {
    const fetchMock = mockSubscription([
      "hosts:",
      "  clash.example.test:",
      "    - 1.1.1.1",
      "    - 1.0.0.1",
      "  edge.example.test: 2.2.2.2",
      "proxies:",
      "  - name: JP 1",
      "    type: trojan",
      "    server: jp.example.com",
      "    port: 443",
      "    password: p"
    ].join("\n"));
    const env = makeEnv();
    const config = {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        geoipRenameEnabled: false
      },
      groups: {
        Proxy: "select, {all}"
      },
      sources: [{
        id: "src1",
        name: "Primary",
        url: "https://example.com/sub",
        fetchUserAgent: "clash" as const,
        enabled: true
      }]
    };

    const surge = await generateConfig(env, config, "surge", "https://subpilot.example.com/sync/token/");
    const clash = await generateConfig(env, config, "clash", "https://subpilot.example.com/sync/token/");

    expect(surge.content).toContain("[Host]\nclash.example.test = 1.1.1.1, 1.0.0.1\nedge.example.test = 2.2.2.2");
    const clashHosts = (YAML.parse(clash.content) as { hosts: Record<string, string | string[]> }).hosts;
    expect(clashHosts).toEqual({
      "clash.example.test": ["1.1.1.1", "1.0.0.1"],
      "edge.example.test": "2.2.2.2"
    });
  });

  it("generates chain proxy nodes whenever the shared exit proxy is configured", async () => {
    const fetchMock = mockSubscription("JP 1 = trojan, jp.example.com, 443, password=p");
    const env = makeEnv();
    const config = {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        geoipRenameEnabled: false
      },
      groups: {
        Proxy: `select, ${CHAIN_EXIT_PROXY_NAME}, {all}`,
        [STATIC_EXIT_GROUP_NAME]: `select, ${CHAIN_EXIT_PROXY_NAME}, {all filter=Chain}`
      },
      sources: [{
        id: "src1",
        name: "Primary",
        url: "https://example.com/sub",
        fetchUserAgent: "surge" as const,
        enabled: true
      }],
      chain: {
        exitProxy: {
          protocol: "socks5" as const,
          server: "1.1.1.1",
          port: 1080,
          username: "u",
          password: "p"
        },
        filter: ["JP"]
      },
      surge: {
        ...DEFAULT_CONFIG.surge,
        rules: ["FINAL,Proxy"]
      },
      clash: {
        ...DEFAULT_CONFIG.clash,
        rules: ["MATCH,Proxy"]
      }
    };

    const surge = await generateConfig(env, config, "surge", "https://subpilot.example.com/sync/token/");
    const main = await generateConfig(env, config, "surge", "https://subpilot.example.com/sync/token/");
    const clash = await generateConfig(env, config, "clash", "https://subpilot.example.com/sync/token/");

    expect(surge.content).toContain("[Primary] JP 1 Chain = socks5, 1.1.1.1, 1080");
    expect(surge.content).toContain("username=u");
    expect(surge.content).toContain("password=p");
    expect(surge.content).toContain("underlying-proxy=[Primary] JP 1");
    expect(main.content).toContain("[Proxy]\n[Primary] JP 1 = trojan, jp.example.com, 443");
    expect(main.content).toContain(`${CHAIN_EXIT_PROXY_NAME} = socks5, 1.1.1.1, 1080`);
    expect(main.content).toContain("username=u");
    expect(main.content).toContain("password=p");
    expect(main.content).toContain("[Primary] JP 1 Chain = socks5, 1.1.1.1, 1080");
    expect(main.content).toContain("underlying-proxy=[Primary] JP 1");
    expect(main.content).toContain(`${STATIC_EXIT_GROUP_NAME} = select, [Primary] JP 1 Chain`);
    expect(main.content).not.toContain("policy-path=");
    expect(main.content).not.toContain(`${STATIC_EXIT_GROUP_NAME} = select, ${CHAIN_EXIT_PROXY_NAME}`);
    expect(main.content).not.toContain(`Proxy = select, ${CHAIN_EXIT_PROXY_NAME}`);

    const parsedClash = YAML.parse(clash.content) as {
      proxies: Array<{ name: string; server: string }>;
      "proxy-groups": Array<{ name: string; proxies: string[] }>;
    };
    expect(parsedClash.proxies).toContainEqual(expect.objectContaining({
      name: "[Primary] JP 1 Chain",
      server: "1.1.1.1"
    }));
    expect(parsedClash["proxy-groups"].find((group) => group.name === "Proxy")?.proxies).not.toContain(CHAIN_EXIT_PROXY_NAME);
    expect(parsedClash["proxy-groups"].find((group) => group.name === STATIC_EXIT_GROUP_NAME)?.proxies).toContain("[Primary] JP 1 Chain");
  });

  it("does not generate Surge chain nodes for base proxies unsupported by Surge", async () => {
    const fetchMock = mockSubscription([
      "TW 10 = vless, 207.97.145.15, 443, username=ed221103117, tls=true",
      "JP 1 = trojan, jp.example.com, 443, password=p"
    ].join("\n"));
    const env = makeEnv();
    const config = {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        geoipRenameEnabled: false
      },
      groups: {
        Proxy: "select, {all exclude=Chain}",
        [STATIC_EXIT_GROUP_NAME]: "select, {all filter=Chain}"
      },
      sources: [{
        id: "src1",
        name: "FP",
        url: "https://example.com/sub",
        fetchUserAgent: "surge" as const,
        enabled: true
      }],
      chain: {
        exitProxy: {
          protocol: "socks5" as const,
          server: "1.1.1.1",
          port: 1080,
          username: "u",
          password: "p"
        },
        filter: ["TW", "JP"]
      },
      surge: {
        ...DEFAULT_CONFIG.surge,
        rules: ["FINAL,Proxy"]
      }
    };

    const surge = await generateConfig(env, config, "surge", "https://subpilot.example.com/sync/token/");
    const main = await generateConfig(env, config, "surge", "https://subpilot.example.com/sync/token/");

    expect(surge.content).not.toContain("[FP] TW 10 = vless");
    expect(surge.content).not.toContain("[FP] TW 10 Chain");
    expect(surge.content).not.toContain("underlying-proxy=[FP] TW 10");
    expect(surge.content).toContain("[FP] JP 1 Chain = socks5, 1.1.1.1, 1080");
    expect(surge.content).toContain("underlying-proxy=[FP] JP 1");
    expect(main.content).toContain(`${STATIC_EXIT_GROUP_NAME} = select, [FP] JP 1 Chain`);
    expect(main.content).not.toContain("policy-path=");
  });

  it("numbers renamed nodes after filtering unsupported target protocols", async () => {
    const fetchMock = mockSubscription([
      "TW 10 = vless, 207.97.145.15, 443, username=ed221103117, tls=true",
      "TW 11 = trojan, tw.example.com, 443, password=p"
    ].join("\n"));
    const env = makeEnv();
    const config = {
      ...DEFAULT_CONFIG,
      settings: {
        ...DEFAULT_CONFIG.settings,
        geoipRenameEnabled: true
      },
      groups: {
        Proxy: "select, {all exclude=Chain}",
        [STATIC_EXIT_GROUP_NAME]: "select, {all filter=Chain}"
      },
      sources: [{
        id: "src1",
        name: "FP",
        url: "https://example.com/sub",
        fetchUserAgent: "surge" as const,
        enabled: true
      }],
      chain: {
        exitProxy: {
          protocol: "socks5" as const,
          server: "1.1.1.1",
          port: 1080,
          username: "u",
          password: "p"
        },
        filter: ["TW"]
      },
      surge: {
        ...DEFAULT_CONFIG.surge,
        rules: ["FINAL,Proxy"]
      }
    };

    const surge = await generateConfig(env, config, "surge", "https://subpilot.example.com/sync/token/");

    expect(surge.content).toContain("[FP] TW 01 = trojan, tw.example.com, 443");
    expect(surge.content).toContain("[FP] TW 01 Chain = socks5, 1.1.1.1, 1080");
    expect(surge.content).toContain("underlying-proxy=[FP] TW 01");
    expect(surge.content).not.toContain("[FP] TW 02");
  });

  it("generates and maps the chain exit node for every shared Surge and Clash protocol", async () => {
    const env = makeEnv();
    const clashExpectations = new Map<ChainExitProtocol, Record<string, unknown>>([
      ["https", { type: "http", tls: true, username: "user-id", password: "secret" }],
      ["socks5-tls", { type: "socks5", tls: true, username: "user-id", password: "secret" }],
      ["ss", { type: "ss", cipher: "chacha20-ietf-poly1305", password: "secret" }],
      ["snell", { type: "snell", psk: "secret", version: 4 }],
      ["vmess", { type: "vmess", uuid: "user-id", cipher: "auto" }],
      ["tuic", { type: "tuic", uuid: "user-id", password: "secret" }],
      ["trojan", { type: "trojan", password: "secret" }],
      ["hysteria2", { type: "hysteria2", password: "secret" }],
      ["anytls", { type: "anytls", password: "secret" }],
      ["trust-tunnel", { type: "trust-tunnel", username: "user-id", password: "secret" }],
      ["ssh", { type: "ssh", username: "user-id", password: "secret" }]
    ]);

    for (const protocol of CHAIN_EXIT_PROTOCOLS) {
      const config = configWithExitProtocol(protocol);
      const surge = await generateConfig(env, config, "surge", "https://subpilot.example.com/sync/token/");
      const clash = await generateConfig(env, config, "clash", "https://subpilot.example.com/sync/token/");
      const clashProxy = (YAML.parse(clash.content) as { proxies: Record<string, unknown>[] }).proxies[0]!;

      expect(surge.content).toContain(`${CHAIN_EXIT_PROXY_NAME} = ${protocol}, 1.2.3.4, 443`);
      expect(clashProxy.server).toBe("1.2.3.4");
      expect(clashProxy.port).toBe(443);
      const expected = clashExpectations.get(protocol);
      if (expected) expect(clashProxy).toMatchObject(expected);
      if (protocol === "tuic") expect(clashProxy).not.toHaveProperty("token");
    }
  });
});
