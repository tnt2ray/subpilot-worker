# sing-box configuration schema

`schema-1.15.0-alpha.6.json` is an unmodified copy of the upstream v1.15.0-alpha.6 schema:
https://github.com/SagerNet/sing-box/blob/v1.15.0-alpha.6/docs/schema.json

Copyright © 2022 nekohasekai. The upstream GPL-3.0-or-later license and additional
terms are retained in `LICENSE`. This schema powers the native configuration forms and validates compatible
configuration output; SubPilot is an independent project.

`src/singbox-validation.ts` derives the schema used by SubPilot from this copy,
removing the TUN `stack` option from forms and validation, adding required Tailcat keys,
and annotating DERP Tailcat inbound references. Additional validation checks DERP
selection conflicts, Tailcat user keys, and referenced inbound types. The upstream file remains unchanged.

Update this file only together with the supported core version, adapters,
migration behavior, and native `sing-box check` verification.

Pinned schema SHA-256: `af4579d1005d9667b54eb557adb2738b57f39fba67cea965c5a5796b15758340`.

This is a 1.15 preview baseline. Existing 1.14.0/1.14.1 document markers migrate
to 1.15.0-alpha.6 without resetting native settings. Optional new fields remain
omitted until configured.
