# Admin Panel Everywhere

A static universal admin client with a first-class **Telegraph Cloud document database, object storage and API tooling** integration. Run `npm run build` and deploy **`dist/` to Cloudflare Pages**—no production Node server, database, or startup process is required.

## Developer workspace

A responsive navigation shell brings **Overview, Data, Files, API, Tools,
Connections and Settings** together. Use **Ctrl/⌘ K** for quick navigation;
AI assist remains under Tools. Tables include copyable IDs, full JSON inspection,
compact/comfortable density and optional wrapping. Light/dark/system appearance
and all display preferences stay in the current tab only.

Overview reports actual session context—not demo metrics. All existing connector,
validation, concurrency and execution-confirmation boundaries are preserved.
See [workspace UI](docs/workspace-ui.md) for navigation and keyboard behavior.

## Data workspace

- Collections with loading/error/empty states and explicit catalog provenance.
- Record table, cursor pagination, indexed equality filters, and refresh.
- Create, edit, delete, duplicate, and raw JSON inspection.
- Expected-version writes and explicit conflict comparison/review.
- Forms for text, number, boolean, datetime, json, file references, and select fields.
- Schema-less JSON editing without lossy type conversion.

**Discovery limitation:** the current Telegraph developer API does not enumerate collections or expose collection schemas. Discover names/schema in the supported Telegraph console, then open an exact name or supply descriptors. No names or control-plane endpoints are guessed. See [database integration](docs/database-integration.md).

## Files workspace

- Known/configured buckets, prefix navigation, prefix-only search and cursor pagination.
- Raw-byte uploads (up to 20 MiB), authenticated downloads/ranges, and explicit deletion confirmation.
- HEAD metadata: size, content type, ETag, object version and custom metadata.
- Copy a credential-free **API address**, not a public/presigned share link.

The object API has no bucket-enumeration endpoint, so no names are guessed. It also
does not document conditional PUT/DELETE guarantees; those limitations are stated
in the UI. Normal workflows use the Bearer object API, **not S3**.
See [object storage](docs/object-storage.md) for semantics and limitations.

## API workstation

- **Overview**, **Explorer**, **OpenAPI**, and session-only **Request history**.
- Live OpenAPI catalog grouped by tags, with parameters, resolved body schemas and authentication requirements.
- Controlled request execution and status/header/body inspection, including HTTP errors.
- Copyable cURL and JavaScript fetch examples with runtime credential placeholders.
- Redacted, bounded in-memory history; no secret persistence, automatic retries or invented endpoints.

The catalog comes from the connected backend’s OpenAPI (Telegraph defaults to
`https://telestorage.pages.dev/openapi.json`). S3 remains documentation-only:
no browser SigV4 signer or Bearer substitute. The explorer is backend-neutral;
connector policy owns URLs, authentication and execution permissions.
See [API tooling](docs/api-tooling.md) for supported editors, security and limits.

## Productivity tools

- JSON import and schema-guided CSV import, with validation and preview before writes.
- Explicit JSON/CSV export of selected or loaded records—not an implied full backup.
- Multi-record selection, confirmed bulk update/delete and duplication through single-record connector operations.
- Raw JSON editing, formatting, validation and a reviewed diff before versioned save.
- Sequential progress, cancellation between requests, safe error reports and explicit version/idempotency-aware retries.
- Existing API request builder / Files workflows plus local file metadata and SHA-256 inspection.

Use **Tools for this page** in Data to carry a filtered or later page and its
schema into Tools, or load a known collection directly. Batches are bounded to
100 records and paced for Telegraph's shared mutation quota. No bulk endpoints,
atomic transactions or background server jobs are invented.
See [productivity tools](docs/productivity-tools.md) for limits and retry semantics.

## AI-assisted workflows

- Provider-neutral **AI assist** workspace with manual prompt/response mode and a trusted adapter registry—no live AI provider configured by default.
- Explicit, redacted context review: backend/project, loaded OpenAPI/schema hints, selected records/objects and current filters. Bodies and API errors are opt-in.
- Explain records/errors; propose test/schema-compatible data, JSON transforms, filters, read-only API requests and bulk edits.
- Strict structured proposals, cancellation/stale-context guards, and separate draft handoff to Tools/Data/API. AI never executes mutations.
- Existing authentication, backend validation, connector permissions and expected-version confirmation remain mandatory; credentials are not shared with a model.

See [AI workflows](docs/ai-workflows.md) for the manual workflow, adapter contract,
privacy limits and supported proposal shapes. No AI backend or database is added.

## Production deployment and local development

```sh
npm install              # use npm ci for reproducible CI installs
npm test
npm run build            # production artifact: dist/
npm run preview          # read-only local preview on 0.0.0.0:3214
```

For Cloudflare Pages: **Framework None · Build `npm run build` · Output `dist`**.
Node 22.22.3 is pinned for build/test tooling; production runs no Node process.
`wrangler.jsonc` configures static Pages with no Function, database or service bindings.

- `npm run dev`: build once and preview; rebuild/reload after source changes.
- `npm start`: local preview alias, not an Express or production server.
- `npm run pages:preview`: actual Pages emulator on port 8788.
- `npm run verify:pages`: bounded local Pages compatibility check; no deployment.

**Environment:** `TELEGRAPH_URL` and `TELEGRAPH_PROJECT` are public build defaults,
overridable in the runtime form. `TELEGRAPH_API_KEY` is accepted only as an
in-memory runtime session credential; a private Pages secret is **never bundled
or made available through a config endpoint**. A build-time key is not exported.
The browser starts disconnected and clears the key field after connection.

No lowdb, `DB_FILE_ABS_PATH`, filesystem persistence, local backend API or
production Express dependency remains. Old local `.env` files are not loaded.
Direct browser API requests still require Telegraph to permit your deployed
origin through CORS. A concealed deployment-key gateway would require a separate,
authenticated security design; there is no fake backend or public proxy here.

See **[Cloudflare Pages deployment](docs/deployment.md)** for exact settings,
secret boundaries, local iframe-preview options, CLI deployment and verification
limitations. Only `dist/` should be published, never the repository root.

## Architecture and documentation

- [Productivity tools, import/export and bulk safety](docs/productivity-tools.md)
- [Cloudflare Pages deployment and environment model](docs/deployment.md)
- [API workstation, security and extension points](docs/api-tooling.md)
- [Object storage workflows and limitations](docs/object-storage.md)
- [Database integration, capabilities, and limitations](docs/database-integration.md)
- [Connection contract, runtime configuration, and request security](docs/connection-architecture.md)
- [Original architecture audit and migration rationale](docs/architecture-audit.md)

The connection layer separates metadata, authentication, discovery, database, storage, and API operations. The UI invokes connector methods; only the controlled request client invokes fetch. Telegraph remains the sole remote data layer. The Data and Files workspaces use their respective connector operations. The API workstation uses the same connection boundary. An S3 browser signer and a managed-secret gateway are not implemented.

The old Express/lowdb backend, internal schema database, and positional/string-only editor have been retired. External legacy JSON data has not been modified or migrated.

## Attribution

This project began as [json-server Admin Dashboard](https://github.com/razaahmad333/json-server-admin-dashboard) by Ahmad Raza. Useful layout and interaction ideas informed this rework. The package retains the original MIT license declaration and author attribution.
