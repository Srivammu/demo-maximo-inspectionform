# Inspection Form → Maximo

Upload a source form document; it is digitised, turned into an inspection form in
Maximo, and its cascade options are remapped to the real Maximo numbers.

**No CORS configuration is needed anywhere.** The browser only ever talks to the
local server; all three upstream calls happen server-side.

## Run it

```
cd /d D:\2026\inspectionform
node dev-server.js
```

Open **http://localhost:3000**.

No npm install, no Vercel, no `.env` file — plain Node, built-in modules only,
and the working hosts and credentials are already in `api/`. The startup banner
prints which upstreams it will call.

Do **not** double-click `index.html`. `file://` cannot reach `/api/upload`, and
`python -m http.server` cannot run the proxies. Both will fail immediately.

## Files

```
dev-server.js      run this. serves the page and both proxies on :3000.
index.html         the UI. same-origin requests only, no credentials in it.
api/upload.js      proxy → digitiser.  holds X-API-Key.
api/maximo.js      proxy → Maximo.     holds APIKEY. POST creates, PATCH updates.
```

## Running it on Vercel

Both proxies are plain Vercel functions, so a normal deploy works — `index.html`
is served statically and `api/*.js` run as functions. There are no env vars at
all; the hosts and credentials are hardcoded constants in `api/`.

Two Vercel-specific constraints are already handled in the code:

**Vercel reads the request body before your function runs, and for binary content
types it consumes the stream without populating `req.body`.** `bodyParser: false`
is only honoured as an ESM `export const config`, which these CommonJS files
cannot provide. So a browser-built multipart body arrives empty — and so does a
raw binary body. Both produced `400 — no file bytes reached the server`.

`application/json` is the one content type the runtime reliably parses into
`req.body`, so that is the transport: the browser base64-encodes the file into a
JSON envelope and `api/upload.js` decodes it and builds the multipart. Ugly, but
it is the shape that actually survives.

```js
POST /api/upload
{ "filename": "test.docx", "type": "application/…", "size": 13004,
  "dataBase64": "UEsDBB…" }
```

`resolveUpload()` still accepts a raw `Buffer`, a JSON string, an unparsed raw
JSON body, or an intact stream, and reports which route it used in the
`X-Upload-Via` response header — so this works unchanged locally, and a future
body-handling surprise is diagnosable from the response instead of guesswork.
Switch `CONFIG.api1.transport` to `"raw"` or `"multipart"` if you ever want the
older shapes; both work locally and both fail on Vercel.

**Vercel rejects request bodies over 4.5 MB** at the platform level, before the
function runs — an opaque `413`. Base64 inflates a file by about a third, so
`validation.maxSizeMb` is `3`: roughly 4 MB on the wire. Oversized files are
refused in the browser with a clear message. Raise it if you only ever run
locally.

### Reproducing deployed behaviour locally

```
SIMULATE_VERCEL=1 node dev-server.js
```

This makes `dev-server.js` behave like the deployed runtime — body already
consumed, no `req.rawBody`, `req.body` only for JSON. If an upload works under
this flag it will work deployed. Every test below was run both ways.

## The flow

```
                    browser                           proxy                    upstream
1  validate         local file checks                       —                      —
2  digitise         POST /api/upload      ──► api/upload.js  ──► POST {digitiser}/api/v1/form-digitisation
                    body = JSON with the      decodes base64,      /upload/mock?target_format=maximo
                    file as dataBase64        builds multipart      + X-API-Key
3  create           POST /api/maximo      ──► api/maximo.js  ──► POST {maximo}/api/os/mxapiinspform
                    body = step 2's response verbatim              ?ignorecollectionref=1&lean=1
                                                                    + APIKEY + properties: *
4  remap cascades   PATCH /api/maximo     ──► api/maximo.js  ──► PATCH {maximo}/api/os/mxapiinspform/{id}
                    ?id=<inspectionformid>                         ?ignorecollectionref=1&lean=1
                    body = remapped inspcascadeoption[]             + APIKEY + properties: *
                                                                    + patchtype: MERGE
```

Step 4 exists because step 2's cascade rows identify fields and questions by
`CRC32(description)` — real Maximo numbers don't exist until step 3 creates the
record. Step 4 recomputes the same CRC32 over the descriptions in step 3's
response, translates each `srcquestion`/`tgtquestion`/`srcfield`/`tgtfield` to the
real number, and merge-PATCHes the corrected array onto the new record.

If any hash cannot be matched, step 4 **fails without sending the PATCH** rather
than writing half-mapped rows. If there are no cascade options at all, step 4 is
skipped and the run still succeeds.

## Why everything is proxied

Maximo's CORS allowlist only admits the IBM Maximo Mobile app's own origin. It
cannot be made to accept a page you host — not localhost, not a domain. So the
browser can never call `mxapiinspform` directly, and no front-end change fixes
that. Proxying removes the problem instead of fighting it:

- No CORS or preflight anywhere. Nothing to ask an administrator for.
- `PATCH` and the non-simple headers (`APIKEY`, `properties`, `patchtype`) stop
  being a problem, because same-origin requests are never preflighted.
- Neither credential is in the browser. Verified: the page contains no key, no
  `APIKEY`, and neither hostname.
- No mixed-content issue: the page is `http`, the `https` calls are server-side.

## The two fields people keep breaking

`CONFIG.api1.path` and `CONFIG.api2.path` are routes on **this app** —
`/api/upload` and `/api/maximo`. They are not the upstream paths. Pasting an
upstream path there makes the browser request it from your own domain, which
returns **404** with no hint about why.

Upstream paths live in the proxy files:

| Where | Setting |
|---|---|
| `api/upload.js` | `PATH` — `/api/v1/form-digitisation/upload/mock?target_format=maximo` |
| `api/maximo.js` | `OS_PATH` — `/api/os/mxapiinspform` |

Same for credentials: `APIKEY` and `X-API-Key` must **not** appear in
`index.html`. The proxies attach them server-side. A credential in the page is
readable by every visitor and changes nothing about the request.

Both mistakes are now caught at page load. `index.html` runs a config check and,
if either rule is violated, shows a red banner naming the exact field and refuses
to send anything. Verified: with a bad path or a stray `APIKEY`, zero requests
leave the page.

## Which Maximo OS path?

Maximo exposes object structures under both `/oslc/os/...` and `/api/os/...`, and
which one answers varies by instance. `api/maximo.js` is pinned to
`/api/os/mxapiinspform` — the `OS_PATH` constant — and reports it in the
`X-Maximo-Path` response header. Edit the constant if a given instance needs
`/oslc/os/mxapiinspform` instead.

## Bugs fixed along the way

1. **The PATCH was unauthenticated.** `api3.headers` sent `APIKEY: ""` and no
   `maxauth`, so step 4 would have returned 401 even with CORS solved. Both
   Maximo calls now use the same credential, applied by the proxy.
2. **`/api/upload` returned `400 — no file received` on Vercel.** Vercel consumed
   the request body before the function ran. First attempt (raw bytes) failed the
   same way, because the runtime does not populate `req.body` for binary content
   types either. Fixed by moving the file into a JSON envelope as base64.
3. **The paths were edited to upstream values**, making the browser request
   `/api/v1/form-digitisation/...` from its own domain — a bare `404`. Fixed, and
   a load-time config check now catches it explicitly.
4. **Binary uploads were corrupted.** An earlier `dev-server.js` buffered request
   bodies as a string. It now uses a Buffer, verified with a 300 KB PDF whose
   SHA-256 matches byte for byte at the digitiser.
5. **The config check had a hole.** It tested that `api*.path` starts with
   `/api/`, which `/api/v1/form-digitisation/...` does. Now an exact route match.

## Overriding hosts or credentials

There are no env vars — edit the constants directly:

| Where | Constants |
|---|---|
| `api/upload.js` | `BASE_URL`, `PATH`, `FIELD`, `API_KEY` |
| `api/maximo.js` | `BASE_URL`, `OS_PATH`, `APIKEY` |

Note the current digitiser path ends in `/upload/mock` — that is the mock
endpoint. Drop `/mock` via `PATH` in `api/upload.js` when you want the real one.

## Security status

Neither credential reaches the browser. Both are hardcoded in `api/`, so anyone
with the repo has them — acceptable for a demo, not for a public repo.

`APIKEY` is a plaintext Maximo API key, not encrypted. Treat it like a password.

## Verified

Every case below was run twice against mocked upstreams — once normally, and once
with `SIMULATE_VERCEL=1`, which reproduces the deployed runtime that caused the
`400`. Identical results both ways.

- All four steps green; `inspformnum` and the mapped-cascade count shown.
- Multipart assembled correctly by the proxy: `source_file` field, real filename,
  `?target_format=maximo` preserved, and SHA-256 of the bytes matching exactly at
  the digitiser — a 300 KB PDF locally and a 13 KB `.docx` through the Vercel
  simulation.
- An empty upload now returns a `400` that includes diagnostics (`hasRawBody`,
  `bodyType`, `contentLength`) so a body-handling problem is identifiable from the
  response instead of guesswork.
- Step 2's JSON reaching Maximo verbatim, with `APIKEY` and `properties: *`.
- PATCH hitting `/mxapiinspform/3345` with `patchtype: MERGE`, and the body
  containing real numbers (`1001`/`2001`/`2002`) rather than CRC32 hashes.
- Zero cross-origin requests: every request the page made was recorded, none left
  `localhost:3000`.
- Page source free of both credentials and both hostnames.
- No cascade options → step 4 skipped, run still succeeds.
- Unresolvable hash → step 4 fails and **no PATCH is sent**.
- Digitiser `422`, Maximo create `400` (`BMXAA9549E`), Maximo PATCH `400`
  (`BMXAA0129E`), digitiser `204` — each fails at the right step with the real
  upstream message, and later steps marked "Not run".
- Proxy probes: `GET` → `405`, missing `?id` → `400`, path-traversal id
  (`../../etc`) → `400`, empty body → `400`, non-multipart upload → `400`.
- No page errors, no failed requests.
