import { describe, expect, it } from "vitest";
import { mergeConfigPatch, validateConfigForSave } from "../src/config-api";
import { normalizeConfig } from "../src/config-normalize";
import { validateManagedBaseUrl } from "../src/config-validation";
import { DEFAULT_CONFIG } from "../src/default-config";
import type { AppConfig, SurgeTailscaleNodeConfig } from "../src/types";

function validConfig(): AppConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    settings: {
      ...structuredClone(DEFAULT_CONFIG.settings),
      managedBaseUrl: "https://subpilot.example.com/sync"
    }
  };
}

function tailscaleNode(name: string, underlyingProxy = ""): SurgeTailscaleNodeConfig {
  return {
    name,
    sectionName: name.toLowerCase().replace(/\s+/g, "-"),
    authKey: "tskey-auth-test",
    controlUrl: "",
    hostname: "",
    derpOnly: false,
    exitNode: "none",
    idleKeepalive: 600,
    preferIpv6: false,
    dnsServer: [],
    mtu: 1280,
    underlyingProxy,
    testUrl: "http://100.100.100.100/",
    testTimeout: 5,
    enabled: true
  };
}

describe("config API correctness", () => {
  it("deep-merges Surge and Clash nested PATCH objects", () => {
    const current = validConfig();
    current.surge.mitm.hostname = ["keep.example"];
    current.surge.mitm.caPassphrase = "keep-passphrase";
    current.clash.tun.stack = "mixed";
    current.clash.tun.skipProxy = ["keep.example"];

    const merged = mergeConfigPatch(current, {
      surge: { mitm: { h2: false } } as AppConfig["surge"],
      clash: { tun: { enable: false } } as AppConfig["clash"]
    });

    expect(merged.surge.mitm).toMatchObject({
      h2: false,
      hostname: ["keep.example"],
      caPassphrase: "keep-passphrase"
    });
    expect(merged.clash.tun).toMatchObject({
      enable: false,
      stack: "mixed",
      skipProxy: ["keep.example"]
    });
  });

  it("requires exactly one compiled fallback rule", () => {
    const config = validConfig();
    config.ruleSets.mode = "compiled";
    expect(validateConfigForSave(config)).toContain("必须保留一个 FINAL 或 MATCH");

    config.ruleSets.directRules = [{
      id: "final",
      name: "Final",
      enabled: true,
      rule: "FINAL,Proxy",
      policy: "Proxy",
      order: 99
    }];
    expect(validateConfigForSave(config)).toBeNull();

    config.ruleSets.directRules[0]!.policy = "PASS";
    expect(validateConfigForSave(config)).toContain("不受所有输出目标支持");
    config.ruleSets.directRules[0]!.policy = "Proxy";

    config.ruleSets.directRules.push({
      id: "match",
      name: "Match",
      enabled: true,
      rule: "MATCH,DIRECT",
      policy: "DIRECT",
      order: 100
    });
    expect(validateConfigForSave(config)).toContain("只能保留一个 FINAL 或 MATCH");
  });

  it("validates group names, IDs, predictable policy collisions, and entity limits", () => {
    const badGroup = validConfig();
    badGroup.groups = { ...badGroup.groups, "Bad,Group": "select, DIRECT" };
    expect(validateConfigForSave(badGroup)).toContain("策略组名称格式无效");

    const duplicateSources = validConfig();
    duplicateSources.sources = [{
      id: "same",
      name: "One",
      url: "https://one.example/sub",
      fetchUserAgent: "surge",
      enabled: true
    }, {
      id: "same",
      name: "Two",
      url: "https://two.example/sub",
      fetchUserAgent: "surge",
      enabled: true
    }];
    expect(validateConfigForSave(duplicateSources)).toContain("订阅源 ID same 不能重复");

    const duplicateStaticNames = validConfig();
    duplicateStaticNames.proxyNodes = ["one", "two"].map((id) => ({
      id,
      config: "Same Node = socks5, 192.0.2.1, 1080",
      chainFilter: [],
      enabled: true,
      chainExit: false,
      includeInGroups: true
    }));
    expect(validateConfigForSave(duplicateStaticNames)).toContain("代理节点名称 Same Node 不能重复");

    const tooManySources = validConfig();
    tooManySources.sources = Array.from({ length: 21 }, (_item, index) => ({
      id: `source-${index}`,
      name: `Source ${index}`,
      url: "",
      fetchUserAgent: "surge" as const,
      enabled: false
    }));
    expect(validateConfigForSave(tooManySources)).toContain("订阅源数量不能超过 20");

    const tooManyKeywords = validConfig();
    tooManyKeywords.settings.excludeKeywords = Array.from({ length: 2_001 }, () => "");
    expect(validateConfigForSave(tooManyKeywords)).toContain("排除关键词数量不能超过 2000");
  });

  it("validates Tailscale URLs, underlying policies, name collisions, and cycles", () => {
    const invalidUrl = validConfig();
    invalidUrl.surge.tailscaleNodes = [{ ...tailscaleNode("Tail A"), testUrl: "https://example.com/health" }];
    expect(validateConfigForSave(invalidUrl)).toContain("test-url 必须是有效的 http:// URL");

    const missing = validConfig();
    missing.surge.tailscaleNodes = [tailscaleNode("Tail A", "Missing")];
    expect(validateConfigForSave(missing)).toContain("underlying-proxy Missing 不存在或不可用");

    const malformed = validConfig();
    malformed.surge.tailscaleNodes = [{
      ...tailscaleNode("Tail A"),
      underlyingProxy: undefined as unknown as string
    }];
    expect(() => validateConfigForSave(malformed)).not.toThrow();
    expect(validateConfigForSave(malformed)).toBeNull();

    const self = validConfig();
    self.surge.tailscaleNodes = [tailscaleNode("Tail A", "Tail A")];
    expect(validateConfigForSave(self)).toContain("不能引用自身");

    const cycle = validConfig();
    cycle.surge.tailscaleNodes = [tailscaleNode("Tail A", "Tail B"), tailscaleNode("Tail B", "Tail A")];
    expect(validateConfigForSave(cycle)).toContain("不能形成循环引用");

    const collision = validConfig();
    collision.surge.tailscaleNodes = [tailscaleNode("Auto")];
    expect(validateConfigForSave(collision)).toContain("与已有策略、节点或内置策略冲突");

    const uppercaseSubnet = validConfig();
    uppercaseSubnet.groups = {
      ...uppercaseSubnet.groups,
      Network: "SUBNET, TYPE:WIFI=DIRECT"
    };
    uppercaseSubnet.surge.tailscaleNodes = [tailscaleNode("Tail A", "Network")];
    expect(validateConfigForSave(uppercaseSubnet)).toBeNull();
  });

  it("rejects unsafe policy-group specifications and malformed entities", () => {
    const unknownType = validConfig();
    unknownType.groups.Experimental = "random, DIRECT";
    expect(validateConfigForSave(unknownType)).toContain("类型 random 不受支持");

    const reservedOption = validConfig();
    reservedOption.groups.Auto = "url-test, {all}, name=Injected";
    expect(validateConfigForSave(reservedOption)).toContain("参数 name 为保留字段");

    const missingMember = validConfig();
    missingMember.groups.Proxy = "select, Missing";
    expect(validateConfigForSave(missingMember)).toContain("成员 Missing 不存在");

    const cycle = validConfig();
    cycle.groups = {
      Proxy: "select, Network",
      Network: "SUBNET, default=Proxy"
    };
    expect(validateConfigForSave(cycle)).toContain("策略组不能形成循环引用：Proxy -> Network -> Proxy");

    const uppercaseSubnet = validConfig();
    uppercaseSubnet.groups = {
      Proxy: "SELECT, Network",
      Network: "SUBNET, TYPE:WIFI=DIRECT"
    };
    expect(normalizeConfig(uppercaseSubnet).groups).toEqual({
      Proxy: "select, Network",
      Network: "subnet, default=Proxy, TYPE:WIFI=DIRECT"
    });

    uppercaseSubnet.settings.excludeKeywords = ["  ads  ", "", "   "];
    expect(normalizeConfig(uppercaseSubnet).settings.excludeKeywords).toEqual(["ads"]);

    const malformed = validConfig();
    malformed.proxyNodes = [null as unknown as AppConfig["proxyNodes"][number]];
    expect(() => validateConfigForSave(malformed)).not.toThrow();
    expect(validateConfigForSave(malformed)).toContain("格式无效");
  });

  it("rejects unsafe source URLs, rule lines, and User-Agent values", () => {
    const sourceUrl = validConfig();
    sourceUrl.sources = [{
      id: "local",
      name: "Local",
      url: "file:///etc/passwd",
      fetchUserAgent: "surge",
      enabled: true
    }];
    expect(validateConfigForSave(sourceUrl)).toContain("URL 必须使用 http 或 https");

    const ruleSourceUrl = validConfig();
    ruleSourceUrl.ruleSets.sources = [{
      id: "local-rules",
      name: "Local rules",
      url: "data:text/plain,DOMAIN,example.com",
      format: "surge-rule-set",
      enabled: true,
      order: 1
    }];
    expect(validateConfigForSave(ruleSourceUrl)).toContain("URL 必须使用 http 或 https");

    const ruleLine = validConfig();
    ruleLine.surge.rules = ["FINAL,Proxy\nDOMAIN,example.com,DIRECT"];
    expect(validateConfigForSave(ruleLine)).toContain("不能包含换行");

    const userAgent = validConfig();
    userAgent.settings.userAgentSurge = "Surge\r\nX-Injected: true";
    expect(validateConfigForSave(userAgent)).toContain("Surge User-Agent不能包含换行");
  });

  it("validates compiled policies and Surge options before saving", () => {
    const missingPolicy = validConfig();
    missingPolicy.ruleSets.mode = "compiled";
    missingPolicy.ruleSets.outputs = [{
      name: "Output",
      policy: "Missing",
      sourceIds: [],
      inlineRules: ["DOMAIN,example.com"],
      surgeOptions: [],
      enabled: true,
      order: 1
    }];
    missingPolicy.ruleSets.directRules = [{
      id: "final",
      name: "Final",
      rule: "FINAL,Proxy",
      policy: "Proxy",
      enabled: true,
      order: 1
    }];
    expect(validateConfigForSave(missingPolicy)).toContain("策略 Missing 不存在或不可用");

    missingPolicy.ruleSets.outputs[0]!.policy = "Proxy";
    missingPolicy.ruleSets.outputs[0]!.surgeOptions = ["no-resolve", "NO-RESOLVE"];
    expect(validateConfigForSave(missingPolicy)).toContain("Surge 参数不能重复");

    missingPolicy.ruleSets.outputs[0]!.surgeOptions = ["udp"];
    expect(validateConfigForSave(missingPolicy)).toContain("Surge 参数 udp 不受支持");
  });

  it("requires an enabled Tailscale auth key and rejects field injection", () => {
    const blankKey = validConfig();
    blankKey.surge.tailscaleNodes = [{ ...tailscaleNode("Tail A"), authKey: "   " }];
    expect(validateConfigForSave(blankKey)).toContain("启用时 auth-key 不能为空");

    const injected = validConfig();
    injected.surge.tailscaleNodes = [{ ...tailscaleNode("Tail A"), hostname: "tail\n[Proxy]" }];
    expect(validateConfigForSave(injected)).toContain("hostname不能包含换行");
  });

  it("reserves the vendor asset path for managed subscriptions", () => {
    expect(validateManagedBaseUrl({ settings: { managedBaseUrl: "https://subpilot.example.com/vendor" } })).toContain("reserved");
    expect(validateManagedBaseUrl({ settings: { managedBaseUrl: "https://subpilot.example.com/vendor/codemirror.js" } })).toContain("reserved");
  });
});
