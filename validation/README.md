# Validation against field profiles

The model is checked against Parks Canada field profiles, not just station snow height.

## Pieces
| Path | What it is |
|---|---|
| `profiles/` | Source field profiles as uploaded (Propagation Labs and SnowPilot exports, 2022–26). |
| `validation/TRANSCRIBE.md` | How profiles are transcribed: schema, grain symbols, hardness index. |
| `validation/observed/{season}/*.json` | One JSON per profile: layers, grain form and size, hardness, temperatures, tests, named layers. `index.csv` lists them all. |
| `validation/compare.mjs` | Scores a set of model point profiles against the observed ones. |
| `validation/report/` | Scores per model version (`{label}-summary.md`, `{label}-profiles.json`, `{label}-forcing-skill.md`), and the version comparisons (`v3-vs-v2.md`, `v4-vs-v3.md`, `v5-vs-v4.md`). |
| `scripts/replay.mjs` | Replays past seasons locally for the model's points, from the forcing cache and station archive. `--code` runs another checkout (e.g. a git worktree of an older version) on the same inputs. |
| `validation/bulletins.mjs` | Scores the model's avalanche problem indices (storm, wind, persistent, wet) by band against the problems in past BYK bulletins, from a CSV of bulletin problems (format in the script header). |
| `scripts/forcing-skill.mjs` | Scores air temperature and humidity at the stations, and the 10 m and ridge wind at the ridge anemometers: analysis with each station withheld, and 48 h forecasts. Also 48 h forecast snowfall at the snow-height stations. |
| `.github/workflows/export-validation-data.yml` | Copies the live site's past-season point profiles and the weather explorer's 3-year hourly station archive to the `validation-data` branch. |
| `.github/workflows/cache-forcing.yml` | Caches the archived HRDPS forcing at every model node on the `forcing-cache` branch, for local replays. |

## Run a comparison
```
git fetch origin validation-data && mkdir -p /tmp/vd && git archive FETCH_HEAD | tar -x -C /tmp/vd
node validation/compare.mjs --model /tmp/vd/model --label v2
```
The model directory needs `points.json` and `{season}/{pointId}.json.gz`, which is the layout of the export and of local replays.

## Replay a model change before releasing it
```
git fetch origin forcing-cache && mkdir -p /tmp/fc && git archive FETCH_HEAD | tar -x -C /tmp/fc
node scripts/replay.mjs --forcing /tmp/fc --stations /tmp/vd/stations --out /tmp/replay --nodes dem
node validation/compare.mjs --model /tmp/replay --label v4
node scripts/forcing-skill.mjs --forcing /tmp/fc --stations /tmp/vd/stations --seasons 2023-24,2024-25,2025-26 --nodes dem
```
A full three-season replay takes about a minute and a half. `--nodes dem` matches what the live site receives.

## Matching and scores
**Matching.**
- Study plots use fixed points: Bow Summit → `fts-bowsummit`, Goat's Eye → `fts-sunshine`, Simpson → `fts-simplo`, Takakkaw Falls → `emerald-pk:BTL`. All are flat.
- Test profiles use the nearest point by horizontal km + |Δz|/100 m.
- The virtual slope comes from the observed aspect: N/NE/NW → N, S/SE/SW → S, E → E, W → W. Slopes under 10° use the flat run.
- The model's 17:00 profile on the same date is used.

**Scores.** All scores use only the depth range the pit actually covered.
- **HS error.** Full-depth pits only.
- **Grain-group agreement.** AVID's five groups, compared on a 40-step relative-height grid.
- **Hand-hardness error.**
- **Feature detection.** Basal persistent grains in the bottom 30 % of the pack, crusts, and buried surface hoar. A model layer matches an observed one if it is within 12 % of HS in relative height or 10 cm in depth from the surface.
- **Test failures.** Whether the model has a weak layer with p ≥ 50 % at each observed test failure.
- **Snow temperature.** Error below 20 cm depth.

## Caveats
- Profiles were transcribed from images. Three were checked against the charts and matched closely, but small misreads are possible.
- Several exports carry the Banff-townsite default coordinates and elevation instead of the pit location. `compare.mjs` uses known plot locations, or a short gazetteer, for those.
- Observation times are mostly late morning. The model profile is for 17:00.
