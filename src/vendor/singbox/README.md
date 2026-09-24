# sing-box configuration schema

`schema-1.15.0-alpha.7.json` is an unmodified copy of the upstream v1.15.0-alpha.7 schema:
https://github.com/SagerNet/sing-box/blob/v1.15.0-alpha.7/docs/schema.json

Copyright © 2022 nekohasekai. The upstream GPL-3.0-or-later license and additional
terms are retained in `LICENSE`. This schema powers the native configuration forms and validates compatible
configuration output; SubPilot is an independent project.

`src/singbox-validation.ts` derives the schema used by SubPilot from this copy,
removing the TUN `stack` option from forms and validation, adding required Tailcat keys,
and annotating DERP Tailcat inbound references. Additional validation checks DERP
selection conflicts, Tailcat user keys, and referenced inbound types. The upstream file remains unchanged.

Update this file only together with the supported core version, adapters,
migration behavior, and native `sing-box check` verification.

This is a 1.15 preview baseline. Existing 1.14.0, 1.14.1 and 1.15.0-alpha.6
document markers migrate to 1.15.0-alpha.7 without resetting native settings.
For older documents, HTTP outbounds without an explicit version retain the
previous HTTP/1.1 default. Optional new fields remain omitted until configured.

Pinned schema SHA-256: `904ae70b41888b8eadbb3a7843c9e7a29763bbbb3b357f705be90e373ec31e38`.
