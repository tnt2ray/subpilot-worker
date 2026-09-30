// Forms use the same pinned upstream schema as the Worker output validator.
// Values stay in a modal draft until the caller validates and applies them.
import { splitPolicyGroupSpec, parseAllSelector, parseGroupOption } from "./app-policy-group-spec.js";
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const kind = (value) => Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
const own = (value, key, item) => Object.defineProperty(value, key, { value: item, enumerable: true, writable: true, configurable: true });
const TITLES = {
  inbounds: ["入站与 TUN", "Inbounds & TUN"], dns: ["DNS 服务器与规则", "DNS servers & rules"],
  route: ["路由与规则集", "Routing & rule sets"], endpoints: ["VPN 端点", "VPN endpoints"],
  outbounds: ["本端原生出站", "Client native outbounds"], services: ["服务", "Services"],
  log: ["日志", "Logging"], experimental: ["缓存、API 与调试", "Cache, API & debugging"],
  ntp: ["时间同步", "Time synchronization"], certificate: ["证书信任", "Certificate trust"],
  certificate_providers: ["证书提供者", "Certificate providers"], http_clients: ["HTTP 客户端", "HTTP clients"],
  network_namespaces: ["网络命名空间（Linux）", "Network namespaces (Linux)"], $schema: ["配置 Schema 地址", "Configuration schema URL"]
};
const LABELS = {
  dns_server_address: "网络 DNS 地址匹配", dns_search_domain: "网络 DNS 搜索域匹配",
  on_demand: "允许按需断开", buffer_size: "写缓冲大小", flush_interval: "自动刷新间隔",
  multi_queue: "多队列（仅 Linux）", auto_redirect_tproxy_mark: "IPv6 TCP TPROXY 标记",
  server_public_key: "服务端公钥", server_disco_key: "服务端发现公钥", pre_shared_key: "预共享密钥",
  derp_map_url: "DERP 映射地址", derp_region: "DERP 区域", derp_servers: "自定义 DERP 服务器",
  verify_client_inbound: "验证客户端的 Tailcat 入站", verify_client_key: "允许的 Tailcat 公钥",
  type: "类型", tag: "名称", server: "服务器", server_port: "服务器端口", listen: "监听地址", listen_port: "监听端口",
  enabled: "启用", password: "密码", private_key: "私钥", public_key: "公钥", auth_key: "认证密钥", username: "用户名",
  tls: "TLS 加密", transport: "传输", multiplex: "多路复用", detour: "前置出站", domain_resolver: "域名解析器",
  address: "虚拟网卡地址", mtu: "MTU", auto_route: "自动路由", strict_route: "严格路由", auto_detect_interface: "自动检测接口",
  route_address: "包含路由", route_exclude_address: "排除路由", include_package: "包含应用包", exclude_package: "排除应用包",
  platform: "平台配置", http_proxy: "系统 HTTP 代理", rules: "规则", rule_set: "规则集", action: "动作", mode: "逻辑模式",
  domain: "完整域名", domain_suffix: "域名后缀", domain_keyword: "域名关键词", domain_regex: "域名正则",
  ip_cidr: "目标网段", source_ip_cidr: "来源网段", port: "目标端口", source_port: "来源端口", protocol: "协议",
  process_name: "进程名", process_path: "进程路径", package_name: "应用包名", wifi_ssid: "Wi-Fi 名称", invert: "反向匹配",
  final: "默认目标", outbound: "出站", outbounds: "出站成员", servers: "服务器列表", strategy: "解析策略",
  cache_capacity: "缓存容量", optimistic: "乐观 DNS 缓存", timeout: "超时", reverse_mapping: "反向映射", sniffer: "嗅探协议",
  server_name: "TLS 服务器名", insecure: "跳过证书验证", certificate_path: "证书路径", certificate: "证书内容",
  peers: "对端", allowed_ips: "允许网段", endpoint: "关联端点", bind_interface: "绑定接口", interface_name: "接口名称",
  default: "默认成员", interrupt_exist_connections: "切换时中断连接", idle_timeout: "空闲超时", interval: "间隔", tolerance: "延迟容差",
  url: "地址", path: "路径", format: "格式", update_interval: "更新间隔", headers: "请求头", http_client: "HTTP 客户端",
  default_http_client: "默认 HTTP 客户端", default_domain_resolver: "建立连接时的默认 DNS", find_process: "查找进程", find_neighbor: "查找邻居",
  netns: "网络命名空间", cache_file: "缓存文件", clash_api: "Clash API", v2ray_api: "V2Ray API", debug: "调试",
  level: "日志级别", timestamp: "时间戳", output: "输出路径", disabled: "禁用", store: "信任库", secret: "密钥",
  dns_mode: "DNS 处理方式", dns_address: "DNS 地址", auto_redirect: "自动重定向", loopback_address: "回环地址", udp_timeout: "UDP 超时",
  include_interface: "包含接口", exclude_interface: "排除接口", route_address_set: "包含路由规则集", route_exclude_address_set: "排除路由规则集",
  disable_cache: "禁用缓存", disable_expire: "缓存不过期", client_subnet: "客户端子网", rewrite_ttl: "重写 TTL", predefined: "预设记录",
  inet4_range: "IPv4 地址段", inet6_range: "IPv6 地址段", query_type: "查询类型", ip_is_private: "目标为私有地址", source_ip_is_private: "来源为私有地址",
  ip_version: "IP 版本", network: "网络协议", inbound: "入站", port_range: "目标端口范围", source_port_range: "来源端口范围", clash_mode: "Clash 模式",
  method: "方式", override_address: "覆盖目标地址", override_port: "覆盖目标端口", default_interface: "默认出口网卡", default_mark: "默认路由标记",
  default_network_strategy: "默认网络策略", override_android_vpn: "覆盖 Android VPN", path: "路径", cache_id: "缓存标识", store_fakeip: "保存 FakeIP", store_dns: "保存 DNS 缓存",
  external_controller: "控制器监听地址", external_ui: "面板目录", default_mode: "默认模式", users: "用户", system: "使用系统接口", name: "接口名称",
  persistent_keepalive_interval: "保活间隔", reserved: "保留字节", engine: "引擎", version: "版本", state_directory: "状态目录", hostname: "主机名"
};
export const singboxSections = {
  network: ["inbounds"], dns: ["dns"], rules: ["route"],
  endpoints: ["endpoints"],
  advanced: ["log", "http_clients", "outbounds", "experimental", "services"]
};
export const singboxTitle = (key, t) => TITLES[key] ? t(...TITLES[key]) : key;
export const singboxLabel = (key, t) => t(LABELS[key] || TITLES[key]?.[0] || String(key), TITLES[key]?.[1] || String(key).replaceAll("_", " "));
// Settings a new entry of this type cannot work without; values only the user knows stay empty.
const PRESETS = {
  inbounds: {
    tun: { address: ["172.19.0.1/30", "fdfe:dcba:9876::1/126"], auto_route: true, strict_route: true },
    mixed: { listen: "127.0.0.1", listen_port: "" }, http: { listen: "127.0.0.1", listen_port: "" }, socks: { listen: "127.0.0.1", listen_port: "" }
  },
  endpoints: { wireguard: { address: [""], private_key: "", peers: [{ address: "", port: "", public_key: "", allowed_ips: [""] }] } }
};
const DNS_ACTIONS = {
  route: ["使用指定服务器", "Use DNS server"], evaluate: ["查询并继续匹配", "Query and continue matching"], respond: ["返回已查询的响应", "Return the evaluated response"],
  "route-options": ["调整查询参数", "Set query options"], reject: ["拒绝查询", "Reject query"], predefined: ["返回预设响应", "Return a predefined response"]
};

export function createSingboxGroupForm(root, spec, choices, { t, esc }) {
  const [type, ...parts] = splitPolicyGroupSpec(spec);
  const options = {};
  const members = [];
  for (const part of parts) {
    const all = parseAllSelector(part), option = parseGroupOption(part);
    if (all) members.push({ mode: "all", filter: all.filter, exclude: all.exclude, name: "" });
    else if (option) own(options, option.key, option.value);
    else members.push({ mode: "name", name: part, filter: "", exclude: "" });
  }
  const fields = ["default", "url", "interval", "tolerance", "idle_timeout", "interrupt_exist_connections"];
  root.innerHTML = `<label class="sb-variant">${t("组类型", "Group type")}<select data-sbg-type>${[...new Set(["select", "url-test", type])].map((value) => `<option ${value === type ? "selected" : ""}>${esc(value)}</option>`).join("")}</select></label><div data-sbg-members></div><button type="button" data-sbg-add>${t("添加成员", "Add member")}</button><datalist id="sb-group-policies">${choices.map((name) => `<option value="${esc(name)}"></option>`).join("")}</datalist>${fields.map((key) => `<label class="sb-variant" data-sbg-option-row="${key}">${esc(t(LABELS[key] || key, key))}${key === "interval" ? ` (${t("秒", "seconds")})` : ""}${key === "interrupt_exist_connections" ? `<select data-sbg-option="${key}">${["", "true", "false"].map((value) => `<option value="${value}" ${options[key] === value ? "selected" : ""}>${value || t("使用默认值", "Use default")}</option>`).join("")}</select>` : `<input data-sbg-option="${key}" type="${["interval", "tolerance"].includes(key) ? "number" : "text"}" ${["interval", "tolerance"].includes(key) ? 'min="0" step="1"' : ""} value="${esc(options[key] || "")}" ${key === "default" ? 'list="sb-group-policies"' : ""}>`}</label>`).join("")}<p class="help">${t("成员顺序会保留。筛选关键词用英文逗号分隔；空闲超时填写带单位的时长，例如 30m。", "Member order is preserved. Separate filter keywords with commas; use a duration such as 30m for idle timeout.")}</p>`;
  function syncMembers() {
    for (const input of root.querySelectorAll("[data-sbg-member-field]")) members[Number(input.dataset.index)][input.dataset.sbgMemberField] = input.value;
  }
  function renderMembers() {
    root.querySelector("[data-sbg-members]").innerHTML = members.map((member, index) => `<div class="sb-item"><div class="sb-add"><select data-sbg-member-field="mode" data-index="${index}" aria-label="${t("成员来源", "Member source")}"><option value="name" ${member.mode === "name" ? "selected" : ""}>${t("指定节点或策略", "Named node or policy")}</option><option value="all" ${member.mode === "all" ? "selected" : ""}>${t("共享节点筛选", "Filter shared nodes")}</option></select><button type="button" data-sbg-remove="${index}">${t("移除", "Remove")}</button><button type="button" data-sbg-up="${index}" ${index === 0 ? "disabled" : ""}>${t("上移", "Move up")}</button></div>${member.mode === "name" ? `<label>${t("节点 / 策略名称", "Node / policy name")}<input data-sbg-member-field="name" data-index="${index}" value="${esc(member.name)}" list="sb-group-policies"></label>` : ["filter", "exclude"].map((key) => `<label class="sb-variant">${key === "filter" ? t("包含关键词", "Include keywords") : t("排除关键词", "Exclude keywords")}<input data-sbg-member-field="${key}" data-index="${index}" value="${esc(member[key])}"></label>`).join("")}</div>`).join("");
  }
  function updateType() {
    const select = root.querySelector("[data-sbg-type]").value === "select";
    for (const row of root.querySelectorAll("[data-sbg-option-row]")) row.hidden = row.dataset.sbgOptionRow === "default" ? !select : row.dataset.sbgOptionRow !== "interrupt_exist_connections" && select;
  }
  root.addEventListener("change", (event) => {
    if (event.target.hasAttribute("data-sbg-type")) updateType();
    if (event.target.dataset.sbgMemberField === "mode") { syncMembers(); renderMembers(); }
  });
  root.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    syncMembers();
    if (button.hasAttribute("data-sbg-add")) members.push({ mode: "name", name: "", filter: "", exclude: "" });
    else if (button.hasAttribute("data-sbg-remove")) members.splice(Number(button.dataset.sbgRemove), 1);
    else if (button.hasAttribute("data-sbg-up")) { const index = Number(button.dataset.sbgUp); [members[index - 1], members[index]] = [members[index], members[index - 1]]; }
    else return;
    renderMembers();
  });
  renderMembers(); updateType();
  return { read() {
    syncMembers();
    const type = root.querySelector("[data-sbg-type]").value;
    const parts = members.map((member) => {
      if (member.mode === "name") {
        if (!member.name.trim() || /[,={}\r\n]/.test(member.name)) throw Error(t("请输入有效成员名称", "Enter a valid member name"));
        return member.name.trim();
      }
      if (/[{}\r\n]/.test(member.filter + member.exclude) || /\s+exclude=/.test(member.filter)) throw Error(t("筛选条件不能包含花括号或换行", "Filters cannot contain braces or newlines"));
      return `{all${member.filter.trim() ? ` filter=${member.filter.trim()}` : ""}${member.exclude.trim() ? ` exclude=${member.exclude.trim()}` : ""}}`;
    });
    for (const input of root.querySelectorAll("[data-sbg-option]")) {
      const key = input.dataset.sbgOption;
      if (input.closest("[data-sbg-option-row]").hidden) { delete options[key]; continue; }
      if (!input.checkValidity()) throw Error(`${key}: ${t("数值无效", "Invalid number")}`);
      if (input.value.trim()) {
        if (/[,\r\n]/.test(input.value)) throw Error(`${key}: ${t("不能包含逗号或换行", "Commas and newlines are not allowed")}`);
        options[key] = input.value.trim();
      } else delete options[key];
    }
    return [type, ...parts, ...Object.entries(options).map(([key, value]) => `${key}=${value}`)].join(", ");
  } };
}

export function createSingboxForm(root, schema, section, original, { t, esc, references = {}, referenceTypes = {}, singleItem = false, endpointType, rootRule }) {
  let draft = structuredClone(original);
  const variantsCache = new WeakMap();
  const selections = new Map();
  const expanded = new Set(["[]"]);
  // Nested settings and sole list entries start open; after that the user's toggling decides.
  const seen = new Set();
  const openOnce = (key) => { if (!seen.has(key)) { seen.add(key); expanded.add(key); } };
  let controls = [];
  const title = (key) => singboxLabel(key, t);
  // Repeat the raw key only when the title is a translation of it.
  const labelHtml = (text, key) => text.replaceAll(" ", "_") === String(key) ? esc(text) : `${esc(text)} <code>${esc(key)}</code>`;
  const deref = (node) => node?.$ref ? { ...schema.$defs[node.$ref.split("/").at(-1)], ...Object.fromEntries(Object.entries(node).filter(([key]) => key !== "$ref")) } : node || {};
  const merge = (a, b) => ({ ...a, ...b, properties: { ...a.properties, ...b.properties }, required: [...new Set([...(a.required || []), ...(b.required || [])])] });
  function variants(raw) {
    if (variantsCache.has(raw)) return variantsCache.get(raw);
    const node = deref(raw);
    const { oneOf, anyOf, allOf, ...base } = node;
    let result = [base];
    if (oneOf || anyOf) result = (oneOf || anyOf).flatMap((branch) => variants(branch).map((item) => merge(base, item)));
    if (allOf) for (const branch of allOf) result = result.flatMap((item) => variants(branch).map((part) => merge(item, part)));
    variantsCache.set(raw, result);
    return result;
  }
  function score(node, value) {
    if (value === undefined) return 0;
    if (Object.hasOwn(node, "const")) return node.const === value ? 30 : -1000;
    if (node.enum && !node.enum.includes(value)) return -1000;
    if (node.type && node.type !== kind(value) && !(node.type === "integer" && Number.isInteger(value))) return -1000;
    let result = 1;
    if (object(value)) for (const [key, child] of Object.entries(node.properties || {})) {
      if (Object.hasOwn(value, key)) result += Math.max(...variants(child).map((item) => score(item, value[key])));
    }
    return result;
  }
  function active(raw, value, path) {
    const list = variants(raw);
    let candidates = list.map((node, index) => ({ node, index }));
    if (object(value) && list.length > 1) {
      const discriminators = new Set(list.flatMap((node) => Object.entries(node.properties || {}).filter(([key, child]) => {
        const field = deref(child);
        return Object.hasOwn(field, "const") || ["type", "action", "provider"].includes(key) && field.enum;
      }).map(([key]) => key)));
      const compatible = candidates.filter(({ node }) => [...discriminators].every((key) => {
        if (!Object.hasOwn(value, key)) return !node.required?.includes(key);
        const child = node.properties?.[key];
        return child && Math.max(...variants(child).map((part) => score(part, value[key]))) >= 0;
      }));
      // Incomplete fields must not outweigh an explicitly selected type/action.
      if (compatible.length) candidates = compatible;
    }
    const best = candidates.reduce((best, item) => score(item.node, value) > score(best.node, value) ? item : best).index;
    const selected = selections.get(JSON.stringify(path)) ?? best;
    return { list, selected, node: list[selected] || list[0] };
  }
  function seed(node) {
    if (Object.hasOwn(node, "const")) return structuredClone(node.const);
    // A schema's first enum value (or numeric minimum) is not a default.
    if (node.enum) return node.enum.length === 1 ? node.enum[0] : "";
    if (node.type === "object" || Object.keys(node.properties || {}).length) {
      const result = {};
      const fixed = Object.keys(node.properties || {}).filter((key) => Object.hasOwn(deref(node.properties[key]), "const"));
      for (const key of new Set([...(node.required || []), ...fixed])) {
        if (node.properties?.[key]) own(result, key, seed(variants(node.properties[key])[0]));
      }
      // Keep common connection fields visible when creating a typed entry.
      // Optional ports stay absent so each protocol can use its own default.
      if (result.type) for (const key of ["tag", "server", "outbounds"]) {
        if (node.properties?.[key] && !Object.hasOwn(result, key)) own(result, key, seed(variants(node.properties[key])[0]));
      }
      for (const [key, item] of Object.entries(PRESETS[section]?.[result.type] || {})) {
        if (node.properties?.[key] && !Object.hasOwn(result, key)) own(result, key, structuredClone(item));
      }
      // The core requires a destination for route actions, even though the
      // upstream schema does not mark it required. Never guess an outbound.
      if (result.action === "route" && node.properties?.outbound) result.outbound = "";
      if (result.action === "route" && node.properties?.server) result.server = "";
      return result;
    }
    if (node.type === "array") return [];
    if (node.type === "boolean" || node.type === "integer" || node.type === "number") return "";
    if (node.type === "null") return null;
    return "";
  }
  function get(path) { return path.reduce((value, key) => value?.[key], draft); }
  function set(path, value) {
    if (!path.length) draft = value;
    else own(get(path.slice(0, -1)), path.at(-1), value);
  }
  function register(data) { controls.push(data); return controls.length - 1; }
  const button = (label, op, id, disabled = false, attrs = "") => `<button type="button" data-sb-op="${op}" data-sb-id="${id}" ${disabled ? "disabled" : ""} ${attrs}>${label}</button>`;
  function clientBranch(node, path) {
    if (path.length !== 1 || typeof path[0] !== "number") return true;
    const type = deref(node.properties?.type);
    const protocol = type.const ?? type.enum?.[0];
    if (!protocol) return true;
    if (section === "inbounds") return ["tun", "mixed", "http", "socks", "tailcat"].includes(protocol);
    if (section === "endpoints") return endpointType ? protocol === endpointType : ["wireguard", "tailscale", "openconnect", "openvpn-client", "masque-client", "masque-server"].includes(protocol);
    return true;
  }
  function branchName(node, ruleKind) {
    const type = deref(node.properties?.type), action = deref(node.properties?.action);
    const typeName = type.const ?? type.enum?.[0], actionName = action.const ?? action.enum?.[0];
    if (actionName) return `${typeName === "logical" ? t("逻辑组合 · ", "Logical group · ") : ""}${actionTitle(actionName, ruleKind)}`;
    if (typeName) return typeName;
    const fixed = Object.entries(node.properties || {}).flatMap(([key, value]) => Object.hasOwn(deref(value), "const") ? [`${title(key)}: ${deref(value).const}`] : []);
    if (fixed.length) return fixed.join(" · ");
    return Object.hasOwn(node, "const") ? String(node.const) : t(({ object: "自定义设置", array: "多个值", string: "文本", integer: "整数", number: "数值", boolean: "开关", null: "不设置" })[node.type] || node.type || "自定义设置", ({ object: "Custom settings", array: "Multiple values", string: "Text", integer: "Integer", number: "Number", boolean: "On / off", null: "Unset" })[node.type] || node.type || "Custom settings");
  }
  function actionTitle(action, ruleKind) {
    const names = ruleKind === "dns" ? DNS_ACTIONS : { sniff: ["嗅探域名", "Sniff domains"], "hijack-dns": ["接管 DNS 查询", "Handle DNS queries"], route: ["使用指定出口", "Route to outbound"], "route-options": ["调整连接参数", "Set connection options"], direct: ["直接连接", "Connect directly"], reject: ["拒绝连接", "Reject"], resolve: ["解析域名", "Resolve domains"], bypass: ["绕过代理", "Bypass"] };
    return names[action] ? `${t(...names[action])} (${action})` : action;
  }
  // A scalar and a list of the same scalar share one editor. Keep the original
  // representation until the user explicitly adds another value.
  function scalarList(raw) {
    const list = variants(raw);
    if (list.length !== 2) return null;
    const scalar = list.find((item) => ["string", "integer", "number", "boolean"].includes(item.type));
    const array = list.find((item) => item.type === "array");
    if (!scalar || !array || !array.items) return null;
    const items = variants(array.items);
    return items.length === 1 && items[0].type === scalar.type && JSON.stringify(items[0].enum) === JSON.stringify(scalar.enum) ? { scalar, array } : null;
  }
  const ruleActions = { route: schema.$defs.RuleAction ? variants(schema.$defs.RuleAction) : [], dns: schema.$defs.DNSRuleAction ? variants(schema.$defs.DNSRuleAction) : [] };
  // Route rules live in the route section's list; a DNS rule is edited on its own as the form root.
  const ruleKindAt = (path) => section === "route" && path.length === 2 && path[0] === "rules" && typeof path[1] === "number" ? "route" : rootRule && !path.length ? rootRule : null;
  const actionKeysFor = (value, ruleKind) => new Set(Object.keys(ruleActions[ruleKind].find((item) => deref(item.properties?.action).const === (value.action || "route"))?.properties || {}));
  const targetKey = (ruleKind) => ruleKind === "dns" ? "server" : "outbound";
  const isRouteRule = (path) => ruleKindAt(path) === "route";
  const isRouteRuleList = (path) => section === "route" && path.length === 1 && path[0] === "rules";
  const isDnsHijackPreset = (value) => object(value) && value.action === "hijack-dns"
    && (value.type === undefined || value.type === "" || value.type === "default") && JSON.stringify([].concat(value.protocol)) === '["dns"]'
    && Object.keys(value).every((key) => ["type", "action", "protocol"].includes(key));
  const matchKeys = (value, ruleKind) => { const actionKeys = actionKeysFor(value, ruleKind); return Object.keys(value).filter((key) => !["type", "action"].includes(key) && !actionKeys.has(key)); };
  function addFields(keys, path, node, label) {
    if (!keys.length) return "";
    const id = register({ path, node });
    return `<div class="sb-add"><select data-sb-property="${id}" aria-label="${esc(label)}"><option value="" selected disabled>${esc(label)}</option>${keys.map((key) => `<option value="${esc(key)}">${esc(title(key).replaceAll(" ", "_") === key ? key : `${title(key)} · ${key}`)}${node.required?.includes(key) ? " *" : ""}</option>`).join("")}</select>${button(t("添加", "Add"), "property", id)}</div>`;
  }
  // The upstream address patterns are far too long to show; describe the known formats.
  function formatHint(node) {
    if (!node.pattern) return "";
    const defs = schema.$defs;
    const known = node.pattern === defs.IPPrefix?.pattern ? ["填写 CIDR 网段，例如 172.19.0.1/30 或 fdfe:dcba:9876::1/126。", "Enter a CIDR prefix, for example 172.19.0.1/30 or fdfe:dcba:9876::1/126."]
      : node.pattern === defs.IPAddress?.pattern ? ["填写 IPv4 或 IPv6 地址，例如 127.0.0.1 或 ::1。", "Enter an IPv4 or IPv6 address, for example 127.0.0.1 or ::1."]
        : node.pattern === defs.IPAddressOrPrefix?.pattern ? ["填写 IPv4、IPv6 或 CIDR，例如 192.0.2.1、2001:db8::/32。", "Enter IPv4, IPv6 or CIDR, for example 192.0.2.1 or 2001:db8::/32."]
          : node.pattern === defs.Duration?.pattern ? ["填写带单位的时长，例如 30s、5m、1h。", "Enter a duration with a unit, for example 30s, 5m or 1h."] : null;
    if (known) return `<p class="help">${t(...known)}</p>`;
    return node.pattern.length <= 80 ? `<p class="help">${t("格式", "Format")}: <code>${esc(node.pattern)}</code></p>` : "";
  }
  function renderValue(raw, value, path, name) {
    const { list, selected, node } = active(raw, value, path);
    const multi = scalarList(raw);
    const id = register({ path, raw, node, multi });
    const data = `data-sb-id="${id}" aria-label="${esc(name)}"`;
    const hasVariant = list.length > 1 && !multi;
    const ruleKind = ruleKindAt(path);
    const typed = list.some((item) => item.properties?.action || item.properties?.type);
    const variantLabel = list.some((item) => item.properties?.action) ? t("规则动作", "Rule action") : list.some((item) => item.properties?.type) ? t("类型", "Type") : t("填写方式", "Value format");
    let html = hasVariant ? `<label class="${typed ? "sb-type" : "sb-variant"}"><span>${variantLabel}</span><select data-sb-variant data-sb-id="${id}" aria-label="${esc(variantLabel)}">${list.map((item, i) => !clientBranch(item, path) && i !== selected ? "" : `<option ${!clientBranch(item, path) ? "disabled" : ""} value="${i}" ${selected === i ? "selected" : ""}>${esc(branchName(item, ruleKind))}</option>`).join("")}</select></label>` : "";
    if (value === undefined) return html + button(t("配置此项", "Configure"), "create", id);
    const type = node.type || kind(value);
    if (singleItem && !path.length && type === "array") return renderValue(node.items || {}, value[0], [0], name);
    if (type === "object" && object(value)) {
      const props = node.properties || {};
      const actionKeys = ruleKind ? actionKeysFor(value, ruleKind) : new Set();
      const discriminator = (key) => hasVariant && ["type", "action"].includes(key) && (Object.hasOwn(deref(props[key]), "const") || deref(props[key]).enum?.length === 1);
      const leadingKeys = new Set(["type", "tag", "action", "address", "interface_name", "auto_route", "strict_route", "mtu", "listen", "listen_port", "server", "server_port", "outbound", "outbounds", "final", "servers", "rules"]);
      let leadingHtml = "", otherHtml = "";
      const needsTarget = ruleKind && (value.action || "route") === "route" && Object.hasOwn(props, targetKey(ruleKind));
      const fieldKeys = [...new Set([...Object.keys(value), ...(needsTarget ? [targetKey(ruleKind)] : [])])];
      for (const key of fieldKeys) {
        if (discriminator(key) && score(deref(props[key]), value[key]) >= 0) continue;
        const child = props[key] || (object(node.additionalProperties) ? node.additionalProperties : { type: kind(value[key]) });
        const childPath = [...path, key], pathKey = JSON.stringify(childPath);
        const childId = register({ path: childPath });
        const target = needsTarget && key === targetKey(ruleKind);
        const condition = ruleKind && !actionKeys.has(key) && !["type", "action"].includes(key);
        const fieldTitle = condition && ruleKind === "route" && key === "protocol" ? t("已识别协议", "Detected protocol") : title(key);
        const complex = value[key] !== null && typeof value[key] === "object";
        const ruleList = section === "route" && path.length === 0 && key === "rules";
        const inline = ruleKind || ruleList || scalarList(child) || Array.isArray(value[key]) && value[key].every((item) => item === null || typeof item !== "object");
        const collapsible = complex && !inline;
        if (collapsible) openOnce(pathKey);
        const body = collapsible && !expanded.has(pathKey) ? `<div data-sb-lazy="${register({ path: childPath, raw: child, name: fieldTitle })}"></div>` : renderValue(child, target ? value[key] ?? "" : value[key], childPath, fieldTitle);
        const required = node.required?.includes(key) || target;
        const removeLabel = condition ? t("移除条件", "Remove condition") : t("移除设置", "Remove setting");
        const remove = required || ruleList ? "" : `<div class="sb-remove">${button(t("移除", "Remove"), "remove", childId, false, `title="${removeLabel}" aria-label="${removeLabel}: ${esc(fieldTitle)}"`)}</div>`;
        const fieldHtml = `<div class="sb-field${ruleList ? " sb-rule-list" : ""}">${collapsible ? `<details data-sb-path="${esc(pathKey)}" ${expanded.has(pathKey) ? "open" : ""}><summary>${labelHtml(fieldTitle, key)}</summary><div class="sb-nested">${body}</div></details>` : `<label class="sb-label">${labelHtml(fieldTitle, key)}</label><div class="sb-control">${body}</div>`}${remove}</div>`;
        if (ruleKind ? !condition : leadingKeys.has(key) || required || node.propertyNames?.["x-tag-reference"]) leadingHtml += fieldHtml;
        else otherHtml += fieldHtml;
      }
      const missing = Object.keys(props).filter((key) => !fieldKeys.includes(key) && !discriminator(key));
      if (ruleKind) {
        const action = value.action || "route", dns = ruleKind === "dns";
        const note = action === "sniff" ? `<p class="help">${t("在分流前识别连接中的域名。通常无需设置匹配条件。", "Identify domains before routing. Matching conditions are usually unnecessary.")}</p>` : "";
        html += note + `<div class="sb-rule-section"><h3>${t("动作参数", "Action settings")}</h3><div class="sb-fields">${leadingHtml || `<p class="help">${t("此动作无需额外参数。", "No additional settings are needed.")}</p>`}</div>${addFields(missing.filter((key) => actionKeys.has(key)), path, node, t("添加动作参数", "Add action setting"))}</div>`;
        const warning = action === "sniff" && Object.hasOwn(value, "protocol") ? `<p class="notice warning">${t("“已识别协议”会限制哪些连接执行嗅探。常规域名嗅探请移除此条件；指定嗅探方式请在动作参数中添加“嗅探协议”。", "Detected protocol limits which connections are sniffed. Remove this condition for general domain sniffing; use Sniffer in action settings to choose sniffing methods.")}</p>` : "";
        const scope = matchKeys(value, ruleKind).length
          ? dns ? t("仅匹配这些条件的查询执行此动作。", "This action applies only to queries matching these conditions.") : t("仅匹配这些条件的连接执行此动作。", "This action applies only to connections matching these conditions.")
          : dns ? t("未设置条件：应用于所有查询。", "No conditions: applies to all queries.") : t("未设置条件：应用于所有连接。", "No conditions: applies to all connections.");
        html += `<div class="sb-rule-section"><h3>${t("匹配条件", "Match conditions")}</h3><p class="help">${scope}</p>${warning}<div class="sb-fields">${otherHtml}</div>${addFields(missing.filter((key) => !actionKeys.has(key)), path, node, t("添加匹配条件", "Add match condition"))}</div>`;
      } else {
        // Configured settings stay visible: hiding them behind a toggle also hid what was just added.
        if (leadingHtml || otherHtml) html += `<div class="sb-fields">${leadingHtml}${otherHtml}</div>`;
        html += addFields(missing, path, node, t("添加可选设置", "Add optional setting"));
      }
      if (node.additionalProperties !== false && (node.additionalProperties || !Object.keys(props).length)) {
        const keySchema = deref(node.propertyNames), reference = keySchema["x-tag-reference"];
        if (reference) {
          const choices = (references[reference] || []).filter((tag) => tag && !Object.hasOwn(value, tag) && (!keySchema["x-tag-types"] || keySchema["x-tag-types"].includes(referenceTypes[reference]?.[tag])));
          html += `<div class="sb-add"><select data-sb-key="${id}" aria-label="${esc(t("选择 DNS 服务器", "Choose DNS server"))}" ${choices.length ? "" : "disabled"}>${choices.length ? choices.map((tag) => `<option value="${esc(tag)}">${esc(tag)}</option>`).join("") : `<option value="">${t("没有可添加的 DNS 服务器", "No DNS servers available to add")}</option>`}</select>${button(t("添加条目", "Add entry"), "entry", id, !choices.length)}</div>`;
        } else html += `<div class="sb-add"><input data-sb-key="${id}" placeholder="${esc(t("键名，例如域名或请求头", "Key, e.g. domain or header"))}" aria-label="${esc(t("新键名", "New key"))}">${button(t("添加条目", "Add entry"), "entry", id)}</div>`;
      }
    } else if (type === "array" && Array.isArray(value)) {
      html += `<div class="sb-list">${value.map((item, index) => {
        const childPath = [...path, index], key = JSON.stringify(childPath);
        const childId = register({ path: childPath });
        if (item === null || typeof item !== "object") return `<div class="sb-scalar-item"><span class="sb-scalar-index">${index + 1}</span><div>${renderValue(node.items || {}, item, childPath, `${name} ${index + 1}`)}</div>${button("×", "remove", childId, false, `class="icon-button" title="${t("删除此值", "Delete this value")}" aria-label="${t("删除此值", "Delete this value")}"`)}</div>`;
        if (value.length === 1) openOnce(key);
        const rule = isRouteRule(childPath);
        const conditions = rule ? matchKeys(item, "route") : [];
        const summary = rule ? `${item.type === "logical" ? t("逻辑组合 · ", "Logical group · ") : ""}${actionTitle(item.action || "route")} · ${conditions.length ? conditions.map((key) => `${title(key)}${["protocol", "network"].includes(key) ? `: ${[].concat(item[key]).join(", ")}` : ""}`).join(" / ") : t("所有连接", "All connections")}` : object(item) ? [item.tag, item.type, item.action].filter(Boolean).join(" · ") : t("条目", "Item");
        const body = expanded.has(key) ? renderValue(node.items || {}, item, childPath, `${name} ${index + 1}`) : `<div data-sb-lazy="${register({ path: childPath, raw: node.items || {}, name: `${name} ${index + 1}` })}"></div>`;
        return `<details class="sb-item" data-sb-path="${esc(key)}" ${expanded.has(key) ? "open" : ""}><summary>${index + 1}. ${esc(summary || t("未命名条目", "Unnamed item"))}</summary><div class="sb-item-actions">${button(t("上移", "Move up"), "up", childId, index === 0)}${button(t("下移", "Move down"), "down", childId, index === value.length - 1)}${button(rule ? t("删除规则", "Delete rule") : t("删除条目", "Delete item"), "remove", childId)}</div>${body}</details>`;
      }).join("")}</div>`;
      if (value.length && value.every((item) => item === null || typeof item !== "object")) html += formatHint(variants(node.items || {})[0]);
      html += isRouteRuleList(path)
        ? `<div class="sb-add"><select data-sb-new-rule="${id}" aria-label="${t("选择新规则动作", "Choose new rule action")}"><option value="" selected disabled>${t("选择新规则动作", "Choose new rule action")}</option>${variants(node.items || {}).map((item, index) => `<option value="${index}">${esc(branchName(item, "route"))}</option>`).join("")}</select>${button(t("添加规则", "Add rule"), "append", id)}</div><p class="help">${t("通用域名嗅探添加 sniff，DNS 接管另加 hijack-dns。两者是独立规则，请将嗅探放在 DNS 接管和分流规则之前。", "Add sniff for general domain sniffing and a separate hijack-dns rule for DNS handling. Place sniffing before DNS handling and routing rules.")}</p>`
        : `<div class="sb-list-add">${button(!path.length && section === "inbounds" ? t("添加入站", "Add inbound") : !path.length && section === "endpoints" ? t("添加连接", "Add connection") : multi || value.every((item) => item === null || typeof item !== "object") && !variants(node.items || {}).some((item) => item.type === "object") ? t("添加值", "Add value") : t("添加条目", "Add item"), "append", id)}</div>`;
    } else if (Object.hasOwn(node, "const")) html += `<input ${data} value="${esc(value)}" readonly>`;
    else if (node.enum || type === "boolean") {
      const choices = node.enum || [false, true];
      html += `<select data-sb-value ${data}>${!choices.includes(value) ? `<option value="-1" selected disabled>${value === "" ? t("请选择", "Choose an option") : t("原值无效，请选择", "Invalid existing value; choose an option")}</option>` : ""}${choices.map((item, i) => `<option value="${i}" ${item === value ? "selected" : ""}>${esc(typeof item === "boolean" ? item ? t("启用", "Enabled") : t("关闭", "Disabled") : item)}</option>`).join("")}</select>`;
    } else if (type === "number" || type === "integer") html += `<input type="number" data-sb-value ${data} value="${esc(value)}" step="${type === "integer" ? 1 : "any"}" ${node.minimum !== undefined ? `min="${node.minimum}"` : ""} ${node.maximum !== undefined ? `max="${node.maximum}"` : ""}>`;
    else if (type === "null") html += `<span>null</span>`;
    else {
      const sensitive = path.some((key) => /password|secret|token|(^|_)key$|(^|_)psk$|authorization|cookie/i.test(String(key)));
      const ref = references[node["x-tag-reference"]] || [];
      // PEM material accepts a line list upstream; WireGuard-style keys are a single line.
      const multiline = /\n/.test(String(value)) || /certificate$|client_key$/.test(String(path.at(-1))) || /private_key$/.test(String(path.at(-1))) && Boolean(multi);
      html += multiline ? `<textarea ${sensitive ? 'class="sb-secret"' : ""} data-sb-value ${data} rows="5" spellcheck="false" autocomplete="off">${esc(value)}</textarea>` : sensitive ? `<input type="password" data-sb-value ${data} value="${esc(value)}" autocomplete="new-password">` : `<input type="text" data-sb-value ${data} value="${esc(value)}" autocomplete="off" spellcheck="false" ${ref.length ? `list="sb-refs-${id}"` : ""}>`;
      if (ref.length) html += `<datalist id="sb-refs-${id}">${ref.map((tag) => `<option value="${esc(tag)}"></option>`).join("")}</datalist>`;
    }
    if (multi && !Array.isArray(value)) html += `<div class="sb-value-add">${button(t("添加另一个值", "Add another value"), "multiple", id)}</div>`;
    const help = {
      reverse_mapping: ["记录经由 sing-box 解析的域名与 IP 对应关系，帮助 TUN 连接按域名分流。", "Remember domain-to-IP mappings from sing-box DNS responses for domain-based TUN routing."],
      dns_server_address: ["选择 DNS 服务器，填写要匹配的 IP 或 CIDR；匹配它从系统、DHCP 或 VPN 获得的 DNS 地址。支持 local、dhcp、resolved、tailscale、openvpn、openconnect。", "Choose a DNS server and enter IP addresses or CIDRs to match the DNS addresses it obtains from the system, DHCP or VPN. Supports local, dhcp, resolved, tailscale, openvpn and openconnect."],
      dns_search_domain: ["选择 DNS 服务器，填写要匹配的搜索域；匹配当前网络的 DNS 搜索域，不是查询域名。支持 local、dhcp、resolved、tailscale、openvpn、openconnect。", "Choose a DNS server and enter search domains to match its current network DNS search domains. Supports local, dhcp, resolved, tailscale, openvpn and openconnect."],
      on_demand: ["允许客户端在需要时断开此端点；留空沿用内核默认行为。", "Allows the client to disconnect this endpoint when needed; omit to use the core default."],
      buffer_size: ["缓存文件写缓冲大小，例如 1MB；默认 1MB。", "Cache-file write buffer size, for example 1MB; defaults to 1MB."],
      flush_interval: ["自动写入磁盘的间隔，例如 30s；默认不定时刷新。", "Automatic disk flush interval, for example 30s; periodic flushing is disabled by default."],
      multi_queue: ["仅支持 Linux，使用新 TUN 协议栈，吞吐量可随 CPU 核心数扩展。", "Linux only, using the new TUN stack to scale throughput across CPU cores."],
      auto_redirect: ["Android 需要图形客户端 root 服务或 root shell。", "Android requires the graphical client's root service or a root shell."],
      verify_client_inbound: ["选择已配置的 Tailcat 入站；不能引用 TUN 或其他入站类型。", "Reference configured Tailcat inbounds, not TUN or other inbound types."],
      derp_servers: ["不能与 derp_map_url 或 derp_region 同时设置。", "Cannot be combined with derp_map_url or derp_region."]
    }[String(path.at(-1))];
    if (help) html += `<p class="help">${esc(t(...help))}</p>`;
    // A list states its item format once, below the items.
    if (typeof path.at(-1) !== "number") html += formatHint(node);
    return html;
  }
  function render() {
    controls = [];
    root.innerHTML = `<div class="sb-form">${renderValue(schema.properties[section], draft, [], singboxTitle(section, t))}</div><p class="notice warning" data-sb-error hidden role="alert"></p>`;
  }
  function error(message) {
    const el = root.querySelector("[data-sb-error]");
    el.textContent = message; el.hidden = !message;
    if (message) el.scrollIntoView({ block: "nearest" });
  }
  function readInputs(discardPath) {
    for (const input of root.querySelectorAll("[data-sb-value]")) {
      // Untouched controls must not coerce imported values or normalize PEM lines.
      if (!input.dataset.sbChanged) continue;
      const { path, node } = controls[Number(input.dataset.sbId)];
      if (discardPath && discardPath.every((key, index) => path[index] === key)) continue;
      const choices = node.enum || (node.type === "boolean" ? [false, true] : null);
      let value = choices ? choices[Number(input.value)] : input.value;
      if (!choices && (node.type === "integer" || node.type === "number")) {
        if (!input.value.trim() || !input.checkValidity() || !Number.isFinite(Number(input.value))) {
          input.setAttribute("aria-invalid", "true"); input.focus();
          throw Error(`${path.join(" / ")}: ${t("请输入范围内的有效数值", "Enter a valid number within the allowed range")}`);
        }
        value = Number(input.value);
      }
      input.removeAttribute("aria-invalid");
      set(path, value);
    }
  }
  root.addEventListener("input", (event) => {
    if (event.target.hasAttribute("data-sb-value")) event.target.dataset.sbChanged = "true";
  });
  root.addEventListener("toggle", (event) => {
    if (!root.contains(event.target)) return;
    const path = event.target.dataset.sbPath;
    if (path) event.target.open ? expanded.add(path) : expanded.delete(path);
    const lazy = event.target.querySelector(":scope > [data-sb-lazy], :scope > .sb-nested > [data-sb-lazy]");
    if (event.target.open && lazy) {
      const { path, raw, name } = controls[Number(lazy.dataset.sbLazy)];
      lazy.outerHTML = renderValue(raw, get(path), path, name);
    }
  }, true);
  root.addEventListener("change", (event) => {
    const input = event.target;
    if (input.hasAttribute("data-sb-value")) input.dataset.sbChanged = "true";
    if (!input.hasAttribute("data-sb-variant")) return;
    try {
      readInputs();
      const { path, raw } = controls[Number(input.dataset.sbId)];
      const next = variants(raw)[Number(input.value)], current = get(path);
      if (!clientBranch(next, path)) throw Error(t("此页面仅配置客户端功能", "This page configures client features only"));
      let value = seed(next);
      if (object(current) && object(value)) {
        for (const [key, item] of Object.entries(current)) {
          const child = next.properties?.[key];
          if (child && Math.max(...variants(child).map((part) => score(part, item))) >= 0) own(value, key, item);
        }
        // A name generated from the previous type would mislabel the new one.
        if (section === "inbounds" && current.type && value.type && value.tag === current.tag && String(current.tag).startsWith(`${current.type}-in`)) {
          const used = (references.inbound || []).filter((tag) => tag !== current.tag);
          let tag = `${value.type}-in`;
          for (let count = 2; used.includes(tag); count++) tag = `${value.type}-in-${count}`;
          value.tag = tag;
        }
        // A stock DNS handler carries a DNS match, not a sniffing preference.
        // Only discard this inherited condition for that exact preset.
        if (isRouteRule(path) && value.action === "sniff" && value.type !== "logical" && isDnsHijackPreset(current)) delete value.protocol;
        if (isRouteRule(path) && value.action === "hijack-dns" && value.type !== "logical" && !matchKeys(value, "route").length) value.protocol = "dns";
      }
      for (const key of selections.keys()) if (key !== JSON.stringify(path)) selections.delete(key);
      selections.set(JSON.stringify(path), Number(input.value));
      set(path, value); render();
    } catch (reason) { error(reason.message); }
  });
  root.addEventListener("click", (event) => {
    const target = event.target.closest("[data-sb-op]");
    if (!target || target.disabled) return;
    try {
      const { path, node } = controls[Number(target.dataset.sbId)], op = target.dataset.sbOp;
      readInputs(op === "remove" ? path : undefined);
      const current = get(path);
      if (op === "create") set(path, seed(node));
      if (op === "multiple") {
        const { multi } = controls[Number(target.dataset.sbId)];
        set(path, [current, seed(variants(multi.array.items)[0])]);
        selections.delete(JSON.stringify(path));
      }
      if (op === "property" || op === "entry") {
        const key = root.querySelector(`[data-sb-${op === "property" ? "property" : "key"}="${target.dataset.sbId}"]`).value;
        if (op === "property" && !key) throw Error(t("请先选择要添加的设置。", "Choose a setting to add first."));
        if (!key.trim() || Object.hasOwn(current, key)) throw Error(t("键名不能为空或重复", "Keys must be nonempty and unique"));
        const raw = node.properties?.[key] || (object(node.additionalProperties) ? node.additionalProperties : { type: "string" });
        own(current, key, seed(variants(raw)[0])); expanded.add(JSON.stringify([...path, key]));
      }
      if (op === "append") {
        const list = variants(node.items || {});
        let next = list.find((variant) => clientBranch(variant, [...path, current.length])) || list[0];
        if (isRouteRuleList(path)) {
          const choice = root.querySelector(`[data-sb-new-rule="${target.dataset.sbId}"]`).value;
          if (choice === "") throw Error(t("请先选择新规则的动作。", "Choose the new rule's action first."));
          next = list[Number(choice)];
        }
        const value = seed(next);
        if (isRouteRuleList(path) && value.action === "hijack-dns" && value.type !== "logical") value.protocol = "dns";
        current.push(value); expanded.add(JSON.stringify([...path, current.length - 1]));
      }
      if (["remove", "up", "down"].includes(op)) {
        const parent = get(path.slice(0, -1)), key = path.at(-1);
        if (op === "remove") Array.isArray(parent) ? parent.splice(key, 1) : delete parent[key];
        else { const next = key + (op === "up" ? -1 : 1); [parent[key], parent[next]] = [parent[next], parent[key]]; }
        selections.clear();
      }
      render();
    } catch (reason) { error(reason.message); }
  });
  render();
  const pathName = (path) => path.map((key) => typeof key === "number" ? `#${key + 1}` : title(key)).join(" / ");
  function validateChoices(raw, value, path) {
    const { node } = active(raw, value, path);
    if (object(value)) {
      const ruleKind = ruleKindAt(path);
      if (ruleKind && (value.action || "route") === "route" && (typeof value[targetKey(ruleKind)] !== "string" || !value[targetKey(ruleKind)].trim())) {
        throw Error(ruleKind === "dns" ? t("请选择 DNS 服务器。", "Choose a DNS server.") : `${t("规则", "Rule")} ${path[1] + 1}: ${t("请选择出站。", "Choose an outbound.")}`);
      }
      // An empty condition is not "unset": an empty domain suffix matches every name.
      const empty = ruleKind && matchKeys(value, ruleKind).find((key) => value[key] === "");
      if (empty) throw Error(`${pathName([...path, empty])}: ${t("请填写匹配值，或移除此条件。", "Enter a value, or remove this condition.")}`);
      if (value.tag === "") throw Error(`${pathName([...path, "tag"])}: ${t("请填写名称。", "Enter a name.")}`);
      for (const [key, item] of Object.entries(value)) validateChoices(node.properties?.[key] || (object(node.additionalProperties) ? node.additionalProperties : {}), item, [...path, key]);
    } else if (Array.isArray(value)) value.forEach((item, index) => validateChoices(node.items || {}, item, [...path, index]));
    else if (node.enum && !node.enum.includes(value) || node.type === "boolean" && typeof value !== "boolean") {
      throw Error(`${pathName(path)}: ${t("请选择一个值，或移除此可选设置以使用内核默认值。", "Choose a value, or remove this optional setting to use the core default.")}`);
    } else if (["number", "integer"].includes(node.type) && (typeof value !== "number" || !Number.isFinite(value))) {
      throw Error(`${pathName(path)}: ${t("请填写数值，或移除此可选设置以使用内核默认值。", "Enter a number, or remove this optional setting to use the core default.")}`);
    } else if (value === "" && typeof path.at(-1) === "number") {
      throw Error(`${pathName(path)}: ${t("请填写此项，或将其从列表中删除。", "Enter a value, or delete it from the list.")}`);
    }
  }
  return { read() { readInputs(); validateChoices(schema.properties[section], draft, []); return structuredClone(draft); }, error };
}
