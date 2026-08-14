/**
 * Proxy → digitisation service.
 *
 * The browser POSTs multipart/form-data to /api/upload; this forwards the bytes
 * untouched (same boundary, same `source_file` part) to the digitiser with the
 * X-API-Key attached, and passes the response straight back.
 *
 * Runs server-side, so no CORS applies and the key never reaches the browser.
 *
 * Env overrides (optional — the defaults below are the working values):
 *   DIGITISE_BASE_URL   default https://dev-mms.eam360.com/digitiser
 *   DIGITISE_PATH       default /api/v1/form-digitisation/upload/mock?target_format=maximo
 *   DIGITISE_API_KEY    default the key below
 *   UPSTREAM_TIMEOUT_MS default 120000
 */

const DEFAULT_BASE = "https://dev-mms.eam360.com/digitiser";
const DEFAULT_PATH = "/api/v1/form-digitisation/upload/mock?target_format=maximo";
const DEFAULT_KEY = "jT1pyUNC,ja==+gPk@KCh{qyEtAu3s.e";

/* Vercel: keep the raw bytes intact instead of parsing the body. */
module.exports.config = { api: { bodyParser: false } };

function readRaw(req) {
  if (req.rawBody) return Promise.resolve(req.rawBody);
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

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ message: `${req.method} is not allowed here. Use POST.` });
  }

  const contentType = req.headers["content-type"] || "";
  if (!contentType.includes("multipart/form-data")) {
    return res.status(400).json({
      message: `Expected multipart/form-data, got "${contentType || "nothing"}".`
    });
  }

  const body = await readRaw(req);
  if (!body || body.length === 0) {
    return res.status(400).json({ message: "Empty request body — no file received." });
  }

  const base = (process.env.DIGITISE_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
  const path = process.env.DIGITISE_PATH || DEFAULT_PATH;
  const apiKey = process.env.DIGITISE_API_KEY || DEFAULT_KEY;
  const timeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS || 120000);

  const target = base + path;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let upstream;
  try {
    upstream = await fetch(target, {
      method: "POST",
      headers: {
        "X-API-Key": apiKey,
        /* Forward the original Content-Type verbatim — it carries the multipart
           boundary, and regenerating it would corrupt the body. */
        "Content-Type": contentType
      },
      body,
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
  console.log(`  ↳ POST ${target} → ${upstream.status} (${text.length} bytes, sent ${body.length})`);
  res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
  return res.status(upstream.status).send(text);
};
