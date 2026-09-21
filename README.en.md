# SubPilot Worker

Language: [中文](./readme.md) | English

Generate independent Surge, clash, and sing-box configurations from shared resources. SubPilot runs on Cloudflare Workers, stores encrypted configuration in Workers KV, and provides a browser admin UI.

[Overview](#overview) · [Deployment](#deployment) · [First use](#first-use) · [Subscription URLs](#subscription-urls) · [Configuration](#configuration) · [Updates and migration](#updates-and-migration) · [Cache and operational limits](#cache-and-operational-limits) · [Telegram and GeoIP](#telegram-and-geoip) · [Security and data](#security-and-data) · [Local development](#local-development) · [License](#license)

## Overview

Subscription sources, manual nodes, and chain exits are shared. Policy groups, disabled states, and rule sources belong to each client. Network, DNS, routing, and advanced settings are independent for each client. Subscription generation validates the selected client configuration and blocks output when conversion would lose critical behavior.

| Capability | Surge | clash | sing-box |
| --- | --- | --- | --- |
| Output | `.conf` | Clash-compatible `.yaml` | Native JSON for **1.15.0-alpha.6 (preview)** |
| Nodes and groups | Supported protocols and group types | Supported protocols and group types | Native outbounds, `selector` / `urltest`, endpoint references |
| Native routing | Surge rule text | `rules` + `rule-providers` | JSON `route` |
| Compiled rule sources | `.list` | `.yaml` | JSON source `.json`, or optional Actions processing to `.srs` |
| Network and DNS | Surge settings | clash settings | Native inbounds and DNS |
| Rewrite / Map Local / MITM / scripts | Retained | Omitted | Omitted |
| Tailscale | Dedicated native form | Omitted | Native endpoint with a dedicated form |

The admin UI provides subscription checks, a universal subscription link, token rotation, cache refresh, GeoIP renaming, and Telegram notifications. Version 2 retires Stash and Shadowrocket output.

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

On a new installation, setup creates local `wrangler.jsonc`, creates or reuses the `SUBPILOT_CONFIG` KV namespace, and asks for the source refresh interval (1–24 hours, default 12). It checks remote Secrets, requests an admin token of at least 24 characters when the admin credential is missing, and uses a supplied or generated encryption key when that Secret is missing. It deploys with the missing Secrets through a temporary file that is removed afterward. Keep the admin token in a password manager.

If `wrangler.jsonc` already exists, setup reuses it, verifies and preserves existing Secrets, and writes only missing ones. After an invalid token or failed deployment interrupts first-time setup, correct the problem and rerun `npm run setup`; an existing configuration file does not skip unfinished Secret initialization. Setup stops without writing Secrets if their remote state cannot be verified. `npm run setup -- --force-secrets` also deploys and replaces both Secrets; use it only for an intentional reset or planned rotation. **Preserve the existing `CONFIG_ENCRYPTION_KEY` when reusing encrypted KV data.**

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

For a custom domain, connect it to the Worker in Cloudflare or configure `routes` in local `wrangler.jsonc`. Keep that file untracked. The example configuration includes subscription refresh, daily rule-change detection, and pending rebuilds every 5 minutes; see [Cache and operational limits](#cache-and-operational-limits).

## First use

Open the deployment URL and sign in with the admin token.

1. In **System settings**, confirm Managed Base URL (usually `https://<your-domain>/sync`) and the display time zone.
2. In **Sources**, add upstream subscriptions and their fetch User-Agents. In **Proxy nodes**, add manual nodes and chain exits as needed. The node editor shows **Upstream node selection** only when **Chain exit** is enabled; turning it off hides the field while retaining its values. Enter one keyword per line: a case-insensitive substring match against any keyword in a node name or label selects that node; regular expressions are not supported. Only matching non-exit nodes generate chained nodes; unmatched nodes do not participate, and an empty selection generates none. The path is device → matching node → current exit node → destination.
3. In **Policy groups**, select a client, then configure its members, filters, and options.
4. In **Client configuration**, choose Surge, clash, or sing-box and edit its network, DNS, routing, and advanced settings.
5. For compiled routing, enter source URLs directly in the selected client’s routing tab and choose a policy. Sources are linked automatically within that client; move rule sets and direct rules up/down in one list. Select RULE-SET or DOMAIN-SET in Surge, behavior and interval in Clash, and the source format in sing-box.
6. Save the configuration, run a subscription check in **Configuration links**, and copy the universal subscription URL.

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

Subscriptions, static nodes and chain nodes are shared. Policy groups, rule sources, routing, networking and DNS are independent for each client. Names may be reused across clients.

Surge, Clash and sing-box no longer convert, copy or initialize settings from one another. Fresh installations and upgrades from version 1 documents use sing-box's own native DNS, TUN inbound, outbound interface detection, Proxy group and FINAL rule defaults; Tailscale connections start empty. Proxy outbounds come from shared nodes and the current client's groups. Existing settings for each client are preserved.

Cross-client migration diagnostics and their management panel have been removed. Loading or importing a configuration discards all historical `migrationIssues`, and the next save persists the cleanup. These records no longer block subscription checks or downloads, and require no manual dismissal or reinitialization. Native field, reference and rule checks still validate the current configuration. Storage compatibility for upgrading version 1 / 2 documents to version 3 remains; no additional KV schema migration is required.

Configuration previews and modal editors include line numbers and syntax highlighting. Apply changes in the editor, then click Save configuration.

### Nodes and policy groups

Proxy nodes accepts Surge node syntax, Clash YAML/JSON and native sing-box JSON. sing-box input may be one node, an array or an object containing `outbounds`; DNS, routing and groups from that input are not imported.

Clash targets Mihomo **v1.19.31**: TUN supports `mips`; DNS exposes `fallback-lazy-query` (off by default) and Linux `listen-routing-mark` (0 disables it). A dedicated field sets `default-selected` for `select` groups. The default must be an emitted member; a saved client selection may override it.

Native Clash YAML/JSON supports EasyTier, ZeroTier, MASQUE, WireGuard and OpenVPN. EasyTier, ZeroTier and WireGuard with `peers` do not require top-level `server`/`port`. Native fields are preserved, including ZeroTier `identity-secret`, WireGuard AmneziaWG options and `ip-stack`; AnyTLS `client-metadata` and Hysteria2 `handshake-timeout` are also retained. Use the appropriate core's native configuration; Surge and Mihomo MASQUE formats are not converted into each other. Core configuration validation does not verify remote connectivity.

Merged duplicate nodes retain original name mappings for each source, so chain references still resolve to the retained node. Subscription URIs preserve their transport type; unsupported conversions are omitted with a diagnostic. Hysteria2 links default to port 443 when omitted and retain complete `username:password` authentication.

Configure groups separately for each client. Definitions use `type, members or filter, option=value`, with English commas and no `group-name =` prefix. The page's syntax guide lists the available types and options.

- `{all}` selects proxy nodes, not other groups.
- `fallback` supports `{all}` and its filters, for example `fallback, {all}`. Expanded node order determines failover priority, so changes to node order affect priority. `subnet` does not support this selector.
- `{all filter=Hong Kong,Japan exclude=via,DMIT}` performs case-insensitive substring matching against names and tags, filtering before exclusion. It is not a regular expression.
- Named members may reference nodes, groups and supported built-in policies. Self-references and cycles are invalid.
- `Proxy` must stay enabled and cannot be deleted or renamed. Other empty groups are omitted; routing policies referencing them fall back to `Proxy`. An empty `Proxy` blocks the subscription.
- Update references manually after deleting or renaming a resource.

Surge supports types including `select` and `smart`, with `url-test` converted to `smart`. Clash supports `select`, `url-test`, `fallback` and `load-balance`. sing-box emits `selector` and `urltest`. Options are not interchangeable across clients. Snell 6 is not downgraded to Clash Snell 5; sing-box supports Snell 4/6 conversion. AnyTLS conversion preserves the TLS server name and certificate verification choice, omitting unsupported TCP Fast Open.

### Client configuration

| Page | Purpose |
| --- | --- |
| Network & TUN | Local proxy ports, TUN, interfaces and connection settings; sing-box offers TUN, HTTP, SOCKS and mixed inbounds |
| DNS | Resolvers, DNS rules and caching; includes sing-box's default resolver for connection hostnames |
| Routing rules | Rule-set URLs, individual matches, outbound policies and matching order |
| Tailscale | Configure connections independently in Surge and sing-box; no cross-client copying |
| WireGuard / OpenConnect / OpenVPN | Separate sing-box client connection tabs |
| Advanced | Surge URL Rewrite, Map Local and scripts; sing-box logging and HTTP clients; no Clash tab |
| MITM certificates | Surge only: generate, import or export a CA and configure MITM hostnames |

The sing-box baseline is **1.15.0-alpha.6 (preview)**. Add optional settings through forms; removing an optional field restores core behavior. Device permissions, Always On and application selection must be configured in the actual client.

SubPilot no longer exposes or generates the sing-box TUN `stack` option. Loading or importing existing configurations removes this field, allowing the client to use its own default stack. Version 1.15 uses sing-tun's own TCP/IP stack. Existing 1.14.0 / 1.14.1 documents automatically migrate their version marker while retaining native settings. Configurations using new fields require a compatible 1.15 client.

New 1.15 controls:

- **VPN connections**: WireGuard, Tailscale, OpenVPN and OpenConnect expose `on_demand`, allowing the client to disconnect endpoints when needed; this is not an idle timeout.
- **Advanced → Cache, API & debugging**: `cache_file.buffer_size` controls write buffering (default `1MB`); `flush_interval` controls periodic flushing (e.g. `30s`, disabled by default).
- **Inbound connections → TUN**: supports `multi_queue` (Linux only, with the new stack) and `auto_redirect_tproxy_mark`. Full Android `auto_redirect` requires a root service or root shell.
- **Inbound connections / Advanced → Client native outbounds**: supports Tailcat. Shared nodes can also import native Tailcat JSON, preserving keys and DERP options for sing-box only; Tailcat has no conventional server/port pair. Generate keys with `sing-box generate tailcat-keypair`. Inbounds require a private key; outbounds require server public and discovery keys. Custom `derp_servers` cannot be combined with `derp_map_url` or `derp_region`.
- **Advanced → Services → DERP**: supports `verify_client_inbound` and `verify_client_key`. Inbound references must identify existing Tailcat inbounds. Verified clients need fixed private keys.

New optional settings remain omitted until configured. See the [1.15 changelog](https://sing-box.sagernet.org/changelog/) and [Tailcat documentation](https://sing-box.sagernet.org/configuration/outbound/tailcat/).

### Tailscale

Connection names can be used in the current client's groups and routing rules. Enabled Surge nodes use either an auth key or interactive login, never both. Complete interactive sign-in in the Surge policy editor; identity stays on that device, and renaming the section may require signing in again. sing-box may leave it empty and authorize through the login URL in client logs; use a separate state directory for each instance. Authentication keys are masked in the editor.

SubPilot generates configuration and does not log into Tailscale on the client's behalf. See the [sing-box Tailscale documentation](https://sing-box.sagernet.org/configuration/endpoint/tailscale/).

Surge exposes `auto-add-magic-dns-rule`, enabled by default, for automatic MagicDNS and visible-peer address routing. Subnets and exit traffic still require explicit rules. Existing idle keepalive values are preserved. Test URLs accept HTTP and HTTPS; HTTPS needs a Surge Beta with support for this feature, and TLS handshakes may increase test duration.

### Surge groups and rule compatibility

The group editor provides a `category` field and a dedicated Smart priority input. Enter one `regex:factor` per line, for example `Premium:0.9`. The first match wins; factors must be finite positive numbers, with values below 1 increasing preference. Quoted patterns preserve commas and quantifiers. `url-test` continues to render as `smart`.

Category and HTTPS testing follow the [Surge Beta announcement](https://t.me/SurgeTestFlightFeed/413) and require a compatible client. Mac 6.9.1 / iOS 5.22.1 introduced `GEOIP,UNKNOWN` and `IP-ASN,UNKNOWN`, supported in Surge individual rules, logical rules and compiled rule sets. These semantics are not translated into ASN or GeoIP matches for other clients.

### Routing rules

The sing-box DNS tab separates three purposes: **DNS server list** manages available servers; **Fallback DNS server for queries** handles queries that match neither rule-set DNS nor advanced DNS rules, using the first listed server when empty; **Default DNS for establishing connections** resolves proxy server addresses and unresolved direct-connection targets. A connection-specific resolver takes priority, and connection resolution may bypass DNS query routing rules.

On the sing-box DNS tab, native rules appear under **Advanced DNS rules**, collapsed by default with a configured-rule count. Configure rule-set DNS on the Routing rules tab; advanced DNS rules match afterward. Collapsing the section does not disable existing rules.

The rule-set editor includes a **DNS resolver** field; empty inherits global settings, and the list shows the current selection. Here, Clash means Clash Verge with the Mihomo core. Surge / Clash accept one IP, IP:port, `system`, or encrypted DNS URL; sing-box selects an existing server from the DNS tab. Save and update the client subscription. No KV schema migration or extra deployment steps are required.

- Surge emits `[Host]` `RULE-SET:` / `DOMAIN-SET:` DNS mappings, requiring Mac 5.10+ / iOS 5.14.3+. Existing Host mappings take priority; bindings follow routing-list order. Remote proxy resolution is not guaranteed to use this resolver. Entries with a DNS assignment do not aggregate by outbound policy.
- Clash emits `dns.nameserver-policy` and requires DNS to be enabled. IP-only (`ipcidr`) providers cannot assign a resolver. This setting selects a resolver; it does not select the DNS connection outbound or guarantee remote proxy resolution behavior.
- sing-box generates a separate `-dns.json` set (`dns.srs` in the repository when SRS compilation is enabled) containing standalone DOMAIN, DOMAIN-SUFFIX, DOMAIN-KEYWORD, DOMAIN-REGEX and DOMAIN-WILDCARD rules, excluding IP, process and logical rules. Bindings follow routing-list order before native DNS-tab rules; empty domain sets produce a notice. Update bindings after deleting or renaming a referenced DNS server before saving.


1. Select a client and open Routing rules. Add a rule set or direct rule.
2. Enter rule-set URLs, one per line, then select the format and outbound policy.
3. Arrange rules by matching priority. Surge uses `FINAL`, Clash uses `MATCH`, and sing-box's `FINAL` row represents `route.final`. The final row cannot be deleted, disabled or moved; its outbound can be changed.
4. Apply changes, save, then update the subscription in the client.

| Client | Rule-set settings |
| --- | --- |
| Surge | `RULE-SET` or `DOMAIN-SET`, plus supported rule options |
| Clash | Source format: automatic, Clash YAML, domain/IP-CIDR/classical text; `behavior`: domain / ipcidr / classical; `interval` in seconds, default 86400 |
| sing-box | Automatic or explicit Clash, Surge, domain, IP-CIDR or classical source format; independent direct SRS downloads |

A single compatible Surge source, or a single compatible Clash source with an explicit format, is downloaded by the client without Worker fetching or caching. Clash automatic mode detects actual content and compiles it, even for a single URL; it never guesses the format from an extension. This supports extensionless URLs, `.conf` URLs and extensions that do not match the content. The selected format applies to all URLs in the entry; changing a shared source's format does not change other entries. Multiple URLs within one entry are merged and deduplicated. Clash `rule-providers` are generated automatically. Separate Clash and sing-box entries remain independent; Surge optionally aggregates by policy, which can change matching order.

Surge compilation preserves the user's `no-resolve` choice and does not add it merely because a set contains IP-CIDR rules. Source `extended-matching` options remain in RULE-SET output. Options that DOMAIN-SET cannot express, and extended matching without an equivalent in another client, produce diagnostics and block incompatible output. Native Clash HTTP providers without an explicit `path` receive distinct cache paths that also avoid explicitly assigned paths.

Clash and Surge sources require conversion for sing-box even with one URL. `IP-ASN` expands into IPv4/IPv6 CIDRs and updates periodically. Resolution failures use cached data when possible; otherwise the ASN is skipped with a notice. Unsupported rules such as `USER-AGENT` and `URL-REGEX` are skipped. Download failures and invalid source formats are reported as errors. Generated remote rule sets use a direct HTTP client for downloading.

In automatic mode, each sing-box `.srs` URL becomes an independent `remote` / `binary` rule set downloaded and updated by the client. Select SRS explicitly for binary URLs without that extension. When an entry mixes SRS and text sources, each SRS remains independent and only text is merged and compiled; all use the entry's outbound policy. The Worker does not download, parse or cache user-supplied native SRS sources. With a DNS resolver assigned, SRS is referenced directly by native DNS rules and must be suitable for DNS matching; text sources still contribute only standalone domain rules.

The native sing-box route and rule-set editor remains available after enabling the unified rule plan, with native rules retaining priority. Converting native Clash routing discards dormant shared or Surge plan entries and keeps the current native rules and providers. A failed conversion preserves the original configuration.

Generated files use `.list`, `.yaml` and `.json` for Surge, Clash and sing-box respectively by default; the optional feature below changes sing-box rule sets to `.srs`. The same name can be used independently across clients.

### Optional Actions rule compilation

Disabled by default. With the option off, the Worker continues to fetch, merge, deduplicate, convert and rebucket rule sources, producing Surge `.list`, Clash `.yaml` and sing-box `.json` files. When enabled, GitHub Actions performs this work for all three clients: it downloads original sources, uses the same compilation core as the Worker, and compiles sing-box results into SRS with **1.15.0-alpha.6**. The Worker prefers confirmed Actions artifacts. While they are pending, it reuses local caches matching the current configuration, or fetches, merges, deduplicates and buckets rules itself to keep subscriptions available.

The output branch is fixed to **`rules`** and is not editable. Each client has its own directory, so identical rule-set names remain independent:

| Client | Example directory | Artifacts |
| --- | --- | --- |
| Surge | `Surge/OpenAI/` | `routing.list`, `domains.list` |
| Clash | `Clash/OpenAI/` | `routing.yaml`, `domains.yaml`, `ip-ranges.yaml` |
| sing-box | `Sing-Box/OpenAI/` | `routing.srs`, `domains.srs`, `ip-ranges.srs`, `dns-domains.srs` |

Only needed files are generated, alongside `README.md` and a publication receipt, `manifest.json`. Unicode names are supported; unsafe, long or reserved names receive a safe name and hash suffix. Compatible single direct sources, user-provided native SRS and individual rules retain their existing behavior and are not uploaded as merging jobs.

1. Prepare an initialized public repository with Actions enabled and a README. Its default branch hosts the workflow and must differ from `rules`. Use a separate repository per SubPilot deployment.
2. Create a fine-grained GitHub token for that repository with **Actions, Contents, Workflows and Secrets: Read and write**. Complete organization approval if required.
3. Enable and save a rule plan for at least one client. Open **System settings → Actions rule compilation → Setup wizard** and enter the repository, workflow callback address and token.
4. Select **Check, install and enable**. The wizard installs `compile-rule-sets.yml`, the runner and the shared compiler, saves the new settings and submits the initial batch without saving other drafts. Credentials are encrypted separately; GitHub Secrets store `SUBPILOT_ACTIONS_SECRET` and `SUBPILOT_URL`.
5. Prefer this deployment's workers.dev callback address to avoid custom-domain bot challenges. The wizard checks format only; the first run verifies connectivity and dispatch permission.
6. Open **View compilation progress** to inspect Surge, Clash and sing-box separately. Subscriptions can use Worker rules during compilation; update after confirmation to switch to Actions artifacts. GitHub accepting a request does not prove it is running; check repository Actions for queue and execution details.

During initial setup, rule-plan changes or Actions failures, the Worker handles rule sets without confirmed artifacts. Dispatch or callback failures do not block Worker processing. Each rule set independently selects confirmed remote artifacts or Worker caches matching its current plan; a subscription can use both. sing-box falls back to JSON and switches to SRS on a subscription update after publication. Previously issued managed JSON URLs keep returning JSON and refreshing on demand. Confirmed publications remain usable during refresh failures when their plan is unchanged. Disable and save to use the Worker for all processing.

The Worker attempts missing compilation within a bounded request budget. Existing errors or HTTP `503` with `Retry-After` apply only when neither remote artifacts nor complete local rules are available and source retrieval fails or processing remains unfinished; background preparation continues. Pending Actions alone never blocks a subscription, and fallback never serves caches from a different rule plan.

Saved rule changes, manual refresh and daily refresh can trigger Actions. One batch covers all clients and downloads each source once. Published outputs are reused when source bodies, compilation inputs and valid ASN data are unchanged. The sing-box compiler is downloaded only when SRS generation is needed, once per batch. An output failure does not stop other outputs. Existing five-minute maintenance checks recover unfinished jobs with a 60-minute automatic dispatch interval; **Resubmit compilation** bypasses that interval. No additional GitHub schedule is needed.

Each output's files and receipt are published atomically in one commit. Replacing its directory removes obsolete buckets while preserving other outputs; branch conflicts are retried without force-pushing. The Worker validates the receipt at an immutable commit before referencing artifacts, and subscription URLs include that commit to avoid later unconfirmed content. Update client subscriptions after a new publication. Disabling the feature or deleting a rule set does not erase public files or Git history.

Settings use `settings.actionsCompilation`; status is available at `GET /api/actions-compilation/status`. Old SRS-specific settings, credentials, workflows, callbacks and artifact paths are neither read nor migrated. Existing deployments must run the shared setup wizard again and can remove obsolete workflows and artifacts themselves.

Encrypted rule-plan snapshots remain in KV for 24 hours for authenticated Actions downloads. Normal Actions runs download original source bodies to temporary runner storage, remove them on completion and exclude them from the repository. Worker fallback uses the existing encrypted source and compiled-rule caches. The Worker keeps Actions publication metadata without storing or proxying its artifact bodies. Rule-set names and generated rules are public; source addresses, Worker addresses and credentials are excluded from artifacts and logs. The token and shared secret are encrypted separately and excluded from configuration exports. Replacing the token preserves the shared secret; clearing and reconfiguring requires reinstalling the workflow. `ADMIN_TOKEN_HASH` and `CONFIG_ENCRYPTION_KEY` remain Worker Secrets.

Deployment builds run `npm run build:actions` to bundle the shared compiler for installation by the wizard. Generated files live in ignored `dist/` and are not committed; dependency installation also builds the bundle.

### Subscription checks

Under Configuration links, select a client in Subscription checks to inspect the saved configuration. Missing outbounds, cycles and incompatible settings can produce HTTP 422. Unsupported nodes may be omitted with a diagnostic. Correct the configuration, save and check again.

Configuration validation is not a connectivity test. Check sing-box startup logs, permissions, certificates and node connectivity on the actual device.

## Updates and migration

### Update an existing deployment

Read the [release notes](https://github.com/tnt2ray/subpilot-worker/releases) first. **The following command updates local program files, installs runtime dependencies, and deploys to the Worker in local `wrangler.jsonc`:**

```bash
npm run update
```

For a Git clone, it requires clean tracked files and pulls the current branch with `--ff-only`. For a release-archive installation, it prefers the latest `subpilot-worker-vX.Y.Z.tar.gz`, falls back to the source archive when that attachment is absent, and replaces managed program files. Both paths preserve `wrangler.jsonc` and existing Secrets. Do not remove that file or replace `CONFIG_ENCRYPTION_KEY`: existing encrypted data depends on the same key.

`npm run update -- --no-deploy` skips only the final deployment. It still updates code, dependencies, and local configuration, so it is not a read-only check.

The setup script adds the pending-rebuild schedule while retaining your existing subscription interval. Confirm all three schedules after upgrading; see [Cache and operational limits](#cache-and-operational-limits). The current version appears below “Sign out” in the sidebar, replaced by green “Update available” text when a new version is detected. Scheduled version checks are disabled by default; when enabled, GitHub Releases is checked at most daily and a bound Telegram chat receives one notification for each newly detected version.

### Upgrading from 1.4.0 to 2.0.0

1. Retain `wrangler.jsonc`, the KV namespace, `ADMIN_TOKEN_HASH` and `CONFIG_ENCRYPTION_KEY`. Update the application as described above; do not generate a replacement encryption key.
2. Reload the dashboard, review the migration draft and confirm. Version 1 documents from 1.4.0 migrate to document version 3; the KV schema is 12.
3. Surge, Clash and shared nodes are retained with independent groups and rule sources. **Upgrades from version 1 documents use sing-box's own DNS, TUN, outbound interface detection, Proxy group and FINAL rule defaults. Tailscale connections start empty, and no settings are read from other clients.**
4. Review sing-box inbounds, DNS, groups and routing, then run a subscription check before use. Existing version 3 sing-box settings saved in 2.0 are not cleared by an application update; historical cross-client migration diagnostics are removed automatically.
5. Copy the universal URL from Configuration links and update your clients. Existing `/sync/<read_token>/` URLs remain usable if the base path and token are unchanged. Replace old client-specific or tagged URLs. Stash and Shadowrocket output is no longer available.

Reviewing a draft does not commit it. After confirmation, the Worker writes and reads back the new snapshot, then schedules legacy cleanup after a grace period of at least five minutes. If the old configuration changes during migration, reload and review the draft again.

Existing development version 2 documents are automatically split into version 3 while retaining their sing-box settings; they are not treated as first-time migrations from 1.4.0.

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

Replace the example domain, or use `SUBPILOT_BASE_URL` to provide the URL. The script does not export configuration files; the former `--backup` option and `SUBPILOT_BACKUP_PATH` environment variable have been removed. Review and save each client’s settings after migration.

</details>

## Cache and operational limits

Enabled upstream subscriptions are fetched into encrypted KV cache. Requests prefer cached content; failed refreshes try to retain usable old entries. Rule-source bodies share cache, while compiled artifacts remain separate for each client. Refreshes have execution deadlines, retain successful results, and report individual failures; once the deadline is reached, no new remote fetches or compilations start.

With Actions disabled, sing-box configuration and hosted rule downloads only read complete JSON rule caches matching the current configuration and compiler version. When first use, rule changes, or an upgrade invalidate those JSON caches, the server promptly returns HTTP `503` with `Retry-After` and prepares rules in background batches. Retry the configuration update after the indicated delay. **Subscription check** also starts preparation and reports its status. A complete configuration is returned once every required JSON cache is ready. Actions mode prefers confirmed remote artifacts and falls back to Worker processing while they are pending; update the subscription after confirmation to switch to Actions artifacts.

Saving configuration that affects rule output immediately records pending work in KV and starts a background update. If the execution budget runs out, the five-minute schedule continues unfinished work. Closing the admin page or stopping client updates does not stop this progress. The five-minute task only processes pending work; it does not refetch all upstream sources every 5 minutes, and needs no additional storage binding or secret.

The daily rule task checks upstream content hashes and recompiles when source content, relevant configuration, or the compiler version changes, ASN data expires, or cache is missing. Unchanged source bodies are retained, and recompilation is skipped when the other compiler inputs still match and complete artifacts remain usable. Older artifacts without source hashes are rebuilt once during the next rule check to establish a comparison baseline. Batch checks process sources individually instead of retaining all source bodies together.

The following describes local Worker compilation. Actions retries, logs and remote artifact retention follow the optional compilation section above.

Failed background compilations briefly back off before retrying so other rule sets can make progress. Recognized source-format or configuration-reference errors appear in subsequent subscription checks and return HTTP `422` on subscription downloads. When only ASN data has expired and the configuration and compiler version still match, existing complete artifacts remain available while ASN data refreshes in the background. An incomplete background ASN lookup without usable cached prefixes prevents publishing an artifact with missing rules. Background work has an execution budget, so large batches may need several scheduled continuations to finish.

Rule sources share one complete encrypted body per URL; subscription sources share one per URL and effective User-Agent. Successfully fetched new content replaces earlier content without keeping source history. A complete successful compiled version replaces earlier versions, which are then removed. Edge cache entries use stable URLs with version validation and overwrite previous responses.

After deleting a rule set or source, or changing its URL and saving, background cleanup removes unreferenced source bodies, metadata and compiled artifacts. Caches still used by another active rule or client remain. Source configuration entries with no rule-entry references are also removed. Saving or refreshing automatically cleans historical caches; no KV schema migration or extra deployment steps are required. Old edge copies expire according to their cache lifetime; rule-download endpoints stop using deleted entries once they read the newly saved configuration.

The default schedules in local `wrangler.jsonc` are:

```json
{
  "triggers": {
    "crons": ["0 */12 * * *", "0 16 * * *", "*/5 * * * *"]
  }
}
```

The first entry refreshes subscriptions every 12 hours; keep your chosen interval if different. `0 16 * * *` is reserved for daily rule-source change detection, and `*/5 * * * *` for pending rebuilds every 5 minutes. Other cron entries refresh subscriptions. Existing deployments must add `*/5 * * * *` to `triggers.crons` in private `wrangler.jsonc` and redeploy; `npm run setup` and `npm run update` add it if missing. Without it, background work still starts immediately, but unfinished work cannot continue through the five-minute task. No new bindings or Secrets are required. Cron uses UTC; changes require deployment and time to propagate through Cloudflare. [Cron configuration](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

Use **Force refresh** on the overview to refresh subscriptions. Save drafts before refreshing. Admin and Telegram times use the configured display time zone in `yyyy-mm-dd hh:mm:ss`; stored timestamps remain UTC.

| Scope | Limit |
| --- | --- |
| Configuration request | 6 MiB |
| Entities | 20 shared subscription sources, 500 shared manual nodes; 100 policy groups per client; no separate rule-source count limit |
| Compiled outputs | 40 per client |
| One remote input | 4 MiB per subscription source; 16 MiB per text rule source compiled by the Worker, reserving room for encryption and memory; client downloads are exempt |
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
2. In the **Telegram** section of **System settings**, enter the Bot Token and save. Chat ID and binding actions are grouped in the same section. A non-empty token enables Telegram notifications and configures the webhook; clearing it disables notifications.
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

To change the receiving chat, click **Unbind**, generate a new code, and bind again. Unbinding takes effect immediately and preserves other unsaved configuration drafts on the page. If the bot token changes, the old chat binding is cleared; save the new token and bind again. Clearing the token removes the old webhook. If binding fails, check the token, code expiry, Telegram API access, and chat permissions; for a leaked token, revoke it through BotFather before replacing it. See Telegram's [bot features](https://core.telegram.org/bots/features) and [FAQ](https://core.telegram.org/bots/faq).

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
- Configuration snapshots, subscription/rule-source caches, Worker-compiled JSON/text rules, and recoverable subscription read tokens are encrypted. Telegram tokens and other private configuration values are protected within the encrypted snapshot. Preserve the encryption key across updates and migration.
- Optional GitHub Actions artifacts use the fixed `rules` branch of a public repository, with separate client directories. The dispatch token and shared secret use a separate encrypted KV record; the shared secret is also configured in Actions Secrets.
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
