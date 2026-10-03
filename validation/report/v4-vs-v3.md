# Model v4 vs v3: snow-height-driven precipitation

Both versions were replayed locally through 2023–24, 2024–25 and 2025–26 with the same inputs (complete forcing cache, full station archive).

## What changed
- **Snow height drives snowfall at the stations.** A flat column at each snow-height station (Bow Summit, Bosworth Lower, Stanley Lower, Simpson Lower, Sunshine, Pika Run, Coleman, Big Bend) gets snow only when the measured HS rises above the simulated HS, as SNOWPACK does at automatic stations. The station's own point uses that snowfall directly.
- **Neighbours are corrected at full weight.** Precipitation ratios are taken over 72 h, so a storm the model has a few hours early or late still counts, and can go from ×0.25 to ×4. They spread about 40 km and 1200 m of elevation. Before, an HS station could take off only about a quarter of the model's precipitation at its own location.
- **Forecast.** Each station's recent precipitation ratio carries into the forecast.
- **HS quality control.** Rises faster than snow can fall, and jumps that don't hold for the next hours, are dropped. This removes Bow Summit's 220.9 cm error value, Sunshine's evening readings near 190 cm, and the summer 317 cm readings.
- **Sensor baselines.** HS sensor baselines now come from July–September only. The past-season baselines had picked up spring hours with snow still on the ground, so Bow Summit, Sunshine and Bosworth Lower were shifted by up to 30 cm. That affected the site's past-season "snow height check" table, not the field-profile scores.

## Field profiles
| Measure | v3 | v4 |
|---|---|---|
| HS error, all full-depth pits (n 104) | −20.8 cm, mean abs 30.5 | −12.5 cm, mean abs 20.3 |
| HS error, study plots (n 58) | −16.8 cm, mean abs 28.4 | −7.8 cm, mean abs 12.5 |
| HS error, test profiles away from stations (n 46) | −25.8 cm, mean abs 33.2 | −18.4 cm, mean abs 30.0 |
| Test failures with a model weak layer | 58 / 180 | 61 / 180 |
| Grain-group agreement | 49.1 % | 49.6 % |
| Crusts, matched / unmatched | 47 / 188 | 42 / 171 |
| Buried SH, matched / unmatched | 6 / 296 | 6 / 339 |

## Station snow height
Model (flat, at the station's point) minus the quality-checked sensor, December to March mean absolute difference in cm, with the corrected baselines for both versions:

| Station | 2023–24 v3 → v4 | 2024–25 v3 → v4 | 2025–26 v3 → v4 |
|---|---|---|---|
| Bosworth Lower | 43 → 2 | 13 → 2 | 22 → 4 |
| Bow Summit | 6 → 3 | 20 → 2 | 7 → 5 |
| Simpson Lower | 34 → 2 | 29 → 6 | 42 → 2 |
| Stanley Lower | 28 → 2 | 4 → 1 | 18 → 5 |
| Sunshine | 8 → 5 | 8 → 10 | 40 → 8 |

In May, melt still runs ahead of the sensor at some stations.

## Forecast snowfall (`v4-forcing-skill.md`)
48 h snowfall at the HS stations, compared with the snowfall their snow height then showed, December to March:

| Season | v3 bias / MAE (mm) | v4 bias / MAE (mm) |
|---|---|---|
| 2023–24 | −3.8 / 5.7 | −1.5 / 6.0 |
| 2024–25 | −4.7 / 6.1 | −2.6 / 5.4 |
| 2025–26 | −4.4 / 9.3 | −4.4 / 9.3 |

The bias falls in two of the three seasons. The error on individual forecasts is about the same. Air temperature and humidity scores are unchanged from v3.

## Still wrong
- Pits away from the stations are still about 18 cm too shallow.
- The model makes far more buried surface hoar and crusts than observers record. Buried surface hoar went up a little (296 → 339 unmatched), because the station points now get dry hours where the weather model had drizzle.
- Spring melt runs ahead of the sensors in some seasons.
