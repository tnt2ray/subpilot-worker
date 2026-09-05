# SubPilot Worker

语言：中文 | [英文版](./README.en.md)

SubPilot Worker 是运行在 Cloudflare Workers 上的订阅配置生成器，使用 Workers KV 保存加密配置。2.0 提供 Surge、mihomo 与 sing-box 三个独立客户端配置，共享订阅源、代理节点、策略组和规则来源。

本仓库可以公开使用：仓库不会保存生产 KV namespace、生产域名、管理员 token、订阅源 URL、链式出口密码、MITM CA 或其他个人运行数据。自己的生产部署信息应保存在本地未跟踪的 `wrangler.jsonc`、Cloudflare Worker Secrets 和 Workers KV 中。

## 许可证

SubPilot Worker 项目代码以 [GNU Affero General Public License v3.0 or later](./LICENSE) 授权。通过网络运行修改版服务时，也需要按 AGPL 要求向用户提供对应源码。

本项目依赖和内置的第三方代码保留其原始许可证。用户自行配置或上传的上游订阅、规则集、GeoIP MMDB、客户端自带资源和其它外部数据不随本项目授权；使用前请自行确认来源和许可。

## 功能概览

- 三端网络、DNS、路由规则和高级功能独立保存，切换客户端不会覆盖另一端设置。
- 共用订阅源、手动代理节点、链式出口、策略组和规则来源；每个源可填写自己的抓取 User-Agent。
- sing-box 以 **1.14.0** 为适配基线，生成完整 JSON；支持从 JSON `outbounds`、节点数组或单个节点对象读取代理节点。输入中的 DNS、路由和策略组不会作为整份配置导入。
- 根据目标输出协议和策略组，跳过不支持的节点或普通附加功能并报告原因。缺失策略、循环依赖、关键规则不可转换、被引用的空组会阻止当前端下载。
- 每端独立选择原生规则或共享来源编排；来源正文缓存共享，编译产物按输出端隔离。
- 灰白与蓝色管理界面，提供网络与 TUN、DNS、路由规则、高级设置分栏，结构化编辑、原生文本/JSON、草稿预览与适配详情。
- 三端使用独立订阅链接；支持读取 token 轮换、缓存刷新、GeoIP 重命名和 Telegram 通知。
- 旧配置先导出、确认后迁移；Surge 与 mihomo 保留配置，sing-box 从 Surge 一次性转换。Stash 与 Shadowrocket 不再提供输出。

架构和消融取舍见 [架构说明](./docs/architecture.md)，界面规范见 [UI 设计](./docs/ui-design.md)。

## 安全模型

- 管理员登录 token 不写入代码，不以明文保存到 KV。
- 生产登录校验只读取 Worker Secret `ADMIN_TOKEN_HASH`，值是管理员 token 的 SHA-256 hex。
- `CONFIG_ENCRYPTION_KEY` 必须作为 Worker Secret 保存，用于加密完整配置快照、订阅源与规则源缓存正文、编译规则正文和可恢复订阅读取 token。
- 旧配置在管理员导出并确认前保持原样；新快照写入并读回校验后才开始延迟清理旧配置。缓存仍按需加密迁移。不要轮换或删除原有 `CONFIG_ENCRYPTION_KEY`。
- 管理员会话是 HttpOnly 签名 Cookie，不创建 `session:*` KV 键。
- `wrangler.jsonc` 被 `.gitignore` 排除，用于保存个人 Worker 名称、KV namespace ID 和自定义域名。

## 快速部署

前置条件：

- 已有 Cloudflare 账号。
- 本机已安装 Node.js 和 npm。
- 已全局安装 Wrangler，并完成登录：

```bash
npm install -g wrangler
wrangler login
```

克隆并部署：

```bash
git clone https://github.com/tnt2ray/subpilot-worker.git
cd subpilot-worker
npm install --omit=dev
npm run setup
```

也可以在 GitHub Releases 下载 `subpilot-worker-vX.Y.Z.tar.gz` 发布包，解压后进入目录运行：

```bash
npm install --omit=dev
npm run setup
```

`npm run setup` 会执行这些操作：

1. 从 `wrangler.example.jsonc` 生成本地 `wrangler.jsonc`。
2. 创建或写入 `SUBPILOT_CONFIG` KV namespace。
3. 询问上游订阅自动获取间隔（1～24 小时），默认每 12 小时一次。
4. 要求输入至少 24 个字符的管理员 token，并生成配置加密密钥。
5. 通过 `wrangler deploy --secrets-file` 同时部署 Worker、静态管理页和两个必需 Secrets；即使 Wrangler 失败，也会删除临时密钥文件。

脚本会把你输入的管理员 token 转成 SHA-256 hash 写入 `ADMIN_TOKEN_HASH`。请把管理员 token 保存在密码管理器中；仓库、KV 和 Cloudflare Secret 中都不会保存它的明文。

如果当前目录已经存在本地 `wrangler.jsonc`，`npm run setup` 会复用它并默认跳过 Secret 写入，避免误轮换生产 `CONFIG_ENCRYPTION_KEY` 后导致旧 KV 加密数据无法解密。只有在你明确要替换管理员 token 和配置加密密钥时，才使用：

```bash
npm run setup -- --force-secrets
```

可选环境变量：

```bash
SUBPILOT_WORKER_NAME=my-subpilot \
SUBPILOT_KV_NAMESPACE_ID=<existing-kv-namespace-id> \
SUBPILOT_ADMIN_TOKEN=<your-admin-token> \
SUBPILOT_LOGIN_RATE_LIMIT_NAMESPACE_ID=<positive-integer> \
SUBPILOT_SOURCE_REFRESH_HOURS=12 \
npm run setup
```

交互式运行时，脚本会提示输入管理员 token。非交互式运行且需要写入 Secrets 时，必须通过 `SUBPILOT_ADMIN_TOKEN` 提供至少 24 个字符的管理员 token。默认情况下脚本会自动生成配置加密密钥，并通过临时文件写入 Worker Secrets。

初始化脚本会配置登录限流：同一 Cloudflare 位置内，每个客户端 IP 默认每分钟最多尝试 10 次。Rate Limiter 的 namespace ID 默认由 Worker 名称稳定派生；同一账号内需要手动避让其它 Rate Limiter namespace 时，可用 `SUBPILOT_LOGIN_RATE_LIMIT_NAMESPACE_ID` 指定 1 到 4294967295 的正整数。

## 手动部署

如果不使用初始化脚本，可以按下面的步骤手动部署。

1. 安装依赖：

```bash
npm install --omit=dev
```

2. 创建本地 Wrangler 配置：

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

3. 创建 KV namespace：

```bash
wrangler kv namespace create SUBPILOT_CONFIG
```

把输出中的 namespace `id` 写入 `wrangler.jsonc` 的 `kv_namespaces[0].id`。

4. 生成管理员 token hash：

```bash
read -r -s -p 'Admin token: ' ADMIN_TOKEN
printf '\n'
printf '%s' "$ADMIN_TOKEN" | shasum -a 256 | awk '{print $1}'
```

5. 写入 Worker Secrets：

```bash
wrangler secret put ADMIN_TOKEN_HASH
wrangler secret put CONFIG_ENCRYPTION_KEY
```

管理员 token 至少应有 24 个字符。`ADMIN_TOKEN_HASH` 填第 4 步得到的 SHA-256 hex；`CONFIG_ENCRYPTION_KEY` 填一个足够长的随机字符串。

6. 部署：

```bash
wrangler deploy
```

默认 `wrangler.example.jsonc` 会配置每 12 小时获取上游订阅，并每天刷新一次编译规则集。需要调整上游订阅间隔时，可以修改 `wrangler.jsonc` 中对应的 `triggers.crons` 项后重新部署。保留 `0 16 * * *` 作为编译规则集每日任务，其余 cron 项用于刷新上游订阅。

如需自定义域名，在 Cloudflare 中把域名接到 Worker，或在本地 `wrangler.jsonc` 中添加自己的 `routes` 配置。不要把包含真实域名和 namespace ID 的 `wrangler.jsonc` 提交到公开仓库。

## 使用方式

打开部署地址，使用管理员 token 登录。

1. 在“系统设置”确认 Managed Base URL（通常为 `https://<your-domain>/sync`）和显示时区。
2. 在“订阅源”添加上游地址、名称和抓取 User-Agent；在“代理节点”添加自维护节点或链式出口。
3. 在“策略组”设置成员、筛选条件和适用客户端。
4. 在“客户端配置”选择 Surge、mihomo 或 sing-box，独立配置网络、DNS、路由与高级功能。
5. 使用共享来源编排时，先在“规则来源”添加来源，再到当前客户端的路由页选择来源、策略与顺序。
6. 预览当前草稿，在“适配详情”处理阻断项，保存后从“配置链接”复制订阅地址。

编辑中的草稿只在当前页面内存中保留；切换页面或客户端可继续编辑，刷新或关闭页面会丢失未保存内容。保存整个配置文档，但三端字段独立；预览可直接检查尚未保存的草稿。复制和下载按钮仅在当前预览没有阻断项时启用。

订阅地址：

```text
https://<your-domain>/sync/<read_token>/surge/
https://<your-domain>/sync/<read_token>/surge/stable/
https://<your-domain>/sync/<read_token>/surge/tf/
https://<your-domain>/sync/<read_token>/clash/
https://<your-domain>/sync/<read_token>/sing-box/
```

Surge、mihomo 与 sing-box 分别使用自己的独立地址，输出格式完全由路径决定。通用地址 `/sync/<read_token>/` 及旧文件名入口已移除，不再按 User-Agent 自动识别；使用旧地址的客户端需要重新导入对应链接。响应文件名仍分别为 `SubPilot.conf`、`SubPilot.yaml`、`SubPilot.json`，它们仅用于文件下载命名。订阅与规则文件不接受查询参数；Stash、Shadowrocket 不再提供输出。目标配置存在阻断项时返回 422，可登录后台查看原因。

Managed Base URL 必须包含非根路径，不能占用 `/api`、`/vendor` 或管理页资源路径。只有当前配置的基础路径有效；修改它后，旧订阅地址也需更新。

Surge 使用路径末尾的 `stable` / `tf` Tag 选择兼容档位，UA 不参与版本或渠道判断。`/surge/` 默认使用 `stable`。未知 Tag 拒绝访问。管理页提供两个链接及对应预览选项；Surge 下载配置内的自动更新地址保留所选 Tag。mihomo 统一使用 `/clash/`，客户端应保存此订阅地址用于后续更新；旧 `/mihomo/` 地址不再提供输出。预览 API 必须显式指定 `target`。

截至 2026-09-05，`stable` 基线为 iOS **5.22.0** / macOS **6.9.0**；`tf` 采用已核实的 iOS build **3823** / macOS build **12250** 能力快照。Tag 不探测设备实际版本，旧客户端需先升级。目前已接入的新功能都已进入正式版，因此两个档位可能输出相同功能。后续 TF 专属功能只有在明确支持的档位才会输出。版本依据、能力表和维护方式见 [Surge 兼容档位](docs/surge-compatibility.md)。

## 上游订阅自动获取

SubPilot 会把启用的上游订阅源定时拉取到 Workers KV 加密缓存中。这样客户端请求订阅配置时，可以优先使用已经缓存的上游内容；如果某个上游临时失败，系统会尽量沿用旧缓存，减少客户端拉取配置时直接失败的概率。

初次运行 `npm run setup` 时，脚本会询问自动获取间隔，默认每 12 小时一次。这个间隔写入本地 `wrangler.jsonc` 的 `triggers.crons`，由 Cloudflare Workers Cron Triggers 执行。非交互安装可以通过环境变量指定：

```bash
SUBPILOT_SOURCE_REFRESH_HOURS=6 npm run setup
```

取值范围是 1 到 24 小时。已经部署后如需修改间隔，编辑 `wrangler.jsonc` 中的 `triggers.crons` 并重新运行 `wrangler deploy`。

后台状态页会显示上游缓存与编译规则集缓存的覆盖情况、最近更新时间和各缓存项状态，并可分别强制刷新。后台和 Telegram 通知中的时间会按 “系统设置”中的显示时区转换，格式为 `yyyy-mm-dd hh:mm:ss`；KV 中保存的系统时间仍是 UTC。Telegram bot 的 `/status` 会显示缓存概览，`/recent` 会显示最近 5 条配置拉取记录，`/refresh` 会强制获取上游订阅源，并在后台异步刷新编译规则集，完成后分别发送结果。启用 Telegram 通知后，定时获取出现失败时会发送提醒。

上游与编译规则集刷新都有执行截止时间。一次刷新可以部分成功：已成功的源和规则输出会保留，失败项会在状态、预览或通知中单独报告；到达截止时间后不会再启动新的远程获取或编译任务，并尽量继续使用已有缓存。

## 运行边界与 KV 一致性

为适配 Cloudflare Workers 的请求、内存和子请求预算，保存与生成时采用以下主要上限：

| 范围 | 上限 |
| --- | --- |
| 配置实体 | 20 个订阅源、40 个规则输出；规则来源不设独立数量上限 |
| 单个远程输入 | 订阅源 4 MiB；规则源 2 MiB |
| 节点与 Host | 所有订阅源合计 10,000 个节点、20,000 条 Host；最终输出 15,000 个节点 |
| 单个规则输出编译 | 最多 8 MiB 规则源内容（按字符数计）和 50,000 条规则 |
| 最终客户端配置 | 最多 8 MiB（按字符数计） |
| GeoIP 在线补全 | 每次生成最多查询 100 个不同 IP |
| 规则覆盖诊断 | 最多展开 24 个外部源，合计 8 MiB 内容和 5,000 条规则 |

完整配置快照、读取 token 记录和编译规则产物均采用版本化、追加式 KV 数据：先写完整的新版本，再让读取端选择最新的有效版本；不完整或损坏的新版本会回退到上一份有效数据。旧版本、失败写入留下的孤儿产物和迁移遗留键会延迟、分批清理，以兼容 Workers KV 的 eventual consistency；因此短时间内看到旧键仍存在属于正常现象，不应由外部脚本按固定键名直接修改或删除运行数据。涉及 Telegram webhook 的配置会在远端操作成功后才提交新快照；若提交确认失败，系统会保留旧配置并尝试恢复旧 webhook。管理页仍会串行提交保存请求。

如果 Workers KV 拒绝写入或触发写入限流，API 会返回 HTTP 429。管理页会串行提交保存操作；遇到 429 时，请保留页面草稿，稍后再次保存，避免同时打开多个管理页面反复写入。

## 更新

有新版本时，建议先阅读 GitHub Releases 中的版本说明。常规更新只需要在项目目录运行：

```bash
npm run update
```

如果当前目录是 Git 克隆，命令会拉取当前分支最新代码；如果当前目录来自 GitHub Releases 的 `subpilot-worker-vX.Y.Z.tar.gz` 发布包，命令会优先下载最新 Release 中同名发布包并覆盖程序文件。两种方式都会保留本地 `wrangler.jsonc`，只安装运行部署所需依赖，然后部署到对应 Worker。

升级时会保留本地 `wrangler.jsonc`，请确认 `triggers.crons` 同时包含上游订阅和编译规则集两个任务：

```json
"triggers": {
  "crons": ["0 */12 * * *", "0 16 * * *"]
}
```

第一项可以继续使用你原有的上游订阅刷新周期；第二项固定用于每天刷新编译规则集。缺少第二项时，编译规则集仍可在状态页手动刷新或在使用时生成，但不会执行每日后台刷新。修改后运行 `wrangler deploy` 使计划任务生效。全新安装会由 `npm run setup` 自动写入这两个任务。

**升级到 2.0 需要确认配置迁移。** 首次打开后台会显示迁移提示：

1. 点击“下载旧配置”，妥善保存含旧客户端配置的完整 JSON 备份。
2. 查看 Surge → sing-box 转换诊断，确认后迁移到文档版本 2、KV schema 12。
3. 原 Surge/mihomo 配置和共享资源继续保留；规则计划各复制一份。sing-box 转换后不再跟随 Surge 设置变化。
4. 无法等价转换的 DNS、路由等关键设置会保留待处理标记。迁移可完成，但必须手动修复或明确确认放弃该行为后才能下载 sing-box 配置。
5. 新加密快照写入并读回验证后，旧 Stash/Shadowrocket 数据进入至少 5 分钟宽限期，随后分批清理。新文档提交后不会再回退读取旧版快照；回退程序版本需使用导出的旧配置备份。

迁移前浏览配置、导出和预览不会删除旧配置。重复确认可重试；旧配置变更后需重新导出备份。全新安装直接使用版本 2。

也可使用 `npm run migrate -- --url <deployment-url> --backup <private-backup-path>` 先导出，再使用同一命令加 `--apply` 确认；管理员 token 通过 `SUBPILOT_ADMIN_TOKEN` 环境变量提供。脚本不会覆盖已有备份文件，第二次执行请指定新的备份路径。

更新时不要删除本地 `wrangler.jsonc`，也不要重新运行会轮换 Secrets 的命令。尤其不要无意替换 `CONFIG_ENCRYPTION_KEY`，否则 KV 中已加密的配置快照、订阅与规则源缓存、编译规则、Telegram Bot Token 和订阅读取 token 将无法解密。只有在你明确要重置整个部署或轮换密钥时，才使用 `npm run setup -- --force-secrets`。

后台状态页会显示当前应用版本和最新版本检查结果。设置页的“版本更新检查”默认关闭；启用后，定时任务每天最多访问一次 GitHub Releases。若已绑定 Telegram，有新版本时会发送一次提醒。同一个最新版本不会重复提醒。手动点击状态页“检查更新”会立即访问 GitHub Releases。

## 规则与策略组

共享资源只保存一份；三个客户端的网络、DNS、规则选择、规则顺序、默认策略与高级设置互不覆盖。

| 功能 | Surge | mihomo | sing-box 1.14.0 |
| --- | --- | --- | --- |
| 节点与策略组 | 按协议和组类型适配 | 按协议和组类型适配 | `selector` / `urltest` |
| 手工路由 | Surge 规则文本 | mihomo rules + rule-providers | 原生 JSON route |
| 编译规则文件 | `.list` | `.yaml` | JSON source `.json` |
| DNS 与 TUN | Surge 独立字段 | mihomo 独立字段 | 原生 DNS 与 inbounds |
| URL Rewrite / Map Local / MITM / 脚本 | 保留 Surge 功能 | 不输出 | 不输出 |
| Ponte / Surge Tailscale | Surge 专属 | 不输出 | 不自动转换 |

策略组可选择适用端。`select` 和 `url-test` 在三端具有对应实现；`fallback`、`load-balance` 适用于 Surge/mihomo，`subnet` 和 `smart` 仅适用于 Surge。类型不会静默替换。组中可使用 `{all}`、筛选条件或显式策略成员；Proxy 必须保留。没有可用节点且被引用的组、策略或链式依赖缺失以及循环引用会阻断输出，不会自动切换到直连。改名、禁用或删除资源后，原引用保留以便诊断定位。sing-box 必须显式指定默认出站，或以无条件的路由/拒绝规则兜底。

Surge 的组级 `url` 在当前客户端中无效，应使用 Surge 的代理测速 URL；预览会提示该差异。[Surge 官方说明](https://manual.nssurge.com/policy-groups/url-test.html)

每端路由可选择原生规则或共享来源编排。编译模式独立保存来源选择、策略、顺序、内联规则及单条规则；规则源正文共用加密缓存，同名产物按客户端隔离。可选择按策略合并规则集，合并项放在该策略首次出现的位置；这可能改变跨策略规则的匹配优先级，请在预览前确认。启用的普通规则按顺序执行，兜底规则必须在最后；Surge/mihomo 编译计划需要一个 FINAL/MATCH，sing-box 也可使用显式 `route.final`。

规则源中不能等价表达的匹配条件会阻断对应端输出，不会静默删除或扩大匹配范围。例如 sing-box 不直接使用旧 GEOIP 数据规则、Surge `IN-PORT` 或 `no-resolve` 规则；需在该客户端中改写原生路由或关联可用的规则集。未知字段会由固定版本的官方 sing-box JSON Schema 拦截。远程规则集使用 1.14 的 `http_client`，JSON source 格式为版本 4。[sing-box 规则集](https://sing-box.sagernet.org/configuration/rule-set/)

mihomo 原生 rule-providers 只提供规则数据，必须显式添加 rules 中的 RULE-SET 引用及策略；不会自动插入 Proxy 规则或删除现有引用。Surge/mihomo 原生规则预览保留规则覆盖诊断。

sing-box 节点输入保留原生字段。跨格式转换无法保留 TLS、传输或认证参数时会跳过该节点并说明原因，避免生成连接参数不完整的节点。Snell 6 不会降级成 mihomo 的 Snell 5；sing-box 自动转换支持 Snell 4/6，其他版本需核对原生节点参数。[mihomo Snell 支持范围](https://wiki.metacubex.one/en/config/proxies/snell/)

Surge 的 Tailscale、Ponte、Hosts、DNS 跟随出站、Map Local、MITM 与脚本在其高级/DNS设置中维护。简单 IP Hosts 可转换给 sing-box；带别名、通配或指定解析器的 Hosts 需手动处理。sing-box 高级设置可编辑完整客户端 JSON，包括额外顶层设置；`outbounds` 由共享节点和策略组生成。不同平台的权限、文件路径、证书与实际网络连通性仍需在目标设备上确认。

## Telegram 通知配置

SubPilot 只支持两种通知状态：关闭通知，或启用 Telegram 通知。Telegram 通知用于上游订阅与编译规则集刷新失败提醒，也提供一组 bot 命令用于查看状态和手动刷新。

### 申请 Telegram Bot

1. 在 Telegram 中打开官方 `@BotFather`。
2. 发送 `/newbot`，按提示输入 bot 显示名称。
3. 输入 bot 用户名，用户名必须以 `bot` 结尾，例如 `my_subpilot_bot`。
4. BotFather 会返回一段 Bot Token，格式类似 `123456:ABC-...`。复制并妥善保存这段 token。

不要把 Bot Token 写入仓库、README、issue 或公开聊天记录。SubPilot 后台保存 token 时会写入 Workers KV 的加密配置键，生产环境依赖 `CONFIG_ENCRYPTION_KEY` 解密。

### Bot 权限和隐私模式

推荐把 SubPilot bot 绑定到个人私聊或一个只有管理员成员的私有群组。

- 个人私聊：不需要额外权限。直接打开 bot 会话即可绑定。
- 私有群组：把 bot 加入群组即可；SubPilot 只依赖命令消息和发送消息，一般不需要设置为群管理员。
- 频道：如果要绑定频道，bot 需要能在频道中接收 channel post 并发送消息，通常需要添加为频道管理员。更推荐使用私聊或私有群组，权限边界更清楚。

BotFather 的 `/setprivacy` 建议保持默认启用。SubPilot 只需要接收 `/bind`、`/status`、`/sources`、`/recent`、`/refresh`、`/help` 这些命令；隐私模式启用时，bot 在群组里仍可收到明确发给它的命令。如果你关闭过 privacy mode，Telegram 可能要求把 bot 从已有群组移除后重新加入才会完全生效。

### 设置命令菜单

命令菜单不是必须项，但建议配置，方便在 Telegram 客户端中直接选择命令。

在 `@BotFather` 中发送 `/setcommands`，选择你的 SubPilot bot，然后粘贴：

```text
status - 查看订阅与缓存概览
sources - 查看订阅源启用状态
recent - 查看最近配置拉取记录
refresh - 强制刷新订阅源并异步刷新编译规则集
help - 查看命令列表
```

不要把 `/bind` 放进公开命令菜单。`/bind <code>` 是 SubPilot 后台临时生成的一次性绑定命令，有效期 10 分钟，只应在绑定时复制使用。

### 在 SubPilot 后台绑定

1. 确认 Worker 已部署，并且管理页可以通过 Workers.dev 域名或自定义域名访问。
2. 登录 SubPilot 管理页，进入“系统设置”。
3. 在 `Telegram 配置` 中粘贴 Bot Token。填写 Bot Token 即视为启用 Telegram 通知；清空 Bot Token 即关闭通知。
4. 点击 `生成绑定命令`。SubPilot 会自动调用 Telegram API 注册 webhook，webhook 地址为当前 Worker 域名下的 `/api/telegram/webhook`。
5. 把后台显示的 `/bind <code>` 复制到目标 Telegram 会话中发送给 bot。目标会话可以是个人私聊、私有群组或已正确授权的频道。
6. bot 回复 `SubPilot Telegram 通知已绑定成功。` 后，SubPilot 会记录该会话的 Chat ID。后台按钮会变为 `解除绑定`。

绑定成功后，只有这个已绑定 Chat ID 可以触发 SubPilot bot 命令。来自其他会话的命令会被忽略。

### 可用 bot 命令

```text
/status  查看订阅源数量、缓存数量和最近 Surge/clash/sing-box 拉取时间
/sources 查看订阅源启用状态
/recent  查看最近配置拉取记录、目标类型、客户端位置和 User-Agent
/refresh 强制重新拉取上游订阅源，并异步刷新编译规则集；两项任务完成后分别回复结果
/help    查看命令列表
```

在群组里，如果有多个 bot 或命令没有响应，可以使用带用户名的形式，例如 `/status@my_subpilot_bot`。SubPilot 也支持这种 Telegram 标准命令格式。

### 轮换 Bot Token 或更换接收会话

- 如果 Bot Token 泄露，在 `@BotFather` 中使用 `/revoke` 重新生成 token，然后回到 SubPilot 后台替换 Bot Token 并重新生成绑定命令。
- 如果要更换接收会话，先在 SubPilot 后台点击 `解除绑定`，再生成新的绑定命令并发送到新的目标会话。
- 修改 Bot Token 后，SubPilot 会清除原 Chat ID 绑定并重新注册 Telegram webhook，需要生成新的绑定命令完成绑定；清空 Bot Token 关闭通知时会删除旧 webhook。

### 常见问题

- 生成绑定命令失败：检查 Bot Token 是否完整、是否复制了多余空格，以及 Worker 是否能访问 Telegram API。
- 发送 `/bind <code>` 后没有成功回复：确认命令在 10 分钟有效期内、发送到了正确 bot 所在会话，并且 bot 没有被群权限禁止发言。
- 群组命令无响应：尝试发送 `/status@你的_bot_用户名`；如果你调整过 BotFather privacy mode，移除并重新添加 bot 到群组。
- 绑定到频道失败：优先改用私聊或私有群组；如果必须使用频道，确认 bot 是频道管理员，并具有发送消息所需权限。

参考 Telegram 官方文档：Bot 创建见 [From BotFather to Hello World](https://core.telegram.org/bots/tutorial)，privacy mode 和群组消息规则见 [Bot Features](https://core.telegram.org/bots/features) 与 [Bots FAQ](https://core.telegram.org/bots/faq)，命令菜单可通过 BotFather 或 Bot API 的 [setMyCommands](https://core.telegram.org/bots/api#setmycommands) 配置。

## GeoIP MMDB

后台“配置”页提供 GeoIP MMDB 上传入口，用户可上传最大 25 MiB 的 MaxMind DB Country `.mmdb` 文件。管理页会直接以原始二进制上传，使用方式不变，无需手动做 Base64 或其它转换。上传后，IP 节点地区识别会优先使用该库。

如果本机已经安装相关客户端，下面这些位置可能存在它们下载的 MMDB 文件。不同 MMDB 数据源有各自的许可协议，直接复制、上传或复用这些文件可能违反对应许可；使用前请自行确认文件来源和授权范围。

- Surge macOS：`~/Library/Application Support/com.nssurge.surge-mac/GeoLite2-Country.mmdb`
- Clash Verge Windows：`%APPDATA%\io.github.clash-verge-rev.clash-verge-rev\Country.mmdb`
- Clash Verge macOS：`~/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/Country.mmdb`

如果没有上传 MMDB，SubPilot 只能使用已有的单 IP 记录识别地区；没有记录的 IP 节点无法自动判断国家/地区。这会导致以下能力不完整：

- IP 地址节点不能稳定按实际地区自动重命名。
- 依赖地区标签的策略组筛选可能漏掉 IP 地址节点。
- 链式节点按地区匹配时，未知地区的 IP 节点不会被纳入对应地区过滤结果。
- 最近获取记录中的客户端 IP 位置可能显示为未知。

上传或重新上传 MMDB 后，系统会清理旧的地区识别缓存，使新的地区识别结果尽快生效。

## 配置保留与本地验证

版本 2 配置文档包含共享资源和 `clients.surge`、`clients.mihomo`、`clients.singbox`，不再写入 Stash/Shadowrocket 输出设置。API 保存和预览使用该文档；`target=mihomo`（兼容 `clash`）选择 mihomo。旧备份只能通过迁移流程转换；不要向 KV 直接写入客户端 JSON。

`npm run verify` 执行 Worker 类型生成、TypeScript 检查和公开文件扫描；`npm audit` 检查依赖漏洞。本地使用全局 Wrangler 执行 `wrangler deploy --dry-run --config wrangler.example.jsonc --outdir /tmp/subpilot-dry-run` 可检查构建而不部署。项目不允许 AI 创建或修改测试代码。

下载 sing-box 输出后可用 `sing-box check -c SubPilot.json` 检查；编译规则源可用 `sing-box rule-set compile rules.json -o rules.srs` 验证。Schema/内核检查不代替手机和桌面客户端的导入、VPN 权限与实际连通验证。
