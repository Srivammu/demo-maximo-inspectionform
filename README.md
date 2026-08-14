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

## The flow

```
                    browser (localhost:3000)          dev-server.js            upstream
1  validate         local file checks                       —                      —
2  digitise         POST /api/upload      ──► api/upload.js  ──► POST {digitiser}/api/v1/form-digitisation
                                                                    /upload/mock?target_format=maximo
                                                                    + X-API-Key
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

## Two bugs fixed from the previous version

1. **The PATCH was unauthenticated.** `api3.headers` sent `APIKEY: ""` and no
   `maxauth`, so step 4 would have returned 401 even with CORS solved. Both
   Maximo calls now use the same credential, applied by the proxy.
2. **Binary uploads were corrupted.** An earlier `dev-server.js` buffered request
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

Full run against mocked upstreams, with both proxies live:

- All four steps green; `inspformnum` and the mapped-cascade count shown.
- Multipart intact through the proxy: `source_file` field, real filename,
  boundary preserved, `?target_format=maximo` preserved, and SHA-256 of a 300 KB
  PDF matching exactly at the digitiser.
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
