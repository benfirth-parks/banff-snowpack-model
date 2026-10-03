# Model v3 vs v2

Both versions were replayed locally (`scripts/replay.mjs`) through 2023–24, 2024–25 and 2025–26 with the same inputs: the complete forcing cache (HRDPS, RDPS gap-fill, Open-Meteo's default downscaling to the 90 m DEM, as the live site receives it) and the full station archive. `v2-replay` reproduces the live site's v2 scores (`v2-summary.md`) closely, so the differences below come from the model changes alone.

## Air temperature (`*-forcing-skill.md`)
Mean absolute error in °C, December to March. "Withheld" is the analysis at each station's location with that station left out, which is how well the model knows places without a station. "Forecast" is from 12 UTC every third day, using only data before then.

| | 2023–24 v2 → v3 | 2024–25 v2 → v3 | 2025–26 v2 → v3 |
|---|---|---|---|
| Analysis, station withheld | 2.0 → 1.8 | 2.0 → 1.8 | 1.9 → 1.6 |
| Forecast 13–24 h | 2.4 → 2.1 | 2.8 → 1.8 | 2.2 → 1.9 |
| Forecast 25–48 h | 2.9 → 2.3 | 3.0 → 1.9 | 2.7 → 2.1 |
| Forecast bias 25–48 h | −2.0 → 0.0 | −2.1 → −0.1 | −1.4 → +0.1 |

- Ridge stations, withheld (2023–24): Vulture Peak −1.9 → −0.5 °C bias, Whymper −1.9 → −0.7, Simpson Upper −1.8 → −1.4.
- Forecast humidity error at 25–48 h drops from 11.7–13.6 % to 10.5–11.7 %.
- Bow Summit (a cold hollow) gets slightly worse when withheld (bias +1.0 → +1.6 °C). A straight elevation fit can't represent a local cold pool. With its own station in, Bow Summit is corrected as before.

## Profiles (`v2-replay-summary.md`, `v3-summary.md`)
| Measure (122 profiles) | v2 | v3 |
|---|---|---|
| Basal persistent grains where observed | 70 / 79 | 78 / 79 |
| ≥ 2 mm "RG" at the base | 42 | 0 |
| Grain-group agreement | 47.3 % | 49.1 % |
| Test failures with a model weak layer | 55 / 180 | 58 / 180 |
| Snow temperature below 20 cm, bias | −1.5 °C | −1.3 °C |
| HS error (full-depth pits) | −19.3 cm | −20.8 cm |
| Crusts, unmatched | 173 | 188 |
| Buried SH, unmatched | 319 | 296 |

## Still wrong
- The pack is about 20 cm too shallow. That is precipitation (plan item 2), not addressed here.
- The model makes far more buried surface hoar and crusts than observers record.
