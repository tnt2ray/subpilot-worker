# SubPilot Worker

Language: [中文](./readme.md) | English

SubPilot Worker is a subscription configuration generator on Cloudflare Workers, with encrypted configuration in Workers KV. Version 2.0 provides independent Surge, mihomo, and sing-box configurations sharing subscription sources, proxy nodes, policy groups, and rule sources.

This repository is safe to use publicly: it does not store production KV namespace IDs, production domains, admin tokens, subscription source URLs, chain exit passwords, MITM CAs, or other personal runtime data. Keep your own production deployment details in the local untracked `wrangler.jsonc`, Cloudflare Worker Secrets, and Workers KV.

## License

SubPilot Worker is licensed under the [GNU Affero General Public License v3.0 or later](./LICENSE). If you run a modified version of the service over a network, you must also provide the corresponding source code as required by the AGPL.

Third-party dependencies and bundled code keep their original licenses. Upstream subscriptions, rule sets, GeoIP MMDB files, client-provided resources, and other external data configured or uploaded by users are not licensed by this project. Check their source and license before use.

## Features

- Independent network, DNS, routing, and advanced settings for all three clients. Switching clients preserves the other clients' settings.
- Shared subscription sources, manual nodes, chain exits, policy groups, and rule sources. Each source can specify its fetch User-Agent.
- Full sing-box JSON output targeting **1.14.0**. Node input accepts JSON `outbounds`, a node array, or a single outbound object. DNS, routes, and groups from input files are not imported as a complete client configuration.
- Target-specific protocol and group support. Unsupported nodes and ordinary extras are skipped with diagnostics. Missing policies, dependency cycles, incompatible critical rules, and referenced empty groups block downloads for that target.
- Native rules or shared-source compilation selected independently per client. Source bodies are cached once; compiled artifacts are isolated by target.
- A gray, white, and blue admin UI with network/TUN, DNS, routing, and advanced tabs, structured editors, native text/JSON, draft previews, and diagnostics.
- Dedicated subscription links for each client, token rotation, cache refresh, GeoIP renaming, and Telegram notifications.
- Export and confirm before migrating old configuration. Surge and mihomo retain their settings; sing-box is initialized once from Surge. Stash and Shadowrocket output is retired.

See [architecture and ablation decisions](./docs/architecture.md) and the [UI design specification](./docs/ui-design.md).

## Security Model

- The admin token is not written into code and is not stored in KV as plaintext.
- Production login validation only reads the Worker Secret `ADMIN_TOKEN_HASH`, which is the SHA-256 hex value of the admin token.
- `CONFIG_ENCRYPTION_KEY` must be stored as a Worker Secret. It encrypts complete configuration snapshots, subscription-source and rule-source cache bodies, compiled rule bodies, and the recoverable subscription read token.
- Old configuration remains intact until an administrator exports it and confirms migration. Cleanup starts only after the new encrypted snapshot is written and read back successfully. Cache encryption still migrates on demand. Preserve the existing `CONFIG_ENCRYPTION_KEY`.
- Admin sessions are HttpOnly signed cookies. The app does not create `session:*` KV keys.
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
3. Ask for the upstream subscription auto-fetch interval (1–24 hours), defaulting to 12 hours.
4. Ask for an admin token of at least 24 characters and generate the configuration encryption key.
5. Deploy the Worker and static admin UI with both required Secrets through `wrangler deploy --secrets-file`. The temporary secrets file is removed even if Wrangler fails.

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
SUBPILOT_LOGIN_RATE_LIMIT_NAMESPACE_ID=<positive-integer> \
SUBPILOT_SOURCE_REFRESH_HOURS=12 \
npm run setup
```

In interactive mode, the script prompts for the admin token. In non-interactive mode, if Secrets need to be written, provide an admin token of at least 24 characters through `SUBPILOT_ADMIN_TOKEN`. By default, the script generates the configuration encryption key automatically and writes Worker Secrets through a temporary file.

The setup script configures login rate limiting: each client IP can make up to 10 attempts per minute within each Cloudflare location by default. The Rate Limiter namespace ID is derived deterministically from the Worker name. To avoid a namespace collision with another Rate Limiter in the same account, set `SUBPILOT_LOGIN_RATE_LIMIT_NAMESPACE_ID` to a positive integer from 1 through 4294967295.

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

Use an admin token of at least 24 characters. Use its SHA-256 hex from step 4 for `ADMIN_TOKEN_HASH`, and use a sufficiently long random string for `CONFIG_ENCRYPTION_KEY`.

6. Deploy:

```bash
wrangler deploy
```

The default `wrangler.example.jsonc` fetches upstream subscriptions every 12 hours and refreshes compiled rule sets once per day. To adjust the upstream interval, edit its entry in `triggers.crons` in `wrangler.jsonc` and deploy again. Keep `0 16 * * *` for the daily compiled rule-set task; other cron entries refresh upstream subscriptions.

For a custom domain, connect the domain to the Worker in Cloudflare or add your own `routes` configuration in local `wrangler.jsonc`. Do not commit a `wrangler.jsonc` that contains real domains or namespace IDs to the public repository.

## Usage

Open the deployment URL and sign in with the admin token.

1. Confirm Managed Base URL (usually `https://<your-domain>/sync`) and the display time zone in **System settings**.
2. Add upstream URLs, names, and fetch User-Agents under **Sources**; add manual nodes or chain exits under **Proxy nodes**.
3. Set policy-group members, filters, and applicable clients under **Policy groups**.
4. Choose Surge, mihomo, or sing-box in **Client configuration**, then edit its network, DNS, routing, and advanced settings.
5. For compiled routing, add sources under **Rule sources** and choose their policies and order in the selected client's routing tab.
6. Preview the draft, resolve blocking diagnostics, save, and copy a subscription URL from **Configuration links**.

Drafts live in the current page's memory. They survive navigation between pages and clients, but reloading or closing the page loses unsaved edits. Save writes the complete document while retaining independent client fields. Preview accepts unsaved drafts. Copy and download are enabled only for a current preview without blockers.

Subscription URLs:

```text
https://<your-domain>/sync/<read_token>/surge/
https://<your-domain>/sync/<read_token>/surge/stable/
https://<your-domain>/sync/<read_token>/surge/tf/
https://<your-domain>/sync/<read_token>/clash/
https://<your-domain>/sync/<read_token>/sing-box/
```

Surge, mihomo, and sing-box each use a dedicated URL; the path alone determines the output format. The generic `/sync/<read_token>/` URL and legacy filename endpoints have been removed, along with User-Agent detection. Clients using an old URL need to import their dedicated link. Response filenames remain `SubPilot.conf`, `SubPilot.yaml`, and `SubPilot.json` for downloaded files only. Subscription and rule URLs reject query parameters. Stash and Shadowrocket output is no longer supported. A blocked target returns 422; sign in to inspect diagnostics.

Managed Base URL must contain a non-root path and cannot occupy `/api`, `/vendor`, or admin asset paths. Only the currently configured base path is active; update subscription URLs after changing it.

Surge selects compatibility using the trailing `stable` / `tf` path tag. User-Agent does not determine its version or channel. `/surge/` defaults to `stable`; unknown tags are rejected. The admin offers both links and matching preview options. Downloaded Surge configurations retain the selected tag in their automatic update URL. mihomo uses `/clash/`; the client should retain this subscription URL for future updates. The old `/mihomo/` path no longer serves output. The preview API requires an explicit `target`.

As verified on 2026-09-05, `stable` targets iOS **5.22.0** / macOS **6.9.0**; `tf` uses a verified capability snapshot for iOS build **3823** / macOS build **12250**. Tags do not detect the installed version; older clients need updating. All newly integrated features currently also ship in stable, so both profiles may emit the same features. Future TF-only features require explicit support in the selected profile. See [Surge compatibility profiles](docs/surge-compatibility.md) for sources, the capability table, and maintenance.

## Upstream Subscription Auto-Fetch

SubPilot periodically fetches enabled upstream subscription sources into encrypted Workers KV cache. Client subscription requests can then prefer cached upstream content. If an upstream source temporarily fails, the system tries to keep using the old cache to reduce client-side fetch failures.

When `npm run setup` runs for the first time, it asks for the auto-fetch interval, defaulting to once every 12 hours. The interval is written to `triggers.crons` in local `wrangler.jsonc` and is executed by Cloudflare Workers Cron Triggers. For non-interactive installation, use:

```bash
SUBPILOT_SOURCE_REFRESH_HOURS=6 npm run setup
```

The value must be between 1 and 24 hours. After deployment, edit `triggers.crons` in `wrangler.jsonc` and run `wrangler deploy` again to change the interval.

The admin status page shows coverage, last update time, and item details for both upstream and compiled rule-set caches, with separate force-refresh actions. Admin and Telegram notification times are converted to the display time zone configured in **System settings**, using the `yyyy-mm-dd hh:mm:ss` format; system timestamps in KV remain UTC. The Telegram bot command `/status` shows cache overview, `/recent` shows the 5 most recent configuration fetch records, and `/refresh` force-fetches upstream subscriptions while refreshing compiled rule sets asynchronously in the background; each operation sends its own result. When Telegram notifications are enabled, scheduled fetch failures send alerts.

Upstream and compiled rule-set refreshes have execution deadlines. A refresh may partially succeed: successful sources and rule outputs are retained, while each failure is reported separately in status, preview, or notifications. After the deadline, SubPilot does not start new remote fetches or compilations and tries to keep using existing cache entries.

## Operational Limits and KV Consistency

The following primary limits keep saves and generation within Cloudflare Workers request, memory, and subrequest budgets:

| Scope | Limit |
| --- | --- |
| Configuration entities | 20 subscription sources and 40 rule outputs; rule sources have no separate count limit |
| Individual remote input | 4 MiB per subscription source; 2 MiB per rule source |
| Nodes and hosts | 10,000 source nodes and 20,000 host entries in aggregate; 15,000 nodes in the final output |
| Compilation of one rule output | 8 MiB of rule-source content, counted as characters, and 50,000 rules |
| Final client configuration | 8 MiB, counted as characters |
| Online GeoIP completion | 100 distinct IP lookups per generation |
| Rule coverage diagnostics | 24 external sources, 8 MiB of content, and 5,000 rules in aggregate |

Complete configuration snapshots, read-token records, and compiled rule artifacts use versioned, append-only KV data: SubPilot writes a complete new version first, and readers select the newest valid version; an incomplete or corrupt new version falls back to the previous valid data. Old versions, orphaned artifacts from failed writes, and migration leftovers are cleaned up later in bounded batches to accommodate Workers KV eventual consistency. Seeing old keys briefly remain is therefore expected; external scripts should not edit or delete runtime data by assuming fixed KV key names. Configuration changes involving a Telegram webhook commit their new snapshot only after the remote operation succeeds; if the commit cannot be confirmed, SubPilot keeps the old configuration and attempts to restore the old webhook. The admin UI still serializes save requests.

If Workers KV rejects a write or applies a write rate limit, the API returns HTTP 429. The admin UI serializes save operations. If saving fails, keep the page draft and retry later instead of repeatedly writing from several admin tabs.

## Updates

When a new version is available, read the release notes on GitHub Releases first. A normal update only requires this command in the project directory:

```bash
npm run update
```

If the current directory is a Git clone, the command pulls the latest code for the current branch. If the current directory came from a GitHub Releases `subpilot-worker-vX.Y.Z.tar.gz` archive, the command downloads the latest release asset with the same archive name and overlays the program files. Both paths preserve local `wrangler.jsonc`, install only dependencies needed for runtime deployment, and deploy to the configured Worker.

Updates preserve local `wrangler.jsonc`. Confirm that `triggers.crons` contains both the upstream subscription task and the compiled rule-set task:

```json
"triggers": {
  "crons": ["0 */12 * * *", "0 16 * * *"]
}
```

The first entry may keep your existing upstream refresh interval. The second entry runs the daily compiled rule-set refresh. Without it, compiled rule sets can still be refreshed manually from the status page or generated on demand, but the daily background refresh does not run. Run `wrangler deploy` after editing the file. New installations write both tasks automatically through `npm run setup`.

**Upgrading to 2.0 requires confirmed configuration migration.** The admin UI guides you through:

1. Export the complete old JSON configuration, including retired clients, and store it securely.
2. Review Surge → sing-box diagnostics and confirm migration to document version 2 and KV schema 12.
3. Keep existing Surge/mihomo settings and shared resources. Rule plans are copied per client. Later Surge edits do not change sing-box.
4. Unconvertible critical DNS/routing behavior remains marked for attention. Migration can finish, but sing-box downloads stay blocked until you resolve those items or explicitly acknowledge omitting the behavior.
5. Write and read back the new encrypted snapshot before scheduling old Stash/Shadowrocket data for cleanup after a grace period of at least five minutes. Once committed, reads cannot fall back to a legacy snapshot. Rolling back the application requires your exported old configuration.

Browsing, exporting, and previewing before confirmation do not delete old configuration. Confirmation is retryable; export again if the old document changes. Fresh installations start with version 2.

Alternatively, run `npm run migrate -- --url <deployment-url> --backup <private-backup-path>` to export, then add `--apply` to confirm. Supply the admin token through `SUBPILOT_ADMIN_TOKEN`. The script refuses to overwrite existing backup files, so use a new backup path for the second command.

Do not delete local `wrangler.jsonc` during updates, and do not rerun commands that rotate Secrets unless that is intentional. In particular, do not accidentally replace `CONFIG_ENCRYPTION_KEY`, or encrypted configuration snapshots, subscription and rule-source caches, compiled rules, Telegram Bot Tokens, and subscription read tokens in KV will no longer decrypt. Use `npm run setup -- --force-secrets` only when you intentionally reset the whole deployment or rotate keys.

The admin status page shows the current app version and latest-version check result. The `Version update check` setting is disabled by default; when enabled, the scheduled task checks GitHub Releases at most once per day. If Telegram is bound, a new-version notification is sent once. The same latest version is not notified repeatedly. Clicking `Check updates` on the status page checks GitHub Releases immediately.

## Rules and Policy Groups

Shared resources have one definition. Network, DNS, rule selection/order, default policy, and advanced settings remain independent for each client.

| Feature | Surge | mihomo | sing-box 1.14.0 |
| --- | --- | --- | --- |
| Nodes and groups | Adapted by protocol/type | Adapted by protocol/type | `selector` / `urltest` |
| Native routing | Surge rule text | rules + rule-providers | Native JSON route |
| Compiled rule files | `.list` | `.yaml` | JSON source `.json` |
| DNS and TUN | Independent Surge fields | Independent mihomo fields | Native DNS and inbounds |
| Rewrite / Map Local / MITM / scripts | Surge features retained | Omitted | Omitted |
| Ponte / Surge Tailscale | Surge only | Omitted | Not automatically converted |

Select applicable clients for each shared group. `select` and `url-test` have equivalents across clients; `fallback` and `load-balance` apply to Surge/mihomo, while `subnet` and `smart` are Surge only. Types are never silently substituted. Groups accept `{all}`, filters, or explicit members; Proxy must remain. Referenced empty groups, missing policies or detours, and dependency cycles block output without switching to direct access. Renaming, disabling, or deleting resources preserves references for diagnostics. sing-box requires an explicit default outbound or a final unconditional route/reject rule.

Current Surge ignores group-level `url`; use its proxy test URL setting. Preview reports this difference. [Surge documentation](https://manual.nssurge.com/policy-groups/url-test.html)

Each client chooses native routing or shared-source compilation. Compiled mode stores source selection, policy, order, inline rules, and direct rules independently. Source bodies share encrypted cache; identically named artifacts are isolated by target. Optional aggregation merges outputs with the same policy at its first occurrence, which can change precedence across policies. Review that choice before previewing. Final rules belong last. Surge/mihomo compiled plans require one FINAL/MATCH; sing-box can also use explicit `route.final`.

Incompatible match semantics block that target instead of silently dropping or broadening rules. For example, sing-box does not directly consume legacy GEOIP data rules, Surge IN-PORT, or no-resolve rules; rewrite native routing or use an appropriate rule set in that client. Unknown native fields are checked against the pinned official sing-box JSON Schema. Remote sets use 1.14 `http_client`; generated JSON source files use version 4. [sing-box rule sets](https://sing-box.sagernet.org/configuration/rule-set/)

Native mihomo rule-providers supply data and need explicit RULE-SET references and policies in rules. The app does not insert Proxy rules or remove references automatically. Native Surge/mihomo previews retain rule-coverage diagnostics.

Native sing-box node input preserves its fields. Conversions that cannot retain TLS, transport, or authentication options skip the node with a reason. Snell 6 is never downgraded to mihomo Snell 5. Automatic sing-box conversion supports Snell 4/6; review native options for other versions. [mihomo Snell support](https://wiki.metacubex.one/en/config/proxies/snell/)

Surge Tailscale, Ponte, Hosts, DNS outbound following, Map Local, MITM, and scripts remain under its advanced/DNS settings. Simple IP Hosts can be converted for sing-box; aliases, wildcard hosts, and resolver directives need manual handling. sing-box advanced settings expose the complete client JSON, including additional top-level settings; shared nodes and groups generate `outbounds`. Platform permissions, file paths, certificates, and actual connectivity still need verification on the target device.

## Telegram Notifications

SubPilot supports two notification states: notifications off, or Telegram notifications enabled. Telegram notifications report upstream subscription and compiled rule-set refresh failures, and provide bot commands for status checks and manual refresh.

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
refresh - Refresh subscription sources and compiled rule sets
help - View command list
```

Do not put `/bind` in the public command menu. `/bind <code>` is a one-time binding command temporarily generated by the SubPilot admin UI. It is valid for 10 minutes and should only be copied during binding.

### Bind in the SubPilot Admin UI

1. Confirm the Worker is deployed and the admin UI can be opened through the Workers.dev domain or your custom domain.
2. Log in to the SubPilot admin UI and open **System settings**.
3. Paste the Bot Token in the Telegram token field under `System settings`. A non-empty Bot Token enables Telegram notifications; clearing it disables notifications.
4. Save the configuration, then click `Generate binding code`. SubPilot automatically registers the Telegram webhook at `/api/telegram/webhook` under the current Worker domain.
5. Copy `/bind <code>` from the admin UI and send it to the bot in the target Telegram conversation. The target can be a personal chat, private group, or correctly authorized channel.
6. After the bot replies `SubPilot Telegram 通知已绑定成功。`, SubPilot records that conversation's Chat ID. The admin button changes to `Unbind`.

After binding succeeds, only the bound Chat ID can trigger SubPilot bot commands. Commands from other conversations are ignored.

### Available Bot Commands

```text
/status  View source count, cache count, and recent Surge/clash/sing-box fetch time
/sources View subscription source enabled state
/recent  View recent configuration fetch records, target type, client location, and User-Agent
/refresh Force refresh upstream subscriptions and asynchronously refresh compiled rule sets; each task replies with its own result
/help    View command list
```

In a group, if there are multiple bots or commands do not respond, use the username-qualified form, for example `/status@my_subpilot_bot`. SubPilot supports this standard Telegram command format.

### Rotate the Bot Token or Change the Receiving Chat

- If the Bot Token leaks, use `/revoke` in `@BotFather` to regenerate it, then replace the Bot Token in the SubPilot admin UI and generate a new binding command.
- To change the receiving conversation, click `Unbind` in the SubPilot admin UI, then generate a new binding command and send it to the new target conversation.
- After the Bot Token changes, SubPilot clears the previous Chat ID binding and registers the Telegram webhook again; generate a new binding command to bind the new token. When the Bot Token is cleared and notifications are disabled, SubPilot deletes the old webhook.

### Troubleshooting

- Binding command generation fails: check whether the Bot Token is complete, whether extra spaces were copied, and whether the Worker can access the Telegram API.
- No success reply after sending `/bind <code>`: confirm the command is still within its 10-minute validity window, was sent to the correct bot conversation, and the bot is not blocked from speaking by group permissions.
- Group commands do not respond: try sending `/status@your_bot_username`; if you changed BotFather privacy mode, remove and re-add the bot to the group.
- Channel binding fails: prefer a personal chat or private group. If you must use a channel, confirm the bot is a channel administrator and has the required send-message permission.

References: Telegram bot creation is documented in [From BotFather to Hello World](https://core.telegram.org/bots/tutorial). Privacy mode and group message behavior are covered by [Bot Features](https://core.telegram.org/bots/features) and [Bots FAQ](https://core.telegram.org/bots/faq). Command menus can be configured through BotFather or the Bot API [`setMyCommands`](https://core.telegram.org/bots/api#setmycommands).

## GeoIP MMDB

The admin **System settings** page provides a GeoIP MMDB upload entry. Users can upload a MaxMind DB Country `.mmdb` file up to 25 MiB. The UI sends it as raw binary without changing the workflow; no manual Base64 or other conversion is needed. After upload, IP node region detection prefers that database.

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

## Configuration preservation and local verification

Version 2 documents contain shared resources and `clients.surge`, `clients.mihomo`, and `clients.singbox`; retired Stash/Shadowrocket output settings are no longer persisted. Save and preview APIs use this document. `target=mihomo` (with `clash` as an alias) selects mihomo. Convert old backups through migration; do not write client JSON directly into KV.

`npm run verify` generates Worker types, checks TypeScript, and scans public files. `npm audit` checks dependency advisories. Use global Wrangler with `wrangler deploy --dry-run --config wrangler.example.jsonc --outdir /tmp/subpilot-dry-run` for a build check without deployment. AI-created or modified test code is prohibited in this repository.

Use `sing-box check -c SubPilot.json` to check downloaded output and `sing-box rule-set compile rules.json -o rules.srs` for generated rule sources. Schema/core checks do not replace import, VPN permission, and connectivity verification in desktop/mobile clients.
