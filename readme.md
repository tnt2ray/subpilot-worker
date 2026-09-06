# SubPilot Worker

语言：中文 | [English](./README.en.md)

SubPilot Worker 是运行在 Cloudflare Workers 上的订阅配置生成器，使用 Workers KV 保存加密配置。2.0 共享订阅源和代理节点，三端分别维护策略组和规则来源，为 **Surge、clash 和 sing-box** 分别生成配置。

[功能概览](#功能概览) · [部署](#部署) · [首次配置](#首次配置) · [订阅地址](#订阅地址) · [配置模型](#配置模型) · [更新与迁移](#更新与迁移) · [缓存与运行边界](#缓存与运行边界) · [Telegram 与 GeoIP](#telegram-与-geoip) · [安全与数据](#安全与数据) · [本地开发](#本地开发) · [许可证](#许可证)

## 功能概览

- 共享资源只维护一份，三端的网络、DNS、路由与高级设置独立保存。
- 按目标客户端适配输出；无法保留的节点或附加功能会报告原因，关键配置问题会阻止下载。
- 支持手动节点、链式出口、策略组筛选、原生规则及本端来源编排。
- 提供迁移问题处理、通用订阅地址、加密缓存、Telegram 通知和 GeoIP MMDB 上传。
- sing-box 适配基线为 **1.14.0**；旧配置可迁移到配置文档版本 3。Stash 和 Shadowrocket 已退出输出目标。

概览页的“最近订阅请求”按时间倒序显示，包含按系统显示时区格式化的请求日期和时间。默认每页 10 条，可翻页查看最近 50 条；刷新页面后返回第一页。概览页保留项目版本显示，不再提供“刷新数据”和“检查更新”按钮。

“订阅缓存”位于“最近订阅请求”之前，展示已缓存源数、节点总数、最近更新时间和各源的缓存状态及协议数量。点击“强制刷新”会重新拉取已保存并启用的订阅源；刷新期间防止重复提交，失败时显示原因和是否沿用旧缓存。

## 部署

### 准备环境

准备 Cloudflare 账号、Node.js 和 npm，使用 Git 克隆或下载发布包。使用全局 Wrangler；尚未安装时执行安装命令，然后登录：

```bash
npm install -g wrangler
wrangler login
```

### 使用初始化脚本

**以下 `npm run setup` 会创建或复用 Cloudflare 资源，并部署 Worker 和管理页。**

```bash
git clone https://github.com/tnt2ray/subpilot-worker.git
cd subpilot-worker
npm install --omit=dev
npm run setup
```

也可下载 [GitHub Releases](https://github.com/tnt2ray/subpilot-worker/releases) 中的 `subpilot-worker-vX.Y.Z.tar.gz`，解压并进入项目目录后运行最后两条命令。

全新安装时，脚本会：

1. 从 `wrangler.example.jsonc` 生成本地 `wrangler.jsonc`，创建或配置 `SUBPILOT_CONFIG` KV namespace。
2. 询问上游订阅刷新间隔，范围为 1～24 小时，默认 12 小时。
3. 要求输入至少 24 个字符的管理员 token，并生成配置加密密钥。
4. 将 token 的 SHA-256 hash 写入 `ADMIN_TOKEN_HASH`，与 `CONFIG_ENCRYPTION_KEY` 一起通过 `wrangler deploy --secrets-file` 部署；临时密钥文件会在命令结束后删除。

请把管理员 token 保存在密码管理器中。若已有本地 `wrangler.jsonc`，脚本会复用配置并默认跳过 Secrets 写入。**不要在推荐安装流程中先手动复制模板**；手动安装见下方独立步骤。

仅在明确要替换管理员 token 和加密密钥时使用 `npm run setup -- --force-secrets`。替换现有 `CONFIG_ENCRYPTION_KEY` 会使原密钥加密的数据无法解密。

<details>
<summary>自动化安装参数</summary>

可通过环境变量提供参数；需要写入 Secrets 的非交互安装必须提供管理员 token。

| 环境变量 | 用途 |
| --- | --- |
| `SUBPILOT_WORKER_NAME` | Worker 名称。 |
| `SUBPILOT_KV_NAMESPACE_ID` | 复用已有 KV namespace。 |
| `SUBPILOT_ADMIN_TOKEN` | 至少 24 个字符的管理员 token。 |
| `SUBPILOT_CONFIG_ENCRYPTION_KEY` | 指定加密密钥；未提供时自动生成。复用已有加密数据时必须与原密钥匹配。 |
| `SUBPILOT_SOURCE_REFRESH_HOURS` | 上游刷新间隔，1～24 小时，默认 12。 |
| `SUBPILOT_LOGIN_RATE_LIMIT_NAMESPACE_ID` | 可选的限流 namespace ID，取值 1～4294967295；默认从 Worker 名称稳定派生。 |

初始化会配置登录限流：同一 Cloudflare 位置内，每个客户端 IP 每分钟最多尝试 10 次。通过安全的环境变量管理方式提供凭据，避免写进命令历史或仓库。

</details>

<details>
<summary>手动部署</summary>

以下命令使用 Bash。先安装依赖并创建本地配置：

```bash
npm install --omit=dev
cp wrangler.example.jsonc wrangler.jsonc
wrangler kv namespace create SUBPILOT_CONFIG
```

在 `wrangler.jsonc` 中填写自己的 Worker 名称，将创建得到的 namespace ID 写入 `kv_namespaces[0].id`。再生成管理员 token 的 SHA-256 hash：

```bash
read -r -s -p 'Admin token: ' SUBPILOT_ADMIN_TOKEN
printf '\n'
printf '%s' "$SUBPILOT_ADMIN_TOKEN" | shasum -a 256 | awk '{print $1}'
unset SUBPILOT_ADMIN_TOKEN
```

管理员 token 至少应有 24 个字符。以下操作会写入 Worker Secrets 并部署：

```bash
wrangler secret put ADMIN_TOKEN_HASH
wrangler secret put CONFIG_ENCRYPTION_KEY
wrangler deploy
```

`ADMIN_TOKEN_HASH` 填上述 SHA-256 hex；`CONFIG_ENCRYPTION_KEY` 填足够长的随机字符串。更新现有部署时保留原加密密钥。

模板包含上游订阅与编译规则集两个定时任务，详见[缓存与运行边界](#缓存与运行边界)。自定义域名可在 Cloudflare 中连接到 Worker，或写入本地 `wrangler.jsonc` 的 `routes`。不要提交个人部署配置。

</details>

## 首次配置

打开部署地址，用管理员 token 登录。旧版本用户应先完成[配置迁移](#更新与迁移)。

1. 在“系统设置”确认订阅基础 URL（通常为 `https://<your-domain>/sync`）和显示时区。
2. 在“订阅源”添加上游地址、名称和抓取 User-Agent；在“代理节点”维护手动节点或链式出口。编辑节点时，仅启用“作为链式出口”后显示“前置节点筛选”；关闭后隐藏，保留已填写的筛选条件。每行一个关键词，节点名称或标签包含任一关键词即选中，不区分大小写、不支持正则。仅为命中的非出口节点生成链式节点，未命中节点不参与；留空不生成。链路为“本机 → 命中节点 → 当前出口节点 → 目标网站”。
3. 在“策略组”选择客户端，再设置该端的成员、筛选条件和参数。
4. 在“客户端配置”选择 Surge、clash 或 sing-box，编辑当前端的网络、DNS、路由与高级功能。
5. 使用本端来源编排时，在当前客户端路由页直接填写规则集来源地址（每行一个），并下拉选择策略组。新地址自动关联到该端规则来源；规则集和单条规则在同一列表中上下排序。来源名称、解析格式及启用状态在规则集编辑弹窗的“来源设置”中维护，不再提供独立的“规则来源”页面。
6. 检查配置并处理“迁移问题”中的待办项；保存后从“配置链接”复制通用订阅地址。

订阅源、代理节点和策略组均可点击名称或行内“编辑”按钮修改已有内容；弹窗中点击“应用更改”后，再点击页面底部“保存配置”持久保存。窄屏下操作列保持可见，其余详情可横向滚动。

页面标题与底部操作栏保持可见，长内容在中间区域独立滚动，避免被操作栏遮挡。

配置导出、备份下载和迁移草稿下载已移除；旧配置迁移仅需检查并确认，无需先下载备份。

草稿保存在当前页面内存中，切换页面或客户端可继续编辑；刷新或关闭页面会丢失未保存内容。订阅请求使用已保存配置，并在生成时执行兼容性校验。输出预览页面、相关按钮和预览 API 已移除。保存的是整个配置文档，三端字段分别维护。

## 订阅地址

以下示例使用默认基础路径 `/sync`；实际地址以管理页“配置链接”为准。

Surge、clash和 sing-box 全部使用同一个地址：

```text
https://<your-domain>/sync/<read_token>/
```

服务端根据 User-Agent 中的客户端标识选择输出，匹配不区分大小写：

| UA 标识 | 输出客户端 | 下载文件名 |
| --- | --- | --- |
| `Surge` | Surge | `SubPilot.conf` |
| `clash` | clash | `SubPilot.yaml` |
| `sing-box` 或 `singbox` | sing-box | `SubPilot.json` |

请将通用地址导入客户端。UA 缺失、无法识别或同时匹配多个目标时返回 HTTP 400；自定义 UA 时应保留对应客户端标识。订阅入口可省略末尾 `/`。

Surge 不区分 iOS/macOS、正式版/TF 或版本号，也不使用版本 Tag。订阅按保存的 Surge 设置输出，不按客户端版本裁剪功能，配置中的自动更新链接始终为通用地址。详见 [Surge 输出说明](./docs/surge-compatibility.md)。

客户端独立入口、带 Tag 的 Surge 地址、旧文件名入口及 Stash/Shadowrocket 输出不再提供。文件名只用于下载命名，不能作为订阅路径。订阅与规则文件地址不接受查询参数；配置存在阻断问题时返回 HTTP 422。

基础 URL 必须包含非根路径，不能占用 `/api`、`/vendor` 或管理页资源路径。修改基础 URL 或轮换读取 token 后，需要更新客户端保存的链接；只有当前基础路径有效。

## 配置模型

### 共享资源与独立设置

旧文档中的 `clients.mihomo` 会在读取时自动转换为 `clients.clash`，保存时使用新字段；继续兼容已有 `mihomo` User-Agent，无需手动迁移 KV。

订阅源、手动节点和链式节点继续共享；策略组、启用状态、规则来源及规则编排与网络、DNS、默认策略和高级设置一起分别保存在 `clients.surge`、`clients.clash`、`clients.singbox` 中。策略组位于各端的 `groups` / `disabledGroups`，规则来源位于各端的 `ruleSets.sources`，不再有共享 `groupTargets`。同名策略组和相同来源 ID 只在所属客户端内解析。

| 能力 | Surge | clash | sing-box 1.14.0 |
| --- | --- | --- | --- |
| 手工路由 | Surge 规则文本 | rules 与 rule-providers | 原生 JSON route |
| 编译规则文件 | `.list` | `.yaml` | JSON source `.json` |
| DNS 与网络 | Surge 独立设置 | clash DNS / TUN | 原生 DNS / inbounds |
| 通用策略组 | `select` / `smart`（由 `url-test` 转换） | `select` / `url-test` | `selector` / `urltest` |
| 其他策略组 | fallback、load-balance、subnet、smart | fallback、load-balance | 不自动替换组类型 |
| Rewrite / Map Local / MITM / 脚本 | 保留 | 不输出 | 不输出 |
| Tailscale | 独立表单配置 | 不输出 | 原生 endpoint，独立表单配置 |

在“客户端配置 → Surge → MITM 证书”中生成、导入或导出 CA 证书。生成时自动填入可修改的 CA 密码，在浏览器内完成生成并显示进度状态；完成后需保存配置，再更新客户端订阅。现有证书数据可展开查看或编辑，MITM 主机名等设置也在该分栏中。

### 节点与策略组

静态节点接受 Surge 语法、Clash YAML/JSON 或 sing-box 原生 JSON。Clash 使用 `name`、`port`，sing-box 使用 `tag`、`server_port`；原生 SSH 节点省略端口时使用 22。

sing-box 节点输入可为包含 `outbounds` 的 JSON、节点数组或单个节点对象，只读取其中的代理节点，不导入输入文件的 DNS、路由和策略组。原生字段会保留；跨格式转换无法保留认证、TLS 或传输语义时会跳过节点并报告原因。Snell 6 不会降级为 clash 的 Snell 5；sing-box 自动转换支持 Snell 4/6。

策略组支持 `{all}`、筛选条件和显式成员，可指定适用客户端。`Proxy` 必须保留并启用，但类型不限于 `select`，可使用对应客户端支持的策略组类型。改名、禁用或删除资源不会自动改写现有引用。sing-box 组可显式引用 `endpoints` 的标签，Tailscale 端点可在专用页管理，并保留成员顺序；包含这些成员的组应限定为 sing-box。

策略组页面提供“语法说明与示例”，随当前客户端显示可用类型和参数。组配置只填一行，格式为 `类型, 成员或筛选器, 参数=值`，使用英文逗号，名称单独填写，不加 `组名 =` 前缀。

- 显式成员填写已有节点或策略组的准确名称，或当前端支持的内置策略；不能自引用或循环引用。
- `{all}` 只展开可用于当前组的节点，不会选中其他策略组。`fallback` 需显式列出成员，`subnet` 使用条件映射；两者不能使用 `{all}`。
- `{all filter=香港,日本 exclude=via,DMIT}` 先保留命中“香港”或“日本”的节点，再排除命中“via”或“DMIT”的节点。按节点名称和匹配标签进行不区分大小写的包含匹配，不是正则表达式。
- `filter`、`exclude` 均可省略；多个关键字用英文逗号分隔，`filter` 写在前，与 `exclude` 之间用空格。`{all exclude=via,DMIT}` 表示排除命中任意一个关键字的节点。
- 被引用的组筛选后为空或成员不可用时，订阅可能返回 422；可在“配置链接 → 订阅检查”定位原因。

各端分别维护组配置。旧共享配置迁移时，Surge 的 `url-test` 转为 `smart`；Surge 输出仍兼容自动转换 `url-test`，clash 和 sing-box 使用自己的自动测速类型。转换后的组同样执行 smart 成员检查，引用内置策略或嵌套策略组会阻断 Surge 输出。Smart 使用自身测速周期，`interval` 不生效。

`hidden=true` 在 Surge 和 clash 中输出；clash 需要面板或客户端配合。sing-box 不输出 `hidden`，启用时显示适配提示。

Surge 不使用组级 `url`，请设置 Surge 的代理测速 URL。sing-box 的 `outbounds` 合并共享节点、当前端策略组和“原生出站”页中的本端节点。原生顶层设置均提供逐字段表单。

Surge 的脚本、URL 重写和本地映射等文本列表可通过区块右上角的“文本编辑”打开原生逐行编辑器。应用更改后保存配置。

Surge Ponte 支持已移除。旧配置中的 Ponte 设备列表在读取时忽略；已有 `DEVICE:` 策略引用不会自动删除或替换，需手动改为有效策略后才能生成对应订阅。无需修改 KV schema。

### sing-box 完整配置表单

适配基线保持 **sing-box 1.14.0**。界面与生成器共用该版本的[官方 JSON Schema](https://github.com/SagerNet/sing-box/blob/v1.14.0/docs/schema.json)，不会把旧版或已移除字段作为可选项提供。具体能力以此版本的[配置手册](https://sing-box.sagernet.org/configuration/)与实际客户端构建为准。

| 页面 | 可配置内容 |
| --- | --- |
| 网络与 TUN | 全部入站类型、TUN 地址/路由/应用过滤/平台选项、监听参数；Linux 网络命名空间 |
| DNS | 15 种服务器类型，包括 UDP/TCP/TLS/QUIC/HTTPS/HTTP3、Local/Hosts/DHCP/mDNS/FakeIP、Tailscale/OpenConnect/OpenVPN/Resolved；缓存、乐观缓存、查询超时、逻辑规则与全部 DNS 动作 |
| 路由规则 | 全部匹配字段、逻辑组合、route/route-options/direct/bypass/reject/hijack-dns/sniff/resolve 动作；本地/远程/内联规则集、域名解析器、HTTP 客户端、接口与邻居发现 |
| VPN 端点 | WireGuard、Tailscale、OpenConnect、OpenVPN Client / Server；对端、认证、路由、TLS 与连接选项 |
| 原生出站 | 全部 1.14 出站类型，含 Naive、Hysteria、ShadowTLS、Tor、SSH、Bridge、Snell 4/6、原生 selector/urltest；各协议的 TLS/ECH/Reality/uTLS、传输、多路复用与拨号字段 |
| 服务 | API、DERP、Resolved、SSM API、CCM、OCM、Hysteria Realm、USB/IP、OOM killer 等 Schema 支持的服务 |
| 高级设置 | 日志、NTP、证书信任与证书提供者、共享 HTTP 客户端、缓存文件、Clash API、V2Ray API 与调试 |
| 策略组 | 指定成员、共享节点筛选和排序；selector 默认成员；urltest 测速 URL/间隔/容差/空闲超时；切换时是否中断连接 |

每个分类通过“配置”打开表单；“添加字段”可选取尚未设置的字段，嵌套对象可展开，列表支持添加、删除和排序。字符串、数值、布尔值、枚举、单值/列表及对象变体各有对应控件；证书、私钥和请求头等不需要手写 JSON。移除可选字段恢复内核默认值，未修改的字段和列表顺序保留。切换类型或动作会保留兼容字段、移除不兼容字段；取消可放弃本次编辑。应用时执行服务端 Schema 校验，保存配置后生效。外部导入的未知字段仍保留并显示，需按诊断修正或移除。

原生出站与共享节点、生成策略组一起输出；它们及端点的标签不能重复，也不能占用内置 `DIRECT` 或已有组名。可在策略组和规则中引用这些标签。配置服务检查出站、DNS、入站、规则集、HTTP 客户端、证书提供者、网络命名空间引用，以及策略/拨号循环、selector 默认成员和 VPN DNS 关联端点类型。

**来源编排模式会先输出本端原生路由规则，再输出编排规则；原生规则集与生成规则集一起保留。** 因此，原生无条件规则会提前终止匹配；如需编排规则生效，请将原生前置规则限定到明确条件。编排中的 FINAL/MATCH 仍设置最终出站。`{all}` 继续筛选共享节点；本端原生出站和端点通过“指定节点或策略”加入组。无需 KV 数据结构迁移，也无需新增 Secrets。

平台差异仍需遵守官方限制：[Android](https://sing-box.sagernet.org/clients/android/features/) 使用 VpnService，应用过滤与进程/接口权限有区别；[Apple](https://sing-box.sagernet.org/clients/apple/features/) 使用 NetworkExtension，应用包匹配和部分进程匹配不可用；网络命名空间只在 Linux 可用，Apple HTTP 引擎只在 Apple 平台可用。客户端自己的 Always On、通知显示和应用选择覆盖等设置不能通过订阅 JSON 下发，需在客户端操作。Schema 校验不验证文件存在、系统权限、协议认证、全部字段间约束或实际连通性；导入后仍应在对应设备执行 `sing-box check` 并检查运行结果。

### Tailscale

Surge 与 sing-box 的客户端配置中均有与“路由规则”并列的 **Tailscale** 页。通过节点列表新增、编辑或删除；身份认证、路由出口、连接参数均使用表单，认证密钥以密码框显示。两端独立保存。

- Surge 保留配置段名称、DERP、空闲保活、DNS、MTU、前置代理和测速等全部现有设置。启用节点需要认证密钥。
- sing-box 使用 1.14 原生 `endpoints` 中的 `type: "tailscale"`，支持子网路由、出口发布、接口与中继、SSH、Taildrop 以及 DNS 和连接选项。可选开关可以选择“使用默认值”；未修改的可选字段保留原样。其他类型的 endpoint 不受此页影响。
- sing-box 密钥可留空，通过客户端日志中的登录地址授权；多个实例应使用各自的状态目录。配置服务只生成客户端配置，不会代替客户端登录 Tailscale。
- 节点名称可用于该端策略组和路由规则，sing-box 也可选为默认出站。改名或删除后需要手动调整已有引用。Surge 配置不会自动复制或转换到 sing-box。

参见 [sing-box Tailscale endpoint 文档](https://sing-box.sagernet.org/configuration/endpoint/tailscale/)。

### 路由与输出诊断

规则编排在手机上使用卡片排列，来源地址和操作按钮无需横向滚动。Surge 原生规则编辑器提供专用匹配类型及 `no-resolve`、`extended-matching`、`dns-failed` 选项。结构化编辑中 FINAL 固定在末尾，新规则插入其前；文本编辑保留原生内容，并在应用时检查 FINAL 唯一且置底。

Surge 原生 FINAL 行直接显示已有附加选项，点击编辑可设置 `dns-failed`。编排规则同时支持 `FINAL,dns-failed`（策略单独选择）和 `FINAL,Proxy,dns-failed`，也接受 `MATCH` 别名；显示、编辑、保存和生成 Surge 订阅均保留该选项。该参数不适用于 clash 或 sing-box，不会在跨端输出时静默丢弃。参见 [Surge FINAL 官方手册](https://manual.nssurge.com/rules/final.html)。

Clash 的“分流配置”页面只需录入规则集地址并选择出口策略，也可添加单条规则。规则集名称自动生成，来源默认自动识别；来源格式、名称、启用状态、`no-resolve` 和内联内容放在折叠设置中。策略组本身仍在“策略组”页面维护。

- 三端配置独立。Clash 来源仅接受 Clash YAML 的 `payload` 数组及 domain、ipcidr、classical 文本；自动识别遵守同一限制。Surge 来源格式、配置段落、条目内出口和其他客户端专属参数会明确报错，不会自动转换或静默删除。
- 聚合保留各来源的 `no-resolve` 语义：仅将对应来源的 IP 条件（含逻辑规则中的条件）标记为不主动解析，不影响同策略的其他来源。单条 IP 规则支持 `src`、`no-resolve`，并支持 `IN-PORT` 匹配。
- **按策略聚合后分桶输出**开启时，同一出口的启用规则集合并、规范化去重后重新分桶，放在该出口首次出现的位置；不同出口之间不去重。
- 关闭时，每个规则集独立去重、分桶，保留各自匹配顺序。开关本身不改写独立顺序；“调整匹配顺序”显示实际聚合块或独立规则，移动聚合块会一起移动其成员。单条规则独立排序，兜底始终最后匹配。
- `domain`、`ipcidr` 各自超过 1000 条时独立输出，小桶并入 `classical`，不生成空桶。带 `no-resolve` 或 `src` 的 IP 规则保留在 `classical` 中，避免专用桶丢失选项。Clash 只需加载本项目生成的规则提供者。规则源不再设置固定下载大小、编译输入总量或规则条数上限；大规则集边解析边去重，按当前客户端生成产物。实际处理仍受 Worker 运行资源和 KV 单值存储容量约束，失败会报错，不截断规则。
- 新 Clash 配置默认使用编排并开启聚合；已有编排配置沿用开关原值。旧原生配置先点击“转换为分流配置”，检查草稿后保存。未引用的来源保留为停用条目，已有休眠编排条目保留为停用状态。文件、MRS、额外原生参数或逻辑规则内的原生规则集引用必须先处理，不能静默丢弃。迁移保存会执行编译校验，失败时旧配置继续生效，页面保留草稿和原因。
- 转换后来源由本项目按既有刷新周期管理，原生提供者的客户端缓存路径和单独刷新周期不再使用。编译结果默认折叠，读取真实缓存状态、去重数及实际输出桶；草稿变化后需保存并重新读取，刷新失败会展示原因及缓存回退信息。

Surge、sing-box 继续显示当前配置对应的原生或编排编辑器。各端来源、出口、顺序、内联规则和单条规则独立保存。同一 URL 可复用正文缓存，编译产物按客户端隔离；删除本端来源不会删除其他端仍使用的正文缓存。本次不需要 KV 数据结构迁移或新增 Secrets；部署后新编译器会按新指纹重新生成所需产物。

修改规则集来源地址会保留已有来源的启用状态，只有新建来源默认启用。sing-box 编排编辑器遇到含 `no-resolve` 等附加选项的旧规则时会阻止直接改写，需先通过原生路由表单明确处理其语义，避免编辑时丢失选项。策略候选项包含当前草稿中已启用、适用于所选客户端的手动共享节点，以及这些节点生成的链式节点；名称复用后端解析与去重逻辑，读取候选项不会保存配置或拉取订阅源。

sing-box 的 `netns` 支持已配置的命名空间标签，也支持客户端 Linux 系统的命名空间名称或路径。系统名称和路径不要求出现在 `network_namespaces` 中，其是否存在由运行 sing-box 的设备检查。

- 按策略合并规则集时，合并项放在该策略首次出现的位置，可能改变跨策略的匹配优先级。
- 兜底规则必须在最后。Surge/clash 编译计划需要一个 `FINAL` / `MATCH`；单条兜底可只写规则类型，也可带策略及逗号前后空白，输出使用其独立策略字段。
- sing-box 也可使用显式 `route.final`，或以无条件路由/拒绝规则兜底。`route.rules` 中的 `preferred_by` 引用出站或 endpoint，DNS 规则中的同名字段引用 DNS 服务器。
- clash 原生 rule-providers 只提供数据，需要在 rules 中显式添加 `RULE-SET` 引用及策略；系统不会自动插入 Proxy 规则。
- Surge 的 Hosts、DNS 跟随出站及其他高级功能在本端维护。简单 IP Hosts 可转换给 sing-box；别名、通配或指定解析器需要手动处理。

Surge 输出校验按完整分节标题识别配置段；`[来源] 节点名` 这类带方括号前缀的节点仍按代理声明处理，后续 Tailscale 策略也参与可用性和依赖检查。

普通不支持节点或可省略功能产生诊断；被引用的空组、缺失策略或链式依赖、循环引用、无法等价转换的关键规则会阻止对应端输出，不会自动改成直连。订阅请求遇到阻断项返回 **HTTP 422**，响应包含具体错误及配置位置。可在“配置链接 → 订阅检查”中选择客户端，在检查按钮下方以页面内纯文本日志查看服务器已保存配置的检查结果，包含时间、级别、配置位置、错误代码和说明；支持一键复制或手动选中复制。修改后先保存，再重新检查。

sing-box 按固定版本的官方 JSON Schema 校验。旧 GEOIP 数据规则、Surge `IN-PORT`、`no-resolve` 等不能直接等价转换的规则，需要在当前客户端中改写。生成的远程规则集使用 1.14 的 `http_client` 和版本 4 的 JSON source 格式。字段间约束、设备权限和实际连接仍需在目标客户端核对。

## 更新与迁移

### 更新程序

先阅读 [Release 说明](https://github.com/tnt2ray/subpilot-worker/releases)，保留本地 `wrangler.jsonc` 和已有 Secrets。**以下命令会更新程序并部署到配置中的 Worker：**

```bash
npm run update
```

| 安装方式 | 更新行为 |
| --- | --- |
| Git 克隆 | 要求已跟踪文件无改动，再执行 `git pull --ff-only` 更新当前分支。 |
| Release 发布包 | 优先下载最新 Release 的 `subpilot-worker-vX.Y.Z.tar.gz`，覆盖受管理的程序文件；附件缺失时回退源码包。 |

两种方式都保留本地 Wrangler 配置、安装运行依赖并部署。`npm run update -- --no-deploy` 仅跳过最后的部署，仍会更新代码、依赖和本地配置，不是只读检查。更新后请核对[定时任务](#缓存与运行边界)。

版本更新检查默认关闭，可在“系统设置”启用。启用后定时任务每天最多检查一次 GitHub Releases；已绑定 Telegram 时会提醒新版本，同一版本不会重复提醒。

### 从旧配置迁移到 2.0

**升级后请统一使用通用订阅地址。** `/sync/<read_token>/` 已恢复；基础路径和 token 未变化时，旧通用地址可继续使用。此前使用 `/surge/`、`/clash/`、`/sing-box/` 或带 `stable` / `tf` Tag 地址的客户端，需要在后台复制通用地址替换旧链接，再刷新订阅。具体格式见[订阅地址](#订阅地址)。

全新安装使用配置文档版本 3；KV schema 仍为 12。已有版本 2 文档在读取时自动拆分，保存后写入版本 3，无需手工修改 KV 或更换订阅地址。策略组按原 `groupTargets` 复制到适用端，保留禁用状态；旧共享 `hidden` 继续仅作用于 Surge，clash 的隐藏需在拆分后自行设置；完整规则来源列表复制到三端并保留 ID 与规则引用，后续独立编辑。已打开的旧管理页需要刷新后再编辑。

更早的版本 1 部署仍需在后台确认迁移：

1. 检查 Surge → sing-box 的转换诊断，按需编辑迁移草稿，再确认迁移到配置文档版本 3、KV schema 12。
2. Surge/clash 原设置与共享节点继续保留，各客户端获得独立策略组、规则来源和规则计划；sing-box 此后不再随 Surge 设置变化。
3. 无法等价转换的关键设置会保留待处理标记。可先完成迁移，再手动修复或明确确认放弃该行为；处理阻断项后才能下载 sing-box 配置。

确认迁移时检查旧配置指纹。旧配置发生变化时会阻止提交，页面草稿保留在内存中；记下需要保留的修改后刷新页面，重新检查迁移。

查看迁移草稿不会删除旧配置。新快照写入并读回验证后，旧版数据进入至少 5 分钟宽限期，再分批清理；新文档提交后不会回退读取旧快照。不要删除或轮换原 `CONFIG_ENCRYPTION_KEY`。

<details>
<summary>使用命令行检查与迁移</summary>

通过安全环境变量提供 `SUBPILOT_ADMIN_TOKEN`。第一条命令仅检查迁移状态；第二条命令确认并写入迁移后的配置：

```bash
npm run migrate -- --url "https://your-worker.example"
npm run migrate -- --url "https://your-worker.example" --apply
```

将示例域名替换为实际值，也可通过 `SUBPILOT_BASE_URL` 提供 URL。脚本不导出配置文件，旧 `--backup` 参数和 `SUBPILOT_BACKUP_PATH` 环境变量已移除。转换问题可在迁移后继续通过管理界面处理。

</details>

## 缓存与运行边界

启用的上游订阅定时写入加密缓存，配置生成优先使用缓存；上游失败时尽量沿用已有内容。概览页显示缓存覆盖、更新时间和各项状态，并提供手动刷新。刷新可以部分成功；达到执行截止时间后不再启动新获取或编译任务，失败项单独报告。

本地 `wrangler.jsonc` 的两个定时任务示例：

```json
{
  "triggers": {
    "crons": ["0 */12 * * *", "0 16 * * *"]
  }
}
```

`0 16 * * *` 固定用于每日编译规则集刷新，其余 cron 用于上游订阅。第一项可按需调整；修改后需部署生效。缺少每日任务时仍可手动刷新或在使用时生成规则集。后台和 Telegram 按设置的显示时区展示时间，KV 系统时间使用 UTC。

### 主要上限

| 范围 | 上限 |
| --- | --- |
| 配置请求体 | 6 MiB（容纳三端独立资源） |
| 资源数量 | 共享 20 个订阅源、500 个手工节点；每端最多 100 个策略组，规则来源不设独立数量上限 |
| 规则输出 | 每客户端 40 个 |
| 单个远程输入 | 订阅源 4 MiB；规则源不设项目级下载大小上限 |
| 单个订阅源 | 2,500 个节点、5,000 条 Host |
| 所有订阅源合计 | 10,000 个节点、20,000 条 Host；最终输出最多 15,000 个节点 |
| 单个规则输出编译 | 不设输入字符总量或规则条数上限；仍受运行资源与产物存储容量约束 |
| 最终客户端配置 | 最多 8 × 1024 × 1024 个字符 |
| GeoIP 地区补全 | 每次生成最多查询 100 个不同 IP |
| 规则覆盖诊断 | 最多展开 24 个外部源，合计 8 × 1024 × 1024 个字符和 5,000 条规则 |

### KV 一致性与写入失败

完整配置、读取 token 及编译产物采用追加版本和延迟清理：读取最新有效数据，新版本不完整或损坏时回退有效版本；迁移完成后不再回退旧格式。Workers KV 具有最终一致性，短时间读取旧版本或看到旧键仍存在属于运行边界，不应按固定键名直接修改或删除运行数据。

涉及 Telegram webhook 的保存先完成远端操作，再提交新配置；提交确认失败时会尝试恢复旧 webhook。管理页串行提交保存请求。KV 写入限流返回 **HTTP 429**，请保留页面草稿、稍后重试，避免多个管理页反复写入。

## Telegram 与 GeoIP

### Telegram 通知

填写并保存 Bot Token 即启用通知，清空并保存则关闭。Bot 用于刷新失败、新版本提醒和状态查询。

1. 在 Telegram 的 `@BotFather` 使用 `/newbot` 创建 bot，妥善保存返回的 Bot Token。
2. 在 SubPilot“系统设置”填写 Bot Token，**先保存配置**，再点击“生成绑定码”。
3. 将显示的 `/bind <code>` 发送到目标会话；绑定码一次性使用，有效期 10 分钟。
4. 收到绑定成功回复后，只有该 Chat ID 可以触发 bot 命令。

保存 Bot Token 时自动配置 webhook，地址为 `/api/telegram/webhook`，域名优先取订阅基础 URL 的 origin。推荐个人私聊或管理员私有群组；群组通常无需管理员权限，频道需要相应接收与发送权限。保留 BotFather 默认隐私模式即可接收明确发给 bot 的命令。

| 命令 | 用途 |
| --- | --- |
| `/status` | 订阅与缓存概览，以及最近 Surge/clash/sing-box 拉取时间 |
| `/sources` | 订阅源启用状态 |
| `/recent` | 最近 5 条配置拉取记录、目标、客户端位置和 UA |
| `/refresh` | 强制刷新订阅源，并异步刷新编译规则集，分别回复结果 |
| `/help` | 命令列表 |

可用 BotFather 的 `/setcommands` 配置菜单，但不要公开添加临时 `/bind` 命令。群组命令无响应时尝试 `/status@你的_bot_用户名`；绑定失败时检查 token、绑定码有效期、目标会话和发言权限。

更换会话时先“解除绑定”，再生成新绑定码。替换 Bot Token 会清除原 Chat ID 并重新注册 webhook，需要再次绑定；token 泄露时先在 BotFather 撤销。关闭通知会删除旧 webhook。

参考：[Telegram Bot 创建](https://core.telegram.org/bots/tutorial)、[Bot Features](https://core.telegram.org/bots/features)、[Bots FAQ](https://core.telegram.org/bots/faq)、[命令菜单 API](https://core.telegram.org/bots/api#setmycommands)。

### GeoIP MMDB

在“系统设置”的 GeoIP MMDB 区域可查看当前文件名、数据库类型、数据库版本（构建时间）、上传时间和文件大小；已有数据库也会读取其内置版本信息，缺少构建时间时会明确标注。

选择 Country `.mmdb` 文件后点击“上传”，最大 **25 MiB**，无需手动进行 Base64 转换。页面显示传输进度及服务端校验、保存状态，上传期间禁用重复上传。成功后立即更新当前数据库信息；失败时显示原因并保留所选文件以便重试，也可点击“刷新数据库信息”确认当前状态。

可从本机客户端选择已有文件，路径参考如下：

| 客户端 | MMDB 文件路径 |
| --- | --- |
| Surge macOS | `~/Library/Application Support/com.nssurge.surge-mac/GeoLite2-Country.mmdb` |
| Clash Verge Windows | `%APPDATA%\io.github.clash-verge-rev.clash-verge-rev\Country.mmdb` |
| Clash Verge macOS | `~/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/Country.mmdb` |

地区查询使用已有单 IP 覆盖记录和上传的 MMDB，单 IP 记录优先，不调用外部在线接口。没有 MMDB 时只能依赖已有 IP 记录，可能影响 IP 节点重命名、地区筛选、链式匹配及最近记录中的位置显示。上传新库后，版本化缓存使旧结果失效。

## 安全与数据

| 数据 | 保存位置 |
| --- | --- |
| Worker 名称、KV namespace ID、自定义域名 | 未跟踪的本地 `wrangler.jsonc` |
| 管理员 token 的 SHA-256 hash | Worker Secret `ADMIN_TOKEN_HASH`，不保存 token 明文 |
| 配置加密密钥 | Worker Secret `CONFIG_ENCRYPTION_KEY` |
| 配置快照、上游与规则缓存、编译规则、Bot Token、可恢复读取 token | 加密的 Workers KV 数据 |
| 管理员会话 | HttpOnly 签名 Cookie，不创建 `session:*` KV 键 |

订阅链接的读取 token 授予配置访问权限。不要把 token、私有配置、密码、MITM CA 或其他运行数据提交到仓库、Issue 或公开聊天。程序更新保留原 Secrets；丢失或替换加密密钥会使对应数据无法解密。

## 本地开发

使用 `npm install` 安装完整依赖，按需运行以下命令；Wrangler 使用全局版本：

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动本地 Worker 与管理页 |
| `npm run typecheck` | TypeScript 检查 |
| `npm run typecheck:worker` | 生成 Worker 类型并检查 TypeScript |
| `npm run verify` | Worker 类型生成、TypeScript 检查和公开文件扫描 |
| `npm audit` | 依赖漏洞检查 |
| `npm run dry-run` | 本地生成部署产物，不执行部署 |

`dry-run` 使用本地 `wrangler.jsonc`。也可显式使用公开示例配置检查构建，以下命令不会部署：

```bash
wrangler deploy --dry-run --config wrangler.example.jsonc --outdir /tmp/subpilot-dry-run
```

API 保存使用版本 3 文档；旧版配置读取时自动转换。订阅输出端通过通用地址请求的 User-Agent 识别。

下载 sing-box 输出后，可在已安装对应内核的环境中检查：

```bash
sing-box check -c SubPilot.json
sing-box rule-set compile rules.json -o rules.srs
```

内核检查不能替代目标设备上的导入、VPN 权限、证书路径及实际连通验证。设计资料见[架构说明](./docs/architecture.md)、[Surge 输出说明](./docs/surge-compatibility.md)和[界面规范](./docs/ui-design.md)。

## 许可证

项目代码按 [GNU Affero General Public License v3.0 or later](./LICENSE) 授权；修改版网络服务的源码提供要求以许可证为准。

依赖与内置第三方代码保留各自许可证。用户配置或上传的订阅、规则集、GeoIP MMDB、客户端资源及其他外部数据不随本项目授权；使用前请确认来源和许可。
