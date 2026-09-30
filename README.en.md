# SubPilot Worker

Language: [中文](./readme.md) | English

Generate independent Surge, clash, and sing-box configurations from shared resources. SubPilot runs on Cloudflare Workers, stores encrypted configuration in Workers KV, and provides a browser admin UI.

[Overview](#overview) · [Deployment](#deployment) · [First use](#first-use) · [Subscription URLs](#subscription-urls) · [Configuration](#configuration) · [Updates and migration](#updates-and-migration) · [Cache and operational limits](#cache-and-operational-limits) · [Telegram and GeoIP](#telegram-and-geoip) · [Security and data](#security-and-data) · [Local development](#local-development) · [License](#license)

## Overview

Subscription sources, manual nodes, and chain exits are shared. Policy groups, disabled states, and rule sources belong to each client. Network, DNS, routing, and advanced settings are independent for each client. Subscription generation validates the selected client configuration and blocks output when conversion would lose critical behavior.

| Capability | Surge | clash | sing-box |
| --- | --- | --- | --- |
| Output | `.conf` | Clash-compatible `.yaml` | Native JSON for **1.15.0-alpha.8 (preview)** |
| Nodes and groups | Supported protocols and group types | Supported protocols and group types | Native outbounds, `selector` / `urltest`, endpoint references |
| Native routing | Surge rule text | `rules` + `rule-providers` | JSON `route` |
| Compiled rule sources | `.list` | `.yaml` | JSON source `.json`, or optional Actions processing to `.srs` |
| Network and DNS | Surge settings | clash settings | Native inbounds and DNS |
| Rewrite / Map Local / MITM / scripts | Retained | Omitted | Omitted |
| Tailscale | Dedicated native form | Native Mihomo proxy with a dedicated form | Native endpoint with a dedicated form |

The admin UI provides subscription checks, a universal subscription link, token rotation, cache refresh, GeoIP renaming, and Telegram notifications.

The overview shows the latest 50 subscription requests, node counts, and subscription cache status. **Force refresh** fetches saved, enabled sources again. Refresh failures show the reason and whether cached content remains available.

## Deployment

### Prerequisites

You need a Cloudflare account, Git or a release archive, Node.js **22.12 or later**, and npm. Builds and deployment use the project's Cloudflare `cf` CLI and Vite dependencies, so include development dependencies when installing. A global Wrangler installation is not required. The project currently pins preview versions of `cf` and the Cloudflare Vite plugin.

### Recommended setup

Obtain the source, install dependencies, and sign in:

```bash
git clone https://github.com/tnt2ray/subpilot-worker.git
cd subpilot-worker
npm install --include=dev
npm run cf -- auth login --mode template
```

Alternatively, extract `subpilot-worker-vX.Y.Z.tar.gz` from [GitHub Releases](https://github.com/tnt2ray/subpilot-worker/releases), enter its directory, install dependencies with `npm install --include=dev`, and sign in with `npm run cf -- auth login --mode template`.

**The following command creates or configures Cloudflare resources and deploys the Worker and admin UI:**

```bash
npm run setup
```

On a new installation, setup creates `cloudflare.local.json` from `cloudflare.example.json`, creates or reuses the `SUBPILOT_CONFIG` KV namespace, and asks for the source refresh interval (1–24 hours, default 12). It checks remote Secrets, requests an admin token of at least 24 characters when the admin credential is missing, and uses a supplied or generated encryption key when that Secret is missing. It writes the missing Worker Secrets, builds, and deploys. Keep the admin token in a password manager.

Setup reuses an existing `cloudflare.local.json`. If only the old `wrangler.jsonc` exists, setup can convert the deployment fields supported by this project and preserves the original. Unsupported custom fields or build settings stop conversion; follow the message to migrate them manually before retrying. After successful conversion, subsequent runs use `cloudflare.local.json`, retaining the existing Worker, KV namespace, and Secrets, and writing only missing Secrets. After an invalid token or failed deployment interrupts first-time setup, correct the problem and rerun `npm run setup`; an existing configuration file does not skip unfinished Secret initialization. Setup stops without writing Secrets if their remote state cannot be verified. `npm run setup -- --force-secrets` also deploys and replaces both Secrets; use it only for an intentional reset or planned rotation. **Preserve the existing `CONFIG_ENCRYPTION_KEY` when reusing encrypted KV data.**

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
<summary>Customize deployment settings</summary>

After installing dependencies and signing in, you may copy the public example before running setup. Skip the copy if a local configuration already exists or you need to migrate an old one:

```bash
cp cloudflare.example.json cloudflare.local.json
```

Set `worker.name` in `cloudflare.local.json`. To reuse KV, set `worker.env.SUBPILOT_CONFIG.id` to the existing namespace ID; retain the example structure for other bindings. Run setup to check resources, fill in missing Secrets, and deploy:

```bash
npm run setup
```

After later changes to deployment settings or application code, redeploy with:

```bash
npm run deploy
```

For additional Worker Secrets, declare each name under `worker.env` as `{ "type": "secret" }` so ordinary deployments preserve it. Keep the values in Worker Secrets.

</details>

For a custom domain, connect it to the Worker in Cloudflare or configure `worker.domains` in local `cloudflare.local.json`. Keep that file untracked. Secret values remain in Worker Secrets and must not be entered in the local configuration. The example includes subscription refresh, daily rule-change detection, and pending rebuilds every 5 minutes; see [Cache and operational limits](#cache-and-operational-limits).

## First use

Open the deployment URL and sign in with the admin token.

1. In **System settings**, confirm Managed Base URL (usually `https://<your-domain>/sync`) and the display time zone.
2. In **Sources**, add upstream subscriptions and their fetch User-Agents. In **Proxy nodes**, add manual nodes and chain exits as needed. The node editor shows **Upstream node selection** only when **Chain exit** is enabled; turning it off hides the field while retaining its values. Enter one keyword per line: a case-insensitive substring match against any keyword in a node name or label selects that node; regular expressions are not supported. Only matching non-exit nodes generate chained nodes; unmatched nodes do not participate, and an empty selection generates none. The path is device → matching node → current exit node → destination.
3. In **Policy groups**, select a client, then configure its members, filters, and options.
4. In **Client configuration**, choose Surge, clash, or sing-box and edit its network, DNS, routing, and advanced settings.
5. For compiled routing, enter source URLs directly in the selected client’s routing tab and choose a policy. Sources are linked automatically within that client; move rule sets and direct rules up/down in one list. Select RULE-SET or DOMAIN-SET in Surge, behavior and interval in Clash, and the source format in sing-box.
6. Save the configuration, run a subscription check in **Configuration links**, and copy the universal subscription URL.

System settings are ordered as **Preferences → Node processing → Subscription and fetching**. Choose the display time zone from a dropdown that also preserves the currently configured zone. Node processing shows excluded keywords as tags and feature tags as rows of names and matching keywords. Use the edit icon beside each title to make changes.

To update an existing subscription source, proxy node, or policy group, click its name or the row’s **Edit** button. Choose **Apply changes** in the dialog, then **Save configuration** at the bottom of the page to persist the changes. On narrow screens, the action column remains visible while other details scroll horizontally.

The page header and bottom action bar remain visible. Long content scrolls within the space between them, keeping the last items clear of the action bar.

Headings group their text with a question mark immediately after it, with action buttons outside this group. Feature introductions and longer usage instructions appear in these help tips. Click to read, then click outside or press Escape to dismiss. Errors, progress, required inputs and save reminders remain directly visible.

Each page loads its latest data when you open it and does not update automatically while it stays open. To see newer status, open the page again, or select Refresh status in the Actions compilation progress dialog. Configuration is loaded when you open the admin UI, and edits are saved manually.

Drafts stay in the current page's memory while navigating between pages and clients. Reloading or closing the page loses unsaved edits. Subscription requests use saved configuration and check compatibility before generating output.

Before updating an existing deployment, check the [configuration format requirements](#configuration-format-requirements).

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

Surge, Clash and sing-box no longer convert, copy or initialize settings from one another. Fresh installations use sing-box's own native DNS, TUN inbound, outbound interface detection, Proxy group and FINAL rule defaults, with DNS reverse mapping enabled. Native routing rules include general sniffing followed by DNS query handling to support domain-based matching. Tailscale connections start empty. Proxy outbounds come from shared nodes and the current client's groups. New defaults do not overwrite saved configurations that use the current format.

Configuration previews and modal editors include line numbers and syntax highlighting. Apply changes in the editor, then click Save configuration.

### Nodes and policy groups

Proxy nodes accepts Surge node syntax, Clash YAML/JSON and native sing-box JSON. sing-box input may be one node, an array or an object containing `outbounds`; DNS, routing and groups from that input are not imported.

Clash targets Mihomo **v1.19.31**: TUN supports `mips`; DNS exposes `fallback-lazy-query` (off by default) and Linux `listen-routing-mark` (0 disables it). A dedicated field sets `default-selected` for `select` groups. The default must be an emitted member; a saved client selection may override it.

Native Clash YAML/JSON supports Tailscale, EasyTier, ZeroTier, MASQUE, WireGuard and OpenVPN. Tailscale, EasyTier, ZeroTier and WireGuard with `peers` do not require top-level `server`/`port`. Native fields are preserved, including ZeroTier `identity-secret`, WireGuard AmneziaWG options and `ip-stack`; AnyTLS `client-metadata` and Hysteria2 `handshake-timeout` are also retained. Use the appropriate core's native configuration; Surge and Mihomo MASQUE formats are not converted into each other. Core configuration validation does not verify remote connectivity.

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
| Tailscale | Configure connections independently in Surge, Clash / Mihomo and sing-box; no cross-client copying |
| WireGuard / OpenConnect / OpenVPN / MASQUE | Separate sing-box endpoint configuration tabs |
| Advanced | Surge URL Rewrite, Map Local and scripts; sing-box logging and HTTP clients; no Clash tab |
| MITM certificates | Surge only: generate, import or export a CA and configure MITM hostnames |

The sing-box baseline is **1.15.0-alpha.8 (preview)**. Add optional settings through forms; removing an optional field restores core behavior. Device permissions, Always On and application selection must be configured in the actual client.

sing-box TUN uses the core's default stack. The old `stack` field is unsupported; configurations containing it are rejected. Remove it before saving or importing.

Native routing and advanced DNS rules support `dns_server_address` and `dns_search_domain`, including nested logical rules. Select an existing local, dhcp, resolved, tailscale, openvpn or openconnect DNS server, then enter IP addresses/CIDRs or search domains to choose routing and DNS policies based on the system, DHCP or VPN DNS environment. These conditions match the current network's DNS configuration, not destination IPs or queried domains. Referenced DNS servers must exist and use a supported type; remove references before deleting a server. These optional conditions are not added by default.

Use **Advanced → Client native outbounds** to configure HTTP, Tailcat and other connections, then reference them in the current client's groups and rules. HTTP outbounds without an explicit version prefer HTTP/2 with fallback, or HTTP/1.1 when `path` or a `Host` header is set. Explicit version and fallback settings are preserved; clear the version field to restore the default selection.

For protocol fields and requirements, see the [sing-box configuration documentation](https://sing-box.sagernet.org/configuration/), [HTTP outbound](https://sing-box.sagernet.org/configuration/outbound/http/) and [Tailcat outbound](https://sing-box.sagernet.org/configuration/outbound/tailcat/).

### Tailscale

Connection names can be used in the current client's groups and routing rules. Enabled Surge nodes use either an auth key or interactive login, never both. Complete interactive sign-in in the Surge policy editor; identity stays on that device, and renaming the section may require signing in again. Mihomo and sing-box may leave the auth key empty and authorize through the login URL in client logs; use a separate state directory for each instance. Authentication keys are masked in the editor.

For Clash, add connections under **Client configuration → Clash → Tailscale**. This requires Mihomo v1.19.25+ built with Tailscale support; original Clash is not supported. New connections receive separate state directories, and optional switches retain core defaults; UDP forwarding defaults to off. Nodes from this page do not automatically join `{all}`: add them explicitly to groups or routing rules. Tailscale starts on the first matching connection, so wait for sign-in and retry if needed. Public internet traffic requires an available exit node; Tailnet subnets require accepting subnet routes and configuring matching rules. Save and update the client subscription. Existing connections in each client are preserved.

SubPilot generates configuration and does not log into Tailscale on the client's behalf. See the [Mihomo Tailscale documentation](https://wiki.metacubex.one/en/config/proxies/tailscale/) and [sing-box Tailscale documentation](https://sing-box.sagernet.org/configuration/endpoint/tailscale/).

Surge exposes `auto-add-magic-dns-rule`, enabled by default, for automatic MagicDNS and visible-peer address routing. Subnets and exit traffic still require explicit rules. Existing idle keepalive values are preserved. Test URLs accept HTTP and HTTPS; HTTPS needs a Surge Beta with support for this feature, and TLS handshakes may increase test duration.

### Surge groups and rule compatibility

The group editor provides a `category` field and a dedicated Smart priority input. Enter one `regex:factor` per line, for example `Premium:0.9`. The first match wins; factors must be finite positive numbers, with values below 1 increasing preference. Quoted patterns preserve commas and quantifiers. `url-test` continues to render as `smart`.

Category and HTTPS testing follow the [Surge Beta announcement](https://t.me/SurgeTestFlightFeed/413) and require a compatible client. Mac 6.9.1 / iOS 5.22.1 introduced `GEOIP,UNKNOWN` and `IP-ASN,UNKNOWN`, supported in Surge individual rules, logical rules and compiled rule sets. These semantics are not translated into ASN or GeoIP matches for other clients.

### Routing rules

The sing-box DNS tab separates three purposes: **DNS server list** manages available servers; **Fallback DNS server for queries** handles queries that match neither rule-set DNS nor advanced DNS rules, using the first listed server when empty; **Default DNS for establishing connections** resolves proxy server addresses and unresolved direct-connection targets. A connection-specific resolver takes priority, and connection resolution may bypass DNS query routing rules.

The sing-box DNS tab provides a **DNS reverse mapping** switch to associate DNS answers with subsequent TUN connections. Native DNS rules appear under **Advanced DNS rules**, collapsed by default with a configured-rule count. Configure rule-set DNS on the Routing rules tab; advanced DNS rules match afterward. Collapsing the section does not disable existing rules.

Under **Routing rules → Routing & rule sets → Configure**, choose an action before adding a new rule. Each rule separates action settings from match conditions. For general domain sniffing, choose `sniff` and leave match conditions empty. Add a separate `hijack-dns` rule for DNS query handling; its preset matches the DNS protocol. Place sniffing before DNS handling and routing rules. **Detected protocol** is a condition evaluated before the action; **Sniffer** selects the sniffing methods. Omitted optional settings use the core defaults. Added settings require a value or selection instead of automatically using the first enum option or port `0`. Apply changes, save configuration, and update the client subscription.

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

Clash and Surge sources require conversion for sing-box even with one URL. `IP-ASN` expands into IPv4/IPv6 CIDRs and updates periodically. Resolution failures use cached data when possible; otherwise the ASN is skipped with a notice. Unsupported rules such as `USER-AGENT` and `URL-REGEX` are skipped. Download failures and invalid source formats are reported as errors. Worker-generated remote rule sets download through the `Proxy` group (`http_client.detour: "Proxy"`), including Actions SRS, Worker-hosted JSON and native SRS sources. Select a working proxy in this group in your client. This affects rule downloads only, not the traffic policies of the rules.


The Worker configures rule-set download routing when generating profiles:
- **sing-box**: generated remote rule sets use `http_client.detour: "Proxy"`.
- **Clash / Mihomo**: HTTP rule providers default to `proxy: Proxy`, preserving explicitly configured download proxies. File and inline providers are unchanged.

After upgrading, update client subscriptions and select a working node in `Proxy`.


In automatic mode, each sing-box `.srs` URL becomes an independent `remote` / `binary` rule set downloaded and updated by the client. Select SRS explicitly for binary URLs without that extension. When an entry mixes SRS and text sources, each SRS remains independent and only text is merged and compiled; all use the entry's outbound policy. The Worker does not download, parse or cache user-supplied native SRS sources. With a DNS resolver assigned, SRS is referenced directly by native DNS rules and must be suitable for DNS matching; text sources still contribute only standalone domain rules.

The native sing-box route and rule-set editor remains available after enabling the unified rule plan, with native rules retaining priority. Converting native Clash routing discards dormant shared or Surge plan entries and keeps the current native rules and providers. A failed conversion preserves the original configuration.

Generated files use `.list`, `.yaml` and `.json` for Surge, Clash and sing-box respectively by default; the optional feature below changes sing-box rule sets to `.srs`. The same name can be used independently across clients.

### Optional Actions rule compilation

Disabled by default. With the option off, the Worker continues to fetch, merge, deduplicate, convert and rebucket rule sources, producing Surge `.list`, Clash `.yaml` and sing-box `.json` files. When enabled, GitHub Actions performs this work for all three clients: it downloads original sources, uses the same compilation core as the Worker, and compiles sing-box results into SRS with **1.15.0-alpha.8**. The Worker prefers confirmed Actions artifacts. While they are pending, it reuses local caches matching the current configuration, or fetches, merges, deduplicates and buckets rules itself to keep subscriptions available.

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
   Use the setup wizard both to configure and replace the token. An existing token is shown as a mask; keep it unchanged to reuse it, or enter a new value to replace it. On desktop, labels and inputs share aligned columns; narrow screens stack them. Related links follow their fields, and the branch input in Advanced settings uses the same alignment. The token field shows only the repository selection reminder, without repeating the permission list. “Create token (preset permissions)” preselects no expiration (subject to organization lifetime policies), Actions, Contents and Secrets read/write plus Workflows write; choose the resource owner and limit access to the target repository on GitHub. A question mark beside the outer Actions heading combines compilation, public rule visibility, token permissions and setup guidance; the wizard title has no question mark. System settings show Actions configuration and controls only when Actions compilation is enabled. Telegram hides Chat ID and binding controls until a Bot Token is entered. Hiding fields preserves their values.
4. Select **Check, install and enable**. The wizard installs `compile-rule-sets.yml`, the runner and the shared compiler, saves the new settings and submits the initial batch. On success, the page immediately updates the toggle and repository details without saving other drafts. Credentials are encrypted separately; GitHub Secrets store `SUBPILOT_ACTIONS_SECRET` and `SUBPILOT_URL`.
5. Prefer this deployment's workers.dev callback address to avoid custom-domain bot challenges. The wizard checks format only; the first run verifies connectivity and dispatch permission.
6. Open **View compilation progress** to inspect Surge, Clash and sing-box separately. Subscriptions can use Worker rules during compilation; update after confirmation to switch to Actions artifacts. GitHub accepting a request does not prove it is running; check repository Actions for queue and execution details.

During initial setup, rule-plan changes or Actions failures, the Worker handles rule sets without confirmed artifacts. Dispatch or callback failures do not block Worker processing. Each rule set independently selects confirmed remote artifacts or Worker caches matching its current plan; a subscription can use both. sing-box falls back to JSON and switches to SRS on a subscription update after publication. Previously issued managed JSON URLs keep returning JSON and refreshing on demand. Confirmed publications remain usable during refresh failures when their plan is unchanged. Disable and save to use the Worker for all processing.

The Worker attempts missing compilation within a bounded request budget. Existing errors or HTTP `503` with `Retry-After` apply only when neither remote artifacts nor complete local rules are available and source retrieval fails or processing remains unfinished; background preparation continues. Pending Actions alone never blocks a subscription, and fallback never serves caches from a different rule plan.

Saved rule changes, manual refresh and daily refresh can trigger Actions. One batch covers all clients and downloads each source once. Published outputs are reused when source bodies, compilation inputs and valid ASN data are unchanged. The sing-box compiler is downloaded only when SRS generation is needed, once per batch. An output failure does not stop other outputs. Existing five-minute maintenance checks recover unfinished jobs with a 60-minute automatic dispatch interval; **Resubmit compilation** bypasses that interval. No additional GitHub schedule is needed.

Each output's files and receipt are published atomically in one commit. Replacing its directory removes obsolete buckets while preserving other outputs; branch conflicts are retried without force-pushing. The Worker still validates the receipt at the reported commit. Rule URLs emitted for Surge, Clash and sing-box follow the fixed `rules` branch without a commit hash. Clients fetch recompiled content on their rule update schedule without refreshing the main configuration. Refresh the main configuration once to replace old commit URLs, or when rule directories or buckets change. Disabling the feature or deleting a rule set does not erase public files or Git history.

The workflow filename is fixed to `compile-rule-sets.yml`. When Actions is enabled but its workflow is not ready, the admin page attempts installation using the saved repository, callback address and token, then shows the result. If credentials or the callback address are missing, enter them in the setup wizard and install the workflow again. Skipping disables Actions compilation and keeps the Worker serving rules.

Encrypted rule-plan snapshots remain in KV for 24 hours for authenticated Actions downloads. Normal Actions runs download original source bodies to temporary runner storage, remove them on completion and exclude them from the repository. Worker fallback uses the existing encrypted source and compiled-rule caches. The Worker keeps Actions publication metadata without storing or proxying its artifact bodies. Rule-set names and generated rules are public; source addresses, Worker addresses and credentials are excluded from artifacts and logs. The token and shared secret are encrypted separately and excluded from configuration exports. Replacing the token preserves the shared secret; clearing and reconfiguring requires reinstalling the workflow. `ADMIN_TOKEN_HASH` and `CONFIG_ENCRYPTION_KEY` remain Worker Secrets.

Deployment builds and `npm run build:actions` bundle the shared compiler for installation by the wizard. Generated files live in ignored `.subpilot-build/` and are not committed; dependency installation also builds the bundle.

### Subscription checks

Under Configuration links, select a client in Subscription checks to inspect the saved configuration. Missing outbounds, cycles and incompatible settings can produce HTTP 422. Unsupported nodes may be omitted with a diagnostic. Correct the configuration, save and check again.

Configuration validation is not a connectivity test. Check sing-box startup logs, permissions, certificates and node connectivity on the actual device.

## Updates and migration

### Update an existing deployment

Read the [release notes](https://github.com/tnt2ray/subpilot-worker/releases) and [configuration format requirements](#configuration-format-requirements) first, and ensure Node.js is at least 22.12. Preserve local deployment settings and existing Secrets. Close old admin pages and do not save their drafts until migration is complete.

**For the first migration from a Wrangler deployment, do not run the old `npm run update` directly.** The old updater cannot complete this toolchain migration. Obtain the complete new application first:

- Git clone: ensure tracked files have no changes, then run `git pull --ff-only`.
- Release archive: download and extract the new complete `subpilot-worker-vX.Y.Z.tar.gz`, updating program files while preserving the original `wrangler.jsonc`.

Then run the following in the updated project directory. Skip sign-in if `cf` is already authenticated to the intended account. The last command deploys to the existing Worker:

```bash
npm install --include=dev
npm run cf -- auth login --mode template
npm run setup -- --no-deploy --no-secrets --existing-config-only
npm run deploy
```

This setup command only converts or completes an existing local deployment configuration; it does not create cloud resources, write Secrets, or deploy, and stops if no existing configuration is found. If only `wrangler.jsonc` exists, supported settings are converted to `cloudflare.local.json` and the original file is retained. Unsupported custom fields or build settings stop conversion; follow the message to migrate them manually before continuing. Confirm the new file still refers to the existing Worker and KV namespace. Subsequent deployments read that file.

After deploying the new program, explicitly migrate v2.3.3 application configuration. Preview first, then apply:

```bash
npm run migrate:v2.3.3 -- --url https://your-worker.example
npm run migrate:v2.3.3 -- --url https://your-worker.example --apply
```

Replace the example with your Worker HTTPS origin, including only the hostname and optional port, without paths or query parameters. HTTP is allowed for localhost. The command prompts for the admin token without echo; alternatively, provide `SUBPILOT_URL` and `SUBPILOT_ADMIN_TOKEN` through the environment. Do not put the token in command arguments. The default preview does not write data; `--apply` commits the configuration revision covered by its preview. After copying Actions data, the command shows a countdown while waiting for KV propagation, then continues verification and cleanup, for up to 5 minutes. If it times out, preview again before continuing. A pending-cleanup preview does not mean migration is complete. Between deployment and migration, old configuration may temporarily prevent admin-page and subscription access; CLI login and the migration endpoint remain available.

Migration runs within the existing Worker, using its Secret to decrypt and re-encrypt data. You do not need to retrieve or replace the encryption key. Before committing, it saves an encrypted backup for recovery and retains the original configuration snapshots and subscription-token records. Legacy Actions credentials and callback records are copied into the current format and verified before their obsolete records are deleted. Migration does not print or rotate tokens or replace existing client settings with new defaults. After completion, reopen the admin page and check subscriptions. If KV propagation is still pending, retry preview and checks shortly instead of immediately applying again. Already-current configurations with no pending cleanup are not migrated again.

**After deployment and application configuration migration, use the following for routine updates. It updates local program files, installs dependencies including build tools, and deploys to the configured Worker:**

```bash
npm run update
```

For a Git clone, it requires clean tracked files and pulls the current branch with `--ff-only`. For a release-archive installation, it prefers the latest `subpilot-worker-vX.Y.Z.tar.gz`, falls back to the source archive when that attachment is absent, and replaces managed program files. Both paths preserve local deployment settings and existing Secrets. Do not remove your local configuration or replace `CONFIG_ENCRYPTION_KEY`: existing encrypted data depends on the same key.

`npm run update -- --no-deploy` skips only the final deployment. It still updates code, dependencies, and local configuration, so it is not a read-only check.

The setup script adds the pending-rebuild schedule while retaining your existing subscription interval. Confirm all three schedules after upgrading; see [Cache and operational limits](#cache-and-operational-limits). The current version appears below “Sign out” in the sidebar, replaced by green “Update available” text when a new version is detected. Scheduled version checks are disabled by default; when enabled, GitHub Releases is checked at most daily and a bound Telegram chat receives one notification for each newly detected version.

### Configuration format requirements

Normal reads and writes accept only version 3 documents with sing-box `1.15.0-alpha.8`. **The alpha.6 configuration saved by v2.3.3 requires the explicit migration above, even when its document is already version 3.** The one-time tool supports only alpha.6 → alpha.8 conversion in a version 2 snapshot envelope containing a version 3 application document. Already-current documents are not converted again, but legacy Actions records are still checked and cleaned up. Older or unknown storage formats are rejected. Complete and save their format upgrade using an older application version that supports them before deploying this version. Normal reads do not migrate data automatically. The `wrangler.jsonc` conversion handles deployment files only and does not change application configuration in KV.

The tool reuses complete, decryptable legacy Actions credentials, callback addresses, and subscription tokens, including values from supported old SRS records. Token rotation and replacement client subscription URLs are not required. Missing, damaged, or unverifiable records block migration; follow the preview guidance.

If Actions compilation is enabled, reopen the admin page after migration and confirm workflow updates complete so the compiler uses sing-box alpha.8. The page attempts updates using saved credentials. If unfinished, open **System settings → Actions rule compilation → Setup wizard** and select **Check, install and enable**; leave the masked token unchanged to reuse it.

## Cache and operational limits

Enabled upstream subscriptions are fetched into encrypted KV cache. Requests prefer cached content; failed refreshes try to retain usable old entries. Rule-source bodies share cache, while compiled artifacts remain separate for each client. Refreshes have execution deadlines, retain successful results, and report individual failures; once the deadline is reached, no new remote fetches or compilations start.

With Actions disabled, sing-box configuration and hosted rule downloads only read complete JSON rule caches matching the current configuration and compiler version. When first use, rule changes, or an upgrade invalidate those JSON caches, the server promptly returns HTTP `503` with `Retry-After` and prepares rules in background batches. Retry the configuration update after the indicated delay. **Subscription check** also starts preparation and reports its status. A complete configuration is returned once every required JSON cache is ready. Actions mode prefers confirmed remote artifacts and falls back to Worker processing while they are pending; update the subscription after confirmation to switch to Actions artifacts.

Saving configuration that affects rule output immediately records pending work in KV and starts a background update. If the execution budget runs out, the five-minute schedule continues unfinished work. Closing the admin page or stopping client updates does not stop this progress. The five-minute task only processes pending work; it does not refetch all upstream sources every 5 minutes, and needs no additional storage binding or secret.

The daily rule task checks upstream content hashes and recompiles when source content, relevant configuration, or the compiler version changes, ASN data expires, or cache is missing. Unchanged source bodies are retained, and recompilation is skipped when the other compiler inputs still match and complete artifacts remain usable. Older artifacts without source hashes are rebuilt once during the next rule check to establish a comparison baseline. Batch checks process sources individually instead of retaining all source bodies together.

The following describes local Worker compilation. Actions retries, logs and remote artifact retention follow the optional compilation section above.

Failed background compilations briefly back off before retrying so other rule sets can make progress. Recognized source-format or configuration-reference errors appear in subsequent subscription checks and return HTTP `422` on subscription downloads. When only ASN data has expired and the configuration and compiler version still match, existing complete artifacts remain available while ASN data refreshes in the background. An incomplete background ASN lookup without usable cached prefixes prevents publishing an artifact with missing rules. Background work has an execution budget, so large batches may need several scheduled continuations to finish.

Rule sources share one complete encrypted body per URL; subscription sources share one per URL and effective User-Agent. Successfully fetched new content replaces earlier content without keeping source history. A complete successful compiled version replaces earlier versions, which are then removed. Edge cache entries use stable URLs with version validation and overwrite previous responses.

After deleting a rule set or source, or changing its URL and saving, background cleanup removes unreferenced source bodies, metadata and compiled artifacts. Caches still used by another active rule or client remain. Source configuration entries with no rule-entry references are also removed. Old edge copies expire according to their cache lifetime; rule-download endpoints stop using deleted entries once they read the newly saved configuration.

The default schedules in local `cloudflare.local.json` are shown below; unrelated fields are omitted:

```json
{
  "worker": {
    "triggers": [
      { "type": "scheduled", "schedule": "0 */12 * * *" },
      { "type": "scheduled", "schedule": "0 16 * * *" },
      { "type": "scheduled", "schedule": "*/5 * * * *" }
    ]
  }
}
```

The first entry refreshes subscriptions every 12 hours; keep your chosen interval if different. `0 16 * * *` is reserved for daily rule-source change detection, and `*/5 * * * *` for pending rebuilds every 5 minutes. Other cron entries refresh subscriptions. Existing deployments must add the corresponding `scheduled` entry to `worker.triggers` in private `cloudflare.local.json` and redeploy; `npm run setup` and `npm run update` add the five-minute task if missing. Without it, background work still starts immediately, but unfinished work cannot continue through the five-minute task. No new bindings or Secrets are required. Cron uses UTC; changes require deployment and time to propagate through Cloudflare. [Cron configuration](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

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

**System settings → GeoIP MMDB** shows the current file name, database type, database version (build time), upload time, and size. Existing uploads also expose their embedded build metadata; unavailable build times are explicitly labeled. Database information and upload controls appear side by side and stack on narrow screens. Click the question mark beside Upload database to view complete client file path tips; click outside or press Escape to dismiss them.

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
- `cloudflare.local.json` is local and untracked; keep any old `wrangler.jsonc` retained after conversion private as well. Keep real Worker names, namespace IDs, domains, subscription URLs, passwords, MITM CAs, tokens, and private exports out of public source, issues, logs, and release archives. Configuration data contains private information and must not be shared publicly.

## Local development

Use Node.js 22.12 or later and install all dependencies with `npm install --include=dev`. The commands below use the project's `cf` CLI and Vite. Public `cloudflare.config.ts` loads private `cloudflare.local.json`. `npm run dev` always uses locally simulated bindings and does not read or write remote KV.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the local Worker and admin UI |
| `npm run build` | Build the Worker and admin UI |
| `npm run deploy` | Build and deploy to the Worker in local configuration |
| `npm run typecheck` | TypeScript validation |
| `npm run types` | Generate Worker types with `cf workers types` |
| `npm run typecheck:worker` | Generate Worker types and check TypeScript |
| `npm run verify` | Worker type checks, TypeScript, and public-content scan |
| `npm audit` | Dependency vulnerability advisory check |
| `npm run dry-run` | Build deployment artifacts locally without deploying |

`dry-run` uses local `cloudflare.local.json`. To build with public `cloudflare.example.json` instead, without deploying:

```bash
npm run dry-run -- --mode template
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
