# Validation data export

Exported 2026-10-01T18:43:07.316Z by `scripts/export-validation-data.mjs` (workflow `export-validation-data` on main).
This branch is replaced on every export.

- `model/points.json`: the model's points (named points × ALP/TL/BTL, and stations).
- `model/{season}/{pointId}.json.gz`: daily 17:00 profiles from the past-season reanalysis. `A[aspect]` is the profile for flat, N, E, S, W:
  6 integers per layer, top-down: top depth (cm×10), grain class index (PP, DF, RG, FCxr, FC, DH, SH, MF, MFcr), hand hardness×10, T×10 (°C), grain size×10 (mm), density (kg/m³).
- `stations/{stationId}.json.gz`: hourly station archive from the Rockies Weather Data Explorer, column-oriented.
- `summary.json`: row counts and sizes.
