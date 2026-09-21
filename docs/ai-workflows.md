# AI-assisted workflows

AI assist is a **provider-neutral, review-first draft workspace** in the static
client. It is not a database, a backend, an autonomous agent, or a replacement
for the connection/connector APIs. There is **no live AI service configured**:
manual copy/paste works out of the box; trusted application adapters can be
installed explicitly. Nothing is sent when the workspace opens or captures
context.

## Using it

1. Connect normally. Load a Data collection, Files object, or OpenAPI in their
   existing workspaces. For record tasks, use **Tools for this page**, then
   select up to 20 records in Tools. Alternatively load a Tools collection.
   The Data source supplies schema/filter context, not record-editor drafts.
2. Open **AI assist**. Choose a task, working source and instructions. Select
   only the context you need. Record bodies, Files metadata and API errors are
   **off by default**; schema hints, loaded operations and current filters are
   on. No additional records, objects, schemas or remote references are fetched.
3. **Prepare redacted packet** and inspect the exact JSON. Reduce optional
   context if it includes business secrets. For a large catalog, select a
   particular operation in API and choose **Only the operation selected in API**.
4. Acknowledge sharing, then copy the packet to a model of your choice, or send
   it using an installed provider. An adapter receives **exactly the reviewed
   prompt string** and an AbortSignal. Its output must be one JSON object.
5. Paste the response and **Validate response** (installed adapters validate
   their responses automatically). Read the proposal/diff. Model text is
   rendered as text, never HTML, code, a query program or a tool invocation.
6. Separately acknowledge and **Hand off reviewed draft**. This stages a normal
   Tools plan, a Data filter draft, or API request inputs. It executes nothing.
   Tools still requires the exact collection name and execution checkbox.
   Filters require **Apply reviewed filters**; API requires preview/execute.

Prepared packets, model output and bindings are in memory only. Disconnect and
Clear AI session clear the workspace. There is no conversation persistence,
telemetry, localStorage, autonomous retry, model tool execution or background
job. Copying creates an OS/browser clipboard copy; the app cannot retract that
copy or data already sent to a provider. Provider retention/privacy policies
remain the operator's responsibility.

## Tasks and response contracts

Responses are strict JSON objects. Unknown root fields, fenced code, tool calls,
permission flags and unsupported kinds are rejected. Every task may instead
return `{"kind":"explanation","text":"Why context is insufficient…"}`.

| Task | Response / destination |
| --- | --- |
| Explain selected records | `{"kind":"explanation","text":"…"}`; text only |
| Generate test records | `{"kind":"create-records","documents":[{"title":"Synthetic"}]}`; Tools import review |
| Transform JSON | `{"kind":"transform-json","changes":{"title":"Replacement"}}`; one selected record, Tools update review |
| Build filters | `{"kind":"filters","filters":{"title":"Exact"},"limit":20}`; Data filter draft |
| Generate API request | `{"kind":"api-request","endpointId":"GET /api/health","parameters":[]}`; API input draft |
| Explain API errors | Explanation; requires explicitly included current failed API response/error |
| Suggest schema-compatible data | `create-records`; requires included schema hints; Tools import review |
| Prepare bulk edits | `{"kind":"bulk-edit","changes":{"active":false}}`; same explicit patch to all selected records, Tools review |

Examples illustrate shapes, **not** permission to invent fields or endpoints.
An API parameter is `{ "in": "path", "name": "collection", "value": "notes" }`.
Only unique, named, documented primitive parameters for included executable
GET/HEAD operations are accepted. No arbitrary URL, body, extra query/header,
credential input, signing configuration or AI-generated mutation API request.
The API workspace/connector still performs its normal policy checks before a
request. Unsupported S3 operations remain documentation-only.

Filters require at most four known indexed text/select fields and string equality
values. They replace, rather than secretly merge with, existing filters. Open the
same collection in Data before staging; there is no hidden navigation/fetch.

Creates are unmanaged document objects, never record envelopes or upserts.
Transform/bulk changes are explicit top-level replacements. Omitted fields
survive; nested values are replaced as a whole. No removals, increments, JSON
Patch, deletes or model-selected target IDs/versions are supported. Existing
JSON/schema validators validate whole candidate records, followed by the
existing Tools validators at handoff and backend validation at execution.
Credential-like field edits and redaction/omission placeholders are rejected;
intentional credential work belongs in the normal manual tools, not this path.

## Context and confidentiality

The packet allowlists:

- Backend connector/origin and configured project metadata (not authorization).
- Loaded collection schema field/type/required/index/options hints with source
  provenance. Hints are not proof of a server schema or permission to change it.
- Already-loaded OpenAPI operations and schemas; optionally only the selected
  operation. Defaults/examples are scrubbed.
- Explicitly selected Tools record IDs/versions and optional bodies. Data page
  bodies and open editors are not implicit selections.
- Optional selected remote object identity/size/type/ETag/version/time metadata;
  **no file bytes, custom metadata or download/presigned URLs**.
- Current Data filters/limit and Files bucket/prefix/delimiter, with provenance.
  Data filters need not describe a separately loaded Tools selection.
- Optional current API error/failed response, not request/history/auth objects.

The credential-owning connector must implement `api.sanitize` and
`api.sanitizeDocument`; AI sharing fails closed without them. Runtime credentials,
encoded/JSON-escaped echoes, sensitive field values/aliases, common token formats
and private keys are scrubbed. Additional local sensitive-value matching covers
cross-context aliases in instructions, schema enums, explanations and diffs.
Document-aware redaction avoids treating schema definitions as credentials.

No credential getter, session object, connector/controller, editor draft,
authentication headers, idempotency/retry keys or mutation callback reaches an
adapter. There is deliberately no AI credential-entry mechanism and the
Telegraph API key is **never** reused as an AI provider key. All automatic
redaction is heuristic for arbitrary business data: explicit packet review and
minimizing optional context are required, not a claim of perfect secret detection.
Record content, API descriptions and errors are untrusted data; the fixed prompt
says to ignore embedded instructions. Safety does not rely on the model obeying
that prompt: independent validation and explicit execution gates remain in force.

## Trusted bindings, cancellation and concurrency

The controller retains a private selected-record baseline, schema, collection
and source fingerprint. Public snapshots/providers cannot mutate this binding.
Source, selection, versions (including changes hidden by redaction), schemas,
filters, catalog/selected operation and connection changes invalidate proposals.
Instruction/inclusion/provider edits clear review and sharing consent. Editing
response text disarms the old proposal without losing the reviewed packet.

Cancellation, timeouts (60 seconds), changed context and disconnect discard late
provider output, including adapters that ignore AbortSignal. Errors from adapters
are fixed messages, not raw exceptions that might contain provider credentials.
There is no automatic retry. Already-sent data cannot be recalled.

Handoffs refuse existing Tools plans/editor/import/patch/schema drafts, dirty API
inputs or a pending Data filter draft rather than silently overwriting them.
The draft is consumed once. Record execution retains trusted original expected
versions, stable create idempotency keys, existing connector authentication and
permission checks, pacing/cancellation/retry rules and backend validation.
A 409 still requires a new review, never automatic rebase or forced overwrite.
No AI path calls a bulk endpoint or bypasses the normal connection.

## Provider adapter contract

The default registry is empty. Integration is a **trusted code extension**, not a
remote plugin URL, arbitrary endpoint textbox or sandbox for untrusted code:

```js
import { aiProviders } from './ai/providers.js';

const unregister = aiProviders.register({
  id: 'organization-ai',
  label: 'Organization-approved AI',
  async generate({ prompt, signal }) {
    // Implement a deliberately selected transport here. `prompt` is the exact
    // reviewed string. Return a string containing one contract-compliant JSON
    // object. Honor signal. Never log/persist prompts or credentials by default.
    // No transport, vendor, endpoint or provider key is supplied by this app.
    return organizationClient.generateJson({ prompt, signal });
  },
});
// unregister() removes this adapter from the registry.
```

`organizationClient` above is an integration placeholder, not a bundled service.
IDs/labels and functions are validated, registrations cannot silently replace
an existing provider, and only ID/label metadata appears in the selector.
Adapters must not capture the active connection or read unrelated application
state. Any future provider authentication must be intentionally configured,
in-memory and separate from backend credentials; browser CORS and the static
Pages CSP apply. A future security-specific proxy would need its own explicit
scope/review, not a replacement database or generic backend.

## Limits, architecture and verification

- 20 selected records / create documents; selected bodies at most 8 KiB each.
- Exact outgoing prompt and incoming response each at most 64 KiB UTF-8;
  instructions at most 4 KiB. Oversize input fails, not a silent selection cut.
- Existing 96 KiB document and 32-depth/10,000-node validation still applies;
  explanations are at most 12,000 characters. Context redaction is also bounded.
- `app/ai/tasks.js`: trusted prompt/contracts; `context.js`: allowlist/redaction;
  `providers.js`: registry; `proposals.js`: strict validation; `controller.js`:
  consent/lifecycle/binding; `handoff.js`: draft bridge; `view.js`: safe DOM.
- Small Data/API/Tools view hooks stage drafts only. No connector routes,
  production dependencies, database/backend, Pages Functions or persistence added.

Tests use synthetic credentials, fake provider adapters and mocked HTTP. They
cover context minimization/redaction, all eight contracts, prompt-injection text,
malicious/oversized proposals, immutable bindings, stale selections, cancellation,
timeout, safe DOM, protected draft handoffs and a real entry/connector flow that
requires explicit Tools confirmation and preserves authentication/version/409
behavior. No live model invocation or authenticated backend mutation is part of
this implementation's verification.
