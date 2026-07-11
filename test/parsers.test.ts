import { describe, expect, it } from "vitest";
import { maybeDecodeBase64, parseHostEntries, parseManualSurge, parseSubscription, parseSurgeHostLines, toClashProxy, toSurgeLine } from "../src/parsers";
import { CHAIN_EXIT_PROXY_NAME } from "../src/types";

describe("proxy parsing", () => {
  it("rejects upstream YAML proxy and host fields containing line breaks or control characters", () => {
    const injectedName = parseSubscription([
      "proxies:",
      "  - name: |",
      "      Safe Node",
      "      [Rule]",
      "      FINAL,REJECT",
      "    type: trojan",
      "    server: proxy.example.com",
      "    port: 443",
      "    password: secret"
    ].join("\n"), "src");
    const injectedPassword = parseSubscription([
      "proxies:",
      "  - name: Safe Node",
      "    type: trojan",
      "    server: proxy.example.com",
      "    port: 443",
      "    password: |",
      "      secret",
      "      [Rule]"
    ].join("\n"), "src");
    const injectedHosts = parseHostEntries([
      "hosts:",
      "  safe.example: |",
      "    192.0.2.1",
      "    [Rule]",
      "  control.example: \"192.0.2.2\\u007f\""
    ].join("\n"));
    const surgeControlCharacter = parseSubscription(
      "Unsafe\u0000Node = trojan, proxy.example.com, 443, password=secret",
      "src"
    );
    const surgeHostControlCharacter = parseHostEntries(
      "[Host]\nunsafe.example = 192.0.2.1\u0000"
    );

    expect(injectedName).toEqual([]);
    expect(injectedPassword).toEqual([]);
    expect(injectedHosts).toEqual([]);
    expect(surgeControlCharacter).toEqual([]);
    expect(surgeHostControlCharacter).toEqual([]);
  });

  it("parses encoded, manual, Surge host, Clash host, YAML, and duplicate subscription inputs", () => {
    expect(maybeDecodeBase64(btoa("trojan://password@example.com:443#Japan"))).toContain("trojan://");

    const manualNodes = parseManualSurge("[Proxy]\nProxy A = socks5, 1.2.3.4, 443, username=u, password=p");
    expect(manualNodes).toHaveLength(1);
    expect(manualNodes[0]?.name).toBe("Proxy A");

    const surgeHostLines = parseSurgeHostLines([
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
    expect(surgeHostLines).toEqual(["example.test = 1.2.3.4", "api.example.test = server:443"]);

    const hostEntries = parseHostEntries([
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
    expect(hostEntries).toEqual([
      { host: "clash.example.test", value: ["1.1.1.1", "1.0.0.1"] },
      { host: "edge.example.test", value: "2.2.2.2" }
    ]);

    const yamlNodes = parseSubscription("proxies:\n  - name: JP 1\n    type: trojan\n    server: jp.example.com\n    port: 443\n    password: pass\n", "src");
    expect(yamlNodes[0]?.server).toBe("jp.example.com");

    const duplicateNodes = parseSubscription([
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
    expect(duplicateNodes).toHaveLength(2);
    expect(duplicateNodes[0]?.name).toBe("Simple");
    expect(duplicateNodes[1]?.name).toBe("Rich");
    expect(duplicateNodes[1]?.params).toMatchObject({
      network: "ws",
      "ws-opts": {
        path: "/ws",
        headers: {
          Host: "edge.example.com"
        }
      }
    });
  });

  it("maps Surge proxy variants into Clash structures without leaking flattened source fields", () => {
    const [socksNode] = parseManualSurge("[Proxy]\nProxy A = socks5, 1.2.3.4, 443, username=u, password=p");
    expect(toClashProxy(socksNode!)).toMatchObject({ type: "socks5", username: "u", password: "p" });
    expect(toClashProxy(socksNode!)).not.toHaveProperty("uuid");

    const [ssNode] = parseManualSurge("[Proxy]\nSS 1 = ss,1.2.3.4,8388,encrypt-method=chacha20-ietf-poly1305,password=p");
    expect(toClashProxy(ssNode!)).toMatchObject({
      name: "SS 1",
      type: "ss",
      server: "1.2.3.4",
      port: 8388,
      cipher: "chacha20-ietf-poly1305",
      password: "p"
    });
    expect(toClashProxy(ssNode!)).not.toHaveProperty("encrypt-method");

    const [wsNode] = parseManualSurge("[Proxy]\nCF 1 = trojan,1.2.3.4,443,password=p,sni=edge.example.com,ws=true,ws-path=/photos/documents/member?ed=2560,ws-headers=Host:\"edge.example.com\",skip-cert-verify=true,udp-relay=true");
    expect(toClashProxy(wsNode!)).toMatchObject({
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
    expect(toClashProxy(wsNode!)).not.toHaveProperty("ws");
    expect(toClashProxy(wsNode!)).not.toHaveProperty("ws-path");
    expect(toClashProxy(wsNode!)).not.toHaveProperty("ws-headers");
    expect(toClashProxy(wsNode!)).not.toHaveProperty("udp-relay");

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

    const [flattenedNode] = parseManualSurge("[Proxy]\nVL 1 = vless,vl.example.com,443,username=00000000-0000-0000-0000-000000000002,tls=true,network=grpc,grpc-service-name=TunService,reality-public-key=pubkey,reality-short-id=sid");
    const flattenedProxy = toClashProxy(flattenedNode!);
    expect(flattenedProxy).toMatchObject({
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
    expect(flattenedProxy).not.toHaveProperty("grpc-service-name");
    expect(flattenedProxy).not.toHaveProperty("reality-public-key");
    expect(flattenedProxy).not.toHaveProperty("reality-short-id");
    expect((flattenedProxy["reality-opts"] as Record<string, unknown>).opts).toBeUndefined();
    expect((flattenedProxy["grpc-opts"] as Record<string, unknown>)["grpc-opts"]).toBeUndefined();

    const [hy2Node] = parseManualSurge("[Proxy]\nHY2 = hy2,hy.example.com,443,password=p,download-bandwidth=200,upload-bandwidth=50,port-hopping=443;8443-9000,port-hopping-interval=15,salamander-password=obfs");
    const hy2Proxy = toClashProxy(hy2Node!);
    expect(hy2Proxy).toMatchObject({
      name: "HY2",
      type: "hysteria2",
      server: "hy.example.com",
      port: 443,
      password: "p",
      down: "200",
      up: "50",
      ports: "443,8443-9000",
      "hop-interval": "15",
      obfs: "salamander",
      "obfs-password": "obfs"
    });
    expect(hy2Proxy).not.toHaveProperty("download-bandwidth");
    expect(hy2Proxy).not.toHaveProperty("upload-bandwidth");
    expect(hy2Proxy).not.toHaveProperty("port-hopping");
    expect(hy2Proxy).not.toHaveProperty("port-hopping-interval");
    expect(hy2Proxy).not.toHaveProperty("salamander-password");
    expect(hy2Proxy).not.toHaveProperty("plugin");
    expect(hy2Proxy).not.toHaveProperty("plugin-opts");

    const [hy2RawNode] = parseSubscription([
      "proxies:",
      "  - name: HY2 Raw",
      "    type: hysteria2",
      "    server: hy.example.com",
      "    port: 443",
      "    password: p",
      "    obfs: salamander",
      "    obfs-password: obfs"
    ].join("\n"), "src");
    const hy2RawProxy = toClashProxy(hy2RawNode!);
    expect(hy2RawProxy).toMatchObject({
      type: "hysteria2",
      obfs: "salamander",
      "obfs-password": "obfs"
    });
    expect(hy2RawProxy).not.toHaveProperty("plugin");
    expect(hy2RawProxy).not.toHaveProperty("plugin-opts");

    const [tuicNode] = parseManualSurge("[Proxy]\nTUIC = tuic,tuic.example.com,443,token=tok,alpn=h3");
    const tuicProxy = toClashProxy(tuicNode!);
    expect(tuicProxy).toMatchObject({
      name: "TUIC",
      type: "tuic",
      server: "tuic.example.com",
      port: 443,
      token: "tok",
      alpn: ["h3"]
    });
    expect(tuicProxy).not.toHaveProperty("password");

    const [snellNode] = parseManualSurge("[Proxy]\nSnell = snell,snell.example.com,44046,psk=secret,version=4,obfs=http,obfs-host=bing.com,obfs-uri=/");
    const snellProxy = toClashProxy(snellNode!);
    expect(snellProxy).toMatchObject({
      name: "Snell",
      type: "snell",
      server: "snell.example.com",
      port: 44046,
      psk: "secret",
      version: 4,
      "obfs-opts": {
        mode: "http",
        host: "bing.com"
      }
    });
    expect(snellProxy).not.toHaveProperty("plugin");
    expect(snellProxy).not.toHaveProperty("plugin-opts");
    expect(snellProxy).not.toHaveProperty("obfs");
    expect(snellProxy).not.toHaveProperty("obfs-host");
    expect(snellProxy).not.toHaveProperty("obfs-uri");

    const [fingerprintNode] = parseManualSurge("[Proxy]\nTLS = trojan,tls.example.com,443,password=p,server-cert-fingerprint-sha256=abc123");
    const fingerprintProxy = toClashProxy(fingerprintNode!);
    expect(fingerprintProxy).toMatchObject({ fingerprint: "abc123" });
    expect(fingerprintProxy).not.toHaveProperty("server-cert-fingerprint-sha256");
  });

  it("maps Clash YAML and URI auth fields into Surge and Clash target output", () => {
    const [surgeNode] = parseManualSurge("[Proxy]\nJP 1 = trojan,jp.example.com,443,password=p,udp-relay=true,tfo=true");
    expect(toSurgeLine({ ...surgeNode!, name: "Primary JP 1" })).toBe(
      "Primary JP 1 = trojan,jp.example.com,443,password=p,udp-relay=true,tfo=true"
    );

    const [clashNode] = parseSubscription([
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
      "    fingerprint: abc123",
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
    expect(toSurgeLine({ ...clashNode!, name: "Primary TR 1" })).toBe([
      "Primary TR 1 = trojan",
      "tr.example.com",
      "443",
      "password=p",
      "ws=true",
      "udp-relay=true",
      "sni=edge.example.com",
      "skip-cert-verify=true",
      "server-cert-fingerprint-sha256=abc123",
      "alpn=h2;http/1.1",
      "client-fingerprint=chrome",
      "underlying-proxy=Proxy",
      "ws-path=/ws",
      "ws-headers=Host:edge.example.com|X-Test:a",
      "reality-public-key=pubkey",
      "reality-short-id=sid"
    ].join(", "));

    const [hy2ClashNode] = parseSubscription([
      "proxies:",
      "  - name: HY2",
      "    type: hysteria2",
      "    server: hy.example.com",
      "    port: 443",
      "    password: p",
      "    down: 200",
      "    up: 50",
      "    ports: 443,8443-9000",
      "    hop-interval: 15",
      "    obfs: salamander",
      "    obfs-password: obfs"
    ].join("\n"), "src");
    expect(toSurgeLine({ ...hy2ClashNode!, name: "Primary HY2" })).toBe([
      "Primary HY2 = hysteria2",
      "hy.example.com",
      "443",
      "password=p",
      "download-bandwidth=200",
      "upload-bandwidth=50",
      "port-hopping=443;8443-9000",
      "port-hopping-interval=15",
      "salamander-password=obfs"
    ].join(", "));

    const [snellClashNode] = parseSubscription([
      "proxies:",
      "  - name: Snell",
      "    type: snell",
      "    server: snell.example.com",
      "    port: 44046",
      "    psk: secret",
      "    version: 4",
      "    obfs-opts:",
      "      mode: http",
      "      host: bing.com"
    ].join("\n"), "src");
    expect(toSurgeLine({ ...snellClashNode!, name: "Primary Snell" })).toBe([
      "Primary Snell = snell",
      "snell.example.com",
      "44046",
      "psk=secret",
      "version=4",
      "obfs=http",
      "obfs-host=bing.com"
    ].join(", "));

    const [ssPluginNode] = parseSubscription([
      "proxies:",
      "  - name: SS",
      "    type: ss",
      "    server: ss.example.com",
      "    port: 8388",
      "    cipher: chacha20-ietf-poly1305",
      "    password: p",
      "    plugin: obfs",
      "    plugin-opts:",
      "      mode: tls",
      "      host: bing.com",
      "      path: /"
    ].join("\n"), "src");
    expect(toSurgeLine({ ...ssPluginNode!, name: "Primary SS" })).toBe([
      "Primary SS = ss",
      "ss.example.com",
      "8388",
      "password=p",
      "encrypt-method=chacha20-ietf-poly1305",
      "obfs=tls",
      "obfs-host=bing.com",
      "obfs-uri=/"
    ].join(", "));

    const [alpnNode] = parseSubscription([
      "proxies:",
      "  - name: TR 1",
      "    type: trojan",
      "    server: tr.example.com",
      "    port: 443",
      "    password: p",
      "    alpn: h2,http/1.1"
    ].join("\n"), "src");
    expect(toClashProxy(alpnNode!)).toMatchObject({
      alpn: ["h2", "http/1.1"]
    });

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

  it("repairs common boolean parameter typos from upstream proxy inputs", () => {
    const [uriNode] = parseSubscription("trojan://pass@tr.example.com:443?skip-cert-verify=tue&tfo=tue&allowInsecure=ture&udpOverTcp=fasle#TR", "src");
    expect(toClashProxy(uriNode!)).toMatchObject({
      "skip-cert-verify": true,
      tfo: true,
      allowInsecure: true,
      udpOverTcp: false
    });
    expect(toSurgeLine({ ...uriNode!, name: "TR" })).toBe(
      "TR = trojan, tr.example.com, 443, password=pass, skip-cert-verify=true, tfo=true, allowInsecure=true, udpOverTcp=false"
    );

    const [surgeNode] = parseSubscription("TR = trojan,tr.example.com,443,password=p,skip-cert-verify=tue,udp-relay=tue,ws=tue,vmess-aead=ture,mptcp=flase,reduce-rtt=treu,prefer-h3=yes", "src");
    expect(toClashProxy(surgeNode!)).toMatchObject({
      "skip-cert-verify": true,
      udp: true,
      network: "ws",
      "vmess-aead": true,
      mptcp: false,
      "reduce-rtt": true,
      "prefer-h3": true
    });
    expect(toSurgeLine({ ...surgeNode!, name: "TR" })).toBe(
      "TR = trojan, tr.example.com, 443, password=p, skip-cert-verify=true, udp-relay=true, ws=true, vmess-aead=true, mptcp=false, reduce-rtt=true, prefer-h3=true"
    );

    const [embeddedUriNode] = parseSubscription("Embedded = trojan://pass@tr.example.com:443?skip-cert-verify=tue#TR", "src");
    expect(toSurgeLine({ ...embeddedUriNode!, name: "Embedded" })).toBe(
      "Embedded = trojan, tr.example.com, 443, password=pass, skip-cert-verify=true"
    );

    const [yamlNode] = parseSubscription([
      "proxies:",
      "  - name: TR",
      "    type: trojan",
      "    server: tr.example.com",
      "    port: 443",
      "    password: p",
      "    skip-cert-verify: tue",
      "    udp: tue"
    ].join("\n"), "src");
    expect(toClashProxy(yamlNode!)).toMatchObject({
      "skip-cert-verify": true,
      udp: true
    });
    expect(toSurgeLine({ ...yamlNode!, name: "TR" })).toBe(
      "TR = trojan, tr.example.com, 443, password=p, skip-cert-verify=true, udp-relay=true"
    );

    const [pluginNode] = parseSubscription([
      "proxies:",
      "  - name: SS",
      "    type: ss",
      "    server: ss.example.com",
      "    port: 8388",
      "    cipher: chacha20-ietf-poly1305",
      "    password: p",
      "    plugin: v2ray-plugin",
      "    plugin-opts:",
      "      mode: websocket",
      "      tls: ture"
    ].join("\n"), "src");
    expect(toSurgeLine({ ...pluginNode!, name: "SS" })).toBe(
      "SS = ss, ss.example.com, 8388, password=p, encrypt-method=chacha20-ietf-poly1305, ws=true, tls=true"
    );

    const [headerNode] = parseSubscription([
      "proxies:",
      "  - name: Header",
      "    type: trojan",
      "    server: tr.example.com",
      "    port: 443",
      "    password: p",
      "    network: ws",
      "    ws-opts:",
      "      headers:",
      "        Enabled: ture"
    ].join("\n"), "src");
    const headerProxy = toClashProxy(headerNode!);
    expect((headerProxy["ws-opts"] as { headers: Record<string, unknown> }).headers.Enabled).toBe("ture");

    const [unknownValueNode] = parseSubscription("Unknown = trojan,tr.example.com,443,password=p,enabled=maybe", "src");
    expect(toClashProxy(unknownValueNode!)).toMatchObject({ enabled: "maybe" });
    expect(toSurgeLine({ ...unknownValueNode!, name: "Unknown" })).toBe(
      "Unknown = trojan,tr.example.com,443,password=p,enabled=maybe"
    );
  });
});
