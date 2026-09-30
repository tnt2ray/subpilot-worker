import { newTailscaleNode, tailscaleForm, readTailscaleForm, updateTailscaleForm } from "./tailscale-ui.js";
import { createSingboxForm, singboxSections, singboxTitle } from "./singbox-ui.js";
import { CLIENT_SECTIONS, getPath, splitRule } from "./app-model.js";

export function createClientUi({ state, $, t, esc, label, btn, icon, iconButton, smallButton, isObject, isTextList, field, section, renderConfigLines, clientTabs, currentClient, basePath, target, modal, closeModal, changed, render, api, getProxyNames, getClashRouting }) {
let singboxSchema = null;
function validateNativeShape(value, path = "clients.singbox") {
  const objects = ["clients.singbox", "clients.singbox.dns", "clients.singbox.route", "clients.singbox.log", "clients.singbox.experimental"];
  const arrays = ["clients.singbox.inbounds", "clients.singbox.endpoints", "clients.singbox.dns.servers", "clients.singbox.dns.rules", "clients.singbox.route.rules", "clients.singbox.route.rule_set"];
  if (objects.includes(path) && !isObject(value)) throw Error(`${path}: ${t("需要 JSON 对象", "a JSON object is required")}`);
  if (arrays.includes(path) && (!Array.isArray(value) || value.some((item) => !isObject(item)))) throw Error(`${path}: ${t("需要由对象组成的数组", "an array of objects is required")}`);
  if (objects.includes(path)) for (const [key, item] of Object.entries(value)) {
    const child = `${path}.${key}`;
    if (objects.includes(child) || arrays.includes(child)) validateNativeShape(item, child);
  }
}
function groupSyntaxHelp() {
  const types = state.client === "surge"
    ? t("select 手动选择；smart 智能选择；url-test 输出时自动转为 smart；fallback 按顺序故障切换；load-balance 负载均衡；subnet 按网络选择。smart 只能包含代理节点，不能直接引用其他组或 DIRECT。", "select: manual selection; smart: adaptive selection; url-test is emitted as smart; fallback: priority failover; load-balance: load balancing; subnet: network-based selection. Smart accepts proxy nodes only, not nested groups or DIRECT.")
    : state.client === "clash"
      ? t("select 手动选择，可用 default-selected 指定默认成员；url-test 自动测速；fallback 按顺序故障切换；load-balance 负载均衡。", "select: manual selection, with default-selected for the default member; url-test: automatic latency testing; fallback: priority failover; load-balance: load balancing.")
      : t("select 手动选择，输出为 selector；url-test 自动测速，输出为 urltest。可用端点的 tag 可以作为显式成员引用。", "select: manual selection, emitted as selector; url-test: automatic latency testing, emitted as urltest. Available endpoint tags can be referenced as explicit members.");
  const options = state.client === "surge"
    ? t("hidden=true 隐藏组。Surge 不使用组级 url；测速 URL 在客户端配置中设置，smart 的 interval 不生效。subnet 使用 条件=策略，例如 subnet, SSID:Home=DIRECT, default=Proxy；default 必填，不能引用自身。", "hidden=true hides the group. Surge ignores group-level url; set the test URL in client settings. Smart ignores interval. subnet uses condition=policy, for example subnet, SSID:Home=DIRECT, default=Proxy; default is required and must not reference the group itself.")
    : state.client === "clash"
      ? t("url 设置测速地址，interval 设置测速间隔（秒）；hidden=true 隐藏组，但需要客户端或面板支持。", "url sets the test URL; interval sets the test interval in seconds. hidden=true hides the group when supported by the client or dashboard.")
      : t("url 设置测速地址，interval 设置测速间隔（秒），tolerance 设置延迟容差（毫秒）。sing-box 不支持 hidden，输出时会省略。", "url sets the test URL; interval sets the test interval in seconds; tolerance sets latency tolerance in milliseconds. sing-box omits unsupported hidden settings.");
  const example = state.client === "surge" ? "smart, {all filter=DMIT exclude=v4}, hidden=true" : "url-test, {all filter=DMIT exclude=v4}, url=https://www.gstatic.com/generate_204, interval=600";
  return `<div class="group-syntax" data-help><p>${t("组配置格式：", "Group definition: ")}<code>${t("类型, 成员或筛选器, 参数=值", "type, member or selector, option=value")}</code>${t("。只填一行，使用英文逗号分隔；名称单独填写，不要加“组名 =”。", ". Use one line and ASCII commas. Enter the name separately; omit the “group name =” prefix.")}</p><details><summary>${t("语法说明与示例", "Syntax guide and examples")}</summary><ul>
    <li><strong>${t("当前客户端类型：", "Types for this client: ")}</strong>${types}</li>
    <li><strong>${t("显式成员：", "Explicit members: ")}</strong>${t("填写已存在的节点名、策略组名或受支持的内置策略，例如 select, Auto, DIRECT（Auto 需已存在）。名称要完全一致；组不能引用自身，也不能形成 A → B → A 的循环。", "Use existing node or group names, or supported built-in policies, e.g. select, Auto, DIRECT (Auto must exist). Names must match exactly. Do not reference the group itself or create a cycle such as A → B → A.")}</li>
    <li><code>{all}</code> ${t("展开当前客户端可用且允许加入策略组的节点，不会选中策略组。fallback 和 subnet 不能使用此筛选器；fallback 请显式列出成员。", "expands nodes available to this client and allowed in groups; it does not select groups. fallback and subnet cannot use this selector; list fallback members explicitly.")}</li>
    <li><code>{all filter=香港,日本 exclude=via,DMIT}</code> ${t("保留命中“香港”或“日本”的节点，再排除命中“via”或“DMIT”的节点。关键字匹配节点名称和匹配标签，不区分大小写，按包含关系匹配，不是正则表达式。", "keeps nodes matching 香港 or 日本, then excludes nodes matching via or DMIT. Keywords match substrings in node names and matching labels, case-insensitively; they are not regular expressions.")}</li>
    <li>${t("filter 可省略，表示不限制包含条件；exclude 可省略，表示不额外排除。多个关键字用英文逗号分隔，filter 和 exclude 之间用空格，filter 写在前。", "Omit filter to allow all candidates; omit exclude to apply no extra exclusions. Separate keywords with ASCII commas. Put filter before exclude, separated by a space.")} <code>{all exclude=via,DMIT}</code> ${t("表示排除命中任意一个关键字的节点。", "excludes nodes matching either keyword.")}</li>
    <li><strong>${t("参数：", "Options: ")}</strong>${options}</li>
    <li><strong>${t("示例：", "Example: ")}</strong><code>${esc(example)}</code><br>${t("选择名称或标签包含 DMIT、且不包含 v4 的节点。被引用的组筛选后为空、成员缺失或循环引用会阻止订阅生成，可在“配置链接 → 订阅检查”查看具体原因。", "Selects nodes whose names or labels contain DMIT but not v4. Referenced groups with no matching nodes, missing members, or cycles block subscription generation; see Configuration links → Subscription check for details.")}</li>
  </ul></details></div>`;
}
function renderGroups() {
  const client = currentClient();
  return clientTabs() + groupSyntaxHelp() + `<p class="muted" data-help>${t("策略组仅用于当前客户端，同名组可在不同客户端分别配置。", "Policy groups belong to this client. Groups with the same name can have different settings in other clients.")}</p><div class="toolbar">${btn(icon("plus") + t("添加策略组", "Add group"), "add-group", "", "primary")}</div><div class="table-wrap"><table class="editable-table"><thead><tr><th>${t("名称", "Name")}</th><th>${t("组配置", "Group definition")}</th><th class="actions">${t("操作", "Actions")}</th></tr></thead><tbody>${Object.entries(client.groups).map(([name, spec]) => `<tr><td class="entity-name">${btn(esc(name), "edit-group", `data-name="${esc(name)}"`, "link entity-link")}${client.disabledGroups.includes(name) ? ` <span class="chip">${t("停用", "Disabled")}</span>` : ""}</td><td class="truncate">${esc(spec)}</td><td class="actions">${smallButton("edit", "edit-group", `data-name="${esc(name)}"`, t("编辑", "Edit"))}${name !== "Proxy" ? smallButton("trash", "delete-group", `data-name="${esc(name)}"`, t("删除", "Delete")) : ""}</td></tr>`).join("")}</tbody></table></div>`;
}
function renderClient() {
  const client = state.config.clients[state.client];
  const fields = CLIENT_SECTIONS[state.client][state.section] || [];
  const tabs = [["network", "网络与 TUN", "Network & TUN"], ["dns", "DNS", "DNS"], ["rules", "分流规则", "Routing rules"], ["tailscale", "Tailscale", "Tailscale"], ...state.client === "singbox" ? [["wireguard", "WireGuard", "WireGuard"], ["openconnect", "OpenConnect", "OpenConnect"], ["openvpn-client", "OpenVPN", "OpenVPN"], ["masque-client", "MASQUE 客户端", "MASQUE Client"], ["masque-server", "MASQUE 服务端", "MASQUE Server"]] : [], ...state.client !== "clash" ? [["advanced", "高级设置", "Advanced"]] : [], ...state.client === "surge" ? [["mitm", "MITM 证书", "MITM certificates"]] : []];
  let content = "";
  if (state.client === "surge" && state.section === "mitm") content = renderMitm();
  else if (state.section === "tailscale") content = renderTailscale();
  else if (state.section === "rules") content = renderRules();
  else if (state.client === "singbox" && state.section === "dns") content = renderSingboxDns() + renderSingboxConnectionSettings("dns");
  else if (state.client === "singbox" && ["wireguard", "openconnect", "openvpn-client", "masque-client", "masque-server"].includes(state.section)) content = renderSingboxVpn(state.section);
  else if (state.client === "singbox" && state.section === "network") content = renderSingboxNetwork() + renderSingboxConnectionSettings("network");
  else if (state.client === "singbox") content = renderSingboxSections(singboxSections[state.section] || []);
  else {
    const simple = fields.filter((key) => !isObject(client[key]) && !Array.isArray(client[key]));
    const complex = fields.filter((key) => !simple.includes(key));
    const basics = simple.length ? `<div class="client-settings-basics">${simple.map((key) => field(`${basePath()}.${key}`, client[key])).join("")}</div>` : "";
    const details = complex.map((key) => {
      const value = client[key], path = `${basePath()}.${key}`, lines = isTextList(key, value);
      const body = lines
        ? (value.length ? renderConfigLines(value) : `<p class="help">${t("未配置", "Not configured")}</p>`)
        : isObject(value) ? `<div class="client-settings-nested">${Object.entries(value).map(([sub, item]) => field(`${path}.${sub}`, item)).join("")}</div>` : field(path, value);
      const editor = iconButton("edit", "edit-json", `data-path="${path}" data-lines="${lines}"`, t("编辑", "Edit"));
      return `<div class="client-settings-block ${isObject(value) ? "client-settings-object" : "client-settings-list"}">${section(label(key), body, editor)}</div>`;
    }).join("");
    content = `<div class="client-settings ${state.section === "advanced" ? "client-settings-advanced" : ""}">${basics}<div class="client-settings-details">${details}</div></div>`;
  }
  if (!content) content = `<p class="empty">${t("此客户端的设置均在其他分栏中提供。", "All settings for this client are available in the other tabs.")}</p>`;
  return `<div class="client-config-page">` + clientTabs() + `<div class="section-tabs">${tabs.map(([id, zh, en]) => btn(t(zh, en), "section", `data-section="${id}"`, state.section === id ? "selected" : "")).join("")}</div>` + content + `</div>`;
}
function renderSingboxDns() {
  const dns = currentClient().dns;
  const servers = dns.servers || [], rules = dns.rules || [];
  const actions = (kind, index) => iconButton("edit", "edit-sb-dns", `data-kind="${kind}" data-index="${index}"`, t("编辑", "Edit")) + iconButton("trash", "delete-sb-dns", `data-kind="${kind}" data-index="${index}"`, t("删除", "Delete"));
  const serverRows = servers.map((server, index) => {
    const address = server.server || server.endpoint || (server.type === "local" ? t("系统 DNS", "System DNS") : "—");
    return `<tr><td><strong>${esc(server.tag || "—")}</strong></td><td>${esc(server.type || "—")}</td><td><code>${esc(address)}${server.server_port ? ` : ${esc(server.server_port)}` : ""}${server.path ? esc(server.path) : ""}</code></td><td>${esc(server.detour || t("默认连接", "Default connection"))}</td><td class="actions">${actions("servers", index)}</td></tr>`;
  }).join("");
  const ruleRows = rules.map((rule, index) => {
    const match = Object.fromEntries(Object.entries(rule).filter(([key]) => !["server", "action", "disable_cache", "rewrite_ttl", "client_subnet"].includes(key)));
    return `<tr><td>${index + 1}</td><td>${Object.keys(match).length ? renderConfigLines(JSON.stringify(match, null, 2).split("\n")) : t("所有请求", "All requests")}</td><td>${esc(rule.server || rule.action || "route")}</td><td class="actions">${iconButton("up", "move-sb-dns", `data-index="${index}" data-direction="-1" ${index === 0 ? "disabled" : ""}`, t("上移", "Move up"))}${iconButton("down", "move-sb-dns", `data-index="${index}" data-direction="1" ${index === rules.length - 1 ? "disabled" : ""}`, t("下移", "Move down"))}${actions("rules", index)}</td></tr>`;
  }).join("");
  const table = (headers, rows) => `<div class="table-wrap"><table><thead><tr>${headers.map((heading) => `<th>${heading}</th>`).join("")}</tr></thead><tbody>${rows || `<tr><td colspan="${headers.length}" class="empty">${t("尚未配置", "Not configured")}</td></tr>`}</tbody></table></div>`;
  return `<div class="sb-dns-page">${section(t("DNS 服务器列表", "DNS server list"), table([t("名称", "Name"), t("协议", "Protocol"), t("服务器地址", "Server address"), t("连接出口", "Connection outbound"), t("操作", "Actions")], serverRows), btn(t("添加服务器", "Add server"), "edit-sb-dns", 'data-kind="servers"', "primary"))}${section(t("DNS 查询兜底服务器", "Fallback DNS server for queries"), field("clients.singbox.dns.final", dns.final || "", { label: t("兜底 DNS 服务器", "Fallback DNS server"), options: [...servers.map((server) => server.tag).filter(Boolean), ""] }) + `<p class="help">${t("收到的 DNS 查询未命中规则集 DNS 或高级 DNS 规则时使用。留空使用 DNS 服务器列表中的第一个服务器。", "Used when an incoming DNS query matches neither rule-set DNS nor advanced DNS rules. Leave empty to use the first server in the DNS server list.")}</p>`)}${section(t("域名分流", "Domain-based routing"), field("clients.singbox.dns.reverse_mapping", dns.reverse_mapping ?? false, { label: t("DNS 反向映射", "DNS reverse mapping") }) + `<p class="help">${t("记录经由 sing-box 解析的域名与 IP 对应关系，让 TUN 连接可以按域名分流。浏览器自行使用加密 DNS 时，可能无法建立映射。", "Remember domain-to-IP mappings from sing-box DNS responses so TUN connections can match domain rules. Browser-managed encrypted DNS may bypass this mapping.")}</p>`)}${section("", `<details><summary>${t("高级 DNS 规则", "Advanced DNS rules")} · ${rules.length}</summary><p class="help">${t("规则集 DNS 请在“分流规则”Tab 配置。此处用于查询类型匹配、拒绝查询等高级设置，在规则集 DNS 规则之后匹配。折叠不影响已配置规则生效。", "Configure rule-set DNS on the Routing rules tab. Use this section for advanced settings such as query-type matching and query rejection. These rules match after rule-set DNS rules; collapsing this section does not disable them.")}</p>${table([t("顺序", "Order"), t("匹配条件", "Match conditions"), t("解析目标 / 动作", "DNS target / action"), t("操作", "Actions")], ruleRows)}<div class="toolbar">${btn(t("添加规则", "Add rule"), "edit-sb-dns", 'data-kind="rules"')}</div></details>`)}<div class="toolbar">${btn(t("缓存与其他设置", "Cache and other settings"), "edit-sb-dns", 'data-kind="options"')}</div></div>`;
}
async function editSingboxDns(kind, index) {
  singboxSchema ||= await api("/api/singbox/schema");
  const raw = singboxSchema.properties.dns;
  const dnsSchema = raw.$ref ? singboxSchema.$defs[raw.$ref.split("/").at(-1)] : raw;
  const dns = currentClient().dns;
  const options = kind === "options";
  const dedicated = ["servers", "rules", "final", "reverse_mapping"];
  const original = options ? Object.fromEntries(Object.entries(dns).filter(([key]) => !dedicated.includes(key))) : index === null ? (kind === "servers" ? { type: "udp", tag: "", server: "" } : { domain_suffix: [""], action: "route", server: dns.final || dns.servers?.[0]?.tag || "" }) : dns[kind][index];
  const property = options ? { ...dnsSchema, properties: Object.fromEntries(Object.entries(dnsSchema.properties).filter(([key]) => !dedicated.includes(key))), required: (dnsSchema.required || []).filter((key) => !dedicated.includes(key)) } : dnsSchema.properties[kind].items;
  let form;
  modal(options ? t("DNS 缓存与其他设置", "DNS cache and other settings") : kind === "servers" ? t("DNS 服务器", "DNS server") : t("DNS 分流规则", "DNS routing rule"), '<div id="singbox-form"></div>', async () => {
    const value = form.read(), next = structuredClone(dns);
    if (options) { for (const key of Object.keys(next)) if (!dedicated.includes(key)) delete next[key]; Object.assign(next, value); }
    else { next[kind] ||= []; if (index === null) next[kind].push(value); else next[kind][index] = value; }
    const result = await api("/api/singbox/validate", { method: "POST", body: JSON.stringify({ section: "dns", value: next }) });
    if (!result.valid) { form.error(result.errors.join("; ")); return; }
    currentClient().dns = next; closeModal(); changed(); render();
  });
  form = createSingboxForm($("#singbox-form"), { ...singboxSchema, properties: { ...singboxSchema.properties, dns: property } }, "dns", original, { t, esc, references: { dns_server: (dns.servers || []).map((server) => server.tag), outbound: policyChoices(), endpoint: (currentClient().endpoints || []).map((endpoint) => endpoint.tag) }, referenceTypes: { dns_server: Object.fromEntries((dns.servers || []).map((server) => [server.tag, server.type])) } });
}
function renderSingboxNetwork() {
  const inbounds = currentClient().inbounds || [];
  const rows = inbounds.map((item, index) => {
    const tun = item.type === "tun";
    const address = tun ? (Array.isArray(item.address) ? item.address : []) : [item.listen && `${item.listen}${item.listen_port !== undefined ? ` : ${item.listen_port}` : ""}`].filter(Boolean);
    const route = item.auto_route === undefined ? t("未指定", "Not specified") : item.auto_route ? t("开启", "On") : t("关闭", "Off");
    return `<tr><td><strong>${esc(item.tag || t("未命名入站", "Unnamed inbound"))}</strong><div class="help">${esc(item.type || "—")}</div></td><td>${tun ? t("接管设备流量", "Capture device traffic") : ["mixed", "http", "socks"].includes(item.type) ? t("本地代理端口", "Local proxy port") : t("接收入站连接", "Accept inbound connections")}</td><td><div class="help">${tun ? t("虚拟网卡地址", "Virtual interface addresses") : t("监听地址 / 端口", "Listen address / port")}</div>${address.length ? address.map((value) => `<code class="sb-network-address">${esc(value)}</code>`).join("") : "—"}</td><td>${tun ? `<dl><dt>${t("自动路由", "Automatic routing")}</dt><dd>${route}</dd>${item.interface_name ? `<dt>${t("接口", "Interface")}</dt><dd>${esc(item.interface_name)}</dd>` : ""}</dl>` : "—"}</td><td class="actions">${iconButton("edit", "edit-singbox-inbound", `data-index="${index}"`, t("编辑入站", "Edit inbound"))}${iconButton("trash", "delete-singbox-inbound", `data-index="${index}"`, t("删除入站", "Delete inbound"))}</td></tr>`;
  }).join("");
  return `<section class="sb-network"><div class="section-heading"><div><h2>${t("入站管理", "Inbound connections")}</h2><p class="help" data-help>${t("TUN 接管设备流量；HTTP / SOCKS 端口供应用连接代理；Tailcat 通过 DERP 建立点对点隧道。", "TUN captures device traffic; HTTP / SOCKS ports accept proxy connections from apps; Tailcat establishes peer-to-peer tunnels through DERP.")}</p></div>${btn(t("添加入站", "Add inbound"), "edit-singbox-inbound", "", "primary")}</div><div class="table-wrap"><table><thead><tr><th>${t("入站", "Inbound")}</th><th>${t("用途", "Purpose")}</th><th>${t("地址", "Address")}</th><th>${t("网络设置", "Network settings")}</th><th>${t("操作", "Actions")}</th></tr></thead><tbody>${rows || `<tr><td colspan="5" class="empty">${t("尚未配置入站，点击「添加入站」设置流量入口。", "No inbounds configured. Add an inbound to receive traffic.")}</td></tr>`}</tbody></table></div></section>`;
}
function singboxConnectionDnsHelp() {
  return t("用于解析代理节点地址，以及直连时尚未解析的目标域名。连接单独指定 DNS 时优先使用其设置；此处指定的服务器可能绕过 DNS 查询分流规则。", "Resolves proxy server addresses and target domains still unresolved when connecting directly. A connection-specific DNS resolver takes priority; a server selected here may bypass DNS query routing rules.");
}
function renderSingboxConnectionSettings(group) {
  const title = group === "dns" ? t("建立连接时的默认 DNS", "Default DNS for establishing connections") : t("出口连接设置", "Outbound connection settings");
  const route = currentClient().route;
  const keys = group === "dns" ? ["default_domain_resolver"] : ["auto_detect_interface", "default_interface", "default_network_strategy"];
  const names = { default_domain_resolver: t("连接解析服务器", "Connection resolver"), auto_detect_interface: t("自动检测出口网卡", "Detect outbound interface"), default_interface: t("指定出口网卡", "Outbound interface"), default_network_strategy: t("网络选择策略", "Network strategy") };
  const summary = keys.filter((key) => route[key] !== undefined).map((key) => `<div><span class="muted">${names[key]}：</span>${esc(typeof route[key] === "boolean" ? route[key] ? t("开启", "On") : t("关闭", "Off") : typeof route[key] === "object" ? JSON.stringify(route[key]) : route[key])}</div>`).join("");
  return section(title, (summary || `<p class="help">${t("使用默认设置", "Using defaults")}</p>`) + (group === "dns" ? `<p class="help" data-help>${singboxConnectionDnsHelp()}</p>` : ""), btn(t("配置", "Configure"), "edit-singbox-section", `data-key="route" data-route-group="${group}"`));
}
function renderSingboxVpn(type) {
  const title = { wireguard: "WireGuard", openconnect: "OpenConnect", "openvpn-client": "OpenVPN", "masque-client": "MASQUE 客户端", "masque-server": "MASQUE 服务端" }[type];
  const items = (currentClient().endpoints || []).filter((item) => item.type === type);
  const locationLabel = type === "masque-server" ? t("监听地址", "Listen address") : t("服务器 / 地址", "Server / Address");
  const help = type === "masque-client" ? t("通过 MASQUE 连接远端代理，可在策略组和分流规则中选择。", "Connect to a remote proxy with MASQUE and use it in policy groups and routing rules.")
    : type === "masque-server" ? t("配置 MASQUE 服务端 endpoint；监听与证书选项由客户端内核管理。", "Configure a MASQUE server endpoint; the client core manages its listen and certificate options.")
      : t("连接 VPN 服务器，可在策略组和分流规则中选择此连接。", "Connect to a VPN server and use the connection in policy groups and routing rules.");
  return section(title, `<p class="help" data-help>${help}</p><div class="table-wrap"><table><thead><tr><th>${t("名称", "Name")}</th><th>${locationLabel}</th></tr></thead><tbody>${items.map((item) => `<tr><td>${esc(item.tag || "—")}</td><td>${esc(item.server || item.listen || (item.address || []).join(", ") || "—")}</td></tr>`).join("") || `<tr><td colspan="2" class="empty">${t("尚未配置连接", "No connections configured")}</td></tr>`}</tbody></table></div>`, btn(t("配置连接", "Configure connections"), "edit-singbox-section", `data-key="endpoints" data-endpoint-type="${type}"`));
}
function renderSingboxSections(keys) {
  const client = currentClient();
  const notes = {
    inbounds: t("Android / Apple 的 TUN 由系统 VPN 接口管理；接口名、进程匹配等能力受平台权限限制。应用选择、Always On 等客户端自身设置需在客户端中操作。", "Android / Apple TUN uses the system VPN interface. Interface names and process matching depend on platform permissions. App selection overrides and Always On are configured in the client itself."),
    endpoints: t("配置 WireGuard、Tailscale、OpenConnect、OpenVPN 和 MASQUE 端点。", "Configure WireGuard, Tailscale, OpenConnect, OpenVPN and MASQUE endpoints."),
    route: client.ruleSets.mode === "compiled" ? t("来源编排模式下，原生规则先匹配，再匹配编排规则；原生规则集与生成规则集合并，标签不可重复。", "In compiled mode, native rules match before compiled rules. Native and generated rule sets are merged; tags must be unique.") : "",
    outbounds: t("可添加 Tailcat 等本端原生出站，再在策略组和规则中引用。Tailcat 使用公钥和 DERP，不填写服务器地址与端口。", "Add client-native outbounds such as Tailcat, then reference them in groups and rules. Tailcat uses keys and DERP rather than a server address and port."),
    experimental: t("cache_file 中可设置写缓冲大小和定时刷新间隔，留空使用客户端默认值。", "Configure write buffering and periodic flushing under cache_file, or omit them to use client defaults."),
    services: t("DERP 客户端验证可引用 Tailcat 入站或允许的公钥。", "DERP client verification can reference Tailcat inbounds or allowed public keys."),
    http_clients: t("Apple HTTP 引擎仅 Apple 平台可用，支持字段与 Go 引擎不同。", "The Apple HTTP engine is available only on Apple platforms and supports a different set of options from Go.")
  };
  return `<div class="client-settings singbox-settings"><div class="client-settings-details">` + keys.map((key) => {
    const value = client[key];
    const summary = value === undefined ? t("使用默认值", "Using defaults") : Array.isArray(value) ? t(`已配置 ${value.length} 项`, `${value.length} items configured`) : isObject(value) ? Object.keys(value).join(" · ") || t("使用默认值", "Using defaults") : t("已配置", "Configured");
    const purpose = {
      inbounds: t("接管设备流量或开放本地代理端口", "Capture device traffic or expose a local proxy port"),
      dns: t("配置域名解析服务器和解析规则", "Configure DNS servers and resolution rules"),
      route: t("设置流量匹配条件和默认出口", "Configure traffic matching and the default outbound"),
      endpoints: t("配置 VPN 隧道连接", "Configure VPN tunnel connections"),
      log: t("设置日志级别和输出位置", "Set log verbosity and destination")
    };
    const items = Array.isArray(value) ? value : null;
    const overview = items ? (items.length ? `<div class="sb-overview-list">${items.map((item, index) => {
      const type = item.type || "—";
      const role = type === "tun" ? t("设备流量接管", "Device traffic capture") : ["mixed", "http", "socks"].includes(type) ? t("本地代理入口", "Local proxy listener") : type;
      const details = [[t("虚拟网卡地址", "Virtual interface addresses"), (Array.isArray(item.address) ? item.address : []).join(" · ")], [t("接口名称", "Interface name"), item.interface_name], [t("监听地址", "Listen address"), item.listen], [t("监听端口", "Listen port"), item.listen_port]].filter(([, value]) => value !== undefined && value !== "");
      return `<div class="sb-overview-item"><div class="section-heading"><strong>${esc(item.tag || role)}</strong>${key === "inbounds" ? `<div class="toolbar">${iconButton("edit", "edit-singbox-inbound", `data-index="${index}"`, t("编辑入站", "Edit inbound"))}${iconButton("trash", "delete-singbox-inbound", `data-index="${index}"`, t("删除入站", "Delete inbound"))}</div>` : ""}</div><span>${esc(role)} · ${esc(type)}</span><dl class="sb-overview-details">${details.map(([label, value]) => `<dt>${esc(label)}</dt><dd><code>${esc(value)}</code></dd>`).join("")}</dl></div>`;
    }).join("")}</div>` : `<p class="help">${t("尚未配置", "Not configured")}</p>`) : `<p class="sb-summary">${esc(summary)}</p>`;
    const removable = value !== undefined && !["inbounds", "dns", "route", "log", "experimental"].includes(key);
    return section(singboxTitle(key, t), `<p class="help" data-help>${purpose[key] || ""}</p>${overview}${notes[key] ? `<p class="help" data-help>${notes[key]}</p>` : ""}`, `<div class="toolbar">${key === "inbounds" ? btn(t("添加入站", "Add inbound"), "edit-singbox-inbound") : btn(t("配置", "Configure"), "edit-singbox-section", `data-key="${key}"`)}${removable ? btn(t("恢复默认", "Use defaults"), "remove-singbox-section", `data-key="${key}"`) : ""}</div>`);
  }).join("") + `</div></div>`;
}
async function editSingboxSection(key, inboundIndex, endpointType, routeGroup) {
  singboxSchema ||= await api("/api/singbox/schema");
  if (!Object.hasOwn(singboxSchema.properties, key)) throw Error(t("未知配置分类", "Unknown configuration section"));
  const client = state.config.clients.singbox;
  const tags = (items) => (items || []).flatMap((item) => item.tag || []);
  const references = {
    outbound: [...new Set(["DIRECT", ...Object.keys(client.groups).filter((name) => !client.disabledGroups.includes(name)), ...(getProxyNames().names.singbox || []), ...tags(client.outbounds), ...tags(client.endpoints)])],
    inbound: tags(client.inbounds), dns_server: tags(client.dns.servers), rule_set: tags(client.route.rule_set),
    http_client: tags(client.http_clients), certificate_provider: tags(client.certificate_providers), network_namespace: tags(client.network_namespaces), endpoint: tags(client.endpoints)
  };
  let viewSchema = singboxSchema;
  let routeKeys;
  if (routeGroup) {
    const node = singboxSchema.$defs.RouteOptions;
    routeKeys = Object.keys(node.properties).filter((name) => routeGroup === "dns" ? name === "default_domain_resolver" : !["rules", "rule_set", "final", "default_domain_resolver"].includes(name));
    viewSchema = { ...singboxSchema, properties: { ...singboxSchema.properties, route: { ...node, properties: Object.fromEntries(routeKeys.map((name) => [name, node.properties[name]])), required: (node.required || []).filter((name) => routeKeys.includes(name)) } } };
  }
  let form;
  modal(endpointType ? { wireguard: "WireGuard", openconnect: "OpenConnect", "openvpn-client": "OpenVPN" }[endpointType] : routeGroup ? (routeGroup === "dns" ? t("建立连接时的默认 DNS", "Default DNS for establishing connections") : t("出口连接设置", "Outbound connection settings")) : singboxTitle(key, t), `<p class="help">${routeGroup === "dns" ? singboxConnectionDnsHelp() : key === "route" && !routeGroup ? t("每条规则先选择动作，再按需添加匹配条件。不设置条件时应用于所有连接；规则按列表顺序执行。应用后请保存配置。", "Choose an action for each rule, then add conditions if needed. Rules without conditions apply to all connections and run in list order. Save configuration after applying.") : t("先选择配置类型，再填写设置。其他参数可通过“添加可选设置”添加；应用后请保存配置。", "Choose a configuration type and edit its settings. Use Add optional settings for other parameters. Save configuration after applying.")}</p><div id="singbox-form"></div>`, async () => {
    const edited = form.read();
    let value = inboundIndex === undefined ? edited : [...client.inbounds];
    if (routeKeys) {
      value = { ...client.route };
      for (const name of routeKeys) delete value[name];
      Object.assign(value, edited);
    }
    if (endpointType) {
      if (edited.some((item) => item.type !== endpointType)) throw Error(t("连接类型不匹配", "Connection type mismatch"));
      const remaining = [...edited];
      value = (client.endpoints || []).flatMap((item) => item.type === endpointType ? (remaining.length ? [remaining.shift()] : []) : [item]);
      value.push(...remaining);
    }
    if (inboundIndex !== undefined) {
      if (inboundIndex === null) value.push(edited[0]);
      else value[inboundIndex] = edited[0];
    }
    const root = $("#singbox-form"), saveButton = $('#modal-actions [data-action="modal-save"]');
    root.inert = true; saveButton.disabled = true;
    try {
      const result = await api("/api/singbox/validate", { method: "POST", body: JSON.stringify({ section: key, value }) });
      if (!root.isConnected || !$("#modal").open) return;
      if (!result.valid) { form.error(t("请检查以下字段：", "Check these fields: ") + result.errors.join("; ")); return; }
      client[key] = value;
      for (const path of state.invalid.keys()) if (path === `clients.singbox.${key}` || path.startsWith(`clients.singbox.${key}.`)) state.invalid.delete(path);
      closeModal(); changed(); render();
    } finally { root.inert = false; saveButton.disabled = false; }
  });
  const original = routeKeys ? Object.fromEntries(routeKeys.filter((name) => client.route[name] !== undefined).map((name) => [name, client.route[name]])) : endpointType ? (client.endpoints || []).filter((item) => item.type === endpointType) : inboundIndex === undefined ? client[key] : [inboundIndex === null ? { type: "mixed", tag: "mixed-in", listen: "127.0.0.1", listen_port: 7890 } : client.inbounds[inboundIndex]];
  form = createSingboxForm($("#singbox-form"), viewSchema, key, original, { t, esc, references, referenceTypes: { dns_server: Object.fromEntries((client.dns.servers || []).map((server) => [server.tag, server.type])) }, endpointType, singleItem: inboundIndex !== undefined });
}
function tailscaleCollection() {
  return state.client === "singbox" ? currentClient().endpoints || [] : currentClient().tailscaleNodes || [];
}
function renderTailscale() {
  const surge = state.client === "surge", clash = state.client === "clash";
  const rows = tailscaleCollection().flatMap((node, index) => {
    if (!surge && node.type !== "tailscale") return [];
    const name = surge || clash ? node.name : node.tag;
    const exit = surge ? node.exitNode : clash ? node["exit-node"] : node.exit_node;
    return [`<tr><td>${btn(esc(name || t("未命名", "Unnamed")), "edit-tailscale", `data-index="${index}"`, "link")}</td><td>${esc(node.hostname || "—")}</td><td>${esc(exit && exit !== "none" ? exit : t("未指定", "Not selected"))}</td><td>${surge ? node.enabled ? t("启用", "Enabled") : t("停用", "Disabled") : t("已配置", "Configured")}</td><td class="actions">${smallButton("edit", "edit-tailscale", `data-index="${index}"`, t("编辑", "Edit"))}${smallButton("trash", "delete-tailscale", `data-index="${index}"`, t("删除", "Delete"))}</td></tr>`];
  }).join("");
  const help = surge ? t("节点可在当前端的策略组和分流规则中使用。认证密钥仅在编辑时以密码框显示。", "Use nodes in this client's policy groups and routing rules. Auth keys are masked in the editor.") : clash ? t("需要支持 Tailscale 的 Mihomo 内核，原版 Clash 不支持。添加后请在策略组或分流规则中明确选择此节点；首次有连接命中时才开始登录和连接。认证密钥可留空，使用客户端日志中的登录地址授权。", "Requires a Mihomo core with Tailscale support; original Clash is not supported. Select the node explicitly in a policy group or routing rule. Sign-in and connection begin on the first matching connection. Leave the auth key empty to sign in using the URL in client logs.") : t("使用 sing-box 1.15 原生 Tailscale endpoint。认证密钥可留空，通过客户端日志中的登录地址授权；每个实例应使用独立的状态目录。", "Uses native sing-box 1.15 Tailscale endpoints. Leave the auth key empty to sign in through the URL in client logs; use a separate state directory for each instance.");
  const routingHelp = clash ? `<p class="help" data-help>${t("访问公网需配置可用的出口节点。访问 Tailnet 子网需开启“接受 Tailnet 子网路由”，并把相应流量的分流规则指向此节点。每个实例应使用独立的状态目录。", "Configure an available exit node for public internet access. For Tailnet subnets, enable Accept Tailnet subnet routes and direct the matching traffic to this node with routing rules. Use a separate state directory for each instance.")}</p>` : "";
  return section(t("Tailscale 节点", "Tailscale nodes"), `<p class="help" data-help>${help}</p>${routingHelp}<div class="table-wrap"><table class="editable-table tailscale-table"><thead><tr><th>${t("名称", "Name")}</th><th>${t("设备主机名", "Hostname")}</th><th>${t("出口节点", "Exit node")}</th><th>${t("状态", "Status")}</th><th class="actions">${t("操作", "Actions")}</th></tr></thead><tbody>${rows || `<tr><td colspan="5" class="empty">${t("尚未添加 Tailscale 节点", "No Tailscale nodes yet")}</td></tr>`}</tbody></table></div>`, btn(t("添加节点", "Add node"), "add-tailscale", "", "primary"));
}
function editTailscale(index) {
  const client = state.client, surge = client === "surge", clash = client === "clash";
  const nodes = tailscaleCollection();
  const original = index === null ? newTailscaleNode(client) : nodes[index];
  const name = surge || clash ? original.name : original.tag;
  const candidates = policyChoices().filter((policy) => policy !== name && (!clash || !["REJECT", "REJECT-DROP", "PASS", "PASS-RULE", "COMPATIBLE", "GLOBAL"].includes(policy)));
  modal(t("编辑 Tailscale 节点", "Edit Tailscale node"), tailscaleForm(client, original, candidates, t, esc) + `<p class="help">${t("改名或删除不会自动重写已有规则引用。应用更改后保存配置。", "Renaming or deleting does not rewrite existing rule references. Apply changes, then save the configuration.")}</p>`, () => {
    const next = readTailscaleForm(client, original, $("#modal-body"), t);
    const name = surge || clash ? next.name : next.tag;
    const reserved = clash ? ["DIRECT", "REJECT", "REJECT-DROP", "PASS", "PASS-RULE", "COMPATIBLE", "GLOBAL"] : ["DIRECT", "REJECT", "REJECT-DROP"];
    if (nodes.some((node, i) => i !== index && (surge || clash ? node.name : node.tag) === name) || Object.hasOwn(currentClient().groups, name) || reserved.includes(name.toUpperCase()) || clash && (getProxyNames().names.clash || []).includes(name)) throw Error(t("节点名称与已有节点或策略冲突", "Node name conflicts with an existing node or policy"));
    if (surge && nodes.some((node, i) => i !== index && node.sectionName === next.sectionName)) throw Error(t("配置段名称不能重复", "Section names must be unique"));
    if ((surge ? next.underlyingProxy : clash ? next["dialer-proxy"] : next.detour) === name) throw Error(t("前置代理不能引用当前节点自身", "An upstream proxy cannot reference itself"));
    if (index === null) {
      if (surge || clash) (currentClient().tailscaleNodes ??= []).push(next);
      else (currentClient().endpoints ??= []).push(next);
    } else nodes[index] = next;
    closeModal(); changed(); render();
  });
  updateTailscaleForm($("#modal-body"));
}
function renderMitm() {
  const mitm = state.config.clients.surge.mitm;
  const path = "clients.surge.mitm";
  return section(t("MITM 证书管理", "MITM certificate management"), `<p class="muted" data-help>${t("生成或导入 Surge 使用的 CA 证书。修改后保存配置，再在客户端更新订阅。", "Generate or import a CA certificate for Surge. Save changes, then update the subscription in your client.")}</p><p id="ca-status" role="status">${mitm.caP12 ? t("已配置 CA 证书", "CA certificate configured") : t("尚未配置 CA 证书", "No CA certificate configured")}</p><div class="toolbar">${btn(t("生成证书", "Generate certificate"), "generate-ca", "", "primary")}${btn(t("导入证书", "Import certificate"), "import-ca")}${btn(t("导出证书", "Export certificate"), "export-ca", mitm.caP12 ? "" : "disabled")}</div>${field(`${path}.caPassphrase`, mitm.caPassphrase)}<details><summary>${t("查看或编辑证书数据", "View or edit certificate data")}</summary>${field(`${path}.caP12`, mitm.caP12)}</details>`) + section(t("MITM 设置", "MITM settings"), Object.entries(mitm).filter(([key]) => !["caPassphrase", "caP12"].includes(key)).map(([key, value]) => field(`${path}.${key}`, value)).join(""));
}
function renderRules() {
  if (state.client === "clash") return getClashRouting().render();
  const client = currentClient();
  const compiled = client.ruleSets.mode === "compiled";
  if (state.client === "singbox") {
    if (!compiled) return section("", `<p class="help">${t("启用后，已有原生规则仍优先匹配，已保存的编排规则也会启用。", "Existing native rules keep priority. Previously saved rule-plan entries will also become active.")}</p>`, btn(t("使用规则集地址配置", "Use rule-set URLs"), "enable-singbox-rule-plan", "", "primary")) + renderSingboxSections(["route"]);
    return renderSingboxSections(["route"]) + renderRulePlan(client.ruleSets);
  }
  if (compiled) return renderRulePlan(client.ruleSets);
  const path = `${basePath()}.rules`;
  const rules = Array.isArray(client.rules) ? client.rules : [];
  return section("", `<div class="toolbar">${btn(t("文本", "Text"), "edit-json", `data-path="${path}" data-lines="true"`)}</div><div class="table-wrap"><table class="rule-table"><thead><tr><th>${t("顺序", "Order")}</th><th>${t("匹配类型", "Match")}</th><th>${t("匹配值", "Value")}</th><th>${t("出站策略", "Outbound")}</th><th>${t("操作", "Actions")}</th></tr></thead><tbody>${rules.map((rule, index) => surgeRuleRow(rule, index, path)).join("") || `<tr><td colspan="5" class="empty">${t("还没有规则", "No rules")}</td></tr>`}</tbody></table></div>${btn(icon("plus") + t("添加规则", "Add rule"), "add-rule", `data-path="${path}"`)}<div class="toolbar"><span>${t("当前端策略组：", "Client groups:")}</span>${Object.keys(client.groups).slice(0, 7).map((name) => `<span class="chip">${esc(name)}</span>`).join("")}<a href="#groups">${t("管理策略组", "Manage groups")}</a></div>`);
}
function surgeRuleRow(rule, index, path) {
  const parts = splitRule(rule);
  const type = parts[0];
  const final = type === "FINAL" || type === "MATCH";
  const value = final ? parts.slice(2).join(", ") || "—" : parts[1];
  const policy = parts[final ? 1 : 2] || "—";
  const simple = SURGE_RULE_TYPES.includes(type);
  const lockedFinal = isFinalRule(rule);
  const select = (kind, values, current) => `<select ${lockedFinal && kind === "type" ? "disabled" : ""} data-rule-field="${kind}" data-path="${path}" data-index="${index}" aria-label="${t("规则", "Rule")} ${index + 1} ${kind}">${values.map((item) => `<option value="${esc(item)}" ${item === current ? "selected" : ""}>${esc(item)}</option>`).join("")}</select>`;
  return `<tr><td>${index + 1}</td><td>${simple && !lockedFinal ? select("type", SURGE_RULE_TYPES, type) : esc(type)}</td><td class="truncate">${esc(value)}</td><td>${simple ? select("policy", policyChoices(policy), policy) : esc(policy)}</td><td class="actions"><span class="order">${smallButton("up", "move-rule", `data-path="${path}" data-index="${index}" data-direction="-1" ${lockedFinal || index === 0 ? "disabled" : ""}`, t("上移", "Move up"))}${smallButton("down", "move-rule", `data-path="${path}" data-index="${index}" data-direction="1" ${lockedFinal || index === getPath(state.config, path).length - 1 || isFinalRule(getPath(state.config, path)[index + 1]) ? "disabled" : ""}`, t("下移", "Move down"))}</span>${iconButton("edit", simple ? "edit-rule" : "edit-rule-text", `data-path="${path}" data-index="${index}"`, t("编辑", "Edit"))}${smallButton("trash", "delete-rule", `data-path="${path}" data-index="${index}" ${lockedFinal ? "disabled" : ""}`, t("删除", "Delete"))}</td></tr>`;
}
function orderedPlan(plan) {
  return [...plan.outputs.map((item, index) => ({ kind: "output", item, index })), ...plan.directRules.map((item, index) => ({ kind: "direct", item, index }))].sort((a, b) => Number(isFinalEntry(a)) - Number(isFinalEntry(b)) || a.item.order - b.item.order);
}
function isFinalEntry(entry) {
  return entry?.kind === "direct" && isFinalRule(entry.item.rule);
}
function isFinalRule(rule) {
  return typeof rule === "string" && ["FINAL", "MATCH"].includes(splitRule(rule)[0]?.toUpperCase());
}
function nextPlanOrder(plan) {
  return Math.max(-1, ...orderedPlan(plan).map(({ item }) => item.order)) + 1;
}
function appendPlanItem(plan, kind, item) {
  const ordered = orderedPlan(plan);
  const final = ordered.findIndex((entry) => entry.kind === "direct" && isFinalRule(entry.item.rule));
  ordered.splice(final < 0 || (kind === "direct" && isFinalRule(item.rule)) ? ordered.length : final, 0, { kind, item });
  plan[kind === "output" ? "outputs" : "directRules"].push(item);
  ordered.forEach((entry, order) => entry.item.order = order);
}
function outputSourceUrls(output) {
  return output.sourceIds.map((id) => currentClient().ruleSets.sources.find((source) => source.id === id)?.url).filter(Boolean).join("\n");
}
function pruneUnusedRuleSources(plan) {
  const used = new Set(plan.outputs.flatMap((output) => output.sourceIds));
  plan.sources = plan.sources.filter((source) => used.has(source.id));
}
function sourcesForUrls(plan, text, preferredIds = []) {
  const urls = [...new Set(text.split("\n").map((url) => url.trim()).filter(Boolean))];
  for (const url of urls) {
    let parsed;
    try { parsed = new URL(url); } catch { throw Error(t("规则来源需要完整的 HTTP(S) 地址。", "Rule sources require full HTTP(S) URLs.")); }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw Error(t("规则来源需要不含登录凭据的 HTTP(S) 地址。", "Use HTTP(S) URLs without login credentials."));
  }
  const sources = structuredClone(plan.sources);
  const ids = urls.map((url) => {
    let source = sources.find((entry) => entry.url === url && preferredIds.includes(entry.id)) || sources.find((entry) => entry.url === url);
    if (!source) {
      const parsed = new URL(url);
      source = { id: crypto.randomUUID(), name: parsed.pathname.split("/").filter(Boolean).at(-1) || parsed.hostname, url, enabled: true, format: "auto", order: Math.max(-1, ...sources.map((entry) => entry.order)) + 1 };
      sources.push(source);
    }
    return source.id;
  });
  return { sources, ids };
}
function policyChoices(selected = "") {
  const client = currentClient();
  const builtins = state.client === "surge" ? ["DIRECT", "CELLULAR", "CELLULAR-ONLY", "HYBRID", "NO-HYBRID", "REJECT", "REJECT-DROP", "REJECT-NO-DROP", "REJECT-TINYGIF"] : state.client === "clash" ? ["DIRECT", "REJECT", "REJECT-DROP", "PASS", "PASS-RULE", "COMPATIBLE", "GLOBAL"] : ["DIRECT", "REJECT", "REJECT-DROP"];
  return [...new Set([...Object.keys(client.groups).filter((name) => !client.disabledGroups.includes(name)), ...builtins, ...(getProxyNames().names[state.client] || []), ...(state.client === "singbox" ? [...(client.endpoints || []), ...(client.outbounds || [])].map((node) => node.tag) : (client.tailscaleNodes || []).filter((node) => state.client === "clash" || node.enabled).map((node) => node.name)), selected].filter(Boolean))];
}
function selectOptions(choices, selected) {
  return [...new Set([...choices, selected])].map((value) => `<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(value || t("无", "None"))}</option>`).join("");
}
const SURGE_RULE_TYPES = ["DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "IP-CIDR", "IP-CIDR6", "GEOIP", "IP-ASN", "PROCESS-NAME", "USER-AGENT", "URL-REGEX", "SCRIPT", "SUBNET", "SRC-IP", "IN-PORT", "DEST-PORT", "PROTOCOL", "DEVICE-NAME", "CELLULAR-RADIO", "WIFI-SSID", "RULE-SET", "DOMAIN-SET", "AND", "OR", "NOT", "FINAL"];
const SURGE_RULE_SET_TYPES = ["RULE-SET", "DOMAIN-SET"];
const SURGE_DIRECT_RULE_TYPES = SURGE_RULE_TYPES.filter((type) => !SURGE_RULE_SET_TYPES.includes(type));
function surgeOptionChoices(type) {
  if (type === "RULE-SET") return ["", "no-resolve", "extended-matching", "no-resolve,extended-matching"];
  if (["IP-CIDR", "IP-CIDR6", "GEOIP", "IP-ASN"].includes(type)) return ["", "no-resolve"];
  if (["DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "URL-REGEX", "DOMAIN-SET"].includes(type)) return ["", "extended-matching"];
  return type === "FINAL" ? ["", "dns-failed"] : [""];
}
function directMatchText(rule) {
  const parts = splitRule(rule);
  if (isFinalRule(rule)) return [parts[0], ...compiledFinalOptions(parts)].join(",");
  const options = ["no-resolve", "src", "extended-matching"].includes(parts[2]?.toLowerCase()) ? parts.slice(2) : parts.slice(3);
  return [parts[0], parts[1], ...options].join(",");
}
function compiledFinalOptions(parts) {
  // Compiled plans store the policy separately, so FINAL,dns-failed is valid.
  const second = parts[1]?.toLowerCase() || "";
  const option = ["dns-failed", "no-resolve", "src", "extended-matching"].includes(second) || second.includes("=");
  return parts.slice(option ? 1 : 2);
}
function renderRulePlan(plan) {
  const surge = state.client === "surge";
  const ordered = orderedPlan(plan);
  let rows = ordered.map(({ kind, item, index }, position) => {
    const output = kind === "output";
    const lockedFinal = !output && isFinalRule(item.rule);
    const attrs = `data-plan-kind="${kind}" data-index="${index}"`;
    const control = (field, tag, content, extra = "") => `<${tag} data-plan-field="${field}" ${attrs} ${extra}>${content}</${tag}>`;
    const urls = output ? state.invalid.get(`plan.${state.client}.output.${index}.sourceUrls`) ?? outputSourceUrls(item) : "";
    const content = output ? urls.split("\n").filter(Boolean).map((url) => `<div class="routing-url">${esc(url)}</div>`).join("") + (item.inlineRules.length ? `<span class="small muted">${t(`保留 ${item.inlineRules.length} 条已有规则`, `${item.inlineRules.length} existing rules retained`)}</span>` : "") : `<code>${esc(directMatchText(item.rule))}</code>`;
    const kindLabel = output ? (surge ? item.surgeType || t("规则集（自动类型）", "Rule set (automatic type)") : t("规则集", "Rule set")) : t("单条规则", "Direct rule");
    const policy = control("policy", "select", selectOptions(policyChoices(item.policy), item.policy), `aria-label="${t("出口策略", "Outbound policy")}"`);
    const options = output && surge ? `<label class="small">${t("Surge 选项", "Surge options")}${control("surgeOptions", "select", selectOptions(surgeOptionChoices(item.surgeType || "RULE-SET"), item.surgeOptions.join(",")))}</label>` : "";
    return `<tr><td>${position + 1}</td><td class="routing-content"><span class="small muted">${esc(kindLabel)}</span>${content}${output ? `<p class="small muted">DNS: ${esc(item.dnsServer || t("继承全局", "Inherit global"))}</p>` : ""}</td><td>${policy}${options}</td><td><label class="routing-enabled"><input type="checkbox" data-plan-field="enabled" ${attrs} ${item.enabled ? "checked" : ""} ${lockedFinal ? "disabled" : ""}>${t("启用", "Enabled")}</label></td><td class="actions"><span class="routing-actions"><span class="order">${iconButton("up", "move-plan", `data-position="${position}" data-direction="-1" ${lockedFinal || position === 0 ? "disabled" : ""}`, t("上移", "Move up"))}${iconButton("down", "move-plan", `data-position="${position}" data-direction="1" ${lockedFinal || position === ordered.length - 1 || isFinalEntry(ordered[position + 1]) ? "disabled" : ""}`, t("下移", "Move down"))}</span>${iconButton("edit", `edit-${kind}`, `data-index="${index}"`, t("编辑", "Edit"))}${iconButton("trash", `delete-${kind}`, `data-index="${index}" ${lockedFinal ? "disabled" : ""}`, t("删除", "Delete"))}</span></td></tr>`;
  }).join("");
  if (state.client === "singbox" && !plan.directRules.some((item) => item.enabled && isFinalRule(item.rule))) {
    const selected = currentClient().route.final || "";
    const choices = policyChoices(selected).filter((name) => !["REJECT", "REJECT-DROP"].includes(name));
    const options = `${selected ? "" : `<option value="">${t("内核默认（第一个出站）", "Core default (first outbound)")}</option>`}${selectOptions(choices, selected)}`;
    rows += `<tr><td>${ordered.length + 1}</td><td class="routing-content"><span class="small muted">${t("兜底规则", "Final rule")}</span><code>FINAL</code><div class="small muted">${t("未命中以上规则时使用", "Used when no preceding rule matches")}</div></td><td><select data-field="clients.singbox.route.final" aria-label="${t("兜底出口策略", "Final outbound policy")}">${options}</select></td><td><label class="routing-enabled"><input type="checkbox" checked disabled>${t("启用", "Enabled")}</label></td><td class="actions">${iconButton("trash", "delete-direct", "disabled", t("兜底规则不能删除", "The final rule cannot be deleted"))}</td></tr>`;
  }
  return section("", `${state.client === "surge" ? `${field(`${basePath()}.ruleSets.aggregateByPolicy`, plan.aggregateByPolicy)}<p class="help">${t("按策略聚合会在该策略首次出现的位置合并规则集，可能改变跨策略的匹配顺序。", "Same-policy aggregation merges rule sets at the policy's first occurrence and may change precedence across policies.")}</p>` : ""}<div class="toolbar">${btn(t("添加规则集", "Add rule set"), "add-output")}${btn(t("添加单条规则", "Add direct rule"), "add-direct")}</div><div class="table-wrap"><table class="routing-table surge-routing-table"><thead><tr><th>${t("匹配顺序", "Match order")}</th><th>${t("规则集地址 / 单条规则", "Rule-set URL / Direct rule")}</th><th>${t("出口策略", "Outbound policy")}</th><th>${t("状态", "Status")}</th><th class="actions">${t("操作", "Actions")}</th></tr></thead><tbody>${rows || `<tr><td colspan="5" class="empty">${t("还没有规则", "No rules")}</td></tr>`}</tbody></table></div>`);
}
return { isFinalEntry, validateNativeShape, renderGroups, renderClient, renderSingboxDns, editSingboxDns, renderSingboxNetwork, renderSingboxConnectionSettings, renderSingboxVpn, renderSingboxSections, editSingboxSection, tailscaleCollection, renderTailscale, editTailscale, renderMitm, renderRules, orderedPlan, isFinalRule, nextPlanOrder, appendPlanItem, outputSourceUrls, pruneUnusedRuleSources, sourcesForUrls, policyChoices, selectOptions, SURGE_RULE_TYPES, SURGE_RULE_SET_TYPES, SURGE_DIRECT_RULE_TYPES, surgeOptionChoices, compiledFinalOptions, renderRulePlan };
}
