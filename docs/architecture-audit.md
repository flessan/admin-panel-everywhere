# Architecture audit: universal admin client

Date: 2026-09-21

Repository baseline: `e350d47a791d6786d1ee1b2fedccb4f153ee143c`

Scope: audit and proposal only; no application, dependency, deployment, or Telegraph backend changes.

## 1. Executive recommendation

Keep the static frontend foundation and useful presentation patterns. Replace the local-file server architecture and the frontend's positional-row data contract with a capability-based connector boundary. Telegraph Cloud remains the sole remote data/storage system.

Recommended production shape:

```text
Cloudflare Pages static UI
  → view controllers / in-memory state
  → connector interface
  → Telegraph connector / optional generic OpenAPI connector
  → connection transport
  → Telegraph Cloud
```

For deployment-managed credentials, insert a small, protected, stateless Pages Function transport between the browser and Telegraph. This is a credential boundary, not a second database or a replacement business backend. A browser-only, bring-your-own-credential mode is possible only after confirming upstream CORS support.

Do not mechanically port Express routes into Functions. Do not preserve the internal schema database. Do not introduce an ORM, persistent cache, SQL service, KV namespace, R2 bucket, or other application-owned datastore.

## 2. Inspection scope and limitations

Read all tracked application files: `package.json`, lockfile metadata, root entry point, every file in `server/`, every JS/HTML/CSS file in `dashboard-ui/`, README and ignore configuration. Inspected tracked environment variable names without printing values.

Read all chunks of the requested public documentation:

- [llms.txt](https://telestorage.pages.dev/llms.txt)
- [llms-full.txt](https://telestorage.pages.dev/llms-full.txt)
- [OpenAPI 3.1](https://telestorage.pages.dev/openapi.json)
- [AI integration guide](https://telestorage.pages.dev/docs/ai)

No authenticated project access, data writes, token issuance, backend changes, package installation, or application startup was performed. Starting the existing app would populate its persistent internal schema file. Findings about application behavior are static code findings, not browser-test results. `npm test` is explicitly a failing placeholder; there is no existing test suite.

An additional raw OpenAPI/CORS inspection through sandbox Python failed at TLS connection setup before the preflight was reached. Documentation was successfully read through the page-fetch tool, but cross-origin API behavior remains unverified. Do not interpret this sandbox failure as evidence that Telegraph is unavailable.

## 3. Current architecture

### Runtime and data

- `package.json:7–10`: `npm start` launches `node index.js`; development uses nodemon. Runtime dependencies are Express, lowdb, dotenv, and chalk. There is no `json-server` dependency: this application edits a compatible JSON file directly rather than calling a json-server API.
- `index.js:8–38`: loads `DB_FILE_ABS_PATH`, checks the local file, populates internal schema metadata, then starts Express.
- `server/server.js:9–27`: serves `dashboard-ui/` and mounts the custom API under `/api` in the same Node process. There is no API authentication or authorization middleware.
- `server/db.js`: lowdb's Node `JSONFile` adapter reads and rewrites the external database file.
- `server/internalDB/index.js` and `db.json`: a **second persistent lowdb file already exists**, storing per-table field-name arrays. It is tracked in Git. This must not carry forward into the target.
- `server/databaseUtils/index.js`: assumes the external file is an object whose top-level keys identify arrays of row objects. CRUD performs whole-file read/modify/write operations. There is no transaction/concurrency contract protecting concurrent logical mutations.

### API routes

All routes below are mounted beneath `/api` by Express; their handlers delegate to database helpers.

| Method and path | Current behavior / shape |
| --- | --- |
| `GET /databaseSummary` | Lists all root keys as `{tableName, entries}`; counts array lengths. |
| `GET /getTable/:tableName` | Returns `{tableData, tableSchema}` with the entire row array. |
| `GET /getTableSchema/:tableName` | Returns field names from the internal lowdb file. |
| `POST /createTable/:tableName` | Assigns an empty array; can overwrite an existing table. |
| `DELETE /deleteTable/:tableName` | Removes the root key and internal schema entry. |
| `POST /addRow/:tableName` | Appends the supplied object; does not generate a record ID. |
| `DELETE /deleteRow/:tableName/:id` | Despite the parameter name, deletes by numeric array index. |
| `PUT /editRow/:tableName/:id` | Replaces an entire row by array index. |

Mutation success is always HTTP 200. Most failures become HTTP 500, without a useful domain error model. The summary handler returns plain text on failure while most others return `{msg}` JSON.

### Frontend, routing, and state flow

The frontend is approximately 700 lines of static HTML/CSS/browser ES modules. It uses global jQuery and Bootstrap loaded from CDNs; it has no frontend framework or bundler requirement today.

```text
app/index.js
  → ui_helpers.fetchNdisplayTableNames()
  → services.getListOfTables() → /api/databaseSummary → sidebar templates
  → eventListeners registers handlers

window.location.hash = #tableName
  → hashchange handler
  → services.getTableData() → /api/getTable/:tableName
  → ui_helpers + templates → DOM table

button click
  → actions + DOM/FormData
  → services → Express controller → lowdb helpers
  → row refresh or direct DOM removal + toast
```

There is no central state store. State is distributed across the URL hash, rendered DOM, button attributes/jQuery data, and `localStorage.rowIndex`. The localStorage entry is a positional edit target, **not an existing credential store**. Editing reconstructs record values from cell text instead of retaining the source object.

The service layer is eight hard-coded, same-origin fetch wrappers. Reads return parsed JSON; writes return raw `Response` objects. Services have no configurable connection, authentication, cancellation, pagination, or common error normalization.

### Schema and rendering

- `server/internalDB/helpers.js:37–50`: initializes schema from the first row only and retains existing metadata on startup.
- `helpers.js:66–71`: schema updates replace the field-name array with the latest written row's keys, rather than retaining a complete field model.
- The noninitial merge path in `saveSchemaInBulk` constructs a union but returns without assigning it back.
- `ui_helpers.js:23–46`: renders all returned records, choosing stored fields or first-row keys; prepends a synthetic `#` column.
- `templates.js:17–36`: associates edit/delete buttons with the array index, not a durable record ID.
- Form fields are text inputs; `FormData` turns values into strings. Field names are lowercased and spaces become hyphens because a generated DOM ID is also used as the submitted property name.
- Search and row-selection checkboxes have markup but no implemented search/bulk-action flow. “Add column” only adds an input to the current document form; it is not a schema-management operation.
- There are no file views, OpenAPI tools, connection views, or Telegraph integration.

### Build and deployment assumptions

There is no build script, output directory, Wrangler configuration, Pages Functions directory, Cloudflare headers/routes configuration, CI, or deployment workflow. `package.json.main` points to `server.js`, which does not exist at the root; the start script instead uses `index.js`.

The frontend assets themselves are suitable for Pages. The complete existing app is not: it depends on a long-running Express listener, Node filesystem access, mutable local files, and startup metadata writes. Publishing `dashboard-ui/` alone would display the shell but leave every API request without its backend.

The repository still has upstream json-server project metadata/documentation. `.env` is tracked, and `.gitignore` ignores only `node_modules`. Future credential files must be untracked and ignored; never publish the repository root as the static output.

## 4. Major coupling and correctness risks

| Finding | Evidence | Migration consequence |
| --- | --- | --- |
| UI knows the Express API verb/path vocabulary | `services.js:1–50` | Replace with connector operations, not route aliases. |
| Data means root-key arrays | `databaseUtils/index.js:4–25` | Introduce resources, record envelopes, pagination, and capabilities. |
| Identity means array position | `databaseUtils/index.js:43–53`; `templates.js:21–24` | Must use backend IDs. After deleting a row, remaining DOM indices are stale and can target the wrong row. |
| Edit state is scraped display text | `actions.js:131–164` | Preserve original typed data and version in memory; never serialize rendered cells. |
| Schema is a second persistent database | `server/internalDB/*` | Replace with remote/configured schema descriptors and transient inference. |
| All successful responses assumed to be 200 | `actions.js:5–13` | Telegraph create returns 201; general transport must handle all appropriate 2xx statuses and empty/binary responses. |
| Errors are not caught consistently | `services.js`; `actions.js:5–13` | Network/JSON errors can leave controls disabled. Add structured errors and `finally` cleanup. |
| Values are interpolated into HTML/attributes | `templates.js`; `ui_helpers.js:28` | Stored XSS risk, especially severe with runtime credentials. Use safe DOM text/property assignment. |
| Falsy values are substituted | `templates.js:32` | `0`, `false`, and empty strings are misrepresented; nested values also lose fidelity. |
| DOM/form model changes data keys and types | `helpers.js:3`; `ui_helpers.js:53–60`; `actions.js:84–85` | Separate field paths from generated DOM IDs; add typed fields and a JSON editor. |
| View rendering also fetches data and binds events | `ui_helpers.js`, `eventListeners.js`, `actions.js` | Split view/controller/state/transport; current imports are cyclic. |
| Rebinding and navigation are not isolated | `ui_helpers.js:17–19`; `eventListeners.js:22–29` | Rebinding sidebar handlers can duplicate actions; late requests can render a previously selected table. Clearing the hash leaves old rows visible. |
| Mutation UX lacks safeguards | `actions.js`; `utils.js:53–66` | Add destructive confirmations and controlled form submission. Existing click handlers do not prevent the form's native submission. |
| Create/edit mode uses inconsistent attribute access | `actions.js:63,133`; `eventListeners.js:38` | `.attr()` writes mixed with jQuery `.data()` reads can use cached stale mode. Replace with explicit state. |
| Duplicated scripts and utility bug | `index.html:88–99`; `utils.js:48` | Bootstrap bundle plus separate Bootstrap/Popper are redundant; error fallback references an undefined `error`. |

These are reasons to preserve interaction patterns selectively, not carry their implementations across unchanged.

## 5. Telegraph contract and first-class connector

Non-secret connection defaults:

- URL: `https://telestorage.pages.dev`
- Expected project: `prj_1aNS55cTr8BiqBZy8LWFRw`
- OpenAPI: `https://telestorage.pages.dev/openapi.json`

These identify the intended deployment, not verified access. The credential determines project authorization; adding a project ID to a URL or body cannot select or authorize a different project.

### Supported mapping

| Client feature | Documented Telegraph operation |
| --- | --- |
| List records | `GET /api/db/{collection}`; opaque cursor, default 20, max 100, ID-ascending ordering. |
| Read/create | `GET /api/db/{collection}/{recordId}` / `POST /api/db/{collection}`. |
| Edit/delete | `PATCH` / `DELETE /api/db/{collection}/{recordId}`, with expected-version preconditions. |
| File list | `GET /api/storage/{bucket}`; prefix/delimiter/cursor. |
| Upload/download/metadata/delete | `PUT` / `GET` / `HEAD` / `DELETE /api/storage/{bucket}/{key}`. |
| Optional token exchange | `POST /api/auth/token`; short-lived ES256 JWT with inherited project/scopes. |
| API exploration | Load public OpenAPI; use the same connection/auth/error boundary as other views. |

Connector requirements:

- Normalize server record IDs, JSON data, version and timestamps; never infer identity from screen position.
- Preserve expected versions on update/delete; show a conflict/reload/compare flow for `409 version_conflict`. Do not silently retry a stale edit with the latest version.
- Use an `Idempotency-Key` for creates and retain the same key/body for retries of the same attempt; create a new key for a new action.
- Handle stable `{error}` codes, token expiry, forbidden scopes, missing resources, and `429` backoff. Do not blindly retry mutations.
- Exclude managed fields from editable payloads; validate JSON without coercing arbitrary values to strings. Confirm PATCH field-removal/nested-update semantics before promising them.
- Support cursor pages without inventing total counts or arbitrary sorting. Filter support is indexed top-level string equality, up to four filters—not unrestricted full-text search.
- Use Bearer object-storage endpoints initially, not an unnecessary S3 credential/signing implementation. File fetches must support bytes, metadata, ranges, and errors independently of document JSON.
- Respect documented document and object limits (about 96 KiB and 20 MiB). Prefer authenticated fetch-to-Blob/download flows rather than credentials in links; revoke temporary object URLs and do not render arbitrary HTML/SVG as trusted same-origin content.
- Treat documented rate limits as backend behavior, not a guarantee of globally coordinated enforcement; full docs say the burst guard is per-isolate.

### Missing discovery and management endpoints

The reviewed developer OpenAPI does **not** expose collection enumeration, per-collection schema retrieval/management, explicit collection deletion, bucket enumeration, or project management. Collection configuration/schema management belongs to the Telegraph console. The docs say writes to unconfigured collections work as legacy/untyped data, and bucket creation is implicit on upload; this does not provide an empty “create table” equivalent.

Consequently:

1. Start with operator-configured collection and bucket names in a non-secret connection manifest, or names entered during the session. No names for the supplied project have yet been established.
2. Label adding a sidebar resource as “Open/add collection to this connection,” not “Create collection,” unless an actual supported operation is being performed.
3. Disable unsupported management actions and link to `/console`. Do not discover or scrape private console endpoints or reuse dashboard Basic authentication as developer auth.
4. Allow explicitly supplied field descriptors, otherwise infer **display columns** from loaded records. Label inference as incomplete/non-authoritative; retain a typed JSON editor for empty or heterogeneous collections.
5. OpenAPI describes generic endpoint contracts, not this project's collections or their field schemas. A generic API connector must not pretend otherwise.
6. Do not generate one client per collection. A single Telegraph connector accepts the configured resource name.

### Contract discrepancies to resolve before implementation claims

The published documents are not fully consistent:

- `Record` requires a top-level `id`; full-doc examples place the record ID inside `data.id`. `RecordResponse` prose is also ambiguous about metadata placement.
- Create-document OpenAPI uses `additionalProperties: {type: object}` although examples include string and boolean fields.
- The list-filter parameter has an empty name in OpenAPI; prose describes dynamic `field=value` parameters.
- Storage list OpenAPI allows `limit` up to 1000; full docs say 100. Use a conservative page size (e.g. 50) pending verification.
- Upload response schema describes an unwrapped `Object`; prose shows `{data: objectMetadata}`.
- Prose permits `If-Match` for document preconditions, while PATCH/DELETE schemas require `_expected_version` bodies and omit the alternative header.
- Token TTL schema and description are not fully aligned about whether lifetimes above the default are honored.

Do not blindly generate connector behavior or form validation from these inconsistencies. Record small, documented compatibility rules and validate with contract fixtures plus authorized read-only examples first. Controlled mutation tests require later explicit approval and an appropriate test resource; this audit made none. No Telegraph backend changes are proposed.

## 6. Proposed module structure

Preserve `dashboard-ui/` to minimize gratuitous churn. JavaScript ES modules and existing Bootstrap styling are sufficient; a framework rewrite is not a prerequisite. A small Vite build is recommended for bundled dependencies and an isolated static artifact.

```text
admin-panel-everywhere/
├─ dashboard-ui/
│  ├─ index.html                       # adapted existing shell
│  ├─ assets/styles.css                # retained styles
│  ├─ public/
│  │  ├─ connection-defaults.json      # URL/project/resources only; no secrets
│  │  ├─ _headers                     # static security/cache headers
│  │  └─ _routes.json                 # only gateway paths invoke Functions
│  └─ app/
│     ├─ index.js                     # bootstrap runtime config and app
│     ├─ application/
│     │  ├─ router.js                 # connection/data/files/API hash routes
│     │  └─ store.js                  # memory-only active state, drafts, pages
│     ├─ connection/
│     │  ├─ config.js                 # validate public connection profiles
│     │  ├─ session.js                # memory-only credentials/token lifecycle
│     │  ├─ transport.js              # fetch, auth, timeout, abort, response types
│     │  └─ errors.js                 # normalized status/code/conflict errors
│     ├─ connectors/
│     │  ├─ contract.js               # resource/record/page/file interfaces
│     │  ├─ registry.js
│     │  ├─ telegraph/
│     │  │  ├─ index.js
│     │  │  ├─ capabilities.js
│     │  │  ├─ documents.js
│     │  │  ├─ storage.js
│     │  │  └─ normalize.js
│     │  └─ openapi/index.js          # explicit operations, not inferred CRUD
│     ├─ schema/
│     │  ├─ openapi.js                # loading, local refs, operation catalog
│     │  ├─ fields.js                 # declared field descriptors
│     │  ├─ inference.js              # bounded, advisory display inference
│     │  └─ validation.js
│     ├─ views/
│     │  ├─ connections.js
│     │  ├─ data/                    # browser, typed editor, conflict dialog
│     │  └─ files/                   # browser, upload, metadata, download
│     ├─ api-tools/
│     │  ├─ explorer.js
│     │  └─ request-runner.js         # redacted, in-memory request history
│     └─ ui/
│        ├─ icons.js                 # moved existing SVGs
│        ├─ notifications.js         # adapted toasts
│        ├─ action-state.js          # pending/error/finally handling
│        └─ dom.js                   # safe rendering primitives
├─ functions/                        # managed-secret deployment only
│  └─ gateway/[[path]].js            # protected, allowlisted stateless forwarding
├─ tests/
│  ├─ connectors/                   # envelopes, preconditions, error contracts
│  ├─ schema/                       # references, inference, typed values
│  ├─ security/                     # XSS, credential leakage, gateway policy
│  └─ e2e/                          # navigation, CRUD, conflicts, files
├─ docs/
│  ├─ architecture-audit.md
│  ├─ connector-contract.md
│  └─ deployment.md
├─ vite.config.js
├─ wrangler.jsonc
├─ .env.example                     # placeholders only
├─ .gitignore
├─ package.json
├─ package-lock.json
└─ README.md
```

`dist/` would be the generated, ignored Pages output, not checked-in source. Configure Vite with `dashboard-ui` as its root and `../dist` as output. Root-level Functions are deployed alongside that static artifact. Restrict Function routing to `/gateway/*`; hash-based UI routing avoids catch-all rewrite complexity. Local previews must bind to `0.0.0.0`, permit the preview host, and use relative gateway URLs rather than browser-facing localhost calls.

### Abstraction responsibilities

- **Connection**: endpoint, transport mode, expected project, public resource hints, credentials, and lifecycle. It knows how to reach an API, not how that API models documents.
- **Connector**: maps backend semantics to `ResourceDescriptor`, `RecordEnvelope`, `Page`, and `FileEntry`; declares supported operations per resource and effective permissions where known. Unknown permissions must not be presented as guaranteed access; backend authorization is authoritative.
- **Schema/OpenAPI**: keeps endpoint request/response contracts separate from document field definitions and inferred display columns. External references must be restricted/opt-in; loading a spec must never run its operations or forward credentials to its declared servers automatically.
- **State/controller**: tracks original typed records, ID/version, drafts, selection, cursor history, request identity and cancellation. Clears relevant caches/drafts/credentials on disconnect and isolates connection/resource state. DOM is output, not the source of truth.
- **Views**: render normalized models and capability-aware controls. They do not construct URLs or access credential storage.
- **API tools**: use the same transport, require explicit execution, confirm destructive requests, redact credential headers and token responses in history/export. Unsupported credential schemes and dashboard-only operations remain unavailable.

## 7. Runtime configuration and security boundary

### Recommended: managed key with stateless Pages gateway

- `TELEGRAPH_API_KEY` comes only from the Pages Function runtime secret binding (`context.env.TELEGRAPH_API_KEY`). Never a `VITE_*` variable, build-time substitution, public config response, HTML, bundle, URL, or log.
- `TELEGRAPH_URL` and `TELEGRAPH_PROJECT` are non-secret runtime configuration. Public defaults may advertise them; the gateway uses its own trusted deployment configuration, not a caller-supplied origin/project override.
- Protect every gateway request with operator authentication, e.g. Cloudflare Access with verified audience/issuer/signature/expiry. Do not trust a bare user/identity header. Fail closed if protection is absent. Same-origin alone is not authorization; an unprotected gateway would expose the configured key's authority to the public.
- Allow only configured upstream origins, documented paths/methods, and configured resource policy. Reject URL userinfo, traversal, arbitrary targets and cross-origin redirects; never forward managed credentials to a user-entered API server.
- Use origin/CSRF checks for cookie-authenticated mutations, narrow forwarded headers, secret-redacted diagnostics and `Cache-Control: no-store` on sensitive Function responses. Static `_headers` rules do not substitute for headers on Function-generated responses.
- Forward JSON or stream bytes as appropriate; do not save records, schemas, files, or credentials in a new storage layer.

### Optional: browser-only session connection

User-provided credentials enter runtime session memory only, preferably exchanged for short-lived tokens. Clear them on disconnect/expiry/reload. No localStorage, sessionStorage, IndexedDB, URLs, service-worker caches or persisted API history for secrets. A browser-held token is visible to that user and vulnerable to XSS; in-memory is not equivalent to a server-side secret.

Direct requests require verified CORS for actual methods and headers (`Authorization`, `Content-Type`, `If-Match`, `Idempotency-Key`, ranges and metadata) and exposure of relevant response headers. This is presently unverified. Do not solve unsupported CORS by making speculative Telegraph changes; use the protected Pages transport if needed.

For either mode, bundle or deliberately constrain script dependencies, safely render arbitrary remote content, and scope credentials to a connection origin. The old unauthenticated server model must not become the production security model.

## 8. File disposition

### Keep / adapt / move useful parts

| Existing file | Proposed treatment |
| --- | --- |
| `dashboard-ui/index.html` | Keep shell/layout/modal/toast patterns; change branding, connection navigation and script loading; remove unsupported table-management controls. |
| `dashboard-ui/assets/styles.css` | Keep useful styling; extend for new views. |
| `dashboard-ui/app/icons.js` | Move to `app/ui/icons.js`; preserve existing SVG assets/attribution as applicable. |
| `dashboard-ui/app/helpers.js` | Move simple formatting helpers; replace route parsing, field-name transformation and validation. |
| `dashboard-ui/app/utils.js` | Extract toast/button lifecycle concepts into UI modules; fix rendering and async cleanup. |
| `dashboard-ui/app/templates.js` | Retain layout concepts only; replace unsafe interpolation and index-based actions with safe components. |
| `dashboard-ui/app/eventListeners.js` | Preserve interaction intent; split into router and view/controller events, using controlled submits/delegation. |
| `dashboard-ui/app/index.js` | Keep a small bootstrap entry point; initialize configuration/state before resource loading. |

### Replace / retire during implementation, not this audit

| Existing file(s) | Replacement |
| --- | --- |
| `index.js` | Build/dev tooling; no production Node bootstrap. |
| `server/server.js`, `server/routes/index.js`, `server/controllers/index.js` | Remove local business API; connector talks to Telegraph, optionally through the stateless credential gateway. |
| `server/db.js`, `server/databaseUtils/index.js` | Connector document operations; no filesystem database. |
| `server/internalDB/{index.js,helpers.js,db.json}` | Schema/config/inference modules in memory; delete persistent metadata layer. |
| `server/utils.js`, empty `server/helpers.js` | Remove filesystem validation/legacy scaffolding. |
| `dashboard-ui/app/services.js` | Connection transport plus connector modules. |
| `dashboard-ui/app/actions.js`, `ui_helpers.js` | View controllers + state + safe rendering; preserve UX, not DOM-scraped data flow. |
| `package.json`, `package-lock.json` | Replace runtime dependency/scripts assumptions; remove Express/lowdb/chalk/dotenv/nodemon if no longer used; add actual build/test/Pages tooling. |
| `.env` | Remove from tracking; use ignored local runtime config and checked-in placeholders only. Audit history for real secrets before deciding whether rotation is needed. |
| `.gitignore`, `README.md` | Update ignores, project identity, runtime secret guidance, capability limitations and deployment instructions; preserve appropriate attribution. |

### Create

The connection, connector, schema, state/router, file-view, API-tool, safe-UI, test and deployment files in the proposed tree. Only this audit document is created in the current phase; these modules are proposals, not implemented features.

## 9. Migration risks and recommended sequence

### Highest risks / acceptance gates

1. **Data corruption from identity/type loss.** All CRUD must retain stable IDs, JSON types, managed-field separation and versions. Tests must cover booleans, zero, null, nested values, unusual field names and deletion followed by further edits.
2. **Credential exposure through rendering or deployment.** Close unsafe HTML paths before adding credentials. Verify no credentials in bundles, URLs, storage, logs, API history, exports or static artifacts; enforce gateway operator authentication.
3. **Missing resource/schema discovery.** Obtain the intended collection/bucket names and any field descriptors through approved configuration; do not promise automatic discovery or console management through developer credentials.
4. **Contract drift.** Resolve documented envelope/precondition/limit inconsistencies with authorized examples and connector contract tests. Keep compatibility behavior isolated and explicit.
5. **Concurrency and retries.** Preserve versions; handle conflicts without overwriting user intent. Test idempotency, rate limits, cancellation and stale responses across navigation/connection changes.
6. **Pages/direct-browser behavior.** Validate CORS if using direct mode; otherwise validate protected Function routing, preview/production configuration separation, streaming uploads/downloads and secret bindings.
7. **Scope mismatch.** The supplied project is a target, not proof that a future credential belongs to it. Do not present unverified project/scope metadata as authorization; validate verified token claims where applicable and let Telegraph enforce access.
8. **No safety net today.** Add tests before removing legacy behavior; current `npm test` cannot validate a migration.
9. **Legacy file data is separate from application migration.** No copying/importing existing JSON data into Telegraph is implied or authorized. Preserve external files and obtain explicit approval for any later data migration.

### Suggested implementation sequence after audit approval

1. Establish build/test setup, safe rendering primitives, public configuration and in-memory state. Keep the useful static shell.
2. Define connector contracts and fixtures; settle managed-secret gateway vs direct-session deployment and its authentication boundary.
3. Implement Telegraph read-only document browsing against configured resources. Verify envelope/ID/version handling and pagination before enabling writes.
4. Add typed create/update/delete with confirmations, expected versions, error handling, idempotency and conflict UX.
5. Add Bearer file views and OpenAPI request tools using the existing connection transport. Do not implement unsupported S3 features or console management.
6. Validate Cloudflare Pages preview/production deployment and credential handling; retire Express/lowdb/internal schema files and replace documentation.

No second database, speculative Telegraph endpoints, Telegraph schema changes, production mutations, or full rewrite is part of this audit.
