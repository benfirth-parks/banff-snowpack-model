# Model v6 vs v5: melt and crusts

Both versions were replayed locally through 2023–24, 2024–25 and 2025–26 with the same inputs (complete forcing cache, full station archive). Forcing is unchanged: v6 changes only the snow model, so `v5-forcing-skill.md` still applies. All of this is unverified model simulation scored against 122 field profiles and five snow-height sensors.

## What changed
- **Wet-snow albedo follows the hours the surface has spent wet.** v5 used 0.5 + 0.4·exp(−age/2 d) whenever the surface was wet, with age counted from deposition. A surface that had sat cold for two weeks dropped straight to about 0.55 on its first melt hour, and on spring days without snowfall the station snowpacks melted about 1.5 times faster than the sensors (5.9 against 3.8 cm/day). v6 lowers albedo from the dry value toward 0.6 with an e-folding of 100 wet hours, tracked per layer (`wt`). The 100 h rate is the melting-snow rate of ISBA and CLASS. Those schemes floor at 0.5; the 0.6 floor is the low end of old clean wet snow (0.60–0.70) and fitted the station sensors best (0.5 left spring snow about 4.5 cm low, 0.55 about 3 cm).
- **Surface hoar is destroyed once it has held meltwater.** In v5 the meltwater drained out of the thin hoar layer before the check ran, so surface hoar (albedo 0.9) survived three days of 12–14 °C air at Bow Summit in March 2024.
- **Water entering snow below 0 °C refreezes on entry** until that snow reaches 0 °C, and only then is held or passed on. v5 left it liquid until the next half-hour step, so about 4 % of profiles showed wet layers at −1 to −9 °C. This is a consistency fix: wetting-front depth and every score are unchanged by it.
- MODEL_VERSION 6, so the live season and the three past seasons re-run.

## Snow height at the snow-height stations (`v{5,6}-station-hs.md`)
Flat column at the station's point minus the sensor, bias / mean abs, cm. Melt-out is model minus sensor.

| | Early (Oct–Nov) | Winter (Dec–Mar) | Spring (Apr–Jun) | Melt-out |
|---|---|---|---|---|
| v5 | 1 / 2 | 2 / 3 | −7 / 9 | −3 d, mean abs 4 d (n 10) |
| v6 | 2 / 2 | 2 / 3 | 0 / 6 | +1 d, mean abs 5 d (n 9) |

The spring mean abs error falls in 10 of 15 station-seasons and rises in 3 (Bow Summit 2024–25 and 2025–26, Simpson Lower 2024–25). Eight station-seasons now melt too slowly, the most at Bow Summit 2024–25 and Bosworth Lower 2025–26 (+8 cm). Melt-out timing does not improve: v5 was 3 days early and v6 is 1 day late, with a similar absolute error.

**An independent check.** At the stations, snowfall follows the sensor, so a column that melts too fast makes the model invent snowfall to catch up with the sensor. v5 did this all spring; v6 adds 36 % less spring precipitation at the snow-height stations. The Bow Summit precipitation gauge (raw, no undercatch correction) agrees with v6:

| Bow Summit | Gauge | v5 model | v6 model |
|---|---|---|---|
| April 2024 | 52 mm | 132 | 63 |
| May 2024 | 76 | 118 | 76 |
| April 2025 | 29 | 85 | 27 |
| May 2025 | 35 | 69 | 47 |
| April 2026 | 32 | 73 | 26 |
| May 2026 | 77 | 176 | 73 |

## Field profiles (`v{5,6}-summary.md`, all 122)
| Measure | v5 | v6 |
|---|---|---|
| HS error (full-depth pits) | −12.8 / 21.1 cm | −13.1 / 21.0 cm |
| Grain-group agreement | 49.4 % | 49.4 % |
| Hand hardness | −0.2 / 1.0 | −0.2 / 1.0 |
| Basal persistent grains found | 79/79 | 79/79 |
| Crusts matched (layers) | 43/118; 172 unmatched model layers | 45/118; 161 |
| Crusts matched by position: bottom 30 % / mid-pack / top 30 cm | 4/37, 21/55, 18/26 | 6/37, 22/55, 17/26 |
| Model crust zones, with no observed match | 97, 56 | 101, 57 |
| Buried surface hoar matched; unmatched model SH | 6/21; 340 | 6/21; 350 |
| Test failures with a model weak layer | 62/180 (34 %) | 69/180 (38 %) |
| Model weak layers at an observed persistent layer or failure | 170/203 (84 %) | 177/210 (84 %) |
| Snow temperature below 20 cm | −1.3 °C, RMSE 2.5 | −1.4 °C, RMSE 2.5 |

The extra test failures caught are at the study plots (35 → 39 of 89) and in test profiles (27 → 30 of 91).

## What changes away from the stations (not validated)
The station columns are reset toward the sensor at each storm; the named points and slopes are not, so they change more. Mean flat snow height, v5 → v6, cm:

| Band | Mar | Apr | May | Jun |
|---|---|---|---|---|
| ALP | 144 → 146 | 144 → 154 | 87 → 119 | 35 → 69 |
| TL | 114 → 117 | 94 → 112 | 29 → 61 | 1 → 13 |
| BTL | 80 → 86 | 50 → 69 | 6 → 18 | 0 → 0 |

Mean indices over the named points and slopes, v5 → v6:

| Index | Band | Mar | Apr | May | Jun |
|---|---|---|---|---|---|
| Wet | ALP | 4 → 2 | 19 → 8 | 46 → 42 | 35 → 46 |
| Wet | TL | 8 → 5 | 36 → 21 | 38 → 52 | 9 → 23 |
| Wet | BTL | 16 → 11 | 41 → 40 | 17 → 30 | 1 → 2 |
| Persistent | ALP | 52 → 57 | 32 → 50 | 6 → 18 | 0 → 3 |
| Persistent | TL | 53 → 65 | 23 → 48 | 2 → 7 | 0 → 0 |
| Persistent | BTL | 31 → 41 | 8 → 17 | 0 → 0 | 0 → 0 |

The wet-snow season starts weeks later, and persistent layers stay in the output well into April at ALP and TL, because the snowpack stays colder and drier for longer. New-snow and wind-slab indices barely move. Bulletin problems are the way to check this timing (`validation/bulletins.mjs`, waiting on a bulletin export).

## Scoring changes
- `compare.mjs` now also counts the model's crusts as zones, with adjacent crust layers counted once, as an observer logs one thick melt-freeze crust. It also splits observed crusts by position. v5's "172 model crusts with no observed match" are mostly stacks: one wetting fills 10–20 cm, and every layer in it was counted. As zones, v5 has 97 crusts and 56 without a match.
- `station-hs.mjs` dates the sensor's melt-out from its valid readings and ignores gaps. The sensors often stop reporting for a week or more after melt-out, and the old rule dated melt-out to when data resumed. v5 melt-out is −3 d, not −9 d.

## Tried and not included
- **Humidity-aware rain/snow split** (Jennings et al. 2018 logistic; wet-bulb ramps around 0.5–1.5 °C). Tested on 143 precipitation events between −1 and +4 °C at five stations, using station temperature and humidity and labelling each event by whether snow height rose. No scheme was distinguishable from the current split, 50 % snow at +1 °C: event hit rate v5 82 %, Jennings 79 %, wet-bulb 76–77 %. Humidity during these events is 92–100 %, so wet-bulb temperature is within about 0.3 °C of air temperature. The change in seasonal snow water is at most 11 mm, far too small to explain why pits away from the stations are about 18 cm too shallow. With the raw model temperature and humidity instead of station values, every scheme drops to about 66 %, so forcing temperature matters far more than the form of the split.
- **A shallow soil heat reservoir** (two layers, sun-warmed when snow-free, coupled to the snow base). It barely moved early-season snow height (bias 1.34 → 1.27 cm), because snowfall at the stations follows the sensor and absorbs the difference. The −1.3 °C snow-temperature bias is not at the base (+0.03 °C in the bottom 10 cm) but in the upper pack (about −2.8 °C at 20–40 cm depth). The first version also leaked surface energy into the soil.
- **Crust rules.** Three attempts were made to decide which wetted layers become crusts:
  - only the top of each wetted zone, plus layers that have refrozen 40 % of their mass;
  - a minimum of refrozen ice per layer (15 kg/m³), with only weak crusts lost to faceting;
  - the same without the faceting exception.

  Each moved crust hits by about as much as random placement of the same number of crusts in the same part of the pack would. The first only thinned stacks: zones were almost unchanged and mid-pack hits fell 22 → 14. Ben's concern that a trace of water makes a crust holds for few layers: only 24 of v5's 172 unmatched crust layers ever held less than 1 % water, and most held a full 3 % fill.
- **Faster albedo aging**, as first planned. v5 already melted too fast, so faster aging would have made spring worse.

## Still wrong
- **Crust placement is close to chance.** v6 matches 45 of 101 crust zones; random placement in the same parts of the pack would match about 38 (standard error about 5). Only mid-pack crusts at the study plots are clearly better than chance (13 of 23 against about 9). Which events make crusts depends on melt and rain in the forcing. At Bow Summit on 15 March 2024 the observers found only the top 2 cm moist and −8.5 to −10 °C at 10–15 cm depth, while between 13 and 19 March the model melted about 49 mm and wetted 64 cm of snow. Whether the forcing's sunshine or the dry-snow albedo (about 0.74 after ten days) is to blame is not yet known.
- **The model is too cold in the upper pack:** about −2.8 °C at 20–40 cm depth.
- **Snow height away from the stations:** pits are still about 18 cm too shallow (the full-depth test profiles are −19.5 cm).
- **Buried surface hoar:** 350 unmatched model layers against 6 of 21 observed matched.
- **New snow early in the season:** in the first day after a cold October snowfall, the sensors lose 70–80 % of the new snow, faster than the model settles it.
