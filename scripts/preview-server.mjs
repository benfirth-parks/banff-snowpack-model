// Local preview: runs the pipeline on mock data into an in-memory store and
// serves dist/ plus the /api endpoints. For UI work only — real data needs the
// deployed functions.   npm run preview  →  http://localhost:8787
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { runPipeline } from "../netlify/lib/pipeline.mjs";
import { deps } from "../tests/mock-deps.mjs";
import { runSeasonChunk, getRegistry } from "../netlify/lib/reanalysis.mjs";

await runPipeline(deps, { log: (m) => console.log(m) });
if (process.env.SEASON_CHUNKS) for (let i = 0; i < Number(process.env.SEASON_CHUNKS); i++) await runSeasonChunk(deps, "2025-26", { log: (m) => console.log(m) });
const s = deps.store;
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const season = u.searchParams.get("season");
  const pre = season ? `seasons/${season}/` : "";
  if (u.pathname === "/api/meta") { const m = await s.get("meta", { type: "json" }); m.seasons = (await getRegistry(s)).list; return send(200, m); }
  if (u.pathname === "/api/field") { const f = await s.get(`${pre}field/${u.searchParams.get("date")}`, { type: "json" }); return f ? send(200, f) : send(404, { error: "none" }); }
  if (u.pathname === "/api/point") { const id = u.searchParams.get("id"); return send(200, { id, days: (await s.get(`${pre}pts/${id}`, { type: "json" }))?.days || [], forecast: season ? null : await s.get(`ptf/${id}`, { type: "json" }) }); }
  if (u.pathname === "/api/status") return send(200, { status: await s.get("status", { type: "json" }), lastError: null, running: false, seasons: (await getRegistry(s)).list.map(({ dates, ...r }) => ({ ...r, days: (dates || []).length })) });
  const path = join("dist", u.pathname === "/" ? "index.html" : u.pathname);
  try { const b = await readFile(path); res.writeHead(200, { "content-type": types[extname(path)] || "application/octet-stream" }); res.end(b); }
  catch { res.writeHead(404); res.end("not found"); }
}).listen(8787, () => console.log("preview on http://localhost:8787"));
