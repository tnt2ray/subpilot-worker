# SubPilot Worker

Language: [中文](./readme.md) | English

Generate independent Surge, clash, and sing-box configurations from shared resources. SubPilot runs on Cloudflare Workers, stores encrypted configuration in Workers KV, and provides a browser admin UI.

[Overview](#overview) · [Deployment](#deployment) · [First use](#first-use) · [Subscription URLs](#subscription-urls) · [Configuration](#configuration) · [Updates and migration](#updates-and-migration) · [Cache and operational limits](#cache-and-operational-limits) · [Telegram and GeoIP](#telegram-and-geoip) · [Security and data](#security-and-data) · [Local development](#local-development) · [License](#license)

## Overview

Subscription sources, manual nodes, and chain exits are shared. Policy groups, disabled states, and rule sources belong to each client. Network, DNS, routing, and advanced settings are independent for each client. Subscription generation validates the selected client configuration and blocks output when conversion would lose critical behavior.

| Capability | Surge | clash | sing-box |
| --- | --- | --- | --- |
| Output | `.conf` | Clash-compatible `.yaml` | Native JSON for **1.14.0** |
| Nodes and groups | Supported protocols and group types | Supported protocols and group types | Native outbounds, `selector` / `urltest`, endpoint references |
| Native routing | Surge rule text | `rules` + `rule-providers` | JSON `route` |
| Compiled rule sources | `.list` | `.yaml` | JSON source `.json` |
| Network and DNS | Surge settings | clash settings | Native inbounds and DNS |
| Rewrite / Map Local / MITM / scripts | Retained | Omitted | Omitted |
| Tailscale | Dedicated native form | Omitted | Native endpoint with a dedicated form |

The admin UI provides migration issue resolution, a universal subscription link, token rotation, cache refresh, GeoIP renaming, and Telegram notifications. Version 2 retires Stash and Shadowrocket output. See [architecture and ablation decisions](./docs/architecture.md) and the [UI design specification](./docs/ui-design.md) for design details.

The overview shows the latest 50 subscription requests, node counts, and subscription cache status. **Force refresh** fetches saved, enabled sources again. Refresh failures show the reason and whether cached content remains available.

## Deployment

### Prerequisites

You need a Cloudflare account, Git or a release archive, Node.js/npm, and a globally installed Wrangler authenticated to the intended account. Install Wrangler only if it is missing:

```bash
npm install -g wrangler
wrangler login
```

### Recommended setup

Obtain the source and install runtime dependencies:

```bash
git clone https://github.com/tnt2ray/subpilot-worker.git
cd subpilot-worker
npm install --omit=dev
```

Alternatively, extract `subpilot-worker-vX.Y.Z.tar.gz` from [GitHub Releases](https://github.com/tnt2ray/subpilot-worker/releases), enter its directory, and run `npm install --omit=dev`.

**The following command creates or configures Cloudflare resources and deploys the Worker and admin UI:**

```bash
npm run setup
```

On a new installation, setup creates local `wrangler.jsonc`, creates or reuses the `SUBPILOT_CONFIG` KV namespace, and asks for the source refresh interval (1–24 hours, default 12) and an admin token of at least 24 characters. It hashes the token, generates an encryption key, and deploys with the required Worker Secrets through a temporary secrets file that is removed afterward. Keep the admin token in a password manager.

If `wrangler.jsonc` already exists, setup reuses it and skips Secret writes by default. Do not copy the template before using the recommended setup; template copying belongs to the manual steps below. `npm run setup -- --force-secrets` also deploys and replaces both Secrets; use it only for an intentional reset or planned rotation. **Preserve the existing `CONFIG_ENCRYPTION_KEY` when reusing encrypted KV data.**

<details>
<summary>Automation environment variables</summary>

Pass these through your environment or secret manager when running `npm run setup`. Setup still deploys by default.

| Variable | Purpose |
| --- | --- |
| `SUBPILOT_WORKER_NAME` | Worker name |
| `SUBPILOT_KV_NAMESPACE_ID` | Reuse an existing KV namespace |
| `SUBPILOT_ADMIN_TOKEN` | Admin token; required in non-interactive mode when setup writes Secrets, at least 24 characters |
| `SUBPILOT_CONFIG_ENCRYPTION_KEY` | Encryption key to use when writing Secrets; otherwise generated automatically |
| `SUBPILOT_SOURCE_REFRESH_HOURS` | Source refresh interval, integer from 1 to 24 |
| `SUBPILOT_LOGIN_RATE_LIMIT_NAMESPACE_ID` | Optional Rate Limiter namespace override, integer from 1 to 4294967295 |

The login limit defaults to 10 attempts per minute per client IP within each Cloudflare location. Setup derives the Rate Limiter namespace ID from the Worker name; use the override if it conflicts with another limiter in the same account.

</details>

<details>
<summary>Manual deployment</summary>

1. Install runtime dependencies and copy the example configuration:

   ```bash
   npm install --omit=dev
   cp wrangler.example.jsonc wrangler.jsonc
   ```

2. Set your Worker name in `wrangler.jsonc`. The following command creates a remote KV namespace; copy its returned `id` into `kv_namespaces[0].id`:

   ```bash
   wrangler kv namespace create SUBPILOT_CONFIG
   ```

3. Choose an admin token of at least 24 characters and calculate its SHA-256 hex value. This Bash command prompts without echoing the token:

   ```bash
   read -r -s -p 'Admin token: ' SUBPILOT_SETUP_TOKEN
   printf '\n'
   printf '%s' "$SUBPILOT_SETUP_TOKEN" | shasum -a 256 | awk '{print $1}'
   unset SUBPILOT_SETUP_TOKEN
   ```

4. These commands write remote Worker Secrets. Supply the hash above for `ADMIN_TOKEN_HASH` and a long random string for `CONFIG_ENCRYPTION_KEY`; retain an existing encryption key when reusing KV data:

   ```bash
   wrangler secret put ADMIN_TOKEN_HASH
   wrangler secret put CONFIG_ENCRYPTION_KEY
   ```

5. The following command deploys to the Worker configured in `wrangler.jsonc`:

   ```bash
   wrangler deploy
   ```

</details>

For a custom domain, connect it to the Worker in Cloudflare or configure `routes` in local `wrangler.jsonc`. Keep that file untracked. The example configuration includes both refresh schedules described in [Cache and operational limits](#cache-and-operational-limits).

## First use

Open the deployment URL and sign in with the admin token.

1. In **System settings**, confirm Managed Base URL (usually `https://<your-domain>/sync`) and the display time zone.
2. In **Sources**, add upstream subscriptions and their fetch User-Agents. In **Proxy nodes**, add manual nodes and chain exits as needed. The node editor shows **Upstream node selection** only when **Chain exit** is enabled; turning it off hides the field while retaining its values. Enter one keyword per line: a case-insensitive substring match against any keyword in a node name or label selects that node; regular expressions are not supported. Only matching non-exit nodes generate chained nodes; unmatched nodes do not participate, and an empty selection generates none. The path is device → matching node → current exit node → destination.
3. In **Policy groups**, select a client, then configure its members, filters, and options.
4. In **Client configuration**, choose Surge, clash, or sing-box and edit its network, DNS, routing, and advanced settings.
5. For compiled routing, enter source URLs directly in the selected client’s routing tab and choose a policy. Sources are linked automatically within that client; move rule sets and direct rules up/down in one list. Select RULE-SET or DOMAIN-SET in Surge, behavior and interval in Clash, and the source format in sing-box.
6. Review the configuration and resolve pending **Migration issues**, save, and copy the universal URL from **Configuration links**.

To update an existing subscription source, proxy node, or policy group, click its name or the row’s **Edit** button. Choose **Apply changes** in the dialog, then **Save configuration** at the bottom of the page to persist the changes. On narrow screens, the action column remains visible while other details scroll horizontally.

The page header and bottom action bar remain visible. Long content scrolls within the space between them, keeping the last items clear of the action bar.

Drafts stay in the current page's memory while navigating between pages and clients. Reloading or closing the page loses unsaved edits. Subscription requests use saved configuration and check compatibility before generating output.

If an older deployment shows a migration banner, follow [Updates and migration](#updates-and-migration) first.

## Subscription URLs

With Managed Base URL set to `https://<your-domain>/sync`, use the shared subscription address below:

Surge, clash, and sing-box all use the same URL:

```text
https://<your-domain>/sync/<read_token>/
```

The server selects the output from a case-insensitive client identifier in User-Agent:

| UA identifier | Output client | Download filename |
| --- | --- | --- |
| `Surge` | Surge | `SubPilot.conf` |
| `clash` | clash | `SubPilot.yaml` |
| `sing-box` or `singbox` | sing-box | `SubPilot.json` |

Import the universal URL in your client. Missing, unrecognized, or ambiguous client identifiers return HTTP 400. Keep the appropriate client identifier when customizing User-Agent. The subscription entry accepts an optional trailing slash.

Surge uses the same output behavior for iOS/macOS, stable/TestFlight, and all client versions. There are no version tags or version-based feature filters. Subscriptions use the saved Surge settings, and generated automatic update URLs always use the universal entry. See [Surge output behavior](./docs/surge-compatibility.md).

Dedicated client paths, tagged Surge paths, legacy filename endpoints, and Stash/Shadowrocket outputs are not available. Filenames are only used for downloads. Subscription and rule URLs reject query parameters; a blocked configuration returns HTTP 422 with specific errors and configuration paths. Under **Configuration links → Subscription check**, choose a client to inspect the saved configuration as a plain-text log directly below the check buttons with the check time, severity, configuration path, diagnostic code, and message. Use **Copy log** or select the text to copy manually. Save changes before checking again.

Managed Base URL must include a non-root path and cannot occupy `/api`, `/vendor`, or admin asset paths. Only its currently configured path is active. Update client subscription URLs after changing the base URL or rotating the read token.

## Configuration

### Shared resources and client settings

Subscription sources, manual nodes, and chain exits are shared by all three clients. Policy groups, rule sources, routing, network, DNS, and advanced settings are maintained separately. Changes to one client do not update the others, and group names resolve within their own client.

The Surge `FINAL`, Clash `MATCH`, and sing-box `FINAL` / `MATCH` fallback entries stay last. They cannot be deleted, disabled, or changed into ordinary rules; their outbound policy remains editable. New rules are inserted before the fallback. Clash displays `MATCH` as the last table row, with an editable outbound; native sing-box configuration uses its separate **Default outbound** setting.

### Nodes and policy groups

- Subscription input supports the recognized Surge/Clash and proxy-link formats, including Base64 subscriptions. Native sing-box JSON accepts an object containing `outbounds`, an outbound array, or a single outbound. It imports nodes, not the input file's complete DNS, routes, or groups.
- Manual nodes accept Surge syntax, Clash YAML/JSON with `name` and `port`, or native sing-box JSON with `tag` and `server_port`. Native SSH uses port 22 when omitted. Native fields are preserved for sing-box; conversions that cannot retain TLS, transport, or authentication options skip the node with a diagnostic.
- Group members can use `{all}`, filters, or explicit names. `Proxy` cannot be deleted or renamed and must remain enabled; its type is not limited to `select` and may be any group type supported by the target client. Configure each client’s groups independently: `select` and `url-test` have equivalents across clients; `fallback` and `load-balance` apply to Surge/clash; `subnet` and `smart` are Surge only. Migrating shared groups converts Surge `url-test` to `smart`. Surge output also retains this conversion for compatibility; clash and sing-box use their own automatic-testing types. Surge smart groups require proxy-node members; built-in policies and nested groups block that output. Smart uses its own testing schedule, so `interval` has no effect.
- sing-box groups can reference `endpoints` tags, preserving member order; manage Tailscale endpoints in their dedicated tab. Configure these groups in the sing-box tab. Routing `preferred_by` references outbounds or endpoints, while DNS `preferred_by` references DNS servers.

Groups with no available members after filtering are omitted, and other groups drop references to them. Routing rules targeting these empty groups fall back to `Proxy`. Saved filters remain intact, so groups return when matching nodes become available. An empty `Proxy` still blocks subscription output.

The policy groups page includes a **Syntax guide and examples** with types and options for the selected client. Enter one line in the form `type, member or selector, option=value`, using ASCII commas. Enter the group name separately; omit the `group name =` prefix.

- Explicit members use exact existing node/group names or built-in policies supported by the client. Self-references and dependency cycles are invalid.
- `{all}` expands eligible nodes, not other groups. `fallback` requires explicit members and `subnet` uses condition mappings; neither accepts `{all}`.
- `{all filter=香港,日本 exclude=via,DMIT}` keeps nodes matching 香港 or 日本, then excludes nodes matching via or DMIT. Matching uses case-insensitive substrings in node names and matching labels, not regular expressions.
- Both `filter` and `exclude` are optional. Separate keywords with ASCII commas; put `filter` before `exclude`, separated by a space. `{all exclude=via,DMIT}` excludes nodes matching either keyword.
- Referenced groups with no matching nodes or unavailable members may cause HTTP 422; use **Configuration links → Subscription check** to locate the cause.

`hidden=true` is emitted for Surge and clash; clash requires client or dashboard support. sing-box omits it and reports a diagnostic when enabled.

Surge ignores group-level `url`; use its proxy test URL setting. Snell 6 is not downgraded to clash Snell 5; automatic sing-box conversion supports Snell 4/6. See the [Surge group documentation](https://manual.nssurge.com/policy-groups/url-test.html) and [clash Snell documentation](https://wiki.metacubex.one/en/config/proxies/snell/).

Use **Edit text** at the top right of text-list sections such as Surge scripts, URL rewrites, and local mappings to edit native lines. Apply changes, then save the configuration.

Surge Ponte support has been removed. Legacy Ponte device lists are ignored when loading configurations. Existing `DEVICE:` policy references are retained and must be replaced with valid policies before that subscription can be generated. No KV schema change is required.

### Complete sing-box configuration forms

The compatibility baseline remains **sing-box 1.14.0**. The UI and output validator share the pinned [official JSON Schema](https://github.com/SagerNet/sing-box/blob/v1.14.0/docs/schema.json); removed legacy fields are not offered as new options. Consult the [configuration manual](https://sing-box.sagernet.org/configuration/) and the build installed on your device for runtime support.

| Tab | Configuration coverage |
| --- | --- |
| Network & TUN | All inbound types, TUN addresses/routes/app filters/platform options, listen fields, Linux network namespaces |
| DNS | All 15 server types: UDP/TCP/TLS/QUIC/HTTPS/HTTP3, Local/Hosts/DHCP/mDNS/FakeIP, Tailscale/OpenConnect/OpenVPN/Resolved; cache, optimistic cache, timeouts, logical rules and all DNS actions |
| Routing | All match fields, logical combinations, route/route-options/direct/bypass/reject/hijack-dns/sniff/resolve actions; local/remote/inline rule sets, resolvers, HTTP clients, interfaces and neighbor discovery |
| VPN endpoints | WireGuard, Tailscale, OpenConnect, OpenVPN Client / Server; peers, authentication, routes, TLS and dial fields |
| Native outbounds | All 1.14 outbound types, including Naive, Hysteria, ShadowTLS, Tor, SSH, Bridge, Snell 4/6 and native selector/urltest; protocol-specific TLS/ECH/Reality/uTLS, transports, multiplex and dial fields |
| Services | Schema-supported API, DERP, Resolved, SSM API, CCM, OCM, Hysteria Realm, USB/IP, OOM killer and related services |
| Advanced | Logs, NTP, certificate trust/providers, shared HTTP clients, cache files, Clash API, V2Ray API and debugging |
| Policy groups | Named members, shared-node filters and ordering, selector default member, urltest URL/interval/tolerance/idle timeout, connection interruption on switch |

Open **Configure** in each section. **Add field** exposes optional fields; expand nested objects and add, remove or reorder list items. Text, numbers, booleans, enums, scalar/list choices and object variants use dedicated controls, including certificates, keys and header maps, without requiring JSON. Remove optional fields to restore core defaults. Unchanged values and list order are preserved. Switching type or action keeps compatible fields and removes incompatible ones; Cancel discards the draft. Apply validates the section against the server's schema; save the configuration to persist it. Unknown imported fields remain visible and preserved until corrected or removed.

Native outbounds are emitted alongside shared nodes and generated groups. Their tags and endpoint tags must be unique and must not collide with built-in `DIRECT` or existing groups. Use their tags in groups and routing rules. Diagnostics check outbound, DNS, inbound, rule-set, HTTP-client, certificate-provider and network-namespace references, group/dial cycles, selector default membership and VPN DNS endpoint types.

**Compiled mode emits native routing rules before compiled rules and preserves both native and generated rule sets.** An unconditional native rule can therefore stop matching before compiled rules are reached; use explicit conditions for native rules intended to run first. Compiled FINAL/MATCH still sets the final outbound. `{all}` continues to filter shared nodes; add client-native outbounds and endpoints as named members. No KV schema migration or additional Secrets are required.

Platform restrictions still apply: [Android](https://sing-box.sagernet.org/clients/android/features/) uses VpnService and distinguishes app filters from privileged process/interface features; [Apple](https://sing-box.sagernet.org/clients/apple/features/) uses NetworkExtension with restrictions on package and process matching. Network namespaces require Linux; the Apple HTTP engine requires an Apple platform. Client preferences such as Always On, notification display and app-selection overrides cannot be delivered through subscription JSON and must be set in the client. Schema validation does not check local files, system permissions, protocol credentials, every cross-field constraint or connectivity. Run `sing-box check` and verify runtime behavior on the intended device.

### Tailscale

Surge and sing-box each have a **Tailscale** tab beside **Routing rules**. Add, edit, and delete nodes through the list; forms cover authentication, routing, and connection settings, with masked auth-key inputs. The two clients keep independent configurations.

- Surge retains all existing section-name, DERP, idle-keepalive, DNS, MTU, upstream-proxy, and probe settings. Enabled nodes require an auth key.
- sing-box uses native 1.14 `endpoints` with `type: "tailscale"`, including subnet and exit-node advertisement, interfaces, relay, SSH, Taildrop, DNS, and dial options. Optional switches offer **Use default**; untouched optional fields are preserved. Other endpoint types remain unchanged.
- For sing-box, leave the key empty to authorize through the login URL in client logs. Use separate state directories for separate instances. This service generates configurations; Tailscale login happens in the client.
- Use each node's name in that client's policy groups and rules; sing-box also offers endpoints as the default outbound. Update existing references manually after renaming or deleting. Surge settings are not copied or converted to sing-box automatically.

See the [sing-box Tailscale endpoint documentation](https://sing-box.sagernet.org/configuration/endpoint/tailscale/).

### Routing rules

Open **Client configuration**, select a client, and choose **Routing rules**. Each client has its own rules, outbound policies, and matching order.

1. Choose **Add rule set**, enter download URLs (one per line), and select an outbound policy and format.
2. The client downloads a single compatible URL directly, without Worker fetching or caching. Multiple URLs within one rule set are merged and deduplicated. For an individual condition, choose **Add direct rule** and enter its match type, value, and outbound.
3. Place higher-priority rules first. Surge and Clash need one final `FINAL` / `MATCH` rule at the end; sing-box can use `route.final` in its native settings.
4. Choose **Apply changes**, then **Save configuration**, and update the subscription in your client.

| Client | Rule-set settings | Supported sources |
| --- | --- | --- |
| Surge | `RULE-SET` or `DOMAIN-SET` | Typed rules for RULE-SET; domain lists for DOMAIN-SET, with a leading dot to include subdomains |
| Clash | `behavior` and `interval` in seconds | Clash YAML `payload`, or domain / ipcidr / classical text |
| sing-box | Automatic detection or an explicit source format | Clash and Surge rule sets, plus domain, IP-CIDR, and classical text |

Download filenames for merged or converted rule sets are managed automatically. The three clients may share a name, using `.list`, `.yaml`, and `.json` respectively. Existing rule-set download names and your upstream URLs are preserved.

**Clash:** Choose domain, ipcidr, or classical for `behavior`; use classical for mixed rule types. `interval` controls how often the client downloads the rule set, defaulting to 86400 seconds. SubPilot creates `rule-providers` and outbound references automatically. To convert native configuration, choose **Use rule-set form**, review the draft, and save. Unsupported content requires correction; a failed conversion leaves the saved configuration active.

Clash and sing-box match each entry independently, merging only URLs within the same entry. Surge’s **Aggregate by policy** combines rule sets at the outbound’s first occurrence, so review matching priority before enabling it. Entries with an explicit RULE-SET / DOMAIN-SET type remain independent.

**Surge:** Select options such as `no-resolve` and `extended-matching` where the rule type supports them. DOMAIN-SET does not support `no-resolve`. FINAL supports the Surge-only `dns-failed` option. See the [rule-set guide](https://manual.nssurge.com/rules/ruleset.html) and [FINAL guide](https://manual.nssurge.com/rules/final.html).

**sing-box:** For native configurations, choose **Use rule-set URLs** to enable the URL form. Existing native rules match first and remain editable under **Native routing and advanced settings**. An unconditional native rule may prevent later rules from matching.

Clash or Surge sources require conversion for sing-box even with a single URL. During conversion, `IP-ASN` expands to IPv4/IPv6 CIDRs using periodically refreshed data. Failed lookups use cached data where available, or skip the ASN with a warning. Unsupported rules such as `USER-AGENT` and `URL-REGEX` are skipped and reported in diagnostics; download and format failures produce errors. Incompatible native settings still require manual correction. To resolve domains before IP routing, configure a native `resolve` action.

### Subscription checks

Open **Configuration links → Subscription check** and select a client to inspect its saved configuration. Referenced empty groups, missing outbounds, dependency cycles, and incompatible critical settings can cause **HTTP 422**. Use the configuration locations in the log to correct the problems, save, and check again.

Rule sets requiring merging or conversion are processed automatically and refreshed on schedule. After importing sing-box configuration, run `sing-box check` on the actual device to check compatibility with its client version, permissions, and local files.

### Advanced settings

Surge keeps Hosts, DNS outbound following, Map Local, and scripts in its DNS/advanced settings. Tailscale and MITM each have a dedicated tab. Simple IP Hosts can convert to sing-box; aliases, wildcard hosts, and resolver directives need manual handling.

Use **Client settings → Surge → MITM certificates** to generate, import, or export a CA certificate. Generation fills in an editable CA passphrase, runs in the browser, and shows its working state. Save the configuration afterward, then update the client subscription. Expand the certificate data to view or edit it; MITM hostnames and other options are in the same tab.

sing-box settings provide field-level forms for all native top-level sections. Native outbounds are combined with shared nodes and the current client’s generated groups. Verify device permissions, file paths, certificates, and connectivity in the actual client after importing the subscription.

## Updates and migration

### Update an existing deployment

Read the [release notes](https://github.com/tnt2ray/subpilot-worker/releases) first. **The following command updates local program files, installs runtime dependencies, and deploys to the Worker in local `wrangler.jsonc`:**

```bash
npm run update
```

For a Git clone, it requires clean tracked files and pulls the current branch with `--ff-only`. For a release-archive installation, it prefers the latest `subpilot-worker-vX.Y.Z.tar.gz`, falls back to the source archive when that attachment is absent, and replaces managed program files. Both paths preserve `wrangler.jsonc` and existing Secrets. Do not remove that file or replace `CONFIG_ENCRYPTION_KEY`: existing encrypted data depends on the same key.

`npm run update -- --no-deploy` skips only the final deployment. It still updates code, dependencies, and local configuration, so it is not a read-only check.

Confirm both refresh schedules are present after upgrading; see [Cache and operational limits](#cache-and-operational-limits). Scheduled version checks are disabled by default; when enabled, GitHub Releases is checked at most daily and a bound Telegram chat receives one notification for each newly detected version.

### Configuration document migration

**Use the universal subscription URL in every client after upgrading.** `/sync/<read_token>/` is available again; existing universal URLs continue to work if the base path and token are unchanged. Replace `/surge/`, `/clash/`, `/sing-box/`, and any `stable` / `tf` tagged URLs with the universal URL copied from the dashboard, then refresh the subscription. See [Subscription URLs](#subscription-urls).

Fresh installations use document version 3; **KV schema remains 12**. Version 2 documents are split automatically on read and saved as version 3. Groups are copied according to their former target selections, retaining disabled states. Legacy shared `hidden` remains Surge-only; configure hiding independently in clash after the split; the complete rule-source list is copied to each client with IDs and references intact. Subsequent edits are independent. Reload any open admin pages after upgrading before editing. No manual KV changes or subscription URL changes are required.

Version 1 deployments still require explicit migration:

1. Review the migration draft. Surge and clash keep their settings and shared nodes; groups, rule sources, and plans become independent per client. sing-box is initialized once from Surge.
2. Confirm migration. Unconvertible critical DNS/routing behavior remains flagged: sing-box downloads stay blocked until you fix the issue or explicitly mark it resolved after reviewing the omitted behavior.
3. The Worker writes and reads back the new encrypted snapshot before scheduling legacy data cleanup after at least five minutes. After commit, reads cannot fall back to a legacy snapshot.

Reviewing the migration draft does not delete legacy configuration. If the saved configuration changes during migration, you must review it again; the page keeps your draft in memory. Note any edits you want to retain, reload, and review migration again.

<details>
<summary>Command-line migration</summary>

Supply `SUBPILOT_ADMIN_TOKEN` through your environment. Check migration status without applying:

```bash
npm run migrate -- --url "https://your-worker.example"
```

After review, this command **writes the migrated configuration to the deployment**:

```bash
npm run migrate -- --url "https://your-worker.example" --apply
```

Replace the example domain, or use `SUBPILOT_BASE_URL` to provide the URL. The script does not export configuration files; the former `--backup` option and `SUBPILOT_BACKUP_PATH` environment variable have been removed. Conversion issues remain available in the admin UI after migration.

</details>

## Cache and operational limits

Enabled upstream subscriptions are fetched into encrypted KV cache. Requests prefer cached content; failed refreshes try to retain usable old entries. Rule-source bodies share cache, while compiled artifacts remain separate for each client. Refreshes have execution deadlines, retain successful results, and report individual failures; once the deadline is reached, no new remote fetches or compilations start.

The default schedules in local `wrangler.jsonc` are:

```json
{
  "triggers": {
    "crons": ["0 */12 * * *", "0 16 * * *"]
  }
}
```

The first entry refreshes subscriptions every 12 hours; keep your chosen interval if different. Keep `0 16 * * *` for daily compiled rule-set refresh. Other cron entries run upstream refreshes. Without the daily rule task, manual refresh and on-demand generation remain available. Schedule changes require a new deployment using `wrangler deploy`.

Use **Force refresh** on the overview to refresh subscriptions. Save drafts before refreshing. Admin and Telegram times use the configured display time zone in `yyyy-mm-dd hh:mm:ss`; stored timestamps remain UTC.

| Scope | Limit |
| --- | --- |
| Configuration request | 6 MiB |
| Entities | 20 shared subscription sources, 500 shared manual nodes; 100 policy groups per client; no separate rule-source count limit |
| Compiled outputs | 40 per client |
| One remote input | 4 MiB per subscription source; no project-level download-size cap for rule sources |
| One subscription source | 2,500 nodes and 5,000 host entries |
| Nodes and hosts in aggregate | 10,000 source nodes and 20,000 host entries; 15,000 final nodes |
| One compiled rule output | No fixed input-character or rule-count cap; runtime resources and artifact storage capacity still apply |
| Final client configuration | 8 × 1024 × 1024 characters |
| GeoIP completion | 100 distinct IP lookups per generation |
| Rule coverage diagnostics | 24 external sources, 8 × 1024 × 1024 input characters, and 5,000 rules in aggregate |

Saved changes may take a short time to appear in all requests. Manage configuration through the admin UI rather than editing or deleting runtime data directly in KV.

If saving returns **HTTP 429**, keep the page draft and retry later. Avoid repeated saves from multiple admin tabs.

## Telegram and GeoIP

### Telegram

1. Create a bot with `/newbot` in [BotFather](https://core.telegram.org/bots/tutorial) and securely retain its token.
2. In **System settings**, enter the Telegram Bot Token and save. A non-empty token enables Telegram notifications and configures the webhook; clearing it disables notifications.
3. Click **Generate binding code**. Unsaved changes must be saved first. The webhook path is `/api/telegram/webhook`, preferring the origin of Managed Base URL; unchanged webhook settings do not need re-registration.
4. Send the displayed `/bind <code>` to the bot in the receiving conversation within 10 minutes. After success, only that chat can run bot commands.

Use a personal chat or a private admin group. Groups normally need command access and permission to send messages, not bot administrator rights; keep BotFather privacy mode enabled. Channels require suitable posting permissions, typically by making the bot an administrator. For group commands, use `/status@your_bot_username` if necessary.

| Command | Result |
| --- | --- |
| `/status` | Subscription/cache overview and recent client fetch times |
| `/sources` | Subscription sources and enabled state |
| `/recent` | Five recent configuration requests, including target, location, and User-Agent |
| `/refresh` | Force source refresh and asynchronous compiled rule refresh, with separate results |
| `/help` | Command list |

BotFather `/setcommands` can expose these commands in a menu; omit the temporary `/bind` command. Bound notifications include refresh failures and, when enabled, new-version alerts.

To change the receiving chat, click **Unbind**, generate a new code, and bind again. If the bot token changes, the old chat binding is cleared; save the new token and bind again. Clearing the token removes the old webhook. If binding fails, check the token, code expiry, Telegram API access, and chat permissions; for a leaked token, revoke it through BotFather before replacing it. See Telegram's [bot features](https://core.telegram.org/bots/features) and [FAQ](https://core.telegram.org/bots/faq).

### GeoIP MMDB

**System settings → GeoIP MMDB** shows the current file name, database type, database version (build time), upload time, and size. Existing uploads also expose their embedded build metadata; unavailable build times are explicitly labeled.

Select a MaxMind DB Country `.mmdb` file up to **25 MiB**, then click **Upload**. The page shows transfer progress followed by server validation and saving, and prevents duplicate uploads. Success immediately updates the displayed database information. Failure shows the reason and retains the selected file for retry; **Refresh database information** checks the current state. Files upload directly as binary without Base64 conversion. Uploading a replacement invalidates old region-cache results through the database version.

You can select an existing file from a local client at these reference paths:

| Client | MMDB file path |
| --- | --- |
| Surge macOS | `~/Library/Application Support/com.nssurge.surge-mac/GeoLite2-Country.mmdb` |
| Clash Verge Windows | `%APPDATA%\io.github.clash-verge-rev.clash-verge-rev\Country.mmdb` |
| Clash Verge macOS | `~/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/Country.mmdb` |

Region lookup uses existing single-IP overrides first, then the uploaded database; it does not query an external geolocation service. Without a database, unknown IP nodes may lack region-based names and group matches, and recent request locations may be unknown. Use an appropriately licensed data source; client-bundled databases retain their own licensing terms.

## Security and data

- `ADMIN_TOKEN_HASH` and `CONFIG_ENCRYPTION_KEY` belong in **Cloudflare Worker Secrets**. Login checks the admin token's SHA-256 hex hash; the plaintext admin token is not stored in the repository, KV, or Worker Secrets.
- Configuration snapshots, subscription/rule-source caches, compiled rules, and recoverable subscription read tokens are encrypted. Telegram tokens and other private configuration values are protected within the encrypted snapshot. Preserve the encryption key across updates and migration.
- Admin sessions use signed HttpOnly cookies; they do not create `session:*` KV keys. Subscription read tokens grant configuration access and should be kept private and rotated if exposed.
- `wrangler.jsonc` is local and untracked. Keep real Worker names, namespace IDs, domains, subscription URLs, passwords, MITM CAs, tokens, and private exports out of public source, issues, logs, and release archives. Configuration data contains private information and must not be shared publicly.

## Local development

Install all dependencies with `npm install`. Use global Wrangler for development and checks:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the local Worker and admin UI |
| `npm run typecheck` | TypeScript validation |
| `npm run typecheck:worker` | Generate Worker types and check TypeScript |
| `npm run verify` | Worker type checks, TypeScript, and public-content scan |
| `npm audit` | Dependency vulnerability advisory check |
| `npm run dry-run` | Build deployment artifacts locally without deploying |

`dry-run` uses local `wrangler.jsonc`. To check the public example instead:

```bash
wrangler deploy --dry-run --config wrangler.example.jsonc --outdir /tmp/subpilot-dry-run
```

Use the matching sing-box core to validate downloaded configuration and generated rule sources:

```bash
sing-box check -c SubPilot.json
sing-box rule-set compile rules.json -o rules.srs
```

Schema and build checks do not replace importing the result, granting VPN permissions, and checking connectivity on the target device.

## License

SubPilot Worker is licensed under the [GNU Affero General Public License v3.0 or later](./LICENSE). Modified versions offered over a network must provide corresponding source as required by the AGPL.

Third-party dependencies and bundled code retain their licenses. Upstream subscriptions, rule sets, GeoIP databases, and other external data are not licensed by this project; check the terms of their respective sources.
