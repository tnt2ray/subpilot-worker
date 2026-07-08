# SubPilot Worker

Language: [中文](./readme.md) | English

SubPilot Worker is a subscription configuration generator that runs on Cloudflare Workers. It reads nodes from upstream subscription sources, generates Surge, Clash/mihomo, and Stash configuration from the admin settings, serves compatible Clash YAML to Shadowrocket clients, and stores runtime configuration in Workers KV.

This repository is safe to use publicly: it does not store production KV namespace IDs, production domains, admin tokens, subscription source URLs, chain exit passwords, MITM CAs, or other personal runtime data. Keep your own production deployment details in the local untracked `wrangler.jsonc`, Cloudflare Worker Secrets, and Workers KV.

## License

SubPilot Worker is licensed under the [GNU Affero General Public License v3.0 or later](./LICENSE). If you run a modified version of the service over a network, you must also provide the corresponding source code as required by the AGPL.

Third-party dependencies and bundled code keep their original licenses. Upstream subscriptions, rule sets, GeoIP MMDB files, client-provided resources, and other external data configured or uploaded by users are not licensed by this project. Check their source and license before use.

## Features

- Manage upstream subscription URLs, enabled state, fetch User-Agent, and node name prefixes; each source can use a Surge, Clash, Stash, or Shadowrocket User-Agent.
- Generate Surge, Clash/mihomo, and Stash target configurations; Shadowrocket clients receive Clash YAML after User-Agent detection.
- Select the output target automatically from the client User-Agent.
- Maintain Surge, Clash, and Stash feature settings through structured fields instead of editing full templates.
- Manage policy groups, policy rules, rule sets, DNS, TUN, MITM, and URL Rewrite settings.
- Provide structured rule editors for Surge, Clash, and Stash, while keeping a text mode for direct edits.
- Show admin preview warnings for rules shadowed by earlier rules, including Surge rule sets and Clash / Stash rule-provider content.
- Link Clash rule-providers with rules: unused rule sets are automatically added to rules, and deleting a rule set removes the matching rule.
- Manage manually maintained proxy nodes, mark multiple chain exits, and automatically generate the matching chain proxy nodes.
- Rotate the subscription read token and generate subscription links with stable filenames.
- Cache upstream subscriptions and record recent subscription fetch time, User-Agent, and IP location.
- Configure the display time zone for the admin UI and Telegram notifications while internal system timestamps remain stored as UTC.

## Security Model

- The admin token is not written into code and is not stored in KV as plaintext.
- Production login validation only reads the Worker Secret `ADMIN_TOKEN_HASH`, which is the SHA-256 hex value of the admin token.
- `CONFIG_ENCRYPTION_KEY` must be stored as a Worker Secret and is used to encrypt subscription source URLs and the recoverable subscription read token.
- Subscription source URLs are encrypted before they are stored in KV; they are decrypted only inside the Worker when configuration is read.
- Admin sessions are HttpOnly signed cookies. The app does not create `session:*` KV keys.
- Stash CAs should be generated and stored locally in the client. SubPilot does not store or serve a Stash CA private key, `ca-p12`, or `ca-passphrase`.
- Stash output has not yet been fully tested on real clients. Treat it as a test feature in release builds, and review rules, MITM, scripts, and rule-providers before importing.
- `wrangler.jsonc` is excluded by `.gitignore` and should hold your personal Worker name, KV namespace ID, and custom domain settings.

## Quick Deployment

Prerequisites:

- A Cloudflare account.
- Node.js and npm installed locally.
- Wrangler installed globally and logged in:

```bash
npm install -g wrangler
wrangler login
```

Clone and deploy:

```bash
git clone https://github.com/tnt2ray/subpilot-worker.git
cd subpilot-worker
npm install --omit=dev
npm run setup
```

You can also download `subpilot-worker-vX.Y.Z.tar.gz` from GitHub Releases, extract it, enter the directory, and run:

```bash
npm install --omit=dev
npm run setup
```

`npm run setup` will:

1. Generate a local `wrangler.jsonc` from `wrangler.example.jsonc`.
2. Create or write the `SUBPILOT_CONFIG` KV namespace.
3. Deploy the Worker and static admin UI.
4. Ask for the admin token and generate the configuration encryption key.
5. Ask for the upstream subscription auto-fetch interval, defaulting to once every 12 hours.
6. Write `ADMIN_TOKEN_HASH` and `CONFIG_ENCRYPTION_KEY` through `wrangler secret bulk`.

The script converts the admin token you enter into a SHA-256 hash and writes that hash to `ADMIN_TOKEN_HASH`. Store the admin token in a password manager; its plaintext is not stored in the repository, KV, or Cloudflare Secrets.

If a local `wrangler.jsonc` already exists, `npm run setup` reuses it and skips Secret writes by default. This avoids accidentally rotating `CONFIG_ENCRYPTION_KEY` in production and making old encrypted KV data unreadable. Use the following only when you intentionally want to replace the admin token and configuration encryption key:

```bash
npm run setup -- --force-secrets
```

Optional environment variables:

```bash
SUBPILOT_WORKER_NAME=my-subpilot \
SUBPILOT_KV_NAMESPACE_ID=<existing-kv-namespace-id> \
SUBPILOT_ADMIN_TOKEN=<your-admin-token> \
SUBPILOT_SOURCE_REFRESH_HOURS=12 \
npm run setup
```

In interactive mode, the script prompts for the admin token. In non-interactive mode, if Secrets need to be written, provide the admin token through `SUBPILOT_ADMIN_TOKEN`. By default, the script generates the configuration encryption key automatically and writes Worker Secrets through a temporary file.

## Manual Deployment

If you do not use the setup script, deploy manually with these steps.

1. Install dependencies:

```bash
npm install --omit=dev
```

2. Create local Wrangler configuration:

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

3. Create the KV namespace:

```bash
wrangler kv namespace create SUBPILOT_CONFIG
```

Copy the namespace `id` from the output into `kv_namespaces[0].id` in `wrangler.jsonc`.

4. Generate the admin token hash:

```bash
read -r -s -p 'Admin token: ' ADMIN_TOKEN
printf '\n'
printf '%s' "$ADMIN_TOKEN" | shasum -a 256 | awk '{print $1}'
```

5. Write Worker Secrets:

```bash
wrangler secret put ADMIN_TOKEN_HASH
wrangler secret put CONFIG_ENCRYPTION_KEY
```

Use the SHA-256 hex from step 4 for `ADMIN_TOKEN_HASH`; use a sufficiently long random string for `CONFIG_ENCRYPTION_KEY`.

6. Deploy:

```bash
wrangler deploy
```

The default `wrangler.example.jsonc` runs a scheduled task every 12 hours to fetch upstream subscriptions automatically. To adjust the interval, edit `triggers.crons` in `wrangler.jsonc` and deploy again.

For a custom domain, connect the domain to the Worker in Cloudflare or add your own `routes` configuration in local `wrangler.jsonc`. Do not commit a `wrangler.jsonc` that contains real domains or namespace IDs to the public repository.

## Usage

Open the Workers.dev URL from Wrangler deployment output, or your custom domain, and log in with the admin token.

Recommended first-time configuration order:

1. Set `Managed Base URL` in `Configuration`, usually `https://<your-domain>/sync`.
2. Add upstream subscription sources in `Sources`; URLs are encrypted in KV, and the fetch User-Agent can be set to Surge, Clash, Stash, or Shadowrocket according to upstream requirements.
3. Adjust policy groups in `Policy Groups`.
4. Configure target-specific settings in `Surge`, `Clash`, and `Stash`.
5. If you need chain proxies, add manually maintained proxy nodes in `Proxy Nodes`, check the nodes that can be used as chain exits, and configure the chain filter on each exit node.
6. Adjust the display time zone in `Configuration` if needed. The default is `Asia/Shanghai`, and it only affects admin and notification display.
7. Rotate the subscription read token in `Tokens` and copy the subscription link.

Subscription links are based on the `Managed Base URL` configured in the admin UI, usually `https://<your-domain>/sync`. `Managed Base URL` must include a non-root path and cannot use system-reserved paths such as `/api`, `/app.js`, `/styles.css`, `/mitm-ca.js`, `/login.html`, or `/index.html`. Trailing `/` characters are removed when links are built.

```text
https://<your-domain>/sync/<read_token>/
```

`https://<your-domain>/sync/<read_token>/` automatically selects Surge, Clash/mihomo, Stash, or Shadowrocket from the client User-Agent. Shadowrocket uses this common entry point to receive full Clash YAML; there is no dedicated filename path for Shadowrocket. The subscription endpoint does not accept extra query parameters and does not accept explicit target paths such as `/surge`, `/clash`, `/stash`, or `/shadowrocket`. If the User-Agent cannot be recognized, the server returns 401 and does not serve configuration. The client filename is provided through the `Content-Disposition` response header.

The server only accepts subscription entry points under the current `Managed Base URL` path. If you change `Managed Base URL` to `https://<your-domain>/sywwqnc`, then `/sywwqnc/<read_token>/` works and the default `/sync/<read_token>/` no longer works as a subscription entry point.

## Upstream Subscription Auto-Fetch

SubPilot periodically fetches enabled upstream subscription sources into Workers KV cache. Client subscription requests can then prefer cached upstream content. If an upstream source temporarily fails, the system tries to keep using the old cache to reduce client-side fetch failures.

When `npm run setup` runs for the first time, it asks for the auto-fetch interval, defaulting to once every 12 hours. The interval is written to `triggers.crons` in local `wrangler.jsonc` and is executed by Cloudflare Workers Cron Triggers. For non-interactive installation, use:

```bash
SUBPILOT_SOURCE_REFRESH_HOURS=6 npm run setup
```

The value must be between 1 and 24 hours. After deployment, edit `triggers.crons` in `wrangler.jsonc` and run `wrangler deploy` again to change the interval.

The admin status page shows upstream cache count, cache coverage, last update time, and cache state for each source. Admin and Telegram notification times are converted to the display time zone configured in `Configuration`, using the `yyyy-mm-dd hh:mm:ss` format; system timestamps in KV remain UTC. The `Force Fetch` button fetches upstream sources immediately. The Telegram bot command `/status` shows cache overview, `/recent` shows the 5 most recent configuration fetch records, and `/refresh` triggers a remote force fetch. When Telegram notifications are enabled, scheduled fetch failures send alerts.

## Updates

When a new version is available, read the release notes on GitHub Releases first. A normal update only requires this command in the project directory:

```bash
npm run update
```

If the current directory is a Git clone, the command pulls the latest code for the current branch. If the current directory came from a GitHub Releases `subpilot-worker-vX.Y.Z.tar.gz` archive, the command downloads the latest release asset with the same archive name and overlays the program files. Both paths preserve local `wrangler.jsonc`, install only dependencies needed for runtime deployment, and deploy to the configured Worker.

After deployment, SubPilot automatically completes KV data structure updates when the admin UI is opened, a subscription is fetched, or a scheduled task runs. No separate migration command is needed. Even if you skip multiple versions, missing migrations are processed in order.

Do not delete local `wrangler.jsonc` during updates, and do not rerun commands that rotate Secrets unless that is intentional. In particular, do not accidentally replace `CONFIG_ENCRYPTION_KEY`, or old encrypted subscription source URLs, Telegram Bot Tokens, and subscription read tokens in KV will no longer decrypt. Use `npm run setup -- --force-secrets` only when you intentionally reset the whole deployment or rotate keys.

The admin status page shows the current app version and latest-version check result. The `Version update check` setting is disabled by default; when enabled, the scheduled task checks GitHub Releases at most once per day. If Telegram is bound, a new-version notification is sent once. The same latest version is not notified repeatedly. Clicking `Check updates` on the status page checks GitHub Releases immediately.

## Rules and Policy Groups

Policy groups are the shared exit selection foundation for Surge, Clash, and Stash output. The built-in `Proxy` policy group name is fixed and cannot be deleted. Other policy groups can be added, renamed, disabled, or reordered in `Policy Groups`. Rule targets must reference configured policy groups or built-in targets supported by the target client, such as `DIRECT`, `REJECT`, and `REJECT-DROP`.

The Surge, Clash, and Stash rule pages use the structured editor by default. Structured mode generates configuration text from the row order shown on the page and displays the generated result below. After switching to text mode, you can edit the corresponding configuration content directly. Before saving, the system validates rule type, rule-set reference, policy target, and fallback rule position to avoid writing obviously invalid rule configuration.

When the admin preview generates Surge, Clash, or Stash configuration, SubPilot diagnoses coverage according to top-to-bottom rule matching order. If a rule, or part of a rule set, is already covered by an earlier rule, the preview area shows a diagnostic warning. The first layer summarizes which rule section is affected; expanding `View details` shows concrete rules. Diagnostics try to expand Surge `RULE-SET` / `DOMAIN-SET` content and Clash / Stash `rule-providers`. Remote rule set names are simplified to the last filename in warnings for readability.

Surge rule sets and single rules use different syntax. Rule-set lines usually look like:

```text
RULE-SET,https://example.com/rules.list,Proxy
DOMAIN-SET,https://example.com/domain-set.list,DIRECT
```

Single rules usually look like:

```text
DOMAIN-SUFFIX,example.com,Proxy
IP-CIDR,192.168.0.0/16,DIRECT,no-resolve
FINAL,Proxy
```

Surge composite rule types such as `SUBNET`, `AND`, `OR`, and `NOT` can be selected in the structured editor or edited directly in text mode. Ponte device names generate `DEVICE:<name>` policy targets, which can be selected in rules after saving.

Clash / mihomo and Stash `rule-providers` are rule set sources; `RULE-SET` lines in `rules` are the actual match entry points. SubPilot automatically adds rule sets from `rule-providers` that do not yet appear in `rules`, using `Proxy` as the default policy target. Deleting a rule set from `rule-providers` also removes the corresponding `RULE-SET` rule. If you delete a rule-set rule from `rules`, the system asks for confirmation and deletes the same-name rule-provider. Adding the rule-provider again later automatically fills `rules` again.

Shadowrocket can now use the common subscription link to receive Clash YAML configuration, including nodes, policy groups, and rules. Because Shadowrocket uses separate import entries for node subscriptions and configuration, import the same subscription link in both entries if you need the full configuration. SubPilot does not provide a Shadowrocket-specific configuration page or filename path.

## Telegram Notifications

SubPilot supports two notification states: notifications off, or Telegram notifications enabled. Telegram notifications are used for upstream refresh failure alerts and provide bot commands for status checks and manual refresh.

### Create a Telegram Bot

1. Open the official `@BotFather` in Telegram.
2. Send `/newbot` and follow the prompts for the bot display name.
3. Enter a bot username. It must end with `bot`, for example `my_subpilot_bot`.
4. BotFather returns a Bot Token, formatted like `123456:ABC-...`. Copy and store it securely.

Do not put the Bot Token in the repository, README, issues, or public chat history. When SubPilot stores the token from the admin UI, it writes it to an encrypted Workers KV configuration key. Production decryption depends on `CONFIG_ENCRYPTION_KEY`.

### Bot Permissions and Privacy Mode

Bind the SubPilot bot to a private chat with yourself or a private group that only has admin members.

- Personal chat: no extra permission is needed. Open the bot conversation directly before binding.
- Private group: add the bot to the group. SubPilot only needs command messages and the ability to send messages, so administrator permission is usually unnecessary.
- Channel: if you need to bind a channel, the bot must receive channel posts and send messages, which usually requires adding it as a channel administrator. Personal chat or a private group is recommended because the permission boundary is clearer.

BotFather `/setprivacy` should usually remain enabled. SubPilot only needs to receive `/bind`, `/status`, `/sources`, `/recent`, `/refresh`, and `/help`. With privacy mode enabled, the bot can still receive explicit commands addressed to it in groups. If you previously disabled privacy mode, Telegram may require removing and re-adding the bot to existing groups before the setting fully takes effect.

### Set the Command Menu

The command menu is optional, but recommended for easier command selection in Telegram clients.

Send `/setcommands` to `@BotFather`, choose your SubPilot bot, and paste:

```text
status - View subscription and cache overview
sources - View subscription source enabled state
recent - View recent configuration fetch records
refresh - Force refresh upstream subscription sources
help - View command list
```

Do not put `/bind` in the public command menu. `/bind <code>` is a one-time binding command temporarily generated by the SubPilot admin UI. It is valid for 10 minutes and should only be copied during binding.

### Bind in the SubPilot Admin UI

1. Confirm the Worker is deployed and the admin UI can be opened through the Workers.dev domain or your custom domain.
2. Log in to the SubPilot admin UI and open `Configuration`.
3. Paste the Bot Token in `Telegram Configuration`. A non-empty Bot Token enables Telegram notifications; clearing it disables notifications.
4. Click `Generate binding command`. SubPilot automatically registers the Telegram webhook at `/api/telegram/webhook` under the current Worker domain.
5. Copy `/bind <code>` from the admin UI and send it to the bot in the target Telegram conversation. The target can be a personal chat, private group, or correctly authorized channel.
6. After the bot replies `SubPilot Telegram 通知已绑定成功。`, SubPilot records that conversation's Chat ID. The admin button changes to `Unbind`.

After binding succeeds, only the bound Chat ID can trigger SubPilot bot commands. Commands from other conversations are ignored.

### Available Bot Commands

```text
/status  View source count, cache count, and recent Surge/Clash/Stash/Shadowrocket Clash YAML fetch time
/sources View subscription source enabled state
/recent  View recent configuration fetch records, target type, client location, and User-Agent
/refresh Force refresh upstream subscription sources and reply with the result
/help    View command list
```

In a group, if there are multiple bots or commands do not respond, use the username-qualified form, for example `/status@my_subpilot_bot`. SubPilot supports this standard Telegram command format.

### Rotate the Bot Token or Change the Receiving Chat

- If the Bot Token leaks, use `/revoke` in `@BotFather` to regenerate it, then replace the Bot Token in the SubPilot admin UI and generate a new binding command.
- To change the receiving conversation, click `Unbind` in the SubPilot admin UI, then generate a new binding command and send it to the new target conversation.
- After the Bot Token changes, SubPilot registers the Telegram webhook again. When the Bot Token is cleared and notifications are disabled, SubPilot deletes the old webhook.

### Troubleshooting

- Binding command generation fails: check whether the Bot Token is complete, whether extra spaces were copied, and whether the Worker can access the Telegram API.
- No success reply after sending `/bind <code>`: confirm the command is still within its 10-minute validity window, was sent to the correct bot conversation, and the bot is not blocked from speaking by group permissions.
- Group commands do not respond: try sending `/status@your_bot_username`; if you changed BotFather privacy mode, remove and re-add the bot to the group.
- Channel binding fails: prefer a personal chat or private group. If you must use a channel, confirm the bot is a channel administrator and has the required send-message permission.

References: Telegram bot creation is documented in [From BotFather to Hello World](https://core.telegram.org/bots/tutorial). Privacy mode and group message behavior are covered by [Bot Features](https://core.telegram.org/bots/features) and [Bots FAQ](https://core.telegram.org/bots/faq). Command menus can be configured through BotFather or the Bot API [`setMyCommands`](https://core.telegram.org/bots/api#setmycommands).

## GeoIP MMDB

The admin `Configuration` page provides a GeoIP MMDB upload entry. Users can upload a MaxMind DB Country `.mmdb` file. After upload, IP node region detection prefers that database.

If related clients are already installed locally, MMDB files may exist in these locations. Different MMDB data sources have their own license terms; directly copying, uploading, or reusing these files may violate their licenses. Check the file source and allowed usage before use.

- Surge macOS: `~/Library/Application Support/com.nssurge.surge-mac/GeoLite2-Country.mmdb`
- Clash Verge Windows: `%APPDATA%\io.github.clash-verge-rev.clash-verge-rev\Country.mmdb`
- Clash Verge macOS: `~/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/Country.mmdb`

If no MMDB is uploaded, SubPilot can only identify regions from existing single-IP records. Nodes with unknown IP addresses cannot have their country or region detected automatically. This makes the following features incomplete:

- IP-address nodes cannot be reliably renamed by their real region.
- Policy group filters that depend on region labels may miss IP-address nodes.
- When chain nodes are matched by region, IP nodes with unknown regions are not included in the matching region filter result.
- Client IP location in recent fetch records may show as unknown.

After uploading or re-uploading an MMDB file, the system clears old region detection cache so new region results take effect as soon as possible.

## KV Storage Shape

SubPilot stores configuration and runtime data in split KV keys:

```text
config:settings:<field>              General settings
config:groups:index                  Policy group name order
config:groups:disabled               Disabled policy groups
config:groups:<name>                 Single policy group definition
config:sources:index                 Subscription source ID order
config:sources:<id>                  Single subscription source, with encrypted URL
config:proxyNodes:index              Manual proxy node ID order
config:proxyNodes:<id>               Single manual proxy node
config:surge:<field>                 Surge feature configuration
config:clash:<field>                 Clash feature configuration
config:stash:<field>                 Stash feature configuration
config:updatedAt                     Configuration update time
config:schemaVersion                 KV schema version used by the migrator
auth:read_token                      Recoverable subscription read token, encrypted
auth:read_token_hash                 SHA-256 hash of the subscription read token
cache:source:<hash>                  Upstream subscription cache
cache:sourceMeta:<hash>              Upstream cache countdown metadata
cache:sourceMeta:index               Upstream cache metadata index
cache:geoip:location:<ip>            Client IP location cache
stats:config:lastFetched:<target>    Last fetch time per output target
stats:config:recentFetches           Recent subscription fetch User-Agent records
stats:updateCheck:latest             Latest GitHub Releases update-check cache
stats:updateCheck:notifiedVersion    Latest version already notified through Telegram
```
