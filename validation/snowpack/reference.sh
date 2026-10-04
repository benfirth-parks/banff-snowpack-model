#!/usr/bin/env bash
# The whole SNOWPACK reference run: export our forcing as SMET, run SNOWPACK one
# season at a time, convert the profiles to day records, score them like our
# model. What .github/workflows/snowpack-reference.yml runs; also runs locally.
#
#   validation/snowpack/reference.sh <forcing-dir> <stations-dir> <out-dir> [seasons]
#
# <forcing-dir>   the forcing-cache branch (forcing/{season}.json.gz)
# <stations-dir>  the validation-data branch's stations/ (hourly station archive)
# [seasons]       comma-separated, default 2023-24,2024-25,2025-26
#
# <out-dir>/smet/      SMET forcing per point-season (export-smet.mjs)
# <out-dir>/runs/      SNOWPACK logs, generated ini/sno, summary.txt; the PRO and
#                      SMET outputs are deleted once converted (KEEP_PRO=1 keeps them)
# <out-dir>/days/      day records in the replay layout: points.json, {season}/{id}.json.gz
# <out-dir>/report/    snowpack-summary.md, snowpack-profiles.json, snowpack-station-hs.md
#
# Env: JOBS (default nproc), KEEP_PRO, SNOWPACK_BIN, LD_LIBRARY_PATH (see run.sh),
#      LABEL (report label, default snowpack).
set -euo pipefail
FC=${1:?usage: reference.sh <forcing-dir> <stations-dir> <out-dir> [seasons]}
STN=${2:?usage: reference.sh <forcing-dir> <stations-dir> <out-dir> [seasons]}
OUT=${3:?usage: reference.sh <forcing-dir> <stations-dir> <out-dir> [seasons]}
SEASONS=${4:-2023-24,2024-25,2025-26}
JOBS=${JOBS:-$(nproc 2>/dev/null || echo 2)}
LABEL=${LABEL:-snowpack}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
mkdir -p "$OUT" && OUT=$(cd "$OUT" && pwd)
ts() { date -u +%H:%M:%S; }

echo "[$(ts)] export SMET forcing: $SEASONS"
node "$HERE/export-smet.mjs" --forcing "$FC" --stations "$STN" --out "$OUT/smet" --nodes dem --seasons "$SEASONS"

mkdir -p "$OUT/runs" "$OUT/days"
failed=0
for season in ${SEASONS//,/ }; do
  echo "[$(ts)] snowpack $season ($JOBS jobs)"
  SEASONS=$season "$HERE/run.sh" "$OUT/smet" "$OUT/runs" "$JOBS" || failed=1 # writes runs/<season>/summary.txt
  echo "[$(ts)] convert $season"
  node "$HERE/pro2days.mjs" --runs "$OUT/runs" --smet "$OUT/smet" --out "$OUT/days" --seasons "$season"
  [ -n "${KEEP_PRO:-}" ] || rm -f "$OUT/runs/$season"/*.pro "$OUT/runs/$season"/*_byk.smet
done
cat "$OUT"/runs/*/summary.txt >"$OUT/runs/summary.txt" # all seasons (run.sh's own copy holds only the last)

echo "[$(ts)] score"
mkdir -p "$OUT/report"
node "$ROOT/validation/compare.mjs" --model "$OUT/days" --label "$LABEL" --out "$OUT/report"
node "$ROOT/validation/station-hs.mjs" --model "$OUT/days" --label "$LABEL" --out "$OUT/report"
echo "[$(ts)] done: $(grep -c '^ok' "$OUT/runs/summary.txt") point-seasons ok, $(grep -c '^FAILED' "$OUT/runs/summary.txt" || true) failed"
exit $failed
