# Model v5 vs v4: ridge-top wind for wind slabs

Both versions were replayed locally through 2023–24, 2024–25 and 2025–26 with the same inputs (complete forcing cache, full station archive). Air temperature, humidity and precipitation are unchanged from v4 (`v5-forcing-skill.md` matches `v4-forcing-skill.md` for those).

## What changed
- **A separate ridge-top wind.** The model's 10 m wind is a 2.5 km grid-cell average. Over December to March it averages about 6 km/h within 40 km of the ridge anemometers, which average 12–28 km/h. The ridge wind scales the model's mean wind over the surrounding ~40 km by each ridge station's ratio of observed to model wind. It spreads that ratio ~15 km horizontally and pulls it toward the average of the ridge stations elsewhere. The ridge stations are Vulture Peak, Bosworth Upper, Lookout, Whymper and Simpson Upper.
- **Loading direction from the regional flow.** The drift direction is the model's flow averaged over ~40 km. At the ridge stations, in hours over 25 km/h, it is within a median 12–45° of the observed direction. The 10 m direction of the nearest grid cells was 14–58° off; at Whymper and Bosworth Upper it is channelled up the valleys.
- **Which slopes see it.** Snow on the 38° slopes is moved by the ridge wind in the alpine (2400 m and up), by a wind between the local and ridge wind at treeline (about 60 % ridge at the TL band), and by the local wind below 1800 m. This sets drifting, loading during snowfall, and the density and wind mark of the deposited snow. The flat field and the slopes' energy balance keep the local wind.
- **Forecast.** Each ridge station's ratio fades into its learned average (12 h e-folding), like the 10 m wind correction.
- The status dialog's wind column now also shows each ridge station's current ridge ratio.

## Wind at the ridge anemometers (`v5-forcing-skill.md`)
Analysis with each ridge station withheld in turn, December to March. "Caught" is the share of observed hours over 25 km/h (about where fresh snow drifts) that the model also has over 25 km/h.

| Season | Observed mean | 10 m wind: bias / MAE / caught | Ridge wind: bias / MAE / caught | Ridge wind false alarms |
|---|---|---|---|---|
| 2023–24 | 18.5 km/h | −8.4 / 10.2 / 15 % | −0.6 / 7.0 / 45 % | 37 % |
| 2024–25 | 19.1 km/h | −9.2 / 10.8 / 15 % | −0.6 / 8.9 / 37 % | 49 % |
| 2025–26 | 23.9 km/h | −10.2 / 11.9 / 23 % | −1.4 / 9.0 / 53 % | 37 % |

Forecasts at the ridge stations, every third day from 12 UTC (the station's own ratio carried forward):

| Season | Lead | 10 m wind: bias / MAE / caught | Ridge wind: bias / MAE / caught |
|---|---|---|---|
| 2023–24 | 1–6 h | −6.5 / 8.8 / 29 % | +0.9 / 6.1 / 72 % |
| 2023–24 | 25–48 h | −6.4 / 8.9 / 16 % | +0.2 / 7.6 / 36 % |
| 2024–25 | 1–6 h | −6.6 / 8.3 / 25 % | 0.0 / 6.1 / 50 % |
| 2024–25 | 25–48 h | −7.6 / 9.5 / 22 % | −1.5 / 7.6 / 40 % |
| 2025–26 | 1–6 h | −6.5 / 8.8 / 50 % | +0.5 / 6.9 / 75 % |
| 2025–26 | 25–48 h | −7.6 / 10.2 / 35 % | −0.7 / 8.2 / 59 % |

The ridge wind removes the low bias and catches two to three times as many drifting-wind hours. It also has more false alarms, 25–53 % of its hours over 25 km/h against 14–35 % for the 10 m wind. Each station's own exposure still differs: withheld, Vulture Peak and Lookout read lower than their neighbours suggest, and Bosworth Upper higher.

## Wind slabs
Share of December–March days on which the replayed named points have a wind slab index of 50 % or more (thickness of dry wind-affected snow from the last 96 h, centred at 15 cm):

| Band | v4: N / E / S / W | v5: N / E / S / W | v5, any slope |
|---|---|---|---|
| ALP | 4 / 4 / 2 / 2 % | 11 / 11 / 5 / 6 % | 12 % (v4 4 %) |
| TL | 1 / 1 / 0 / 0 % | 2 / 2 / 1 / 1 % | 3 % (v4 1 %) |
| BTL | 0 % | 0 % | 0 % |

The lee of the prevailing south-west to west flow (N and E) now loads most. Points away from the ridge anemometers change most: at ALP, Emerald Peak 0 → 23 %, Mt Dennis 1 → 17 %, Observation Peak 0 → 11 % and Simpson 0 → 9 % of days. In 2024–25 the wind moving snow on their slopes averaged 4–6 km/h in v4 and 14–20 km/h in v5.

## Field profiles
| Measure | v4 | v5 |
|---|---|---|
| HS error, all full-depth pits (n 104) | −12.5 cm, mean abs 20.3 | −12.8 cm, mean abs 21.1 |
| HS error, test profiles on the N slope (N, NE, NW; n 20) | −12.7 cm, mean abs 37.0 | −8.7 cm, mean abs 36.0 |
| HS error, test profiles on the E slope (n 5) | −31.6 cm | −29.8 cm |
| HS error, test profiles on the S slope (S, SE, SW; n 7) | −23.0 cm | −28.4 cm |
| HS error, test profiles on the W slope (n 4) | −23.2 cm, mean abs 26.8 | −44.2 cm, mean abs 47.2 |
| Test failures with a model weak layer | 61 / 180 | 62 / 180 |
| Model weak layers at an observed persistent layer or test failure | 165 / 197 | 170 / 203 |
| Grain-group agreement | 49.6 % | 49.4 % |
| Crusts, matched / unmatched | 42 / 171 | 43 / 172 |
| Buried SH, matched / unmatched | 6 / 339 | 6 / 340 |

Study plots and flat test profiles are unchanged, since the flat field keeps the local wind. Lee-facing pits get deeper and windward ones shallower. Three of the four W-facing pits are treeline pits that are matched to the 2500 m alpine slope, which the model strips, so they can't tell whether the stripping is too strong.

## Tried, not included
- **Ridge wind in the slopes' energy balance.** More sensible heat exchange on the slopes raised unmatched crusts from 171 to 203 and cut weak-layer precision from 84 to 81 %. Lee slopes sit in the eddy below the ridge, so they keep the local wind.
- **Ridge wind from the nearest grid cells** instead of the regional mean. It scored slightly worse at the withheld stations (MAE 8.9 against 8.1 km/h) and left valley-sheltered points (Simpson, Emerald Peak) at about 9 km/h ridge wind, below every ridge anemometer.
- **A faster drift rate** (Tabler's U^3.8 transport over a 100 m lee zone, about 3× the current rate). ALP wind-slab days rose to 16 %, but W-facing pits went to −64 cm. With no data on how often slabs actually form, I kept the existing rate.

## Still wrong
- How often the model forms wind slabs can't be checked against field profiles, which are mostly study plots and calm-day test pits. The forecast bulletins' wind-slab problems by elevation and aspect would pin the drift rate and the wind slab index.
- Pits away from the stations are still about 18 cm too shallow, which limits how much snow there is to drift.
