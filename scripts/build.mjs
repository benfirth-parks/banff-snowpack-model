// Bundles the front end into dist/ (MapLibre is self-hosted: some corporate
// networks block or rewrite third-party CDN scripts).
import { build } from "esbuild";
import { mkdirSync, copyFileSync } from "node:fs";

mkdirSync("dist", { recursive: true });
await build({ entryPoints: ["src/web/app.js"], bundle: true, minify: true, format: "iife", target: "es2020", outfile: "dist/app.js", sourcemap: false });
for (const f of ["index.html", "styles.css", "about.html"]) copyFileSync(`src/web/${f}`, `dist/${f}`);
copyFileSync("node_modules/maplibre-gl/dist/maplibre-gl.js", "dist/maplibre-gl.js");
copyFileSync("node_modules/maplibre-gl/dist/maplibre-gl.css", "dist/maplibre-gl.css");
console.log("built dist/");
