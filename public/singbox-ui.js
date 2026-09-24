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
  cache_capacity: "缓存容量", optimistic: "乐观 DNS 缓存", timeout: "超时", reverse_mapping: "反向映射",
  server_name: "TLS 服务器名", insecure: "跳过证书验证", certificate_path: "证书路径", certificate: "证书内容",
  peers: "对端", allowed_ips: "允许网段", endpoint: "关联端点", bind_interface: "绑定接口", interface_name: "接口名称",
  default: "默认成员", interrupt_exist_connections: "切换时中断连接", idle_timeout: "空闲超时", interval: "间隔", tolerance: "延迟容差",
  url: "地址", path: "路径", format: "格式", update_interval: "更新间隔", headers: "请求头", http_client: "HTTP 客户端",
  default_http_client: "默认 HTTP 客户端", default_domain_resolver: "建立连接时的默认 DNS", find_process: "查找进程", find_neighbor: "查找邻居",
  netns: "网络命名空间", cache_file: "缓存文件", clash_api: "Clash API", v2ray_api: "V2Ray API", debug: "调试",
  level: "日志级别", timestamp: "时间戳", output: "输出路径", disabled: "禁用", store: "信任库", secret: "密钥"
};
export const singboxSections = {
  network: ["inbounds"], dns: ["dns"], rules: ["route"],
  endpoints: ["endpoints"],
  advanced: ["log", "http_clients", "outbounds", "experimental", "services"]
};
export const singboxTitle = (key, t) => TITLES[key] ? t(...TITLES[key]) : key;

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

export function createSingboxForm(root, schema, section, original, { t, esc, references = {}, singleItem = false, endpointType }) {
  let draft = structuredClone(original);
  const variantsCache = new WeakMap();
  const selections = new Map();
  const expanded = new Set(["[]"]);
  if (Array.isArray(original) && original.length === 1) expanded.add("[0]");
  let controls = [];
  const title = (key) => t(LABELS[key] || TITLES[key]?.[0] || key, TITLES[key]?.[1] || key.replaceAll("_", " "));
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
    const best = list.reduce((index, item, i) => score(item, value) > score(list[index], value) ? i : index, 0);
    const selected = selections.get(JSON.stringify(path)) ?? best;
    return { list, selected, node: list[selected] || list[0] };
  }
  function seed(node) {
    if (Object.hasOwn(node, "const")) return structuredClone(node.const);
    if (node.enum) return node.enum[0];
    if (node.type === "object" || Object.keys(node.properties || {}).length) {
      const result = {};
      for (const key of new Set([...(node.required || []), ...["tag", "server", "server_port", "outbounds"].filter((key) => node.properties?.[key])])) {
        if (node.properties?.[key]) own(result, key, seed(variants(node.properties[key])[0]));
      }
      return result;
    }
    if (node.type === "array") return [];
    if (node.type === "boolean") return false;
    if (node.type === "integer" || node.type === "number") return node.minimum ?? 0;
    if (node.type === "null") return null;
    return "";
  }
  function get(path) { return path.reduce((value, key) => value?.[key], draft); }
  function set(path, value) {
    if (!path.length) draft = value;
    else own(get(path.slice(0, -1)), path.at(-1), value);
  }
  function register(data) { controls.push(data); return controls.length - 1; }
  const button = (label, op, id, disabled = false) => `<button type="button" data-sb-op="${op}" data-sb-id="${id}" ${disabled ? "disabled" : ""}>${label}</button>`;
  function clientBranch(node, path) {
    if (path.length !== 1 || typeof path[0] !== "number") return true;
    const type = deref(node.properties?.type);
    const protocol = type.const ?? type.enum?.[0];
    if (!protocol) return true;
    if (section === "inbounds") return ["tun", "mixed", "http", "socks", "tailcat"].includes(protocol);
    if (section === "endpoints") return endpointType ? protocol === endpointType : ["wireguard", "tailscale", "openconnect", "openvpn-client", "masque-client", "masque-server"].includes(protocol);
    return true;
  }
  function branchName(node) {
    const parts = Object.entries(node.properties || {}).flatMap(([key, value]) => Object.hasOwn(value, "const") ? [`${key}: ${value.const}`] : ["type", "action"].includes(key) && value.enum ? [`${key}: ${value.enum[0] || "default"}`] : []);
    return parts.join(" · ") || (Object.hasOwn(node, "const") ? String(node.const) : node.enum?.join(" / ") || t(({ object: "对象", array: "列表", string: "文本", integer: "整数", number: "数值", boolean: "开关" })[node.type] || node.type || "对象", node.type || "object"));
  }
  function renderValue(raw, value, path, name) {
    const { list, selected, node } = active(raw, value, path);
    const id = register({ path, raw, node });
    const data = `data-sb-id="${id}" aria-label="${esc(name)}"`;
    let html = list.length > 1 ? `<label class="sb-variant">${t("类型 / 动作", "Type / action")}<select data-sb-variant ${data}>${list.map((item, i) => !clientBranch(item, path) && i !== selected ? "" : `<option ${!clientBranch(item, path) ? "disabled" : ""} value="${i}" ${selected === i ? "selected" : ""}>${esc(branchName(item))}</option>`).join("")}</select></label>` : "";
    if (value === undefined) return html + button(t("配置此项", "Configure"), "create", id);
    const type = node.type || kind(value);
    if (singleItem && !path.length && type === "array") return renderValue(node.items || {}, value[0], [0], name);
    if (type === "object" && object(value)) {
      const props = node.properties || {};
      const basicKeys = new Set(["type", "tag", "action", "address", "interface_name", "auto_route", "strict_route", "mtu", "listen", "listen_port", "server", "server_port", "outbound", "outbounds", "final", "servers", "rules"]);
      let basicHtml = "", advancedHtml = "";
      for (const key of Object.keys(value)) {
        const child = props[key] || (object(node.additionalProperties) ? node.additionalProperties : { type: kind(value[key]) });
        const childPath = [...path, key], pathKey = JSON.stringify(childPath);
        const childId = register({ path: childPath });
        const complex = value[key] !== null && typeof value[key] === "object";
        if (complex && ["address", "outbounds"].includes(key)) expanded.add(pathKey);
        const body = complex && !expanded.has(pathKey) ? `<div data-sb-lazy="${register({ path: childPath, raw: child, name: title(key) })}"></div>` : renderValue(child, value[key], childPath, title(key));
        const required = node.required?.includes(key);
        const fieldHtml = `<div class="sb-field">${complex ? `<details data-sb-path="${esc(pathKey)}" ${expanded.has(pathKey) ? "open" : ""}><summary>${esc(title(key))} <code>${esc(key)}</code></summary>${body}</details>` : `<label class="sb-label">${esc(title(key))} <code>${esc(key)}</code></label><div class="sb-control">${body}</div>`}<div class="sb-remove">${button(t("移除", "Remove"), "remove", childId, required)}</div></div>`;
        if (basicKeys.has(key) || required) basicHtml += fieldHtml;
        else advancedHtml += fieldHtml;
      }
      html += `<div class="sb-basic-fields">${basicHtml}</div>`;
      if (advancedHtml) html += `<details class="sb-advanced-fields"><summary>${t("高级设置（已配置）", "Advanced settings (configured)")}</summary>${advancedHtml}</details>`;
      const missing = Object.keys(props).filter((key) => !Object.hasOwn(value, key));
      if (missing.length) html += `<details class="sb-more-options"><summary>${t("添加可选设置", "Add optional settings")}</summary><div class="sb-add"><select data-sb-property="${id}" aria-label="${esc(t("选择配置字段", "Choose a field"))}">${missing.map((key) => `<option value="${esc(key)}">${esc(title(key))} · ${esc(key)}${node.required?.includes(key) ? " *" : ""}</option>`).join("")}</select>${button(t("添加", "Add"), "property", id)}</div></details>`;
      if (node.additionalProperties !== false && (node.additionalProperties || !Object.keys(props).length)) html += `<div class="sb-add"><input data-sb-key="${id}" placeholder="${esc(t("键名，例如域名或请求头", "Key, e.g. domain or header"))}" aria-label="${esc(t("新键名", "New key"))}">${button(t("添加条目", "Add entry"), "entry", id)}</div>`;
    } else if (type === "array" && Array.isArray(value)) {
      html += `<div class="sb-list">${value.map((item, index) => {
        const childPath = [...path, index], key = JSON.stringify(childPath);
        const childId = register({ path: childPath });
        if (item === null || typeof item !== "object") return `<div class="sb-scalar-item"><span class="sb-scalar-index">${index + 1}</span><div>${renderValue(node.items || {}, item, childPath, `${name} ${index + 1}`)}</div>${button(t("删除", "Delete"), "remove", childId)}</div>`;
        const summary = object(item) ? [item.tag, item.type, item.action].filter(Boolean).join(" · ") : t("条目", "Item");
        const body = expanded.has(key) ? renderValue(node.items || {}, item, childPath, `${name} ${index + 1}`) : `<div data-sb-lazy="${register({ path: childPath, raw: node.items || {}, name: `${name} ${index + 1}` })}"></div>`;
        return `<details class="sb-item" data-sb-path="${esc(key)}" ${expanded.has(key) ? "open" : ""}><summary>${index + 1}. ${esc(summary || t("条目", "Item"))}</summary><div class="sb-item-actions">${button(t("上移", "Move up"), "up", childId, index === 0)}${button(t("下移", "Move down"), "down", childId, index === value.length - 1)}${button(t("删除", "Delete"), "remove", childId)}</div>${body}</details>`;
      }).join("")}</div>${button((!path.length && section === "inbounds" ? t("添加入站", "Add inbound") : t("添加条目", "Add item")), "append", id)}`;
    } else if (Object.hasOwn(node, "const")) html += `<input ${data} value="${esc(value)}" readonly>`;
    else if (node.enum || type === "boolean") {
      const choices = node.enum || [false, true];
      html += `<select data-sb-value ${data}>${!choices.includes(value) ? `<option value="-1" selected disabled>${t("原值无效，请选择", "Invalid existing value; choose an option")}</option>` : ""}${choices.map((item, i) => `<option value="${i}" ${item === value ? "selected" : ""}>${esc(typeof item === "boolean" ? item ? t("启用", "Enabled") : t("关闭", "Disabled") : item)}</option>`).join("")}</select>`;
    } else if (type === "number" || type === "integer") html += `<input type="number" data-sb-value ${data} value="${esc(value)}" step="${type === "integer" ? 1 : "any"}" ${node.minimum !== undefined ? `min="${node.minimum}"` : ""} ${node.maximum !== undefined ? `max="${node.maximum}"` : ""}>`;
    else if (type === "null") html += `<span>null</span>`;
    else {
      const sensitive = path.some((key) => /password|secret|token|(^|_)key$|(^|_)psk$|authorization|cookie/i.test(String(key)));
      const ref = references[node["x-tag-reference"]] || [];
      const multiline = /\n/.test(String(value)) || /certificate$|private_key$|client_key$/.test(String(path.at(-1)));
      html += multiline ? `<textarea ${sensitive ? 'class="sb-secret"' : ""} data-sb-value ${data} rows="5" spellcheck="false" autocomplete="off">${esc(value)}</textarea>` : sensitive ? `<input type="password" data-sb-value ${data} value="${esc(value)}" autocomplete="new-password">` : `<input type="text" data-sb-value ${data} value="${esc(value)}" autocomplete="off" spellcheck="false" ${ref.length ? `list="sb-refs-${id}"` : ""}>`;
      if (ref.length) html += `<datalist id="sb-refs-${id}">${ref.map((tag) => `<option value="${esc(tag)}"></option>`).join("")}</datalist>`;
    }
    const help = {
      on_demand: ["允许客户端在需要时断开此端点；留空沿用内核默认行为。", "Allows the client to disconnect this endpoint when needed; omit to use the core default."],
      buffer_size: ["缓存文件写缓冲大小，例如 1MB；默认 1MB。", "Cache-file write buffer size, for example 1MB; defaults to 1MB."],
      flush_interval: ["自动写入磁盘的间隔，例如 30s；默认不定时刷新。", "Automatic disk flush interval, for example 30s; periodic flushing is disabled by default."],
      multi_queue: ["仅支持 Linux，使用新 TUN 协议栈，吞吐量可随 CPU 核心数扩展。", "Linux only, using the new TUN stack to scale throughput across CPU cores."],
      auto_redirect: ["Android 需要图形客户端 root 服务或 root shell。", "Android requires the graphical client's root service or a root shell."],
      verify_client_inbound: ["选择已配置的 Tailcat 入站；不能引用 TUN 或其他入站类型。", "Reference configured Tailcat inbounds, not TUN or other inbound types."],
      derp_servers: ["不能与 derp_map_url 或 derp_region 同时设置。", "Cannot be combined with derp_map_url or derp_region."]
    }[String(path.at(-1))];
    if (help) html += `<p class="help">${esc(t(...help))}</p>`;
    if (node.pattern) html += `<p class="help">${t("格式", "Format")}: <code>${esc(node.pattern)}</code></p>`;
    return html;
  }
  function render() {
    controls = [];
    root.innerHTML = `<div class="sb-form">${renderValue(schema.properties[section], draft, [], singboxTitle(section, t))}</div><p class="notice warning" data-sb-error hidden role="alert"></p>`;
  }
  function error(message) { const el = root.querySelector("[data-sb-error]"); el.textContent = message; el.hidden = !message; }
  function readInputs() {
    for (const input of root.querySelectorAll("[data-sb-value]")) {
      // Untouched controls must not coerce imported values or normalize PEM lines.
      if (!input.dataset.sbChanged) continue;
      const { path, node } = controls[Number(input.dataset.sbId)];
      const choices = node.enum || (node.type === "boolean" ? [false, true] : null);
      let value = choices ? choices[Number(input.value)] : input.value;
      if (node.type === "integer" || node.type === "number") {
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
    const lazy = event.target.querySelector(":scope > [data-sb-lazy]");
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
      readInputs();
      const { path, node } = controls[Number(target.dataset.sbId)], op = target.dataset.sbOp;
      const current = get(path);
      if (op === "create") set(path, seed(node));
      if (op === "property" || op === "entry") {
        const key = root.querySelector(`[data-sb-${op === "property" ? "property" : "key"}="${target.dataset.sbId}"]`).value;
        if (!key.trim() || Object.hasOwn(current, key)) throw Error(t("键名不能为空或重复", "Keys must be nonempty and unique"));
        const raw = node.properties?.[key] || (object(node.additionalProperties) ? node.additionalProperties : { type: "string" });
        own(current, key, seed(variants(raw)[0])); expanded.add(JSON.stringify([...path, key]));
      }
      if (op === "append") { current.push(seed(variants(node.items || {}).find((variant) => clientBranch(variant, [...path, current.length])) || variants(node.items || {})[0])); expanded.add(JSON.stringify([...path, current.length - 1])); }
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
  return { read() { readInputs(); return structuredClone(draft); }, error };
}
