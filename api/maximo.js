/**
 * Proxy → Maximo (mxapiinspform). Handles both Maximo steps:
 *
 *   POST  /api/maximo           → create   POST  {BASE_URL}{OS_PATH}?ignorecollectionref=1&lean=1
 *   PATCH /api/maximo?id=<n>    → update   PATCH {BASE_URL}{OS_PATH}/<n>?ignorecollectionref=1&lean=1
 *                                          with patchtype: MERGE
 *
 * Both get APIKEY + properties: * attached here, server-side. Maximo's CORS
 * allowlist only admits the IBM Maximo Mobile app's own origin, so a browser can
 * never call it directly — this proxy is what makes the flow possible at all.
 *
 * No env vars — host, path and credential are hardcoded below.
 */

const QUERY = "?ignorecollectionref=1&lean=1";
const BASE_URL = "https://maseam360.manage.maseam360.apps.masdev.eam360.com/maximo";
const OS_PATH = "/api/os/mxapiinspform";
const APIKEY = "6l1cccr640vj72m6cn3uo88hbp6568sa3hiup6j";
const TIMEOUT_MS = 120000;


function authHeaders() {
  return { "properties": "*", "APIKEY": APIKEY };
}

function readRawText(req) {
  if (req.rawBody) return Promise.resolve(
    Buffer.isBuffer(req.rawBody) ? req.rawBody.toString("utf8") : String(req.rawBody)
  );
  if (req.readableEnded || req.complete || req.readable === false) {
    return Promise.resolve("");
  }
  return new Promise((resolve) => {
    let raw = "";
    const finish = () => { clearTimeout(timer); resolve(raw); };
    const timer = setTimeout(finish, 20000);
    req.on("data", (c) => { raw += c; });
    req.on("end", finish);
    req.on("error", finish);
  });
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    res.setHeader("Allow", "POST, PATCH, OPTIONS");
    return res.status(204).end();
  }
  if (req.method !== "POST" && req.method !== "PATCH") {
    res.setHeader("Allow", "POST, PATCH");
    return res.status(405).json({
      message: `${req.method} is not allowed here. POST to create, PATCH to update.`
    });
  }

  /* ---- body ------------------------------------------------------------- */
  let payload = req.body;
  if (payload === undefined) {
    const raw = await readRawText(req);
    if (raw) { try { payload = JSON.parse(raw); } catch (_) { payload = raw; } }
  }
  if (payload === undefined || payload === null || payload === "") {
    return res.status(400).json({
      message: req.method === "POST"
        ? "Empty request body — the digitisation service returned nothing to send to Maximo."
        : "Empty request body — no cascade options to PATCH."
    });
  }
  const bodyText = typeof payload === "string" ? payload : JSON.stringify(payload);

  /* ---- id, for PATCH ---------------------------------------------------- */
  let id = null;
  if (req.method === "PATCH") {
    id = new URL(req.url, "http://localhost").searchParams.get("id");
    if (!id) {
      return res.status(400).json({
        message: "PATCH requires ?id=<inspectionformid>. Maximo's response to the create call supplies it."
      });
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      return res.status(400).json({ message: `Invalid id "${id}".` });
    }
  }

  const headers = { "Content-Type": "application/json", ...authHeaders() };
  if (req.method === "PATCH") headers["patchtype"] = "MERGE";

  const target = BASE_URL + OS_PATH + (id ? "/" + id : "") + QUERY;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetch(target, {
      method: req.method, headers, body: bodyText, signal: ctrl.signal
    });
  } catch (err) {
    clearTimeout(timer);
    const timedOut = ctrl.signal.aborted;
    return res.status(504).json({
      message: timedOut
        ? `Maximo did not respond within ${Math.round(TIMEOUT_MS / 1000)}s.`
        : `Could not reach Maximo at ${BASE_URL}: ${err.message}`
    });
  }
  clearTimeout(timer);

  const text = await upstream.text();
  console.log(`  ↳ ${req.method} ${target} → ${upstream.status} (${text.length} bytes)`);
  res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
  res.setHeader("X-Maximo-Path", OS_PATH);
  const location = upstream.headers.get("location");
  if (location) res.setHeader("X-Maximo-Location", location);
  return res.status(upstream.status).send(text);
};
