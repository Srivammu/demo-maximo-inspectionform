/**
 * Proxy → digitisation service.
 *
 * The browser POSTs the file as a RAW BODY to /api/upload?filename=<name>.
 * This function builds the multipart/form-data itself (field `source_file`) and
 * forwards it to the digitiser with the X-API-Key attached.
 *
 * Why raw bytes instead of the browser sending multipart directly:
 * Vercel's Node runtime consumes and parses the request body before a function
 * runs, and `bodyParser: false` is only honoured as an ESM `export const config`.
 * With a raw body we do not care whether the runtime handed us a Buffer or left
 * the stream intact — both are handled below — and there is no boundary to
 * preserve, so nothing can corrupt the upload.
 *
 * Env overrides (optional — the defaults are the working values):
 *   DIGITISE_BASE_URL   default https://dev-mms.eam360.com/digitiser
 *   DIGITISE_PATH       default /api/v1/form-digitisation/upload/mock?target_format=maximo
 *   DIGITISE_FIELD      default source_file
 *   DIGITISE_API_KEY    default the key below
 *   UPSTREAM_TIMEOUT_MS default 120000
 */

const DEFAULT_BASE = "https://dev-mms.eam360.com/digitiser";
const DEFAULT_PATH = "/api/v1/form-digitisation/upload/mock?target_format=maximo";
const DEFAULT_FIELD = "source_file";
const DEFAULT_KEY = "jT1pyUNC,ja==+gPk@KCh{qyEtAu3s.e";

/* Kept for runtimes that do read it. Harmless where it is ignored. */
module.exports.config = { api: { bodyParser: false } };

/* Get the request bytes whatever the runtime did with them. */
function getBytes(req) {
  /* 1. dev-server.js sets this. */
  if (req.rawBody) {
    return Promise.resolve(Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(req.rawBody));
  }
  /* 2. Vercel parses the body first. For a binary content type it hands back a
        Buffer; for text types, a string. latin1 is byte-preserving. */
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
    if (typeof req.body === "string") return Promise.resolve(Buffer.from(req.body, "latin1"));
  }
  /* 3. Stream is still intact — read it. */
  if (req.readableEnded || req.complete || req.readable === false) {
    return Promise.resolve(Buffer.alloc(0));
  }
  return new Promise((resolve) => {
    const chunks = [];
    const finish = () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); };
    const timer = setTimeout(finish, 20000);
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", finish);
    req.on("error", finish);
  });
}

const safeName = (n) =>
  (String(n || "upload.bin").split(/[\\/]/).pop() || "upload.bin").slice(0, 200);

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ message: `${req.method} is not allowed here. Use POST.` });
  }

  const query = new URL(req.url, "http://localhost").searchParams;
  const filename = safeName(query.get("filename"));
  const fileType = query.get("type") || req.headers["content-type"] || "application/octet-stream";

  const bytes = await getBytes(req);
  if (!bytes || bytes.length === 0) {
    return res.status(400).json({
      message: "Empty request body — no file bytes reached the server.",
      diagnostics: {
        hasRawBody: !!req.rawBody,
        bodyType: req.body === undefined ? "undefined" : (Buffer.isBuffer(req.body) ? "Buffer" : typeof req.body),
        contentLength: req.headers["content-length"] || null,
        contentType: req.headers["content-type"] || null
      }
    });
  }

  const base = (process.env.DIGITISE_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
  const path = process.env.DIGITISE_PATH || DEFAULT_PATH;
  const field = process.env.DIGITISE_FIELD || DEFAULT_FIELD;
  const apiKey = process.env.DIGITISE_API_KEY || DEFAULT_KEY;
  const timeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS || 120000);
  const target = base + path;

  /* Build the multipart body here. fetch generates the boundary and the
     matching Content-Type, so no header is set manually. */
  const form = new FormData();
  form.append(field, new Blob([bytes], { type: fileType }), filename);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let upstream;
  try {
    upstream = await fetch(target, {
      method: "POST",
      headers: { "X-API-Key": apiKey },
      body: form,
      signal: ctrl.signal
    });
  } catch (err) {
    clearTimeout(timer);
    const timedOut = ctrl.signal.aborted;
    return res.status(504).json({
      message: timedOut
        ? `The digitisation service did not respond within ${Math.round(timeoutMs / 1000)}s.`
        : `Could not reach the digitisation service at ${base}: ${err.message}`
    });
  }
  clearTimeout(timer);

  const text = await upstream.text();
  console.log(`  ↳ POST ${target} → ${upstream.status} | sent ${field}="${filename}" (${bytes.length} bytes)`);
  res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
  return res.status(upstream.status).send(text);
};
