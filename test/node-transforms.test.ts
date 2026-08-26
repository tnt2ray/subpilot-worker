import { describe, expect, it } from "vitest";
import { buildChainNodes, ensureUniqueProxyPolicyNames, isProxyNodeSupportedForTarget } from "../src/node-transforms";
import { DEFAULT_CONFIG } from "../src/default-config";
import type { ProxyNode } from "../src/types";

function proxy(name: string, overrides: Partial<ProxyNode> = {}): ProxyNode {
  return {
    name,
    type: "socks5",
    server: "192.0.2.1",
    port: 1080,
    params: {},
    ...overrides
  };
}

describe("proxy policy name allocation", () => {
  it("keeps TUIC v4 Surge-only and maps TUIC v5 across Surge and Clash-like targets", () => {
    expect(isProxyNodeSupportedForTarget({ type: "tuic" }, "surge")).toBe(true);
    expect(isProxyNodeSupportedForTarget({ type: "tuic" }, "clash")).toBe(false);
    expect(isProxyNodeSupportedForTarget({ type: "tuic" }, "stash")).toBe(false);
    expect(isProxyNodeSupportedForTarget({ type: "tuic-v5" }, "surge")).toBe(true);
    expect(isProxyNodeSupportedForTarget({ type: "tuic-v5" }, "clash")).toBe(true);
    expect(isProxyNodeSupportedForTarget({ type: "tuic-v5" }, "stash")).toBe(true);
  });

  it("keeps manual names stable and renames upstream collisions deterministically", () => {
    const config = {
      ...DEFAULT_CONFIG,
      groups: { Proxy: "select", Group: "select" },
      surge: {
        ...DEFAULT_CONFIG.surge,
        tailscaleNodes: [{
          name: "Tail",
          sectionName: "tail",
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
      }
    };
    const warnings: string[] = [];
    const nodes = ensureUniqueProxyPolicyNames([
      proxy("Same"),
      proxy("Same", { manual: true }),
      proxy("Group"),
      proxy("Tail"),
      proxy("DIRECT")
    ], config, warnings);

    expect(nodes.map((node) => node.name)).toEqual(["Same 2", "Same", "Group 2", "Tail 2", "DIRECT 2"]);
    expect(warnings).toHaveLength(4);
  });

  it("builds chain references after base-name allocation and only renames colliding chain names", () => {
    const warnings: string[] = [];
    const baseNodes = ensureUniqueProxyPolicyNames([
      proxy("Base", { matchLabels: ["JP"] }),
      proxy("Base", { manual: true, matchLabels: ["US"] }),
      proxy("Exit", {
        manual: true,
        chainExit: true,
        chainFilter: ["JP"],
        includeInGroups: false
      })
    ], DEFAULT_CONFIG, warnings);
    const chainNodes = buildChainNodes(baseNodes);
    const uniqueChainNodes = ensureUniqueProxyPolicyNames(
      chainNodes,
      DEFAULT_CONFIG,
      warnings,
      baseNodes.map((node) => node.name)
    );

    expect(baseNodes.map((node) => node.name)).toEqual(["Base 2", "Base", "Exit"]);
    expect(uniqueChainNodes).toHaveLength(1);
    expect(uniqueChainNodes[0]?.name).toBe("Base 2 via Exit");
    expect(uniqueChainNodes[0]?.params["underlying-proxy"]).toBe("Base 2");
    expect(uniqueChainNodes[0]?.params["dialer-proxy"]).toBe("Base 2");
  });
});
