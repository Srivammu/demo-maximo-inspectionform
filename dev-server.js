/**
 * Local dev server — a stand-in for `vercel dev`, with no Vercel account,
 * no CLI and no npm install required. Plain Node, nothing else.
 *
 *   1. node dev-server.js
 *   2. open http://localhost:3000
 *
 * It serves index.html and runs anything in api/ the same way Vercel does,
 * so /api/inspform works exactly as it will in production.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".ico": "image/x-icon", ".map": "application/json", ".txt": "text/plain"
};

/* ---- Vercel-shaped res helpers ----------------------------------------- */
function shim(res) {
  let code = 200;
  return {
    setHeader: (k, v) => res.setHeader(k, v),
    getHeader: (k) => res.getHeader(k),
    status(c) { code = c; return this; },
    json(o) {
      if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "application/json");
      res.writeHead(code); res.end(JSON.stringify(o));
    },
    send(b) {
      res.writeHead(code);
      res.end(b == null ? "" : (typeof b === "string" ? b : JSON.stringify(b)));
    },
    end() { res.writeHead(code); res.end(); }
  };
}

/* Buffer, not string — file uploads are binary and string concat corrupts them. */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    const finish = () => resolve(Buffer.concat(chunks));
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", finish);
    req.on("error", finish);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  let pathname = decodeURIComponent(url.pathname);

  /* ---- /api/* → api/<name>.js ----------------------------------------- */
  if (pathname.startsWith("/api/")) {
    const name = pathname.slice(5).replace(/[^a-zA-Z0-9._-]/g, "");
    const file = path.join(ROOT, "api", name + ".js");
    if (!fs.existsSync(file)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ message: `No function at api/${name}.js` }));
    }

    const raw = await readBody(req);
    const ct = req.headers["content-type"] || "";

    if (process.env.SIMULATE_VERCEL) {
      /* Reproduce the deployed runtime: the body is already consumed, rawBody
         does not exist, and req.body is only populated for JSON. Use this to
         test that an upload will actually work once deployed:
             SIMULATE_VERCEL=1 node dev-server.js                              */
      if (raw.length && ct.includes("application/json")) {
        const text = raw.toString("utf8");
        try { req.body = JSON.parse(text); } catch (_) { req.body = text; }
      }
    } else {
      req.rawBody = raw;                     // Buffer — used by api/upload.js
      if (raw.length && ct.includes("application/json")) {
        const text = raw.toString("utf8");
        try { req.body = JSON.parse(text); } catch (_) { req.body = text; }
      }
    }

    try {
      delete require.cache[require.resolve(file)];   // pick up edits without a restart
      const handler = require(file);
      const fn = typeof handler === "function" ? handler : handler.default;
      await fn(req, shim(res));
    } catch (err) {
      console.error(`[api/${name}]`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: `Function crashed: ${err.message}` }));
      }
    }
    console.log(`${req.method} ${pathname} → api/${name}.js`);
    return;
  }

  /* ---- static ---------------------------------------------------------- */
  if (pathname === "/") pathname = "/index.html";
  const file = path.join(ROOT, pathname);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("Not found");
  }
  /* Never serve secrets, even by accident. */
  if (/(^|[\\/])\.env/.test(pathname)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    return res.end("Forbidden");
  }
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
    "Cache-Control": "no-store"
  });
  fs.createReadStream(file).pipe(res);
  console.log(`${req.method} ${pathname}`);
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error(`  Run it on another port:   set PORT=3001 && node dev-server.js\n`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, () => {
  console.log(`\n  Inspection form UI running:  http://localhost:${PORT}\n`);
  console.log(`  digitiser      : https://dev-mms.eam360.com/digitiser`);
  console.log(`  Maximo         : https://demo.eam360.com/maxrest`);
  console.log(`  Maximo auth    : maxauth`);  
  console.log(`\n  All three API calls are proxied through this server, so the`);
  console.log(`  browser makes same-origin requests only — no CORS anywhere.`);
  console.log(`\n  Ctrl+C to stop.\n`);
});
