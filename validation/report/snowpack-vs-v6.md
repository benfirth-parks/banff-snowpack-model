# SNOWPACK reference run vs our model (v6)

SLF's open-source SNOWPACK (commit b324cbd, June 2026) was run at all 58 validation points for 2023-24, 2024-25 and 2025-26 on the same station-corrected hourly forcing that `scripts/replay.mjs` feeds our model, and its profiles were scored with the same scripts (`validation/compare.mjs`, `validation/station-hs.mjs`) against the same 122 field profiles and the same five snow-height sensors. Everything is in `validation/snowpack/` (`reference.sh` runs it all; the script headers explain how SNOWPACK is fed and how its output is mapped onto our records). The weekly Action `snowpack-reference.yml` republishes the run to the `snowpack-reference` branch.

The point is to separate what the forcing gets wrong from what our snow physics gets wrong: where both models miss in the same way, the weather is the limit; where SNOWPACK does better, our physics has room. Both are unverified simulations; nothing here is a danger rating.

## How SNOWPACK was run
- Flat column plus N, E, S and W slopes at 38°, with SNOWPACK's own redistribution driven by the same slope drift wind our model uses (local wind blended toward the ridge wind by exposure, regional flow direction). No soil; the ground is held at 0 °C (our model's 0 °C ground sits behind a thermal resistance). 15-minute steps, 2 cm new-snow elements, hand hardness from SNOWPACK's Monti parameterisation.
- At the five stations where our model drives snowfall from the snow-height sensor (Bosworth, Bow Summit, Simpson, Stanley, Sunshine), SNOWPACK follows the same cleaned sensor series (`ENFORCE_MEASURED_SNOW_HEIGHTS`). SNOWPACK normally refuses to add snow while the air is more than 3 °C warmer than its modelled surface; under our forcing that gate stayed shut through whole storms (see "What the forcing gets wrong" below), so it is switched off, as our model has no such gate. Everywhere else both models are precipitation driven.
- Shortwave is centred on the hour stamp for SNOWPACK, because it reads the value as instantaneous while our forcing is an hourly mean (our model places the sun half an hour earlier for the same reason).
- Grain classes come from SNOWPACK's Swiss code (MF refrozen = MFcr), weak layers from its own skier search and SSI/Sk38 classes, mapped to p = 100 (poor), 60 (fair), 0 (good). Our p is continuous and tops out near 96 at six lemons, so the strict rows below use p ≥ 90 ("poor" for SNOWPACK, six lemons for ours).
- Profiles are taken every 3 h, so SNOWPACK's daily record is the 17:00 MST profile in winter and the 18:00 MDT one in autumn and spring, an hour later than ours.
- All 174 point-seasons ran (about 30 s each on four cores).

## Scores against the 122 field profiles
SNOWPACK first, v6 second. Full tables: `snowpack-summary.md`, `v6-summary.md`.

| Measure (all 122 profiles) | SNOWPACK | v6 |
|---|---|---|
| Snow height, model − pit (104 full-depth pits) | −17.3 cm, mean abs 22.3 | −13.1 cm, mean abs 21.0 |
| Grain-group agreement by relative height (100) | 46.5 % | 49.4 % |
| Hand hardness, model − observed (122) | −0.8 steps, mean abs 1.4 | −0.2 steps, mean abs 1.0 |
| Basal persistent grains found where observed | 68 of 79 | 79 of 79 |
| Crusts matched (chance rate: share of the pit range within tolerance of a model crust) | 83 of 118 = 70 % (chance 43 %) | 45 of 118 = 38 % (chance 22 %) |
| Model crust zones with no observed crust | 110 of 191 (58 %) | 55 of 92 (60 %) |
| Buried surface hoar matched / model SH with no observed match | 0 of 21 / 7 | 6 of 21 / 350 |
| Test failures with a flagged weak layer within tolerance, p ≥ 50 | 77 of 180 = 43 % | 69 of 180 = 38 % |
| Same, p ≥ 90 | 46 of 180 = 26 % | 22 of 180 = 12 % |
| Flagged layers (p ≥ 50) at an observed persistent layer or test failure | 95 of 106 = 90 % | 177 of 210 = 84 % |
| Same, p ≥ 90 | 55 of 61 = 90 % | 65 of 82 = 79 % |
| Snow temperature below 20 cm, model − observed (45) | +0.5 °C, RMSE 1.5 | −1.4 °C, RMSE 2.5 |

Weak-layer base rate (`flag-rate.mjs`, Dec–Apr, flat HS ≥ 50 cm, all sectors): SNOWPACK lists at least one p ≥ 50 layer in 79 % of profiles (0.96 layers per profile), v6 in 63 % (1.57 per profile); at p ≥ 90, 47 % vs 41 %. Both flag something most of the time, so the detection rows are read together with the precision rows.

| By group | SNOWPACK | v6 |
|---|---|---|
| Study plots (60): snow height | −8.0 cm, abs 11.9 | −8.1 cm, abs 12.4 |
| Study plots: grain agreement / hardness bias | 49.5 % / −0.6 | 53.8 % / −0.1 |
| Study plots: test failures flagged p ≥ 50 (p ≥ 90) | 38 % (18 %) | 44 % (16 %) |
| Study plots: snow temperature | +0.6 °C, RMSE 1.5 | −1.2 °C, RMSE 2.3 |
| Test profiles (62): snow height (46 full-depth) | −29.1 cm, abs 35.4 | −19.5 cm, abs 31.8 |
| Test profiles: grain agreement / hardness bias | 42.2 % / −1.0 | 43.0 % / −0.3 |
| Test profiles: test failures flagged p ≥ 50 (p ≥ 90) | 47 % (33 %) | 33 % (9 %) |
| Test profiles: flagged layers confirmed p ≥ 50 (p ≥ 90) | 84 % (84 %) | 71 % (52 %) |
| Test profiles: snow temperature (8) | −0.1 °C, RMSE 1.7 | −2.4 °C, RMSE 3.0 |

| By season: snow height / grain agreement / test failures flagged (p ≥ 50) / snow temperature bias | SNOWPACK | v6 |
|---|---|---|
| 2023-24 (36 pits) | −13.4 cm / 44 % / 41 % / +1.2 °C | −9.3 cm / 51 % / 50 % / −0.3 °C |
| 2024-25 (41) | −14.8 cm / 66 % / 49 % / +0.2 °C | −12.8 cm / 70 % / 47 % / −2.3 °C |
| 2025-26 (45) | −25.5 cm / 32 % / 39 % / 0.0 °C | −18.3 cm / 32 % / 23 % / −1.8 °C |

Study plots, snow height and grain agreement: Bow Summit −1.7 cm, 59 % (v6 −1.3 cm, 66 %); Goat's Eye +1.5 cm, 41 % (+3.0 cm, 50 %); Simpson −6.2 cm, 57 % (−6.5 cm, 55 %); Takakkaw Falls −37.7 cm, 40 % (−41.1 cm, 38 %).

## Station snow height (`snowpack-station-hs.md`, `v6-station-hs.md`)
Both follow the sensors by construction. Model − sensor, bias / mean abs over the 15 station-seasons: early season 0 / 1 cm (v6 2 / 2), winter 1 / 2 (2 / 3), spring 2 / 3 (0 / 6). Melt-out dates: both a day late on average, mean abs 4 days (v6 5). SNOWPACK's spring is tighter because its melt follows the sensor while our column melts on its own energy balance.

## What this says
1. **Snow height away from the stations is the forcing, not the physics.** Both models are far too shallow at the test profiles (−29 and −20 cm) and at Takakkaw Falls (−38 and −41 cm), while both are within a few cm at the sensor-driven plots. Two different snow models fed the same precipitation end up at the same place: the precipitation reaching points away from the stations is under-caught. SNOWPACK is the shallower of the two on test profiles, presumably through denser new snow and more settlement; that is not a reason to prefer either.
2. **Our pack is too cold, and that is our physics.** Below 20 cm our model runs 1.4 °C cold (RMSE 2.5 °C); SNOWPACK on the same radiation and air temperature is within 0.5 °C (RMSE 1.5). The bias is largest in 2024-25 (−2.3 °C) and in the test profiles (−2.4 °C). Candidates: conduction and settlement, the ground coupling, the energy balance at the surface. This is the clearest item for v7.
3. **Crusts: SNOWPACK forms them more readily and more often rightly, at the price of more false ones.** It matches 70 % of observed crusts against a 43 % chance rate (27 points of skill); ours matches 38 % against 22 % (16 points). Both leave about six in ten of their crust zones unmatched. SNOWPACK's crusts are also harder (knife for every refrozen element) and it keeps early-season crusts as crusts where observers logged facets: 315 of its grid cells call observed facets or surface hoar "MFcr".
4. **Basal facets: ours always has them, SNOWPACK mostly.** Our persistent basal layers (v3) are present wherever they were observed (79 of 79), SNOWPACK's in 68 of 79. Facets at the base are observed in three pits out of four here, so "always on" is hard to beat on this measure; the score does not count the quarter of pits where the base is not persistent.
5. **Surface hoar: neither has skill; they err in opposite directions.** SNOWPACK buries almost no surface hoar (0 of 21 observed layers matched, 7 unmatched model layers); ours buries far too much (6 of 21 matched, 350 unmatched). Real SH formation physics is still the missing piece ([v4 notes](v4-vs-v3.md)).
6. **Weak layers and test failures: SNOWPACK's indices are somewhat better on this data.** With a comparable base rate it flags 43 % of observed test failures within tolerance against our 38 %, 26 % against 12 % at the strict threshold, and its flagged layers are confirmed by an observed persistent layer or failure slightly more often (90 % vs 84 %). The gap is at the test profiles (47 % vs 33 %); at the study plots ours is ahead at p ≥ 50 (44 % vs 38 %). Our lemons-based p and SNOWPACK's Sk38/SSI classes are different scales, so the two thresholds are both shown.
7. **Grain groups and hardness: ours is a little better.** Agreement 49 % vs 47 % overall and 54 % vs 50 % at the study plots; hand hardness bias −0.2 vs −0.8 steps (SNOWPACK is too soft everywhere except its crusts).

## What the forcing gets wrong (both models)
- **Cloud cover is zero at the synoptic hours.** In the forcing cache, cloud cover is exactly 0 at every 00, 06, 12 and 18 UTC hour at every node (and 25–35 % of the time otherwise), so the incoming longwave is the clear-sky value a quarter of the time, including through storms (Bow Summit, 1 Feb 2025: RH 97 %, 15 cm of snow, longwave 205–215 W/m² where an overcast sky at −5 °C gives about 280). Dec–Feb at Bow Summit the forcing's longwave averages 196 W/m² at those hours and 218 at the others. The 17:00 MST snapshot is one of the affected hours. This cooled SNOWPACK's surface 10–20 °C below the air through storms (hence the gate above) and is probably part of our own cold bias. A fix belongs in the forcing (treat those zeros as missing, or infer cloud from humidity and precipitation) and should be scored like any model change.
- **Precipitation away from the stations** (item 1 above).
- During sensor gaps SNOWPACK was given an interpolated or held snow height where our model falls back to model precipitation after 24 h without readings (Sunshine 2024-25 and Bosworth 2025-26 had long gaps). That is an information advantage for SNOWPACK at those two station-seasons only.

## On "serve whichever scores better"
Neither model dominates. Ours is ahead on snow height, grain groups, hand hardness and basal facets, and has fewer false crusts; SNOWPACK is ahead on snow temperature, crust detection, weak-layer detection and has almost no false surface hoar. Two practical points for the decision: SNOWPACK is a C++ program that cannot run inside the hourly Netlify function, so serving it would mean a daily GitHub Action feeding the site, with no hourly update and no forecast or forecast-spread product; and the two largest shared errors (precipitation away from stations, clear-sky longwave) are forcing problems that fixing would help either model equally. The recommendation from this comparison is to keep serving our model, use the SNOWPACK reference as the standing benchmark (it now reruns weekly), and take the snow-temperature bias, crust formation and the longwave artefact as the next model items.

## Reproduce
```
SNOWPACK_BIN=... LD_LIBRARY_PATH=... validation/snowpack/reference.sh /tmp/fc /tmp/vd/stations /tmp/snowpack-ref
node validation/snowpack/flag-rate.mjs v6=/tmp/replay-v6 snowpack=/tmp/snowpack-ref/days
```
`compare.mjs` gained the crust chance rate, the p ≥ 90 rows and the 3 cm crust-zone merge in this comparison; `v6-summary.md` was regenerated with it. The earlier version comparisons (v3–v6) were not regenerated and lack those rows.
