# SubPilot 2.0 UI Design

The client-configuration workspace uses a gray sidebar, a white main surface, blue selection and primary actions, three client tabs, routing tables, native configuration editors, and a migration issue drawer. Clash routing follows the simplified URL-and-policy form described below, replacing the earlier policy-sidebar concepts.

- Canvas `#ffffff`; sidebar and table headers `#f7f8fb`.
- Primary blue `#2563eb`, text `#172033`, muted text `#667085`, border `#dce1e9`.
- System sans-serif UI; monospace for editable configuration. No external font dependency.
- The login panel is centered horizontally and vertically below the brand header; short viewports scroll naturally to keep the entire form reachable.
- Sidebar width 214 px. Shared subscription resources and client settings have separate navigation entries. Policy groups and rule sources each have Surge / clash / sing-box tabs and edit only the selected client.
- Client tabs: Surge, clash, sing-box. Subtabs: network/TUN, DNS, routing, advanced; Surge additionally has MITM certificates with generation, import, export, and related settings.
- Configuration links shows one universal subscription URL for all clients; User-Agent selects the output. No dedicated client links or Surge version/profile controls.
- Group target selectors are removed; rule selectors and source checkboxes only list the current client’s resources.
- Rules show order, match type/value, outbound, edit and removal controls. Advanced rules retain native JSON/text editing.
- Clash routing has one list for source URLs and direct rules, with outbound, enabled state, and edit/delete actions. Adding a rule set requires only URL and policy; names are generated and source options are collapsed. Policy groups remain on their existing page. There is no inner policy sidebar or extra routing/source navigation layer.
- The Clash aggregation switch uses `aggregateByPolicy`: off preserves independent positions; on shows the shared effective position of each policy block. The reorder dialog opens as a right drawer and moves effective blocks or direct rules. The final outbound stays below the list, and the existing persistent save bar saves the entire draft.
- Compilation results are collapsed, report real counts and emitted buckets, and mark changed drafts as pending. Small domain/ipcidr buckets join classical; IP options that cannot survive specialized payloads remain classical. No sample counts are shipped.
- Legacy Clash conversion produces a draft and lists unsupported providers without discarding them. Saving the transition requires successful compilation; a failed save preserves the draft and the previously saved configuration. Existing aggregation values are retained; new configurations enable aggregation.
- The sing-box migration drawer lists pending migration issues, links to affected settings, and supports resolution, keyboard focus containment, and Escape dismissal.
- The viewport uses a flex column with a persistent header and bottom bar. Main content scrolls independently in the remaining height; the bottom bar reserves its actual height, including wrapping and safe-area insets.
- The bottom bar reports draft/save status and offers save. Output preview and its copy/download actions are removed; clients retrieve saved configuration through the universal subscription URL.
- Small screens use a collapsible sidebar and horizontally scrollable dense tables within the page. Page-level horizontal overflow is prohibited.
- Toast messages appear at the top center of the viewport, with 16 px spacing below the top safe-area inset.
- Empty states, validation messages, loading, disabled actions, and migration confirmation use actual application state. No synthetic activity data.

The implementation uses the existing vanilla JavaScript and Worker asset pipeline. Drafts remain in memory; only language preference is stored in localStorage. Complex configuration can be edited as native text or JSON without introducing a second configuration representation in the browser.
