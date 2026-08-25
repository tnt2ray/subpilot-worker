import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/default-config";
import { buildClashGroups, buildSurgeGroups } from "../src/policy-groups";
import type { AppConfig, ProxyNode } from "../src/types";

describe("policy group generation", () => {
  it("keeps the root Proxy usable when no proxy nodes are available", () => {
    expect(buildSurgeGroups(DEFAULT_CONFIG, [])).toEqual([{
      name: "Proxy",
      line: "Proxy = select, DIRECT"
    }]);
    expect(buildClashGroups(DEFAULT_CONFIG, [])).toEqual([{
      name: "Proxy",
      type: "select",
      proxies: ["DIRECT"]
    }]);
  });

  it("recursively removes references to child groups whose filters resolve empty", () => {
    const config: AppConfig = {
      ...DEFAULT_CONFIG,
      groups: {
        Proxy: "select, Empty Parent, Working",
        "Empty Parent": "select, Empty Child",
        "Empty Child": "url-test, {all filter=US}, url=https://www.gstatic.com/generate_204, interval=600",
        Working: "select, {all filter=JP}"
      }
    };
    const nodes: ProxyNode[] = [{
      name: "JP 1",
      type: "trojan",
      server: "jp.example.com",
      port: 443,
      password: "password",
      params: {}
    }];

    expect(buildSurgeGroups(config, nodes)).toEqual([{
      name: "Proxy",
      line: "Proxy = select, Working"
    }, {
      name: "Working",
      line: "Working = select, JP 1"
    }]);
    expect(buildClashGroups(config, nodes)).toEqual([{
      name: "Proxy",
      type: "select",
      proxies: ["Working"]
    }, {
      name: "Working",
      type: "select",
      proxies: ["JP 1"]
    }]);
  });

  it("does not count fallback or load-balance options as usable policy members", () => {
    const config: AppConfig = {
      ...DEFAULT_CONFIG,
      groups: {
        Proxy: "select, Empty Fallback, Empty Balance, Cycle A",
        "Empty Fallback": "fallback, Empty Child, url=https://www.gstatic.com/generate_204, interval=600",
        "Empty Balance": "load-balance, {all filter=US}, url=https://www.gstatic.com/generate_204, interval=600, strategy=round-robin",
        "Empty Child": "select, {all filter=US}",
        "Cycle A": "select, Cycle B",
        "Cycle B": "select, Cycle A"
      }
    };
    const nodes: ProxyNode[] = [{
      name: "JP 1",
      type: "trojan",
      server: "jp.example.com",
      port: 443,
      password: "password",
      params: {}
    }];

    expect(buildSurgeGroups(config, nodes)).toEqual([{
      name: "Proxy",
      line: "Proxy = select, DIRECT"
    }]);
    expect(buildClashGroups(config, nodes)).toEqual([{
      name: "Proxy",
      type: "select",
      proxies: ["DIRECT"]
    }]);
  });

  it("does not let a legacy cycle anchored at Proxy reintroduce circular group references", () => {
    const config: AppConfig = {
      ...DEFAULT_CONFIG,
      groups: {
        Proxy: "select, Cycle",
        Cycle: "select, Proxy"
      }
    };

    expect(buildSurgeGroups(config, [])).toEqual([{
      name: "Proxy",
      line: "Proxy = select, DIRECT"
    }]);
    expect(buildClashGroups(config, [])).toEqual([{
      name: "Proxy",
      type: "select",
      proxies: ["DIRECT"]
    }]);
  });

  it("normalizes case-insensitive group types before rendering target syntax", () => {
    const config: AppConfig = {
      ...DEFAULT_CONFIG,
      groups: {
        Proxy: "SELECT, Auto",
        Auto: "URL-TEST, {all}, url=https://www.gstatic.com/generate_204, interval=600"
      }
    };
    const nodes: ProxyNode[] = [{
      name: "Node 1",
      type: "trojan",
      server: "node.example.com",
      port: 443,
      password: "password",
      params: {}
    }];

    expect(buildSurgeGroups(config, nodes)).toEqual([{
      name: "Proxy",
      line: "Proxy = select, Auto"
    }, {
      name: "Auto",
      line: "Auto = smart, Node 1"
    }]);
    expect(buildClashGroups(config, nodes)).toEqual([{
      name: "Proxy",
      type: "select",
      proxies: ["Auto"]
    }, {
      name: "Auto",
      type: "url-test",
      proxies: ["Node 1"],
      url: "https://www.gstatic.com/generate_204",
      interval: "600"
    }]);
  });

  it("keeps fallback and load-balance options when their policy members are usable", () => {
    const config: AppConfig = {
      ...DEFAULT_CONFIG,
      groups: {
        Proxy: "select, Fallback, Balance",
        Fallback: "fallback, Working, url=https://fallback.example/generate_204, interval=300",
        Balance: "load-balance, {all filter=JP}, url=https://balance.example/generate_204, interval=400, strategy=round-robin",
        Working: "select, {all filter=JP}"
      }
    };
    const nodes: ProxyNode[] = [{
      name: "JP 1",
      type: "trojan",
      server: "jp.example.com",
      port: 443,
      password: "password",
      params: {}
    }];

    expect(buildSurgeGroups(config, nodes)).toEqual([{
      name: "Proxy",
      line: "Proxy = select, Fallback, Balance"
    }, {
      name: "Fallback",
      line: "Fallback = fallback, Working, url=https://fallback.example/generate_204, interval=300"
    }, {
      name: "Balance",
      line: "Balance = load-balance, JP 1, url=https://balance.example/generate_204, interval=400, strategy=round-robin"
    }, {
      name: "Working",
      line: "Working = select, JP 1"
    }]);
    expect(buildClashGroups(config, nodes)).toEqual([{
      name: "Proxy",
      type: "select",
      proxies: ["Fallback", "Balance"]
    }, {
      name: "Fallback",
      type: "fallback",
      proxies: ["Working"],
      url: "https://fallback.example/generate_204",
      interval: "300"
    }, {
      name: "Balance",
      type: "load-balance",
      proxies: ["JP 1"],
      url: "https://balance.example/generate_204",
      interval: "400",
      strategy: "round-robin"
    }, {
      name: "Working",
      type: "select",
      proxies: ["JP 1"]
    }]);
  });

  it("keeps target-specific built-in policies out of other clients", () => {
    const config: AppConfig = {
      ...DEFAULT_CONFIG,
      groups: {
        Proxy: "select, Surge Only, Clash Only, Shared",
        "Surge Only": "select, CELLULAR, CELLULAR-ONLY, HYBRID, NO-HYBRID",
        "Clash Only": "select, PASS-RULE, COMPATIBLE",
        Shared: "select, DIRECT"
      }
    };

    expect(buildSurgeGroups(config, [])).toEqual([{
      name: "Proxy",
      line: "Proxy = select, Surge Only, Shared"
    }, {
      name: "Surge Only",
      line: "Surge Only = select, CELLULAR, CELLULAR-ONLY, HYBRID, NO-HYBRID"
    }, {
      name: "Shared",
      line: "Shared = select, DIRECT"
    }]);
    expect(buildClashGroups(config, [])).toEqual([{
      name: "Proxy",
      type: "select",
      proxies: ["Clash Only", "Shared"]
    }, {
      name: "Clash Only",
      type: "select",
      proxies: ["PASS-RULE", "COMPATIBLE"]
    }, {
      name: "Shared",
      type: "select",
      proxies: ["DIRECT"]
    }]);
    expect(buildClashGroups(config, [], "stash")).toEqual([{
      name: "Proxy",
      type: "select",
      proxies: ["Shared"]
    }, {
      name: "Shared",
      type: "select",
      proxies: ["DIRECT"]
    }]);
  });
});
