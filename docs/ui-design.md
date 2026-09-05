# SubPilot 2.0 UI Design

The accepted client-configuration concept defines a compact configuration workspace: a gray sidebar, a white main surface, blue selection and primary actions, three client tabs, routing tables, native configuration previews, and a diagnostics drawer.

- Canvas `#ffffff`; sidebar and table headers `#f7f8fb`.
- Primary blue `#2563eb`, text `#172033`, muted text `#667085`, border `#dce1e9`.
- System sans-serif UI; monospace for editable/generated configuration. No external font dependency.
- Sidebar width 214 px. Shared resources and client settings have separate navigation entries.
- Client tabs: Surge, mihomo, sing-box. Subtabs: network/TUN, DNS, routing, advanced.
- Rules show order, match type/value, outbound, edit and removal controls. Advanced rules retain native JSON/text editing.
- The right drawer shows target-specific warnings and blockers, provides navigation to affected settings, and supports keyboard focus containment and Escape dismissal.
- The fixed bottom bar reports draft/save status and offers preview, save, and a download enabled only for a current valid output.
- Small screens use a collapsible sidebar and horizontally scrollable dense tables within the page. Page-level horizontal overflow is prohibited.
- Empty states, validation messages, loading, disabled actions, and migration confirmation use actual application state. No synthetic activity data.

The implementation uses the existing vanilla JavaScript and Worker asset pipeline. Drafts remain in memory; only language preference is stored in localStorage. Complex configuration can be edited as native text or JSON without introducing a second configuration representation in the browser.
