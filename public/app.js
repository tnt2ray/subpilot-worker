let state = null;
let lastSavedState = null;
let fetchStats = null;
let statusStatsRefreshPromise = null;
let statusStatsRefreshVersion = 0;
let fetchRecordsPage = 1;
let geoIpMmdbStatus = { uploaded: false };
let currentReadToken = "";
let currentPreviewTarget = "";
let currentPreviewContent = "";
let previewLoadingTarget = "";
let surgeValidationRunning = false;
let saveStatusResetTimer = 0;
let telegramBindPollTimer = 0;
let codeMirrorLoadPromise = null;

const PAGES = ["status", "settings", "groups", "sources", "surge", "clash", "tokens"];
const EDITABLE_PAGES = new Set(["settings", "groups", "sources", "surge", "clash"]);
const CODE_EDITOR_PAGES = new Set(["surge", "clash"]);
const FETCH_RECORDS_PAGE_SIZE = 10;
const DEFAULT_CLASH_MODE = "Rule";
const DEFAULT_CLASH_LOG_LEVEL = "info";
let activePage = getPageFromHash();
const renderedPages = new Set();

const I18N = {
  title: "SubPilot 控制台",
  navStatus: "状态",
  navSystem: "系统",
  navConfiguration: "配置",
  navPolicyGroups: "策略组",
  navSources: "订阅源",
  navSurge: "Surge",
  navClash: "Clash",
  navAccess: "访问",
  navTokens: "配置链接",
  pageStatusTitle: "状态",
  pageStatusDescription: "查看服务状态、订阅数量和最近获取记录。",
  pageSettingsTitle: "配置",
  pageSettingsDescription: "编辑生成行为、上游请求头、缓存策略和链式代理。",
  pageGroupsTitle: "策略组",
  pageGroupsDescription: "按输出顺序编辑 Surge 与 Clash 的策略组。",
  pageSourcesTitle: "订阅源",
  pageSourcesDescription: "管理上游订阅地址和拉取方式；启用的订阅会参与配置生成。",
  pageSurgeTitle: "Surge",
  pageSurgeDescription: "管理 Surge 输出所需的通用设置、规则、脚本和 MITM 选项。",
  pageClashTitle: "Clash",
  pageClashDescription: "管理 Clash 输出所需的端口、TUN、DNS 和规则配置。",
  pageTokensTitle: "配置链接",
  pageTokensDescription: "复制自动识别订阅链接，并生成 Surge 或 Clash 配置预览。",
  idle: "保存并应用",
  saving: "保存中",
  saved: "已保存",
  saveFailed: "保存失败：",
  saveApply: "保存并应用",
  loginTitle: "管理员登录",
  adminToken: "管理令牌",
  secretTokenPlaceholder: "输入管理令牌",
  adminTokenHelp: "请输入管理员令牌以进入控制台。",
  login: "登录",
  configurationTitle: "SubPilot 配置",
  managedBaseUrl: "托管基础地址",
  managedBaseUrlHelp: "用于生成订阅链接的基础地址，通常保持当前域名即可。",
  surgeUserAgent: "Surge User-Agent",
  surgeUserAgentHelp: "拉取上游订阅并生成 Surge 输出时发送。",
  clashUserAgent: "Clash User-Agent",
  clashUserAgentHelp: "拉取上游订阅并生成 Clash 输出时发送。",
  excludeKeywords: "排除关键词",
  excludeKeywordsHelp: "逗号分隔，节点名称包含这些关键词时会在策略组生成前移除。",
  featureTagRules: "能力标签规则",
  featureTagRulesHelp: "每行一个规则，格式为 标签=关键词1,关键词2。命中原始节点名后会追加标签。",
  geoIpMmdb: "GeoIP MMDB",
  chooseGeoIpMmdb: "选择 .mmdb",
  uploadGeoIpMmdb: "上传",
  uploadGeoIpMmdbUploading: "上传中",
  geoIpMmdbStatusEmpty: "尚未上传 MMDB。",
  geoIpMmdbStatusReady: "当前文件：{fileName}，{size}，上传时间 {time}。",
  geoIpMmdbSelectFile: "请先选择 .mmdb 文件。",
  geoIpMmdbUploadFailed: "上传 MMDB 失败：",
  geoIpMmdbMissingNotice: "未上传 MMDB 时，服务只能使用已有的单 IP 记录识别地区；没有记录的 IP 节点无法自动判断国家/地区，会影响 IP 节点重命名、按地区筛选和链式节点地区匹配的完整性。",
  geoIpMmdbHelp: "上传 MaxMind DB Country 格式 .mmdb 后，IP 节点地区识别会优先使用该库。",
  geoIpMmdbPathHelp: "可从本机客户端选择现有文件：",
  telegramNotification: "Telegram 配置",
  telegramBotTokenPlaceholder: "Bot Token",
  telegramBindCode: "生成绑定命令",
  telegramBindCodeLoading: "生成中",
  telegramBindMissingToken: "请先填写 Bot Token。",
  telegramBindFailed: "生成绑定命令失败：",
  telegramUnbind: "解除绑定",
  telegramUnbindConfirm: "确定解除当前 Telegram 通知绑定吗？",
  telegramUnbindFailed: "解除绑定失败：",
  telegramBindCommandHelp: "10 分钟内发送给 Telegram bot：",
  telegramBindStatusBound: "已绑定 Telegram 会话。需要更换接收会话时，请先解除绑定。",
  telegramBindStatusUnbound: "尚未绑定 Telegram 会话。填写 Bot Token 后生成绑定命令，并发送给你的 bot。",
  telegramBindCommandSteps: "下一步：打开 Telegram，把下面这条命令发送给 bot。绑定成功后 bot 会回复确认消息。",
  telegramBindCommandExpires: "过期时间：{time}",
  telegramNotificationHelp: "填写 Bot Token 即启用 Telegram 通知；清空 Bot Token 即关闭通知。生成一次性绑定命令后，把命令发送给 bot，系统会通过 webhook 自动记录 Chat ID。",
  sourceCacheRefreshFailed: "强制获取完成，但有 {count} 个订阅源失败：\n{warnings}",
  sourceCacheNotificationWarnings: "\n\n通知状态：\n{warnings}",
  sourceCacheStatus: "上游缓存",
  chainExitProxy: "链式出口节点",
  chainExitProxyHelp: "生成配置时会自动创建名为 Chain Exit 的出口节点。",
  chainExitServer: "服务器地址",
  chainExitPort: "端口",
  chainExitUsername: "用户名 / UUID / 加密方法",
  chainExitPassword: "密码 / token / psk",
  chainFilter: "链式节点过滤器",
  chainFilterHelp: "逗号分隔，按最终节点名、地区或能力标签筛选。命中的节点会额外生成经 Chain Exit 出口的链式节点。",
  groupsTitle: "策略组",
  addGroup: "添加策略组",
  newGroup: "新策略组",
  policyGroups: "策略组",
  tableDefinition: "生成规则",
  groupType: "类型",
  groupTypeHelpSelect: "手动选择一个策略组或节点，适合作为主入口组。",
  groupTypeHelpUrlTest: "自动测速并选择延迟最低的可用项；Surge 输出会使用 smart，Clash 输出会使用 url-test。",
  groupTypeHelpFallback: "按固定策略组顺序备用，前面的不可用才切到后面的。",
  groupTypeHelpLoadBalance: "在多个固定策略组之间分摊连接，适合同地区、质量接近的线路。",
  groupTypeHelpSubnet: "根据当前网络环境选择策略。此类型仅输出到 Surge；Clash 会跳过此组，并把规则中引用它的目标回退到 Proxy。",
  groupTypeLabelSelect: "手动选择",
  groupTypeLabelAuto: "自动选择",
  groupTypeLabelFallback: "故障转移",
  groupTypeLabelLoadBalance: "负载均衡",
  groupTypeLabelSubnet: "按网络环境",
  groupFixedChoices: "纳入其它策略组",
  groupFixedChoicesHelp: "选择已添加的其它策略组；Proxy 是保底组。节点请通过“自动加入订阅源节点”加入。",
  noGroupChoices: "暂无可选策略组",
  groupIncludeAll: "自动加入订阅源节点",
  groupFilterKeywords: "纳入包含以下关键字的节点",
  groupExcludeKeywords: "排除以下关键字的节点",
  groupNodeRuleHelp: "留空时向该策略组添加所有可用节点；包含与排除条件会同时生效。",
  groupSubnetDefault: "默认策略",
  groupSubnetDefaultHelp: "必填。没有命中任何网络条件时使用；可选 Proxy、其它策略组或 Surge 内置策略，不能选择当前组本身。",
  groupSubnetRules: "网络条件映射",
  groupSubnetRulesHelp: "可选参数，可按顺序重复添加；每条条件都需要选择参数、查询值和使用策略。SSID/BSSID 支持通配符。",
  groupSubnetAddRule: "添加条件",
  groupSubnetNoRules: "暂无网络条件；未命中任何条件时会使用默认策略。",
  groupSubnetParameter: "参数",
  groupSubnetQuery: "查询值",
  groupSubnetPolicy: "使用策略",
  groupSubnetParamSsid: "Wi-Fi 名称",
  groupSubnetParamBssid: "BSSID",
  groupSubnetParamRouter: "路由器 IP",
  groupSubnetParamType: "网络类型",
  groupSubnetTypeWifi: "Wi-Fi",
  groupSubnetTypeWired: "有线",
  groupSubnetTypeCellular: "蜂窝",
  groupUrl: "测试 URL",
  groupInterval: "间隔秒数",
  groupAdvancedOptions: "其它参数",
  groupAdvancedOptionsHelp: "逗号分隔的原始 key=value 参数，仅在需要高级选项时填写。",
  groupGeneratedDefinition: "生成定义",
  groupEnabled: "启用此组",
  builtInGroup: "不可删除",
  builtInGroupHelp: "Proxy 名称固定且不可删除。",
  sourcesTitle: "订阅源",
  addSource: "添加订阅源",
  tableName: "名称",
  tableFetchUserAgent: "拉取 User-Agent",
  tableEnabled: "启用",
  tableUrl: "订阅 URL",
  tableAction: "操作",
  sourceFetchUserAgentHelp: "选择请求该订阅地址时使用的客户端标识。",
  sourceNameHelp: "用于标识节点来源，生成时会作为节点名前缀。",
  sourceUrlHelp: "上游订阅地址。启用后会参与 Surge 和 Clash 配置生成。",
  fetchUserAgentSurge: "Surge User-Agent",
  fetchUserAgentClash: "Clash User-Agent",
  remove: "移除",
  newSource: "新订阅源",
  textEditMode: "文本编辑模式",
  structuredEditMode: "结构化编辑模式",
  generatedOutput: "生成结果",
  textConfigContent: "文本配置",
  surgeConfigTitle: "Surge 功能配置",
  surgeTabGeneral: "General",
  surgeTabHost: "Host",
  surgeTabUrlRewrite: "URL Rewrite",
  surgeTabScript: "Script",
  surgeTabMitm: "MITM",
  surgeTabPonte: "Ponte",
  surgeTabRule: "Rule",
  surgeHosts: "Surge Host",
  surgeHostAdvancedMode: "文本编辑模式",
  addSurgeHost: "添加 Host 规则",
  surgeHostName: "主机名",
  surgeHostValue: "解析值",
  surgeHostOutput: "生成结果",
  surgeHostPonteNotice: "Ponte 外部访问局域网示例：在 Host 添加 lan-device.home -> 192.168.1.10，在 Ponte 页填写承载该局域网的设备名 Home-Mac，再在 Rule 中添加 DOMAIN,lan-device.home,DEVICE:Home-Mac。外部设备访问 http://lan-device.home:5000 时，会经 Ponte 设备访问 192.168.1.10:5000。",
  surgeHostEditorHelp: "Host 用于 Surge 本地 DNS 映射；可把域名映射到 IP、别名域名，或为某个域名指定 DNS 服务器。",
  surgeHostNoRows: "暂无 Host 规则。添加后会在下方生成 Surge [Host] 内容。",
  surgeHostValidationError: "存在无效 Surge Host 配置，已阻止保存。请修正后再保存。",
  surgeHostHelpName: "例如 example.com、*.dev、Macbook。",
  surgeHostHelpValue: "例如 1.2.3.4、1.1.1.1, 1.0.0.1、alias.example.com、server:8.8.8.8、server:system、server:https://cloudflare-dns.com/dns-query。",
  surgeUrlRewrite: "URL Rewrite",
  surgeUrlRewriteAdvancedMode: "文本编辑模式",
  addSurgeUrlRewrite: "添加 URL Rewrite",
  surgeUrlRewritePattern: "匹配正则",
  surgeUrlRewriteReplacement: "替换值",
  surgeUrlRewriteType: "动作",
  surgeUrlRewriteOutput: "生成结果",
  surgeUrlRewriteHttpsMitmNotice: "如果 URL Rewrite 匹配 https:// 请求，必须在 MITM 页启用对应主机名，否则该规则不会生效。",
  surgeUrlRewriteEditorHelp: "URL Rewrite 用于按 URL 正则执行 header 重写、302 跳转或 reject 拒绝。",
  surgeUrlRewriteNoRows: "暂无 URL Rewrite。添加后会在下方生成 Surge [URL Rewrite] 内容。",
  surgeUrlRewriteValidationError: "存在无效 Surge URL Rewrite 配置，已阻止保存。请修正后再保存。",
  surgeUrlRewriteReplacementHelp: "reject 动作可使用 -；header 和 302 需要填写 http 或 https URL。",
  surgeScripts: "Surge 脚本",
  surgeScriptsHelp: "填写脚本定义，每行一条，例如：名称 = type=...,pattern=...,script-path=...。",
  surgeScriptValidationError: "存在无效 Surge 脚本配置，已阻止保存。请修正后再保存。",
  surgeMitmOptions: "MITM 选项",
  surgeMitmCertificateNotice: "MITM 解密 HTTPS 前，需要生成或导入 CA 证书，并在使用该配置的设备上安装且信任该证书。",
  surgeMitmSkipServerCertVerify: "跳过服务器证书验证",
  surgeMitmH2: "启用 HTTP/2 解密",
  surgeMitmOptionsHelp: "启用证书校验跳过可以绕过上游证书异常，但也会降低连接校验强度。",
  surgeMitmHostname: "MITM 主机名",
  surgeMitmHostnameHelp: "Surge 只会对这里列出的域名执行 HTTPS 解密。每行一个主机名，支持通配符。",
  surgeMitmCa: "MITM CA",
  generateSurgeMitmCa: "生成 CA 证书",
  generateSurgeMitmCaPassphrase: "生成 CA 密码",
  importSurgeMitmCaP12: "导入 .p12",
  surgeMitmCaGenerating: "正在生成 CA 证书...",
  surgeMitmCaGenerated: "CA 证书已生成，证书包已填入，并已开始下载 .p12 文件。",
  surgeMitmCaFailed: "CA 证书生成失败：",
  surgeMitmCaHelp: "可在当前浏览器生成 CA 证书，或选择 .p12/.pfx 文件导入。CA 私钥会进入配置文件，请保护管理令牌和读取链接。",
  addSurgeRule: "添加单条规则",
  addSurgeRuleSet: "添加规则集",
  surgeRuleKind: "类型",
  surgeRuleKindSingle: "单条规则",
  surgeRuleKindRuleSet: "规则集",
  surgeRuleSetType: "集合类型",
  surgeRuleType: "规则类型",
  surgeRuleValue: "匹配值",
  surgeRuleSetName: "规则集地址",
  surgeRulePolicy: "策略出口",
  surgeRuleOptions: "附加参数",
  surgeRuleOptionNone: "无",
  surgeRuleOptionInvalid: "附加参数不适用于当前规则类型。",
  surgeRuleOutput: "生成结果",
  surgeRuleAdvancedMode: "文本编辑模式",
  surgeRuleEditorHelp: "规则集和单条规则使用不同语法；策略出口只能选择已配置策略组或 Surge 内置策略。",
  surgeRuleNoRows: "暂无规则。添加规则后会在下方生成 Surge [Rule] 内容。",
  surgeRuleUnknownPolicy: "策略出口必须是已配置策略组或 Surge 内置策略。",
  surgeRuleFinalLocked: "FINAL 是兜底规则，固定在最后，不能删除或移动。",
  surgeRuleFinalMissing: "必须保留一个 FINAL 兜底规则。",
  surgeRuleFinalDuplicate: "只能保留一个 FINAL 兜底规则。",
  surgeRuleFinalNotLast: "FINAL 兜底规则必须位于最后。",
  surgeRuleValidationError: "存在无效 Surge 规则，已阻止保存。请修正后再保存。",
  moveUp: "上移",
  moveDown: "下移",
  clashConfigTitle: "Clash 功能配置",
  clashTabGeneral: "General",
  clashTabDns: "DNS",
  clashTabProviders: "规则集",
  clashTabRules: "Rule",
  skipProxy: "跳过代理",
  skipProxyHelp: "这些主机、域名或网段不进入代理处理，通常用于本机、局域网、运营商保留地址和系统探测域名。",
  dnsServer: "DNS 服务器",
  dnsServerHelp: "Surge 普通 DNS 解析使用的服务器列表，按顺序尝试。使用逗号分隔。",
  alwaysRealIp: "始终真实 IP",
  alwaysRealIpHelp: "匹配这些域名时始终返回真实 IP，适合游戏、STUN、语音视频等不适合 fake-ip 的服务。使用逗号分隔。",
  internetTestUrl: "联网测试地址",
  internetTestUrlHelp: "Surge 用这个地址判断当前网络是否可直连互联网，通常使用返回 204 的探测 URL。",
  proxyTestUrl: "代理测试地址",
  proxyTestUrlHelp: "Surge 用这个地址测试代理连通性，通常使用稳定返回 204 的探测 URL。",
  managedConfigInterval: "主配置更新间隔",
  managedConfigIntervalHelp: "写入 #!MANAGED-CONFIG 的 interval，单位秒；默认 43200（12 小时）。",
  showErrorPageForReject: "Reject 错误页",
  showErrorPageForRejectHelp: "启用后，HTTP 请求命中 REJECT 规则时显示 Surge 错误页，便于识别拦截原因。",
  ipv6Help: "控制 Surge 输出中是否启用 IPv6。",
  ipv6Vif: "IPv6 虚拟接口",
  ipv6VifHelp: "控制 Surge 虚拟接口的 IPv6 行为。off 不启用 IPv6 VIF，auto 在本地网络支持 IPv6 时自动启用，always 始终启用。",
  allowWifiAccess: "允许 Wi-Fi 访问",
  allowWifiAccessHelp: "启用后，同一 Wi-Fi 网络中的其它设备可以访问本机 Surge 代理端口。",
  tunExcludedRoutes: "TUN 排除路由",
  tunExcludedRoutesHelp: "这些网段不会被 Surge TUN 接管，通常用于保留局域网、私有地址和组播发现地址的直连访问。使用逗号分隔。",
  encryptedDnsServer: "加密 DNS 服务器",
  encryptedDnsServerHelp: "Surge 使用的 DoH/DoQ 等加密 DNS 服务器列表。使用逗号分隔。",
  wifiAssist: "Wi-Fi Assist",
  wifiAssistHelp: "控制 Surge 是否启用 Wi-Fi Assist 网络辅助能力。",
  excludeSimpleHostnames: "排除简单主机名",
  excludeSimpleHostnamesHelp: "启用后，不带点号的简单主机名不会交给远端 DNS，适合保留局域网主机名解析。",
  encryptedDnsFollowOutboundMode: "加密 DNS 跟随出站模式",
  encryptedDnsFollowOutboundModeHelp: "启用后，加密 DNS 查询会跟随当前出站模式，避免 DNS 流量绕过当前策略。",
  surgePonteDeviceNames: "Ponte 设备名",
  surgePonteDeviceNamesHelp: "填写 Surge Ponte 设备名，逗号分隔；保存后可在 Rule 的策略出口中选择 DEVICE:<设备名>。",
  surgeRules: "Surge 规则",
  ports: "端口",
  clashHttpPort: "HTTP 代理端口",
  clashHttpPortHelp: "HTTP 代理入口，供浏览器或系统 HTTP 代理使用。",
  clashSocksPort: "SOCKS5 代理端口",
  clashSocksPortHelp: "SOCKS5 代理入口，供支持 SOCKS5 的应用使用。",
  clashMixedPort: "混合代理端口",
  clashMixedPortHelp: "同时接受 HTTP 和 SOCKS5，通常作为默认代理入口。",
  clashNetworkOptions: "网络选项",
  clashAllowLanHelp: "允许局域网其它设备访问 Clash 代理端口。",
  clashIpv6Help: "控制 Clash 输出中是否启用 IPv6 解析和连接。",
  modeAndLog: "模式 / 日志级别",
  clashExternalController: "external-controller",
  clashExternalControllerHelp: "Clash 外部控制器监听地址；0.0.0.0:9090 表示监听所有 IPv4 网络接口，不按来源地址限制访问。",
  clashRuntimeOptions: "运行选项",
  clashUnifiedDelay: "统一延迟",
  clashUnifiedDelayHelp: "统一节点测速口径，减少握手差异造成的延迟偏差。",
  clashTcpConcurrent: "TCP 并发",
  clashTcpConcurrentHelp: "对同一域名解析出的多个 IP 并发连接，使用最先连通的地址。",
  clashTunMode: "TUN 模式",
  clashTunEnableHelp: "通过 TUN 接管系统流量；关闭后隐藏相关设置，并从生成结果中移除 tun 配置。",
  clashTunRouteOptions: "TUN 路由 / 栈",
  clashTunAutoRoute: "自动路由",
  clashTunAutoRouteHelp: "自动添加系统路由，把匹配流量导入 TUN。",
  clashTunAutoDetectInterface: "自动检测接口",
  clashTunAutoDetectInterfaceHelp: "自动识别当前出口网卡，减少手动指定接口的需要。",
  clashTunStack: "TUN 栈",
  clashTunStackHelp: "选择 TUN 网络栈实现；system 使用系统栈，gvisor 使用用户态栈，mixed 由客户端混合处理。",
  clashTunSkipProxy: "TUN 跳过代理",
  clashTunSkipProxyHelp: "TUN 开启时每行一个地址或网段；这些目标不进入 TUN 代理处理。",
  dnsSettings: "DNS 设置",
  dnsEnabled: "启用 DNS",
  dnsEnabledHelp: "启用 Clash 内置 DNS 服务，下面的 DNS 解析配置才会生效。",
  dnsIpv6: "DNS IPv6",
  dnsIpv6Help: "允许 DNS 返回 IPv6 结果；是否实际连接 IPv6 还受 General 中 IPv6 开关影响。",
  clashDnsListen: "listen",
  clashDnsListenHelp: "DNS 服务监听地址，只有启用 DNS 后生效。",
  clashDnsResolveOptions: "DNS 解析方式",
  clashDnsResolveMode: "返回模式",
  clashDnsEnhancedMode: "DNS 处理模式",
  clashDnsEnhancedModeHelp: "选择 Clash DNS 如何返回解析结果：fake-ip 返回虚拟 IP，适合 TUN 和透明代理；redir-host 返回真实 IP，兼容性较高。",
  clashDnsFakeIpRange: "fake-ip-range",
  clashDnsFakeIpRangeHelp: "仅返回模式为 fake-ip 时生效；用于设置 fake-ip 使用的 IPv4 地址段。",
  clashDefaultNameservers: "默认 DNS",
  clashDefaultNameserversHelp: "每行一个基础 DNS，通常填写纯 IP；用于解析 DNS 服务器本身的域名。",
  nameservers: "DNS 服务器",
  nameserversHelp: "每行一个上游 DNS；Clash DNS 默认优先使用这里的服务器解析域名。",
  clashFallbackNameservers: "Fallback DNS",
  clashFallbackNameserversHelp: "每行一个备用 DNS；Fallback 过滤命中时使用这里的解析结果。",
  clashFallbackFilter: "Fallback 过滤",
  clashFallbackFilterGeoipHelp: "根据 GeoIP 判断主 DNS 结果是否需要回退；命中时使用 Fallback DNS。",
  clashFallbackFilterIpcidrHelp: "每行一个 IP 或 CIDR；主 DNS 结果命中这些地址段时使用 Fallback DNS。",
  clashFakeIpFilter: "Fake-IP 过滤",
  clashFakeIpFilterHelp: "仅返回模式为 fake-ip 时生效；匹配的域名返回真实解析结果，不分配 fake-ip。",
  clashRuleProviders: "规则集提供者",
  clashRuleProviderAdvancedMode: "文本编辑模式",
  addClashRuleProvider: "添加规则集",
  clashRuleProviderNoRows: "暂无规则集提供者。",
  clashRuleProviderName: "名称",
  clashRuleProviderType: "类型",
  clashRuleProviderBehavior: "行为",
  clashRuleProviderUrl: "URL",
  clashRuleProviderInterval: "更新间隔",
  clashRuleProvidersYaml: "YAML",
  clashRuleProvidersStructuredHelp: "结构化模式用于编辑常用字段，保存时会写入标准 Clash rule-providers YAML。",
  clashRuleProvidersHelp: "YAML 顶层固定为 rule-providers；每个规则集可配置 type、behavior、url、interval，path 由系统按名称生成。",
  clashRuleProviderValidationError: "规则集配置存在错误，请先修正。",
  clashRules: "Clash 规则",
  clashRuleAdvancedMode: "文本编辑模式",
  addClashRule: "添加单条规则",
  addClashRuleSet: "添加规则集",
  clashRuleKind: "类型",
  clashRuleKindSingle: "单条规则",
  clashRuleKindRuleSet: "规则集",
  clashRuleType: "规则类型",
  clashRuleValue: "匹配值",
  clashRuleSetName: "规则集名称",
  clashRulePolicy: "策略出口",
  clashRuleOptions: "附加参数",
  clashRulesYaml: "YAML",
  clashRuleStructuredHelp: "结构化模式按顺序编辑 Clash 规则；规则从上到下匹配，命中后停止。rule-providers 中的规则集会自动补入 rules，并默认使用 Proxy。",
  clashRulesHelp: "YAML 顶层固定为 rules；每一项使用标准 Clash 规则语法，例如 RULE-SET,Google,Proxy 或 MATCH,Proxy。",
  clashRuleNoRows: "暂无规则。添加后会在下方生成标准 Clash rules YAML。",
  clashRuleUnknownPolicy: "策略出口必须是已配置策略组或 Clash 内置策略。",
  clashRuleUnknownProvider: "规则集名称必须来自 rule-providers。",
  clashRuleSetDeleteProviderConfirm: "删除规则集规则 {name} 会同时删除 rule-providers 中的同名规则集。是否继续？",
  clashRuleMatchLocked: "MATCH 是兜底规则，固定在最后，不能删除或移动。",
  clashRuleMatchMissing: "必须保留一个 MATCH 兜底规则。",
  clashRuleMatchDuplicate: "只能保留一个 MATCH 或 FINAL 兜底规则。",
  clashRuleMatchNotLast: "MATCH 或 FINAL 兜底规则必须位于最后。",
  clashRuleValidationError: "存在无效 Clash 规则，已阻止保存。请修正后再保存。",
  linksTitle: "配置链接",
  automaticLink: "自动识别",
  rotateReadToken: "刷新订阅令牌",
  copyLink: "复制",
  copied: "已复制",
  copyFailed: "复制失败",
  previewTitle: "配置预览",
  previewEmpty: "点击上方按钮生成预览。",
  previewLoading: "正在生成 {target} 配置预览，请稍候...",
  previewFailed: "配置预览生成失败：",
  validateSurgeOnline: "Surge 在线验证",
  validateSurgeOnlineRisk: "在线验证会将后台生成的脱敏 Surge 配置提交至 services.nssurge.com；真实代理服务器、端口、用户名、密码、token、SNI、WebSocket Host 和外部资源地址不会提交，规则内容仍会用于校验。是否继续？",
  validateSurgeOnlineRunning: "正在提交 Surge 在线验证...",
  validateSurgeOnlinePassed: "Surge 在线验证通过。",
  validateSurgeOnlineFailed: "Surge 在线验证失败：",
  statusTitle: "SubPilot 状态",
  sources: "订阅源",
  fetchRecordsTitle: "配置获取记录",
  fetchColumnTarget: "配置",
  fetchColumnTime: "最近获取",
  fetchColumnUa: "客户端 UA",
  fetchColumnNetwork: "IP / 位置",
  fetchRecordsPrev: "上一页",
  fetchRecordsNext: "下一页",
  fetchRecordsPageInfo: "{start}-{end} / {total}",
  fetchTargetSurge: "Surge 配置",
  fetchTargetClash: "Clash 配置",
  neverFetched: "尚未获取",
  noRecentUa: "暂无获取记录",
  unknownIp: "未知 IP",
  unknownLocation: "未知位置",
  emptyCell: "-",
  sourceCacheEmpty: "当前没有上游订阅缓存",
  sourceCacheUnknown: "等待定时任务或手动强制获取",
  sourceCacheUpdatedAt: "{count} 项缓存，上次刷新 {time}",
  sourceCacheCoverage: "订阅源缓存：{cached} / {expected}",
  sourceCacheCoverageReady: "全部已缓存",
  sourceCacheCoverageMissing: "缺 {count} 个",
  sourceCacheEntryCount: "缓存条目：{count}",
  sourceCacheUpdatedLabel: "更新时间：{time}",
  sourceCacheProtocols: "协议节点：{value}",
  sourceCacheNoNodes: "未解析到节点",
  sourceCacheSourceCached: "{name}：已缓存，{count} 个节点",
  sourceCacheSourceMissing: "{name}：未缓存",
  refreshSourceCache: "强制获取",
  refreshingSourceCache: "获取中",
  enabled: "已启用",
  disabled: "已禁用"
};

const $ = (id) => document.getElementById(id);
const refs = {
  pageTitle: $("pageTitle"),
  pageDescription: $("pageDescription"),
  pageHead: $("pageHead"),
  mainMenu: $("mainMenu"),
  loginPanel: $("loginPanel"),
  workspace: $("workspace"),
  adminToken: $("adminToken"),
  loginBtn: $("loginBtn"),
  saveBtn: $("saveBtn"),
  groupsBody: $("groupsBody"),
  addGroupBtn: $("addGroupBtn"),
  sourcesBody: $("sourcesBody"),
  addSourceBtn: $("addSourceBtn"),
  saveSourcesBtn: $("saveSourcesBtn"),
  managedBaseUrl: $("managedBaseUrl"),
  userAgentSurge: $("userAgentSurge"),
  userAgentClash: $("userAgentClash"),
  excludeKeywords: $("excludeKeywords"),
  featureTagRules: $("featureTagRules"),
  geoIpMmdbFile: $("geoIpMmdbFile"),
  uploadGeoIpMmdbBtn: $("uploadGeoIpMmdbBtn"),
  geoIpMmdbStatus: $("geoIpMmdbStatus"),
  geoIpMmdbMissingNotice: $("geoIpMmdbMissingNotice"),
  notificationTelegramBotToken: $("notificationTelegramBotToken"),
  telegramBindStatus: $("telegramBindStatus"),
  telegramBindCodeBtn: $("telegramBindCodeBtn"),
  chainExitProtocol: $("chainExitProtocol"),
  chainExitServer: $("chainExitServer"),
  chainExitPort: $("chainExitPort"),
  chainExitUsername: $("chainExitUsername"),
  chainExitPassword: $("chainExitPassword"),
  chainFilter: $("chainFilter"),
  surgeSkipProxy: $("surgeSkipProxy"),
  surgeDnsServer: $("surgeDnsServer"),
  surgeAlwaysRealIp: $("surgeAlwaysRealIp"),
  surgeInternetTestUrl: $("surgeInternetTestUrl"),
  surgeProxyTestUrl: $("surgeProxyTestUrl"),
  surgeManagedConfigIntervalSeconds: $("surgeManagedConfigIntervalSeconds"),
  surgeShowErrorPageForReject: $("surgeShowErrorPageForReject"),
  surgeIpv6: $("surgeIpv6"),
  surgeIpv6VifRow: $("surgeIpv6VifRow"),
  surgeIpv6Vif: $("surgeIpv6Vif"),
  surgeAllowWifiAccess: $("surgeAllowWifiAccess"),
  surgeTunExcludedRoutes: $("surgeTunExcludedRoutes"),
  surgeEncryptedDnsServer: $("surgeEncryptedDnsServer"),
  surgeWifiAssist: $("surgeWifiAssist"),
  surgeExcludeSimpleHostnames: $("surgeExcludeSimpleHostnames"),
  surgeEncryptedDnsFollowOutboundMode: $("surgeEncryptedDnsFollowOutboundMode"),
  surgePonteDeviceNames: $("surgePonteDeviceNames"),
  surgeHostAdvancedMode: $("surgeHostAdvancedMode"),
  surgeHostStructuredEditor: $("surgeHostStructuredEditor"),
  addSurgeHostBtn: $("addSurgeHostBtn"),
  surgeHostRows: $("surgeHostRows"),
  surgeHostValidation: $("surgeHostValidation"),
  surgeHosts: $("surgeHosts"),
  surgeHostsLabel: document.querySelector('label[for="surgeHosts"]'),
  surgeUrlRewriteAdvancedMode: $("surgeUrlRewriteAdvancedMode"),
  surgeUrlRewriteStructuredEditor: $("surgeUrlRewriteStructuredEditor"),
  addSurgeUrlRewriteBtn: $("addSurgeUrlRewriteBtn"),
  surgeUrlRewriteRows: $("surgeUrlRewriteRows"),
  surgeUrlRewriteValidation: $("surgeUrlRewriteValidation"),
  surgeUrlRewrite: $("surgeUrlRewrite"),
  surgeUrlRewriteLabel: document.querySelector('label[for="surgeUrlRewrite"]'),
  surgeScripts: $("surgeScripts"),
  surgeScriptValidation: $("surgeScriptValidation"),
  surgeMitmSkipServerCertVerify: $("surgeMitmSkipServerCertVerify"),
  surgeMitmH2: $("surgeMitmH2"),
  surgeMitmHostname: $("surgeMitmHostname"),
  generateSurgeMitmCaBtn: $("generateSurgeMitmCaBtn"),
  generateSurgeMitmCaPassphraseBtn: $("generateSurgeMitmCaPassphraseBtn"),
  surgeMitmCaP12File: $("surgeMitmCaP12File"),
  surgeMitmCaGenerationStatus: $("surgeMitmCaGenerationStatus"),
  surgeMitmCaPassphrase: $("surgeMitmCaPassphrase"),
  surgeMitmCaP12: $("surgeMitmCaP12"),
  surgeRuleAdvancedMode: $("surgeRuleAdvancedMode"),
  surgeRuleStructuredEditor: $("surgeRuleStructuredEditor"),
  surgeRuleStructuredActions: $("surgeRuleStructuredActions"),
  addSurgeRuleBtn: $("addSurgeRuleBtn"),
  addSurgeRuleSetBtn: $("addSurgeRuleSetBtn"),
  surgeRuleRows: $("surgeRuleRows"),
  surgeRuleValidation: $("surgeRuleValidation"),
  surgeRules: $("surgeRules"),
  surgeRulesLabel: document.querySelector('label[for="surgeRules"]'),
  clashPort: $("clashPort"),
  clashSocksPort: $("clashSocksPort"),
  clashMixedPort: $("clashMixedPort"),
  clashAllowLan: $("clashAllowLan"),
  clashMode: $("clashMode"),
  clashLogLevel: $("clashLogLevel"),
  clashIpv6: $("clashIpv6"),
  clashUnifiedDelay: $("clashUnifiedDelay"),
  clashTcpConcurrent: $("clashTcpConcurrent"),
  clashExternalController: $("clashExternalController"),
  clashTunEnable: $("clashTunEnable"),
  clashTunStack: $("clashTunStack"),
  clashTunAutoRoute: $("clashTunAutoRoute"),
  clashTunAutoDetectInterface: $("clashTunAutoDetectInterface"),
  clashTunSkipProxy: $("clashTunSkipProxy"),
  clashDnsEnabled: $("clashDnsEnabled"),
  clashDnsListen: $("clashDnsListen"),
  clashDnsIpv6: $("clashDnsIpv6"),
  clashDnsEnhancedMode: $("clashDnsEnhancedMode"),
  clashDnsFakeIpRange: $("clashDnsFakeIpRange"),
  clashDefaultNameservers: $("clashDefaultNameservers"),
  clashNameservers: $("clashNameservers"),
  clashFallbackNameservers: $("clashFallbackNameservers"),
  clashFallbackFilterGeoip: $("clashFallbackFilterGeoip"),
  clashFallbackFilterIpcidr: $("clashFallbackFilterIpcidr"),
  clashFakeIpFilter: $("clashFakeIpFilter"),
  clashRuleProviderAdvancedMode: $("clashRuleProviderAdvancedMode"),
  addClashRuleProviderBtn: $("addClashRuleProviderBtn"),
  clashRuleProviderStructuredEditor: $("clashRuleProviderStructuredEditor"),
  clashRuleProviderRows: $("clashRuleProviderRows"),
  clashRuleProviderValidation: $("clashRuleProviderValidation"),
  clashRuleProviders: $("clashRuleProviders"),
  clashRuleAdvancedMode: $("clashRuleAdvancedMode"),
  clashRuleStructuredEditor: $("clashRuleStructuredEditor"),
  clashRuleStructuredActions: $("clashRuleStructuredActions"),
  addClashRuleBtn: $("addClashRuleBtn"),
  addClashRuleSetBtn: $("addClashRuleSetBtn"),
  clashRuleRows: $("clashRuleRows"),
  clashRuleValidation: $("clashRuleValidation"),
  clashRules: $("clashRules"),
  rotateTokenBtn: $("rotateTokenBtn"),
  links: $("links"),
  previewOutput: $("previewOutput"),
  previewSurgeBtn: $("previewSurgeBtn"),
  previewClashBtn: $("previewClashBtn"),
  validateSurgeOnlineBtn: $("validateSurgeOnlineBtn"),
  surgeOnlineValidation: $("surgeOnlineValidation"),
  summarySources: $("summarySources"),
  summaryGroups: $("summaryGroups"),
  summarySourceCache: $("summarySourceCache"),
  refreshSourceCacheBtn: $("refreshSourceCacheBtn"),
  fetchRecordsTableBody: $("fetchRecordsTableBody"),
  fetchRecordsPagination: $("fetchRecordsPagination"),
  fetchRecordsPageInfo: $("fetchRecordsPageInfo"),
  fetchRecordsPrevBtn: $("fetchRecordsPrevBtn"),
  fetchRecordsNextBtn: $("fetchRecordsNextBtn")
};

const configCodeEditorRefs = [
  "surgeHosts",
  "surgeUrlRewrite",
  "surgeScripts",
  "surgeMitmHostname",
  "surgeMitmCaP12",
  "surgeRules",
  "clashTunSkipProxy",
  "clashDefaultNameservers",
  "clashNameservers",
  "clashFallbackNameservers",
  "clashFallbackFilterIpcidr",
  "clashFakeIpFilter",
  "clashRuleProviders",
  "clashRules"
];
const configCodeEditors = new Map();
const CONFIG_POLICY_HIGHLIGHT_BUILT_INS = [
  "Proxy",
  "DIRECT",
  "REJECT",
  "REJECT-DROP",
  "REJECT-NO-DROP",
  "REJECT-TINYGIF",
  "PASS",
  "GLOBAL"
];

const PREVIEW_TARGETS = ["surge", "clash"];
const PREVIEW_TARGET_LABELS = {
  surge: "Surge",
  clash: "Clash"
};

function isModeTogglePressed(button) {
  return button.getAttribute("aria-pressed") === "true";
}

function setModeTogglePressed(button, pressed) {
  button.setAttribute("aria-pressed", pressed ? "true" : "false");
}

function syncTextModeLabels(button, outputLabel, advanced) {
  button.textContent = t(advanced ? "structuredEditMode" : "textEditMode");
  if (outputLabel) {
    outputLabel.textContent = t(advanced ? "textConfigContent" : "generatedOutput");
  }
}

function configCodeEditorMaxRows(textarea) {
  const value = Number(textarea?.dataset?.codeEditorMaxRows || textarea?.getAttribute("rows") || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function configCodeEditorLineHeight(editor) {
  const line = editor.getWrapperElement().querySelector(".CodeMirror-line");
  const computed = window.getComputedStyle(line || editor.getWrapperElement());
  return Number.parseFloat(computed.lineHeight) || 20;
}

function configCodeEditorMode(textarea) {
  return textarea?.dataset?.codeEditorMode === "plain" ? null : "proxy-config";
}

function configPolicyHighlightCandidates() {
  const candidates = new Set(CONFIG_POLICY_HIGHLIGHT_BUILT_INS);
  Object.keys(state?.groups || {}).forEach((name) => {
    const trimmed = String(name || "").trim();
    if (trimmed) candidates.add(trimmed);
  });
  (state?.surge?.ponteDeviceNames || []).forEach((name) => {
    const trimmed = String(name || "").trim();
    if (trimmed) candidates.add(`DEVICE:${trimmed}`);
  });
  return [...candidates].sort((a, b) => b.length - a.length);
}

function hasConfigPolicyBoundary(stream) {
  const next = stream.peek();
  return !next || /[,\s\])]/.test(next);
}

function hasConfigPolicyStartBoundary(stream) {
  const previous = stream.pos > 0 ? stream.string.charAt(stream.pos - 1) : "";
  return !previous || /[,\s([=]/.test(previous);
}

function matchConfigPolicyToken(stream) {
  if (!hasConfigPolicyStartBoundary(stream)) return false;
  for (const policy of configPolicyHighlightCandidates()) {
    const start = stream.pos;
    if (stream.match(policy)) {
      if (hasConfigPolicyBoundary(stream)) return true;
      stream.pos = start;
    }
  }
  return Boolean(
    stream.match(/(?:DIRECT|Proxy|REJECT(?:-(?:DROP|NO-DROP|TINYGIF))?|PASS|GLOBAL)(?=\s*,|\s|\]|\)|$)/i)
    || stream.match(/DEVICE:[^,\s\])]+/i)
  );
}

function resizeConfigCodeEditor(textarea, editor) {
  const maxRows = configCodeEditorMaxRows(textarea);
  if (!maxRows) return;
  const lineHeight = configCodeEditorLineHeight(editor);
  const documentHeight = Math.max(lineHeight, editor.heightAtLine(editor.lastLine() + 1, "local", true));
  const height = Math.ceil(Math.min(documentHeight, maxRows * lineHeight) + 18);
  editor.setSize(null, height);
}

function loadStylesheet(href) {
  if (document.querySelector(`link[href="${href}"]`)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.addEventListener("load", () => resolve(), { once: true });
    link.addEventListener("error", () => reject(new Error(`Failed to load ${href}`)), { once: true });
    document.head.append(link);
  });
}

function loadScript(src) {
  if (document.querySelector(`script[src="${src}"]`)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)), { once: true });
    document.body.append(script);
  });
}

async function ensureConfigCodeEditors() {
  if (window.CodeMirror) {
    initConfigCodeEditors();
    refreshConfigCodeEditors();
    return true;
  }
  if (!codeMirrorLoadPromise) {
    codeMirrorLoadPromise = Promise.all([
      loadStylesheet("/vendor/codemirror/codemirror.css"),
      loadScript("/vendor/codemirror/codemirror.js")
    ]).then(() => {
      initConfigCodeEditors();
      refreshConfigCodeEditors();
      return true;
    }).catch((error) => {
      codeMirrorLoadPromise = null;
      console.warn(error);
      return false;
    });
  }
  return codeMirrorLoadPromise;
}

function ensureConfigCodeEditorsForPage(page = activePage) {
  if (!CODE_EDITOR_PAGES.has(page)) return;
  void ensureConfigCodeEditors();
}

function defineConfigCodeMirrorMode(CodeMirror) {
  if (!CodeMirror || CodeMirror.modes?.["proxy-config"]) return;
  CodeMirror.defineMode("proxy-config", () => ({
    token(stream) {
      if (stream.sol() && stream.match(/\s*[#;]/, false)) {
        stream.skipToEnd();
        return "comment";
      }
      if (stream.eatSpace()) return null;
      if (stream.match(/[;#].*/)) return "comment";
      if (stream.match(/\[[^\]]+\]/)) return "header";
      if (stream.match(/"(?:[^"\\]|\\.)*"/) || stream.match(/'(?:[^'\\]|\\.)*'/)) return "string";
      if (stream.match(/https?:\/\/[^\s,]+/i)) return "link";
      if (stream.match(/[A-Za-z][\w.-]*(?=\s*:)/)) return "attribute";
      if (stream.match(/(?:RULE-SET|DOMAIN-SET|DOMAIN-SUFFIX|DOMAIN-KEYWORD|DOMAIN-WILDCARD|DOMAIN|IP-CIDR6?|GEOIP|FINAL|URL-REGEX|PROCESS-NAME|SUBNET|AND|OR|NOT|SSID|BSSID|ROUTER|TYPE|DEVICE-NAME)(?=\s*,|\s|$)/i)) return "keyword";
      if (matchConfigPolicyToken(stream)) return "variable-2";
      if (stream.match(/(?:no-resolve|extended-matching|server:[^,\s]+|skip-server-cert-verify|ca-passphrase|ca-p12|hostname|h2)(?=\s*,|\s|=|$)/i)) return "attribute";
      if (stream.match(/[=,]/)) return "operator";
      if (stream.match(/-?\d+(?:\.\d+)?/)) return "number";
      stream.next();
      return null;
    }
  }));
}

function syncConfigCodeEditor(textarea) {
  const editor = configCodeEditors.get(textarea);
  if (!editor) return;
  const value = textarea.value || "";
  if (editor.getValue() !== value) {
    editor.state.subpilotSyncing = true;
    editor.setValue(value);
    editor.state.subpilotSyncing = false;
  }
  const readOnly = textarea.readOnly;
  if (editor.getOption("readOnly") !== readOnly) {
    editor.setOption("readOnly", readOnly);
  }
  if (editor.getOption("mode") !== configCodeEditorMode(textarea)) {
    editor.setOption("mode", configCodeEditorMode(textarea));
  }
  editor.getWrapperElement().classList.toggle("is-readonly", textarea.readOnly);
  resizeConfigCodeEditor(textarea, editor);
  requestAnimationFrame(() => {
    editor.refresh();
    resizeConfigCodeEditor(textarea, editor);
  });
}

function syncConfigCodeEditors() {
  for (const name of configCodeEditorRefs) {
    syncConfigCodeEditor(refs[name]);
  }
}

function refreshConfigCodeEditors() {
  requestAnimationFrame(() => {
    for (const [textarea, editor] of configCodeEditors.entries()) {
      editor.setOption("mode", configCodeEditorMode(textarea));
      editor.refresh();
      resizeConfigCodeEditor(textarea, editor);
    }
  });
}

function initConfigCodeEditors() {
  const CodeMirror = window.CodeMirror;
  if (!CodeMirror) return;
  defineConfigCodeMirrorMode(CodeMirror);
  for (const name of configCodeEditorRefs) {
    const textarea = refs[name];
    if (!textarea || configCodeEditors.has(textarea)) continue;
    const editor = CodeMirror.fromTextArea(textarea, {
      mode: configCodeEditorMode(textarea),
      lineNumbers: true,
      lineWrapping: true,
      tabSize: 2,
      indentUnit: 2,
      viewportMargin: 90,
      readOnly: textarea.readOnly,
      extraKeys: {
        Tab(cm) {
          if (cm.somethingSelected()) {
            cm.indentSelection("add");
            return;
          }
          cm.replaceSelection("  ", "end");
        }
      }
    });
    editor.getWrapperElement().classList.add("config-code-editor");
    editor.getWrapperElement().classList.toggle("is-auto-height", Boolean(configCodeEditorMaxRows(textarea)));
    editor.on("change", () => {
      if (editor.state.subpilotSyncing) return;
      editor.save();
      resizeConfigCodeEditor(textarea, editor);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    configCodeEditors.set(textarea, editor);
    syncConfigCodeEditor(textarea);
  }
}

function t(key) {
  return I18N[key] ?? key;
}

function formatMessage(key, values = {}) {
  return t(key).replace(/\{(\w+)\}/g, (_, name) => values[name] ?? "");
}

function getPageFromHash() {
  const page = location.hash.replace(/^#/, "");
  if (page === "preview") return "tokens";
  return PAGES.includes(page) ? page : "status";
}

function applyLanguage() {
  document.documentElement.lang = "zh-CN";
  document.title = t("title");
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
    element.setAttribute("placeholder", t(element.dataset.i18nPlaceholder));
  });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
    element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
  });
  setSaveStatus(refs.saveBtn.dataset.state || "idle");
  if (!currentPreviewContent) {
    refs.previewOutput.textContent = t("previewEmpty");
    refs.previewOutput.dataset.empty = "true";
  }
  updatePageHeading();
  if (state) {
    renderCurrentPage({ force: true });
  }
}

function setSaveStatus(status) {
  for (const button of [refs.saveBtn, refs.saveSourcesBtn].filter(Boolean)) {
    button.dataset.state = status;
    button.textContent = t(status);
    button.disabled = isSaveButtonDisabled(button, status);
  }
}

function isSaveButtonDisabled(button, status = button?.dataset?.state || "idle") {
  if (!state) return true;
  if (status === "saving" || status === "saved") return true;
  const page = button === refs.saveSourcesBtn ? "sources" : activePage;
  return !hasUnsavedChanges(page);
}

function updateSaveAvailability() {
  let status = refs.saveBtn.dataset.state || "idle";
  if (status === "saved" && (hasUnsavedChanges(activePage) || hasUnsavedChanges("sources"))) {
    if (saveStatusResetTimer) window.clearTimeout(saveStatusResetTimer);
    status = "idle";
  }
  setSaveStatus(status);
}

function updatePageHeading() {
  const key = pageI18nKey(activePage);
  refs.pageTitle.textContent = t(`page${key}Title`);
  refs.pageDescription.textContent = t(`page${key}Description`);
  refs.saveBtn.closest(".apply-bar")?.classList.toggle("hidden", !EDITABLE_PAGES.has(activePage));
}

function pageI18nKey(page) {
  return page
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function showPage(page, pushHash = false) {
  activePage = PAGES.includes(page) ? page : "status";
  renderCurrentPage();
  document.querySelectorAll(".page-view").forEach((view) => {
    view.classList.toggle("hidden", view.dataset.page !== activePage);
  });
  document.querySelectorAll(".luci-menu a[data-page]").forEach((link) => {
    link.classList.toggle("active", link.dataset.page === activePage);
  });
  scrollActiveNavIntoView();
  updatePageHeading();
  if (pushHash && location.hash !== `#${activePage}`) {
    history.pushState(null, "", `#${activePage}`);
  }
  ensureConfigCodeEditorsForPage(activePage);
  updateSaveAvailability();
  refreshStatusStatsIfVisible();
}

function showSurgeTab(tab) {
  const nextTab = ["general", "host", "urlRewrite", "script", "mitm", "ponte", "rule"].includes(tab) ? tab : "general";
  document.querySelectorAll("[data-surge-tab]").forEach((button) => {
    const active = button.dataset.surgeTab === nextTab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll("[data-surge-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.surgePanel !== nextTab);
  });
  ensureConfigCodeEditorsForPage("surge");
}

function showClashTab(tab) {
  const nextTab = ["general", "dns", "providers", "rules"].includes(tab) ? tab : "general";
  document.querySelectorAll("[data-clash-tab]").forEach((button) => {
    const active = button.dataset.clashTab === nextTab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll("[data-clash-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.clashPanel !== nextTab);
  });
  if (state && nextTab === "rules") {
    reconcileClashRulesWithProviders();
  }
  ensureConfigCodeEditorsForPage("clash");
}

function scrollActiveNavIntoView() {
  const activeLink = document.querySelector(".luci-menu a.active");
  if (!activeLink || !window.matchMedia("(max-width: 820px)").matches) return;
  activeLink.scrollIntoView({ block: "nearest", inline: "nearest" });
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return response.json();
}

async function boot() {
  try {
    const session = await request("/api/session");
    if (!session.ok) throw new Error("No active session");
    await loadConfig();
    showWorkspace();
  } catch {
    showLogin();
  }
}

function showLogin() {
  refs.mainMenu.classList.add("hidden");
  refs.pageHead.classList.add("hidden");
  refs.loginPanel.classList.remove("hidden");
  refs.workspace.classList.add("hidden");
  updateSaveAvailability();
}

function showWorkspace() {
  refs.mainMenu.classList.remove("hidden");
  refs.pageHead.classList.remove("hidden");
  refs.loginPanel.classList.add("hidden");
  refs.workspace.classList.remove("hidden");
  showPage(activePage);
}

async function login() {
  await request("/api/login", {
    method: "POST",
    body: JSON.stringify({ token: refs.adminToken.value })
  });
  await loadConfig();
  showWorkspace();
}

async function loadConfig() {
  const [config, readToken, stats, mmdbStatus] = await Promise.all([
    request("/api/config"),
    request("/api/read-token"),
    request("/api/stats"),
    request("/api/geoip/mmdb")
  ]);
  state = config;
  lastSavedState = cloneConfig(config);
  fetchStats = stats;
  geoIpMmdbStatus = mmdbStatus;
  currentReadToken = readToken.token;
  render();
}

function render() {
  renderedPages.clear();
  showPage(activePage);
  updateSaveAvailability();
}

function renderCurrentPage(options = {}) {
  renderPage(activePage, options);
}

function renderPage(page, options = {}) {
  if (!state) return;
  if (!options.force && renderedPages.has(page)) return;
  switch (page) {
    case "status":
      renderStatus();
      break;
    case "settings":
      renderSettings();
      break;
    case "groups":
      renderGroups();
      break;
    case "sources":
      renderSources();
      break;
    case "surge":
      renderSurge();
      break;
    case "clash":
      renderClash();
      break;
    case "tokens":
      renderLinks();
      break;
    default:
      return;
  }
  renderedPages.add(page);
}

function renderStatus() {
  renderSummary();
  renderFetchStats();
}

function renderSettings() {
  refs.managedBaseUrl.value = state.settings.managedBaseUrl;
  refs.userAgentSurge.value = state.settings.userAgentSurge;
  refs.userAgentClash.value = state.settings.userAgentClash;
  refs.excludeKeywords.value = state.settings.excludeKeywords.join(", ");
  refs.featureTagRules.value = linesToText(state.settings.featureTagRules || []);
  refs.notificationTelegramBotToken.value = state.settings.notificationTelegramBotToken || "";
  renderTelegramBindStatus();
  renderGeoIpMmdbStatus();
  refs.chainExitProtocol.value = state.chain.exitProxy.protocol;
  refs.chainExitServer.value = state.chain.exitProxy.server;
  refs.chainExitPort.value = String(state.chain.exitProxy.port || "");
  refs.chainExitUsername.value = state.chain.exitProxy.username;
  refs.chainExitPassword.value = state.chain.exitProxy.password;
  refs.chainFilter.value = (state.chain.filter || []).join(", ");
}

function renderSurge() {
  const advancedHostMode = isModeTogglePressed(refs.surgeHostAdvancedMode);
  const advancedUrlRewriteMode = isModeTogglePressed(refs.surgeUrlRewriteAdvancedMode);
  const advancedRuleMode = isModeTogglePressed(refs.surgeRuleAdvancedMode);
  refs.surgeSkipProxy.value = state.surge.skipProxy.join(", ");
  refs.surgeDnsServer.value = state.surge.dnsServer.join(", ");
  refs.surgeAlwaysRealIp.value = state.surge.alwaysRealIp.join(", ");
  refs.surgeInternetTestUrl.value = state.surge.internetTestUrl;
  refs.surgeProxyTestUrl.value = state.surge.proxyTestUrl;
  refs.surgeManagedConfigIntervalSeconds.value = state.surge.managedConfigIntervalSeconds;
  refs.surgeShowErrorPageForReject.checked = state.surge.showErrorPageForReject;
  refs.surgeIpv6.checked = state.surge.ipv6;
  refs.surgeIpv6Vif.value = state.surge.ipv6Vif;
  syncSurgeIpv6VifVisibility();
  refs.surgeAllowWifiAccess.checked = state.surge.allowWifiAccess;
  refs.surgeTunExcludedRoutes.value = state.surge.tunExcludedRoutes.join(", ");
  refs.surgeEncryptedDnsServer.value = state.surge.encryptedDnsServer.join(", ");
  refs.surgeWifiAssist.checked = state.surge.wifiAssist;
  refs.surgeExcludeSimpleHostnames.checked = state.surge.excludeSimpleHostnames;
  refs.surgeEncryptedDnsFollowOutboundMode.checked = state.surge.encryptedDnsFollowOutboundMode;
  refs.surgePonteDeviceNames.value = normalizePonteDeviceNames(state.surge.ponteDeviceNames || []).join(", ");
  renderSurgeHostRows(state.surge.hosts || []);
  if (advancedHostMode) {
    refs.surgeHosts.value = linesToText(state.surge.hosts || []);
  }
  setModeTogglePressed(refs.surgeHostAdvancedMode, advancedHostMode);
  syncSurgeHostMode();
  renderSurgeUrlRewriteRows(state.surge.urlRewrite || []);
  if (advancedUrlRewriteMode) {
    refs.surgeUrlRewrite.value = linesToText(state.surge.urlRewrite || []);
  }
  setModeTogglePressed(refs.surgeUrlRewriteAdvancedMode, advancedUrlRewriteMode);
  syncSurgeUrlRewriteMode();
  refs.surgeScripts.value = linesToText(state.surge.scripts || []);
  refs.surgeMitmSkipServerCertVerify.checked = state.surge.mitm?.skipServerCertVerify !== false;
  refs.surgeMitmH2.checked = state.surge.mitm?.h2 !== false;
  refs.surgeMitmHostname.value = linesToText(state.surge.mitm?.hostname || []);
  refs.surgeMitmCaPassphrase.value = state.surge.mitm?.caPassphrase || "";
  refs.surgeMitmCaP12.value = state.surge.mitm?.caP12 || "";
  validateCurrentSurgeScripts();
  renderSurgeRuleRows(state.surge.rules);
  if (advancedRuleMode) {
    refs.surgeRules.value = linesToText(state.surge.rules);
  }
  setModeTogglePressed(refs.surgeRuleAdvancedMode, advancedRuleMode);
  syncSurgeRuleMode();
  syncConfigCodeEditors();
}

function renderClash() {
  refs.clashPort.value = String(state.clash.port);
  refs.clashSocksPort.value = String(state.clash.socksPort);
  refs.clashMixedPort.value = String(state.clash.mixedPort);
  refs.clashAllowLan.checked = state.clash.allowLan;
  refs.clashMode.value = DEFAULT_CLASH_MODE;
  refs.clashLogLevel.value = DEFAULT_CLASH_LOG_LEVEL;
  refs.clashIpv6.checked = state.clash.ipv6;
  refs.clashUnifiedDelay.checked = state.clash.unifiedDelay;
  refs.clashTcpConcurrent.checked = state.clash.tcpConcurrent;
  refs.clashExternalController.value = state.clash.externalController || "";
  refs.clashTunEnable.checked = state.clash.tun?.enable !== false;
  refs.clashTunStack.value = state.clash.tun?.stack || "system";
  refs.clashTunAutoRoute.checked = state.clash.tun?.autoRoute !== false;
  refs.clashTunAutoDetectInterface.checked = state.clash.tun?.autoDetectInterface !== false;
  refs.clashTunSkipProxy.value = linesToText(state.clash.tun?.skipProxy || []);
  syncClashTunVisibility();
  refs.clashDnsEnabled.checked = state.clash.dnsEnabled;
  refs.clashDnsListen.value = state.clash.dnsListen || "";
  refs.clashDnsIpv6.checked = state.clash.dnsIpv6;
  refs.clashDnsEnhancedMode.value = state.clash.dnsEnhancedMode;
  refs.clashDnsFakeIpRange.value = state.clash.dnsFakeIpRange || "";
  syncClashFakeIpVisibility();
  refs.clashDefaultNameservers.value = linesToText(state.clash.defaultNameservers || []);
  refs.clashNameservers.value = linesToText(state.clash.nameservers);
  refs.clashFallbackNameservers.value = linesToText(state.clash.fallbackNameservers || []);
  refs.clashFallbackFilterGeoip.checked = state.clash.fallbackFilterGeoip !== false;
  refs.clashFallbackFilterIpcidr.value = linesToText(state.clash.fallbackFilterIpcidr || []);
  refs.clashFakeIpFilter.value = linesToText(state.clash.fakeIpFilter || []);
  refs.clashRuleProviders.value = state.clash.ruleProviders || "";
  renderClashRuleProviderRowsFromYaml(refs.clashRuleProviders.value);
  syncClashRuleProviderMode();
  const advancedRuleMode = isModeTogglePressed(refs.clashRuleAdvancedMode);
  refs.clashRules.value = buildClashRulesYaml(state.clash.rules);
  renderClashRuleRowsFromYaml(refs.clashRules.value);
  if (advancedRuleMode) {
    refs.clashRules.value = buildClashRulesYaml(state.clash.rules);
  }
  setModeTogglePressed(refs.clashRuleAdvancedMode, advancedRuleMode);
  syncClashRuleMode();
  reconcileClashRulesWithProviders();
  syncConfigCodeEditors();
}

const CLASH_RULE_PROVIDER_TYPES = ["http", "file"];
const CLASH_RULE_PROVIDER_BEHAVIORS = ["classical", "domain", "ipcidr"];

function yamlIndent(line) {
  return String(line || "").match(/^\s*/)?.[0].length || 0;
}

function stripYamlComment(value) {
  const text = String(value || "");
  let quote = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if ((char === "\"" || char === "'") && text[index - 1] !== "\\") {
      quote = quote === char ? "" : quote || char;
    }
    if (char === "#" && !quote && (index === 0 || /\s/.test(text[index - 1]))) {
      return text.slice(0, index).trim();
    }
  }
  return text.trim();
}

function unquoteYamlScalar(value) {
  const text = stripYamlComment(value);
  if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function quoteYamlScalar(value) {
  const text = String(value || "").trim();
  if (!text) return "\"\"";
  return /^[A-Za-z0-9_./:@%+?=&~-]+$/.test(text)
    ? text
    : JSON.stringify(text);
}

function quoteYamlKey(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9_.-]+$/.test(text)
    ? text
    : JSON.stringify(text);
}

function parseYamlPair(line) {
  const index = String(line || "").indexOf(":");
  if (index < 0) return null;
  return {
    key: unquoteYamlScalar(line.slice(0, index)),
    value: line.slice(index + 1)
  };
}

function defaultClashRuleProvider() {
  return {
    name: "",
    type: "http",
    behavior: "classical",
    url: "",
    interval: "86400"
  };
}

function clashRuleProviderDefaultPath(name) {
  const slug = String(name || "")
    .trim()
    .replace(/[\\/:*?"<>|#\s]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `./rules/${slug || "provider"}.yaml`;
}

function parseClashRuleProvidersYaml(value) {
  const text = String(value || "").replace(/\r\n?/g, "\n").trimEnd();
  if (!text.trim()) return { providers: [], errors: [] };
  const lines = text.split("\n");
  const errors = [];
  const providers = [];
  const firstContentIndex = lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith("#");
  });
  if (firstContentIndex < 0) return { providers, errors };

  let startIndex = firstContentIndex;
  let baseIndent = -2;
  const firstPair = parseYamlPair(lines[firstContentIndex].trim());
  if (firstPair?.key === "rule-providers" && stripYamlComment(firstPair.value) === "") {
    baseIndent = yamlIndent(lines[firstContentIndex]);
    startIndex = firstContentIndex + 1;
  }

  let current = null;
  let currentIndent = -1;
  for (let index = startIndex; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = yamlIndent(rawLine);
    if (indent <= baseIndent) {
      errors.push(`第 ${index + 1} 行只能包含 rule-providers 配置块。`);
      current = null;
      continue;
    }
    const pair = parseYamlPair(trimmed);
    if (!pair || !pair.key) {
      errors.push(`第 ${index + 1} 行不是有效的 YAML 键值。`);
      continue;
    }
    const value = stripYamlComment(pair.value);
    if (value === "" && (current === null || indent <= currentIndent)) {
      current = { ...defaultClashRuleProvider(), name: pair.key };
      currentIndent = indent;
      providers.push(current);
      continue;
    }
    if (!current || indent <= currentIndent) {
      errors.push(`第 ${index + 1} 行规则集字段必须写在规则集名称下面。`);
      continue;
    }
    if (["type", "behavior", "url", "path", "interval"].includes(pair.key)) {
      current[pair.key] = unquoteYamlScalar(pair.value);
    }
  }
  return { providers, errors };
}

function buildClashRuleProvidersYaml(providers) {
  const rows = (providers || [])
    .map((provider) => ({
      name: String(provider.name || "").trim(),
      type: String(provider.type || "http").trim() || "http",
      behavior: String(provider.behavior || "classical").trim() || "classical",
      url: String(provider.url || "").trim(),
      interval: String(provider.interval || "").trim()
    }))
    .filter((provider) => provider.name);
  if (!rows.length) return "";
  const lines = ["rule-providers:"];
  for (const provider of rows) {
    lines.push(`  ${quoteYamlKey(provider.name)}:`);
    lines.push(`    type: ${quoteYamlScalar(provider.type)}`);
    lines.push(`    behavior: ${quoteYamlScalar(provider.behavior)}`);
    if (provider.url) lines.push(`    url: ${quoteYamlScalar(provider.url)}`);
    lines.push(`    path: ${quoteYamlScalar(clashRuleProviderDefaultPath(provider.name))}`);
    if (provider.interval) lines.push(`    interval: ${quoteYamlScalar(provider.interval)}`);
  }
  return lines.join("\n");
}

function renderClashRuleProviderTypeOptions(selected) {
  return CLASH_RULE_PROVIDER_TYPES
    .map((type) => `<option value="${type}"${type === selected ? " selected" : ""}>${type}</option>`)
    .join("");
}

function renderClashRuleProviderBehaviorOptions(selected) {
  return CLASH_RULE_PROVIDER_BEHAVIORS
    .map((behavior) => `<option value="${behavior}"${behavior === selected ? " selected" : ""}>${behavior}</option>`)
    .join("");
}

function renderClashRuleProviderRow(provider) {
  const normalized = { ...defaultClashRuleProvider(), ...(provider || {}) };
  return `
    <div class="clash-rule-provider-row" data-clash-rule-provider>
      <label>
        <span>${escapeHtml(t("clashRuleProviderName"))}</span>
        ${inputWithTitle('data-clash-rule-provider-part="name"', normalized.name)}
      </label>
      <label>
        <span>${escapeHtml(t("clashRuleProviderType"))}</span>
        <select data-clash-rule-provider-part="type">${renderClashRuleProviderTypeOptions(normalized.type)}</select>
      </label>
      <label>
        <span>${escapeHtml(t("clashRuleProviderBehavior"))}</span>
        <select data-clash-rule-provider-part="behavior">${renderClashRuleProviderBehaviorOptions(normalized.behavior)}</select>
      </label>
      <label>
        <span>${escapeHtml(t("clashRuleProviderUrl"))}</span>
        ${inputWithTitle('data-clash-rule-provider-part="url" dir="rtl"', normalized.url)}
      </label>
      <label>
        <span>${escapeHtml(t("clashRuleProviderInterval"))}</span>
        <input data-clash-rule-provider-part="interval" inputmode="numeric" value="${escapeHtml(normalized.interval)}">
      </label>
      <div class="clash-rule-provider-actions">
        <button class="danger" data-clash-rule-provider-remove type="button">${escapeHtml(t("remove"))}</button>
      </div>
    </div>
  `;
}

function renderClashRuleProviderEmpty() {
  return `<div class="clash-rule-provider-empty">${escapeHtml(t("clashRuleProviderNoRows"))}</div>`;
}

function readClashRuleProviderRow(row) {
  return {
    name: row.querySelector('[data-clash-rule-provider-part="name"]')?.value.trim() || "",
    type: row.querySelector('[data-clash-rule-provider-part="type"]')?.value || "http",
    behavior: row.querySelector('[data-clash-rule-provider-part="behavior"]')?.value || "classical",
    url: row.querySelector('[data-clash-rule-provider-part="url"]')?.value.trim() || "",
    interval: row.querySelector('[data-clash-rule-provider-part="interval"]')?.value.trim() || ""
  };
}

function readClashRuleProviderRows() {
  return Array.from(refs.clashRuleProviderRows.querySelectorAll("[data-clash-rule-provider]")).map(readClashRuleProviderRow);
}

function renderClashRuleProviderRowsFromYaml(value, options = {}) {
  const { providers } = parseClashRuleProvidersYaml(value);
  refs.clashRuleProviderRows.innerHTML = providers.length > 0
    ? providers.map(renderClashRuleProviderRow).join("")
    : renderClashRuleProviderEmpty();
  if (options.updateOutput) {
    updateClashRuleProviderOutput();
  } else {
    validateCurrentClashRuleProviders();
  }
}

function validateClashRuleProviderRows(providers, errors = []) {
  const validation = { errors: [...errors], warnings: [] };
  const names = new Set();
  providers.forEach((provider, index) => {
    const rowNumber = index + 1;
    if (!provider.name) {
      validation.errors.push(`第 ${rowNumber} 个规则集缺少名称。`);
    } else if (names.has(provider.name)) {
      validation.errors.push(`规则集名称 ${provider.name} 重复。`);
    }
    names.add(provider.name);
    if (!CLASH_RULE_PROVIDER_TYPES.includes(provider.type)) {
      validation.errors.push(`${provider.name || `第 ${rowNumber} 个规则集`} 的 type 只能是 http 或 file。`);
    }
    if (!CLASH_RULE_PROVIDER_BEHAVIORS.includes(provider.behavior)) {
      validation.errors.push(`${provider.name || `第 ${rowNumber} 个规则集`} 的 behavior 只能是 classical、domain 或 ipcidr。`);
    }
    if (provider.type === "http" && !provider.url) {
      validation.errors.push(`${provider.name || `第 ${rowNumber} 个规则集`} 的 http 类型必须填写 URL。`);
    }
    if (provider.interval && (!/^\d+$/.test(provider.interval) || Number(provider.interval) <= 0)) {
      validation.errors.push(`${provider.name || `第 ${rowNumber} 个规则集`} 的更新间隔必须是正整数。`);
    }
  });
  return validation;
}

function renderClashRuleProviderValidation(validation) {
  const messages = [
    ...(validation?.errors || []).map((message) => ({ type: "error", message })),
    ...(validation?.warnings || []).map((message) => ({ type: "warning", message }))
  ];
  refs.clashRuleProviderValidation.classList.toggle("hidden", messages.length === 0);
  refs.clashRuleProviderValidation.innerHTML = messages
    .map(({ type, message }) => `<div class="${type}">${escapeHtml(message)}</div>`)
    .join("");
}

function validateCurrentClashRuleProviders() {
  const parsed = parseClashRuleProvidersYaml(refs.clashRuleProviders.value);
  const validation = validateClashRuleProviderRows(parsed.providers, parsed.errors);
  renderClashRuleProviderValidation(validation);
  return validation;
}

function updateClashRuleProviderOutput() {
  if (!isModeTogglePressed(refs.clashRuleProviderAdvancedMode)) {
    refs.clashRuleProviders.value = buildClashRuleProvidersYaml(readClashRuleProviderRows());
  }
  syncConfigCodeEditor(refs.clashRuleProviders);
  validateCurrentClashRuleProviders();
  reconcileClashRulesWithProviders();
}

function handleClashRuleProvidersInput() {
  validateCurrentClashRuleProviders();
  reconcileClashRulesWithProviders();
}

function removeClashRuleProviderByName(name) {
  const target = String(name || "").trim();
  if (!target) return false;
  const providers = parseClashRuleProvidersYaml(refs.clashRuleProviders.value).providers;
  const nextProviders = providers.filter((provider) => provider.name !== target);
  if (nextProviders.length === providers.length) return false;
  refs.clashRuleProviderRows.innerHTML = nextProviders.length > 0
    ? nextProviders.map(renderClashRuleProviderRow).join("")
    : renderClashRuleProviderEmpty();
  refs.clashRuleProviders.value = buildClashRuleProvidersYaml(nextProviders);
  syncConfigCodeEditor(refs.clashRuleProviders);
  validateCurrentClashRuleProviders();
  return true;
}

function syncClashRuleProviderMode() {
  const advanced = isModeTogglePressed(refs.clashRuleProviderAdvancedMode);
  refs.clashRuleProviderStructuredEditor.classList.toggle("hidden", advanced);
  refs.clashRuleProviders.readOnly = !advanced;
  refs.clashRuleProviders.classList.toggle("generated-code", !advanced);
  syncTextModeLabels(refs.clashRuleProviderAdvancedMode, null, advanced);
  syncConfigCodeEditor(refs.clashRuleProviders);
}

function toggleClashRuleProviderAdvancedMode() {
  const advanced = !isModeTogglePressed(refs.clashRuleProviderAdvancedMode);
  if (!advanced) {
    const validation = validateCurrentClashRuleProviders();
    if (validation.errors.length > 0) {
      window.alert(t("clashRuleProviderValidationError"));
      return;
    }
  }
  setModeTogglePressed(refs.clashRuleProviderAdvancedMode, advanced);
  if (!advanced) {
    renderClashRuleProviderRowsFromYaml(refs.clashRuleProviders.value, { updateOutput: true });
  }
  syncClashRuleProviderMode();
  validateCurrentClashRuleProviders();
}

function addClashRuleProvider() {
  refs.clashRuleProviderRows.querySelector(".clash-rule-provider-empty")?.remove();
  refs.clashRuleProviderRows.insertAdjacentHTML("beforeend", renderClashRuleProviderRow(defaultClashRuleProvider()));
  updateClashRuleProviderOutput();
}

function ensureClashRuleProviderEmptyState() {
  if (refs.clashRuleProviderRows.querySelector("[data-clash-rule-provider]")) return;
  refs.clashRuleProviderRows.innerHTML = renderClashRuleProviderEmpty();
}

function handleClashRuleProviderListClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  const row = target?.closest("[data-clash-rule-provider]");
  if (!row) return;
  if (target.closest("[data-clash-rule-provider-remove]")) {
    row.remove();
    ensureClashRuleProviderEmptyState();
    updateClashRuleProviderOutput();
  }
}

function handleClashRuleProviderListChange(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target?.closest("[data-clash-rule-provider]")) return;
  updateClashRuleProviderOutput();
}

const CLASH_BUILT_IN_POLICIES = ["Proxy", "DIRECT", "REJECT", "REJECT-DROP", "PASS", "GLOBAL"];
const CLASH_RULE_TYPES = [
  "DOMAIN",
  "DOMAIN-SUFFIX",
  "DOMAIN-KEYWORD",
  "DOMAIN-REGEX",
  "GEOSITE",
  "GEOIP",
  "IP-CIDR",
  "IP-CIDR6",
  "IP-ASN",
  "SRC-IP-CIDR",
  "SRC-PORT",
  "DST-PORT",
  "PROCESS-NAME",
  "PROCESS-PATH",
  "MATCH",
  "FINAL"
];
const CLASH_VALUELESS_RULE_TYPES = new Set(["MATCH", "FINAL"]);
const CLASH_RULE_OPTION_ORDER = ["no-resolve"];
const CLASH_NO_RESOLVE_RULE_TYPES = new Set(["RULE-SET", "GEOIP", "IP-CIDR", "IP-CIDR6", "IP-ASN"]);

function quoteYamlListItem(value) {
  const text = String(value || "").trim();
  if (!text) return "\"\"";
  return /^[A-Za-z0-9_./:@%+?=&~,*()| -]+$/.test(text) && !/^[-?:]/.test(text)
    ? text
    : JSON.stringify(text);
}

function parseClashRulesYaml(value) {
  const text = String(value || "").replace(/\r\n?/g, "\n").trimEnd();
  if (!text.trim()) return { rules: [], errors: [] };
  const lines = text.split("\n");
  const errors = [];
  const rules = [];
  const firstContentIndex = lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith("#");
  });
  if (firstContentIndex < 0) return { rules, errors };

  const firstPair = parseYamlPair(lines[firstContentIndex].trim());
  if (firstPair?.key !== "rules") {
    errors.push(`第 ${firstContentIndex + 1} 行必须以 rules: 开始。`);
    return { rules, errors };
  }

  const baseIndent = yamlIndent(lines[firstContentIndex]);
  const inlineValue = stripYamlComment(firstPair.value);
  if (inlineValue && inlineValue !== "[]") {
    errors.push(`第 ${firstContentIndex + 1} 行 rules 必须使用 YAML 列表形式。`);
  }

  for (let index = firstContentIndex + 1; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = yamlIndent(rawLine);
    if (indent <= baseIndent) {
      errors.push(`第 ${index + 1} 行只能包含 rules 配置块。`);
      continue;
    }
    if (!trimmed.startsWith("-")) {
      errors.push(`第 ${index + 1} 行必须是 YAML 列表项。`);
      continue;
    }
    const item = trimmed.slice(1).trim();
    if (!item) {
      errors.push(`第 ${index + 1} 行规则不能为空。`);
      continue;
    }
    rules.push(unquoteYamlScalar(item));
  }
  return { rules, errors };
}

function buildClashRulesYaml(lines) {
  const rules = (lines || []).map((line) => String(line || "").trim()).filter(Boolean);
  if (!rules.length) return "";
  return ["rules:", ...rules.map((line) => `  - ${quoteYamlListItem(line)}`)].join("\n");
}

function clashRuleProviderNames() {
  return parseClashRuleProvidersYaml(refs.clashRuleProviders.value).providers
    .map((provider) => provider.name)
    .filter(Boolean);
}

function clashPolicyCandidates() {
  return [...new Set([...groupEntries().map(([name]) => name), ...CLASH_BUILT_IN_POLICIES])];
}

function normalizeClashRulePolicy(policy) {
  const trimmed = String(policy || "").trim();
  return isValidClashPolicy(trimmed) ? trimmed : "Proxy";
}

function isKnownClashPolicy(policy) {
  return clashPolicyCandidates().includes(String(policy || "").trim());
}

function isValidClashPolicy(policy) {
  const trimmed = String(policy || "").trim();
  return Boolean(trimmed) && !/[\r\n,[\]]/.test(trimmed);
}

function renderClashPolicyOptions(selected) {
  const selectedPolicy = normalizeClashRulePolicy(selected);
  const candidates = clashPolicyCandidates();
  if (selectedPolicy && !candidates.includes(selectedPolicy)) {
    candidates.push(selectedPolicy);
  }
  return candidates
    .map((policy) => `<option value="${escapeHtml(policy)}"${policy === selectedPolicy ? " selected" : ""}>${escapeHtml(renderPolicyLabel(policy))}</option>`)
    .join("");
}

function renderClashRuleProviderNameOptions(selected) {
  const normalized = String(selected || "").trim();
  const names = clashRuleProviderNames();
  if (normalized && !names.includes(normalized)) names.unshift(normalized);
  if (!names.length) return `<option value="">${escapeHtml(t("clashRuleProviderNoRows"))}</option>`;
  return names
    .map((name) => `<option value="${escapeHtml(name)}"${name === normalized ? " selected" : ""}>${escapeHtml(name)}</option>`)
    .join("");
}

function allowedClashRuleOptions(kind, ruleType) {
  const type = kind === "rule-set" ? "RULE-SET" : String(ruleType || "").trim().toUpperCase();
  return CLASH_NO_RESOLVE_RULE_TYPES.has(type) ? new Set(["no-resolve"]) : new Set();
}

function normalizeClashRuleOptions(value, kind, ruleType) {
  const allowed = allowedClashRuleOptions(kind, ruleType);
  const requested = String(value || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  const output = [];
  for (const option of CLASH_RULE_OPTION_ORDER) {
    if (requested.includes(option) && allowed.has(option)) output.push(option);
  }
  return output.join(",");
}

function validateClashRuleOptions(options, kind, ruleType) {
  const values = (options || []).map((option) => option.trim().toLowerCase()).filter(Boolean);
  const uniqueValues = new Set(values);
  if (uniqueValues.size !== values.length) return "附加参数不能重复";
  const allowed = allowedClashRuleOptions(kind, ruleType);
  const invalid = values.filter((option) => !allowed.has(option) || !CLASH_RULE_OPTION_ORDER.includes(option));
  if (invalid.length === 0) return "";
  const allowedText = [...allowed].join(", ") || t("surgeRuleOptionNone");
  return `${t("surgeRuleOptionInvalid")} 可用参数：${allowedText}。`;
}

function renderClashRuleOptionChoices(kind, ruleType, selected) {
  const selectedValue = normalizeClashRuleOptions(selected, kind, ruleType);
  const choices = [["", t("surgeRuleOptionNone")]];
  for (const option of CLASH_RULE_OPTION_ORDER) {
    if (allowedClashRuleOptions(kind, ruleType).has(option)) choices.push([option, option]);
  }
  return choices
    .map(([value, label]) => `<option value="${escapeHtml(value)}"${value === selectedValue ? " selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
}

function validateClashRuleLine(line, lineNumber) {
  const trimmed = String(line || "").trim();
  const result = { errors: [], warnings: [] };
  if (!trimmed || trimmed.startsWith("#")) return result;
  const parts = splitSurgeRuleLine(trimmed);
  const type = (parts[0] || "").trim().toUpperCase();
  if (!type) {
    result.errors.push(`第 ${lineNumber} 行缺少规则类型`);
    return result;
  }
  if (parts.some((part) => !part.trim())) {
    result.errors.push(`第 ${lineNumber} 行存在空参数`);
    return result;
  }

  let policy = "";
  if (type === "RULE-SET") {
    if (parts.length < 3) {
      result.errors.push(`第 ${lineNumber} 行规则集语法应为 RULE-SET,规则集名称,策略`);
      return result;
    }
    const providerName = parts[1] || "";
    if (!clashRuleProviderNames().includes(providerName)) {
      result.errors.push(`第 ${lineNumber} 行${t("clashRuleUnknownProvider")}`);
    }
    policy = parts[2] || "";
    const optionError = validateClashRuleOptions(parts.slice(3), "rule-set", "RULE-SET");
    if (optionError) result.errors.push(`第 ${lineNumber} 行${optionError}`);
  } else if (CLASH_VALUELESS_RULE_TYPES.has(type)) {
    if (parts.length < 2) {
      result.errors.push(`第 ${lineNumber} 行 ${type} 规则缺少策略出口`);
      return result;
    }
    policy = parts[1] || "";
    const optionError = validateClashRuleOptions(parts.slice(2), "single", type);
    if (optionError) result.errors.push(`第 ${lineNumber} 行${optionError}`);
  } else {
    if (!CLASH_RULE_TYPES.includes(type)) {
      result.errors.push(`第 ${lineNumber} 行规则类型 ${type} 不受支持`);
      return result;
    }
    if (parts.length < 3) {
      result.errors.push(`第 ${lineNumber} 行语法应为 类型,匹配值,策略`);
      return result;
    }
    policy = parts[2] || "";
    const optionError = validateClashRuleOptions(parts.slice(3), "single", type);
    if (optionError) result.errors.push(`第 ${lineNumber} 行${optionError}`);
  }

  if (!isValidClashPolicy(policy)) {
    result.errors.push(`第 ${lineNumber} 行策略出口格式无效`);
  } else if (!isKnownClashPolicy(policy)) {
    result.errors.push(`第 ${lineNumber} 行${t("clashRuleUnknownPolicy")}`);
  }
  return result;
}

function effectiveClashRuleEntries(lines) {
  return (lines || []).map((line, index) => {
    const trimmed = String(line || "").trim();
    if (!trimmed || trimmed.startsWith("#")) return null;
    return {
      lineNumber: index + 1,
      type: (splitSurgeRuleLine(trimmed)[0] || "").trim().toUpperCase()
    };
  }).filter(Boolean);
}

function validateClashRuleLines(lines, errors = []) {
  const validation = { errors: [...errors], warnings: [] };
  (lines || []).forEach((line, index) => {
    const result = validateClashRuleLine(line, index + 1);
    validation.errors.push(...result.errors);
    validation.warnings.push(...result.warnings);
  });
  const effectiveRules = effectiveClashRuleEntries(lines);
  const fallbackRules = effectiveRules.filter((rule) => CLASH_VALUELESS_RULE_TYPES.has(rule.type));
  if (fallbackRules.length === 0) {
    validation.errors.push(t("clashRuleMatchMissing"));
  } else if (fallbackRules.length > 1) {
    validation.errors.push(t("clashRuleMatchDuplicate"));
  } else if (!CLASH_VALUELESS_RULE_TYPES.has(effectiveRules[effectiveRules.length - 1]?.type || "")) {
    validation.errors.push(t("clashRuleMatchNotLast"));
  }
  return validation;
}

function renderClashRuleValidation(validation) {
  const messages = [
    ...(validation?.errors || []).map((message) => ({ type: "error", message })),
    ...(validation?.warnings || []).map((message) => ({ type: "warning", message }))
  ];
  refs.clashRuleValidation.classList.toggle("hidden", messages.length === 0);
  refs.clashRuleValidation.innerHTML = messages
    .map(({ type, message }) => `<div class="${type}">${escapeHtml(message)}</div>`)
    .join("");
}

function currentClashRuleLines() {
  return isModeTogglePressed(refs.clashRuleAdvancedMode)
    ? parseClashRulesYaml(refs.clashRules.value).rules
    : buildClashRuleLines(readClashRuleRows());
}

function validateCurrentClashRules() {
  const parsed = parseClashRulesYaml(refs.clashRules.value);
  const lines = isModeTogglePressed(refs.clashRuleAdvancedMode) ? parsed.rules : buildClashRuleLines(readClashRuleRows());
  const validation = validateClashRuleLines(lines, isModeTogglePressed(refs.clashRuleAdvancedMode) ? parsed.errors : []);
  renderClashRuleValidation(validation);
  return validation;
}

function parseClashRuleLine(line) {
  const parts = splitSurgeRuleLine(line);
  const type = (parts[0] || "").trim().toUpperCase();
  if (!type) return null;
  if (type === "RULE-SET") {
    return {
      kind: "rule-set",
      setName: parts[1] || "",
      policy: normalizeClashRulePolicy(parts[2] || ""),
      options: parts.slice(3).join(", ")
    };
  }
  const valueless = CLASH_VALUELESS_RULE_TYPES.has(type);
  const policyIndex = valueless ? 1 : 2;
  return {
    kind: "single",
    ruleType: type,
    value: valueless ? "" : parts[1] || "",
    policy: normalizeClashRulePolicy(parts[policyIndex] || ""),
    options: parts.slice(policyIndex + 1).join(", ")
  };
}

function fallbackClashRule() {
  return { kind: "single", ruleType: "MATCH", value: "", policy: normalizeClashRulePolicy("Proxy"), options: "" };
}

function isFallbackClashRule(rule) {
  return CLASH_VALUELESS_RULE_TYPES.has(String(rule?.ruleType || "").trim().toUpperCase());
}

function normalizeClashRuleRows(rules) {
  const list = Array.isArray(rules) ? rules : [];
  const fallbackRule = list.find(isFallbackClashRule) || fallbackClashRule();
  return [
    ...list.filter((rule) => !isFallbackClashRule(rule)),
    { ...fallbackRule, kind: "single", value: "" }
  ];
}

function defaultClashRule(kind = "single") {
  const policy = normalizeClashRulePolicy("Proxy");
  return kind === "rule-set"
    ? { kind: "rule-set", setName: clashRuleProviderNames()[0] || "", policy, options: "" }
    : { kind: "single", ruleType: "DOMAIN-SUFFIX", value: "", policy, options: "" };
}

function renderClashRuleKindOptions(selected) {
  return [
    ["single", t("clashRuleKindSingle")],
    ["rule-set", t("clashRuleKindRuleSet")]
  ].map(([value, label]) => `<option value="${value}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");
}

function renderClashRuleTypeOptions(selected, lockedFallback = false) {
  if (lockedFallback) return `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)}</option>`;
  const editableTypes = CLASH_RULE_TYPES.filter((type) => !CLASH_VALUELESS_RULE_TYPES.has(type));
  const types = editableTypes.includes(selected) ? editableTypes : [selected, ...editableTypes].filter(Boolean);
  return types.map((type) => `<option value="${escapeHtml(type)}"${type === selected ? " selected" : ""}>${escapeHtml(type)}</option>`).join("");
}

function renderClashRuleRow(rule) {
  const normalized = rule || defaultClashRule();
  const kind = normalized.kind === "rule-set" ? "rule-set" : "single";
  const ruleType = normalized.ruleType || "DOMAIN-SUFFIX";
  const lockedFallback = kind === "single" && CLASH_VALUELESS_RULE_TYPES.has(ruleType);
  const valueless = CLASH_VALUELESS_RULE_TYPES.has(ruleType);
  const disabledAttr = lockedFallback ? " disabled" : "";
  const mainField = kind === "rule-set"
    ? `<label>
        <span>${escapeHtml(t("clashRuleSetName"))}</span>
        <select data-clash-rule-part="setName">${renderClashRuleProviderNameOptions(normalized.setName || "")}</select>
      </label>`
    : `<label>
        <span>${escapeHtml(t("clashRuleType"))}</span>
        <select data-clash-rule-part="ruleType"${disabledAttr}>${renderClashRuleTypeOptions(ruleType, lockedFallback)}</select>
        ${lockedFallback ? `<small>${escapeHtml(t("clashRuleMatchLocked"))}</small>` : ""}
      </label>
      <label>
        <span>${escapeHtml(t("clashRuleValue"))}</span>
        ${inputWithTitle(`data-clash-rule-part="value"${valueless ? " disabled" : ""}`, normalized.value || "")}
      </label>`;
  return `
    <div class="clash-rule-row ${kind === "rule-set" ? "rule-set" : "single"}" data-clash-rule${lockedFallback ? " data-clash-rule-fallback" : ""}>
      <label>
        <span>${escapeHtml(t("clashRuleKind"))}</span>
        <select data-clash-rule-part="kind"${disabledAttr}>${renderClashRuleKindOptions(kind)}</select>
      </label>
      ${mainField}
      <label>
        <span>${escapeHtml(t("clashRulePolicy"))}</span>
        <select data-clash-rule-part="policy">${renderClashPolicyOptions(normalized.policy)}</select>
      </label>
      <label>
        <span>${escapeHtml(t("clashRuleOptions"))}</span>
        <select data-clash-rule-part="options">${renderClashRuleOptionChoices(kind, ruleType, normalized.options || "")}</select>
      </label>
      <div class="clash-rule-actions">
        <button class="btn" data-clash-rule-move="up" type="button"${disabledAttr}>${escapeHtml(t("moveUp"))}</button>
        <button class="btn" data-clash-rule-move="down" type="button"${disabledAttr}>${escapeHtml(t("moveDown"))}</button>
        <button class="danger" data-clash-rule-remove type="button"${disabledAttr}>${escapeHtml(t("remove"))}</button>
      </div>
    </div>
  `;
}

function renderClashRuleEmpty() {
  return `<div class="clash-rule-empty">${escapeHtml(t("clashRuleNoRows"))}</div>`;
}

function renderClashRuleRowsFromYaml(value, options = {}) {
  const parsed = parseClashRulesYaml(value);
  const rules = normalizeClashRuleRows(parsed.rules.map(parseClashRuleLine).filter(Boolean));
  refs.clashRuleRows.innerHTML = rules.length > 0
    ? rules.map(renderClashRuleRow).join("")
    : renderClashRuleEmpty();
  if (options.updateOutput) {
    updateClashRuleOutput();
  } else {
    validateCurrentClashRules();
  }
}

function readClashRuleRow(row) {
  const kind = row.querySelector('[data-clash-rule-part="kind"]')?.value || "single";
  const policy = normalizeClashRulePolicy(row.querySelector('[data-clash-rule-part="policy"]')?.value || "");
  const options = row.querySelector('[data-clash-rule-part="options"]')?.value.trim() || "";
  if (kind === "rule-set") {
    return {
      kind,
      setName: row.querySelector('[data-clash-rule-part="setName"]')?.value.trim() || "",
      policy,
      options: normalizeClashRuleOptions(options, kind, "RULE-SET")
    };
  }
  const ruleType = (row.querySelector('[data-clash-rule-part="ruleType"]')?.value || "DOMAIN-SUFFIX").trim().toUpperCase();
  return {
    kind: "single",
    ruleType,
    value: row.querySelector('[data-clash-rule-part="value"]')?.value.trim() || "",
    policy,
    options: normalizeClashRuleOptions(options, kind, ruleType)
  };
}

function readClashRuleRows() {
  return Array.from(refs.clashRuleRows.querySelectorAll("[data-clash-rule]")).map(readClashRuleRow);
}

function buildClashRuleLine(rule) {
  if (rule.kind === "rule-set") {
    const name = String(rule.setName || "").trim();
    const options = normalizeClashRuleOptions(rule.options, "rule-set", "RULE-SET");
    const suffix = options ? `,${options}` : "";
    return `RULE-SET,${name},${normalizeClashRulePolicy(rule.policy)}${suffix}`;
  }
  const type = String(rule.ruleType || "").trim().toUpperCase();
  const policy = normalizeClashRulePolicy(rule.policy);
  const options = normalizeClashRuleOptions(rule.options, "single", type);
  const suffix = options ? `,${options}` : "";
  if (!type) return "";
  if (CLASH_VALUELESS_RULE_TYPES.has(type)) {
    return `${type},${policy}${suffix}`;
  }
  const value = String(rule.value || "").trim();
  return `${type},${value},${policy}${suffix}`;
}

function buildClashRuleLines(rules) {
  return normalizeClashRuleRows(rules).map(buildClashRuleLine).filter(Boolean);
}

function sameLines(left, right) {
  if (left.length !== right.length) return false;
  return left.every((line, index) => line === right[index]);
}

function currentClashRuleRows() {
  return isModeTogglePressed(refs.clashRuleAdvancedMode)
    ? parseClashRulesYaml(refs.clashRules.value).rules.map(parseClashRuleLine).filter(Boolean)
    : readClashRuleRows();
}

function reconcileClashRulesWithProviders() {
  const providerNames = clashRuleProviderNames();
  const providerSet = new Set(providerNames);
  const currentRows = normalizeClashRuleRows(currentClashRuleRows());
  const retainedRows = currentRows.filter((rule) => rule.kind !== "rule-set" || providerSet.has(String(rule.setName || "").trim()));
  const configured = new Set(retainedRows
    .filter((rule) => rule.kind === "rule-set")
    .map((rule) => String(rule.setName || "").trim())
    .filter(Boolean));
  const missingRows = providerNames
    .filter((name) => !configured.has(name))
    .map((name) => ({ kind: "rule-set", setName: name, policy: "Proxy", options: "" }));
  const fallbackRows = retainedRows.filter(isFallbackClashRule);
  const reconciledRows = normalizeClashRuleRows([
    ...retainedRows.filter((rule) => !isFallbackClashRule(rule)),
    ...missingRows,
    ...fallbackRows
  ]);
  const beforeLines = buildClashRuleLines(currentRows);
  const afterLines = buildClashRuleLines(reconciledRows);
  if (sameLines(beforeLines, afterLines)) return false;
  refs.clashRuleRows.innerHTML = reconciledRows.map(renderClashRuleRow).join("");
  refs.clashRules.value = buildClashRulesYaml(afterLines);
  syncConfigCodeEditor(refs.clashRules);
  validateCurrentClashRules();
  return true;
}

function updateClashRuleOutput() {
  if (!isModeTogglePressed(refs.clashRuleAdvancedMode)) {
    refs.clashRules.value = buildClashRulesYaml(buildClashRuleLines(readClashRuleRows()));
  }
  syncConfigCodeEditor(refs.clashRules);
  validateCurrentClashRules();
  reconcileClashRulesWithProviders();
}

function syncClashRuleMode() {
  const advanced = isModeTogglePressed(refs.clashRuleAdvancedMode);
  refs.clashRuleStructuredEditor.classList.toggle("hidden", advanced);
  refs.clashRuleStructuredActions.classList.toggle("hidden", advanced);
  refs.clashRules.readOnly = !advanced;
  refs.clashRules.classList.toggle("generated-code", !advanced);
  syncTextModeLabels(refs.clashRuleAdvancedMode, null, advanced);
  syncConfigCodeEditor(refs.clashRules);
  validateCurrentClashRules();
}

function toggleClashRuleAdvancedMode() {
  const advanced = !isModeTogglePressed(refs.clashRuleAdvancedMode);
  if (!advanced) {
    const validation = validateCurrentClashRules();
    if (validation.errors.length > 0) {
      window.alert(t("clashRuleValidationError"));
      return;
    }
  }
  setModeTogglePressed(refs.clashRuleAdvancedMode, advanced);
  if (!advanced) {
    renderClashRuleRowsFromYaml(refs.clashRules.value, { updateOutput: true });
  }
  syncClashRuleMode();
  validateCurrentClashRules();
}

function addClashRule(kind) {
  refs.clashRuleRows.querySelector(".clash-rule-empty")?.remove();
  const fallbackRow = refs.clashRuleRows.querySelector("[data-clash-rule-fallback]");
  const html = renderClashRuleRow(defaultClashRule(kind));
  if (fallbackRow) {
    fallbackRow.insertAdjacentHTML("beforebegin", html);
  } else {
    refs.clashRuleRows.insertAdjacentHTML("beforeend", html);
  }
  updateClashRuleOutput();
}

function ensureClashRuleEmptyState() {
  if (refs.clashRuleRows.querySelector("[data-clash-rule]")) return;
  refs.clashRuleRows.innerHTML = renderClashRuleEmpty();
}

function rerenderClashRuleRow(row) {
  const rule = readClashRuleRow(row);
  row.outerHTML = renderClashRuleRow(rule);
  updateClashRuleOutput();
}

function handleClashRuleListClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  const row = target?.closest("[data-clash-rule]");
  if (!row) return;
  if (row.matches("[data-clash-rule-fallback]")) return;
  if (target.closest("[data-clash-rule-remove]")) {
    const rule = readClashRuleRow(row);
    const setName = rule.kind === "rule-set" ? String(rule.setName || "").trim() : "";
    if (setName && clashRuleProviderNames().includes(setName)) {
      if (!window.confirm(formatMessage("clashRuleSetDeleteProviderConfirm", { name: setName }))) return;
      removeClashRuleProviderByName(setName);
    }
    row.remove();
    ensureClashRuleEmptyState();
    updateClashRuleOutput();
    return;
  }
  const move = target.closest("[data-clash-rule-move]")?.dataset.clashRuleMove;
  if (move === "up") {
    const previous = row.previousElementSibling?.matches("[data-clash-rule]") ? row.previousElementSibling : null;
    if (previous) refs.clashRuleRows.insertBefore(row, previous);
    updateClashRuleOutput();
    return;
  }
  if (move === "down") {
    const next = row.nextElementSibling?.matches("[data-clash-rule]") ? row.nextElementSibling : null;
    if (next?.matches("[data-clash-rule-fallback]")) return;
    if (next) refs.clashRuleRows.insertBefore(next, row);
    updateClashRuleOutput();
  }
}

function handleClashRuleListChange(event) {
  const target = event.target instanceof Element ? event.target : null;
  const row = target?.closest("[data-clash-rule]");
  if (!row) return;
  if (target.matches('[data-clash-rule-part="kind"], [data-clash-rule-part="ruleType"]')) {
    rerenderClashRuleRow(row);
    return;
  }
  updateClashRuleOutput();
}

function groupEntries() {
  return Object.entries(state.groups || {});
}

function setGroupEntries(entries) {
  state.groups = Object.fromEntries(entries);
}

const GROUP_TYPES = ["select", "url-test", "fallback", "load-balance", "subnet"];
const GROUP_OPTION_FIELDS = new Set(["url", "interval"]);
const NAME_LOCKED_GROUP_NAMES = new Set(["Proxy"]);
const SUBNET_PARAMETERS = ["SSID", "BSSID", "ROUTER", "TYPE"];
const SUBNET_NETWORK_TYPES = ["WIFI", "WIRED", "CELLULAR"];
const SUBNET_BUILT_IN_POLICIES = ["Proxy", "DIRECT", "REJECT", "REJECT-DROP", "REJECT-NO-DROP", "REJECT-TINYGIF"];
const SURGE_BUILT_IN_POLICY_LABELS = {
  DIRECT: "直连 (DIRECT)",
  REJECT: "拒绝请求 (REJECT)",
  "REJECT-DROP": "静默丢弃 (REJECT-DROP)",
  "REJECT-NO-DROP": "拒绝但不自动静默丢弃 (REJECT-NO-DROP)",
  "REJECT-TINYGIF": "返回 1px 透明图 (REJECT-TINYGIF)"
};
const SURGE_RULE_TYPES = [
  "DOMAIN",
  "DOMAIN-SUFFIX",
  "DOMAIN-KEYWORD",
  "IP-CIDR",
  "IP-CIDR6",
  "GEOIP",
  "PROCESS-NAME",
  "USER-AGENT",
  "URL-REGEX",
  "SCRIPT",
  "SUBNET",
  "AND",
  "OR",
  "NOT",
  "FINAL"
];
const SURGE_VALUELESS_RULE_TYPES = new Set(["FINAL", "MATCH"]);
const SURGE_RULE_SET_TYPES = new Set(["RULE-SET", "DOMAIN-SET"]);
const SURGE_RULE_OPTION_ORDER = ["no-resolve", "extended-matching", "dns-failed"];
const SURGE_RULE_SET_OPTIONS = new Set(["no-resolve", "extended-matching"]);
const SURGE_DOMAIN_SET_OPTIONS = new Set(["extended-matching"]);
const SURGE_IP_RULE_OPTIONS = new Set(["no-resolve"]);
const SURGE_EXTENDED_MATCHING_RULE_TYPES = new Set(["DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "URL-REGEX"]);
const SURGE_FINAL_RULE_OPTIONS = new Set(["dns-failed"]);
const SURGE_VALUE_RULE_TYPES = new Set([
  "DOMAIN",
  "DOMAIN-SUFFIX",
  "DOMAIN-KEYWORD",
  "IP-CIDR",
  "IP-CIDR6",
  "GEOIP",
  "PROCESS-NAME",
  "USER-AGENT",
  "URL-REGEX",
  "SCRIPT",
  "SUBNET",
  "SRC-IP",
  "IN-PORT",
  "DEST-PORT",
  "PROTOCOL",
  "DEVICE-NAME",
  "CELLULAR-RADIO",
  "WIFI-SSID",
  "AND",
  "OR",
  "NOT"
]);

function isBuiltInGroupName(name) {
  return NAME_LOCKED_GROUP_NAMES.has(String(name || "").trim());
}

function isRemovalLockedGroupName(name) {
  return String(name || "").trim() === "Proxy";
}

function isDisableToggleAllowed(name) {
  return !isRemovalLockedGroupName(name);
}

function isGroupDisabled(name) {
  return new Set(state.disabledGroups || []).has(String(name || "").trim());
}

function setGroupDisabled(name, disabled) {
  const target = String(name || "").trim();
  const disabledGroups = new Set(state.disabledGroups || []);
  if (disabled) {
    disabledGroups.add(target);
  } else {
    disabledGroups.delete(target);
  }
  disabledGroups.delete("Proxy");
  state.disabledGroups = Array.from(disabledGroups).filter((item) => Object.prototype.hasOwnProperty.call(state.groups, item));
}

function splitSurgeHostLine(line) {
  const trimmed = String(line || "").trim();
  const separatorIndex = trimmed.indexOf("=");
  if (separatorIndex < 0) return { host: trimmed, value: "" };
  return {
    host: trimmed.slice(0, separatorIndex).trim(),
    value: trimmed.slice(separatorIndex + 1).trim()
  };
}

function isValidSurgeHostName(value) {
  return Boolean(value)
    && !/[\s=,[\]]/.test(value)
    && !value.includes("://");
}

function isValidSurgeHostValue(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || /[\s,[\]]/.test(trimmed)) return false;
  if (!trimmed.startsWith("server:")) return !trimmed.includes("=");

  const server = trimmed.slice("server:".length);
  if (!server) return false;
  if (server === "system") return true;
  if (server.includes("=") || /[\s,[\]]/.test(server)) return false;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(server)) {
    try {
      return ["https:", "h3:", "quic:", "tls:"].includes(new URL(server).protocol);
    } catch {
      return false;
    }
  }
  return true;
}

function validateSurgeHostLine(line, lineNumber) {
  const trimmed = String(line || "").trim();
  const result = { errors: [], warnings: [] };
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) return result;
  if (/^\[[^\]]+\]$/.test(trimmed)) {
    result.errors.push(`第 ${lineNumber} 行不能包含配置段标题`);
    return result;
  }

  const separatorIndex = trimmed.indexOf("=");
  if (separatorIndex <= 0 || !trimmed.slice(separatorIndex + 1).trim()) {
    result.errors.push(`第 ${lineNumber} 行语法应为 主机名 = 解析值`);
    return result;
  }

  const { host, value } = splitSurgeHostLine(trimmed);
  if (!isValidSurgeHostName(host)) {
    result.errors.push(`第 ${lineNumber} 行主机名格式无效`);
  }
  const values = value.split(",").map((item) => item.trim());
  if (values.some((item) => !item)) {
    result.errors.push(`第 ${lineNumber} 行解析值存在空项`);
  }
  const invalidValue = values.find((item) => item && !isValidSurgeHostValue(item));
  if (invalidValue) {
    result.errors.push(`第 ${lineNumber} 行解析值格式无效：${invalidValue}`);
  }
  return result;
}

function validateSurgeHostLines(lines) {
  const validation = { errors: [], warnings: [] };
  (lines || []).forEach((line, index) => {
    const result = validateSurgeHostLine(line, index + 1);
    validation.errors.push(...result.errors);
    validation.warnings.push(...result.warnings);
  });
  return validation;
}

function renderSurgeHostValidation(validation) {
  const messages = [
    ...(validation?.errors || []).map((message) => ({ type: "error", message })),
    ...(validation?.warnings || []).map((message) => ({ type: "warning", message }))
  ];
  refs.surgeHostValidation.classList.toggle("hidden", messages.length === 0);
  refs.surgeHostValidation.innerHTML = messages
    .map(({ type, message }) => `<div class="${type}">${escapeHtml(message)}</div>`)
    .join("");
}

function currentSurgeHostLines() {
  return isModeTogglePressed(refs.surgeHostAdvancedMode)
    ? textToLines(refs.surgeHosts.value)
    : buildSurgeHostLines(readSurgeHostRows());
}

function validateCurrentSurgeHosts() {
  const validation = validateSurgeHostLines(currentSurgeHostLines());
  renderSurgeHostValidation(validation);
  return validation;
}

function parseSurgeHostLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";") || /^\[[^\]]+\]$/.test(trimmed)) return null;
  const { host, value } = splitSurgeHostLine(trimmed);
  return host || value ? { host, value } : null;
}

function defaultSurgeHost() {
  return { host: "", value: "" };
}

function renderSurgeHostRow(host) {
  const normalized = host || defaultSurgeHost();
  return `
    <div class="surge-host-row" data-surge-host>
      <label>
        <span>${escapeHtml(t("surgeHostName"))}</span>
        ${inputWithTitle('data-surge-host-part="host" placeholder="example.com"', normalized.host || "")}
        <small>${escapeHtml(t("surgeHostHelpName"))}</small>
      </label>
      <label>
        <span>${escapeHtml(t("surgeHostValue"))}</span>
        ${inputWithTitle('data-surge-host-part="value" placeholder="1.2.3.4"', normalized.value || "")}
        <small>${escapeHtml(t("surgeHostHelpValue"))}</small>
      </label>
      <div class="surge-host-actions">
        <button class="danger" data-surge-host-remove type="button">${escapeHtml(t("remove"))}</button>
      </div>
    </div>
  `;
}

function renderSurgeHostEmpty() {
  return `<div class="surge-host-empty">${escapeHtml(t("surgeHostNoRows"))}</div>`;
}

function renderSurgeHostRows(lines) {
  const hosts = (lines || []).map(parseSurgeHostLine).filter(Boolean);
  refs.surgeHostRows.innerHTML = hosts.length > 0
    ? hosts.map(renderSurgeHostRow).join("")
    : renderSurgeHostEmpty();
  updateSurgeHostOutput();
}

function readSurgeHostRow(row) {
  return {
    host: row.querySelector('[data-surge-host-part="host"]')?.value.trim() || "",
    value: row.querySelector('[data-surge-host-part="value"]')?.value.trim() || ""
  };
}

function readSurgeHostRows() {
  return Array.from(refs.surgeHostRows.querySelectorAll("[data-surge-host]")).map(readSurgeHostRow);
}

function buildSurgeHostLine(host) {
  const name = String(host.host || "").trim();
  const value = String(host.value || "").trim();
  return name || value ? `${name} = ${value}` : "";
}

function buildSurgeHostLines(hosts) {
  return (hosts || []).map(buildSurgeHostLine).filter(Boolean);
}

function updateSurgeHostOutput() {
  if (!isModeTogglePressed(refs.surgeHostAdvancedMode)) {
    refs.surgeHosts.value = buildSurgeHostLines(readSurgeHostRows()).join("\n");
  }
  syncConfigCodeEditor(refs.surgeHosts);
  validateCurrentSurgeHosts();
}

function syncSurgeHostMode() {
  const advanced = isModeTogglePressed(refs.surgeHostAdvancedMode);
  refs.surgeHostStructuredEditor.classList.toggle("hidden", advanced);
  refs.surgeHosts.readOnly = !advanced;
  refs.surgeHosts.classList.toggle("advanced", advanced);
  syncTextModeLabels(refs.surgeHostAdvancedMode, refs.surgeHostsLabel, advanced);
  syncConfigCodeEditor(refs.surgeHosts);
  validateCurrentSurgeHosts();
}

function toggleSurgeHostAdvancedMode() {
  const advanced = !isModeTogglePressed(refs.surgeHostAdvancedMode);
  setModeTogglePressed(refs.surgeHostAdvancedMode, advanced);
  if (!advanced) {
    renderSurgeHostRows(textToLines(refs.surgeHosts.value));
  }
  syncSurgeHostMode();
}

function addSurgeHost() {
  refs.surgeHostRows.querySelector(".surge-host-empty")?.remove();
  refs.surgeHostRows.insertAdjacentHTML("beforeend", renderSurgeHostRow(defaultSurgeHost()));
  updateSurgeHostOutput();
}

function ensureSurgeHostEmptyState() {
  if (refs.surgeHostRows.querySelector("[data-surge-host]")) return;
  refs.surgeHostRows.innerHTML = renderSurgeHostEmpty();
}

function handleSurgeHostListClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  const row = target?.closest("[data-surge-host]");
  if (!row || !target.closest("[data-surge-host-remove]")) return;
  row.remove();
  ensureSurgeHostEmptyState();
  updateSurgeHostOutput();
}

function splitSurgeUrlRewriteLine(line) {
  const parts = String(line || "").trim().split(/\s+/);
  return {
    pattern: parts[0] || "",
    replacement: parts[1] || "",
    type: (parts[2] || "").toLowerCase()
  };
}

function isValidUrlRewriteReplacement(type, replacement) {
  const trimmed = String(replacement || "").trim();
  if (!trimmed) return false;
  if (type === "reject") return true;
  return /^https?:\/\//i.test(trimmed);
}

function validateSurgeUrlRewriteLine(line, lineNumber) {
  const trimmed = String(line || "").trim();
  const result = { errors: [], warnings: [] };
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) return result;
  if (/^\[[^\]]+\]$/.test(trimmed)) {
    result.errors.push(`第 ${lineNumber} 行不能包含配置段标题`);
    return result;
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 3) {
    result.errors.push(`第 ${lineNumber} 行语法应为 正则 替换值 类型`);
    return result;
  }

  const { pattern, replacement, type } = splitSurgeUrlRewriteLine(trimmed);
  if (!["header", "302", "reject"].includes(type)) {
    result.errors.push(`第 ${lineNumber} 行动作类型必须是 header、302 或 reject`);
  }
  try {
    new RegExp(pattern);
  } catch {
    result.errors.push(`第 ${lineNumber} 行正则表达式无效`);
  }
  if (!isValidUrlRewriteReplacement(type, replacement)) {
    result.errors.push(`第 ${lineNumber} 行 ${type || "该"} 动作需要有效替换 URL`);
  }
  return result;
}

function validateSurgeUrlRewriteLines(lines) {
  const validation = { errors: [], warnings: [] };
  (lines || []).forEach((line, index) => {
    const result = validateSurgeUrlRewriteLine(line, index + 1);
    validation.errors.push(...result.errors);
    validation.warnings.push(...result.warnings);
  });
  return validation;
}

function renderSurgeUrlRewriteValidation(validation) {
  const messages = [
    ...(validation?.errors || []).map((message) => ({ type: "error", message })),
    ...(validation?.warnings || []).map((message) => ({ type: "warning", message }))
  ];
  refs.surgeUrlRewriteValidation.classList.toggle("hidden", messages.length === 0);
  refs.surgeUrlRewriteValidation.innerHTML = messages
    .map(({ type, message }) => `<div class="${type}">${escapeHtml(message)}</div>`)
    .join("");
}

function currentSurgeUrlRewriteLines() {
  return isModeTogglePressed(refs.surgeUrlRewriteAdvancedMode)
    ? textToLines(refs.surgeUrlRewrite.value)
    : buildSurgeUrlRewriteLines(readSurgeUrlRewriteRows());
}

function validateCurrentSurgeUrlRewrite() {
  const validation = validateSurgeUrlRewriteLines(currentSurgeUrlRewriteLines());
  renderSurgeUrlRewriteValidation(validation);
  return validation;
}

function parseSurgeUrlRewriteLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";") || /^\[[^\]]+\]$/.test(trimmed)) return null;
  const parsed = splitSurgeUrlRewriteLine(trimmed);
  return parsed.pattern || parsed.replacement || parsed.type ? parsed : null;
}

function defaultSurgeUrlRewrite() {
  return { pattern: "", replacement: "-", type: "reject" };
}

function renderSurgeUrlRewriteTypeOptions(selected) {
  return ["reject", "302", "header"]
    .map((type) => `<option value="${type}"${type === selected ? " selected" : ""}>${type}</option>`)
    .join("");
}

function renderSurgeUrlRewriteRow(rule) {
  const normalized = rule || defaultSurgeUrlRewrite();
  const type = ["reject", "302", "header"].includes(normalized.type) ? normalized.type : "reject";
  return `
    <div class="surge-url-rewrite-row" data-surge-url-rewrite>
      <label>
        <span>${escapeHtml(t("surgeUrlRewritePattern"))}</span>
        ${inputWithTitle(`data-surge-url-rewrite-part="pattern" placeholder="^https?:\\/\\/example\\.com\\/ad"`, normalized.pattern || "")}
      </label>
      <label>
        <span>${escapeHtml(t("surgeUrlRewriteReplacement"))}</span>
        ${inputWithTitle('data-surge-url-rewrite-part="replacement" placeholder="-"', normalized.replacement || "")}
        <small>${escapeHtml(t("surgeUrlRewriteReplacementHelp"))}</small>
      </label>
      <label>
        <span>${escapeHtml(t("surgeUrlRewriteType"))}</span>
        <select data-surge-url-rewrite-part="type">${renderSurgeUrlRewriteTypeOptions(type)}</select>
      </label>
      <div class="surge-url-rewrite-actions">
        <button class="btn" data-surge-url-rewrite-move="up" type="button">${escapeHtml(t("moveUp"))}</button>
        <button class="btn" data-surge-url-rewrite-move="down" type="button">${escapeHtml(t("moveDown"))}</button>
        <button class="danger" data-surge-url-rewrite-remove type="button">${escapeHtml(t("remove"))}</button>
      </div>
    </div>
  `;
}

function renderSurgeUrlRewriteEmpty() {
  return `<div class="surge-url-rewrite-empty">${escapeHtml(t("surgeUrlRewriteNoRows"))}</div>`;
}

function renderSurgeUrlRewriteRows(lines) {
  const rules = (lines || []).map(parseSurgeUrlRewriteLine).filter(Boolean);
  refs.surgeUrlRewriteRows.innerHTML = rules.length > 0
    ? rules.map(renderSurgeUrlRewriteRow).join("")
    : renderSurgeUrlRewriteEmpty();
  updateSurgeUrlRewriteOutput();
}

function readSurgeUrlRewriteRow(row) {
  const type = (row.querySelector('[data-surge-url-rewrite-part="type"]')?.value || "reject").trim().toLowerCase();
  return {
    pattern: row.querySelector('[data-surge-url-rewrite-part="pattern"]')?.value.trim() || "",
    replacement: row.querySelector('[data-surge-url-rewrite-part="replacement"]')?.value.trim() || (type === "reject" ? "-" : ""),
    type
  };
}

function readSurgeUrlRewriteRows() {
  return Array.from(refs.surgeUrlRewriteRows.querySelectorAll("[data-surge-url-rewrite]")).map(readSurgeUrlRewriteRow);
}

function buildSurgeUrlRewriteLine(rule) {
  const pattern = String(rule.pattern || "").trim();
  const replacement = String(rule.replacement || "").trim() || (rule.type === "reject" ? "-" : "");
  const type = String(rule.type || "").trim().toLowerCase();
  return pattern || replacement || type ? `${pattern} ${replacement} ${type}` : "";
}

function buildSurgeUrlRewriteLines(rules) {
  return (rules || []).map(buildSurgeUrlRewriteLine).filter(Boolean);
}

function updateSurgeUrlRewriteOutput() {
  if (!isModeTogglePressed(refs.surgeUrlRewriteAdvancedMode)) {
    refs.surgeUrlRewrite.value = buildSurgeUrlRewriteLines(readSurgeUrlRewriteRows()).join("\n");
  }
  syncConfigCodeEditor(refs.surgeUrlRewrite);
  validateCurrentSurgeUrlRewrite();
}

function syncSurgeUrlRewriteMode() {
  const advanced = isModeTogglePressed(refs.surgeUrlRewriteAdvancedMode);
  refs.surgeUrlRewriteStructuredEditor.classList.toggle("hidden", advanced);
  refs.surgeUrlRewrite.readOnly = !advanced;
  refs.surgeUrlRewrite.classList.toggle("advanced", advanced);
  syncTextModeLabels(refs.surgeUrlRewriteAdvancedMode, refs.surgeUrlRewriteLabel, advanced);
  syncConfigCodeEditor(refs.surgeUrlRewrite);
  validateCurrentSurgeUrlRewrite();
}

function toggleSurgeUrlRewriteAdvancedMode() {
  const advanced = !isModeTogglePressed(refs.surgeUrlRewriteAdvancedMode);
  setModeTogglePressed(refs.surgeUrlRewriteAdvancedMode, advanced);
  if (!advanced) {
    renderSurgeUrlRewriteRows(textToLines(refs.surgeUrlRewrite.value));
  }
  syncSurgeUrlRewriteMode();
}

function addSurgeUrlRewrite() {
  refs.surgeUrlRewriteRows.querySelector(".surge-url-rewrite-empty")?.remove();
  refs.surgeUrlRewriteRows.insertAdjacentHTML("beforeend", renderSurgeUrlRewriteRow(defaultSurgeUrlRewrite()));
  updateSurgeUrlRewriteOutput();
}

function ensureSurgeUrlRewriteEmptyState() {
  if (refs.surgeUrlRewriteRows.querySelector("[data-surge-url-rewrite]")) return;
  refs.surgeUrlRewriteRows.innerHTML = renderSurgeUrlRewriteEmpty();
}

function handleSurgeUrlRewriteListClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  const row = target?.closest("[data-surge-url-rewrite]");
  if (!row) return;
  if (target.closest("[data-surge-url-rewrite-remove]")) {
    row.remove();
    ensureSurgeUrlRewriteEmptyState();
    updateSurgeUrlRewriteOutput();
    return;
  }
  const move = target.closest("[data-surge-url-rewrite-move]")?.dataset.surgeUrlRewriteMove;
  if (move === "up") {
    const previous = row.previousElementSibling?.matches("[data-surge-url-rewrite]") ? row.previousElementSibling : null;
    if (previous) refs.surgeUrlRewriteRows.insertBefore(row, previous);
    updateSurgeUrlRewriteOutput();
    return;
  }
  if (move === "down") {
    const next = row.nextElementSibling?.matches("[data-surge-url-rewrite]") ? row.nextElementSibling : null;
    if (next) refs.surgeUrlRewriteRows.insertBefore(next, row);
    updateSurgeUrlRewriteOutput();
  }
}

function handleSurgeUrlRewriteListChange(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target?.closest("[data-surge-url-rewrite]")) return;
  updateSurgeUrlRewriteOutput();
}

function splitSurgeRuleLine(line) {
  const parts = [];
  let current = "";
  let depth = 0;
  for (const char of String(line || "")) {
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim() || parts.length > 0) parts.push(current.trim());
  return parts;
}

function surgePolicyCandidates() {
  const groups = groupEntries().map(([name]) => name);
  const ponteDevices = normalizePonteDeviceNames(state?.surge?.ponteDeviceNames || [])
    .map((name) => `DEVICE:${name}`);
  return [...new Set([...groups, ...SUBNET_BUILT_IN_POLICIES, ...ponteDevices])];
}

function normalizeSurgeRulePolicy(policy) {
  const trimmed = String(policy || "").trim();
  const candidates = surgePolicyCandidates();
  return candidates.includes(trimmed) ? trimmed : candidates[0] || "Proxy";
}

function isKnownSurgePolicy(policy) {
  const trimmed = String(policy || "").trim();
  return surgePolicyCandidates().includes(trimmed) || isSurgeDevicePolicy(trimmed);
}

function isValidSurgePolicy(policy) {
  const trimmed = String(policy || "").trim();
  return Boolean(trimmed) && !/[\r\n,[\]]/.test(trimmed);
}

function isSurgeDevicePolicy(policy) {
  return /^DEVICE:[^,\r\n[\]]+$/i.test(String(policy || "").trim());
}

function renderPolicyLabel(policy) {
  return SURGE_BUILT_IN_POLICY_LABELS[policy] || policy;
}

function normalizePonteDeviceNames(value) {
  const items = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(items
    .map((item) => String(item).trim().replace(/^DEVICE:/i, "").trim())
    .filter((item) => item && !/[,\r\n[\]]/.test(item)))];
}

function validateSurgeRuleLine(line, lineNumber) {
  const trimmed = String(line || "").trim();
  const result = { errors: [], warnings: [] };
  if (!trimmed || trimmed.startsWith("#")) return result;
  if (/^\[[^\]]+\]$/.test(trimmed)) {
    result.errors.push(`第 ${lineNumber} 行不能包含配置段标题`);
    return result;
  }

  const parts = splitSurgeRuleLine(trimmed);
  const type = (parts[0] || "").trim().toUpperCase();
  if (!type) {
    result.errors.push(`第 ${lineNumber} 行缺少规则类型`);
    return result;
  }
  if (parts.some((part) => !part.trim())) {
    result.errors.push(`第 ${lineNumber} 行存在空参数`);
    return result;
  }

  let policy = "";
  if (SURGE_RULE_SET_TYPES.has(type)) {
    if (parts.length < 3) {
      result.errors.push(`第 ${lineNumber} 行规则集语法应为 ${type},名称,策略`);
      return result;
    }
    policy = parts[2] || "";
    const optionError = validateSurgeRuleOptions(parts.slice(3), "rule-set", type, "");
    if (optionError) result.errors.push(`第 ${lineNumber} 行${optionError}`);
  } else if (SURGE_VALUELESS_RULE_TYPES.has(type)) {
    if (parts.length < 2) {
      result.errors.push(`第 ${lineNumber} 行 ${type} 规则缺少策略出口`);
      return result;
    }
    policy = parts[1] || "";
    const optionError = validateSurgeRuleOptions(parts.slice(2), "single", "", type);
    if (optionError) result.errors.push(`第 ${lineNumber} 行${optionError}`);
  } else {
    if (!SURGE_VALUE_RULE_TYPES.has(type)) {
      result.errors.push(`第 ${lineNumber} 行规则类型 ${type} 不受支持`);
      return result;
    }
    if (parts.length < 3) {
      result.errors.push(`第 ${lineNumber} 行语法应为 类型,匹配值,策略`);
      return result;
    }
    policy = parts[2] || "";
    const optionError = validateSurgeRuleOptions(parts.slice(3), "single", "", type);
    if (optionError) result.errors.push(`第 ${lineNumber} 行${optionError}`);
  }

  if (!isValidSurgePolicy(policy)) {
    result.errors.push(`第 ${lineNumber} 行策略出口格式无效`);
  } else if (!isKnownSurgePolicy(policy)) {
    result.errors.push(`第 ${lineNumber} 行${t("surgeRuleUnknownPolicy")}`);
  }
  return result;
}

function validateSurgeRuleOptions(options, kind, setType, ruleType) {
  const values = (options || []).map((option) => option.trim().toLowerCase()).filter(Boolean);
  const uniqueValues = new Set(values);
  if (uniqueValues.size !== values.length) return "附加参数不能重复";
  const allowed = allowedSurgeRuleOptions(kind, setType, ruleType);
  const invalid = values.filter((option) => !allowed.has(option) || !SURGE_RULE_OPTION_ORDER.includes(option));
  if (invalid.length === 0) return "";
  const allowedText = [...allowed].join(", ") || t("surgeRuleOptionNone");
  return `${t("surgeRuleOptionInvalid")} 可用参数：${allowedText}。`;
}

function effectiveSurgeRuleEntries(lines) {
  return (lines || []).map((line, index) => {
    const trimmed = String(line || "").trim();
    if (!trimmed || trimmed.startsWith("#")) return null;
    return {
      lineNumber: index + 1,
      type: (splitSurgeRuleLine(trimmed)[0] || "").trim().toUpperCase()
    };
  }).filter(Boolean);
}

function validateSurgeRuleLines(lines) {
  const validation = { errors: [], warnings: [] };
  (lines || []).forEach((line, index) => {
    const result = validateSurgeRuleLine(line, index + 1);
    validation.errors.push(...result.errors);
    validation.warnings.push(...result.warnings);
  });
  const effectiveRules = effectiveSurgeRuleEntries(lines);
  const finalRules = effectiveRules.filter((rule) => rule.type === "FINAL");
  if (finalRules.length === 0) {
    validation.errors.push(t("surgeRuleFinalMissing"));
  } else if (finalRules.length > 1) {
    validation.errors.push(t("surgeRuleFinalDuplicate"));
  } else if (effectiveRules[effectiveRules.length - 1]?.type !== "FINAL") {
    validation.errors.push(t("surgeRuleFinalNotLast"));
  }
  return validation;
}

function renderSurgeRuleValidation(validation) {
  const messages = [
    ...(validation?.errors || []).map((message) => ({ type: "error", message })),
    ...(validation?.warnings || []).map((message) => ({ type: "warning", message }))
  ];
  refs.surgeRuleValidation.classList.toggle("hidden", messages.length === 0);
  refs.surgeRuleValidation.innerHTML = messages
    .map(({ type, message }) => `<div class="${type}">${escapeHtml(message)}</div>`)
    .join("");
}

function currentSurgeRuleLines() {
  return isModeTogglePressed(refs.surgeRuleAdvancedMode)
    ? textToLines(refs.surgeRules.value)
    : buildSurgeRuleLines(readSurgeRuleRows());
}

function validateCurrentSurgeRules() {
  const validation = validateSurgeRuleLines(currentSurgeRuleLines());
  renderSurgeRuleValidation(validation);
  return validation;
}

function parseSurgeRuleLine(line) {
  const parts = splitSurgeRuleLine(line);
  const type = (parts[0] || "").trim().toUpperCase();
  if (!type) return null;
  if (SURGE_RULE_SET_TYPES.has(type)) {
    return {
      kind: "rule-set",
      setType: type,
      setName: parts[1] || "",
      policy: normalizeSurgeRulePolicy(parts[2] || ""),
      options: parts.slice(3).join(", ")
    };
  }
  const valueless = SURGE_VALUELESS_RULE_TYPES.has(type);
  const policyIndex = valueless ? 1 : 2;
  return {
    kind: "single",
    ruleType: type,
    value: valueless ? "" : parts[1] || "",
    policy: normalizeSurgeRulePolicy(parts[policyIndex] || ""),
    options: parts.slice(policyIndex + 1).join(", ")
  };
}

function finalSurgeRule() {
  return { kind: "single", ruleType: "FINAL", value: "", policy: normalizeSurgeRulePolicy("Proxy"), options: "" };
}

function isFinalSurgeRule(rule) {
  return String(rule?.ruleType || "").trim().toUpperCase() === "FINAL";
}

function normalizeSurgeRuleRows(rules) {
  const list = Array.isArray(rules) ? rules : [];
  const finalRule = list.find(isFinalSurgeRule) || finalSurgeRule();
  return [
    ...list.filter((rule) => !isFinalSurgeRule(rule)),
    { ...finalRule, kind: "single", ruleType: "FINAL", value: "" }
  ];
}

function defaultSurgeRule(kind = "single") {
  const policy = normalizeSurgeRulePolicy("Proxy");
  return kind === "rule-set"
    ? { kind: "rule-set", setType: "RULE-SET", setName: "", policy, options: "" }
    : { kind: "single", ruleType: "DOMAIN-SUFFIX", value: "", policy, options: "" };
}

function renderSurgeRuleKindOptions(selected) {
  return [
    ["single", t("surgeRuleKindSingle")],
    ["rule-set", t("surgeRuleKindRuleSet")]
  ].map(([value, label]) => `<option value="${value}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");
}

function renderSurgeRuleTypeOptions(selected, lockedFinal = false) {
  if (lockedFinal) return '<option value="FINAL" selected>FINAL</option>';
  const editableTypes = SURGE_RULE_TYPES.filter((type) => type !== "FINAL");
  const types = editableTypes.includes(selected) ? editableTypes : [selected, ...editableTypes].filter(Boolean);
  return types.map((type) => `<option value="${escapeHtml(type)}"${type === selected ? " selected" : ""}>${escapeHtml(type)}</option>`).join("");
}

function renderSurgeRuleSetTypeOptions(selected) {
  const normalized = SURGE_RULE_SET_TYPES.has(selected) ? selected : "RULE-SET";
  return [...SURGE_RULE_SET_TYPES]
    .map((type) => `<option value="${escapeHtml(type)}"${type === normalized ? " selected" : ""}>${escapeHtml(type)}</option>`)
    .join("");
}

function renderSurgePolicyOptions(selected) {
  const selectedPolicy = normalizeSurgeRulePolicy(selected);
  return surgePolicyCandidates()
    .map((policy) => `<option value="${escapeHtml(policy)}"${policy === selectedPolicy ? " selected" : ""}>${escapeHtml(renderPolicyLabel(policy))}</option>`)
    .join("");
}

function allowedSurgeRuleOptions(kind, setType, ruleType) {
  if (kind === "rule-set") {
    return setType === "DOMAIN-SET" ? SURGE_DOMAIN_SET_OPTIONS : SURGE_RULE_SET_OPTIONS;
  }
  const type = String(ruleType || "").trim().toUpperCase();
  if (["IP-CIDR", "IP-CIDR6", "GEOIP"].includes(type)) return SURGE_IP_RULE_OPTIONS;
  if (SURGE_EXTENDED_MATCHING_RULE_TYPES.has(type)) return SURGE_DOMAIN_SET_OPTIONS;
  if (type === "FINAL") return SURGE_FINAL_RULE_OPTIONS;
  return new Set();
}

function normalizeSurgeRuleOptions(value, kind, setType, ruleType) {
  const allowed = allowedSurgeRuleOptions(kind, setType, ruleType);
  const requested = String(value || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  const output = [];
  for (const option of SURGE_RULE_OPTION_ORDER) {
    if (requested.includes(option) && allowed.has(option)) output.push(option);
  }
  return output.join(",");
}

function renderSurgeRuleOptionChoices(kind, setType, ruleType, selected) {
  const allowed = allowedSurgeRuleOptions(kind, setType, ruleType);
  const selectedValue = normalizeSurgeRuleOptions(selected, kind, setType, ruleType);
  const choices = [["", t("surgeRuleOptionNone")]];
  for (const option of SURGE_RULE_OPTION_ORDER) {
    if (allowed.has(option)) choices.push([option, option]);
  }
  if (allowed.has("no-resolve") && allowed.has("extended-matching")) {
    choices.push(["no-resolve,extended-matching", "no-resolve + extended-matching"]);
  }
  return choices
    .map(([value, label]) => `<option value="${escapeHtml(value)}"${value === selectedValue ? " selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
}

function renderSurgeRuleRow(rule) {
  const normalized = rule || defaultSurgeRule();
  const kind = normalized.kind === "rule-set" ? "rule-set" : "single";
  const setType = SURGE_RULE_SET_TYPES.has(normalized.setType) ? normalized.setType : "RULE-SET";
  const ruleType = normalized.ruleType || "DOMAIN-SUFFIX";
  const lockedFinal = kind === "single" && ruleType === "FINAL";
  const valueless = SURGE_VALUELESS_RULE_TYPES.has(ruleType);
  const disabledAttr = lockedFinal ? " disabled" : "";
  const mainField = kind === "rule-set"
    ? `<label>
        <span>${escapeHtml(t("surgeRuleSetType"))}</span>
        <select data-surge-rule-part="setType">${renderSurgeRuleSetTypeOptions(setType)}</select>
      </label>
      <label>
        <span>${escapeHtml(t("surgeRuleSetName"))}</span>
        ${inputWithTitle('class="surge-rule-set-address" data-surge-rule-part="setName" dir="rtl"', normalized.setName || "")}
      </label>`
    : `<label>
        <span>${escapeHtml(t("surgeRuleType"))}</span>
        <select data-surge-rule-part="ruleType"${disabledAttr}>${renderSurgeRuleTypeOptions(ruleType, lockedFinal)}</select>
        ${lockedFinal ? `<small>${escapeHtml(t("surgeRuleFinalLocked"))}</small>` : ""}
      </label>
      <label>
        <span>${escapeHtml(t("surgeRuleValue"))}</span>
        ${inputWithTitle(`data-surge-rule-part="value"${valueless ? " disabled" : ""}`, normalized.value || "")}
      </label>`;
  return `
    <div class="surge-rule-row ${kind === "rule-set" ? "rule-set" : "single"}" data-surge-rule${lockedFinal ? " data-surge-rule-final" : ""}>
      <label>
        <span>${escapeHtml(t("surgeRuleKind"))}</span>
        <select data-surge-rule-part="kind"${disabledAttr}>${renderSurgeRuleKindOptions(kind)}</select>
      </label>
      ${mainField}
      <label>
        <span>${escapeHtml(t("surgeRulePolicy"))}</span>
        <select data-surge-rule-part="policy">${renderSurgePolicyOptions(normalized.policy)}</select>
      </label>
      <label>
        <span>${escapeHtml(t("surgeRuleOptions"))}</span>
        <select data-surge-rule-part="options">${renderSurgeRuleOptionChoices(kind, setType, ruleType, normalized.options || "")}</select>
      </label>
      <div class="surge-rule-actions">
        <button class="btn" data-surge-rule-move="up" type="button"${disabledAttr}>${escapeHtml(t("moveUp"))}</button>
        <button class="btn" data-surge-rule-move="down" type="button"${disabledAttr}>${escapeHtml(t("moveDown"))}</button>
        <button class="danger" data-surge-rule-remove type="button"${disabledAttr}>${escapeHtml(t("remove"))}</button>
      </div>
    </div>
  `;
}

function renderSurgeRuleEmpty() {
  return `<div class="surge-rule-empty">${escapeHtml(t("surgeRuleNoRows"))}</div>`;
}

function renderSurgeRuleRows(lines) {
  const rules = normalizeSurgeRuleRows((lines || []).map(parseSurgeRuleLine).filter(Boolean));
  refs.surgeRuleRows.innerHTML = rules.length > 0
    ? rules.map(renderSurgeRuleRow).join("")
    : renderSurgeRuleEmpty();
  updateSurgeRuleOutput();
}

function readSurgeRuleRow(row) {
  const kind = row.querySelector('[data-surge-rule-part="kind"]')?.value || "single";
  const policy = normalizeSurgeRulePolicy(row.querySelector('[data-surge-rule-part="policy"]')?.value || "");
  const options = row.querySelector('[data-surge-rule-part="options"]')?.value.trim() || "";
  if (kind === "rule-set") {
    const setType = (row.querySelector('[data-surge-rule-part="setType"]')?.value || "RULE-SET").trim().toUpperCase();
    return {
      kind,
      setType,
      setName: row.querySelector('[data-surge-rule-part="setName"]')?.value.trim() || "",
      policy,
      options: normalizeSurgeRuleOptions(options, kind, setType, "")
    };
  }
  const ruleType = (row.querySelector('[data-surge-rule-part="ruleType"]')?.value || "DOMAIN-SUFFIX").trim().toUpperCase();
  return {
    kind: "single",
    ruleType,
    value: row.querySelector('[data-surge-rule-part="value"]')?.value.trim() || "",
    policy,
    options: normalizeSurgeRuleOptions(options, kind, "", ruleType)
  };
}

function readSurgeRuleRows() {
  return Array.from(refs.surgeRuleRows.querySelectorAll("[data-surge-rule]")).map(readSurgeRuleRow);
}

function buildSurgeRuleLine(rule) {
  if (rule.kind === "rule-set") {
    const type = SURGE_RULE_SET_TYPES.has(rule.setType) ? rule.setType : "RULE-SET";
    const name = String(rule.setName || "").trim();
    const options = normalizeSurgeRuleOptions(rule.options, "rule-set", type, "");
    const suffix = options ? `,${options}` : "";
    return `${type},${name},${normalizeSurgeRulePolicy(rule.policy)}${suffix}`;
  }
  const type = String(rule.ruleType || "").trim().toUpperCase();
  const policy = normalizeSurgeRulePolicy(rule.policy);
  const options = normalizeSurgeRuleOptions(rule.options, "single", "", type);
  const suffix = options ? `,${options}` : "";
  if (!type) return "";
  if (SURGE_VALUELESS_RULE_TYPES.has(type)) {
    return `${type},${policy}${suffix}`;
  }
  const value = String(rule.value || "").trim();
  return `${type},${value},${policy}${suffix}`;
}

function buildSurgeRuleLines(rules) {
  return normalizeSurgeRuleRows(rules).map(buildSurgeRuleLine).filter(Boolean);
}

function updateSurgeRuleOutput() {
  if (!isModeTogglePressed(refs.surgeRuleAdvancedMode)) {
    refs.surgeRules.value = buildSurgeRuleLines(readSurgeRuleRows()).join("\n");
  }
  syncConfigCodeEditor(refs.surgeRules);
  validateCurrentSurgeRules();
}

function syncSurgeRuleMode() {
  const advanced = isModeTogglePressed(refs.surgeRuleAdvancedMode);
  refs.surgeRuleStructuredEditor.classList.toggle("hidden", advanced);
  refs.surgeRuleStructuredActions.classList.toggle("hidden", advanced);
  refs.surgeRules.readOnly = !advanced;
  refs.surgeRules.classList.toggle("advanced", advanced);
  syncTextModeLabels(refs.surgeRuleAdvancedMode, refs.surgeRulesLabel, advanced);
  syncConfigCodeEditor(refs.surgeRules);
  validateCurrentSurgeRules();
}

function syncSurgePonteDeviceNames() {
  state.surge.ponteDeviceNames = normalizePonteDeviceNames(refs.surgePonteDeviceNames.value);
  if (isModeTogglePressed(refs.surgeRuleAdvancedMode)) {
    validateCurrentSurgeRules();
    return;
  }
  const lines = buildSurgeRuleLines(readSurgeRuleRows());
  renderSurgeRuleRows(lines);
}

function toggleSurgeRuleAdvancedMode() {
  const advanced = !isModeTogglePressed(refs.surgeRuleAdvancedMode);
  setModeTogglePressed(refs.surgeRuleAdvancedMode, advanced);
  if (!advanced) {
    renderSurgeRuleRows(textToLines(refs.surgeRules.value));
  }
  syncSurgeRuleMode();
}

function addSurgeRule(kind) {
  refs.surgeRuleRows.querySelector(".surge-rule-empty")?.remove();
  const finalRow = refs.surgeRuleRows.querySelector("[data-surge-rule-final]");
  const html = renderSurgeRuleRow(defaultSurgeRule(kind));
  if (finalRow) {
    finalRow.insertAdjacentHTML("beforebegin", html);
  } else {
    refs.surgeRuleRows.insertAdjacentHTML("beforeend", html);
  }
  updateSurgeRuleOutput();
}

function ensureSurgeRuleEmptyState() {
  if (refs.surgeRuleRows.querySelector("[data-surge-rule]")) return;
  refs.surgeRuleRows.innerHTML = renderSurgeRuleEmpty();
}

function rerenderSurgeRuleRow(row) {
  const rule = readSurgeRuleRow(row);
  row.outerHTML = renderSurgeRuleRow(rule);
  updateSurgeRuleOutput();
}

function handleSurgeRuleListClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  const row = target?.closest("[data-surge-rule]");
  if (!row) return;
  if (row.matches("[data-surge-rule-final]")) return;
  if (target.closest("[data-surge-rule-remove]")) {
    row.remove();
    ensureSurgeRuleEmptyState();
    updateSurgeRuleOutput();
    return;
  }
  const move = target.closest("[data-surge-rule-move]")?.dataset.surgeRuleMove;
  if (move === "up") {
    const previous = row.previousElementSibling?.matches("[data-surge-rule]") ? row.previousElementSibling : null;
    if (previous) refs.surgeRuleRows.insertBefore(row, previous);
    updateSurgeRuleOutput();
    return;
  }
  if (move === "down") {
    const next = row.nextElementSibling?.matches("[data-surge-rule]") ? row.nextElementSibling : null;
    if (next?.matches("[data-surge-rule-final]")) return;
    if (next) refs.surgeRuleRows.insertBefore(next, row);
    updateSurgeRuleOutput();
  }
}

function handleSurgeRuleListChange(event) {
  const target = event.target instanceof Element ? event.target : null;
  const row = target?.closest("[data-surge-rule]");
  if (!row) return;
  if (target.matches('[data-surge-rule-part="kind"], [data-surge-rule-part="setType"], [data-surge-rule-part="ruleType"]')) {
    rerenderSurgeRuleRow(row);
    return;
  }
  updateSurgeRuleOutput();
}

function splitPolicyGroupSpec(spec) {
  const parts = [];
  let current = "";
  let braceDepth = 0;
  for (const char of String(spec || "")) {
    if (char === "{") braceDepth += 1;
    if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
    if (char === "," && braceDepth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseAllSelector(item) {
  const match = String(item).match(/^\{all(?:\s+filter=([^}]*?)(?=\s+exclude=|}))?(?:\s+exclude=([^}]+))?\}$/);
  if (!match) return null;
  return {
    filter: (match[1] || "").trim(),
    exclude: (match[2] || "").trim()
  };
}

function parseGroupSpec(name, spec) {
  const [type = "select", ...items] = splitPolicyGroupSpec(spec);
  const isSubnetSpec = type === "subnet";
  const editor = {
    type,
    choices: [],
    includeAll: false,
    filter: "",
    exclude: "",
    subnetDefault: "",
    subnetRules: [],
    url: "",
    interval: "",
    advancedOptions: []
  };

  for (const item of items) {
    const allSelector = parseAllSelector(item);
    if (allSelector) {
      editor.includeAll = true;
      editor.filter = allSelector.filter;
      editor.exclude = allSelector.exclude;
      continue;
    }
    const option = parseGroupOption(item);
    if (isSubnetSpec && option && option.key.toLowerCase() === "default") {
      editor.subnetDefault = option.value;
      continue;
    }
    if (isSubnetSpec && option && isSubnetConditionKey(option.key)) {
      editor.subnetRules.push({
        ...parseSubnetConditionKey(option.key),
        policy: option.value
      });
      continue;
    }
    if (option && GROUP_OPTION_FIELDS.has(option.key)) {
      editor[option.key] = option.value;
      continue;
    }
    if (option) {
      editor.advancedOptions.push(item);
      continue;
    }
    editor.choices.push(item);
  }
  return editor;
}

function parseGroupOption(item) {
  const match = String(item).match(/^([^=,{}]+)=(.*)$/s);
  if (!match) return null;
  const key = match[1].trim();
  if (!key) return null;
  return {
    key,
    value: match[2].trim()
  };
}

function formatGroupOption(key, value) {
  return `${key.trim()}=${String(value).trim()}`;
}

function isSubnetConditionKey(key) {
  return Boolean(parseSubnetConditionKey(key));
}

function parseSubnetConditionKey(key) {
  const match = String(key || "").match(/^(SSID|BSSID|ROUTER|TYPE):(.+)$/i);
  if (!match) return null;
  const parameter = match[1].toUpperCase();
  const query = match[2].trim();
  if (!SUBNET_PARAMETERS.includes(parameter) || !query) return null;
  if (parameter === "TYPE" && !SUBNET_NETWORK_TYPES.includes(query.toUpperCase())) return null;
  return {
    parameter,
    query: parameter === "TYPE" ? query.toUpperCase() : query
  };
}

function makeAllSelector(filter, exclude) {
  const parts = ["{all"];
  if (filter.trim()) parts.push(`filter=${filter.trim()}`);
  if (exclude.trim()) parts.push(`exclude=${exclude.trim()}`);
  return `${parts.join(" ")}}`;
}

function commaList(value) {
  return splitPolicyGroupSpec(value).map((item) => item.trim()).filter(Boolean);
}

function choiceList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return commaList(value);
}

function groupList(value, currentName, groupNames = Object.keys(state.groups || {})) {
  const groups = new Set(groupNames.filter((name) => name !== currentName && name !== "Proxy"));
  const choices = choiceList(value);
  return choices.filter((item, index) => groups.has(item) && choices.indexOf(item) === index);
}

function subnetPolicyValue(value, currentName) {
  const policy = String(value || "").trim();
  if (!policy || policy === currentName) return "";
  return policy;
}

function subnetRuleList(value, currentName) {
  const output = [];
  const rules = Array.isArray(value) ? value : [];
  for (const rule of rules) {
    const normalized = normalizeSubnetRule(rule);
    if (!normalized) continue;
    const policy = subnetPolicyValue(normalized.policy, currentName);
    if (!policy) continue;
    const item = formatGroupOption(subnetConditionKey(normalized.parameter, normalized.query), policy);
    output.push(item);
  }
  return output;
}

function normalizeSubnetRule(rule) {
  if (typeof rule === "string") {
    const option = parseGroupOption(rule);
    if (!option) return null;
    const condition = parseSubnetConditionKey(option.key);
    return condition ? { ...condition, policy: option.value } : null;
  }
  const parameter = String(rule?.parameter || "").trim().toUpperCase();
  const rawQuery = String(rule?.query || "").trim();
  const query = parameter === "TYPE" ? rawQuery.toUpperCase() : rawQuery;
  const policy = String(rule?.policy || "").trim();
  if (!SUBNET_PARAMETERS.includes(parameter) || !query || !policy) return null;
  if (parameter === "TYPE" && !SUBNET_NETWORK_TYPES.includes(query)) return null;
  return { parameter, query, policy };
}

function subnetConditionKey(parameter, query) {
  return `${parameter}:${query}`;
}

function serializeGroupEditor(editor, groupNames) {
  const type = editor.type.trim() || "select";
  const parts = [type];
  if (type === "subnet") {
    parts.push(`default=${subnetPolicyValue(editor.subnetDefault, editor.name) || "Proxy"}`);
    parts.push(...subnetRuleList(editor.subnetRules, editor.name));
    return parts.join(", ");
  }
  parts.push(...groupList(editor.choices, editor.name, groupNames));
  if (editor.includeAll) {
    parts.push(makeAllSelector(editor.filter, editor.exclude));
  }
  if (type !== "select") {
    if (editor.url.trim()) parts.push(`url=${editor.url.trim()}`);
    if (editor.interval.trim()) parts.push(`interval=${editor.interval.trim()}`);
    if (type !== "url-test") {
      parts.push(...commaList(editor.advancedOptions));
    }
  }
  return parts.join(", ");
}

function normalizeGroupSpec(name, spec, groupNames) {
  const editor = parseGroupSpec(name, spec);
  return serializeGroupEditor({
    ...editor,
    name,
    advancedOptions: editor.advancedOptions.join(", ")
  }, groupNames);
}

function normalizeGroupEntries(entries) {
  const groupNames = entries.map(([name]) => name);
  return entries.map(([name, spec]) => [name, normalizeGroupSpec(name, spec, groupNames)]);
}

function renameFixedGroupChoices(entries, previousName, nextName) {
  if (!previousName || !nextName || previousName === nextName) return entries;
  const groupNames = entries.map(([name]) => name);
  return entries.map(([name, spec]) => {
    const editor = parseGroupSpec(name, spec);
    const choices = editor.choices.map((choice) => choice === previousName ? nextName : choice);
    const subnetDefault = editor.subnetDefault === previousName ? nextName : editor.subnetDefault;
    const subnetRules = editor.subnetRules.map((rule) => rule.policy === previousName ? { ...rule, policy: nextName } : rule);
    return [name, serializeGroupEditor({
      ...editor,
      name,
      choices,
      subnetDefault,
      subnetRules,
      advancedOptions: editor.advancedOptions.join(", ")
    }, groupNames)];
  });
}

function readGroupEditor(row) {
  const type = row.querySelector('[data-group-part="type"]').value;
  const usesSubscriptionNodes = type !== "fallback" && type !== "subnet";
  const includeAll = usesSubscriptionNodes && row.querySelector('[data-group-part="includeAll"]').checked;
  return {
    type,
    name: row.dataset.groupName || "",
    choices: Array.from(row.querySelectorAll('[data-group-part="choices"]:checked')).map((input) => input.value),
    includeAll,
    filter: includeAll ? row.querySelector('[data-group-part="filter"]').value : "",
    exclude: includeAll ? row.querySelector('[data-group-part="exclude"]').value : "",
    subnetDefault: row.querySelector('[data-group-part="subnetDefault"]').value,
    subnetRules: readSubnetRules(row),
    url: row.querySelector('[data-group-part="url"]').value,
    interval: row.querySelector('[data-group-part="interval"]').value,
    advancedOptions: row.querySelector('[data-group-part="advancedOptions"]').value
  };
}

function renderGroupTypeOptions(type) {
  const types = GROUP_TYPES.includes(type) ? GROUP_TYPES : [type, ...GROUP_TYPES];
  return types.map((item) => `<option value="${escapeHtml(item)}"${item === type ? " selected" : ""}>${escapeHtml(groupTypeLabel(item))}</option>`).join("");
}

function groupTypeLabel(type) {
  return {
    select: t("groupTypeLabelSelect"),
    "url-test": t("groupTypeLabelAuto"),
    fallback: t("groupTypeLabelFallback"),
    "load-balance": t("groupTypeLabelLoadBalance"),
    subnet: t("groupTypeLabelSubnet")
  }[type] || type;
}

function renderGroupChoiceInputs(currentName, choices) {
  const candidates = groupEntries().map(([name]) => name).filter((name) => name !== currentName && name !== "Proxy");
  if (candidates.length === 0) {
    return `<div class="group-choice-empty">${escapeHtml(t("noGroupChoices"))}</div>`;
  }
  const selected = new Set(groupList(choices, currentName));
  return candidates.map((name) => `
    <label class="group-choice-item">
      <input data-group-part="choices" type="checkbox" value="${escapeHtml(name)}"${selected.has(name) ? " checked" : ""}>
      <span>${escapeHtml(name)}</span>
    </label>
  `).join("");
}

function subnetPolicyCandidates(currentName) {
  const groups = groupEntries().map(([name]) => name).filter((name) => name !== currentName);
  return [...new Set([...groups, ...SUBNET_BUILT_IN_POLICIES])];
}

function renderSubnetPolicyOptions(currentName, selected) {
  const selectedPolicy = subnetPolicyValue(selected, currentName) || "Proxy";
  const candidates = subnetPolicyCandidates(currentName);
  if (!candidates.includes(selectedPolicy) && selectedPolicy !== currentName) {
    candidates.push(selectedPolicy);
  }
  return candidates
    .filter((item) => item !== currentName)
    .map((item) => `<option value="${escapeHtml(item)}"${item === selectedPolicy ? " selected" : ""}>${escapeHtml(renderPolicyLabel(item))}</option>`)
    .join("");
}

function renderSubnetParameterOptions(selected) {
  const labels = {
    SSID: t("groupSubnetParamSsid"),
    BSSID: t("groupSubnetParamBssid"),
    ROUTER: t("groupSubnetParamRouter"),
    TYPE: t("groupSubnetParamType")
  };
  return SUBNET_PARAMETERS
    .map((item) => `<option value="${item}"${item === selected ? " selected" : ""}>${escapeHtml(labels[item])}</option>`)
    .join("");
}

function renderSubnetNetworkTypeOptions(selected) {
  const labels = {
    WIFI: t("groupSubnetTypeWifi"),
    WIRED: t("groupSubnetTypeWired"),
    CELLULAR: t("groupSubnetTypeCellular")
  };
  return SUBNET_NETWORK_TYPES
    .map((item) => `<option value="${item}"${item === selected ? " selected" : ""}>${escapeHtml(labels[item])}</option>`)
    .join("");
}

function renderSubnetRuleRow(currentName, rule = {}) {
  const normalized = normalizeSubnetRule(rule) || { parameter: "TYPE", query: "WIFI", policy: "Proxy" };
  return `
    <div class="subnet-rule-row" data-subnet-rule>
      <label>
        <span>${escapeHtml(t("groupSubnetParameter"))}</span>
        <select data-subnet-rule-part="parameter">${renderSubnetParameterOptions(normalized.parameter)}</select>
      </label>
      <label class="subnet-query-text-field">
        <span>${escapeHtml(t("groupSubnetQuery"))}</span>
        <input data-subnet-rule-part="queryText" value="${escapeHtml(normalized.parameter === "TYPE" ? "" : normalized.query)}">
      </label>
      <label class="subnet-query-type-field">
        <span>${escapeHtml(t("groupSubnetQuery"))}</span>
        <select data-subnet-rule-part="queryType">${renderSubnetNetworkTypeOptions(normalized.parameter === "TYPE" ? normalized.query : "WIFI")}</select>
      </label>
      <label>
        <span>${escapeHtml(t("groupSubnetPolicy"))}</span>
        <select data-subnet-rule-part="policy">${renderSubnetPolicyOptions(currentName, normalized.policy)}</select>
      </label>
      <button class="danger subnet-rule-remove" data-subnet-remove type="button">${escapeHtml(t("remove"))}</button>
    </div>
  `;
}

function renderSubnetRules(currentName, rules) {
  const rows = rules.map((rule) => renderSubnetRuleRow(currentName, rule)).join("");
  return `
    <div class="subnet-rule-list" data-subnet-rule-list>
      ${rows || renderSubnetRuleEmpty()}
    </div>
  `;
}

function renderSubnetRuleEmpty() {
  return `<div class="subnet-rule-empty">${escapeHtml(t("groupSubnetNoRules"))}</div>`;
}

function readSubnetRules(row) {
  return Array.from(row.querySelectorAll("[data-subnet-rule]")).map((ruleRow) => {
    const parameter = ruleRow.querySelector('[data-subnet-rule-part="parameter"]')?.value || "TYPE";
    const query = parameter === "TYPE"
      ? ruleRow.querySelector('[data-subnet-rule-part="queryType"]')?.value
      : ruleRow.querySelector('[data-subnet-rule-part="queryText"]')?.value;
    const policy = ruleRow.querySelector('[data-subnet-rule-part="policy"]')?.value || "";
    return { parameter, query, policy };
  });
}

function groupTypeHelp(type) {
  const key = {
    select: "groupTypeHelpSelect",
    "url-test": "groupTypeHelpUrlTest",
    fallback: "groupTypeHelpFallback",
    "load-balance": "groupTypeHelpLoadBalance",
    subnet: "groupTypeHelpSubnet"
  }[type];
  return key ? t(key) : "";
}

function renderGroups() {
  refs.groupsBody.innerHTML = "";
  const entries = groupEntries();
  entries.forEach(([name, spec], index) => {
    const builtIn = isBuiltInGroupName(name);
    const removalLocked = isRemovalLockedGroupName(name);
    const canToggleEnabled = isDisableToggleAllowed(name);
    const enabled = !isGroupDisabled(name);
    const editor = parseGroupSpec(name, spec);
    const displaySpec = normalizeGroupSpec(name, spec);
    const usesNodeOptions = editor.type !== "fallback" && editor.type !== "subnet";
    const isSubnetGroup = editor.type === "subnet";
    const row = document.createElement("tr");
    row.innerHTML = `
      <td class="group-name-cell" data-label="Name">
        <div class="group-card-kicker">
          <span>#${index + 1}</span>
          <span class="group-state-pill${enabled ? "" : " off"}">${escapeHtml(enabled ? t("enabled") : t("disabled"))}</span>
        </div>
        ${inputWithTitle(`class="group-name-input" data-field="name"${builtIn ? " disabled" : ""}`, name)}
        ${builtIn ? `<small class="cell-help locked-note">${escapeHtml(t("builtInGroupHelp"))}</small>` : ""}
        <label class="group-type-field group-meta-field">
          <span>${escapeHtml(t("groupType"))}</span>
          <select data-group-part="type">${renderGroupTypeOptions(editor.type)}</select>
          <small data-group-type-help>${escapeHtml(groupTypeHelp(editor.type))}</small>
        </label>
        ${canToggleEnabled ? `
          <label class="check group-enable">
            <input data-group-enabled type="checkbox"${enabled ? " checked" : ""}>
            <span>${escapeHtml(t("groupEnabled"))}</span>
          </label>
        ` : ""}
        <label class="group-check group-subscription-toggle group-node-option${usesNodeOptions ? "" : " hidden"}">
          <input data-group-part="includeAll" type="checkbox"${editor.includeAll ? " checked" : ""}>
          <span>${escapeHtml(t("groupIncludeAll"))}</span>
        </label>
        ${removalLocked ? "" : `
          <div class="group-card-actions">
            <button class="danger" data-remove type="button">${escapeHtml(t("remove"))}</button>
          </div>
        `}
      </td>
      <td class="group-definition-cell" data-label="Definition">
        <div class="group-editor">
          <div class="group-editor-grid">
            <div class="group-choice-field group-fixed-option${isSubnetGroup ? " hidden" : ""}">
              <span>${escapeHtml(t("groupFixedChoices"))}</span>
              <div class="group-choice-list">${renderGroupChoiceInputs(name, editor.choices)}</div>
              <small>${escapeHtml(t("groupFixedChoicesHelp"))}</small>
            </div>
            <label class="group-subnet-default-field group-subnet-option${isSubnetGroup ? "" : " hidden"}">
              <span>${escapeHtml(t("groupSubnetDefault"))}</span>
              <select data-group-part="subnetDefault">${renderSubnetPolicyOptions(name, editor.subnetDefault)}</select>
              <small>${escapeHtml(t("groupSubnetDefaultHelp"))}</small>
            </label>
            <div class="group-subnet-rules-field group-subnet-option${isSubnetGroup ? "" : " hidden"}">
              <div class="group-subnet-heading">
                <span>${escapeHtml(t("groupSubnetRules"))}</span>
                <button class="btn" data-subnet-add type="button">${escapeHtml(t("groupSubnetAddRule"))}</button>
              </div>
              ${renderSubnetRules(name, editor.subnetRules)}
              <small>${escapeHtml(t("groupSubnetRulesHelp"))}</small>
            </div>
            <label class="group-filter-field group-node-option${usesNodeOptions ? "" : " hidden"}">
              <span>${escapeHtml(t("groupFilterKeywords"))}</span>
              ${inputWithTitle('data-group-part="filter"', editor.filter)}
            </label>
            <label class="group-exclude-field group-node-option${usesNodeOptions ? "" : " hidden"}">
              <span>${escapeHtml(t("groupExcludeKeywords"))}</span>
              ${inputWithTitle('data-group-part="exclude"', editor.exclude)}
            </label>
            <small class="group-rule-help group-node-option${usesNodeOptions ? "" : " hidden"}">${escapeHtml(t("groupNodeRuleHelp"))}</small>
            <label class="group-url-field group-standard-option${isSubnetGroup ? " hidden" : ""}">
              <span>${escapeHtml(t("groupUrl"))}</span>
              ${inputWithTitle('data-group-part="url"', editor.url)}
            </label>
            <label class="group-interval-field group-standard-option${isSubnetGroup ? " hidden" : ""}">
              <span>${escapeHtml(t("groupInterval"))}</span>
              ${inputWithTitle('data-group-part="interval" inputmode="numeric"', editor.interval)}
            </label>
            <label class="group-advanced-field group-standard-option group-non-auto-option${isSubnetGroup ? " hidden" : ""}">
              <span>${escapeHtml(t("groupAdvancedOptions"))}</span>
              ${inputWithTitle('data-group-part="advancedOptions"', editor.advancedOptions.join(", "))}
              <small>${escapeHtml(t("groupAdvancedOptionsHelp"))}</small>
            </label>
          </div>
          <div class="group-generated">
            <span>${escapeHtml(t("groupGeneratedDefinition"))}</span>
            <code>${escapeHtml(displaySpec)}</code>
          </div>
        </div>
      </td>
    `;
    row.dataset.groupName = name;
    row.dataset.groupType = editor.type;
    row.querySelectorAll("td").forEach((cell) => {
      const labelKey = {
        Name: "tableName",
        Definition: "tableDefinition"
      }[cell.dataset.label];
      if (labelKey) cell.dataset.label = t(labelKey);
    });
    const nameInput = row.querySelector('[data-field="name"]');
    nameInput.addEventListener("input", (event) => updateGroupName(index, event.currentTarget));
    nameInput.addEventListener("change", () => renderGroups());
    row.querySelector("[data-group-enabled]")?.addEventListener("change", (event) => {
      setGroupDisabled(name, !event.currentTarget.checked);
      renderSummary();
    });
    row.querySelectorAll("[data-group-part]").forEach((input) => {
      const eventName = input.type === "checkbox" || input.tagName === "SELECT" ? "change" : "input";
      input.addEventListener(eventName, () => {
        syncGroupVisibility(row);
        updateGroupSpec(index, row);
      });
    });
    row.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const addButton = target?.closest("[data-subnet-add]");
      if (addButton) {
        addSubnetRuleRow(row);
        updateGroupSpec(index, row);
        return;
      }
      const removeButton = target?.closest("[data-subnet-remove]");
      if (removeButton) {
        removeButton.closest("[data-subnet-rule]")?.remove();
        ensureSubnetRuleEmptyState(row);
        updateGroupSpec(index, row);
      }
    });
    row.addEventListener("change", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.matches("[data-subnet-rule-part]")) return;
      syncSubnetRuleRows(row);
      updateGroupSpec(index, row);
    });
    row.addEventListener("input", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.matches('[data-subnet-rule-part="queryText"]')) return;
      updateGroupSpec(index, row);
    });
    row.querySelector("[data-remove]")?.addEventListener("click", () => {
      if (isRemovalLockedGroupName(name)) return;
      const next = groupEntries();
      next.splice(index, 1);
      setGroupEntries(normalizeGroupEntries(next));
      renderGroups();
      refreshConfigCodeEditors();
      renderSummary();
    });
    syncGroupVisibility(row);
    refs.groupsBody.append(row);
  });
}

function addSubnetRuleRow(row) {
  const list = row.querySelector("[data-subnet-rule-list]");
  if (!list) return;
  list.querySelector(".subnet-rule-empty")?.remove();
  list.insertAdjacentHTML("beforeend", renderSubnetRuleRow(row.dataset.groupName || "", { parameter: "TYPE", query: "WIFI", policy: "Proxy" }));
  syncSubnetRuleRows(row);
}

function ensureSubnetRuleEmptyState(row) {
  const list = row.querySelector("[data-subnet-rule-list]");
  if (list && !list.querySelector("[data-subnet-rule]")) {
    list.innerHTML = renderSubnetRuleEmpty();
  }
}

function syncSubnetRuleRows(row) {
  row.querySelectorAll("[data-subnet-rule]").forEach((ruleRow) => {
    const parameter = ruleRow.querySelector('[data-subnet-rule-part="parameter"]')?.value || "TYPE";
    const textField = ruleRow.querySelector(".subnet-query-text-field");
    const typeField = ruleRow.querySelector(".subnet-query-type-field");
    const isType = parameter === "TYPE";
    textField?.classList.toggle("hidden", isType);
    typeField?.classList.toggle("hidden", !isType);
  });
}

function syncGroupVisibility(row) {
  const type = row.querySelector('[data-group-part="type"]')?.value;
  row.dataset.groupType = type || "select";
  const help = row.querySelector("[data-group-type-help]");
  if (help) help.textContent = groupTypeHelp(type);
  const usesNodeOptions = type !== "fallback" && type !== "subnet";
  const isSubnetGroup = type === "subnet";
  const isAutoGroup = type === "url-test";
  const usesStandardOptions = type !== "select" && type !== "subnet";
  row.querySelectorAll(".group-node-option").forEach((element) => {
    element.classList.toggle("hidden", !usesNodeOptions);
  });
  row.querySelectorAll(".group-fixed-option").forEach((element) => {
    element.classList.toggle("hidden", isSubnetGroup);
  });
  row.querySelectorAll(".group-standard-option").forEach((element) => {
    element.classList.toggle("hidden", !usesStandardOptions);
  });
  row.querySelectorAll(".group-non-auto-option").forEach((element) => {
    element.classList.toggle("hidden", !usesStandardOptions || isAutoGroup);
  });
  row.querySelectorAll(".group-subnet-option").forEach((element) => {
    element.classList.toggle("hidden", !isSubnetGroup);
  });
  syncSubnetRuleRows(row);
  syncGroupNodeControls(row);
}

function syncGroupNodeControls(row) {
  const type = row.querySelector('[data-group-part="type"]')?.value;
  const includeAll = row.querySelector('[data-group-part="includeAll"]');
  const filter = row.querySelector('[data-group-part="filter"]');
  const exclude = row.querySelector('[data-group-part="exclude"]');
  const usesSubscriptionNodes = type !== "fallback" && type !== "subnet";
  const subscriptionNodesEnabled = usesSubscriptionNodes && Boolean(includeAll?.checked);
  if (includeAll) includeAll.disabled = !usesSubscriptionNodes;
  if (filter) filter.disabled = !subscriptionNodesEnabled;
  if (exclude) exclude.disabled = !subscriptionNodesEnabled;
}

function updateGroupName(index, input) {
  const entries = groupEntries();
  if (!entries[index]) return;
  const previousName = entries[index][0];
  const nextName = input.value.trim();
  if (isBuiltInGroupName(previousName)) {
    input.value = previousName;
    return;
  }
  if (isBuiltInGroupName(nextName)) {
    input.value = previousName;
    return;
  }
  if (entries.some(([name], entryIndex) => entryIndex !== index && name === nextName)) {
    input.value = previousName;
    return;
  }
  entries[index][0] = input.value;
  const renamedEntries = renameFixedGroupChoices(entries, previousName, input.value);
  setGroupEntries(renamedEntries);
  rowDatasetName(input, input.value);
  state.disabledGroups = (state.disabledGroups || []).map((name) => name === previousName ? input.value : name);
  refreshConfigCodeEditors();
  renderSummary();
}

function rowDatasetName(input, name) {
  const row = input.closest("tr");
  if (row) row.dataset.groupName = name;
}

function updateGroupSpec(index, row) {
  const entries = groupEntries();
  if (!entries[index]) return;
  const spec = serializeGroupEditor(readGroupEditor(row));
  entries[index][1] = spec;
  setGroupEntries(entries);
  row.querySelector(".group-generated code").textContent = spec;
  renderSummary();
}

function addGroup() {
  const entries = groupEntries();
  let name = t("newGroup");
  let suffix = 2;
  while (Object.prototype.hasOwnProperty.call(state.groups, name)) {
    name = `${t("newGroup")} ${suffix}`;
    suffix += 1;
  }
  entries.push([name, "select, {all}"]);
  setGroupEntries(entries);
  renderGroups();
  refreshConfigCodeEditors();
  renderSummary();
}

function renderSources() {
  refs.sourcesBody.innerHTML = "";
  for (const source of state.sources) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td data-label="Name">
        ${inputWithTitle('data-field="name"', source.name)}
        <small class="cell-help">${escapeHtml(t("sourceNameHelp"))}</small>
      </td>
      <td data-label="FetchUA">
        <select data-field="fetchUserAgent">
          <option value="surge">${escapeHtml(t("fetchUserAgentSurge"))}</option>
          <option value="clash">${escapeHtml(t("fetchUserAgentClash"))}</option>
        </select>
        <small class="cell-help">${escapeHtml(t("sourceFetchUserAgentHelp"))}</small>
      </td>
      <td class="source-enabled-cell" data-label="Enabled">
        <label class="source-enabled-toggle">
          <input data-field="enabled" type="checkbox">
        </label>
      </td>
      <td data-label="URL">
        ${inputWithTitle('class="url" data-field="url"', source.url || "")}
        <small class="cell-help">${escapeHtml(t("sourceUrlHelp"))}</small>
      </td>
      <td data-label="Action"><button class="danger" data-remove type="button">${escapeHtml(t("remove"))}</button></td>
    `;
    row.querySelectorAll("td").forEach((cell) => {
      const labelKey = {
        Name: "tableName",
        FetchUA: "tableFetchUserAgent",
        Enabled: "tableEnabled",
        URL: "tableUrl",
        Action: "tableAction"
      }[cell.dataset.label];
      if (labelKey) cell.dataset.label = t(labelKey);
    });
    row.querySelector('[data-field="fetchUserAgent"]').value = source.fetchUserAgent === "clash" ? "clash" : "surge";
    row.querySelector('[data-field="enabled"]').checked = source.enabled;
    row.querySelectorAll("[data-field]").forEach((input) => {
      input.addEventListener("input", () => updateSource(source.id, input));
      input.addEventListener("change", () => updateSource(source.id, input));
    });
    row.querySelector("[data-remove]").addEventListener("click", () => {
      state.sources = state.sources.filter((item) => item.id !== source.id);
      renderSources();
      renderSummary();
    });
    refs.sourcesBody.append(row);
  }
}

function updateSource(id, input) {
  const source = state.sources.find((item) => item.id === id);
  if (!source) return;
  const field = input.dataset.field;
  source[field] = input.type === "checkbox" ? input.checked : input.value;
  renderSummary();
}

function addSource() {
  state.sources.push({
    id: crypto.randomUUID(),
    name: t("newSource"),
    url: "",
    fetchUserAgent: "surge",
    enabled: true
  });
  renderSources();
  renderSummary();
}

function readSettingsDraft() {
  const notificationTelegramBotToken = refs.notificationTelegramBotToken.value.trim();
  return {
    settings: {
      ...state.settings,
      managedBaseUrl: refs.managedBaseUrl.value.trim(),
      userAgentSurge: refs.userAgentSurge.value.trim(),
      userAgentClash: refs.userAgentClash.value.trim(),
      excludeKeywords: refs.excludeKeywords.value.split(",").map((item) => item.trim()).filter(Boolean),
      featureTagRules: textToLines(refs.featureTagRules.value),
      notificationChannel: notificationTelegramBotToken ? "telegram" : "off",
      notificationTelegramChatId: notificationTelegramBotToken ? state.settings.notificationTelegramChatId || "" : "",
      notificationTelegramBotToken
    },
    chain: {
      ...state.chain,
      exitProxy: {
        ...state.chain.exitProxy,
        protocol: refs.chainExitProtocol.value,
        server: refs.chainExitServer.value.trim(),
        port: Number(refs.chainExitPort.value) || 1080,
        username: refs.chainExitUsername.value.trim(),
        password: refs.chainExitPassword.value.trim()
      },
      filter: refs.chainFilter.value.split(",").map((item) => item.trim()).filter(Boolean)
    }
  };
}

function collectSettings() {
  const draft = readSettingsDraft();
  state.settings = draft.settings;
  state.chain = draft.chain;
}

function readSurgeDraft() {
  return {
    ...state.surge,
    skipProxy: refs.surgeSkipProxy.value.split(",").map((item) => item.trim()).filter(Boolean),
    dnsServer: refs.surgeDnsServer.value.split(",").map((item) => item.trim()).filter(Boolean),
    alwaysRealIp: refs.surgeAlwaysRealIp.value.split(",").map((item) => item.trim()).filter(Boolean),
    managedConfigIntervalSeconds: Number(refs.surgeManagedConfigIntervalSeconds.value) || state.surge.managedConfigIntervalSeconds,
    internetTestUrl: refs.surgeInternetTestUrl.value.trim(),
    proxyTestUrl: refs.surgeProxyTestUrl.value.trim(),
    showErrorPageForReject: refs.surgeShowErrorPageForReject.checked,
    ipv6: refs.surgeIpv6.checked,
    ipv6Vif: refs.surgeIpv6Vif.value.trim(),
    allowWifiAccess: refs.surgeAllowWifiAccess.checked,
    tunExcludedRoutes: refs.surgeTunExcludedRoutes.value.split(",").map((item) => item.trim()).filter(Boolean),
    encryptedDnsServer: refs.surgeEncryptedDnsServer.value.split(",").map((item) => item.trim()).filter(Boolean),
    wifiAssist: refs.surgeWifiAssist.checked,
    excludeSimpleHostnames: refs.surgeExcludeSimpleHostnames.checked,
    encryptedDnsFollowOutboundMode: refs.surgeEncryptedDnsFollowOutboundMode.checked,
    ponteDeviceNames: normalizePonteDeviceNames(refs.surgePonteDeviceNames.value),
    hosts: isModeTogglePressed(refs.surgeHostAdvancedMode)
      ? textToLines(refs.surgeHosts.value)
      : buildSurgeHostLines(readSurgeHostRows()),
    urlRewrite: isModeTogglePressed(refs.surgeUrlRewriteAdvancedMode)
      ? textToLines(refs.surgeUrlRewrite.value)
      : buildSurgeUrlRewriteLines(readSurgeUrlRewriteRows()),
    scripts: textToLines(refs.surgeScripts.value),
    mitm: {
      ...state.surge.mitm,
      skipServerCertVerify: refs.surgeMitmSkipServerCertVerify.checked,
      h2: refs.surgeMitmH2.checked,
      hostname: textToLines(refs.surgeMitmHostname.value),
      caPassphrase: refs.surgeMitmCaPassphrase.value.trim(),
      caP12: refs.surgeMitmCaP12.value.trim()
    },
    rules: isModeTogglePressed(refs.surgeRuleAdvancedMode)
      ? textToLines(refs.surgeRules.value)
      : buildSurgeRuleLines(readSurgeRuleRows())
  };
}

function readClashDraft() {
  return {
    ...state.clash,
    port: Number(refs.clashPort.value) || 7890,
    socksPort: Number(refs.clashSocksPort.value) || 7891,
    mixedPort: Number(refs.clashMixedPort.value) || 7892,
    allowLan: refs.clashAllowLan.checked,
    mode: DEFAULT_CLASH_MODE,
    logLevel: DEFAULT_CLASH_LOG_LEVEL,
    ipv6: refs.clashIpv6.checked,
    unifiedDelay: refs.clashUnifiedDelay.checked,
    tcpConcurrent: refs.clashTcpConcurrent.checked,
    externalController: refs.clashExternalController.value.trim(),
    tun: {
      ...state.clash.tun,
      enable: refs.clashTunEnable.checked,
      stack: refs.clashTunStack.value.trim(),
      autoRoute: refs.clashTunAutoRoute.checked,
      autoDetectInterface: refs.clashTunAutoDetectInterface.checked,
      skipProxy: textToLines(refs.clashTunSkipProxy.value)
    },
    dnsEnabled: refs.clashDnsEnabled.checked,
    dnsListen: refs.clashDnsListen.value.trim(),
    dnsIpv6: refs.clashDnsIpv6.checked,
    dnsEnhancedMode: refs.clashDnsEnhancedMode.value,
    dnsFakeIpRange: refs.clashDnsFakeIpRange.value.trim(),
    defaultNameservers: textToLines(refs.clashDefaultNameservers.value),
    nameservers: textToLines(refs.clashNameservers.value),
    fallbackNameservers: textToLines(refs.clashFallbackNameservers.value),
    fallbackFilterGeoip: refs.clashFallbackFilterGeoip.checked,
    fallbackFilterIpcidr: textToLines(refs.clashFallbackFilterIpcidr.value),
    fakeIpFilter: textToLines(refs.clashFakeIpFilter.value),
    ruleProviders: refs.clashRuleProviders.value.trimEnd(),
    rules: currentClashRuleLines()
  };
}

function readGroupsDraft() {
  const groups = Object.fromEntries(groupEntries()
    .map(([name, spec]) => [name.trim(), normalizeGroupSpec(name.trim(), spec)])
    .filter(([name]) => name));
  const disabledGroups = (state.disabledGroups || [])
    .map((name) => String(name).trim())
    .filter((name, index, names) => name && name !== "Proxy" && Object.prototype.hasOwnProperty.call(groups, name) && names.indexOf(name) === index);
  return { groups, disabledGroups };
}

function pageDraft(page) {
  if (!state) return null;
  if (page === "settings") return readSettingsDraft();
  if (page === "groups") return readGroupsDraft();
  if (page === "sources") return { sources: cloneConfig(state.sources || []) };
  if (page === "surge") return { surge: readSurgeDraft() };
  if (page === "clash") return { clash: readClashDraft() };
  return null;
}

function pageBaseline(page) {
  if (!lastSavedState) return null;
  if (page === "settings") return { settings: lastSavedState.settings, chain: lastSavedState.chain };
  if (page === "groups") return { groups: lastSavedState.groups, disabledGroups: lastSavedState.disabledGroups };
  if (page === "sources") return { sources: lastSavedState.sources || [] };
  if (page === "surge") return { surge: lastSavedState.surge };
  if (page === "clash") return { clash: lastSavedState.clash };
  return null;
}

function hasUnsavedChanges(page) {
  const draft = pageDraft(page);
  const baseline = pageBaseline(page);
  return Boolean(draft && baseline && JSON.stringify(draft) !== JSON.stringify(baseline));
}

function cloneConfig(value) {
  return JSON.parse(JSON.stringify(value));
}

function collectGroups() {
  const draft = readGroupsDraft();
  state.groups = draft.groups;
  state.disabledGroups = draft.disabledGroups;
}

function collectSurge() {
  state.surge = readSurgeDraft();
}

function collectClash() {
  state.clash = readClashDraft();
}

function syncSurgeIpv6VifVisibility() {
  refs.surgeIpv6VifRow.classList.toggle("hidden", !refs.surgeIpv6.checked);
  refs.surgeIpv6Vif.disabled = !refs.surgeIpv6.checked;
}

function syncClashTunVisibility() {
  const enabled = refs.clashTunEnable.checked;
  document.querySelectorAll("[data-clash-tun-dependent]").forEach((row) => {
    row.classList.toggle("hidden", !enabled);
    row.querySelectorAll("input, select, textarea").forEach((control) => {
      control.disabled = !enabled;
    });
  });
  refreshConfigCodeEditors();
}

function syncClashFakeIpVisibility() {
  const enabled = refs.clashDnsEnhancedMode.value === "fake-ip";
  document.querySelectorAll("[data-clash-fake-ip-dependent]").forEach((row) => {
    row.classList.toggle("hidden", !enabled);
    row.querySelectorAll("input, select, textarea").forEach((control) => {
      control.disabled = !enabled;
    });
  });
  refreshConfigCodeEditors();
}

function isTelegramChatBound() {
  return Boolean((state.settings.notificationTelegramChatId || "").trim());
}

function syncTelegramBindActionButton() {
  refs.telegramBindCodeBtn.textContent = isTelegramChatBound()
    ? t("telegramUnbind")
    : t("telegramBindCode");
}

function renderTelegramBindStatus() {
  const isBound = isTelegramChatBound();
  refs.telegramBindStatus.textContent = isBound
    ? t("telegramBindStatusBound")
    : t("telegramBindStatusUnbound");
  syncTelegramBindActionButton();
  if (isBound) {
    stopTelegramBindPolling();
  }
}

function renderTelegramBindCommand(command, expiresAt) {
  refs.telegramBindStatus.innerHTML = [
    `<span>${escapeHtml(t("telegramBindCommandSteps"))}</span>`,
    `<span>${escapeHtml(t("telegramBindCommandHelp"))}</span>`,
    `<code>${escapeHtml(command)}</code>`,
    `<small>${escapeHtml(formatMessage("telegramBindCommandExpires", { time: formatTimestamp(expiresAt) }))}</small>`
  ].join("");
}

function syncTelegramSettingsFromConfig(config) {
  const savedSettings = config?.settings || {};
  const notificationTelegramBotToken = typeof savedSettings.notificationTelegramBotToken === "string"
    ? savedSettings.notificationTelegramBotToken
    : state.settings.notificationTelegramBotToken || "";
  const notificationTelegramWebhookSecret = typeof savedSettings.notificationTelegramWebhookSecret === "string"
    ? savedSettings.notificationTelegramWebhookSecret
    : state.settings.notificationTelegramWebhookSecret || "";
  const notificationTelegramChatId = typeof savedSettings.notificationTelegramChatId === "string"
    ? savedSettings.notificationTelegramChatId
    : "";
  const syncedTelegramSettings = {
    notificationChannel: notificationTelegramBotToken ? "telegram" : "off",
    notificationTelegramBotToken,
    notificationTelegramWebhookSecret,
    notificationTelegramChatId
  };
  state.settings = { ...state.settings, ...syncedTelegramSettings };
  if (lastSavedState) {
    lastSavedState.settings = { ...lastSavedState.settings, ...syncedTelegramSettings };
  }
  return Boolean(syncedTelegramSettings.notificationTelegramChatId.trim());
}

function stopTelegramBindPolling() {
  if (!telegramBindPollTimer) return;
  window.clearTimeout(telegramBindPollTimer);
  telegramBindPollTimer = 0;
}

function startTelegramBindPolling(expiresAt) {
  stopTelegramBindPolling();
  const deadline = Date.parse(expiresAt);
  if (!Number.isFinite(deadline)) return;
  const poll = async () => {
    telegramBindPollTimer = 0;
    if (Date.now() >= deadline) return;
    try {
      const latestConfig = await request("/api/config");
      if (syncTelegramSettingsFromConfig(latestConfig)) {
        renderTelegramBindStatus();
        updateSaveAvailability();
        return;
      }
    } catch {
      // Keep the bind command visible; the bot confirmation is the source of truth.
    }
    if (Date.now() < deadline) {
      telegramBindPollTimer = window.setTimeout(poll, 3000);
    }
  };
  telegramBindPollTimer = window.setTimeout(poll, 3000);
}

async function generateTelegramBindCode() {
  const token = refs.notificationTelegramBotToken.value.trim();
  if (!token) {
    window.alert(t("telegramBindMissingToken"));
    return;
  }
  refs.telegramBindCodeBtn.disabled = true;
  refs.telegramBindCodeBtn.textContent = t("telegramBindCodeLoading");
  try {
    const result = await request("/api/telegram/bind-code", {
      method: "POST",
      body: JSON.stringify({ token })
    });
    const savedSettings = result.config?.settings || {};
    const syncedTelegramSettings = {
      notificationChannel: "telegram",
      notificationTelegramBotToken: savedSettings.notificationTelegramBotToken || token,
      notificationTelegramWebhookSecret: savedSettings.notificationTelegramWebhookSecret || "",
      notificationTelegramChatId: savedSettings.notificationTelegramChatId || state.settings.notificationTelegramChatId || ""
    };
    state.settings = { ...state.settings, ...syncedTelegramSettings };
    if (lastSavedState) {
      lastSavedState.settings = { ...lastSavedState.settings, ...syncedTelegramSettings };
    }
    refs.notificationTelegramBotToken.value = syncedTelegramSettings.notificationTelegramBotToken;
    renderTelegramBindStatus();
    if (syncedTelegramSettings.notificationTelegramChatId.trim()) {
      updateSaveAvailability();
      return;
    }
    renderTelegramBindCommand(String(result.command || ""), result.expiresAt);
    startTelegramBindPolling(result.expiresAt);
    updateSaveAvailability();
  } catch (error) {
    window.alert(`${t("telegramBindFailed")}${error instanceof Error ? error.message : String(error)}`);
  } finally {
    refs.telegramBindCodeBtn.disabled = false;
    syncTelegramBindActionButton();
  }
}

async function unbindTelegramChat() {
  if (!window.confirm(t("telegramUnbindConfirm"))) return;
  stopTelegramBindPolling();
  refs.telegramBindCodeBtn.disabled = true;
  try {
    const savedConfig = await request("/api/telegram/unbind", { method: "POST" });
    syncTelegramSettingsFromConfig(savedConfig);
    renderTelegramBindStatus();
    updateSaveAvailability();
  } catch (error) {
    window.alert(`${t("telegramUnbindFailed")}${error instanceof Error ? error.message : String(error)}`);
  } finally {
    refs.telegramBindCodeBtn.disabled = false;
    syncTelegramBindActionButton();
  }
}

function handleTelegramBindAction() {
  if (isTelegramChatBound()) {
    void unbindTelegramChat();
    return;
  }
  void generateTelegramBindCode();
}

function renderGeoIpMmdbStatus(type = "") {
  const uploaded = Boolean(geoIpMmdbStatus?.uploaded);
  refs.geoIpMmdbMissingNotice.classList.toggle("hidden", uploaded);
  const message = uploaded
    ? formatMessage("geoIpMmdbStatusReady", {
      fileName: geoIpMmdbStatus.fileName || "GeoIP.mmdb",
      size: formatBytes(geoIpMmdbStatus.size || 0),
      time: formatTimestamp(geoIpMmdbStatus.updatedAt)
    })
    : t("geoIpMmdbStatusEmpty");
  const className = type || (uploaded ? "success" : "warning");
  refs.geoIpMmdbStatus.innerHTML = `<div class="${className}">${escapeHtml(message)}</div>`;
}

async function requestGeoIpMmdbUpload(file) {
  const body = new FormData();
  body.append("file", file);
  const response = await fetch("/api/geoip/mmdb", {
    method: "POST",
    body
  });
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.error || `HTTP ${response.status}`);
  }
  return response.json();
}

async function uploadGeoIpMmdb() {
  const file = refs.geoIpMmdbFile.files?.[0];
  if (!file) {
    window.alert(t("geoIpMmdbSelectFile"));
    return;
  }
  refs.uploadGeoIpMmdbBtn.disabled = true;
  refs.uploadGeoIpMmdbBtn.textContent = t("uploadGeoIpMmdbUploading");
  try {
    geoIpMmdbStatus = await requestGeoIpMmdbUpload(file);
    refs.geoIpMmdbFile.value = "";
    renderGeoIpMmdbStatus("success");
  } catch (error) {
    window.alert(`${t("geoIpMmdbUploadFailed")}${error instanceof Error ? error.message : String(error)}`);
  } finally {
    refs.uploadGeoIpMmdbBtn.disabled = false;
    refs.uploadGeoIpMmdbBtn.textContent = t("uploadGeoIpMmdb");
  }
}

function validateSurgeScriptLines(lines) {
  const validation = { errors: [], warnings: [] };
  (lines || []).forEach((line, index) => {
    const trimmed = String(line || "").trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    if (/^\[[^\]]+\]$/.test(trimmed)) {
      validation.errors.push(`第 ${index + 1} 行不能包含配置段标题`);
      return;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0 || !trimmed.slice(separatorIndex + 1).trim()) {
      validation.errors.push(`第 ${index + 1} 行脚本语法应为 名称 = 参数`);
    }
  });
  return validation;
}

function renderSurgeScriptValidation(validation) {
  const messages = [
    ...(validation?.errors || []).map((message) => ({ type: "error", message })),
    ...(validation?.warnings || []).map((message) => ({ type: "warning", message }))
  ];
  refs.surgeScriptValidation.classList.toggle("hidden", messages.length === 0);
  refs.surgeScriptValidation.innerHTML = messages
    .map(({ type, message }) => `<div class="${type}">${escapeHtml(message)}</div>`)
    .join("");
}

function validateCurrentSurgeScripts() {
  const validation = validateSurgeScriptLines(textToLines(refs.surgeScripts.value));
  renderSurgeScriptValidation(validation);
  return validation;
}

function randomBase64Url(bytes = 24) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function generateSurgeMitmCaPassphrase() {
  refs.surgeMitmCaPassphrase.value = randomBase64Url(24);
  updateSaveAvailability();
}

function renderSurgeMitmCaGenerationStatus(type, message) {
  refs.surgeMitmCaGenerationStatus.classList.remove("hidden");
  refs.surgeMitmCaGenerationStatus.innerHTML = `<div class="${type}">${escapeHtml(message)}</div>`;
}

function base64ToBytes(base64) {
  const clean = String(base64 || "").replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function downloadBase64File(base64, fileName, contentType) {
  const blob = new Blob([base64ToBytes(base64)], { type: contentType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function generateSurgeMitmCa() {
  if (!refs.surgeMitmCaPassphrase.value.trim()) {
    generateSurgeMitmCaPassphrase();
  }
  refs.generateSurgeMitmCaBtn.disabled = true;
  renderSurgeMitmCaGenerationStatus("warning", t("surgeMitmCaGenerating"));
  try {
    const { generateMitmCaP12 } = await import("/mitm-ca.js");
    const result = await generateMitmCaP12({
      commonName: "SubPilot MITM CA",
      passphrase: refs.surgeMitmCaPassphrase.value.trim()
    });
    refs.surgeMitmCaP12.value = result.caP12;
    syncConfigCodeEditor(refs.surgeMitmCaP12);
    downloadBase64File(result.caP12, result.fileName || "SubPilot-MITM-CA.p12", "application/x-pkcs12");
    renderSurgeMitmCaGenerationStatus("success", t("surgeMitmCaGenerated"));
    updateSaveAvailability();
  } catch (error) {
    renderSurgeMitmCaGenerationStatus("error", `${t("surgeMitmCaFailed")}${error instanceof Error ? error.message : String(error)}`);
  } finally {
    refs.generateSurgeMitmCaBtn.disabled = false;
  }
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.split(",").pop() || "" : result);
    });
    reader.addEventListener("error", () => reject(reader.error || new Error("File read failed")));
    reader.readAsDataURL(file);
  });
}

async function importSurgeMitmCaP12() {
  const file = refs.surgeMitmCaP12File.files?.[0];
  if (!file) return;
  refs.surgeMitmCaP12.value = await readFileAsBase64(file);
  syncConfigCodeEditor(refs.surgeMitmCaP12);
  refs.surgeMitmCaP12File.value = "";
  updateSaveAvailability();
}

async function save() {
  await saveActivePage();
}

async function saveSources() {
  await saveActivePage("sources");
}

async function saveActivePage(page = activePage) {
  if (!hasUnsavedChanges(page)) {
    setSaveStatus("idle");
    return;
  }
  setSaveStatus("saving");
  try {
    let patch = null;
    if (page === "settings") {
      collectSettings();
      patch = { settings: state.settings, chain: state.chain };
    } else if (page === "groups") {
      collectGroups();
      patch = { groups: state.groups, disabledGroups: state.disabledGroups };
    } else if (page === "sources") {
      patch = { sources: state.sources };
    } else if (page === "surge") {
      const hostValidation = validateCurrentSurgeHosts();
      if (hostValidation.errors.length > 0) {
        setSaveStatus("idle");
        window.alert(t("surgeHostValidationError"));
        return;
      }
      const urlRewriteValidation = validateCurrentSurgeUrlRewrite();
      if (urlRewriteValidation.errors.length > 0) {
        setSaveStatus("idle");
        window.alert(t("surgeUrlRewriteValidationError"));
        return;
      }
      const scriptValidation = validateCurrentSurgeScripts();
      if (scriptValidation.errors.length > 0) {
        setSaveStatus("idle");
        window.alert(t("surgeScriptValidationError"));
        return;
      }
      const validation = validateCurrentSurgeRules();
      if (validation.errors.length > 0) {
        setSaveStatus("idle");
        window.alert(t("surgeRuleValidationError"));
        return;
      }
      const surgeDraft = readSurgeDraft();
      state.surge = surgeDraft;
      patch = { surge: state.surge };
    } else if (page === "clash") {
      const ruleProviderValidation = validateCurrentClashRuleProviders();
      if (ruleProviderValidation.errors.length > 0) {
        setSaveStatus("idle");
        window.alert(t("clashRuleProviderValidationError"));
        return;
      }
      const ruleValidation = validateCurrentClashRules();
      if (ruleValidation.errors.length > 0) {
        setSaveStatus("idle");
        window.alert(t("clashRuleValidationError"));
        return;
      }
      collectClash();
      patch = { clash: state.clash };
    }
    if (patch) {
      state = await request("/api/config", { method: "PATCH", body: JSON.stringify(patch) });
      lastSavedState = cloneConfig(state);
    }
    if (saveStatusResetTimer) window.clearTimeout(saveStatusResetTimer);
    setSaveStatus("saved");
    saveStatusResetTimer = window.setTimeout(() => { setSaveStatus("idle"); }, 1600);
    render();
  } catch (error) {
    if (saveStatusResetTimer) window.clearTimeout(saveStatusResetTimer);
    setSaveStatus("idle");
    window.alert(`${t("saveFailed")}${error instanceof Error ? error.message : String(error)}`);
  }
}

async function rotateToken() {
  const result = await request("/api/read-token/rotate", { method: "POST", body: "{}" });
  currentReadToken = result.token;
  renderLinks();
}

function renderLinks() {
  const token = currentReadToken || "<rotate-read-token>";
  const base = new URL(state?.settings?.managedBaseUrl || `${location.origin}/sync`, location.origin);
  const url = subscriptionUrl(base, token);
  refs.links.innerHTML = renderLinkRow(t("automaticLink"), url);
  renderSummary();
}

function renderLinkRow(label, url) {
  return `<div class="link-row"><strong>${escapeHtml(label)}</strong><div class="link-copy-field"><code>${escapeHtml(url)}</code><button class="btn copy-link-btn" type="button" data-copy-link="${escapeHtml(url)}">${t("copyLink")}</button></div></div>`;
}

function subscriptionUrl(base, token) {
  const normalizedBase = new URL(base.toString());
  normalizedBase.search = "";
  normalizedBase.hash = "";
  const baseHref = normalizedBase.toString().replace(/\/+$/, "");
  const encodedToken = encodeURIComponent(token);
  return `${baseHref}/${encodedToken}/`;
}

async function copyLink(event) {
  const button = event.target instanceof Element ? event.target.closest("[data-copy-link]") : null;
  if (!button) return;
  const value = button.dataset.copyLink || "";
  try {
    await navigator.clipboard.writeText(value);
    button.textContent = t("copied");
    window.setTimeout(() => {
      button.textContent = t("copyLink");
    }, 1400);
  } catch {
    button.textContent = t("copyFailed");
    window.setTimeout(() => {
      button.textContent = t("copyLink");
    }, 1800);
  }
}

function renderSummary() {
  if (!state) return;
  const enabledSources = state.sources.filter((source) => source.enabled).length;
  refs.summarySources.textContent = `${enabledSources} / ${state.sources.length}`;
  refs.summaryGroups.textContent = `${Object.keys(state.groups || {}).length - (state.disabledGroups || []).length} / ${Object.keys(state.groups || {}).length}`;
  refs.summarySourceCache.innerHTML = formatSourceCacheStatus(fetchStats?.sourceCache);
  refs.refreshSourceCacheBtn.disabled = false;
}

function formatSourceCacheStatus(sourceCache) {
  if (!sourceCache || typeof sourceCache !== "object") return `<div>${escapeHtml(t("sourceCacheUnknown"))}</div>`;
  const count = Number(sourceCache.count) || 0;
  const expected = Math.max(0, Number(sourceCache.expectedCount) || 0);
  const cached = Math.max(0, Number(sourceCache.cachedSourceCount) || 0);
  if (expected <= 0) {
    return [
      `<div>${escapeHtml(count > 0 ? t("sourceCacheEntryCount").replace("{count}", String(count)) : t("sourceCacheEmpty"))}</div>`,
      `<div class="status-cache-muted">${escapeHtml(t("sourceCacheUpdatedLabel").replace("{time}", formatTimestamp(sourceCache.updatedAt)))}</div>`
    ].join("");
  }
  const missing = Math.max(0, expected - cached);
  const coverageState = missing > 0
    ? t("sourceCacheCoverageMissing").replace("{count}", String(missing))
    : t("sourceCacheCoverageReady");
  const sourceRows = Array.isArray(sourceCache.sources)
    ? sourceCache.sources.map(formatSourceCacheSourceRow).join("")
    : "";
  return [
    `<div><strong>${escapeHtml(t("sourceCacheCoverage").replace("{cached}", String(cached)).replace("{expected}", String(expected)))}</strong><span class="status-cache-pill ${missing > 0 ? "warning" : "ready"}">${escapeHtml(coverageState)}</span></div>`,
    `<div class="status-cache-muted">${escapeHtml(t("sourceCacheEntryCount").replace("{count}", String(count)))}</div>`,
    `<div class="status-cache-muted">${escapeHtml(t("sourceCacheUpdatedLabel").replace("{time}", formatTimestamp(sourceCache.updatedAt)))}</div>`,
    `<div>${escapeHtml(t("sourceCacheProtocols").replace("{value}", formatSourceCacheProtocols(sourceCache)))}</div>`,
    sourceRows ? `<div class="status-cache-sources">${sourceRows}</div>` : ""
  ].join("");
}

function formatSourceCacheProtocols(sourceCache) {
  const totalNodes = Number(sourceCache.totalNodes) || 0;
  const protocolCounts = Array.isArray(sourceCache.protocolCounts) ? sourceCache.protocolCounts : [];
  if (totalNodes <= 0 || protocolCounts.length === 0) return t("sourceCacheNoNodes");
  return protocolCounts
    .map((item) => `${item.protocol || "unknown"} ${Number(item.count) || 0}`)
    .concat(`总计 ${totalNodes}`)
    .join("，");
}

function formatSourceCacheSourceRow(source) {
  const name = source?.sourceName || source?.sourceId || "-";
  const text = source?.cached
    ? t("sourceCacheSourceCached")
      .replace("{name}", name)
      .replace("{count}", String(Number(source.nodeCount) || 0))
    : t("sourceCacheSourceMissing").replace("{name}", name);
  return `<div class="status-cache-source ${source?.cached ? "ready" : "warning"}">${escapeHtml(text)}</div>`;
}

async function refreshSourceCache() {
  refs.refreshSourceCacheBtn.disabled = true;
  refs.refreshSourceCacheBtn.textContent = t("refreshingSourceCache");
  try {
    const result = await request("/api/cache/source/refresh", { method: "POST", body: "{}" });
    const refreshVersion = ++statusStatsRefreshVersion;
    const stats = await request("/api/stats");
    if (refreshVersion === statusStatsRefreshVersion) {
      fetchStats = stats;
      renderPage("status", { force: true });
    }
    showSourceRefreshWarnings(result);
  } finally {
    refs.refreshSourceCacheBtn.textContent = t("refreshSourceCache");
    refs.refreshSourceCacheBtn.disabled = false;
  }
}

function refreshStatusStatsIfVisible() {
  if (!state || activePage !== "status") return;
  if (statusStatsRefreshPromise) return;
  const refreshVersion = ++statusStatsRefreshVersion;
  statusStatsRefreshPromise = request("/api/stats")
    .then((stats) => {
      if (refreshVersion !== statusStatsRefreshVersion) return;
      fetchStats = stats;
      if (activePage === "status") {
        renderPage("status", { force: true });
      }
    })
    .catch((error) => {
      console.warn("Status stats refresh failed", error);
    })
    .finally(() => {
      statusStatsRefreshPromise = null;
    });
}

function showSourceRefreshWarnings(result) {
  const failed = Number(result?.failed) || 0;
  if (failed <= 0) return;
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const notificationWarnings = Array.isArray(result.notification?.warnings) ? result.notification.warnings : [];
  let message = t("sourceCacheRefreshFailed")
    .replace("{count}", String(failed))
    .replace("{warnings}", warnings.join("\n") || "- Unknown error");
  if (notificationWarnings.length > 0) {
    message += t("sourceCacheNotificationWarnings").replace("{warnings}", notificationWarnings.join("\n"));
  }
  window.alert(message);
}

function renderFetchStats() {
  const lastFetched = fetchStats?.lastFetched || {};
  const targets = ["surge", "clash"];
  const records = Array.isArray(fetchStats?.recentUserAgents) ? fetchStats.recentUserAgents : [];
  const rows = records.map((record) => ({
    ...record,
    fetchedAt: record.fetchedAt || lastFetched[record.target]
  }));
  for (const target of targets) {
    if (rows.some((record) => record.target === target)) continue;
    rows.push({
      target,
      fetchedAt: lastFetched[target],
      userAgent: "",
      ipAddress: "",
      location: null
    });
  }
  const totalRows = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / FETCH_RECORDS_PAGE_SIZE));
  fetchRecordsPage = Math.min(Math.max(1, fetchRecordsPage), totalPages);
  const startIndex = totalRows > 0 ? (fetchRecordsPage - 1) * FETCH_RECORDS_PAGE_SIZE : 0;
  const pageRows = rows.slice(startIndex, startIndex + FETCH_RECORDS_PAGE_SIZE);
  const endIndex = startIndex + pageRows.length;
  refs.fetchRecordsTableBody.innerHTML = rows.length > 0
    ? pageRows.map(renderFetchRecordRow).join("")
    : `<tr><td class="status-empty-cell" colspan="4">${escapeHtml(t("noRecentUa"))}</td></tr>`;
  renderFetchRecordsPagination(totalRows, startIndex, endIndex, totalPages);
}

function renderFetchRecordRow(record) {
  const hasClient = Boolean(record.userAgent || record.ipAddress || record.location);
  const ipAddress = record.ipAddress || (hasClient ? t("unknownIp") : "");
  const location = hasClient ? formatLocation(record.location) : "";
  const network = [ipAddress, location].filter(Boolean).join(" · ");
  return `
    <tr>
      <td data-label="${escapeHtml(t("fetchColumnTarget"))}">${escapeHtml(formatFetchTargetLabel(record.target))}</td>
      <td data-label="${escapeHtml(t("fetchColumnTime"))}"><time>${escapeHtml(formatTimestamp(record.fetchedAt))}</time></td>
      <td class="status-fetch-ua" data-label="${escapeHtml(t("fetchColumnUa"))}">${escapeHtml(record.userAgent || t("emptyCell"))}</td>
      <td class="status-fetch-network" data-label="${escapeHtml(t("fetchColumnNetwork"))}">${escapeHtml(network || t("emptyCell"))}</td>
    </tr>
  `;
}

function renderFetchRecordsPagination(totalRows, startIndex, endIndex, totalPages) {
  if (!refs.fetchRecordsPagination) return;
  const showPagination = totalRows > FETCH_RECORDS_PAGE_SIZE;
  refs.fetchRecordsPagination.classList.toggle("hidden", !showPagination);
  refs.fetchRecordsPageInfo.textContent = formatMessage("fetchRecordsPageInfo", {
    start: totalRows > 0 ? startIndex + 1 : 0,
    end: endIndex,
    total: totalRows
  });
  refs.fetchRecordsPrevBtn.disabled = fetchRecordsPage <= 1;
  refs.fetchRecordsNextBtn.disabled = fetchRecordsPage >= totalPages;
}

function setFetchRecordsPage(page) {
  fetchRecordsPage = Math.max(1, Number(page) || 1);
  renderFetchStats();
}

function formatFetchTargetLabel(target) {
  const key = {
    surge: "fetchTargetSurge",
    clash: "fetchTargetClash"
  }[target];
  return key ? t(key) : String(target || "-");
}

function formatLocation(location) {
  if (!location || typeof location !== "object") return t("unknownLocation");
  const label = String(location.label || "").trim();
  if (label) return label;
  const parts = [location.city, location.region, location.countryCode]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const text = parts.join(", ");
  return text || t("unknownLocation");
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function formatTimestamp(value) {
  if (!value) return t("neverFetched");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t("neverFetched");
  return date.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

async function preview(target, options = {}) {
  previewLoadingTarget = target;
  updatePreviewControls();
  refs.previewOutput.textContent = formatMessage("previewLoading", { target: PREVIEW_TARGET_LABELS[target] || target });
  refs.previewOutput.dataset.empty = "true";
  refs.surgeOnlineValidation.classList.add("hidden");
  refs.surgeOnlineValidation.innerHTML = "";
  try {
    const result = await request(`/api/preview?target=${target}`, { method: "POST", body: "{}" });
    currentPreviewTarget = target;
    currentPreviewContent = result.content || "";
    refs.previewOutput.textContent = currentPreviewContent;
    refs.previewOutput.dataset.empty = currentPreviewContent ? "false" : "true";
    return currentPreviewContent;
  } catch (error) {
    currentPreviewTarget = "";
    currentPreviewContent = "";
    refs.previewOutput.textContent = `${t("previewFailed")}${error instanceof Error ? error.message : String(error)}`;
    refs.previewOutput.dataset.empty = "true";
    if (options.propagateError) throw error;
    return "";
  } finally {
    previewLoadingTarget = "";
    updatePreviewControls();
  }
}

function updatePreviewControls() {
  const loading = Boolean(previewLoadingTarget);
  for (const target of PREVIEW_TARGETS) {
    const button = target === "surge"
      ? refs.previewSurgeBtn
      : refs.previewClashBtn;
    button.disabled = loading;
    button.textContent = PREVIEW_TARGET_LABELS[target];
  }
  refs.validateSurgeOnlineBtn.disabled = loading || surgeValidationRunning;
}

function renderSurgeOnlineValidation(type, message) {
  refs.surgeOnlineValidation.classList.remove("hidden");
  refs.surgeOnlineValidation.innerHTML = `<div class="${type}">${escapeHtml(message)}</div>`;
}

async function validateSurgeOnline() {
  if (!window.confirm(t("validateSurgeOnlineRisk"))) return;
  surgeValidationRunning = true;
  updatePreviewControls();
  renderSurgeOnlineValidation("warning", t("validateSurgeOnlineRunning"));
  try {
    if (currentPreviewTarget !== "surge" || !currentPreviewContent) {
      await preview("surge", { propagateError: true });
      renderSurgeOnlineValidation("warning", t("validateSurgeOnlineRunning"));
    }
    const result = await request("/api/surge/validate-online", {
      method: "POST",
      body: JSON.stringify({ content: currentPreviewContent, acknowledgeRisk: true })
    });
    if (result.valid) {
      renderSurgeOnlineValidation("success", t("validateSurgeOnlinePassed"));
    } else {
      renderSurgeOnlineValidation("error", `${t("validateSurgeOnlineFailed")}${result.error || "Unknown error"}`);
    }
  } catch (error) {
    renderSurgeOnlineValidation("error", `${t("validateSurgeOnlineFailed")}${error instanceof Error ? error.message : String(error)}`);
  } finally {
    surgeValidationRunning = false;
    updatePreviewControls();
  }
}

function linesToText(lines) {
  return (lines || []).join("\n");
}

function textToLines(value) {
  return String(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function inputWithTitle(attrs, value) {
  const escaped = escapeHtml(value || "");
  return `<input ${attrs} title="${escaped}" value="${escaped}">`;
}

function syncInputTitle(event) {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.type !== "checkbox") {
    target.title = target.value;
  }
}

refs.loginBtn.addEventListener("click", login);
refs.saveBtn.addEventListener("click", save);
refs.saveSourcesBtn?.addEventListener("click", saveSources);
refs.addGroupBtn.addEventListener("click", addGroup);
refs.addSourceBtn.addEventListener("click", addSource);
refs.rotateTokenBtn.addEventListener("click", rotateToken);
refs.refreshSourceCacheBtn.addEventListener("click", refreshSourceCache);
refs.fetchRecordsPrevBtn.addEventListener("click", () => setFetchRecordsPage(fetchRecordsPage - 1));
refs.fetchRecordsNextBtn.addEventListener("click", () => setFetchRecordsPage(fetchRecordsPage + 1));
refs.links.addEventListener("click", copyLink);
refs.previewSurgeBtn.addEventListener("click", () => preview("surge"));
refs.previewClashBtn.addEventListener("click", () => preview("clash"));
refs.validateSurgeOnlineBtn.addEventListener("click", validateSurgeOnline);
refs.uploadGeoIpMmdbBtn.addEventListener("click", uploadGeoIpMmdb);
refs.notificationTelegramBotToken.addEventListener("input", () => {
  stopTelegramBindPolling();
  renderTelegramBindStatus();
});
refs.telegramBindCodeBtn.addEventListener("click", handleTelegramBindAction);
refs.surgeIpv6.addEventListener("change", syncSurgeIpv6VifVisibility);
refs.clashTunEnable.addEventListener("change", syncClashTunVisibility);
refs.clashDnsEnhancedMode.addEventListener("change", syncClashFakeIpVisibility);
refs.surgeHostAdvancedMode.addEventListener("click", toggleSurgeHostAdvancedMode);
refs.addSurgeHostBtn.addEventListener("click", addSurgeHost);
refs.surgeHostRows.addEventListener("click", handleSurgeHostListClick);
refs.surgeHostRows.addEventListener("input", updateSurgeHostOutput);
refs.surgeHosts.addEventListener("input", validateCurrentSurgeHosts);
refs.surgeUrlRewriteAdvancedMode.addEventListener("click", toggleSurgeUrlRewriteAdvancedMode);
refs.addSurgeUrlRewriteBtn.addEventListener("click", addSurgeUrlRewrite);
refs.surgeUrlRewriteRows.addEventListener("click", handleSurgeUrlRewriteListClick);
refs.surgeUrlRewriteRows.addEventListener("input", updateSurgeUrlRewriteOutput);
refs.surgeUrlRewriteRows.addEventListener("change", handleSurgeUrlRewriteListChange);
refs.surgeUrlRewrite.addEventListener("input", validateCurrentSurgeUrlRewrite);
refs.surgeRuleAdvancedMode.addEventListener("click", toggleSurgeRuleAdvancedMode);
refs.addSurgeRuleBtn.addEventListener("click", () => addSurgeRule("single"));
refs.addSurgeRuleSetBtn.addEventListener("click", () => addSurgeRule("rule-set"));
refs.surgeRuleRows.addEventListener("click", handleSurgeRuleListClick);
refs.surgeRuleRows.addEventListener("input", updateSurgeRuleOutput);
refs.surgeRuleRows.addEventListener("change", handleSurgeRuleListChange);
refs.surgeScripts.addEventListener("input", validateCurrentSurgeScripts);
refs.clashRuleProviderAdvancedMode.addEventListener("click", toggleClashRuleProviderAdvancedMode);
refs.addClashRuleProviderBtn.addEventListener("click", addClashRuleProvider);
refs.clashRuleProviderRows.addEventListener("click", handleClashRuleProviderListClick);
refs.clashRuleProviderRows.addEventListener("input", updateClashRuleProviderOutput);
refs.clashRuleProviderRows.addEventListener("change", handleClashRuleProviderListChange);
refs.clashRuleProviders.addEventListener("input", handleClashRuleProvidersInput);
refs.clashRuleAdvancedMode.addEventListener("click", toggleClashRuleAdvancedMode);
refs.addClashRuleBtn.addEventListener("click", () => addClashRule("single"));
refs.addClashRuleSetBtn.addEventListener("click", () => addClashRule("rule-set"));
refs.clashRuleRows.addEventListener("click", handleClashRuleListClick);
refs.clashRuleRows.addEventListener("input", updateClashRuleOutput);
refs.clashRuleRows.addEventListener("change", handleClashRuleListChange);
refs.clashRules.addEventListener("input", validateCurrentClashRules);
refs.generateSurgeMitmCaBtn.addEventListener("click", generateSurgeMitmCa);
refs.generateSurgeMitmCaPassphraseBtn.addEventListener("click", generateSurgeMitmCaPassphrase);
refs.surgeMitmCaP12File.addEventListener("change", importSurgeMitmCaP12);
refs.surgeRules.addEventListener("input", validateCurrentSurgeRules);
refs.surgePonteDeviceNames.addEventListener("input", syncSurgePonteDeviceNames);
document.addEventListener("input", () => queueMicrotask(updateSaveAvailability));
document.addEventListener("change", () => queueMicrotask(updateSaveAvailability));
document.addEventListener("click", () => queueMicrotask(updateSaveAvailability));
document.addEventListener("input", syncInputTitle);
document.querySelectorAll("[data-surge-tab]").forEach((button) => {
  button.addEventListener("click", () => showSurgeTab(button.dataset.surgeTab));
});
document.querySelectorAll("[data-clash-tab]").forEach((button) => {
  button.addEventListener("click", () => showClashTab(button.dataset.clashTab));
});
document.querySelectorAll(".luci-menu a").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    showPage(link.dataset.page, true);
  });
});
window.addEventListener("hashchange", () => {
  showPage(getPageFromHash());
});

applyLanguage();
showPage(activePage);
boot();
