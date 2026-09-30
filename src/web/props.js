// Map properties shown in the Property Explorer: labels, units, legend
// subtitles, value domains and single-hue sequential ramps (light → dark).

const RAMPS = {
  depth: ["#f4efe9", "#d9d3de", "#b5bfd8", "#8ea3cc", "#7482b8", "#5f5ea3"],
  hazard: ["#f7eff3", "#ecc5d7", "#d98bb0", "#b8508a", "#8a2a6b", "#5c1349"],
  orange: ["#fbf1e6", "#f8d4ad", "#f2ab6d", "#e17c34", "#b8561a", "#7d3810"],
  navy: ["#eef1f7", "#c6cfe3", "#8e9fc6", "#5a6ea3", "#2f437a", "#121f45"],
  wet: ["#fbf8e5", "#f2e9a6", "#dcc55f", "#b8962d", "#8a6b17", "#5a440c"],
  blue: ["#eef5fb", "#c7ddf0", "#93bde0", "#5b97c9", "#2f6fa8", "#174a7a"],
  green: ["#eff7ee", "#c8e6c3", "#95cc8d", "#5daa55", "#2f7f30", "#175416"],
  gray: ["#f2f2ef", "#d6d8d0", "#b3b8aa", "#8a9282", "#626b5a", "#3d4436"],
};

const sn = "averaged over aspects";
export const GROUPS = [
  { name: "HAZARD", props: [
    { key: "hazard", label: "Hazard", unit: "%", sub: `Probability of an avalanche problem (%), ${sn}`, domain: [0, 100], ramp: RAMPS.hazard },
    { key: "pNew", label: "New snow", unit: "%", sub: `Probability of a new snow problem (%), ${sn}`, domain: [0, 100], ramp: RAMPS.orange },
    { key: "pWind", label: "Wind slab", unit: "%", sub: `Probability of a wind slab problem (%), ${sn}`, domain: [0, 100], ramp: RAMPS.orange },
    { key: "pPwl", label: "Persistent weak layers", unit: "%", sub: `Structural instability of the weakest persistent layer (%), ${sn}`, domain: [0, 100], ramp: RAMPS.navy },
    { key: "pWet", label: "Wet snow", unit: "%", sub: `Probability of a wet snow problem (%), ${sn}`, domain: [0, 100], ramp: RAMPS.wet },
  ] },
  { name: "NEW SNOW", props: [
    { key: "precip72", label: "Precip (72 h)", unit: "mm", sub: "Precipitation (mm water) in the previous 72 h", domain: [0, 60], ramp: RAMPS.blue },
    { key: "snow72", label: "Snowfall (72 h)", unit: "cm", sub: "Snowfall (cm, at deposition) in the previous 72 h", domain: [0, 80], ramp: RAMPS.depth },
    { key: "rain72", label: "Rain (72 h)", unit: "mm", sub: "Rain (mm) in the previous 72 h", domain: [0, 30], ramp: RAMPS.green },
    { key: "precip24", label: "Precip (24 h)", unit: "mm", sub: "Precipitation (mm water) in the previous 24 h", domain: [0, 30], ramp: RAMPS.blue },
    { key: "snow24", label: "Snowfall (24 h)", unit: "cm", sub: "Snowfall (cm, at deposition) in the previous 24 h", domain: [0, 40], ramp: RAMPS.depth },
    { key: "rain24", label: "Rain (24 h)", unit: "mm", sub: "Rain (mm) in the previous 24 h", domain: [0, 15], ramp: RAMPS.green },
  ] },
  { name: "WIND SLAB", props: [
    { key: "wind24", label: "Wind (24 h)", unit: "km/h", sub: "Mean 10 m wind speed (km/h) over the previous 24 h", domain: [0, 60], ramp: RAMPS.orange },
    { key: "skiPen", label: "Ski pen", unit: "cm", sub: `Ski penetration (cm), ${sn}`, domain: [0, 40], ramp: RAMPS.depth },
  ] },
  { name: "PERSISTENT WEAK LAYERS", props: [
    { key: "critPwl", label: "Critical PWLs", unit: "", sub: `Number of critical persistent weak layers, ${sn}`, domain: [0, 3], ramp: RAMPS.navy, decimals: 1 },
    { key: "critPwlDist", label: "Critical PWL distribution", unit: "%", sub: "Share of aspects with a critical persistent weak layer (%)", domain: [0, 100], ramp: RAMPS.navy },
    { key: "critPwlDepth", label: "Critical PWL depth", unit: "cm", sub: "Depth (cm) of the shallowest critical persistent weak layer", domain: [0, 150], ramp: RAMPS.navy },
  ] },
  { name: "WET SNOW", props: [
    { key: "lwc", label: "Liquid water content", unit: "%", sub: `Maximum volumetric liquid water content (%), ${sn}`, domain: [0, 5], ramp: RAMPS.wet, decimals: 1 },
    { key: "lwm", label: "Liquid water mass", unit: "kg/m²", sub: `Liquid water in the snowpack (kg/m²), ${sn}`, domain: [0, 20], ramp: RAMPS.wet, decimals: 1 },
  ] },
  { name: "SNOW DEPTH", props: [
    { key: "hs", label: "Snow depth", unit: "cm", sub: `Snow depth (cm), ${sn}`, domain: [0, 300], ramp: RAMPS.depth },
  ] },
  { name: "ELEVATION", props: [
    { key: "elev", label: "Elevation", unit: "m", sub: "Mean cell elevation (m) used by the simulation", domain: [1200, 2800], ramp: RAMPS.gray },
  ] },
];

export const PROPS = GROUPS.flatMap((g) => g.props.map((p) => ({ ...p, group: g.name })));
export const PROP = Object.fromEntries(PROPS.map((p) => [p.key, p]));

// MapLibre interpolate expression for a property.
export function colorExpression(p) {
  const [a, b] = p.domain;
  const stops = [];
  p.ramp.forEach((c, i) => { stops.push(a + (b - a) * i / (p.ramp.length - 1), c); });
  return ["case", ["==", ["get", "v"], null], "rgba(0,0,0,0)",
    ["interpolate", ["linear"], ["get", "v"], ...stops]];
}

export function legendTicks(p) {
  const [a, b] = p.domain;
  const n = p.key === "hs" ? 10 : 5;
  const step = (b - a) / n;
  return Array.from({ length: n + 1 }, (_, i) => +(a + i * step).toFixed(p.decimals ? 1 : 0));
}

export function fmt(p, v) {
  if (v === null || v === undefined) return "–";
  return p.decimals ? v.toFixed(p.decimals) : String(Math.round(v));
}

// Grain-type legend (AVID's five groups), validated for colour-vision deficiency.
export const GRAIN_GROUPS = [
  { label: "PP/DF", color: "#D9AE00" },
  { label: "RG/FCxr", color: "#9F86D4" },
  { label: "SH/DH/FC", color: "#86198A" },
  { label: "MFcr", color: "#3F7F2A" },
  { label: "MF", color: "#8CC56A" },
];
export const CLASSES = ["PP", "DF", "RG", "FCxr", "FC", "DH", "SH", "MF", "MFcr"];
export const GROUP_OF = [0, 0, 1, 1, 2, 2, 2, 4, 3];
export const CLASS_NAMES = {
  PP: "Precipitation particles", DF: "Decomposing fragments", RG: "Rounded grains", FCxr: "Rounding facets",
  FC: "Faceted crystals", DH: "Depth hoar", SH: "Surface hoar", MF: "Melt forms (wet)", MFcr: "Melt-freeze crust",
};
export const HARD = ["F", "4F", "1F", "P", "K", "I"];
