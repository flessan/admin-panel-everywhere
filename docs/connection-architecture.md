# Connection architecture

This document describes the connection boundary. The subsequent [Data workspace](database-integration.md) now uses it for document workflows. All new runtime modules are native browser ES modules using Web APIs. They require no Express runtime, filesystem, database, framework, bundler, or new runtime package.

## Layers

```text
view → services.js → selected Connection
                      ├─ metadata
                      ├─ authentication
                      ├─ discovery
                      ├─ database
                      ├─ storage
                      └─ api
                              ↓
                   connector-owned route policy
                              ↓
                   controlled request client
                              ↓
                       remote backend
```

- `dashboard-ui/app/connection/types.d.ts`: structural connector interface and return types (editor documentation, no TS build required).
- `connection/contract.js`: validates required namespaces/methods at runtime.
- `connection/active.js`: explicit selection and disconnect lifecycle; replacing a connection disconnects the previous one.
- `connection/authentication.js`: credential held in a private in-memory closure, with no getter on the public Connection.
- `connection/request-client.js`: sole raw fetch boundary, JSON/binary responses, cancellation/timeouts, normalized errors, safe diagnostics.
- `connection/openapi.js`: caches and exposes the document/catalog; executes only documented operations that also pass the connector's local policy.
- `connectors/telegraph/`: Telegraph configuration, routes, document/file mappings and capabilities.
- `services.js`: existing UI vocabulary translated into backend-neutral connector methods. No URL or credential construction.

`defineConnection()` can accept another implementation without changing the UI services. An alternate non-Telegraph connector is used in the service tests to exercise that boundary. Unsupported operations should reject with `ConnectionError('unsupported_operation')`, not fabricate remote success.

## Runtime configuration

Create the connector with an explicit runtime configuration object:

```js
import { createTelegraphConnection } from './app/connectors/telegraph/index.js';
import { setActiveConnection } from './app/connection/index.js';

// runtimeConfiguration must come from a runtime session/configuration provider.
// Do not replace this variable with a literal real key, a public JSON file,
// a build-time environment substitution, a URL parameter, or browser storage.
const connection = createTelegraphConnection(runtimeConfiguration, {
  // Optional resource hints. These are not remote collection discovery.
  collections: [
    'notes',
    {
      name: 'products',
      schema: {
        type: 'object',
        properties: { title: { type: 'string' } },
      },
    },
  ],
});
setActiveConnection(connection);
```

Required keys in `runtimeConfiguration`:

| Key | Meaning |
| --- | --- |
| `TELEGRAPH_URL` | HTTPS origin only, e.g. `https://telestorage.pages.dev`. No userinfo, path, query or fragment. |
| `TELEGRAPH_PROJECT` | Expected project metadata/context, e.g. `prj_1aNS55cTr8BiqBZy8LWFRw`. |
| `TELEGRAPH_API_KEY` | Runtime Bearer credential. Never exposed by connection metadata or serialized Connection values. |

**Project context is not authorization.** The connector does not insert the configured project into request paths, bodies, query parameters or headers. Telegraph verifies the credential to determine the authorized project/scopes. `authentication.configured` means a credential is present, not that it was remotely verified or that its scopes match the UI's needs.

`.env.example` contains non-secret defaults and an empty key. The browser does not load `.env` and the connector does not inspect `process.env`, `import.meta.env`, or storage. A Worker/Function host could pass its private runtime bindings to the same factory; that host's authentication/gateway is not implemented in this phase. Never return those bindings to a browser as a configuration endpoint.

In browser-only mode a future connection form/session provider can supply the user's credential in memory. The Data workspace now supplies a runtime connection form. It does not automatically connect to production, mint tokens, or verify production credentials at initialization. Until a host selects a connection, the shell displays **No connection configured** and makes no API calls. Clear the provider's own references/inputs after use; the library cannot erase references owned by its caller.

Use `setActiveConnection(null)` to disconnect the selected connection and clear its visible data. A standalone `connection.disconnect()` clears its credential, aborts active requests and invalidates its discovery cache. `authentication.clear()` only clears the credential; already-issued requests are not revoked. The connection is terminal after disconnect—create a new one to reconnect. There is no persistent credential or data store.

## Database interface

```js
await connection.database.listCollections();
await connection.database.getCollection('notes');
await connection.database.getCollectionSchema('notes');

const page = await connection.database.listRecords('notes', {
  limit: 20,
  // cursor: previousPage.nextCursor,
  filters: { title: 'hello' }, // indexed top-level string equality; at most four
});
const record = await connection.database.getRecord('notes', 'rec_...');

const created = await connection.database.createRecord('notes', { done: false }, {
  idempotencyKey: crypto.randomUUID(),
});
await connection.database.updateRecord('notes', created.id, { done: true }, {
  expectedVersion: created.version,
});
// Re-read/use the update response before a later delete: its version has advanced.
```

Signatures and behavior:

| Method | Result / behavior |
| --- | --- |
| `listCollections()` | `{items, source:'configured', complete:false}`. Only configured names, never an authoritative remote list. |
| `getCollection(name)` | `{name, schema, schemaSource}` descriptor; does not prove remote existence. Unknown schemas are `null`. |
| `getCollectionSchema(name)` | `{schema, source}`; `configured` or `unavailable`. |
| `listRecords(name, options)` | `{items: RecordEnvelope[], hasMore, nextCursor}`. No invented totals. |
| `getRecord(name, id, options)` | `RecordEnvelope`. |
| `createRecord(name, data, options)` | `RecordEnvelope`; handles 201; supplies `Idempotency-Key`. |
| `updateRecord(name, id, changes, {expectedVersion, signal})` | PATCH with `_expected_version`; returns the new envelope. |
| `deleteRecord(name, id, {expectedVersion, signal})` | DELETE with `_expected_version`; returns `{deleted, version, deletedAt}`. |

A `RecordEnvelope` is `{id, data, version, createdAt, updatedAt}`. Values inside `data` retain their JSON types. Published top-level `id` and nested `data.id` response forms are accepted; conflicting IDs are rejected. Managed fields cannot be supplied as create/update data. Pass only changed editable fields, not the whole response envelope.

Default list size is 20, maximum 100. Cursors are opaque. Creates get a UUID idempotency key if omitted; for a retry of the same create attempt, explicitly retain and reuse the same key and body. The client performs **no automatic retries**. A 409 surfaces `ConnectionError` with `code: 'version_conflict'`, `status`, and `currentVersion`; views must decide how to reload/resolve it. Missing expected versions fail before a request is sent.

The developer API has no collection-list, schema-get, empty-collection-create or collection-delete endpoint. Configured schemas are advisory client descriptions, not guaranteed backend validation rules. No endpoints were added or inferred. Console management remains outside this connector.

## Storage interface

```js
const page = await connection.storage.listObjects('media', { prefix: 'photos/', delimiter: '/' });
const metadata = await connection.storage.getObjectMetadata('media', 'photos/example.png');
const result = await connection.storage.downloadObject('media', 'photos/example.png');
// result.data is a Blob. If a view creates an object URL, it must revoke it afterward.
await connection.storage.uploadObject('media', 'photos/example.png', fileBlob, {
  contentType: 'image/png', metadata: { label: 'example' },
});
await connection.storage.deleteObject('media', 'photos/example.png');
```

- Bearer `/api/storage` only. No S3 credentials, presigned URLs or multipart behavior.
- List result: `{items: FileEntry[], hasMore, nextCursor, commonPrefixes}`. File entries normalize `content_type`/timestamps into camelCase fields.
- HEAD result: metadata including size, content type, ETag, object version, last-modified and custom metadata. Unexposed/missing numeric headers are `null`.
- Download result: `{data: Blob | null, status, headers}`, supporting range/conditional headers, 206 responses and bodyless 304 responses for `If-None-Match`.
- Upload accepts Blob/ArrayBuffer/typed arrays, checks the documented 20 MiB limit and sends raw bytes. Both published wrapped/unwrapped object metadata response forms are normalized.
- Object keys retain path separators while individual segments are encoded; traversal segments are refused.
- Default file list limit is 50, capped conservatively at 100 because prose and OpenAPI disagree about the maximum.
- Bucket enumeration is not invented. `listBuckets()` exposes explicitly configured names as an incomplete catalog; callers can also supply a known name. Successful deletion returns `{deleted:true}`. `getObjectUrl()` returns a credential-free authenticated API address, never a public/presigned link.

## Discovery and controlled API requests

```js
const document = await connection.discovery.discoverOpenApi(); // public, no Bearer header
const endpoints = await connection.api.listEndpoints();
const result = await connection.api.execute({
  endpointId: 'GET /api/db/{collection}',
  pathParameters: { collection: 'notes' },
  query: { limit: 10 },
});
```

The catalog includes `id`, HTTP method, path template, operationId, tags, summary/description, deprecated state, inherited/overridden security, security schemes, merged parameters, resolved requestBody/responses, reference warnings and `executable`. Both `discovery` and `api` expose document/catalog discovery. Data is copied on return so a consumer cannot modify cached execution policy. `{refresh:true}` reloads the document.

Execution requires a catalog endpoint **and** a matching local Telegraph method/path allowlist. Remote `servers`, external references and credential declarations cannot redirect requests or alter authentication. S3, dashboard management and arbitrary undocumented destinations remain non-executable. No remote reference is fetched automatically, and the editor is not a full OpenAPI/JSON Schema validator.

API execution takes `pathParameters`, `query`, allowed `headers`, `json` or binary `body`, `signal` and optional `responseType`. It returns `{data,status,headers}`. Mutations also require `allowMutation:true`; the API workstation obtains explicit acknowledgement before setting that flag. The generic API tool is intentionally lower-level than the typed database/storage conveniences; the upstream API validates its body. This opt-in is a UX guard, not an authorization boundary.

Public discovery/health/JWKS calls omit credentials. Allowed developer operations send exactly:

```text
Authorization: Bearer <runtime TELEGRAPH_API_KEY>
```

The request client rejects caller-supplied Authorization/Cookie/API-key headers, sensitive query names and accidental placement of the active credential in URLs. It forces `credentials:'omit'`, `redirect:'error'`, `cache:'no-store'` and `referrerPolicy:'no-referrer'`. It never follows a redirect with a credential. Only connector-owned route policies should call the transport; UI modules should use the Connection interface.

Optional diagnostics receive only fixed event names, HTTP methods and numeric statuses. No URL, project, headers, payload, response body, raw network exception or credential is logged. Known stable upstream error codes are retained; arbitrary error text is discarded. Raw successful API responses—including a token-exchange result—are still sensitive application data: callers must not log or persist them. The API workstation instead uses `api.inspect` to receive bounded, redacted HTTP responses (including errors), and `api.previewRequest` for safe request descriptions. Its last 50 executed requests are held only in redacted session memory. `api.sanitize`/`sanitizeDocument` keep credential-aware redaction at the connector boundary. See [API tooling](api-tooling.md).

## Current UI integration and scope boundary

The Data workspace uses `data/controller.js` and safe DOM views for collections,
records and schema. It now includes typed/version-aware mutation flows, not the
read-only shell from the first connection phase. See [database integration](database-integration.md)
for exact behavior and the current collection-discovery limitation.

The old positional actions/templates/event helpers and Express/lowdb backend
have been removed. The small `services.js` compatibility facade is retained, but
the active Data controller calls the connector directly. The Files workspace is now implemented through the same storage interface; see [object storage](object-storage.md). The API workspace uses backend-neutral controllers/views and the OpenAPI tooling hooks; see [API tooling](api-tooling.md). A managed-secret gateway remains outside this implementation.

## Static / Cloudflare Pages deployment

Run **`npm run build`** and deploy **`dist/` as the Cloudflare Pages output directory**. Do not deploy the source directory or repository root. The explicit build copies only the active static graph, public URL/project defaults and Pages security metadata; see [production deployment](deployment.md). All active module imports are relative browser ES-module imports. No runtime Node imports or dependencies were added.

Direct browser requests require the backend to permit the deployed origin, methods and request headers via CORS and expose metadata headers. This phase has **not verified live CORS**. No speculative Telegraph CORS/backend change was made. A deployment-managed key must instead stay in a future authenticated stateless Pages Function; there is no such gateway in this phase and no safe way to make a server-side Pages secret directly available to static browser code.

The `npm run dev` command builds and starts a development-only, read-only static preview on `0.0.0.0:3214`; `npm start`/`npm run preview` serve an existing `dist/`. Express, lowdb and their runtime dependencies have been removed. Production does not run this development server. `.env` has been removed from Git tracking without deleting the local legacy configuration; environment files and Wrangler state are now ignored.

## Verification

Run `npm test` (Node 22 recommended; uses the built-in test runner and fetch Web APIs). Tests are deterministic mocked contract tests. They do not read `.env`, use real keys, create backend resources, or contact Telegraph.

Covered: initialization, missing/invalid config, contract shape, backend-neutral service delegation, Bearer ownership/public unauthenticated discovery, project context isolation, request encoding, stable IDs/preconditions/idempotency, JSON/binary responses, unsupported operations, OpenAPI caching/policy, no-secret diagnostics, cancellation/timeouts, disconnect and upload limits.

Contract sources read before implementation:
- https://telestorage.pages.dev/openapi.json
- https://telestorage.pages.dev/llms.txt
- The full docs and AI guide read during the preceding audit; discrepancies are listed in `architecture-audit.md`.

Live response compatibility, automated collection/schema discovery, managed operator authentication, CORS and token renewal remain integration gates. Data UI workflows are covered by mocked controller/DOM tests; see the Data workspace documentation.
