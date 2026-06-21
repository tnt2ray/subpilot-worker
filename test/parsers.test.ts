import { describe, expect, it } from "vitest";
import { maybeDecodeBase64, parseHostEntries, parseManualSurge, parseSubscription, parseSurgeHostLines, toClashProxy, toSurgeLine } from "../src/parsers";
import { CHAIN_EXIT_PROXY_NAME } from "../src/types";

describe("proxy parsing", () => {
  it("decodes base64 subscriptions", () => {
    const encoded = btoa("trojan://password@example.com:443#Japan");
    expect(maybeDecodeBase64(encoded)).toContain("trojan://");
  });

  it("parses manual surge proxy lines", () => {
    const nodes = parseManualSurge("[Proxy]\nProxy A = socks5, 1.2.3.4, 443, username=u, password=p");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.name).toBe("Proxy A");
  });

  it("preserves host lines from surge subscriptions", () => {
    const lines = parseSurgeHostLines([
      "[General]",
      "loglevel = notify",
      "",
      "[Host]",
      "example.test = 1.2.3.4",
      "# comment",
      "api.example.test = server:443",
      "",
      "[Proxy]",
      "Proxy A = socks5, 1.2.3.4, 443"
    ].join("\n"));
    expect(lines).toEqual(["example.test = 1.2.3.4", "api.example.test = server:443"]);
  });

  it("preserves host entries from clash subscriptions", () => {
    const entries = parseHostEntries([
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
      "    password: pass"
    ].join("\n"));
    expect(entries).toEqual([
      { host: "clash.example.test", value: ["1.1.1.1", "1.0.0.1"] },
      { host: "edge.example.test", value: "2.2.2.2" }
    ]);
  });

  it("keeps socks5 usernames as usernames in Clash output", () => {
    const [node] = parseManualSurge("[Proxy]\nProxy A = socks5, 1.2.3.4, 443, username=u, password=p");
    expect(toClashProxy(node!)).toMatchObject({ type: "socks5", username: "u", password: "p" });
    expect(toClashProxy(node!)).not.toHaveProperty("uuid");
  });

  it("reuses original surge proxy details for Surge output", () => {
    const [node] = parseManualSurge("[Proxy]\nJP 1 = trojan,jp.example.com,443,password=p,udp-relay=true,tfo=true");
    expect(toSurgeLine({ ...node!, name: "Primary JP 1" })).toBe(
      "Primary JP 1 = trojan,jp.example.com,443,password=p,udp-relay=true,tfo=true"
    );
  });

  it("maps surge proxy parameters to Clash fields for Clash output", () => {
    const [node] = parseManualSurge("[Proxy]\nSS 1 = ss,1.2.3.4,8388,encrypt-method=chacha20-ietf-poly1305,password=p");
    expect(toClashProxy(node!)).toMatchObject({
      name: "SS 1",
      type: "ss",
      server: "1.2.3.4",
      port: 8388,
      cipher: "chacha20-ietf-poly1305",
      password: "p"
    });
    expect(toClashProxy(node!)).not.toHaveProperty("encrypt-method");
  });

  it("maps Surge WebSocket proxy parameters to Clash structures", () => {
    const [node] = parseManualSurge("[Proxy]\nCF 1 = trojan,1.2.3.4,443,password=p,sni=edge.example.com,ws=true,ws-path=/photos/documents/member?ed=2560,ws-headers=Host:\"edge.example.com\",skip-cert-verify=true,udp-relay=true");
    expect(toClashProxy(node!)).toMatchObject({
      name: "CF 1",
      type: "trojan",
      password: "p",
      sni: "edge.example.com",
      network: "ws",
      "ws-opts": {
        path: "/photos/documents/member?ed=2560",
        headers: {
          Host: "edge.example.com"
        }
      },
      "skip-cert-verify": true,
      udp: true
    });
    expect(toClashProxy(node!)).not.toHaveProperty("ws");
    expect(toClashProxy(node!)).not.toHaveProperty("ws-path");
    expect(toClashProxy(node!)).not.toHaveProperty("ws-headers");
    expect(toClashProxy(node!)).not.toHaveProperty("udp-relay");
  });

  it("converts clash yaml proxy parameters for Surge output", () => {
    const [node] = parseSubscription([
      "proxies:",
      "  - name: TR 1",
      "    type: trojan",
      "    server: tr.example.com",
      "    port: 443",
      "    password: p",
      "    network: ws",
      "    udp: true",
      "    servername: edge.example.com",
      "    skip-cert-verify: true",
      "    alpn:",
      "      - h2",
      "      - http/1.1",
      "    client-fingerprint: chrome",
      "    dialer-proxy: Proxy",
      "    ws-opts:",
      "      path: /ws",
      "      headers:",
      "        Host: edge.example.com",
      "        X-Test: a",
      "    reality-opts:",
      "      public-key: pubkey",
      "      short-id: sid"
    ].join("\n"), "src");

    expect(toSurgeLine({ ...node!, name: "Primary TR 1" })).toBe([
      "Primary TR 1 = trojan",
      "tr.example.com",
      "443",
      "password=p",
      "ws=true",
      "udp-relay=true",
      "sni=edge.example.com",
      "skip-cert-verify=true",
      "alpn=h2;http/1.1",
      "client-fingerprint=chrome",
      "underlying-proxy=Proxy",
      "ws-path=/ws",
      "ws-headers=Host:edge.example.com|X-Test:a",
      "reality-public-key=pubkey",
      "reality-short-id=sid"
    ].join(", "));
  });

  it("maps TLS HTTP and SOCKS variants to Clash TLS fields", () => {
    expect(toClashProxy({
      name: CHAIN_EXIT_PROXY_NAME,
      type: "https",
      server: "1.2.3.4",
      port: 443,
      params: {}
    })).toMatchObject({ type: "http", tls: true });
    expect(toClashProxy({
      name: CHAIN_EXIT_PROXY_NAME,
      type: "socks5-tls",
      server: "1.2.3.4",
      port: 443,
      params: {}
    })).toMatchObject({ type: "socks5", tls: true });
  });

  it("normalizes Clash alpn strings to arrays", () => {
    const [node] = parseSubscription([
      "proxies:",
      "  - name: TR 1",
      "    type: trojan",
      "    server: tr.example.com",
      "    port: 443",
      "    password: p",
      "    alpn: h2,http/1.1"
    ].join("\n"), "src");

    expect(toClashProxy(node!)).toMatchObject({
      alpn: ["h2", "http/1.1"]
    });
  });

  it("maps URI authentication fields by protocol instead of duplicating password and uuid", () => {
    const [trojan] = parseSubscription("trojan://pass@tr.example.com:443#TR", "src");
    const trojanProxy = toClashProxy(trojan!);
    expect(trojanProxy).toMatchObject({ type: "trojan", password: "pass" });
    expect(trojanProxy).not.toHaveProperty("uuid");
    expect(toSurgeLine({ ...trojan!, name: "TR" })).toBe("TR = trojan, tr.example.com, 443, password=pass");

    const [vless] = parseSubscription("vless://00000000-0000-0000-0000-000000000002@vl.example.com:443?security=reality&type=grpc&serviceName=TunService&fp=chrome&pbk=pubkey&sid=sid#VL", "src");
    const vlessProxy = toClashProxy(vless!);
    expect(vlessProxy).toMatchObject({
      type: "vless",
      uuid: "00000000-0000-0000-0000-000000000002",
      tls: true,
      network: "grpc",
      "grpc-opts": {
        "grpc-service-name": "TunService"
      },
      "client-fingerprint": "chrome",
      "reality-opts": {
        "public-key": "pubkey",
        "short-id": "sid"
      }
    });
    expect(vlessProxy).not.toHaveProperty("password");
  });

  it("restores flattened Surge transport and Reality params to Clash nested structures", () => {
    const [node] = parseManualSurge("[Proxy]\nVL 1 = vless,vl.example.com,443,username=00000000-0000-0000-0000-000000000002,tls=true,network=grpc,grpc-service-name=TunService,reality-public-key=pubkey,reality-short-id=sid");
    const proxy = toClashProxy(node!);
    expect(proxy).toMatchObject({
      type: "vless",
      uuid: "00000000-0000-0000-0000-000000000002",
      tls: true,
      network: "grpc",
      "grpc-opts": {
        "grpc-service-name": "TunService"
      },
      "reality-opts": {
        "public-key": "pubkey",
        "short-id": "sid"
      }
    });
    expect(proxy).not.toHaveProperty("grpc-service-name");
    expect(proxy).not.toHaveProperty("reality-public-key");
    expect(proxy).not.toHaveProperty("reality-short-id");
    expect((proxy["reality-opts"] as Record<string, unknown>).opts).toBeUndefined();
    expect((proxy["grpc-opts"] as Record<string, unknown>)["grpc-opts"]).toBeUndefined();
  });

  it("parses clash yaml proxies", () => {
    const nodes = parseSubscription("proxies:\n  - name: JP 1\n    type: trojan\n    server: jp.example.com\n    port: 443\n    password: pass\n", "src");
    expect(nodes[0]?.server).toBe("jp.example.com");
  });

  it("keeps duplicate nodes while parsing a single subscription", () => {
    const nodes = parseSubscription([
      "proxies:",
      "  - name: Simple",
      "    type: trojan",
      "    server: dup.example.com",
      "    port: 443",
      "    password: p",
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
    ].join("\n"), "src");

    expect(nodes).toHaveLength(2);
    expect(nodes[0]?.name).toBe("Simple");
    expect(nodes[1]?.name).toBe("Rich");
    expect(nodes[1]?.params).toMatchObject({
      network: "ws",
      "ws-opts": {
        path: "/ws",
        headers: {
          Host: "edge.example.com"
        }
      }
    });
  });
});
