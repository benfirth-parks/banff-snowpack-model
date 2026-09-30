# BYK Snowpack Model

AVID-style snowpack model and viewer for Banff / Yoho / Kootenay (Parks Canada Visitor Safety). See README.md for the architecture.

## Conventions
- Commit directly to `main`, in small, descriptive commits. Show the diff before committing larger changes.
- Preserve existing UI and behaviour unless a change is asked for. The look follows AVID (snowpack.avalanche.ca).
- Free, keyless data only. Station actuals come from the weather-explorer API and forecasts from the weather-fx-tool `/api/forecast` proxy. No API keys in the repo. `RUN_TOKEN` is an env var.
- MapLibre is self-hosted from node_modules, not a CDN (the Parks network has corrupted third-party scripts before).
- Model code in `src/model/` must stay dependency-free and runnable in both Node and the browser.
- Run `npm test` after model changes. The synthetic test prints µs per sim-hour; keep it under ~25 so the hourly run stays cheap.
- Be explicit that output is unverified model simulation. Don't present indices as danger ratings.
