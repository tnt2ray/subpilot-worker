# sing-box configuration schema

`schema-1.15.0-alpha.8.json` is an unmodified copy of the upstream v1.15.0-alpha.8 schema:
https://github.com/SagerNet/sing-box/blob/v1.15.0-alpha.8/docs/schema.json

Copyright © 2022 nekohasekai. The upstream GPL-3.0-or-later license and additional
terms are retained in `LICENSE`. This schema powers the native configuration forms and validates compatible
configuration output; SubPilot is an independent project.

`src/singbox-validation.ts` derives the schema used by SubPilot from this copy,
removing the TUN `stack` option from forms and validation, adding required Tailcat keys,
and annotating DERP Tailcat inbound references and DNS environment match map keys.
The latter reference DNS server tags and support only local, DHCP, resolved, Tailscale,
OpenVPN and OpenConnect DNS servers. Additional validation checks these references and
server types, DERP selection conflicts, Tailcat user keys, and referenced inbound types.
The upstream file remains unchanged.

Update this file only together with the supported core version, adapters,
migration behavior, and native `sing-box check` verification.

This is a 1.15 preview baseline. Existing 1.14.0, 1.14.1, 1.15.0-alpha.6 and 1.15.0-alpha.7
document markers migrate to 1.15.0-alpha.8 without resetting native settings.
Explicit HTTP versions are preserved; omitted versions use the core's negotiation
defaults. Optional new fields remain omitted until configured.

Pinned schema SHA-256: `641f9bb28af79e014afe8a781140b40d357c7adf8fcb5fe5e23b7971a62fa52d`.
