// Native Tailscale forms. Optional sing-box fields stay omitted until edited.
const surgeFields = [
  ["identity", "name", "策略名称", "Policy name", "text"],
  ["identity", "sectionName", "配置段名称", "Section name", "text"],
  ["identity", "enabled", "启用节点", "Enable node", "boolean"],
  ["identity", "interactiveLogin", "在 Surge 客户端交互登录", "Sign in interactively in Surge", "boolean"],
  ["identity", "authKey", "认证密钥", "Auth key", "password"],
  ["identity", "controlUrl", "控制服务器地址", "Control server URL", "text"],
  ["identity", "hostname", "设备主机名", "Hostname", "text"],
  ["routing", "autoAddMagicDnsRule", "自动添加 MagicDNS 与对端地址规则", "Automatically route MagicDNS and peer addresses", "boolean"],
  ["routing", "exitNode", "出口节点（none 表示不指定）", "Exit node (none for no exit)", "text"],
  ["routing", "underlyingProxy", "前置代理", "Upstream proxy", "policy"],
  ["routing", "dnsServer", "DNS 服务器", "DNS servers", "list"],
  ["routing", "preferIpv6", "优先使用 IPv6", "Prefer IPv6", "boolean"],
  ["connection", "derpOnly", "仅通过 DERP 中继", "Use DERP relay only", "boolean"],
  ["connection", "idleKeepalive", "空闲保活（秒；0 / -1 为常驻）", "Idle keepalive (seconds; 0 / -1 for always on)", "number", [-1, 86400]],
  ["connection", "mtu", "MTU", "MTU", "number", [576, 1420]],
  ["connection", "testUrl", "测速地址（HTTP / HTTPS）", "Test URL (HTTP / HTTPS)", "text"],
  ["connection", "testTimeout", "测速超时（秒）", "Test timeout (seconds)", "number", [1, 60]]
];
const singboxFields = [
  ["connection", "on_demand", "允许按需断开", "Allow on-demand disconnection", "boolean"],
  ["identity", "tag", "端点名称", "Endpoint tag", "text"],
  ["identity", "auth_key", "认证密钥（可留空交互登录）", "Auth key (optional for interactive login)", "password"],
  ["identity", "control_url", "控制服务器地址", "Control server URL", "text"],
  ["identity", "hostname", "设备主机名", "Hostname", "text"],
  ["identity", "state_directory", "状态存储目录", "State directory", "text"],
  ["identity", "ephemeral", "临时节点", "Ephemeral node", "boolean"],
  ["routing", "accept_routes", "接受其他节点发布的路由", "Accept advertised routes", "boolean"],
  ["routing", "exit_node", "使用的出口节点", "Exit node to use", "text"],
  ["routing", "exit_node_allow_lan_access", "使用出口时允许访问本地局域网", "Allow LAN access with exit node", "boolean"],
  ["routing", "advertise_routes", "发布的子网路由（CIDR）", "Advertised subnet routes (CIDR)", "list"],
  ["routing", "advertise_exit_node", "将本节点发布为出口", "Advertise as exit node", "boolean"],
  ["routing", "advertise_tags", "发布的 ACL 标签", "Advertised ACL tags", "list"],
  ["routing", "detour", "前置出站", "Upstream outbound", "policy"],
  ["interface", "listen_port", "监听端口", "Listen port", "number", [0, 65535]],
  ["interface", "relay_server_port", "对等中继端口", "Peer relay port", "number", [0, 65535]],
  ["interface", "relay_server_static_endpoints", "中继静态地址（IP:端口）", "Relay static endpoints (IP:port)", "list"],
  ["interface", "system_interface", "创建系统网络接口", "Create system interface", "boolean"],
  ["interface", "system_interface_name", "系统接口名称", "System interface name", "text"],
  ["interface", "system_interface_mtu", "系统接口 MTU", "System interface MTU", "number", [0, 4294967295]],
  ["interface", "udp_timeout", "UDP 超时（例如 5m）", "UDP timeout (for example 5m)", "udp-duration"],
  ["services", "ssh_server", "SSH 服务", "SSH server", "ssh"],
  ["services", "ssh_server.enabled", "启用 SSH", "Enable SSH", "boolean"],
  ["services", "ssh_server.disable_pty", "禁用 SSH 终端", "Disable SSH PTY", "boolean"],
  ["services", "ssh_server.disable_sftp", "禁用 SFTP", "Disable SFTP", "boolean"],
  ["services", "ssh_server.disable_forwarding", "禁用 SSH 转发", "Disable SSH forwarding", "boolean"],
  ["services", "taildrop_directory", "Taildrop 接收目录", "Taildrop receive directory", "text"],
  ["connection", "bind_interface", "绑定网络接口", "Bind interface", "text"],
  ["connection", "inet4_bind_address", "绑定 IPv4 地址", "Bind IPv4 address", "text"],
  ["connection", "inet6_bind_address", "绑定 IPv6 地址", "Bind IPv6 address", "text"],
  ["connection", "bind_address_no_port", "绑定地址时不占用端口", "Bind address without reserving a port", "boolean"],
  ["connection", "protect_path", "Android VPN 保护套接字路径", "Android VPN protect socket path", "text"],
  ["connection", "routing_mark", "路由标记", "Routing mark", "text"],
  ["connection", "reuse_addr", "复用地址", "Reuse address", "boolean"],
  ["connection", "netns", "网络命名空间", "Network namespace", "text"],
  ["connection", "connect_timeout", "连接超时（例如 10s）", "Connect timeout (for example 10s)", "duration"],
  ["connection", "tcp_fast_open", "TCP Fast Open", "TCP Fast Open", "boolean"],
  ["connection", "tcp_multi_path", "多路径 TCP", "Multipath TCP", "boolean"],
  ["connection", "disable_tcp_keep_alive", "禁用 TCP 保活", "Disable TCP keepalive", "boolean"],
  ["connection", "tcp_keep_alive", "TCP 保活空闲时间", "TCP keepalive idle time", "duration"],
  ["connection", "tcp_keep_alive_interval", "TCP 保活间隔", "TCP keepalive interval", "duration"],
  ["connection", "udp_fragment", "允许 UDP 分片", "Allow UDP fragmentation", "boolean"],
  ["connection", "network_strategy", "网络选择策略", "Network strategy", "select", ["default", "fallback", "hybrid"]],
  ["connection", "network_type", "首选网络类型", "Preferred network types", "networks"],
  ["connection", "fallback_network_type", "后备网络类型", "Fallback network types", "networks"],
  ["connection", "fallback_delay", "后备网络延迟", "Fallback delay", "duration"],
  ["dns", "domain_resolver", "域名解析方式", "Domain resolver mode", "resolver"],
  ["dns", "domain_resolver.server", "DNS 服务器名称", "DNS server tag", "text"],
  ["dns", "domain_resolver.timeout", "解析超时", "Resolution timeout", "duration"],
  ["dns", "domain_resolver.strategy", "解析地址偏好", "Resolution strategy", "select", ["as_is", "prefer_ipv4", "prefer_ipv6", "ipv4_only", "ipv6_only"]],
  ["dns", "domain_resolver.disable_cache", "禁用 DNS 缓存", "Disable DNS cache", "boolean"],
  ["dns", "domain_resolver.disable_optimistic_cache", "禁用乐观 DNS 缓存", "Disable optimistic DNS cache", "boolean"],
  ["dns", "domain_resolver.rewrite_ttl", "重写 DNS TTL（秒）", "Rewrite DNS TTL (seconds)", "number", [0, 4294967295]],
  ["dns", "domain_resolver.client_subnet", "EDNS 客户端子网", "EDNS client subnet", "text"]
];
const groups = [
  ["identity", "身份与登录", "Identity and login"], ["routing", "路由与出口", "Routing and exit node"],
  ["interface", "接口与中继", "Interfaces and relay"], ["services", "SSH 与文件接收", "SSH and file transfers"],
  ["dns", "域名解析", "Domain resolution"], ["connection", "连接设置", "Connection settings"]
];
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const get = (node, key) => key.split(".").reduce((value, part) => value?.[part], node);
const fields = (client) => client === "surge" ? surgeFields : singboxFields;
function displayed(node, key, type) {
  const value = get(node, key) ?? (key === "autoAddMagicDnsRule" ? true : key === "interactiveLogin" ? false : undefined);
  if (type === "ssh") return object(value) ? "custom" : value === undefined ? "" : String(value);
  if (type === "resolver") return object(value) ? "custom" : value ? "server" : "";
  if (key === "domain_resolver.server" && typeof node.domain_resolver === "string") return node.domain_resolver;
  if (["list", "networks"].includes(type)) return Array.isArray(value) ? value.join("\n") : String(value ?? "");
  return value === undefined ? "" : String(value);
}
export function newTailscaleNode(client) {
  return client === "surge" ? { name: "", sectionName: "", enabled: true, interactiveLogin: false, autoAddMagicDnsRule: true, authKey: "", controlUrl: "", hostname: "", derpOnly: false, exitNode: "none", idleKeepalive: 600, preferIpv6: false, dnsServer: [], mtu: 1280, underlyingProxy: "", testUrl: "", testTimeout: 5 } : { type: "tailscale", tag: "" };
}
export function tailscaleForm(client, node, policies, t, esc) {
  const select = (key, values, value) => `<select id="ts-${key}" data-ts-field="${key}">${values.map(([v, label]) => `<option value="${esc(v)}" ${v === value ? "selected" : ""}>${esc(label)}</option>`).join("")}</select>`;
  return groups.map(([group, zh, en]) => {
    const definitions = fields(client).filter(([g]) => g === group);
    if (!definitions.length) return "";
    const body = definitions.map(([, key, zh, en, type, choices]) => {
      const value = displayed(node, key, type), common = `id="ts-${key}" data-ts-field="${key}"`;
      const automatic = ["", t("使用默认值", "Use default")];
      let control;
      if (type === "boolean") control = client === "surge" ? `<input type="checkbox" class="toggle" ${common} ${value === "true" ? "checked" : ""}>` : select(key, [automatic, ["true", t("启用", "Enabled")], ["false", t("关闭", "Disabled")]], value);
      else if (type === "ssh") control = select(key, [automatic, ["true", t("启用", "Enabled")], ["false", t("关闭", "Disabled")], ["custom", t("自定义权限", "Custom permissions")]], value);
      else if (type === "resolver") control = select(key, [automatic, ["server", t("指定服务器", "Choose server")], ["custom", t("服务器与解析选项", "Server and resolver options")]], value);
      else if (type === "select") control = select(key, [automatic, ...[...new Set([...choices, value].filter(Boolean))].map((v) => [v, v])], value);
      else if (type === "networks") {
        const selected = value.split("\n").filter(Boolean);
        control = `<div class="ts-networks">${["wifi", "cellular", "ethernet", "other"].map((network) => `<label><input type="checkbox" data-ts-network="${key}" value="${network}" ${selected.includes(network) ? "checked" : ""}>${network}</label>`).join("")}</div>`;
      } else if (type === "list") control = `<textarea ${common} rows="3" spellcheck="false">${esc(value)}</textarea><p class="help">${t("每行一项", "One item per line")}</p>`;
      else if (type === "policy") control = `<input ${common} value="${esc(value)}" list="ts-policies" autocomplete="off">`;
      else control = `<input ${common} type="${type === "number" ? "number" : type === "password" ? "password" : "text"}" ${type === "number" ? `min="${choices[0]}" max="${choices[1]}" step="1"` : ""} value="${esc(value)}" autocomplete="${type === "password" ? "new-password" : "off"}" spellcheck="false">`;
      return `<div class="form-row" data-ts-row="${key}"><label for="ts-${key}">${esc(t(zh, en))}</label><div class="field">${control}</div></div>`;
    }).join("");
    return group === "identity" ? body : `<details class="ts-field-group"><summary>${esc(t(zh, en))}</summary>${body}</details>`;
  }).join("") + (client === "surge" ? `<p class="help">${t("交互登录需在 Surge 策略编辑器中完成，身份保存在当前设备；更改配置段名称可能需要重新登录。自动规则覆盖 MagicDNS 和对端地址，子网和出口流量仍需显式规则。", "Complete interactive sign-in in the Surge policy editor. Identity stays on that device; renaming the section may require signing in again. Automatic rules cover MagicDNS and peer addresses; subnets and exit traffic still need explicit rules.")}</p>` : "") + `<datalist id="ts-policies">${policies.map((policy) => `<option value="${esc(policy)}"></option>`).join("")}</datalist>`;
}
export function updateTailscaleForm(root) {
  const ssh = root.querySelector('[data-ts-field="ssh_server"]')?.value;
  const resolver = root.querySelector('[data-ts-field="domain_resolver"]')?.value;
  for (const row of root.querySelectorAll("[data-ts-row]")) {
    const key = row.dataset.tsRow;
    if (key === "authKey") row.hidden = root.querySelector('[data-ts-field="interactiveLogin"]')?.checked === true;
    if (key.startsWith("ssh_server.")) row.hidden = ssh !== "custom";
    if (key.startsWith("domain_resolver.")) row.hidden = resolver !== "custom" && !(resolver === "server" && key === "domain_resolver.server");
  }
}
export function readTailscaleForm(client, original, root, t) {
  const result = structuredClone(original);
  const fail = (zh, en) => { throw Error(t(zh, en)); };
  const set = (key, value) => {
    const parts = key.split("."), last = parts.pop();
    let parent = result;
    for (const part of parts) { if (!object(parent[part])) parent[part] = {}; parent = parent[part]; }
    if (value === undefined) delete parent[last]; else parent[last] = value;
  };
  for (const [, key, zh, en, type, bounds] of fields(client)) {
    if (root.querySelector(`[data-ts-row="${key}"]`)?.hidden) continue;
    const input = root.querySelector(`[data-ts-field="${key}"]`);
    let raw = type === "networks" ? [...root.querySelectorAll(`[data-ts-network="${key}"]:checked`)].map((element) => element.value).join("\n") : input.type === "checkbox" ? String(input.checked) : input.value;
    const initial = displayed(original, key, type);
    if (raw === initial || (type === "networks" && raw.split("\n").sort().join("\n") === initial.split("\n").sort().join("\n"))) continue;
    raw = raw.trim();
    if (type === "ssh") { set(key, raw === "custom" ? {} : raw === "" ? undefined : raw === "true"); continue; }
    if (type === "resolver") { set(key, raw === "" ? undefined : {}); continue; }
    if (raw === "" && client === "singbox") { set(key, undefined); continue; }
    let value = raw;
    if (type === "boolean") value = raw === "true";
    if (["list", "networks"].includes(type)) value = raw.split("\n").map((line) => line.trim()).filter(Boolean);
    if (type === "number") {
      value = Number(raw);
      if (!raw || !Number.isInteger(value) || value < bounds[0] || value > bounds[1]) fail(`${zh}需要 ${bounds[0]}–${bounds[1]} 的整数`, `${en} requires an integer from ${bounds[0]} to ${bounds[1]}`);
    }
    if (["duration", "udp-duration"].includes(type)) {
      if (type === "udp-duration" && /^\d+$/.test(raw)) value = Number(raw);
      else if (!/^[-+]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:ns|us|µs|μs|ms|s|m|h|d))+$/.test(raw) && raw !== "0") fail(`${zh}格式无效，例如 10s 或 5m`, `${en} requires a duration such as 10s or 5m`);
    }
    set(key, value);
  }
  if (client === "singbox") {
    const resolver = root.querySelector('[data-ts-field="domain_resolver"]')?.value;
    if (resolver) {
      const server = root.querySelector('[data-ts-field="domain_resolver.server"]').value.trim();
      if (!server) fail("请选择域名解析服务器", "Choose a domain resolver server");
      if (resolver === "server") result.domain_resolver = server;
      else { if (!object(result.domain_resolver)) result.domain_resolver = {}; result.domain_resolver.server = server; }
    }
    result.type = "tailscale";
    if (!result.tag?.trim()) fail("请填写端点名称", "Enter an endpoint tag");
  } else {
    if (!result.name.trim() || /[=,\r\n[\]]/.test(result.name)) fail("策略名称无效", "Invalid policy name");
    if (!result.sectionName.trim() || /[\s=,\r\n[\]]/.test(result.sectionName)) fail("配置段名称无效，不能包含空格", "Invalid section name; spaces are not allowed");
    if (result.interactiveLogin) result.authKey = "";
    if (result.enabled && !result.interactiveLogin && !result.authKey.trim()) fail("启用节点需要认证密钥", "An enabled node requires an auth key");
  }
  for (const key of client === "surge" ? ["controlUrl", "testUrl"] : ["control_url"]) {
    if (!result[key]) continue;
    try { const url = new URL(result[key]); if (!["https:", "http:"].includes(url.protocol)) throw Error(); }
    catch { fail("控制服务器或测速地址格式无效", "Invalid control server or test URL"); }
  }
  return result;
}
