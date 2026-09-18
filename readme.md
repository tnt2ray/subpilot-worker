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

模板包含上游订阅与编译规则集两个定时任务，详见[缓存与运行边界](#缓存与运行边界)。自定义域名可在 Cloudflare 中连接到 Worker，或写入本地 `wrangler.jsonc` 的 `routes`。不要提交个人部署配置。

</details>

## 首次配置

打开部署地址，用管理员 token 登录。旧版本用户应先完成[配置迁移](#更新与迁移)。

1. 在“系统设置”确认订阅基础 URL（通常为 `https://<your-domain>/sync`）和显示时区。
2. 在“订阅源”添加上游地址、名称和抓取 User-Agent；在“代理节点”维护手动节点或链式出口。编辑节点时，仅启用“作为链式出口”后显示“前置节点筛选”；关闭后隐藏，保留已填写的筛选条件。每行一个关键词，节点名称或标签包含任一关键词即选中，不区分大小写、不支持正则。仅为命中的非出口节点生成链式节点，未命中节点不参与；留空不生成。链路为“本机 → 命中节点 → 当前出口节点 → 目标网站”。
3. 在“策略组”选择客户端，再设置该端的成员、筛选条件和参数。
4. 在“客户端配置”选择 Surge、clash 或 sing-box，编辑当前端的网络、DNS、路由与高级功能。
5. 在当前客户端“分流规则”页直接填写规则集来源地址（每行一个），并下拉选择策略组。新地址自动关联到该端规则来源；规则集和单条规则在同一列表中上下排序。Surge 直接选择 RULE-SET / DOMAIN-SET，Clash 设置 behavior 和 interval，sing-box 直接选择来源格式。
6. 保存配置，在“配置链接”检查订阅并复制通用订阅地址。

订阅源、代理节点和策略组均可点击名称或行内“编辑”按钮修改已有内容；弹窗中点击“应用更改”后，再点击页面底部“保存配置”持久保存。窄屏下操作列保持可见，其余详情可横向滚动。

页面标题与底部操作栏保持可见，长内容在中间区域独立滚动，避免被操作栏遮挡。

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

全新安装和从 1.4.0 迁移时，sing-box 从 Clash 初始化策略组、DNS 和分流规则，自动建立 TUN 入站并检测出口接口；代理出站由共享节点和策略组生成。Tailscale 从 Surge 已启用的连接迁移，没有连接时留空。初始化后各端独立保存，已有 sing-box 配置不会被覆盖。

DNS 保留解析器地址、Fake IP 和域名排除项，多个解析器按顺序尝试；备用 DNS 的 IP-CIDR 过滤会迁移，GeoIP 国家过滤需手动调整。无法等价转换的组类型、DNS 或 Tailscale 参数会在迁移诊断中说明，请确认后使用。

配置内容带行号和语法高亮，点击编辑图标打开编辑弹窗。应用更改后仍需点击页面底部“保存配置”。

### 节点与策略组

“代理节点”接受 Surge 节点语法、Clash YAML/JSON 和 sing-box 原生 JSON。sing-box JSON 可为单个节点、节点数组或包含 `outbounds` 的对象，只导入代理节点，不导入文件中的 DNS、路由或策略组。

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
| Tailscale | 首次初始化时从 Surge 迁移到 sing-box，之后各自维护 |
| WireGuard / OpenConnect / OpenVPN | sing-box 专用的独立客户端连接页 |
| 高级设置 | Surge 的 URL Rewrite、Map Local 和脚本；sing-box 的日志与 HTTP 客户端；Clash 无此页 |
| MITM 证书 | 仅 Surge：生成、导入或导出 CA，设置 MITM 主机名 |

sing-box 适配基线为 **1.14.0**。可选参数通过表单添加，移除可选字段恢复内核默认行为。订阅无法代替客户端设置系统权限、Always On 或应用选择；请在实际设备完成这些操作。

SubPilot 不再提供或生成 sing-box TUN 的 `stack` 选项；加载或导入已有配置时会自动清理该字段，由客户端采用自身默认栈。1.14.0 包含 gVisor 的构建默认使用 `mixed`，否则使用 `system`，因此旧客户端的实际行为可能与原先显式指定的栈不同。

### Tailscale

节点名称可用于当前端策略组和分流规则。Surge 启用节点需要认证密钥；sing-box 可留空，通过客户端日志中的登录地址授权，多个实例应使用各自的状态目录。认证密钥在编辑时以密码框显示。

SubPilot 只生成配置，不代替客户端登录 Tailscale。参见 [sing-box Tailscale 文档](https://sing-box.sagernet.org/configuration/endpoint/tailscale/)。

### 分流规则

sing-box DNS 页区分三种用途：“DNS 服务器列表”维护可选服务器；“DNS 查询兜底服务器”用于未命中规则集 DNS 或高级 DNS 规则的查询，留空使用列表中的第一个服务器；“建立连接时的默认 DNS”用于代理节点地址和直连时尚未解析的目标域名，连接单独指定解析器时优先使用其设置，可能绕过 DNS 查询分流规则。

sing-box 的 DNS 页将原生规则放在默认折叠的“高级 DNS 规则”中，标题显示已配置数量。规则集 DNS 在“分流规则”Tab 配置；高级 DNS 规则在其后匹配，折叠不影响已有规则生效。

规则集编辑窗口可指定“DNS 解析服务器”，留空继承全局；列表显示当前设置。本文的 Clash 指 Clash Verge 使用的 Mihomo 内核。Surge / Clash 填写一个 IP、IP:端口、`system` 或加密 DNS URL；sing-box 选择 DNS 页已有服务器。修改后保存配置并更新订阅，无需 KV 数据结构迁移或额外部署步骤。

- Surge 生成 `[Host]` 的 `RULE-SET:` / `DOMAIN-SET:` DNS 映射，要求 Mac 5.10+ / iOS 5.14.3+。已有 Host 映射优先，规则集按本页顺序匹配；代理远端解析不保证使用指定 DNS。指定 DNS 的条目不参与按策略聚合。
- Clash 生成 `dns.nameserver-policy`，要求启用 DNS；`ipcidr` provider 不允许指定 DNS。此设置选择解析服务器，不改变 DNS 连接出口，也不保证代理远端解析行为。
- sing-box 单独生成 `-dns.json` 域名规则集，包含独立 DOMAIN、DOMAIN-SUFFIX、DOMAIN-KEYWORD、DOMAIN-REGEX、DOMAIN-WILDCARD 规则；排除 IP、进程和逻辑组合。绑定按本页顺序优先于 DNS 页原生规则，无可用域名时提示。删除或重命名所引用的 DNS 服务器后，需更新绑定才能保存。


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

sing-box 的 `.srs` 地址在自动识别模式下直接输出为独立的 `remote` / `binary` 规则集，由客户端下载和更新；无 `.srs` 后缀的二进制地址可明确选择 SRS 格式。同一条目混合 SRS 与文本来源时，每份 SRS 独立输出，只有文本参与合并编译，出口沿用该条目的策略。Worker 不下载、解析或缓存 SRS。指定 DNS 解析服务器时，SRS 直接用于原生 DNS 规则匹配，请选择适合 DNS 匹配的规则集；文本来源仍只提取独立域名规则。

启用 sing-box 统一规则后，原生路由与规则集表单仍可编辑；原生规则继续先于统一规则匹配。Clash 从原生规则转换时，清理历史共享或 Surge 规则计划，仅保留本次原生规则及其提供者；转换失败时保留原配置。

合并或转换后的规则文件由系统命名，Surge、Clash、sing-box 分别使用 `.list`、`.yaml`、`.json` 扩展名。三端可使用相同名称。

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

两种方式都保留本地 Wrangler 配置、安装运行依赖并部署。`npm run update -- --no-deploy` 仅跳过最后的部署，仍会更新代码、依赖和本地配置，不是只读检查。更新后请核对[定时任务](#缓存与运行边界)。

侧栏“退出登录”下方显示当前版本，检测到新版本时显示绿色“有更新”。版本更新检查默认关闭，可在“系统设置”启用。启用后定时任务每天最多检查一次 GitHub Releases；已绑定 Telegram 时会提醒新版本，同一版本不会重复提醒。

### 从 1.4.0 升级到 2.0.0

1. 保留原 `wrangler.jsonc`、KV namespace、`ADMIN_TOKEN_HASH` 和 `CONFIG_ENCRYPTION_KEY`，按上文更新程序。不要重新生成加密密钥。
2. 刷新后台，检查迁移草稿并确认。1.4.0 的版本 1 配置迁移为版本 3 文档；KV schema 为 12。
3. Surge、Clash 设置和共享节点保留，各端分别管理策略组与规则来源。**sing-box 从 Clash 初始化策略组、DNS 和分流规则，自动建立 TUN 入站和出口接口检测；Tailscale 从 Surge 已启用的连接迁移，没有则留空。**
4. 使用 sing-box 前，核对迁移诊断、入站、DNS、策略组和分流规则。已经保存的 2.0 版本 3 sing-box 配置不会因程序更新被清空。
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

规则来源按 URL 共用一份完整加密缓存；订阅源按 URL 与实际 User-Agent 共用一份。刷新成功覆盖原内容，不保存来源历史。批量刷新仅记录状态与内容摘要，编译时逐源读取，避免同时保留所有来源全文。编译产物在新版本完整写入后清理旧版本，仅保留最新成功版本；边缘缓存按固定地址覆盖，并校验版本。

删除规则集、来源或修改下载地址并保存后，后台清理失去生效引用的来源缓存、元数据和编译产物；仍被其他规则或客户端引用的缓存保留。未被任何规则条目引用的来源配置同时移除。历史缓存会在保存或刷新时自动清理，无需 KV 数据结构迁移或额外部署步骤。边缘节点中的旧缓存副本受缓存有效期约束，下载入口读取到已保存的新配置后，不再使用已删除规则的副本。

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
| 单个远程输入 | 订阅源 4 MiB；Worker 编译的文本规则源 16 MiB，为加密存储及内存预留空间；客户端直连来源不受此限制 |
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
