/**
 * Proxy → Maximo (mxapiinspform). Handles both steps of the Maximo work:
 *
 *   POST  /api/maximo           → create   POST {base}/api/os/mxapiinspform?ignorecollectionref=1&lean=1
 *   PATCH /api/maximo?id=<n>    → update   PATCH {base}/api/os/mxapiinspform/<n>?ignorecollectionref=1&lean=1
 *                                          with patchtype: MERGE
 *
 * Both get maxauth + properties: * attached here, server-side. Maximo's CORS
 * allowlist only admits the IBM Maximo Mobile app's own origin, so a browser can
 * never call it directly — this proxy is what makes the flow possible at all.
 *
 * The original front-end sent APIKEY: "" on the PATCH and no maxauth, so that
 * step was unauthenticated. Both calls now use the same credential.
 *
 * Env overrides (optional — the defaults below are the working values):
 *   MAXIMO_BASE_URL     default https://demo.eam360.com/maxrest
 *   MAXIMO_MAXAUTH      default the base64 below   (base64 of "user:password")
 *   MAXIMO_APIKEY       if set, sent as APIKEY instead of maxauth
 *   MAXIMO_COOKIE       if set, sent as Cookie (browsers cannot do this; we can)
 *   UPSTREAM_TIMEOUT_MS default 120000
 */

const DEFAULT_BASE = "https://demo.eam360.com/maxrest";
const DEFAULT_MAXAUTH = "Sk9ITjpTZWRpbkAxMjM=";
const OS_PATH = "/api/os/mxapiinspform";
const QUERY = "?ignorecollectionref=1&lean=1";

function authHeaders() {
  const h = { "properties": "*" };
  if (process.env.MAXIMO_APIKEY) h["APIKEY"] = process.env.MAXIMO_APIKEY;
  else h["maxauth"] = process.env.MAXIMO_MAXAUTH || DEFAULT_MAXAUTH;
  if (process.env.MAXIMO_COOKIE) h["Cookie"] = process.env.MAXIMO_COOKIE;
  return h;
}

function readRawText(req) {
  if (req.rawBody) return Promise.resolve(req.rawBody.toString("utf8"));
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

  /* ---- target URL ------------------------------------------------------- */
  const base = (process.env.MAXIMO_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
  let target;

  if (req.method === "PATCH") {
    const id = new URL(req.url, "http://localhost").searchParams.get("id");
    if (!id) {
      return res.status(400).json({
        message: "PATCH requires ?id=<inspectionformid>. Maximo's response to the create call supplies it."
      });
    }
    /* Only ever interpolate a safe id into the upstream path. */
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      return res.status(400).json({ message: `Invalid id "${id}".` });
    }
    target = `${base}${OS_PATH}/${id}${QUERY}`;
  } else {
    target = `${base}${OS_PATH}${QUERY}`;
  }

  const headers = {
    "Content-Type": "application/json",
    ...authHeaders()
  };
  /* Merge patch so only inspcascadeoption[] is touched. */
  if (req.method === "PATCH") headers["patchtype"] = "MERGE";

  const timeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS || 120000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let upstream;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: bodyText,
      signal: ctrl.signal
    });
  } catch (err) {
    clearTimeout(timer);
    const timedOut = ctrl.signal.aborted;
    return res.status(504).json({
      message: timedOut
        ? `Maximo did not respond within ${Math.round(timeoutMs / 1000)}s.`
        : `Could not reach Maximo at ${base}: ${err.message}`
    });
  }
  clearTimeout(timer);

  const text = await upstream.text();
  console.log(`  ↳ ${req.method} ${target} → ${upstream.status} (${text.length} bytes)`);

  /* Pass the upstream status and body through untouched so the page can show
     the real Maximo error, BMXAA codes and all. */
  res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
  const location = upstream.headers.get("location");
  if (location) res.setHeader("X-Maximo-Location", location);
  return res.status(upstream.status).send(text);
};
