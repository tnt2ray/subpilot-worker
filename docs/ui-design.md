# SubPilot UI Design Constraint

Source: https://raw.githubusercontent.com/VoltAgent/awesome-design-md/refs/heads/main/design-md/claude/DESIGN.md

This project uses that design document as the visual constraint for the admin UI. The implementation adapts the editorial Claude-style system to a dense configuration tool:

- Canvas: warm cream `#faf9f5`; no pure white page floor.
- Primary action: muted coral `#cc785c`, active `#a9583e`, disabled `#e6dfd8`.
- Text: warm ink `#141413`, body `#3d3d3a`, muted `#6c6a64`.
- Surfaces: cream cards `#efe9de`, soft bands `#f5f0e8`, dark product/code surfaces `#181715`.
- Borders: soft hairline `#e6dfd8`; shadow use is intentionally rare.
- Shapes: 8px standard controls, 12px cards, pill badges where status needs compact emphasis.
- Typography: serif display fallback for page titles, Inter/system sans for UI, monospace for generated config and previews.
- Controls: buttons and text inputs target 40px height; focus uses a coral ring.
- Responsive behavior: no horizontal page overflow; dense tables collapse into readable cards on narrow viewports.

Implementation note: display letter spacing stays at `0` in CSS to keep the admin UI aligned with the project's frontend constraints.
