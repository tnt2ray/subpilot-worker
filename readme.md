# SubPilot Worker

语言：中文 | [English](./README.en.md)

SubPilot Worker 是运行在 Cloudflare Workers 上的订阅配置生成器，使用 Workers KV 保存加密配置。2.0 共享订阅源和代理节点，三端分别维护策略组和规则来源，为 **Surge、clash 和 sing-box** 分别生成配置。

[功能概览](#功能概览) · [部署](#部署) · [首次配置](#首次配置) · [订阅地址](#订阅地址) · [配置模型](#配置模型) · [更新与迁移](#更新与迁移) · [缓存与运行边界](#缓存与运行边界) · [Telegram 与 GeoIP](#telegram-与-geoip) · [安全与数据](#安全与数据) · [本地开发](#本地开发) · [许可证](#许可证)

## 功能概览

- 共享资源只维护一份，三端的网络、DNS、路由与高级设置独立保存。
- 按目标客户端适配输出；无法保留的节点或附加功能会报告原因，关键配置问题会阻止下载。
- 支持手动节点、链式出口、策略组筛选、原生规则及本端来源编排。
- 提供订阅检查、通用订阅地址、加密缓存、Telegram 通知和 GeoIP MMDB 上传。
- 可选启用 GitHub Actions，统一处理 Surge、Clash、sing-box 规则集的合并、去重和分桶，并按客户端发布产物。
- sing-box 适配基线为 **1.15.0-alpha.6（预览版）**；旧配置可迁移到配置文档版本 3。Stash 和 Shadowrocket 已退出输出目标。

概览页可查看最近 50 条订阅请求、节点总数和订阅缓存状态。点击“强制刷新”重新获取已保存且启用的订阅源；刷新失败时可查看原因及旧缓存是否可用。

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
3. 核实远端 Secrets；缺少管理员凭据时要求输入至少 24 个字符的 token，缺少配置加密密钥时使用指定值或生成密钥。
4. 将缺失的 `ADMIN_TOKEN_HASH`（token 的 SHA-256 hash）和 `CONFIG_ENCRYPTION_KEY` 通过 `wrangler deploy --secrets-file` 补齐并部署；临时密钥文件会在命令结束后删除。

请把管理员 token 保存在密码管理器中。若已有本地 `wrangler.jsonc`，脚本会复用配置，核实并保留已有 Secrets，只补齐缺失项。首次安装因 token 无效或部署失败而中断后，可修正问题并重新运行 `npm run setup`；本地配置文件的存在不会导致跳过未完成的 Secrets 初始化。无法核实远端状态时停止，不写入 Secrets。手动安装见下方独立步骤。

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

模板包含上游订阅刷新、每日规则变化检测、每 5 分钟待办续建三个定时任务，详见[缓存与运行边界](#缓存与运行边界)。自定义域名可在 Cloudflare 中连接到 Worker，或写入本地 `wrangler.jsonc` 的 `routes`。不要提交个人部署配置。

</details>

## 首次配置

打开部署地址，用管理员 token 登录。旧版本用户应先完成[配置迁移](#更新与迁移)。

1. 在“系统设置”确认订阅基础 URL（通常为 `https://<your-domain>/sync`）和显示时区。
2. 在“订阅源”添加上游地址、名称和抓取 User-Agent；在“代理节点”维护手动节点或链式出口。编辑节点时，仅启用“作为链式出口”后显示“前置节点筛选”；关闭后隐藏，保留已填写的筛选条件。每行一个关键词，节点名称或标签包含任一关键词即选中，不区分大小写、不支持正则。仅为命中的非出口节点生成链式节点，未命中节点不参与；留空不生成。链路为“本机 → 命中节点 → 当前出口节点 → 目标网站”。
3. 在“策略组”选择客户端，再设置该端的成员、筛选条件和参数。
4. 在“客户端配置”选择 Surge、clash 或 sing-box，编辑当前端的网络、DNS、路由与高级功能。
5. 在当前客户端“分流规则”页直接填写规则集来源地址（每行一个），并下拉选择策略组。新地址自动关联到该端规则来源；规则集和单条规则在同一列表中上下排序。Surge 直接选择 RULE-SET / DOMAIN-SET，Clash 设置 behavior 和 interval，sing-box 直接选择来源格式。
6. 保存配置，在“配置链接”检查订阅并复制通用订阅地址。

系统设置按“界面偏好 → 节点处理 → 订阅与抓取”排列，显示时区通过下拉列表选择，并保留当前已配置的时区。节点处理区用标签展示排除关键词，以“标签名＋匹配关键词”逐行展示特征标签；点击标题旁的编辑图标修改。

订阅源、代理节点和策略组均可点击名称或行内“编辑”按钮修改已有内容；弹窗中点击“应用更改”后，再点击页面底部“保存配置”持久保存。窄屏下操作列保持可见，其余详情可横向滚动。

页面标题与底部操作栏保持可见，长内容在中间区域独立滚动，避免被操作栏遮挡。

标题统一将文字与问号组成一组，问号紧跟标题文字，操作按钮置于该组之外；功能介绍和较长使用说明集中在问号提示中，点击查看，点击外部或按 Esc 收起；错误、运行进度、必填要求和保存提醒仍直接显示。

草稿保存在当前页面内存中，切换页面或客户端可继续编辑；刷新或关闭页面会丢失未保存内容。订阅请求使用已保存配置，并在生成时执行兼容性校验。

## 订阅地址

以下示例使用默认基础路径 `/sync`；实际地址以管理页“配置链接”为准。

Surge、clash 和 sing-box 全部使用同一个地址：

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

订阅源、手动节点和链式节点供三个客户端共用。策略组、规则来源、分流规则、网络和 DNS 分别维护，修改一端不会同步到其他端。同名策略组和规则集名称可在不同客户端中分别使用。

Surge、Clash 和 sing-box 不再互相转换、复制或初始化客户端设置。全新安装或从版本 1 配置升级时，sing-box 使用自有的原生 DNS、TUN 入站、出口接口检测、Proxy 策略组和 FINAL 规则默认值；Tailscale 连接默认为空。代理出站由共享节点和当前端策略组生成，已保存的各端配置保持原样。

跨客户端迁移诊断及其处理面板已移除。读取或导入配置时会丢弃全部历史 `migrationIssues`，后续保存时写回清理结果；这些旧记录不再阻断订阅检查或下载，无需逐条处理或重新初始化。当前配置的原生字段、引用和规则检查继续生效。旧版本 1 / 2 文档升级为版本 3 的存储兼容保留，无需新增 KV 数据结构迁移。

配置内容带行号和语法高亮，点击编辑图标打开编辑弹窗。应用更改后仍需点击页面底部“保存配置”。

### 节点与策略组

“代理节点”接受 Surge 节点语法、Clash YAML/JSON 和 sing-box 原生 JSON。sing-box JSON 可为单个节点、节点数组或包含 `outbounds` 的对象，只导入代理节点，不导入文件中的 DNS、路由或策略组。

Clash 适配基线为 Mihomo **v1.19.31**：TUN 支持 `mips`；DNS 可设置 `fallback-lazy-query`（默认关闭）和 Linux `listen-routing-mark`（0 为禁用）；`select` 组可在独立字段设置 `default-selected`，默认成员必须存在于输出成员列表，客户端已保存的选择可能覆盖它。

原生 Clash YAML/JSON 支持 EasyTier、ZeroTier、MASQUE、WireGuard 和 OpenVPN；EasyTier、ZeroTier 及包含 `peers` 的 WireGuard 不要求顶层 `server`/`port`。原生字段完整保留，包括 ZeroTier `identity-secret`、WireGuard AmneziaWG 参数及 `ip-stack`；AnyTLS `client-metadata` 和 Hysteria2 `handshake-timeout` 也会保留。此类节点请填写对应内核的原生配置；Surge 与 Mihomo 的 MASQUE 不互转。内核配置校验不代表远端网络已连通。

重复节点合并后保留各来源的原始名称映射，使链式引用仍指向保留的节点。订阅 URI 按其传输类型解析，无法等价转换的传输会跳过并提示；Hysteria2 链接省略端口时使用 443，并保留完整的 `username:password` 认证。

策略组按客户端配置。组定义格式为 `类型, 成员或筛选器, 参数=值`，使用英文逗号，不填写 `组名 =` 前缀。页面中的“语法说明与示例”列出当前端可用类型和参数。

- `{all}` 选取代理节点，不选取其他策略组。
- `fallback` 支持 `{all}` 及其筛选语法，例如 `fallback, {all}`；展开后的节点顺序决定故障切换优先级，节点顺序变化会影响优先级。`subnet` 不支持此选择器。
- `{all filter=香港,日本 exclude=via,DMIT}` 按名称和标签包含匹配，先筛选再排除，不区分大小写，不是正则表达式。
- 显式成员可引用当前端支持的节点、策略组和内置策略；不能自引用或形成循环。
- `Proxy` 必须保持启用，不能删除或重命名。筛选后为空的其他组不输出；分流规则引用该空组时回落到 `Proxy`。`Proxy` 无可用成员时阻止下载。
- 删除或重命名被引用资源后，需要手动调整引用。

Surge 支持 `select`、`smart` 等类型，`url-test` 会转换为 `smart`；Clash 支持 `select`、`url-test`、`fallback`、`load-balance`；sing-box 使用 `selector`、`urltest` 输出。各端支持范围不同，不能直接复制全部组参数。Snell 6 不会降级为 Clash 的 Snell 5；sing-box 支持转换 Snell 4/6。AnyTLS 转换保留 TLS 服务器名称与证书校验选项，省略 sing-box 不支持的 TCP Fast Open。

### 客户端配置

| 页面 | 用途 |
| --- | --- |
| 网络与 TUN | 本地代理端口、TUN、接口与连接设置；sing-box 入站提供 TUN、HTTP、SOCKS、mixed |
| DNS | 解析服务器、解析规则和缓存；sing-box 的连接域名解析器也在此处配置 |
| 分流规则 | 规则集地址、单条匹配条件、出口策略与匹配顺序 |
| Tailscale | Surge 与 sing-box 分别配置连接，不跨端复制 |
| WireGuard / OpenConnect / OpenVPN | sing-box 专用的独立客户端连接页 |
| 高级设置 | Surge 的 URL Rewrite、Map Local 和脚本；sing-box 的日志与 HTTP 客户端；Clash 无此页 |
| MITM 证书 | 仅 Surge：生成、导入或导出 CA，设置 MITM 主机名 |

sing-box 适配基线为 **1.15.0-alpha.6（预览版）**。可选参数通过表单添加，移除可选字段恢复内核默认行为。订阅无法代替客户端设置系统权限、Always On 或应用选择；请在实际设备完成这些操作。

SubPilot 不再提供或生成 sing-box TUN 的 `stack` 选项；加载或导入已有配置时会自动清理该字段，由客户端采用自身默认栈。1.15 使用 sing-tun 自有协议栈；旧 1.14.0 / 1.14.1 配置加载时自动升级版本标记，保留原生设置。启用 1.15 新字段的配置需要相应版本的客户端。

1.15 新功能入口：

- **VPN 连接**：WireGuard、Tailscale、OpenVPN 和 OpenConnect 提供 `on_demand`，允许客户端在需要时断开端点，不等同于空闲超时。
- **高级 → 缓存、API 与调试**：`cache_file.buffer_size` 设置写缓冲大小（默认 `1MB`）；`flush_interval` 设置定时刷新间隔（例如 `30s`，默认不启用定时刷新）。
- **入站管理 → TUN**：支持 `multi_queue`（仅 Linux、新协议栈）和 `auto_redirect_tproxy_mark`。Android 的完整 `auto_redirect` 需要 root 服务或 root shell。
- **入站管理 / 高级 → 本端原生出站**：支持 Tailcat。共享节点也可导入原生 Tailcat JSON，保留密钥及 DERP 参数，仅输出到 sing-box；Tailcat 不使用常规服务器和端口。通过 `sing-box generate tailcat-keypair` 生成密钥；入站需私钥，出站需服务端公钥和发现公钥。自定义 `derp_servers` 不可与 `derp_map_url` / `derp_region` 混用。
- **高级 → 服务 → DERP**：支持 `verify_client_inbound` 和 `verify_client_key`，入站引用必须指向已存在的 Tailcat 入站；启用验证的客户端需固定私钥。

新增可选设置不会自动启用。参考 [1.15 更新日志](https://sing-box.sagernet.org/changelog/) 和 [Tailcat 文档](https://sing-box.sagernet.org/configuration/outbound/tailcat/)。

### Tailscale

节点名称可用于当前端策略组和分流规则。Surge 启用节点可选择认证密钥或交互登录，二者互斥；交互登录需在 Surge 策略编辑器完成，身份保存在当前设备，修改配置段名称可能需要重新登录。sing-box 可留空，通过客户端日志中的登录地址授权，多个实例应使用各自的状态目录。认证密钥在编辑时以密码框显示。

SubPilot 只生成配置，不代替客户端登录 Tailscale。参见 [sing-box Tailscale 文档](https://sing-box.sagernet.org/configuration/endpoint/tailscale/)。

Surge 提供 `auto-add-magic-dns-rule` 开关，默认启用，为 MagicDNS 和可见对端地址自动添加路由；子网和出口流量仍需显式规则。已有空闲保活值保持不变。测速地址支持 HTTP 和 HTTPS，HTTPS 需要支持该功能的 Surge Beta，TLS 握手可能增加测试耗时。

### Surge 策略组与规则兼容

策略组编辑器提供 `category` 分类字段和 Smart 优先级编辑入口。优先级每行填写 `regex:factor`，例如 `Premium:0.9`；首个匹配项生效，权重必须为有限正数，小于 1 更优先。支持引号内含逗号和量词的正则；`url-test` 仍输出为 `smart`。

分类和 HTTPS 测速依据 [Surge Beta 公告](https://t.me/SurgeTestFlightFeed/413)，使用前需更新到支持它们的客户端。Mac 6.9.1 / iOS 5.22.1 起支持 `GEOIP,UNKNOWN` 和 `IP-ASN,UNKNOWN`，可用于 Surge 单条规则、逻辑规则和编译规则集；该语义不会转换为其他客户端的 ASN 或 GeoIP 匹配。

### 分流规则

sing-box DNS 页区分三种用途：“DNS 服务器列表”维护可选服务器；“DNS 查询兜底服务器”用于未命中规则集 DNS 或高级 DNS 规则的查询，留空使用列表中的第一个服务器；“建立连接时的默认 DNS”用于代理节点地址和直连时尚未解析的目标域名，连接单独指定解析器时优先使用其设置，可能绕过 DNS 查询分流规则。

sing-box 的 DNS 页将原生规则放在默认折叠的“高级 DNS 规则”中，标题显示已配置数量。规则集 DNS 在“分流规则”Tab 配置；高级 DNS 规则在其后匹配，折叠不影响已有规则生效。

规则集编辑窗口可指定“DNS 解析服务器”，留空继承全局；列表显示当前设置。本文的 Clash 指 Clash Verge 使用的 Mihomo 内核。Surge / Clash 填写一个 IP、IP:端口、`system` 或加密 DNS URL；sing-box 选择 DNS 页已有服务器。修改后保存配置并更新订阅，无需 KV 数据结构迁移或额外部署步骤。

- Surge 生成 `[Host]` 的 `RULE-SET:` / `DOMAIN-SET:` DNS 映射，要求 Mac 5.10+ / iOS 5.14.3+。已有 Host 映射优先，规则集按本页顺序匹配；代理远端解析不保证使用指定 DNS。指定 DNS 的条目不参与按策略聚合。
- Clash 生成 `dns.nameserver-policy`，要求启用 DNS；`ipcidr` provider 不允许指定 DNS。此设置选择解析服务器，不改变 DNS 连接出口，也不保证代理远端解析行为。
- sing-box 单独生成 `-dns.json` 域名规则集（Actions 产物就绪后为 `Sing-Box/<规则集名称>/dns-domains.srs`），包含独立 DOMAIN、DOMAIN-SUFFIX、DOMAIN-KEYWORD、DOMAIN-REGEX、DOMAIN-WILDCARD 规则；排除 IP、进程和逻辑组合。绑定按本页顺序优先于 DNS 页原生规则，无可用域名时提示。删除或重命名所引用的 DNS 服务器后，需更新绑定才能保存。


1. 选择客户端，打开“分流规则”，添加规则集或单条规则。
2. 规则集填写下载 URL，每行一个，选择格式和出口策略。
3. 按匹配优先级排序。末尾兜底行为 Surge `FINAL`、Clash `MATCH`；sing-box 的 `FINAL` 行对应 `route.final`。兜底不可删除、停用或移动，可修改出口。
4. 应用更改并保存，然后更新客户端订阅。

| 客户端 | 规则集设置 |
| --- | --- |
| Surge | `RULE-SET` 或 `DOMAIN-SET`，以及规则类型支持的附加选项 |
| Clash | 来源格式：自动识别、Clash YAML、域名/IP-CIDR/classical 文本；`behavior`：domain / ipcidr / classical；`interval` 为下载间隔，单位秒，默认 86400 |
| sing-box | 自动识别或指定 Clash、Surge、域名、IP-CIDR、classical 来源格式；SRS 独立直连 |

单个兼容的 Surge 来源，以及明确指定格式且兼容的单个 Clash 来源，由客户端直接下载，Worker 不下载或缓存。Clash 的“自动识别”按实际内容识别并编译，即使只有一个 URL 也不根据扩展名猜测格式；适用于无后缀、`.conf` 或后缀与内容不一致的地址。所选格式用于本条目所有地址；修改共享来源的格式不会改变其他条目的设置。同一条目包含多个 URL 时，系统合并去重；Clash 自动生成 `rule-providers`，无需手写。不同 Clash / sing-box 条目保持独立，不按出口跨条目聚合。Surge 可选“按策略聚合”，启用前请核对匹配顺序。

Surge 编译保留用户指定的 `no-resolve`，不会因包含 IP-CIDR 自动添加；来源中的 `extended-matching` 保留在 RULE-SET 中。DOMAIN-SET 无法表达的规则选项，以及其他客户端无法等价转换的扩展匹配，会产生诊断并阻止不兼容输出。Clash 原生 HTTP provider 未填写 `path` 时，自动分配互不冲突的缓存路径，并避开已显式指定的路径。

sing-box 使用 Clash 或 Surge 来源时，即使只有一个 URL 也需要转换。`IP-ASN` 展开为 IPv4/IPv6 CIDR，定期更新；查询失败时优先使用旧缓存，无数据则跳过并提示。`USER-AGENT`、`URL-REGEX` 等不支持的规则被跳过，来源下载失败或格式错误会报错。生成的远程规则集使用直连 HTTP 客户端下载。

sing-box 的 `.srs` 地址在自动识别模式下直接输出为独立的 `remote` / `binary` 规则集，由客户端下载和更新；无 `.srs` 后缀的二进制地址可明确选择 SRS 格式。同一条目混合 SRS 与文本来源时，每份 SRS 独立输出，只有文本参与合并编译，出口沿用该条目的策略。Worker 不下载、解析或缓存用户提供的原生 SRS 来源。指定 DNS 解析服务器时，SRS 直接用于原生 DNS 规则匹配，请选择适合 DNS 匹配的规则集；文本来源仍只提取独立域名规则。

启用 sing-box 统一规则后，原生路由与规则集表单仍可编辑；原生规则继续先于统一规则匹配。Clash 从原生规则转换时，清理历史共享或 Surge 规则计划，仅保留本次原生规则及其提供者；转换失败时保留原配置。

合并或转换后的规则文件由系统命名，Surge、Clash、sing-box 默认分别使用 `.list`、`.yaml`、`.json` 扩展名；启用下述选配功能后，sing-box 使用 `.srs`。三端可使用相同名称。

### Actions 规则编译（选配）

默认关闭。关闭时，Worker 保留现有的来源获取、规则合并、去重、格式转换与重新分桶能力，生成 Surge `.list`、Clash `.yaml` 和 sing-box `.json`。启用后，三个客户端需要合并或转换的规则集统一交给 GitHub Actions：Actions 直接下载原始规则来源，使用与 Worker 共用的编译核心完成处理，再将 sing-box 规则编译成 SRS（sing-box **1.15.0-alpha.6**）。Worker 优先使用已确认的 Actions 产物；产物未就绪时，复用匹配当前配置的本地缓存，缺失时自行获取来源、合并、去重并分桶，保持订阅可用。

产物分支固定为 **`rules`**，没有可编辑的产物分支设置。三个客户端分目录存放，同名规则集相互独立：

| 客户端 | 目录示例 | 产物 |
| --- | --- | --- |
| Surge | `Surge/OpenAI/` | `routing.list`、`domains.list` |
| Clash | `Clash/OpenAI/` | `routing.yaml`、`domains.yaml`、`ip-ranges.yaml` |
| sing-box | `Sing-Box/OpenAI/` | `routing.srs`、`domains.srs`、`ip-ranges.srs`、`dns-domains.srs` |

只生成当前规则集需要的文件；目录中还包含用途说明 `README.md` 和发布清单 `manifest.json`。支持中文名称；特殊字符、过长名称及保留名称会转换为安全名称并附加摘要。兼容的单个直连来源、用户提供的原生 SRS 以及单条规则继续使用原有处理方式，不作为合并任务上传。

1. 准备已初始化且启用 Actions 的公开仓库，勾选添加 README。默认分支用于工作流，不能命名为 `rules`；每个 SubPilot 部署使用独立仓库。
2. 创建 fine-grained GitHub Token，仅选择目标仓库，授予 **Actions、Contents、Workflows、Secrets: Read and write**；组织仓库如需审批请先完成。
3. 为至少一个客户端启用规则来源编排并保存。打开 **系统设置 → Actions 规则编译 → 配置向导**，填写仓库、工作流访问地址和 Token。
   Token 的初次配置和替换统一通过配置向导完成；已有 Token 时显示星号掩码，保持不变沿用，填写新值则替换。向导在桌面端统一左侧标签、右侧输入框，窄屏改为上下排列；辅助链接紧随对应字段，高级设置中的分支输入框保持相同对齐。Token 下方仅提示选择仓库所有者及目标仓库，不重复列出权限；“申请 Token（预选权限）”链接预填 Actions、Contents、Secrets 读写及 Workflows 写入权限，仍需在 GitHub 选择仓库所有者并仅授权目标仓库。系统设置中，外层 Actions 标题旁的问号集中提供功能、公开规则、Token 权限和配置向导说明，向导弹窗标题不再显示问号；仅在启用 Actions 编译时显示其配置和操作；Telegram 未填写 Bot Token 时隐藏 Chat ID 和绑定操作。收起配置不会清空已填写的值。
4. 点击 **检查、安装并启用**。向导安装 `compile-rule-sets.yml`、运行脚本和共用编译器，保存新配置并提交首批任务，成功后立即更新页面中的开关和仓库信息，不保存其他页面草稿。凭据独立加密保存；共享密钥同步为 GitHub Secret `SUBPILOT_ACTIONS_SECRET`，访问地址保存为 `SUBPILOT_URL`。
5. 建议使用本部署的 workers.dev 地址作为工作流访问地址，避免自定义域名的人机验证。向导只检查格式；真实连通性与触发权限由首次运行验证。
6. 打开 **查看编译进度**，按 Surge、Clash、sing-box 查看状态；编译期间可使用 Worker 规则；产物确认后，在客户端更新订阅即可切换到 Actions 版本。GitHub 接收请求仅表示提交成功，排队和实际执行情况请查看仓库 Actions。

首次启用、规则计划变化或 Actions 编译失败时，未就绪的规则由 Worker 接管，Actions 提交或回调失败不会阻断 Worker 处理。每个规则集独立选择已确认的远程产物或匹配当前配置的 Worker 缓存，允许同一份订阅混用两者。sing-box 回退时使用 JSON；Actions 确认后，新订阅改用 SRS，已下发的托管 JSON 地址仍返回 JSON，并继续按需刷新。配置未变化且已有确认产物时，来源刷新或编译失败可沿用该已发布版本。关闭开关并保存后统一使用 Worker。

Worker 会在有限请求预算内尝试生成缺失的规则；仅当远程产物与本地完整规则都不可用，且来源失败或处理尚未完成时，才返回原有错误或 HTTP `503` 与 `Retry-After`，并继续后台准备。不会仅因 Actions 尚未完成而拒绝订阅，也不会使用与当前规则计划不匹配的旧缓存。

保存规则变更、手动刷新和每日刷新均可触发 Actions。一次任务批量检查三个客户端的规则集，同一来源在该批次内只下载一次；来源内容、编译输入和有效 ASN 数据均未变化时复用已发布产物。sing-box 编译器仅在需要生成 SRS 时下载，且每批只下载一次。单项失败不阻止其他规则集发布。现有每 5 分钟维护任务检查未完成任务，自动提交间隔为 60 分钟；“重新提交编译”可跳过该间隔。无需额外 GitHub 定时任务。

每个规则集的文件和清单以同一次提交原子发布，删除该目录内不再需要的旧分桶文件，保留其他目录；分支冲突会重试，不使用强制推送。Worker 仍校验具体提交中的公开清单；向 Surge、Clash 和 sing-box 输出的规则地址统一使用固定的 `rules` 分支，不包含提交号。规则内容重新编译后，客户端按规则更新周期拉取最新内容，无需更新主配置；从旧提交地址切换或规则目录、分桶发生变化时，仍需更新一次主配置。公开文件和 Git 历史不会因关闭功能或删除规则集而自动移除。

配置字段统一为 `settings.actionsCompilation`，仅保存启用状态、仓库和分支；状态接口为 `GET /api/actions-compilation/status`。工作流文件名由 Worker 固定为 `compile-rule-sets.yml`，页面不再提供文件名设置，安装和触发均忽略客户端传入的旧字段。升级会一次性清理当前 KV 配置中的旧文件名及其失效协议记录，复用已有迁移状态，完成后停止扫描。旧仓库、分支、开关，以及 KV 中保存的加密 Token、共享密钥和访问地址继续沿用；新配置和新凭据记录始终优先，已清除的凭据不会被恢复。原工作流使用其他文件名的部署需通过配置向导安装固定名称的工作流，期间由 Worker 提供规则。 已启用 Actions 但尚未完成工作流更新时，首次进入管理页面会使用已保存的仓库、访问地址和 Token 自动尝试安装一次，并弹窗显示进度和结果，无需确认。失败时可在向导中修正后重试；选择跳过会保存关闭 Actions 编译并继续由 Worker 提供规则。更新成功或关闭后不再提示，无需额外 KV 提醒标记。

旧数据迁移是一次性升级任务：仅在未完成时借用现有五分钟任务分批推进，持久化新设置并迁移加密凭据和访问地址。读回校验成功并经过至少五分钟传播宽限期后，清理旧 SRS 的凭据、地址、协议标记、任务缓存和发布回执。完成后只读取既有完成状态并立即跳过，不再扫描、解密或清理旧数据；中断时从已保存进度继续。仍用于 Worker 回退的规则正文和正常的三个配置回滚版本保留，无需手动操作 KV。

配置旧快照及配置、订阅令牌的冗余迁移标记也只清理一次，完成状态复用现有记录；日常读取配置不再附带旧快照清理。之后更新或清空凭据、保存访问地址时，被替换的迁移记录设置十分钟过期，自动回收，无需长期轮询。五分钟任务仍负责正常的未完成规则编译。

规则计划快照在 KV 中加密保存 24 小时，供 Actions 认证下载；正常 Actions 编译的来源正文由 runner 下载至临时目录，执行结束后清理，不写入仓库；Worker 接管时按原有方式加密缓存来源和本地编译结果。Worker 保存 Actions 发布元数据，不存储或代理其产物正文。规则集名称和生成的规则内容会公开，来源地址、Worker 地址和访问凭据不写入产物或任务日志。Token 与共享密钥独立加密保存，不进入配置导出；替换 Token 保留共享密钥，清除后重新配置则须重装工作流。`ADMIN_TOKEN_HASH`、`CONFIG_ENCRYPTION_KEY` 仍由 Worker Secrets 管理。

部署构建会运行 `npm run build:actions`，从共享编译核心生成供配置向导安装的独立脚本。生成文件位于被忽略的 `dist/`，不提交到源仓库；安装依赖时也会自动构建。

工作流模板随 `scripts/compile-rule-sets.yml` 分发，兼容旧版压缩包更新器；配置向导将其安装到目标仓库的 `.github/workflows/`。从 v2.2.2 更新无需手动补充模板，也无需手动执行 KV 迁移命令。

### 订阅检查

在“配置链接 → 订阅检查”选择客户端，核对已保存配置。缺失出口、循环依赖或不兼容配置会导致 HTTP 422；不支持的节点可能被跳过，并在日志中说明。修正并保存后重新检查。

配置检查不等于连接测试。导入 sing-box 后，还需在实际设备检查启动日志、权限、证书和节点连通性。

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

两种方式都保留本地 Wrangler 配置、安装运行依赖并部署；安装脚本会在保留已有订阅周期的同时补齐每 5 分钟待办续建任务。`npm run update -- --no-deploy` 仅跳过最后的部署，仍会更新代码、依赖和本地配置，不是只读检查。更新后请核对[定时任务](#缓存与运行边界)。

侧栏“退出登录”下方显示当前版本，检测到新版本时显示绿色“有更新”。版本更新检查默认关闭，可在“系统设置”启用。启用后定时任务每天最多检查一次 GitHub Releases；已绑定 Telegram 时会提醒新版本，同一版本不会重复提醒。

### 从 1.4.0 升级到 2.0.0

1. 保留原 `wrangler.jsonc`、KV namespace、`ADMIN_TOKEN_HASH` 和 `CONFIG_ENCRYPTION_KEY`，按上文更新程序。不要重新生成加密密钥。
2. 刷新后台，检查迁移草稿并确认。1.4.0 的版本 1 配置迁移为版本 3 文档；KV schema 为 12。
3. Surge、Clash 设置和共享节点保留，各端分别管理策略组与规则来源。**从版本 1 配置升级时，sing-box 使用该端自有的 DNS、TUN、出口接口检测、Proxy 策略组和 FINAL 规则默认值，Tailscale 连接留空，不读取其他端设置。**
4. 使用 sing-box 前，核对入站、DNS、策略组和分流规则，并执行订阅检查。已经保存的 2.0 版本 3 sing-box 配置不会因程序更新被清空；历史跨端迁移诊断自动清理。
5. 在“配置链接”复制通用订阅地址并更新客户端。基础路径和读取 token 未变化时，原 `/sync/<read_token>/` 地址可继续使用；旧分客户端路径或带 Tag 的地址需替换。Stash 和 Shadowrocket 不再提供输出。

仅查看草稿不会写入迁移结果。确认后，系统写入并读回校验新快照，再经过至少 5 分钟宽限期清理旧数据。迁移期间旧配置发生变化时，需要刷新并重新检查草稿。

已有开发版版本 2 文档会自动拆分为版本 3；这条路径保留已有 sing-box 设置，不按 1.4.0 首次迁移处理。

<details>
<summary>使用命令行检查与迁移</summary>

通过安全环境变量提供 `SUBPILOT_ADMIN_TOKEN`。第一条命令仅检查迁移状态；第二条命令确认并写入迁移后的配置：

```bash
npm run migrate -- --url "https://your-worker.example"
npm run migrate -- --url "https://your-worker.example" --apply
```

将示例域名替换为实际值，也可通过 `SUBPILOT_BASE_URL` 提供 URL。脚本不导出配置文件，旧 `--backup` 参数和 `SUBPILOT_BACKUP_PATH` 环境变量已移除。迁移完成后，请检查各客户端设置并保存。

</details>

## 缓存与运行边界

启用的上游订阅定时写入加密缓存，配置生成优先使用缓存；上游失败时尽量沿用已有内容。概览页显示缓存覆盖、更新时间和各项状态，并提供手动刷新。刷新可以部分成功；达到执行截止时间后不再启动新获取或编译任务，失败项单独报告。

未启用 Actions 时，sing-box 配置和托管规则文件下载只读取与当前配置及编译版本匹配的完整 JSON 规则缓存。首次生成、规则变更或升级导致 JSON 缓存失效时，服务端及时返回 HTTP `503` 和 `Retry-After`，并在后台分批生成规则；请按提示稍后再次更新配置。“订阅检查”也会触发准备并显示当前状态，全部必需 JSON 缓存就绪后即返回完整配置。启用 Actions 编译时优先使用已确认的远程产物，未就绪时由 Worker 接管；远程产物确认后更新订阅即可切换。

保存影响规则输出的配置后，系统立即记录 KV 待办并启动后台更新；达到单次执行预算时，未完成项由每 5 分钟定时任务继续处理。关闭管理页或不再更新客户端不会停止待办推进。每 5 分钟任务只处理待办，不会每 5 分钟重新抓取所有上游；无需新增存储绑定或密钥。

每日规则任务检查上游正文的内容摘要（hash），在来源内容、相关配置或编译版本变化、ASN 数据到期，以及缓存缺失时重新编译。正文未变时保留已有来源正文；其他编译输入仍匹配且完整产物可用时跳过重编译。旧版本产物没有来源摘要时，下一次规则检查会补建一次，以建立后续变化判断的依据。批量检查逐源处理，避免同时保留所有来源全文。

以下为 Worker 本地编译的缓存行为；Actions 的重试、日志与远程产物保留方式见上文。

后台生成失败的规则会短暂退避后重试，其他规则可继续准备；已识别的来源格式或配置引用错误会在后续订阅检查中显示，并返回 HTTP `422`。如果只是 ASN 数据过期，且配置与编译版本仍匹配，可继续下载已有完整产物，同时在后台更新 ASN 数据。后台 ASN 查询未完成且没有可用旧前缀时，不发布缺少规则的新产物。后台任务有执行预算，大批规则可能需要多轮待办续建才能全部完成。

规则来源按 URL 共用一份完整加密缓存；订阅源按 URL 与实际 User-Agent 共用一份。成功获取的新内容覆盖原内容，不保存来源历史。编译产物在新版本完整写入后清理旧版本，仅保留最新成功版本；边缘缓存按固定地址覆盖，并校验版本。

删除规则集、来源或修改下载地址并保存后，后台清理失去生效引用的来源缓存、元数据和编译产物；仍被其他规则或客户端引用的缓存保留。未被任何规则条目引用的来源配置同时移除。历史缓存会在保存或刷新时自动清理，无需 KV 数据结构迁移或额外部署步骤。边缘节点中的旧缓存副本受缓存有效期约束，下载入口读取到已保存的新配置后，不再使用已删除规则的副本。

本地 `wrangler.jsonc` 的三个定时任务示例：

```json
{
  "triggers": {
    "crons": ["0 */12 * * *", "0 16 * * *", "*/5 * * * *"]
  }
}
```

`0 16 * * *` 固定用于每日规则来源变化检测，`*/5 * * * *` 固定用于每 5 分钟待办续建，其余 cron 用于上游订阅。第一项可按需调整并保留原订阅周期。已有部署需在私有 `wrangler.jsonc` 的 `triggers.crons` 中加入 `*/5 * * * *` 后重新部署；`npm run setup` 和 `npm run update` 会自动补齐缺少的这一项。缺少它时，立即后台更新仍会启动，但剩余待办不能依靠每 5 分钟任务自动继续。无需新增绑定或 Secrets。Cron 使用 UTC，新增或修改后需要部署并等待 Cloudflare 传播生效。[Cron 配置说明](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

后台和 Telegram 按设置的显示时区展示时间，KV 系统时间使用 UTC。

### 主要上限

| 范围 | 上限 |
| --- | --- |
| 配置请求体 | 6 MiB（容纳三端独立资源） |
| 资源数量 | 共享 20 个订阅源、500 个手工节点；每端最多 100 个策略组，规则来源不设独立数量上限 |
| 规则输出 | 每客户端 40 个 |
| 单个远程输入 | 订阅源 4 MiB；Worker 或 Actions 下载的文本规则源 16 MiB，为加密存储及内存预留空间；客户端直连来源不受此限制 |
| 单个订阅源 | 2,500 个节点、5,000 条 Host |
| 所有订阅源合计 | 10,000 个节点、20,000 条 Host；最终输出最多 15,000 个节点 |
| 单个规则输出编译 | 不设输入字符总量或规则条数上限；仍受运行资源与产物存储容量约束 |
| 最终客户端配置 | 最多 8 × 1024 × 1024 个字符 |
| GeoIP 地区补全 | 每次生成最多查询 100 个不同 IP |
| 规则覆盖诊断 | 最多展开 24 个外部源，合计 8 × 1024 × 1024 个字符和 5,000 条规则 |

### KV 一致性与写入失败

保存后，配置更新可能需要短暂时间才能在所有请求中生效。请通过管理页面修改配置，不要直接修改或删除 KV 中的运行数据。

若保存返回 **HTTP 429**，保留页面草稿、稍后重试，避免同时在多个管理页反复保存。

## Telegram 与 GeoIP

### Telegram 通知

填写并保存 Bot Token 即启用通知，清空并保存则关闭。Bot 用于刷新失败、新版本提醒和状态查询。

1. 在 Telegram 的 `@BotFather` 使用 `/newbot` 创建 bot，妥善保存返回的 Bot Token。
2. 在 SubPilot“系统设置”的 Telegram 区块填写 Bot Token（Chat ID 和绑定操作也集中在此），**先保存配置**，再点击“生成绑定码”。
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

更换会话时先“解除绑定”，再生成新绑定码。解绑立即生效，并保留页面中其他未保存的配置草稿。替换 Bot Token 会清除原 Chat ID 并重新注册 webhook，需要再次绑定；token 泄露时先在 BotFather 撤销。关闭通知会删除旧 webhook。

参考：[Telegram Bot 创建](https://core.telegram.org/bots/tutorial)、[Bot Features](https://core.telegram.org/bots/features)、[Bots FAQ](https://core.telegram.org/bots/faq)、[命令菜单 API](https://core.telegram.org/bots/api#setmycommands)。

### GeoIP MMDB

在“系统设置”的 GeoIP MMDB 区域可查看当前文件名、数据库类型、数据库版本（构建时间）、上传时间和文件大小；已有数据库也会读取其内置版本信息，缺少构建时间时会明确标注。数据库信息与上传操作并排显示，窄屏自动改为单列。点击“上传数据库”标题右侧的问号可查看完整客户端文件路径提示，点击外部或按 Esc 收起。

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
| 配置快照、上游与规则缓存、Worker 编译的 JSON/文本规则、Bot Token、可恢复读取 token | 加密的 Workers KV 数据 |
| 选配 GitHub Actions 生成的规则产物 | 公开 GitHub 仓库的固定 `rules` 分支，按客户端分目录 |
| Actions 工作流触发 token、共享密钥 | 独立加密 KV 记录；共享密钥另存于 Actions Secret |
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
