// Sun position and slope irradiance.
//
// Sun position uses the low-precision NOAA / Astronomical Almanac formulas
// (good to ~0.01° for 1950–2050), which is far better than the hourly forcing
// needs. Azimuth is measured clockwise from north, in radians.

const D2R = Math.PI / 180;

export function sunPosition(ms, latDeg, lonDeg) {
  const n = ms / 86400000 + 2440587.5 - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * D2R;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * D2R;
  const eps = (23.439 - 0.0000004 * n) * D2R;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const lmst = gmst + lonDeg / 15;
  const H = lmst * 15 * D2R - ra;
  const lat = latDeg * D2R;
  const cosZ = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H);
  const zen = Math.acos(Math.max(-1, Math.min(1, cosZ)));
  let az = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(lat) - Math.sin(lat) * Math.cos(H));
  if (az < 0) az += 2 * Math.PI;
  return { cosZ, zen, az };
}

// Irradiance on an inclined plane from hourly-mean horizontal global, direct and
// diffuse radiation. The geometry is evaluated at mid-hour (Open-Meteo radiation
// is the mean over the preceding hour). Terrain shading is not modelled — the
// same simplification SNOWPACK's virtual slopes make.
//   slope, aspect in radians (aspect clockwise from north)
//   groundAlbedo: reflectance of the surrounding terrain seen by the slope
export function slopeShortwave(ghi, dirH, difH, sun, slope, aspect, groundAlbedo = 0.6) {
  if (!(ghi > 0)) return 0;
  if (slope === 0) return ghi;
  const cosZ = sun.cosZ;
  let direct = 0;
  if (cosZ > 0.02 && dirH > 0) {
    const dni = Math.min(1100, dirH / Math.max(cosZ, 0.1));
    const sinZ = Math.sin(sun.zen);
    const cosI = Math.cos(slope) * cosZ + Math.sin(slope) * sinZ * Math.cos(sun.az - aspect);
    direct = dni * Math.max(0, cosI);
  }
  const diffuse = Math.max(0, difH) * (1 + Math.cos(slope)) / 2;
  const reflected = ghi * groundAlbedo * (1 - Math.cos(slope)) / 2;
  return direct + diffuse + reflected;
}

export const DEG = D2R;
