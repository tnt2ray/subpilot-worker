# SubPilot 2.0 UI Design

The accepted client-configuration concept defines a compact configuration workspace: a gray sidebar, a white main surface, blue selection and primary actions, three client tabs, routing tables, native configuration editors, and a migration issue drawer.

- Canvas `#ffffff`; sidebar and table headers `#f7f8fb`.
- Primary blue `#2563eb`, text `#172033`, muted text `#667085`, border `#dce1e9`.
- System sans-serif UI; monospace for editable configuration. No external font dependency.
- The login panel is centered horizontally and vertically below the brand header; short viewports scroll naturally to keep the entire form reachable.
- Sidebar width 214 px. Shared subscription resources and client settings have separate navigation entries. Policy groups and rule sources each have Surge / clash / sing-box tabs and edit only the selected client.
- Client tabs: Surge, clash, sing-box. Subtabs: network/TUN, DNS, routing, advanced; Surge additionally has MITM certificates with generation, import, export, and related settings.
- Configuration links shows one universal subscription URL for all clients; User-Agent selects the output. No dedicated client links or Surge version/profile controls.
- Group target selectors are removed; rule selectors and source checkboxes only list the current client’s resources.
- Rules show order, match type/value, outbound, edit and removal controls. Advanced rules retain native JSON/text editing.
- The sing-box migration drawer lists pending migration issues, links to affected settings, and supports resolution, keyboard focus containment, and Escape dismissal.
- The viewport uses a flex column with a persistent header and bottom bar. Main content scrolls independently in the remaining height; the bottom bar reserves its actual height, including wrapping and safe-area insets.
- The bottom bar reports draft/save status and offers save. Output preview and its copy/download actions are removed; clients retrieve saved configuration through the universal subscription URL.
- Small screens use a collapsible sidebar and horizontally scrollable dense tables within the page. Page-level horizontal overflow is prohibited.
- Toast messages appear at the top center of the viewport, with 16 px spacing below the top safe-area inset.
- Empty states, validation messages, loading, disabled actions, and migration confirmation use actual application state. No synthetic activity data.

The implementation uses the existing vanilla JavaScript and Worker asset pipeline. Drafts remain in memory; only language preference is stored in localStorage. Complex configuration can be edited as native text or JSON without introducing a second configuration representation in the browser.
