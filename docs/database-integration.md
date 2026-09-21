# Telegraph Cloud Data: Collections, Records, Schema

## Scope and verified API boundary

This phase replaces the legacy positional-row dashboard with a document client. Production is static `dashboard-ui/`; there is no Express/lowdb runtime, internal schema database, ORM, or application-owned persistent store. The old server and unused jQuery table/editor implementation have been removed. `services.js` remains as a small compatibility facade, but the active Data view uses the connector through `data/controller.js`.

Before implementation, all chunks of the current OpenAPI and AI docs were re-read, along with service metadata:

- https://telestorage.pages.dev/openapi.json
- https://telestorage.pages.dev/llms.txt
- https://telestorage.pages.dev/llms-full.txt
- https://telestorage.pages.dev/docs/ai
- https://telestorage.pages.dev/.well-known/telegraph.json

Only these database operations are used:

| Operation | Route |
| --- | --- |
| List records / create record | `GET` / `POST /api/db/{collection}` |
| Read / edit / delete record | `GET` / `PATCH` / `DELETE /api/db/{collection}/{recordId}` |

The existing connection request client supplies Bearer authentication. Views and controllers never construct Telegraph API URLs. All real credential/project access and live CORS behavior remain unverified; tests use deterministic mocks, not live data writes.

## Collection discovery: an explicit upstream limitation

**Automatic remote collection enumeration and schema retrieval cannot be implemented against the currently documented developer API.** OpenAPI has no collection-list/schema endpoint, and the AI docs place collection/schema management in the dashboard-session-authenticated `/console`. Service metadata advertises the console but no programmatic collection catalog. A project context plus a Bearer credential cannot substitute for dashboard authentication.

Accordingly, the UI:

1. Loads resource descriptors explicitly provided by the selected connector, with loading, ready, empty and error states.
2. Labels an incomplete/configured catalog honestly; it is never presented as every remote collection.
3. Links to the documented Telegraph console so the operator can discover the real names/schema using supported management capabilities.
4. Accepts an exact operator-entered collection name. It issues a **GET**, not a create. Only a successful read adds the name to the session sidebar. A rejected name produces an error and is not registered.
5. Makes no probe requests for guessed names; no collection is selected automatically. No console endpoints are guessed, scraped, or authenticated with developer keys.

A supported, documented control-plane collection/schema read API with an appropriate auth contract is the remaining prerequisite for automated discovery. No speculative backend endpoints were added. The UI can consume remote descriptors through the existing connector contract once a supported provider exists.

## Records

- Table view retains original typed record objects, stable IDs, versions and timestamps. Rendering uses DOM text/property assignment, never unescaped remote HTML.
- Cursor pagination has next/previous history, page sizes of 10/20/50/100 and no invented total. Refresh, filters, page-size changes and successful mutations reset to the first page.
- Filters are up to four exact-match pairs on indexed top-level **string** fields. Declared indexed text/select fields are suggested; when index metadata is absent the operator supplies a known field and the backend validates it. There is no arbitrary full-text search, numeric filtering, or unsupported sorting.
- Create, edit, delete, raw JSON and duplicate are implemented. Edit/duplicate/delete/raw retrieve the current record by ID before opening the dialog.
- Raw JSON shows the normalized full record envelope, including metadata. It is not an editable copy of the wire-level metadata fields.
- Duplicate opens a reviewable create draft with managed fields stripped. It performs no write until explicitly submitted.
- Delete shows the actual record/version and requires a separate confirmation submit. There is no bulk delete or automatic cascade.
- Managed fields cannot be submitted as document data. Unmodeled JSON properties and false/zero/null/nested values are preserved.
- PATCH sends changed top-level fields only. Removing a top-level property is blocked with an explanation because no field-removal syntax is documented; the client does not invent a null-as-delete contract.
- Loading, empty, error and success states are distinct. A successful write followed by a failed refresh is shown as a successful write **and** a read error, not a failed write that invites duplication.

## Optimistic concurrency and retries

PATCH and DELETE use the snapshot's version as `_expected_version`. Positional indices, DOM text, browser localStorage and caller-supplied project context never identify or authorize a write.

On `409 version_conflict`:

1. Keep the original version and unsaved draft.
2. Block further submission; never retry with the server's reported version automatically.
3. Allow **Compare latest**, fetching a fresh record and displaying it alongside the preserved draft.
4. Require an explicit **Discard my draft and edit latest** or **Review this version for deletion** action to adopt that snapshot.
5. Require a new submit/confirmation before any later write. A conflict can recur and follows the same process.

Creates use a per-attempt idempotency key. If a network failure leaves the outcome unknown, retrying the unchanged draft retains its key/body. Changing that draft is blocked until the user cancels and refreshes to check whether the first attempt succeeded. Definite validation/auth/rate-limit rejections permit a corrected attempt. No mutations are automatically retried.

In-flight states prevent duplicate submits. Selection/connection generations and cancellation keep late reads/writes from populating another view. Disconnect clears visible records, drafts, schema hints and credentials. This is ephemeral UI state, not a local replica/database.

## Schema forms and schema-less data

No schema metadata is inferred to be authoritative from a record sample or OpenAPI's generic `Record` definition. Absent/unavailable metadata uses the JSON editor; schema-less legacy collections remain usable, and schema-enforced collections still receive server validation.

Available configured/remote descriptors generate forms. An operator may also paste authorized metadata into the **Schema** tab for this session only; this never writes or changes Telegraph schemas. Supported descriptor inputs are a field list, `{fields:[...]}`, or the existing explicitly configured JSON Schema `properties` format. These are client descriptor formats, not claims of an undocumented control-plane response shape.

Example descriptor (illustrative fields, not a project collection):

```json
{
  "fields": [
    { "name": "title", "type": "text", "required": true, "indexed": true },
    { "name": "amount", "type": "number", "default": 0 },
    { "name": "enabled", "type": "boolean", "default": false },
    { "name": "published_at", "type": "datetime" },
    { "name": "payload", "type": "json" },
    { "name": "attachment", "type": "file" },
    { "name": "status", "type": "select", "options": ["draft", "published"] }
  ]
}
```

| Type | Control / serialization |
| --- | --- |
| text | String input; exact field name preserved. |
| number | Finite number input; `0` is not treated as missing. |
| boolean | Checkbox plus explicit presence; `false` is distinct from absent. |
| datetime | ISO datetime with explicit timezone; no silent browser-timezone conversion. |
| json | JSON value editor; objects, arrays, null and primitives retained. |
| file | Existing reference expressed as JSON (string/object/etc.), preserving its shape. No invented file schema, upload flow or automatic URL rendering. |
| select | Choice from declared string options; no invented options. |

Defaults are applied to create drafts only. Optional fields have explicit inclusion controls. Field names are not derived from DOM IDs. Unknown types or incompatible existing values fall back to JSON rather than coercing data. Server schema enforcement remains authoritative; this client does not recreate Telegraph's schema/database engine.

## Runtime and local development

1. `npm ci` (Node 22+).
2. `npm test`.
3. `npm run dev` starts a **development-only static server** at port 3214, bound to `0.0.0.0` for previews. `PORT` can override it. It serves only `dashboard-ui/`, has no mutation/API routes, and writes no files.
4. Enter runtime URL, expected project context and credential in the connection form, or select a connection through the module API. The key field is cleared immediately; nothing is stored in localStorage/sessionStorage/IndexedDB or URLs.
5. Open the exact collection name found in the console. No names are prefilled or guessed.

For Cloudflare Pages, run `npm run build` and publish `dist/`; see [production deployment](deployment.md). There are no production package dependencies or CDN scripts. Direct browser access still requires backend CORS permission. A deployment-managed secret would require a future protected Pages Function; never inject it into the static bundle.

The ignored local legacy `.env` file is not loaded anymore and any external JSON data file is untouched. No data was imported into Telegraph.

## Tests

`npm test` covers the original connector/request-client/security tests plus:

- collection loading/empty/error and confirmed operator-selected resources;
- record loading, CRUD, read-before-edit, raw view, duplicate review and explicit delete;
- cursor pagination, filter/page-size resets and refresh;
- all seven field types, defaults, presence, exact names, unsupported types and schema-less JSON;
- optimistic edit/delete conflicts, compare/latest flow and no silent retries;
- API errors, uncertain create idempotency, duplicate-submit prevention and stale-response isolation;
- DOM interactions using jsdom, safe rendering, forms, statuses and disabled controls;
- the real static entry → controller → Telegraph connector → mocked HTTP round trip, including credential clearing and disconnect.

Mocks/fixtures contain no real keys or project data. jsdom is a development-only test dependency. Browser CORS and real project integration are not claimed by these tests.
