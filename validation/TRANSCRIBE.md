# Transcribing field snow profiles

How the field profiles in `profiles/` are turned into `validation/observed/{season}/*.json` for checking the model.

## Formats you will meet
1. **Propagation Labs "Manual Snow Profile"** (PDF or 2523×2526 PNG, mostly 2024–26).
   - The header block is at the bottom: Date `YYYY-MM-DD hh:mm`, Observer, Elevation (m or ft), Aspect, Slope, Lat/Lng, Air Temperature, Sky, Precipitation, Wind, HS, Surface Grain, Foot Pen and Ski Pen.
   - Notes sit below the header. For PDFs, `pdftotext -layout file.pdf -` gives the exact header and notes text, so use it.
   - In the chart:
     - **Height axis:** on the right of the hardness chart, in cm above the ground (0 at the bottom). The HS number is in orange at the top.
     - **Hand-hardness bars:** extend left from that axis. The bottom axis runs left to right K, P, 1F, 4F, F.
     - **Temperature profile:** red dots, read against the top axis in °C.
     - **Grain table:** grain form and size (mm), on the right.
     - **Test labels:** yellow, e.g. "CT1 on ∨", drawn at the failure height. The results are in the notes.
2. **SnowPilot graph** (994×840 JPG, or a PDF, mostly 2022–24).
   - The header is at the top: site, date `DD/MM/YYYY hh:mm`, Elevation, Aspect, Slope Angle, Air Temperature, Sky Cover, Precipitation, Wind, and sometimes PF/PS (record these verbatim).
   - In the chart:
     - **Hardness bars:** on the left. The axis runs left to right I, K, P, 1F, 4F, F.
     - **Height axis:** in the middle, in cm above the ground. The top label is HS.
     - **Crystal columns:** Form, Size and Moisture, plus density (ρ) when given.
     - **Stability tests and layer comments:** in the right-hand column, with an arrow at the failure height, e.g. "CT17, SC @10cm x2".
   - Some SnowPilot sheets also carry a temperature profile; record it if present.
3. **Anything else:** a photo, a field-book page, a photo markup or a video. Record what you can. If it is not a profile, write the JSON with `"not_a_profile": true` and a one-line description.

## Grain form symbols (IACS 2009)
| Symbol | Class |
|---|---|
| `+` | PP (precipitation particles) |
| `⟋` (slash) | DF (decomposing and fragmented) |
| `●` (filled circle) | RG (rounded grains) |
| `□` (open square) | FC (faceted crystals) |
| `∧` (caret or hat) | DH (depth hoar) |
| `∨` (V) | SH (surface hoar) |
| `○` (open circle) | MF (melt form); two linked circles, or circles on a thin hard (P/K/I) layer = MFcr (melt-freeze crust) |
| `—` (horizontal bar) | IF (ice formation) |

- **Mixed rounded and faceted glyphs** (a half-filled circle or square, a square with a rounded top, a circle with a flat base): write `FCxr` if the glyph is square-based, `RGxf` if circle-based. Write `FCxr/RGxf` if you cannot tell.
- **Secondary forms** are in parentheses: `□(⟋)` means primary FC, secondary DF.
- **Unreadable glyphs:** describe the glyph in `grain_raw` and give your best class with `"uncertain": true`.

## Hand hardness
Record the label (`F-`, `F`, `F+`, `4F-`, `4F`, `4F+`, `1F-`, `1F`, `1F+`, `P-`, `P`, `P+`, `K-`, `K`, `K+`, `I`) and the index `hardness_idx`:
- F = 1, 4F = 2, 1F = 3, P = 4, K = 5, I = 6;
- `+` adds 0.33 and `-` subtracts 0.33.

Read the bar's outer edge against the axis tick marks. If the edge falls between two ticks, interpolate.

## Procedure, per profile
1. **Render or downsize the image so you can read it.**
   - PDF: `pdftoppm -r 110 -png -singlefile "<pdf>" /tmp/<scratch>/<name>`.
   - Big PNG or JPG: `python3 -c "from PIL import Image; im=Image.open('<file>'); im.thumbnail((1400,1400)); im.convert('RGB').save('/tmp/<scratch>/<name>.jpg', quality=88)"`.
   - Then Read the image. If a region is too small to read, crop it and read the crop. Use PIL `crop()` on the full-resolution file.
2. **For PDFs, also run `pdftotext -layout` to get the exact header and notes text.**
3. **Write one JSON file** to `validation/observed/{season}/{YYYY-MM-DD}_{slug}.json`.
   - `season` is `2023-24`, `2024-25` or `2025-26`.
   - The slug is lowercase with hyphens: `bow-summit-plot`, `goats-eye-plot`, `simpson-plot`, `tak-falls-plot`, or the place name for test profiles.
   - If two source files show the same profile (PDF and PNG of the same pit), write one JSON and list both files in `source_files`.
   - If filename and header dates disagree, trust the header. Note the difference in `reading_issues`.
4. **Record heights in cm above the ground**, exactly as the chart's height axis shows them, and give layers bottom to top. Also give `depth_top_cm` (HS minus top height) for each layer. If a chart is depth-from-surface instead, convert it, and say so in `reading_issues`.
5. **Don't invent values.** Use `null` where a field is blank or unreadable. Be precise about layer boundaries: these profiles are the reference that the model will be scored against.

## JSON schema
```json
{
  "source_files": ["profiles/2025-2026/Study Plot profiles/Bow Summit/2026-01-24_1036_260124 Bow Summit.pdf"],
  "season": "2025-26",
  "kind": "study_plot | test_profile | fracture_line | other",
  "site": "Bow Summit Study Plot",
  "site_slug": "bow-summit-plot",
  "chart_format": "propagation_labs | snowpilot | other",
  "date": "2026-01-24", "time": "10:36",
  "observer": "ben firth",
  "lat": 51.7094, "lon": -116.4790,
  "elevation_m": 2032, "elevation_raw": "6668ft",
  "aspect": "N|NE|E|SE|S|SW|W|NW|flat|null", "slope_deg": null,
  "air_temp_c": -7.8, "sky": "Overcast", "precip": "Snow 1cm/hr", "wind": "Calm", "blowing_snow": null,
  "hs_cm": 135, "surface_grain": "PP", "foot_pen_cm": 35, "ski_pen_cm": 20,
  "header_other": {"PF": "62", "PS": "15"},
  "layers": [
    {"bottom_cm": 0, "top_cm": 8, "depth_top_cm": 127, "grain": "FC", "grain2": null, "grain_raw": "□", "size_mm": [3.0, 4.0], "hardness": "1F", "hardness_idx": 3.0, "moisture": null, "density": null, "uncertain": false, "comment": null}
  ],
  "temps": [{"h_cm": 135, "t_c": -7.7}],
  "tests": [
    {"raw": "CTE1 SC", "type": "CT", "score": "CTE1", "taps": 1, "propagation": null, "fracture": "SC", "height_cm": 123, "depth_cm": 12, "layer_grain": "SH", "count": 1}
  ],
  "named_layers": [{"name": "Jan 3 SH", "height_cm": 123, "depth_cm": 12, "grain": "SH"}],
  "notes": "verbatim notes text",
  "summary": "one sentence describing the structure, e.g. 'Basal FC/DH 0-35 cm with a thin crust at 10 cm; buried SH at 12 cm (CTE1 SC); 135 cm HS'",
  "confidence": "high | medium | low",
  "reading_issues": "anything uncertain"
}
```
- `taps` is the CT/ECT tap count. Use 0 for CTV/ECTV and `null` for no result.
- `propagation` applies to ECT: `"P"` or `"N"`.
- For PST, put the cut length and the result in `raw` and `score`.
