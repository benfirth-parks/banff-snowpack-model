// Local preview: runs the pipeline on mock data into an in-memory store and
// serves dist/ plus the /api endpoints. For UI work only — real data needs the
// deployed functions.   npm run preview  →  http://localhost:8787
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { runPipeline } from "../netlify/lib/pipeline.mjs";
import { deps } from "../tests/mock-deps.mjs";

await runPipeline(deps, { log: (m) => console.log(m) });
const s = deps.store;
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (u.pathname === "/api/meta") return send(200, await s.get("meta", { type: "json" }));
  if (u.pathname === "/api/field") { const f = await s.get(`field/${u.searchParams.get("date")}`, { type: "json" }); return f ? send(200, f) : send(404, { error: "none" }); }
  if (u.pathname === "/api/point") { const id = u.searchParams.get("id"); return send(200, { id, days: (await s.get(`pts/${id}`, { type: "json" }))?.days || [], forecast: await s.get(`ptf/${id}`, { type: "json" }) }); }
  if (u.pathname === "/api/status") return send(200, { status: await s.get("status", { type: "json" }), lastError: null, running: false });
  const path = join("dist", u.pathname === "/" ? "index.html" : u.pathname);
  try { const b = await readFile(path); res.writeHead(200, { "content-type": types[extname(path)] || "application/octet-stream" }); res.end(b); }
  catch { res.writeHead(404); res.end("not found"); }
}).listen(8787, () => console.log("preview on http://localhost:8787"));
