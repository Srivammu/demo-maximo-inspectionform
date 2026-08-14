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
api/maximo.js      proxy → Maximo.     holds maxauth. POST creates, PATCH updates.
.env.example       optional host/credential overrides.
.gitignore         keeps .env.local out of git.
```

## Running it on Vercel

Both proxies are plain Vercel functions, so a normal deploy works — `index.html`
is served statically and `api/*.js` run as functions. No env vars are required;
the working hosts and credentials are in `api/`.

Two Vercel-specific constraints are already handled in the code:

**Vercel parses the request body before your function runs.** `bodyParser: false`
is only honoured as an ESM `export const config`, which these CommonJS files
cannot provide. That is why a browser-generated multipart body arrived empty and
`/api/upload` returned `400 — no file received`. The browser now sends the file as
**raw bytes** with its name in the query string, and `api/upload.js` builds the
multipart itself. `getBytes()` accepts the body as `req.rawBody`, a pre-parsed
`Buffer`, a string, or an intact stream, so it works on Vercel and locally
without branching.

**Vercel rejects request bodies over 4.5 MB** at the platform level, before the
function runs — you would get an opaque `413`. `validation.maxSizeMb` is therefore
`4`, so oversized files are refused in the browser with a clear message. Raise it
if you only ever run locally.

## The flow

```
                    browser                           proxy                    upstream
1  validate         local file checks                       —                      —
2  digitise         POST /api/upload      ──► api/upload.js  ──► POST {digitiser}/api/v1/form-digitisation
                    ?filename=…&type=…        builds the           /upload/mock?target_format=maximo
                    body = raw file bytes     multipart here        + X-API-Key
3  create           POST /api/maximo      ──► api/maximo.js  ──► POST {maximo}/api/os/mxapiinspform
                    body = step 2's response verbatim              ?ignorecollectionref=1&lean=1
                                                                    + maxauth + properties: *
4  remap cascades   PATCH /api/maximo     ──► api/maximo.js  ──► PATCH {maximo}/api/os/mxapiinspform/{id}
                    ?id=<inspectionformid>                         ?ignorecollectionref=1&lean=1
                    body = remapped inspcascadeoption[]             + maxauth + properties: *
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
- `PATCH` and the non-simple headers (`maxauth`, `properties`, `patchtype`) stop
  being a problem, because same-origin requests are never preflighted.
- Neither credential is in the browser. Verified: the page contains no key, no
  `maxauth`, and neither hostname.
- If Maximo turns out to need `JSESSIONIDUIMANAGE`, set `MAXIMO_COOKIE` — a
  server may send `Cookie`, a browser may not.
- No mixed-content issue: the page is `http`, the `https` calls are server-side.

## The two fields people keep breaking

`CONFIG.api1.path` and `CONFIG.api2.path` are routes on **this app** —
`/api/upload` and `/api/maximo`. They are not the upstream paths. Pasting an
upstream path there makes the browser request it from your own domain, which
returns **404** with no hint about why.

Upstream paths live in the proxy files:

| Where | Setting |
|---|---|
| `api/upload.js` | `DIGITISE_PATH` — `/api/v1/form-digitisation/upload/mock?target_format=maximo` |
| `api/maximo.js` | `MAXIMO_OS_PATH` — `/oslc/os/mxapiinspform` or `/api/os/mxapiinspform` |

Same for credentials: `maxauth`, `APIKEY` and `X-API-Key` must **not** appear in
`index.html`. The proxies attach them server-side. A credential in the page is
readable by every visitor and changes nothing about the request.

Both mistakes are now caught at page load. `index.html` runs a config check and,
if either rule is violated, shows a red banner naming the exact field and refuses
to send anything. Verified: with a bad path or a stray `maxauth`, zero requests
leave the page.

## Which Maximo OS path? It probes

Maximo exposes object structures under both `/oslc/os/...` and `/api/os/...`, and
which one answers varies by instance. `api/maximo.js` tries
`/oslc/os/mxapiinspform` first, falls back to `/api/os/mxapiinspform` on a `404`,
and reports the winner in the `X-Maximo-Path` response header — visible in
DevTools → Network → the `/api/maximo` request. Set `MAXIMO_OS_PATH` to pin it and
skip the probe.

## Bugs fixed along the way

1. **The PATCH was unauthenticated.** `api3.headers` sent `APIKEY: ""` and no
   `maxauth`, so step 4 would have returned 401 even with CORS solved. Both
   Maximo calls now use the same credential, applied by the proxy.
2. **`/api/upload` returned `400 — no file received` on Vercel.** Vercel consumed
   and parsed the multipart body before the function ran. Fixed by sending raw
   bytes and assembling the multipart server-side.
3. **Binary uploads were corrupted.** An earlier `dev-server.js` buffered request
   bodies as a string. It now uses a Buffer, verified with a 300 KB PDF whose
   SHA-256 matches byte for byte at the digitiser.

## Overriding hosts or credentials

Copy `.env.example` to `.env.local` and uncomment what you need:

```
MAXIMO_BASE_URL=https://main.manage.masdev.apps.dev.eam360.com/maximo
MAXIMO_APIKEY=<key>          # sent as APIKEY instead of maxauth
DIGITISE_BASE_URL=http://localhost:8009
DIGITISE_PATH=/api/v1/form-digitisation/upload
```

Env values win over the defaults in `api/`. `.env.local` is gitignored.

Note the current digitiser path ends in `/upload/mock` — that is the mock
endpoint. Drop `/mock` via `DIGITISE_PATH` when you want the real one.

## Security status

Neither credential reaches the browser. Both are hardcoded in `api/`, so anyone
with the repo has them — acceptable for a demo. To close that, delete the
`DEFAULT_KEY` / `DEFAULT_MAXAUTH` constants and require the env vars; the code
already prefers env values when present.

`Sk9ITjpTZWRpbkAxMjM=` is base64, not encryption. It decodes in one command to
`JOHN:Sedin@123`. Treat it as a plaintext password, and do not put it in a public
repo.

## Verified

Tested twice against mocked upstreams: once through `dev-server.js`, and once
through a **Vercel runtime simulation** that drains and pre-parses the body and
withholds `req.rawBody` — the exact condition that caused the `400` on the
deployed site. Both pass identically.

- All four steps green; `inspformnum` and the mapped-cascade count shown.
- Multipart assembled correctly by the proxy: `source_file` field, real filename,
  `?target_format=maximo` preserved, and SHA-256 of the bytes matching exactly at
  the digitiser — a 300 KB PDF locally and a 13 KB `.docx` through the Vercel
  simulation.
- An empty upload now returns a `400` that includes diagnostics (`hasRawBody`,
  `bodyType`, `contentLength`) so a body-handling problem is identifiable from the
  response instead of guesswork.
- Step 2's JSON reaching Maximo verbatim, with `maxauth` and `properties: *`.
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
