/**
 * Proxy → digitisation service.
 *
 * The browser POSTs JSON to /api/upload:
 *     { "filename": "test.docx", "type": "application/...", "dataBase64": "..." }
 * This decodes the base64, builds the multipart/form-data itself (field
 * `source_file`), and forwards it to the digitiser with the X-API-Key attached.
 *
 * Why base64-in-JSON rather than a raw or multipart body:
 * Vercel's Node runtime reads the request body before a function runs.
 * `bodyParser: false` is only honoured as an ESM `export const config`, which a
 * CommonJS file cannot provide. For binary content types the runtime consumes the
 * stream WITHOUT populating req.body, so both a browser-built multipart body and
 * a raw binary body arrive empty. `application/json` is the one content type it
 * reliably parses into req.body, so that is what we use. Every other shape is
 * still accepted below, so this also works unchanged under `node dev-server.js`.
 *
 * Cost: base64 is ~33% larger than the file. Vercel rejects request bodies over
 * 4.5 MB, so the practical file ceiling is ~3.3 MB. index.html caps at 3 MB.
 *
 * No env vars — host, path, field name and key are hardcoded below.
 */

const BASE_URL = "https://test-mms.eam360.com/digitiser";
const PATH = "/api/v1/form-digitisation/upload?target_format=maximo";
const FIELD = "source_file";
const API_KEY = "jT1pyUNC,ja==+gPk@KCh{qyEtAu3s.e";
const TIMEOUT_MS = 270000;

module.exports.config = { api: { bodyParser: true } };

const safeName = (n) =>
  (String(n || "upload.bin").split(/[\\/]/).pop() || "upload.bin").slice(0, 200);

function readStream(req) {
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

/**
 * Resolve the upload from whatever the runtime gave us.
 * Returns { bytes, filename, type, via } — `via` is reported on failure so a
 * body-handling problem is diagnosable from the response.
 */
async function resolveUpload(req, query) {
  const qName = query.get("filename");
  const qType = query.get("type");

  /* 1. JSON envelope — the path the browser uses. */
  const asEnvelope = (obj) => {
    if (!obj || typeof obj !== "object" || typeof obj.dataBase64 !== "string") return null;
    return {
      bytes: Buffer.from(obj.dataBase64, "base64"),
      filename: safeName(obj.filename || qName),
      type: obj.type || qType || "application/octet-stream",
      via: "json.dataBase64"
    };
  };

  let hit = asEnvelope(req.body);
  if (hit) return hit;

  /* 2. JSON that arrived as a string. */
  if (typeof req.body === "string" && req.body.trim().startsWith("{")) {
    try {
      hit = asEnvelope(JSON.parse(req.body));
      if (hit) return { ...hit, via: "json-string.dataBase64" };
    } catch (_) { /* fall through */ }
  }

  /* 3. Raw bytes, however they reached us. */
  const raw =
    (req.rawBody && (Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(req.rawBody))) ||
    (Buffer.isBuffer(req.body) ? req.body : null) ||
    (await readStream(req));

  if (raw && raw.length) {
    /* Could be a raw JSON envelope the runtime never parsed. */
    const text = raw.subarray(0, 1).toString("latin1");
    if (text === "{") {
      try {
        hit = asEnvelope(JSON.parse(raw.toString("utf8")));
        if (hit) return { ...hit, via: "raw-json.dataBase64" };
      } catch (_) { /* not JSON, treat as bytes */ }
    }
    return {
      bytes: raw,
      filename: safeName(qName),
      type: qType || req.headers["content-type"] || "application/octet-stream",
      via: "raw-bytes"
    };
  }

  return { bytes: Buffer.alloc(0), filename: safeName(qName), type: qType, via: "nothing" };
}

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
  const { bytes, filename, type, via } = await resolveUpload(req, query);

  if (!bytes || bytes.length === 0) {
    return res.status(400).json({
      message: "Empty request body — no file bytes reached the server.",
      diagnostics: {
        resolvedVia: via,
        hasRawBody: !!req.rawBody,
        bodyType: req.body === undefined
          ? "undefined"
          : (Buffer.isBuffer(req.body) ? "Buffer" : typeof req.body),
        bodyKeys: req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)
          ? Object.keys(req.body).slice(0, 10)
          : null,
        contentType: req.headers["content-type"] || null,
        contentLength: req.headers["content-length"] || null
      }
    });
  }

  const target = BASE_URL + PATH;

  /* fetch generates the boundary and the matching Content-Type. */
  const form = new FormData();
  form.append(FIELD, new Blob([bytes], { type: type || "application/octet-stream" }), filename);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  let upstream;
  try {
    upstream = await fetch(target, {
      method: "POST",
      headers: { "X-API-Key": API_KEY },
      body: form,
      signal: ctrl.signal
    });
  } catch (err) {
    clearTimeout(timer);
    const timedOut = ctrl.signal.aborted;
    return res.status(504).json({
      message: timedOut
        ? `The digitisation service did not respond within ${Math.round(TIMEOUT_MS / 1000)}s.`
        : `Could not reach the digitisation service at ${BASE_URL}: ${err.message}`
    });
  }
  clearTimeout(timer);

  const text = await upstream.text();
  console.log(`  ↳ POST ${target} → ${upstream.status} | ${FIELD}="${filename}" ${bytes.length}b via ${via}`);
  res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
  res.setHeader("X-Upload-Via", via);
  return res.status(upstream.status).send(text);
};
