#!/usr/bin/env bash
# Runs SNOWPACK (SLF) at every exported point-season, five sectors each.
#
#   validation/snowpack/run.sh <smet-dir> <out-dir> [jobs]
#
# <smet-dir>/<season>/<id>.smet   hourly UTC forcing, written by export-smet.mjs
# <smet-dir>/<season>/meta.json   [{ id, file, lat, lon, z, hasHS, start, end }]
#                                 (start/end ISO UTC, first and last row). <id> below
#                                 is the file stem: the point id with ':' -> '_'.
# <out-dir>/<season>/<id>_byk.pro, <id>1_byk.pro .. <id>4_byk.pro   profiles every 3 h
# <out-dir>/<season>/<id>_byk.smet, <id>1_byk.smet .. <id>4_byk.smet time series (HS_mod in cm)
# <out-dir>/<season>/<id>.log     SNOWPACK output; <out-dir>/<season>/{ini,sno}/ the generated inputs
# <out-dir>/summary.txt           one "ok"/"FAILED" line per point-season; <out-dir>/<season>/summary.txt that season's
#
# Sector order is fixed by SNOWPACK: 0 = flat (main station, "<id>"), then the
# virtual slopes "<id>1".."<id>4" at 38 deg facing N, E, S, W, i.e. our aspect
# order [flat, N, E, S, W]. Points with hasHS run with the measured snow height
# enforced on the flat column (snowfall from the sensor, like our model); all
# others are precipitation driven. Everything starts from bare ground one hour
# after `start` (the first SMET row) and runs to `end` (the last row).
#
# A run that fails (nonzero exit, [E] in the log, stopped early, a sector's PRO
# missing) has its partial PRO/SMET output removed, so pro2days.mjs sees no
# output for that point-season rather than a truncated one; its .log stays.
#
# Env: SNOWPACK_BIN (default /tmp/claude-0/item7/usr/bin/snowpack),
#      LD_LIBRARY_PATH (default /tmp/claude-0/item7/usr/lib),
#      SEASONS ("2023-24 2024-25", default: every <smet-dir>/*/meta.json),
#      POINTS (file stems, "fts-bowsummit parker-ridge_ALP"; default: all).
#      The PRO files are large (~100 MB per point-season at 0.02 m elements), so
#      a full three-season run is best done one season at a time: run, convert
#      with pro2days.mjs, delete the PRO files, next season.
set -u
SMET=${1:?usage: run.sh <smet-dir> <out-dir> [jobs]}
OUT=${2:?usage: run.sh <smet-dir> <out-dir> [jobs]}
JOBS=${3:-$(nproc 2>/dev/null || echo 2)}
export SNOWPACK_BIN=${SNOWPACK_BIN:-/tmp/claude-0/item7/usr/bin/snowpack}
export LD_LIBRARY_PATH=${LD_LIBRARY_PATH:-/tmp/claude-0/item7/usr/lib}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TEMPLATE=$HERE/snowpack.ini
SMET=$(cd "$SMET" && pwd) || exit 1
mkdir -p "$OUT" && OUT=$(cd "$OUT" && pwd) || exit 1
[ -x "$SNOWPACK_BIN" ] || { echo "snowpack binary not found: $SNOWPACK_BIN" >&2; exit 1; }

# One bare-ground .sno per sector. SNOWPACK names sectors by appending 1..4 to
# the station id; it takes slope and azimuth from here (SLOPE_FROM_SNO).
write_sno() { # file station_id name lat lon z angle azi profiledate
  cat >"$1" <<EOF
SMET 1.1 ASCII
[HEADER]
station_id       = $2
station_name     = $3
latitude         = $4
longitude        = $5
altitude         = $6
nodata           = -999
tz               = 0
source           = BYK snowpack validation, bare ground start
ProfileDate      = $9
HS_Last          = 0.0000
SlopeAngle       = $7
SlopeAzi         = $8
nSoilLayerData   = 0
nSnowLayerData   = 0
SoilAlbedo       = 0.20
BareSoil_z0      = 0.020
CanopyHeight     = 0.00
CanopyLeafAreaIndex = 0.00
CanopyDirectThroughfall = 1.00
ErosionLevel     = 0
TimeCountDeltaHS = 0.000000
fields           = timestamp Layer_Thick T Vol_Frac_I Vol_Frac_W Vol_Frac_V Vol_Frac_S Rho_S Conduc_S HeatCapac_S rg rb dd sp mk mass_hoar ne CDot metamo
[DATA]
EOF
}

# run_one <season> <id> <hasHS> <begin> <end>; prints one summary line.
run_one() {
  local season=$1 id=$2 hasHS=$3 begin=$4 end=$5
  local out=$OUT/$season
  local log=$out/$id.log t0=$SECONDS
  "$SNOWPACK_BIN" -c "$out/ini/$id.ini" -s "$id" -b "$begin" -e "$end" >"$log" 2>&1
  local rc=$? dt=$((SECONDS - t0)) why=""
  [ $rc -eq 0 ] || why="exit $rc"
  grep -q '^\[E\]' "$log" && why="${why:+$why; }[E] in log"
  grep -q 'No valid data for station\|No forcing data provided' "$log" && why="${why:+$why; }stopped early (missing forcing)"
  local k; for k in "" 1 2 3 4; do [ -s "$out/${id}${k}_byk.pro" ] || { why="${why:+$why; }missing ${id}${k}_byk.pro"; break; }; done
  if [ -z "$why" ]; then echo "ok      $season/$id  ${dt}s"; else
    for k in "" 1 2 3 4; do rm -f "$out/${id}${k}_byk.pro" "$out/${id}${k}_byk.smet"; done # partial output would score as a short season
    echo "FAILED  $season/$id  ${dt}s  ($why)"
  fi
}
export -f run_one
export OUT

jobs=$(mktemp) && prefail=$(mktemp) && trap 'rm -f "$jobs" "$prefail"' EXIT
for meta in "$SMET"/*/meta.json; do
  [ -f "$meta" ] || continue
  season=$(basename "$(dirname "$meta")")
  if [ -n "${SEASONS:-}" ]; then case " $SEASONS " in *" $season "*) ;; *) continue;; esac; fi
  out=$OUT/$season
  mkdir -p "$out/ini" "$out/sno"
  # meta.json -> one line per point: sid hasHS begin end lat lon z, where sid is
  # the file stem (point id with ':' replaced by '_'), which SNOWPACK uses as the
  # station id and output name. The simulation begins one hour after the first
  # SMET row: re-accumulating PSUM over the first 15 min step needs the row
  # before it, and SNOWPACK stops at the first step with no data.
  node -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const utc = (s) => Date.parse(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : s + "Z"); // meta dates are UTC, with or without a Z
    const f = (ms) => new Date(ms).toISOString().slice(0, 16);
    for (const p of m) console.log([p.file.replace(/\.smet$/, ""), p.hasHS ? 1 : 0, f(utc(p.start) + 36e5), f(utc(p.end)), p.lat, p.lon, p.z].join(" "));
  ' "$meta" | while read -r id hasHS begin end lat lon z; do
    if [ -n "${POINTS:-}" ]; then case " $POINTS " in *" $id "*) ;; *) continue;; esac; fi
    [ -f "$SMET/$season/$id.smet" ] || { echo "FAILED  $season/$id  0s  (no $id.smet)" >>"$prefail"; continue; }
    write_sno "$out/sno/$id.sno" "$id" "$id" "$lat" "$lon" "$z" 0.0 0.0 "$begin"
    k=1; for azi in 0.0 90.0 180.0 270.0; do write_sno "$out/sno/$id$k.sno" "$id$k" "$id" "$lat" "$lon" "$z" 38.0 "$azi" "$begin"; k=$((k + 1)); done
    enforce=false; [ "$hasHS" = 1 ] && enforce=true
    cat >"$out/ini/$id.ini" <<EOF
IMPORT_BEFORE = $TEMPLATE
[Input]
METEOPATH = $SMET/$season
SNOWPATH = $out/sno
[Output]
METEOPATH = $out
[Snowpack]
ENFORCE_MEASURED_SNOW_HEIGHTS = $enforce
EOF
    echo "$season $id $hasHS $begin $end" >>"$jobs"
  done
done
n=$(wc -l <"$jobs")
[ "$n" -gt 0 ] || { echo "no point-seasons found under $SMET (need <season>/meta.json with existing .smet files)" >&2; cat "$prefail" >&2; exit 1; }
echo "snowpack: $n point-seasons, $JOBS parallel, out $OUT"
t0=$SECONDS
{ cat "$prefail"; xargs -P "$JOBS" -L1 bash -c 'run_one "$@"' _ <"$jobs"; } | tee "$OUT/summary.txt"
for season in $(cut -d' ' -f1 "$jobs" | sort -u); do grep " $season/" "$OUT/summary.txt" >"$OUT/$season/summary.txt" || true; done # per-season copy
ok=$(grep -c '^ok' "$OUT/summary.txt"); failed=$(grep -c '^FAILED' "$OUT/summary.txt")
echo "done: $ok ok, $failed failed, $((SECONDS - t0)) s wall; summary in $OUT/summary.txt"
[ "$failed" -eq 0 ]
