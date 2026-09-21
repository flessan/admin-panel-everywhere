# API workstation

The **API** workspace has four sections: **Overview**, **Explorer**, **OpenAPI**,
and **Request history**. It is a static browser client, not another service or
persistent data layer. Existing Data and Files workflows remain independent.

## Using it

1. Connect with runtime configuration. The key stays in the connection's memory;
   the configuration input is cleared immediately after submission.
2. Open **API**. Discovery is lazy: entering it loads the connected backend's
   OpenAPI once; **Reload OpenAPI** explicitly refreshes it. Connecting alone
   does not make an HTTP request.
3. In **Explorer**, filter operations by method/path/summary/tag and select one.
   Review its parameters, resolved body schema, documented responses, and
   security requirements. Operations with multiple tags appear in each group.
4. Include optional parameters explicitly; supply every required path/parameter.
   Select a documented content type and enter JSON/text or choose a binary file.
   Examples/defaults are never automatically inserted into request editors.
5. **Generate examples** validates/builds a connector preview without executing
   the selected operation. Copy cURL or JavaScript; the readonly textareas also
   support manual copying if clipboard access is unavailable.
6. **Execute request** is the only operation-execution action. Non-GET/HEAD
   requests require acknowledgement, reset after submission. There are no
   automatic retries, history replay, or background operation requests.
7. Inspect the HTTP status, browser-exposed response headers and redacted body.
   HTTP errors (including 401, 409, 412, 416 and 429) remain inspectable. Network,
   CORS, cancellation and timeout errors have safe messages rather than raw
   exception details. Cancel cannot undo a mutation already accepted upstream.

The low-level explorer does **not** inherit typed Data/Files conveniences such as
adding `_expected_version`, selecting an idempotency key, resolving conflicts or
validating object upload limits. Supply the documented request explicitly; the
backend remains authoritative. Use the typed workspaces for those workflows.

## Document authority and supported operations

Source reviewed: **https://telestorage.pages.dev/openapi.json** (OpenAPI 3.1.0,
Telegraph Cloud API 1.0.0). At implementation time it documented 19 operations:

| Tag | Documented | Executable with current connector |
| --- | ---: | ---: |
| Database | 5 | 5 |
| Storage / Bearer Object API | 5 | 5 |
| S3 | 5 | 0 |
| Platform | 4 | 4 |

These counts are **not hard-coded into the catalog**. Reload reflects the actual
connected document. Only operation entries under OpenAPI `paths` appear; none
are synthesized from CRUD assumptions or console URLs. Local connector policy
is an independent second gate: an operation must be both documented and
allowlisted to execute. A spec can document a future operation without granting
it permission. Remote `servers`, security declarations and `$ref` URLs never
change the configured request origin or authentication policy.

Telegraph's S3 operations require separate AWS SigV4 signing. They are visible
for documentation only. This UI neither loads S3 secrets nor signs requests,
and never pretends a Bearer token is S3 authentication. It intentionally offers
no executable unsigned/Bearer S3 snippet.

The generic parser supports OpenAPI 3.0/3.1, tag grouping, inherited security,
explicit public overrides, path/operation parameter merging by location/name,
and local JSON-pointer references. External/unresolved/circular references are
retained, not fetched; depth and expansion budgets bound reference resolution.
The OpenAPI view displays a redacted, read-only document; Explorer displays
resolved schemas. It is not a full OpenAPI or JSON Schema validator.

## Request editor boundaries

- Primitive path/query/header inputs: string, integer, number and boolean, basic
  required/range/enum validation. Standard simple path/header and form query
  serialization only. Complex object/array/content parameters, cookies and
  unsupported styles are not silently serialized.
- JSON and `+json` request media types preserve arbitrary valid JSON, with finite
  numbers. Required body presence and declared content type are checked. Full
  schema constraints, formats, discriminator/oneOf logic etc. are displayed but
  are not enforced by the editor.
- `application/octet-stream` uses a transient File. Documented text/XML types use
  a text editor. Multipart, form encoding and advanced binary MIME encodings
  are not implemented.
- Extra query/header JSON is for **documented** dynamic contracts, e.g. the
  unnamed exact-match database-filter parameter and `x-amz-meta-*` headers.
  This does not invent names or endpoints: users supply documented values and
  connector policy rejects unsupported names. Credential inputs/overrides are
  rejected. The backend validates query/header semantics.

## Security and history

- Authentication belongs to the connector, never form fields or generated URLs.
  Authorization comes from the runtime key. Caller Authorization/Cookie/key
  overrides, sensitive query names and the active key in a URL are rejected.
- Requests use the controlled client: `credentials: 'omit'`, `redirect: 'error'`,
  `cache: 'no-store'`, `referrerPolicy: 'no-referrer'`. Public document/health/JWKS
  routes do not receive the key. Diagnostics contain only fixed events, method
  and numeric status, not URLs, credentials, bodies or raw errors.
- Responses are redacted **at the credential-owning transport boundary**, before
  entering controller/UI state. Active credentials and encoded forms, recognized
  secret fields, Authorization/cookie headers, issued access tokens, recognizable
  Telegraph keys/JWTs and common textual credential assignments are scrubbed.
  Recognized secret string values of four or more characters are also scrubbed
  from aliases in the same envelope; shorter secret fields are themselves
  masked. Document examples/default values are omitted while schema definitions
  remain inspectable. Redaction is not a general business-data anonymizer and
  cannot identify every arbitrary secret hidden under an unknown field name.
- Response text/JSON previews are limited to **64 KiB**. Larger bodies are omitted
  entirely, not partially displayed across a potentially sensitive boundary.
  Binary or unsupported-encoding bytes are summarized, not rendered/downloaded.
  Request-body previews over 64 KiB are omitted and represented as runtime-file
  inputs in examples; binary bytes are never placed in history.
- All untrusted content is rendered using text/value DOM APIs, not HTML. Snippets
  are text only and are never evaluated by the application.
- cURL quotes user values, disables URL globbing, avoids redirects/verbose
  output, uses literal text bodies (`--data-raw`, avoiding `@file` expansion), and
  uses `${API_TOKEN}` supplied at runtime. File bodies are explicit external-file
  placeholders. HEAD uses `--head`. JavaScript exposes an async `sendRequest`
  function accepting `apiToken` and/or `bodyFile` at runtime and returns a Response
  without logging it. Redacted body placeholders must be replaced securely.
- History holds only the last **50** redacted executed request/result envelopes
  in memory. It records time, elapsed duration, method/path, redacted request,
  status/headers/body or a safe transport error. Clear history prevents pending
  requests from repopulating it. There is no localStorage/sessionStorage,
  IndexedDB, server persistence, automatic replay or key export.
- Disconnect/connection changes/page unload clear the workspace's editors,
  examples, responses and history. Epoch/revision guards discard late discovery
  and execution results. Copying or saving examples moves data outside this
  in-memory lifecycle; review it before sharing and never insert keys into source
  files, URLs or shell history. Shell/runtime credentials have the usual local
  process-inspection risks; generated commands are not a secret store.

## Backend-neutral extension points

`dashboard-ui/app/api-tools/` imports no Telegraph connector and constructs no
backend URLs. It uses `connection.api`:

| Method | Purpose |
| --- | --- |
| `discoverOpenApi({refresh, signal})` | Load/copy the source document. |
| `listEndpoints({refresh, signal})` | Copy the parsed, policy-marked operation catalog. |
| `previewRequest(request)` | Validate using connector policy and return a redacted request descriptor. Must not execute the selected operation. |
| `inspect({...request, allowMutation})` | Return a bounded, redacted `{status, ok, headers, data, bodyKind, omitted}` including non-2xx HTTP responses. |
| `sanitize(value)` | Credential-aware scrubber for serializable UI state. |
| `sanitizeDocument(value)` | Scrubber preserving schema/security definitions while omitting example/default values. |

`execute` retains the pre-existing **programmatic**, raw-response API and error
behavior. The workstation deliberately uses `inspect`, not `execute`; raw
programmatic token exchange responses must never be logged or persisted.

Future connectors can reuse `connection/openapi.js` with their own document
loader, route policy/preview and credential-aware redactor. They must implement
these tooling hooks to enable UI execution; older interfaces remain browsable.
The current example formatter supports public and Bearer descriptors. Additional
auth/signing schemes need a compatible connector/formatter, not UI route guesses.
See `connection/types.d.ts` for descriptor types. A synthetic non-Telegraph
backend test exercises the same controller unchanged.

## Verification and integration gates

`npm test` includes deterministic tests for parsing/local refs, operation and
parameter rendering, request bodies, execution, HTTP-error inspection, redaction,
cURL shell quoting, JavaScript execution against a fake fetch, cancellation,
connection races, bounded/cleared history, DOM injection safety, copy fallback,
and real app-entry → real connector → mocked HTTP flows. Existing Data/Files
regressions remain part of the suite. Tests use synthetic credentials only.

No live authenticated reads/writes, token issuance, deployment, or browser CORS
verification were performed. Upstream must permit the deployed origin, methods
and request headers and expose response headers through CORS. Browser-hidden
headers cannot be recovered by the inspector. The app remains static/Pages-ready
without a production Node server or a new persistent backend.
