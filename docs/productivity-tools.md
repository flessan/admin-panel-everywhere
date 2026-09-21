# Productivity tools

The **Tools** workspace provides **Import, Export, Bulk edit, JSON editor,
Duplicate, API request builder and Media/file tools**. It is a browser-only layer
over the same connection contract, not a second database, backend or job queue.

## Choosing data

- Enter a known collection to load 20 records; **Load 20 more** accumulates up
  to **100** records. There is no guessed collection-enumeration endpoint.
- Or choose **Tools for this page** in Data / **Use current Data page / schema**
  in Tools. This copies exactly the current Data page, including filtered or
  later-page records, their reviewed versions and the advisory schema. It does
  not refetch an unfiltered first page or reinterpret an opaque cursor. Use Data
  pagination to reach records beyond the first Tools window.
- Check individual records or **Select all loaded records**. Selection never
  means all remote records. Loading another collection clears it; loading more
  within a Tools window retains existing reviewed versions and selection.
- Data and Tools are session snapshots, not live replicas. Refresh Data before
  handing its page over when freshness matters. **Reload collection** in Tools
  starts an unfiltered first page. Refresh other workspace views after writes.
- Schema metadata can come from the connector, Data's session metadata or an
  explicitly supplied session schema. It is not an authoritative schema change.
  The backend still validates every write.

## Import

Paste text or read a **UTF-8 JSON/CSV file, at most 5 MiB**. Each batch contains
1–100 documents. Reading files is local; choosing one never uploads it.

JSON must be an array of editable document objects:

```json
[
  {"title":"First","active":false,"metadata":{"labels":["example"]}},
  {"title":"Second","active":true}
]
```

Record envelopes, top-level IDs/versions/timestamps, non-finite numbers,
oversized documents and invalid schema values are rejected. There is no
heuristic envelope unwrapping or upsert: import **creates new server-assigned
IDs**. All rows pass local validation before a plan can execute. Local validation
covers JSON syntax/shape, the existing 96 KiB document guard, 32-level/10000-node JSON limits and supported
schema hints; it is not a full JSON Schema engine or a server-side dry run.

### CSV boundary

CSV requires an explicit, scalar-only schema: text, number, boolean, datetime
and string select fields. Unknown, JSON/file or unsupported schemas require
JSON instead; no flattening or guessed type coercion is performed.

- At most 100 columns; header names must be unique, nonempty and match the schema.
- Quoted commas, escaped quotes, embedded newlines, CRLF and a UTF-8 BOM work.
- Text remains text, including leading zeroes and empty strings.
- Numbers use finite JSON numeric notation; unsafe integers, hexadecimal,
  ambiguous whitespace and boolean `1`/`0` are rejected.
- Booleans are `true`/`false`; datetime/select values use existing schema checks.
- Empty numeric/boolean/datetime cells represent omitted fields. An empty select
  cell is preserved if it is a declared choice, otherwise omitted. Required
  fields/default hints are validated accordingly.
- Malformed rows or any invalid document prevent the entire *local plan* from
  being prepared. Once execution starts, server outcomes can still be partial.

## Export

Choose selected or all **loaded** records and explicitly download JSON or CSV.
This is not an exhaustive collection export or a full backup. JSON exports the
editable document array, omitting managed metadata, so it can be imported as
new records. Large exports may need splitting to fit the import limits.

CSV requires the same scalar schema, no unmodeled fields, no null values and
consistent field presence across rows. It refuses representations that would
silently flatten nested data or confuse missing/null values. Spreadsheet
formula-like strings and headers are prefixed with an apostrophe, including
leading whitespace/control variants. The UI reports altered cells. CSV is not
an exact text round trip in those cases: **use JSON for exact editable values**.

Downloads use the existing Blob attachment manager, with sanitized filenames
and revoked object URLs. Record contents are intentionally exported as data,
not anonymized. Exports and reports may contain sensitive business information;
review them before sharing. Authentication headers/credentials are not part of
these exports and no app-managed browser persistence is added.

## Bulk update/delete and duplicate

Prepare a plan, inspect its per-record details/diffs, type the exact target
collection and acknowledge the writes. No request is sent by previewing a plan.
The acknowledgement resets after each execution/retry action.

- **Update:** supply explicit top-level replacement fields, applied to each
  selected record. Validate each complete merged document first. Unchanged
  records are skipped. Nested objects/arrays are replacement values, not a
  recursive merge. No increments, transformations, JSON Patch, deletion syntax
  or hidden bulk endpoint is invented.
- **Delete:** review exact IDs, data and expected versions. Deletions are
  irreversible here; each uses the reviewed version.
- **Duplicate:** create each reviewed document's editable data in the same
  collection with a fresh server ID. Managed fields are not copied. File
  references remain references; remote object bytes are not duplicated.

The UI uses `connection.database.createRecord`, `updateRecord` and `deleteRecord`
only. Telegraph maps those to its documented single-record POST/PATCH/DELETE
routes. There is **no** `/bulk`, import/export endpoint, transaction, rollback,
collection-management API or filesystem persistence layer.

### Execution, cancellation and retries

One request is in flight per batch. Attempts start at least **3.1 seconds apart**
by default, conservatively respecting Telegraph's documented 20 mutations per
60 seconds per project. Other clients/workspaces share that limit; a batch is
not a reservation of quota.

Progress shows counts and each row's pending/running/succeeded/skipped/failed
status and attempt count. A partial result never masquerades as all-success.
An optional operation report contains row/record IDs, reviewed versions, status,
attempts, result IDs and safe errors—not bodies, auth headers or retry keys.

- **Stop after current request** cancels pacing and prevents queued requests.
  It deliberately lets an active write settle to reduce ambiguous outcomes.
  Completed operations are never rolled back. Resume pending jobs explicitly.
- **429** pauses all remaining work and enforces a conservative **60-second
  cooldown** before retries or resumption. No automatic backoff/retry request is
  made. The service can still reject a later attempt if shared quota is exhausted.
- Transport/timeouts/5xx outcomes may be unknown: pause rather than flooding
  the queue. **Retry eligible failures only** is explicit and never includes
  succeeded/skipped rows. Failed jobs and pending jobs are separate actions.
- Creates retain **one immutable body and Idempotency-Key per row** for every
  retry. A connector receives copies of the retained payload. Keys stay only in
  memory; do not assume the server's idempotency retention lasts indefinitely.
  After a long delay, inspect the backend before retrying or starting a new plan.
- Updates/deletes retain the original **expected version**, including retries.
  A 409 is never silently rebased or overwritten. Conflict/validation failures
  are not eligible for automatic or one-click retry; discard, reload, correct
  and review a new plan. An ambiguous successful write may produce a conflict
  or missing-record error on retry; it is not inferred to have succeeded.
- Authentication/unsupported-operation failures pause the queue. Reconnect or
  correct the problem deliberately; nothing is silently retried on reconnect.
- After any write attempt, the plan/inputs are locked. Discarding attempted
  plans requires acknowledgement and loses retry keys, drafts and results.
  Check uncertain outcomes first. Reload before preparing another plan or
  exporting a fresh Tools view. Before discarding, copy needed proposed values
  from the visible diff and download the report if required.
- Disconnect/connection replacement aborts requests and discards all transient
  state. An in-flight write might already have completed. Epoch/revision guards
  prevent late responses, file reads or checksums from repopulating a different
  connection's workspace. Nothing resumes automatically after page reload.

## JSON editor

Select exactly one record and **Load current selected record** via the connector.
Edit raw, unmanaged document JSON, **Validate and format**, then **Validate and
review diff**. The displayed top-level additions/replacements correspond to the
PATCH that will be sent. Top-level field removal is rejected because the API
does not document a removal syntax.

Saving is the same confirmed plan execution used by bulk actions and includes
the version fetched for review. Editing again invalidates an unexecuted plan
and its acknowledgement. Invalid drafts never execute. On conflict, the current
draft/diff remains visible in the attempted plan until explicit discard; there
is no automatic merge, overwrite or save against an unseen new version.

## API request builder and media/file tools

The Tools launcher opens the existing **API Explorer** and selects its builder
view, preserving the connector-owned OpenAPI catalog, approved routes,
parameters/body editors, mutation acknowledgement, response inspection and
redacted cURL/JavaScript examples. There is no second request implementation.

Media/file tools add **local size/type/SHA-256 inspection**, bounded to 20 MiB,
without uploading, inline rendering or executing file contents. The MIME type
is the browser's hint, not malware detection. The checksum is not a server ETag
or concurrency precondition. HTTPS/secure-context Web Crypto is required.

Remote uploads, downloads/ranges, HEAD metadata, prefix navigation, API-address
copying and confirmed deletion reuse the **Files** workspace and storage
connector. No remote image transforms, bulk object deletes, S3 signer, copy,
rename or presigned URLs are invented. File/object deletion still has the
existing documented concurrency limitation; document version rules are not
borrowed for object writes.

## Implementation and verification

- `app/tools/documents.js`: reusable import/export codecs, bounds, validation and
  top-level document diffs; shares existing Data schema helpers.
- `app/tools/controller.js`: backend-neutral selection, immutable reviewed jobs,
  serial pacing, version/idempotency handling and cancellation/retry state.
- `app/tools/view.js`: text-only DOM rendering, file-read guards, explicit
  confirmations, reports/downloads and existing-workspace launchers.
- `app/tools/media.js`: bounded local file inspection with Web Crypto.

Future connectors must honor the existing expected-version and create-idempotency
options, or reject unsupported mutations rather than silently ignoring safeguards.
The workspace does not manufacture these guarantees for a backend.

No runtime dependency, backend or Pages Function was added. The static build's
side-effect-import scanner was narrowly corrected to distinguish actual import
declarations from literal UI strings such as `'import'`; production imports
remain relative browser modules.

Tests cover codecs/types, CSV injection defenses, previews/validation before
writes, version conflicts, partial outcomes, stable idempotency keys and payloads,
no replay of successes, pacing, cancellation, rate-limit cooldowns, disconnect
races, current Data-page handoff, safe DOM, file-read races, checksum inspection,
real connector HTTP contracts and the real app entry flow. HTTP calls in tests
use mocks and synthetic credentials. No live authenticated Telegraph operations
or production data mutation was performed.

References: https://telestorage.pages.dev/llms-full.txt and
https://telestorage.pages.dev/openapi.json. The published guide documents version
preconditions, create idempotency keys and the shared mutation rate limit; the
connector's existing allowlisted API surface remains unchanged.
