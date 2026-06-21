# SubPilot Worker

SubPilot Worker 是运行在 Cloudflare Workers 上的订阅配置生成器。它从上游订阅源读取节点，按管理页中的规则生成 Surge 和 Clash/mihomo 配置，并用 Workers KV 保存运行配置。

本仓库可以公开使用：仓库不会保存生产 KV namespace、生产域名、管理员 token、订阅源 URL、链式出口密码、MITM CA 或其他个人运行数据。自己的生产部署信息应保存在本地未跟踪的 `wrangler.jsonc`、Cloudflare Worker Secrets 和 Workers KV 中。

## 功能概览

- 管理上游订阅源地址、启用状态、抓取 User-Agent 和节点名前缀。
- 生成 Surge 和 Clash/mihomo 两种目标配置。
- 支持客户端 User-Agent 自动选择输出目标。
- 用独立字段维护 Surge 和 Clash 功能配置，不需要编辑整段模板。
- 管理策略组、策略规则、规则集、DNS、TUN、MITM 和 URL Rewrite。
- 提供 Surge / Clash 规则结构化编辑器，同时保留文本模式用于直接编辑生成内容。
- Clash rule-providers 与 rules 联动：未引用的规则集会自动补入 rules，删除规则集时会同步移除对应规则。
- 配置共享链式出口节点，并自动生成对应链式代理节点。
- 轮换订阅读取 token，生成带稳定文件名的订阅链接。
- 缓存上游订阅，记录最近订阅拉取时间、User-Agent 和 IP 地理位置。

## 安全模型

- 管理员登录 token 不写入代码，不以明文保存到 KV。
- 生产登录校验只读取 Worker Secret `ADMIN_TOKEN_HASH`，值是管理员 token 的 SHA-256 hex。
- `CONFIG_ENCRYPTION_KEY` 必须作为 Worker Secret 保存，用于加密订阅源 URL 和可恢复订阅读取 token。
- 订阅源 URL 保存到 KV 前会加密；读取配置时才在 Worker 内解密。
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
git clone https://github.com/<your-name>/subpilot-worker.git
cd subpilot-worker
npm install
npm run setup
```

`npm run setup` 会执行这些操作：

1. 从 `wrangler.example.jsonc` 生成本地 `wrangler.jsonc`。
2. 创建或写入 `SUBPILOT_CONFIG` KV namespace。
3. 部署 Worker 和静态管理页。
4. 要求输入管理员 token，并生成配置加密密钥。
5. 通过 `wrangler secret bulk` 写入 `ADMIN_TOKEN_HASH` 和 `CONFIG_ENCRYPTION_KEY`。

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
npm run setup
```

交互式运行时，脚本会提示输入管理员 token。非交互式运行且需要写入 Secrets 时，必须通过 `SUBPILOT_ADMIN_TOKEN` 提供管理员 token。默认情况下脚本会自动生成配置加密密钥，并通过临时文件写入 Worker Secrets。

## 手动部署

如果不使用初始化脚本，可以按下面的步骤手动部署。

1. 安装依赖：

```bash
npm install
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

`ADMIN_TOKEN_HASH` 填第 4 步得到的 SHA-256 hex；`CONFIG_ENCRYPTION_KEY` 填一个足够长的随机字符串。

6. 部署：

```bash
wrangler deploy
```

如需自定义域名，在 Cloudflare 中把域名接到 Worker，或在本地 `wrangler.jsonc` 中添加自己的 `routes` 配置。不要把包含真实域名和 namespace ID 的 `wrangler.jsonc` 提交到公开仓库。

## 使用方式

打开 Wrangler 部署输出中的 Workers.dev 地址或自己的自定义域名，使用管理员 token 登录。

首次配置建议顺序：

1. 在 `Configuration` 中设置 `Managed Base URL`，通常是 `https://<your-domain>/sync`。
2. 在 `Sources` 中添加上游订阅源；URL 会加密保存到 KV。
3. 在 `Policy Groups` 中调整策略组。
4. 在 `Surge`、`Clash` 页面中调整各目标的规则、DNS、TUN 等配置。
5. 如需链式代理，在 `Configuration` 中填写共享链式出口节点。
6. 在 `Tokens` 页面轮换订阅读取 token，并复制订阅链接。

订阅链接基于管理页配置的 `Managed Base URL` 生成，通常是 `https://<your-domain>/sync`。`Managed Base URL` 必须包含非根路径，不能使用 `/api`、`/app.js`、`/styles.css`、`/mitm-ca.js`、`/login.html` 或 `/index.html` 等系统已占用路径。拼接链接时会去掉 `Managed Base URL` 末尾多余的 `/`。

```text
https://<your-domain>/sync/<read_token>/
```

`https://<your-domain>/sync/<read_token>/` 会根据客户端 User-Agent 自动选择 Surge 或 Clash/mihomo。订阅接口不接受额外查询参数，也不接受 `/surge`、`/clash` 等显式目标路径；如果 User-Agent 无法识别，服务端会返回 401，不下发配置。客户端文件名通过响应头 `Content-Disposition` 提供。

服务端只接受当前 `Managed Base URL` path 下的订阅入口；如果把 `Managed Base URL` 改成 `https://<your-domain>/sywwqnc`，则 `/sywwqnc/<read_token>/` 生效，默认 `/sync/<read_token>/` 不再作为订阅入口。

## 更新与迁移

公开源码后，建议通过 GitHub Releases 或 `main` 分支更新。更新前先阅读 release notes；如果版本说明里标注需要迁移，按本节步骤执行。

常规更新流程：

```bash
git pull
npm install
wrangler deploy
npm run migrate -- --url https://<your-domain> --token <admin-token>
```

`wrangler deploy` 先部署新 Worker 代码，`npm run migrate` 再调用已部署后台的管理员迁移接口，把 KV 补到当前 schema。也可以用环境变量代替命令参数：

```bash
SUBPILOT_BASE_URL=https://<your-domain> \
SUBPILOT_ADMIN_TOKEN=<admin-token> \
npm run migrate
```

迁移器使用 KV 中的 `config:schemaVersion` 判断当前数据版本。即使跳过多个版本后再更新，也可以直接运行当前版本的迁移命令；迁移会按顺序补齐缺失步骤。重复运行迁移命令不会破坏已有数据。

更新时不要删除本地 `wrangler.jsonc`，也不要重新运行会轮换 Secrets 的命令。尤其不要无意替换 `CONFIG_ENCRYPTION_KEY`，否则旧 KV 中已加密的订阅源 URL、Telegram Bot Token 和订阅读取 token 将无法解密。只有在你明确要重置整个部署或轮换密钥时，才使用 `npm run setup -- --force-secrets`。

后台状态页会显示当前应用版本、KV schema 版本和最新版本检查结果。设置页的“版本更新检查”默认关闭；启用后，定时任务每天最多访问一次 GitHub Releases。若已绑定 Telegram，有新版本时会发送一次提醒。同一个最新版本不会重复提醒。手动点击状态页“检查更新”会立即访问 GitHub Releases。

## 规则与策略组

策略组是 Surge 和 Clash 输出共同使用的出口选择基础。内置 `Proxy` 策略组名称固定，不可删除；其他策略组可在 `Policy Groups` 页面新增、改名、禁用或调整顺序。规则中的策略出口必须引用已配置的策略组，或引用目标客户端支持的内置策略，例如 `DIRECT`、`REJECT`、`REJECT-DROP`。

Surge 和 Clash 的规则页默认使用结构化编辑器。结构化模式会按页面中的行顺序生成配置文本，并在下方显示生成结果；切换到文本模式后，可以直接编辑对应配置内容。保存前系统会校验规则类型、规则集引用、策略出口和兜底规则位置，避免写入明显无效的规则配置。

Surge 规则集和单条规则使用不同语法。规则集行通常形如：

```text
RULE-SET,https://example.com/rules.list,Proxy
DOMAIN-SET,https://example.com/domain-set.list,DIRECT
```

单条规则通常形如：

```text
DOMAIN-SUFFIX,example.com,Proxy
IP-CIDR,192.168.0.0/16,DIRECT,no-resolve
FINAL,Proxy
```

Surge 的 `SUBNET`、`AND`、`OR`、`NOT` 等复合规则类型可以在结构化编辑器中选择，也可以在文本模式中直接编辑。Ponte 设备名会生成 `DEVICE:<name>` 策略出口，保存后可在规则中选择。

Clash / mihomo 的 rule-providers 是规则集来源；rules 中的 `RULE-SET` 行是实际匹配入口。SubPilot 会把 rule-providers 中尚未出现在 rules 里的规则集自动补入 rules，并默认使用 `Proxy` 作为策略出口。删除 rule-providers 中的某个规则集时，对应的 `RULE-SET` 规则会一并移除；如果在 rules 中删除某个规则集规则，系统会提示确认，并同步删除同名 rule-provider。后续再次添加 rule-provider 时，rules 会重新自动补齐。

## Telegram 通知配置

SubPilot 只支持两种通知状态：关闭通知，或启用 Telegram 通知。Telegram 通知用于上游订阅刷新失败提醒，也提供一组 bot 命令用于查看状态和手动刷新。

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
refresh - 强制重新拉取上游订阅源
help - 查看命令列表
```

不要把 `/bind` 放进公开命令菜单。`/bind <code>` 是 SubPilot 后台临时生成的一次性绑定命令，有效期 10 分钟，只应在绑定时复制使用。

### 在 SubPilot 后台绑定

1. 确认 Worker 已部署，并且管理页可以通过 Workers.dev 域名或自定义域名访问。
2. 登录 SubPilot 管理页，进入 `Configuration`。
3. 在 `Telegram 配置` 中粘贴 Bot Token。填写 Bot Token 即视为启用 Telegram 通知；清空 Bot Token 即关闭通知。
4. 点击 `生成绑定命令`。SubPilot 会自动调用 Telegram API 注册 webhook，webhook 地址为当前 Worker 域名下的 `/api/telegram/webhook`。
5. 把后台显示的 `/bind <code>` 复制到目标 Telegram 会话中发送给 bot。目标会话可以是个人私聊、私有群组或已正确授权的频道。
6. bot 回复 `SubPilot Telegram 通知已绑定成功。` 后，SubPilot 会记录该会话的 Chat ID。后台按钮会变为 `解除绑定`。

绑定成功后，只有这个已绑定 Chat ID 可以触发 SubPilot bot 命令。来自其他会话的命令会被忽略。

### 可用 bot 命令

```text
/status  查看订阅源数量、缓存数量和最近 Surge/Clash 拉取时间
/sources 查看订阅源启用状态
/recent  查看最近配置拉取记录、目标类型、客户端位置和 User-Agent
/refresh 强制重新拉取上游订阅源，并在完成后回复刷新结果
/help    查看命令列表
```

在群组里，如果有多个 bot 或命令没有响应，可以使用带用户名的形式，例如 `/status@my_subpilot_bot`。SubPilot 也支持这种 Telegram 标准命令格式。

### 轮换 Bot Token 或更换接收会话

- 如果 Bot Token 泄露，在 `@BotFather` 中使用 `/revoke` 重新生成 token，然后回到 SubPilot 后台替换 Bot Token 并重新生成绑定命令。
- 如果要更换接收会话，先在 SubPilot 后台点击 `解除绑定`，再生成新的绑定命令并发送到新的目标会话。
- 修改 Bot Token 后，SubPilot 会重新注册 Telegram webhook；清空 Bot Token 关闭通知时会删除旧 webhook。

### 常见问题

- 生成绑定命令失败：检查 Bot Token 是否完整、是否复制了多余空格，以及 Worker 是否能访问 Telegram API。
- 发送 `/bind <code>` 后没有成功回复：确认命令在 10 分钟有效期内、发送到了正确 bot 所在会话，并且 bot 没有被群权限禁止发言。
- 群组命令无响应：尝试发送 `/status@你的_bot_用户名`；如果你调整过 BotFather privacy mode，移除并重新添加 bot 到群组。
- 绑定到频道失败：优先改用私聊或私有群组；如果必须使用频道，确认 bot 是频道管理员，并具有发送消息所需权限。

参考 Telegram 官方文档：Bot 创建见 [From BotFather to Hello World](https://core.telegram.org/bots/tutorial)，privacy mode 和群组消息规则见 [Bot Features](https://core.telegram.org/bots/features) 与 [Bots FAQ](https://core.telegram.org/bots/faq)，命令菜单可通过 BotFather 或 Bot API 的 [setMyCommands](https://core.telegram.org/bots/api#setmycommands) 配置。

## GeoIP MMDB

后台“配置”页提供 GeoIP MMDB 上传入口，用户可上传 MaxMind DB Country 格式的 `.mmdb` 文件。上传后，IP 节点地区识别会优先使用该库。

如果本机已经安装相关客户端，可直接选择它们已下载的 MMDB 文件：

- Surge macOS：`~/Library/Application Support/com.nssurge.surge-mac/GeoLite2-Country.mmdb`
- Clash Verge Windows：`%APPDATA%\io.github.clash-verge-rev.clash-verge-rev\Country.mmdb`
- Clash Verge macOS：`~/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/Country.mmdb`

如果没有上传 MMDB，SubPilot 只能使用已有的单 IP 记录识别地区；没有记录的 IP 节点无法自动判断国家/地区。这会导致以下能力不完整：

- IP 地址节点不能稳定按实际地区自动重命名。
- 依赖地区标签的策略组筛选可能漏掉 IP 地址节点。
- 链式节点按地区匹配时，未知地区的 IP 节点不会被纳入对应地区过滤结果。
- 最近获取记录中的客户端 IP 位置可能显示为未知。

上传或重新上传 MMDB 后，系统会清理旧的地区识别缓存，使新的地区识别结果尽快生效。

## KV 存储结构

SubPilot 使用拆分 KV 键保存配置和运行数据：

```text
config:settings:<field>              通用设置
config:groups:index                  策略组名称顺序
config:groups:disabled               禁用的策略组
config:groups:<name>                 单个策略组定义
config:sources:index                 订阅源 ID 顺序
config:sources:<id>                  单个订阅源，加密保存 URL
config:chain:exitProxy               共享链式出口节点
config:surge:<field>                 Surge 功能配置
config:clash:<field>                 Clash 功能配置
config:updatedAt                     配置更新时间
config:schemaVersion                 KV schema 版本，迁移器按它判断待执行步骤
auth:read_token                      可恢复订阅读取 token，加密保存
auth:read_token_hash                 订阅读取 token 的 SHA-256 hash
cache:source:<hash>                  上游订阅缓存
cache:sourceMeta:<hash>              上游缓存倒计时元数据
cache:sourceMeta:index               上游缓存元数据索引
cache:geoip:location:<ip>            客户端 IP 位置缓存
stats:config:lastFetched:<target>    每个目标最近拉取时间
stats:config:recentFetches           最近订阅拉取 UA 记录
stats:updateCheck:latest             最近一次 GitHub Releases 更新检查缓存
stats:updateCheck:notifiedVersion    已通过 Telegram 提醒过的最新版本
```
