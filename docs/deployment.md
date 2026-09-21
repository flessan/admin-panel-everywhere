# Production deployment: Cloudflare Pages

## Architecture and startup

```text
Browser → Cloudflare Pages (static HTML / CSS / browser ES modules)
        → Admin Panel frontend → Telegraph Cloud API over HTTPS
```

Cloudflare Pages serves the generated **`dist/`** directory. There is **no
production start command or long-running application server**: loading the page
starts the browser entry module, initializes the three workspaces and displays
the disconnected runtime connection form. There is no startup database access,
local API request, automatic login, or environment-file fetch.

- Express and lowdb were removed, not wrapped or reproduced as Pages Functions.
- No application filesystem writes, database files, SQLite/D1, KV, Durable
  Objects, Node compatibility flag, or local backend service is required.
- `DB_FILE_ABS_PATH` is unused. An old local `.env` can remain on a developer's
  machine, but it is ignored, no longer tracked, and is not loaded by the build
  or frontend. External legacy JSON data is not migrated or modified.
- There is no `functions/` or `_worker.js`. No Function is necessary for static
  hosting or direct, operator-supplied Bearer authentication. An unauthenticated
  proxy holding a deployment key would expose its authority even if it hid the
  key's bytes, so it is deliberately **not** implemented.

Node is used **only for installation, build, tests and local tooling**. Its
filesystem reads/writes create reproducible build assets and temporary test
fixtures; they are not an application data/persistence layer. Wrangler's local
emulator may create `.wrangler/` caches; these are disposable development-tool
state, not data required by the deployed application.

## Build contract

```sh
npm install              # npm ci is preferred for repeatable CI installs
npm test
npm run build
```

Node **22.22.3** is pinned in `.node-version`; package engines require Node 22+.
The build itself uses only Node built-ins; there are **no production npm
runtime dependencies**. jsdom and the pinned Wrangler CLI are development-only.

`scripts/build.mjs` creates a clean, deterministic `dist/` from:

- The browser module graph reachable from `dashboard-ui/app/index.js`.
- `index.html` and the stylesheet.
- A generated, strictly allowlisted public configuration module.
- `deployment/_headers` and `deployment/404.html`.

Unused modules, server/scripts/tests/docs, Node packages, environment files,
source maps, declaration files and repository metadata are not copied. Bare
package/Node imports, dynamic module imports, persistence/environment APIs and
escaped source paths fail the build. Build products are ignored by Git.
Validation precedes output replacement; a failed build must not be deployed.

There is no bundler-wide `process.env` substitution and no endpoint that exports
all deployment environment variables. The build will also fail if its private
`TELEGRAPH_API_KEY` value is detected in a public asset/default; diagnostics do
not echo that value. This guard is not a substitute for secret scanning and
code review of arbitrary hard-coded credentials.

## Environment configuration and secret boundary

| Name | Supported input | Visibility / semantics |
| --- | --- | --- |
| `TELEGRAPH_URL` | Pages **build** environment or local shell; editable runtime connection form | Public HTTPS origin; defaults to `https://telestorage.pages.dev`. Credentials, path, query and fragment are rejected. |
| `TELEGRAPH_PROJECT` | Pages **build** environment or local shell; editable runtime connection form | Public `prj_...` context, never an authorization boundary. Defaults to the existing example project context. |
| `TELEGRAPH_API_KEY` | **Browser runtime connection form** (or explicit programmatic connector configuration) | Private in-memory session credential. Never exported by the build, read from browser-accessible config, or stored in browser storage. The form clears after submission; disconnect/pagehide clears the connection. |

URL/project overrides become public bytes in `dist/app/public-config.js`.
Set them separately for production and preview builds if desired. Updating a
Pages **runtime binding** does not update static bytes: change the build
variables and rebuild/redeploy. Operators can also edit these public defaults
in the connection form for the current session.

**A private Pages environment secret named `TELEGRAPH_API_KEY` does not log a
browser into this static app.** If supplied during the build, it is deliberately
not exported and the CLI prints only a fixed warning. A runtime Pages secret is
unavailable to static browser JavaScript. Do not solve that by committing it,
putting it in `wrangler.jsonc` `vars`, injecting it into HTML/JavaScript, exposing
a config endpoint, or adding it to a URL.

This deployment uses a **bring-your-own-runtime-key** model: the operator already
knows the key they enter. If a future deployment must conceal its service key
from operators, it needs an authenticated, authorization-enforcing gateway
with a concrete security design (operator identity, limited operations/scopes,
request validation, CSRF/session policy, abuse controls and redacted logging).
That would be a different flow with a justified Pages Function, not a public
proxy or a reimplementation of Express routes. It is outside this change.

`.env.example` documents the variable names without a credential. `.env`,
`.env.*`, `.dev.vars*`, `.wrangler/`, `node_modules/` and `dist/` are excluded from
Git. The build never auto-loads `.env`. For example:

```sh
TELEGRAPH_URL=https://telestorage.pages.dev \
TELEGRAPH_PROJECT=prj_your_context \
npm run build
```

Never put a private key in that command or shell history. Enter it only in the
runtime form. Use scoped, revocable operator keys and a trusted HTTPS origin.

## Cloudflare Pages setup

Use a **Pages** project, not a Workers application deployment:

| Setting | Value |
| --- | --- |
| Framework preset | None |
| Repository root directory | Repository root |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Node version | `.node-version` (or `NODE_VERSION=22.22.3` in build settings) |
| Public build variables | `TELEGRAPH_URL`, `TELEGRAPH_PROJECT` as needed |
| Runtime bindings / databases | None |
| Production start command | None |

`wrangler.jsonc` declares `pages_build_output_dir: "./dist"`, a project name and
an explicit compatibility date matching the pinned local workerd release. It
contains no credentials, server entry point or resource bindings. Adjust its
non-secret project name to match your Pages project, or pass `--project-name`.

For Git-integrated Pages, connect the repository, configure the table above and
let Pages install/build/publish. **Do not deploy the repository root** or
`dashboard-ui/` directly: use the generated artifact so configuration and
security metadata are included.

For an authorized local direct upload after creating/selecting a Pages project:

```sh
# Authenticate with Cloudflare using its normal local OAuth flow, outside chat.
npx wrangler login
npm run pages:deploy -- --project-name your-pages-project
```

This command builds first and only then invokes `wrangler pages deploy dist`.
Cloudflare credentials are CLI credentials, not Telegraph credentials and not
frontend assets. The branch determines preview/production targeting according
to your Pages project settings; verify the target before deploying. No remote
project creation or deployment was performed as part of this implementation.

## Local development and previews (no lowdb)

```sh
npm ci
npm run dev              # build once, then read-only preview on 0.0.0.0:3214
# Rebuild after source or public-environment changes; then reload the browser.

npm run build
npm run preview          # serve existing dist/ only
npm start                # alias for local preview, NOT a production server

npm run pages:preview    # actual Wrangler Pages emulator on 0.0.0.0:8788
npm run verify:pages     # build + bounded emulator smoke check, then stop/clean up
```

The lightweight preview accepts proxy hosts, serves only static assets and
rejects all non-GET/HEAD requests. It implements no `/api/*`, write/upload,
configuration, environment or database routes. `PORT` changes its listen port.
The frontend always calls the configured HTTPS Telegraph origin directly, never
browser `localhost` endpoints. Localhost appears only in test clients/tooling.

Production CSP denies framing. For an explicitly trusted iframe-based local
preview, run:

```sh
PREVIEW_ALLOW_EMBEDDING=1 npm run dev
```

This relaxes **only the local Node preview's frame restriction**. It does not
change the artifact's CSP or the Wrangler/production response policy. Use the
Wrangler preview in a top-level browser tab to test production framing rules.

The Wrangler launcher disables implicit `.env`/process-environment binding
imports and passes an intentionally empty `deployment/preview.env` so legacy
`.env`/`.dev.vars` cannot become local Worker-shim bindings. This file contains
no values and is not a frontend asset. Wrangler's internal static-serving shim
is an emulator implementation detail, not a checked-in application Function.

## Headers, routes and browser compatibility

`_headers` sets CSP, `nosniff`, `no-referrer`, restricted device permissions,
`noindex`, and browser revalidation for the unfingerprinted static modules.
There is no inline/eval script allowance. The app renders untrusted API content
as text; no service worker/offline response cache is installed.

CSP intentionally permits **HTTPS** network destinations because the existing
connection form can select another authorized HTTPS backend. Connector policy
still pins every request to the operator-configured origin. A deployment that
wants a single-origin CSP can replace `connect-src https:` in
`deployment/_headers` with its exact backend origin, rebuild, and treat changing
backends as a deployment operation. CSP is not a replacement for connector
policy or backend authorization.

A root `404.html` disables Pages' automatic catch-all SPA fallback. Missing
assets and old local backend URLs therefore return real 404s rather than a
misleading 200 admin page. No `/api` rewrites or fake backend endpoints exist.
`_headers` is Pages metadata, not a production asset. The pinned Wrangler
4.135.0 emulator has a specific reserved-file quirk: a direct `GET /_headers`
tries `_headers/index.html` and reports `ENOTDIR`/502 instead of 404. The smoke
check recognizes only that specific failure (or a proper 404), verifies the
metadata is not served, and still requires real 404s for missing/API paths.

### CORS remains an upstream requirement

The Telegraph service must allow the actual Pages/custom-domain origin and its
required methods/headers, including Authorization, Content-Type, conditional
headers, Range and applicable metadata/idempotency headers. Expose needed
response headers (ETag, content range, object version, etc.). Production and
preview deployments may have different origins. Headers on the **frontend**
Pages deployment cannot grant CORS access to the **Telegraph** response.

A CORS denial must be fixed through the service's supported configuration, not
by inventing local proxy routes. No live authenticated Telegraph calls, upstream
CORS verification or production DNS/TLS deployment was performed here.

## Verification and CI

- `npm install`, `npm run build`: clean static artifact; no runtime dependencies.
- `npm test`: existing workspaces plus deployment defaults, secret exclusion,
  deterministic/clean output, built-entry startup and read-only preview tests.
- `npm run verify:pages`: actual pinned Wrangler/workerd emulator, static assets
  and MIME types, security headers, private-file exclusion, missing routes and
  refusal of local API mutations. It isolates environment bindings, uses a
  temporary copied artifact, stops its process group, and deletes emulator state.
  It does not contact Telegraph or deploy. Wrangler may attempt Cloudflare
  platform metadata lookup; an offline `Request.cf` placeholder does not affect
  this static application.
- `npm ls --omit=dev --depth=0 --package-lock-only`: no declared production packages.
  A production-only `npm ci --omit=dev --ignore-scripts` followed by the build
  also succeeds without development dependencies.
- Optional CI can run `npm ci`, `npm test`, `npm run build`, and
  `npm run verify:pages` using the pinned Node version. No workflow YAML is
  committed. These checks need no deployment secrets or remote data access
  and do not deploy to production.

Production acceptance still requires deploying to an authorized Pages project
and checking real browser CORS against the intended Telegraph account. Local
emulation validates compatibility, not ownership, access scopes or live data.

References reviewed:
- https://developers.cloudflare.com/pages/configuration/build-configuration/
- https://developers.cloudflare.com/pages/configuration/headers/
- https://developers.cloudflare.com/pages/configuration/serving-pages/
- https://developers.cloudflare.com/pages/functions/local-development/
- https://developers.cloudflare.com/pages/functions/wrangler-configuration/
