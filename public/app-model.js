const CLIENTS = { surge: { label: "Surge", target: "surge" }, clash: { label: "clash", target: "clash" }, singbox: { label: "sing-box", target: "sing-box" } };
const NAV = [["status", "概览", "Overview", "grid"], ["sources", "订阅源", "Sources", "source"], ["nodes", "代理节点", "Proxy nodes", "nodes"], ["groups", "策略组", "Policy groups", "settings"], ["clients", "客户端配置", "Client settings", "settings"], ["links", "配置链接", "Subscription links", "link"], ["system", "系统设置", "System settings", "settings"]];
const LABELS = {
  managedBaseUrl: "订阅基础 URL",
  userAgentSurge: "Surge 抓取 User-Agent",
  userAgentClash: "clash 抓取 User-Agent",
  excludeKeywords: "排除关键词",
  geoipRenameEnabled: "GeoIP 节点重命名",
  featureTagRules: "节点特征标签",
  updateCheckEnabled: "检查版本更新",
  displayTimeZone: "显示时区",
  actionsCompilation: "Actions 规则编译",
  repository: "GitHub 仓库（owner/repo）",
  ref: "GitHub 分支或标签",
  notificationChannel: "通知渠道",
  notificationTelegramChatId: "Telegram Chat ID",
  notificationTelegramBotToken: "Telegram Bot Token",
  notificationTelegramWebhookSecret: "Telegram Webhook Secret",
  skipProxy: "绕过代理",
  dnsServer: "DNS 服务器",
  alwaysRealIp: "始终使用真实 IP",
  managedConfigIntervalSeconds: "订阅更新间隔（秒）",
  internetTestUrl: "网络检测 URL",
  proxyTestUrl: "代理检测 URL",
  showErrorPageForReject: "显示拒绝错误页",
  ipv6: "IPv6",
  ipv6Vif: "IPv6 虚拟接口",
  allowWifiAccess: "允许 Wi-Fi 访问",
  tunExcludedRoutes: "TUN 排除路由",
  encryptedDnsServer: "加密 DNS 服务器",
  wifiAssist: "Wi-Fi 助理",
  excludeSimpleHostnames: "排除简单主机名",
  encryptedDnsFollowOutboundMode: "加密 DNS 跟随出站",
  tailscaleNodes: "Tailscale 节点",
  hosts: "Hosts",
  urlRewrite: "URL Rewrite",
  mapLocal: "Map Local",
  scripts: "脚本",
  mitm: "MITM",
  rules: "分流规则",
  port: "HTTP 端口",
  socksPort: "SOCKS 端口",
  mixedPort: "混合端口",
  allowLan: "允许局域网访问",
  mode: "运行模式",
  logLevel: "日志级别",
  unifiedDelay: "统一延迟",
  tcpConcurrent: "TCP 并发",
  externalController: "外部控制器",
  tun: "TUN",
  enable: "启用",
  stack: "网络栈",
  autoRoute: "自动路由",
  autoDetectInterface: "自动检测接口",
  dnsEnabled: "启用 DNS",
  dnsListen: "DNS 监听地址",
  dnsListenRoutingMark: "DNS 监听路由标记（Linux，0 为禁用）",
  dnsFallbackLazyQuery: "延迟查询备用 DNS",
  dnsIpv6: "DNS IPv6",
  dnsEnhancedMode: "DNS 模式",
  dnsFakeIpRange: "Fake IP 网段",
  defaultNameservers: "DNS 服务器域名解析",
  nameservers: "常规 DNS 解析",
  fallbackNameservers: "备用 DNS 解析",
  fallbackFilterGeoip: "备用 DNS GeoIP 过滤",
  fallbackFilterIpcidr: "备用 DNS IP 过滤",
  fakeIpFilter: "绕过 Fake IP 的域名",
  ruleProviders: "原生规则提供者 YAML",
  skipServerCertVerify: "跳过服务器证书校验",
  h2: "HTTP/2",
  hostname: "主机名",
  caPassphrase: "CA 密码",
  caP12: "CA PKCS#12",
  log: "日志",
  dns: "DNS",
  inbounds: "入站",
  route: "路由",
  experimental: "高级设置",
  servers: "解析器",
  final: "默认项",
  tag: "名称",
  type: "类型",
  server: "服务器",
  server_port: "服务器端口",
  listen: "监听地址",
  listen_port: "监听端口",
  address: "接口地址",
  auto_route: "自动路由",
  route_exclude_address: "排除路由",
  default_domain_resolver: "默认域名解析器",
  auto_detect_interface: "自动检测接口",
  cache_file: "本地缓存",
  enabled: "启用",
  level: "日志级别",
  timestamp: "时间戳",
  rule_set: "规则集",
  name: "名称",
  url: "URL",
  fetchUserAgent: "抓取 User-Agent",
  format: "输入格式",
  order: "顺序",
  config: "节点配置（Surge / YAML / sing-box JSON）",
  chainExit: "作为链式出口",
  includeInGroups: "加入策略组",
  chainFilter: "前置节点筛选",
  filter: "筛选条件",
  policy: "策略",
  sourceIds: "规则来源 ID",
  inlineRules: "内联规则",
  surgeOptions: "Surge 选项",
  aggregateByPolicy: "按策略聚合规则集",
  directRules: "直接规则",
  outputs: "规则集编排",
  ruleSets: "规则编排",
  authKey: "认证密钥",
  controlUrl: "控制 URL",
  sectionName: "区段名称",
  derpOnly: "仅 DERP",
  exitNode: "出口节点",
  idleKeepalive: "空闲保活",
  preferIpv6: "优先 IPv6",
  mtu: "MTU",
  underlyingProxy: "底层代理",
  testUrl: "检测 URL",
  testTimeout: "检测超时",
  rule: "规则",
  value: "匹配值"
};
const CLIENT_SECTIONS = {
  surge: {
    network: ["ipv6", "ipv6Vif", "allowWifiAccess", "skipProxy", "tunExcludedRoutes", "wifiAssist", "excludeSimpleHostnames", "managedConfigIntervalSeconds", "internetTestUrl", "proxyTestUrl", "showErrorPageForReject"],
    dns: ["dnsServer", "encryptedDnsServer", "encryptedDnsFollowOutboundMode", "alwaysRealIp", "hosts"],
    rules: ["rules"],
    advanced: ["urlRewrite", "mapLocal", "scripts"],
    tailscale: ["tailscaleNodes"],
    mitm: ["mitm"]
  },
  clash: {
    network: ["port", "socksPort", "mixedPort", "allowLan", "mode", "logLevel", "ipv6", "unifiedDelay", "tcpConcurrent", "externalController", "tun"],
    dns: ["dnsEnabled", "dnsListen", "dnsListenRoutingMark", "dnsFallbackLazyQuery", "dnsIpv6", "dnsEnhancedMode", "dnsFakeIpRange", "defaultNameservers", "nameservers", "fallbackNameservers", "fallbackFilterGeoip", "fallbackFilterIpcidr", "fakeIpFilter"],
    rules: ["rules", "ruleProviders"]
  },
  singbox: { network: ["inbounds"], dns: ["dns"], rules: ["route"], tailscale: ["endpoints"], advanced: ["log", "experimental"] }
};
function getPath(object, path) {
  return path.split(".").reduce((value, key) => value?.[key], object);
}
function setPath(object, path, value) {
  const parts = path.split(".");
  if (parts.some((key) => ["__proto__", "prototype", "constructor"].includes(key))) throw Error("Invalid field path");
  const last = parts.pop();
  const parent = parts.reduce((v, key) => v[key], object);
  parent[last] = value;
}
function splitRule(line) {
  const result = [];
  let current = "", depth = 0, quote = "", escaped = false;
  for (const char of line) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === "\\") { current += char; escaped = true; continue; }
    if (quote) { current += char; if (char === quote) quote = ""; continue; }
    if (char === '"' || char === "'") { current += char; quote = char; continue; }
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) {
      result.push(current.trim());
      current = "";
    } else current += char;
  }
  result.push(current.trim());
  return result;
}
export {
  CLIENTS,
  CLIENT_SECTIONS,
  LABELS,
  NAV,
  getPath,
  setPath,
  splitRule
};
