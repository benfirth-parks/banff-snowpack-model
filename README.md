# BYK Snowpack Model

Simulated snowpack structure and avalanche-problem indices for Banff, Yoho and Kootenay, in the style of Avalanche Canada's AVID snowpack viewer (snowpack.avalanche.ca). It is driven by Parks Canada's own weather stations and HRDPS/RDPS forecasts.

- **Actuals:** Parks Canada FTS stations, read from the Rockies Weather Data Explorer (`https://rockiesweatherdataexplorer.netlify.app/api/fts`).
- **Forecasts:** HRDPS 2.5 km, then RDPS 10 km, read through the Parks Wx Fx cached Open-Meteo proxy (`https://rockiesweatherfxtool.netlify.app/api/forecast`). If the proxy fails it calls Open-Meteo directly.
- **Terrain:** Open-Meteo elevation API (90 m DEM). This is fetched once, when the grid is first built.

Every source is free and keyless.

## How it works
Model weather is interpolated to a ~5 km grid (0.045° × 0.07°) and to named points at ALP, TL and BTL elevations, using lapse rates from the model itself. Station residuals (T, RH, wind, 24 h precipitation) then correct it with an elevation-aware kernel, and those corrections decay through the forecast. Each location runs five snow columns: flat, plus N, E, S and W at 38°. The snow model is a compact multilayer model in the SNOWPACK/Crocus style (`src/model/snowpack.js`). It covers the energy balance, conduction, settlement, metamorphism, surface hoar, liquid water and wind loading. On top of that it computes threshold-sum ("lemons") weak-layer stability and new/wind/PWL/wet problem indices (`src/model/stability.js`). The full method and its limitations are in `src/web/about.html`, which is served at `/about.html`.

## Layout
| Path | What |
|---|---|
| `src/model/` | Model code with no dependencies, shared by the functions and the browser: domain, forcing, snowpack, site (aspects), stability, solar, time |
| `netlify/lib/pipeline.mjs` | One run: fetch data → advance the analysis → run the forecast → write fields and point series to Blobs |
| `netlify/lib/fetchers.mjs` | Station, forecast-model and elevation fetchers |
| `netlify/functions/run-background.mjs` | The run itself (background function, 15 min limit), guarded by `RUN_TOKEN` |
| `netlify/functions/schedule.mjs` | Hourly trigger at :25 UTC |
| `netlify/functions/{meta,field,point,status}.mjs` | Read API (`/api/meta`, `/api/field?date=`, `/api/point?id=`, `/api/status`) |
| `src/web/` | Front end: MapLibre map, Property Explorer, profile graphic (`profile.js`) |
| `tests/` | Synthetic-season physics test and an end-to-end pipeline test on mock data |

## Blobs (store `snowpack-v1`)
`meta` (grid, points, available dates), `state/c{n}` and `state/points` (snowpack state), `field/{YYYY-MM-DD}` (map values and text for every cell at 17:00 local), `pts/{id}` (daily profiles for a point), `ptf/{id}` (forecast profiles for a point), and `status`.

## Develop
```
npm install
npm test              # physics smoke test + mock end-to-end run
npm run preview       # mock data at http://localhost:8787 (UI work only)
npm run build         # dist/
```

## Deploy
Netlify builds with `npm run build` and publishes `dist/`. Set the environment variable `RUN_TOKEN` to a random string. The scheduled function passes it to the background run. To run by hand (for example to spin up a season):
```
curl -X POST -H "x-run-token: $RUN_TOKEN" "https://<site>/.netlify/functions/run-background?fc=1"
```
To restart a season, delete the `state/index` blob. The next run then spins up again from `SEASON_START` in `netlify/lib/pipeline.mjs`.
