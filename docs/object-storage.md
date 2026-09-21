# Telegraph Files workspace

## Scope and API

The **Files** tab adds Buckets, Objects and Object details to the existing static application. The Data workspace is unchanged. All browser operations use the existing Connection's `storage` methods and controlled request client; views never construct API fetch URLs.

| Workflow | Documented operation |
| --- | --- |
| List objects, prefix search, pagination | `GET /api/storage/{bucket}` |
| Upload raw bytes | `PUT /api/storage/{bucket}/{key}` |
| Download bytes / ranges | `GET /api/storage/{bucket}/{key}` |
| Read metadata | `HEAD /api/storage/{bucket}/{key}` |
| Delete current object | `DELETE /api/storage/{bucket}/{key}` |

Requests use the runtime Bearer credential and its `storage:read`/`storage:write` scopes. No S3 access/secret keys are requested, read from the environment, displayed or persisted. S3 remains an advanced external compatibility/tooling capability; there is no browser SigV4 client, multipart uploader or presigned-URL implementation.

Before implementation, the current object API portions of [OpenAPI](https://telestorage.pages.dev/openapi.json), [llms.txt](https://telestorage.pages.dev/llms.txt) and [full AI documentation](https://telestorage.pages.dev/llms-full.txt) were read. No Telegraph endpoint/backend changes or live data writes were performed.

## Buckets and prefixes

There is **no documented bucket-enumeration endpoint**. `storage.listBuckets()` returns only explicit configured names, with `{source:'configured', complete:false}`. The connector accepts an optional `buckets` array, empty by default:

```js
const connection = createTelegraphConnection(runtimeConfiguration, {
  buckets: operatorProvidedBucketNames,
});
```

The UI links to the supported Telegraph console and accepts exact operator-entered bucket names. Opening a bucket issues a list request; a successful read adds it to the in-memory sidebar. Failed names are not registered. It never calls an invented `/api/storage` root-list endpoint or assumes bucket names.

- Listing uses `prefix`, optional `delimiter`, `limit` and opaque `cursor` values.
- **Group by /** exposes returned `common_prefixes` as navigable virtual folders. It does not create directories or a local object manifest.
- **Key starts with** is a server-side prefix filter, not substring, content or metadata search.
- Root/up navigation and prefix changes reset cursor history. Previous/next retain opaque cursors. No total count or unsupported sort is invented.
- The default page size is 50, with a conservative maximum of 100: prose documents 100 while the OpenAPI parameter says 1000.
- Loading, empty, error and success states are distinct. Bucket discovery incompleteness is displayed explicitly.

## Upload

The upload form accepts one browser file, an exact destination bucket/key, an editable content type and optional string-valued custom metadata.

- Maximum: **20 MiB / 20,971,520 bytes**, checked before sending. Zero-byte objects are supported.
- Raw Blob/ArrayBuffer/typed-array bytes are sent, not JSON or multipart form data. The file's MIME type is used when available, otherwise `application/octet-stream`.
- At most 20 custom metadata entries are sent as the documented `x-amz-meta-*` headers. These header names are part of the Bearer object API and do not imply S3 authentication.
- Keys are encoded segment-by-segment, preserving nested paths, repeated separators and trailing-slash marker objects. Dot traversal/control characters are rejected and the 1024-byte key limit is enforced.
- PUT may overwrite an existing key and may implicitly create a bucket. The user must acknowledge this before submission.
- **Conditional PUT is not documented.** The client does not fabricate `If-Match`/expected-version guarantees for writes.
- No multipart upload, resumable upload or fabricated progress percentages. An in-flight status and file size are displayed.
- Writes are never retried automatically. After an uncertain network/timeout outcome, refresh before explicitly retrying.
- Successful upload is reported separately from a subsequent failed list refresh, including the write-only-credential case.

## Object details, ETags and versions

List entries normalize size, content type, ETag, version and timestamps. Selecting an object performs HEAD and displays:

- exact bucket/key;
- size in bytes and human-readable units;
- content type;
- opaque ETag (including its header quoting);
- `X-Telegraph-Cloud-Object-Version`;
- last-modified and accept-ranges headers;
- custom metadata.

ETags and numeric object versions are separate values. A numeric version is **not** substituted for an ETag. Missing/malformed numeric headers are represented as unknown, not zero/NaN. Missing metadata may mean the backend has not exposed those headers through CORS; the UI says so rather than filling values from assumptions.

## Downloads and ranges

Downloads use authenticated fetch and a temporary Blob URL, never a credential-bearing URL or a navigation that expects browser cookies.

- With an exposed HEAD ETag, the UI supplies that exact value as `If-Match`. A changed object yields a visible 412 and requires metadata refresh; it does not silently retry without the condition.
- Without an exposed ETag, the UI explains that the download reads the current object unconditionally.
- Optional single byte ranges support `bytes=start-end`, `bytes=start-`, and `bytes=-suffix`. Invalid ranges fail before a request; 416 is displayed explicitly.
- A requested range that receives a full 200 response is not silently saved as a fragment.
- 206 responses are labeled partial and saved with a `.part` suffix. Content-Range, response size, ETag, version and content type are shown in transfer details when exposed.
- The connector also supports `ifNoneMatch`; a documented 304 returns `{data:null,status:304,...}` without trying to parse a body. No file is saved for 304.
- Files are forced to download as attachments using a Blob with `application/octet-stream`. HTML/SVG and other arbitrary content is never injected into an image/iframe/document preview.
- Temporary URLs are revoked after the download starts, and outstanding URLs are cleared on disconnect/connection replacement/pagehide. Received bytes are not retained in controller snapshots or browser storage.

## Delete and concurrency

Delete first shows the exact bucket/key and observed metadata in a confirmation dialog. It requires a separate acknowledgement and submit, prevents duplicate submits while in flight, and retains errors for explicit retry/cancel.

**Unlike document PATCH/DELETE, storage DELETE has no documented expected-version or ETag write precondition.** The confirmation warns that it deletes the current object and the displayed version may change before deletion. The client sends only the documented DELETE and does not pretend a HEAD-before-delete sequence is atomic.

## Copy object URL

`storage.getObjectUrl(bucket,key)` creates the encoded resource address through the connector and the request client's URL safety checks. It returns `{url, requiresAuthentication:true}` without making a network request.

The button is deliberately called **Copy API address**, not “public share link”:

- No Bearer token, API key, S3 credential, signature or presigned query string is included.
- The recipient still needs an independently authorized Bearer credential.
- Clipboard failures offer a selectable readonly address for manual copying.
- No public-access capability is assumed, and object addresses are not auto-opened.

## State, errors and deployment

Files state is session-only. Selection generations, request cancellation and transfer locking prevent late responses from replacing another bucket/object/connection. On disconnect, visible listings/details, upload form inputs, copied address fields and pending download URLs are cleared.

The client handles auth/scope failures, missing resources, 412, 413, 416, 429, malformed responses, timeouts and network/CORS errors. HEAD errors may contain no JSON body, so their HTTP status is sufficient for a meaningful message. Request diagnostics continue to exclude URLs, headers, payloads, raw exceptions and credentials.

Deployment remains static: run `npm run build` and publish `dist/` on Cloudflare Pages; see [production deployment](deployment.md). No new runtime dependencies, persistent services, proxy endpoints, or backend changes were introduced. Real project access and live cross-origin integration have **not** been verified. Direct browser operation needs CORS permission for Authorization, PUT/DELETE/HEAD, Range, conditional headers, Content-Type and metadata headers, plus exposure of ETag, Content-Range, Last-Modified, Accept-Ranges, object version and custom metadata. The UI does not work around missing CORS by putting secrets into URLs.

## Tests

Run `npm test`. New tests cover configured buckets, listings, prefix/delimiter/cursor construction, HEAD metadata, raw upload and size boundaries, ranges/304/412/416, DELETE semantics, request errors, credential-free URL copying, state isolation, confirmation dialogs, safe DOM rendering, Blob-URL cleanup and the full static entry → real connector → mocked HTTP workflow.

Fixtures and request implementations are test-only and contain no real credentials or live object data. Data/connection tests continue to run as regressions.
