# Workspace UI

The application is a desktop-first developer workspace, not a dashboard with
sample production data. A persistent navigation rail replaces the original
horizontal dashboard. The presentation layer uses local HTML/CSS/ES modules;
no UI framework, font CDN, analytics, runtime dependency or backend was added.

## Navigation

- **Overview**: real connection configuration, known collections/buckets, loaded
  OpenAPI operation count, and retained API-workstation requests. Counts are
  explicitly session-scoped, not complete database/storage totals. “Configured”
  does not claim the backend has verified the connection.
- **Data**: Collections, Records, Schema. Collections focuses the exact-name
  browser; records/schema share that collection context. IDs open full JSON.
- **Files**: Objects and Buckets, retaining prefix navigation, transfers,
  metadata and explicit deletion confirmation.
- **API**: Explorer, OpenAPI and Requests. The existing API overview remains
  available as a local tab. Catalog loading remains lazy on entry.
- **Tools**: Import, Export, Bulk Actions and JSON. Duplicate, API builder and
  media tools remain available in the workspace. **AI assist** is accessible
  under Tools and from Overview; its review/consent gates are unchanged.
- **Connections**: Telegraph Cloud configuration and an honest availability
  state for Other Connections. Arbitrary backend support is not invented.
- **Settings**: light/dark/system theme, comfortable/compact table density and
  value wrapping. These are presentation preferences for the current tab only.

Allowlisted hash routes support bookmarks and browser Back/Forward without
putting record IDs, filters, credentials or request bodies into navigation URLs.
Switching pages does not reset drafts or confirm operations. Internal draft
handoffs retain their selected destination tab. Modal editing cannot be
interrupted by global navigation.

## Interaction and accessibility

- Ctrl/Command K opens a local navigation palette. Filtering matches page/tool
  names, **not backend data**. Arrow keys move through results; Enter opens one.
- Horizontal tab groups use Arrow Left/Right, Home/End and a roving tab stop.
- `?` shows keyboard help outside text inputs. Escape closes the palette,
  keyboard help and mobile drawer. Native record/object dialogs retain the
  controllers' busy/destructive guards; Escape never cancels an accepted write.
- Skip link, named landmarks, visible focus, labels, semantic tables and native
  modal focus trapping. Record-dialog focus returns to the equivalent live
  row action after table rerender, or a stable heading if the row disappeared.
- Small screens use an inert, focus-contained navigation drawer with a scrim
  and Escape/close controls. Tables scroll inside their region, not the entire
  page. Desktop action columns stay pinned; mobile removes that pin so it does
  not obscure data. Clicking a record ID opens its full JSON without scrolling
  to the action column.
- Loading, empty and error states have contextual actions. No synthetic rows,
  fake requests, invented health checks or dashboard activity are displayed.
- Explicit Copy ID / Copy JSON controls supplement existing redacted API and
  Files copy controls. Clipboard failure selects text for manual copying;
  connection changes discard stale success feedback. Copying is an intentional
  operator action and the app cannot retract clipboard contents.

The CSS uses a restrained neutral/green palette, opaque surfaces, compact
hierarchy, clear state layers and reduced-motion support. There are no gradients,
glass effects, marketing heroes or externally fetched decorative assets.

## Implementation and verification

`app/workspace/shell.js` owns navigation, keyboard interaction, session display
preferences and read-only state projection. The connection/connector/controllers
still own all data and remote operations. The existing view hooks and element
IDs remain, with focused table/dialog improvements. No authentication,
validation, optimistic-concurrency, import/export or AI proposal logic changed.

Regression tests cover existing workflows plus navigation/deep links, palette,
roving tabs, modal guards, mobile inertness/focus containment, memory-only
preferences, sanitized connection summaries, explicit copy and draft handoffs.
Real Chromium checks used **mocked HTTP and synthetic records** to exercise the
populated Data/Files/API/Tools workspaces, JSON editing, AI draft handoff, and
light/dark mobile layouts. Automated axe WCAG A/AA scans found no violations in
the tested views; this is not a claim of a complete manual accessibility audit.
No live authenticated backend mutations were used for UI verification.
