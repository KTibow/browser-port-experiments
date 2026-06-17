#!/usr/bin/env node
// Minimal static file server for local testing of dist/.
// Supports Range requests (needed if you ever host images locally) and sets
// permissive cross-origin headers.
import http from "node:http";
import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const port = Number(process.env.PORT || 8000);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".bin": "application/octet-stream",
  ".img": "application/octet-stream",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent(req.url.split("?")[0]);
    if (urlPath.endsWith("/")) urlPath += "index.html";
    const filePath = path.join(root, path.normalize(urlPath));
    if (!filePath.startsWith(root)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat || stat.isDirectory()) {
      res.writeHead(404).end("Not found");
      return;
    }
    const type = TYPES[path.extname(filePath)] || "application/octet-stream";
    // Mirror GitHub Pages: no COOP/COEP. v86 runs single-threaded without them.
    const headers = {
      "Content-Type": type,
      "Access-Control-Allow-Origin": "*",
    };
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      res.writeHead(206, {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
      });
      createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...headers, "Content-Length": stat.size, "Accept-Ranges": "bytes" });
      createReadStream(filePath).pipe(res);
    }
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
});

server.listen(port, () => {
  console.log(`Serving dist/ at http://localhost:${port}/`);
});
