"use strict";

const fs = require("fs");
const path = require("path");
const { areaKey } = require("./areas");

/**
 * Historic built-up / development curve features.
 * Populate `data/development-series.json` from open archives (Landsat / Sentinel
 * via Earth Engine, Planetary Computer STAC, etc.): annual built-up or NDBI
 * inside a buffer around each locality — not from Google Earth’s UI API.
 */
function loadDevelopmentSeries(dataDir) {
  const p = path.join(dataDir, "development-series.json");
  try {
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw);
  } catch {
    return { areas: {} };
  }
}

function rowForArea(seriesDoc, area) {
  const table = seriesDoc.areas || {};
  return table[areaKey(area)] || table[area.name] || null;
}

function zScoresFromMetric(areas, seriesDoc, key) {
  const vals = [];
  for (const a of areas) {
    const row = rowForArea(seriesDoc, a);
    if (row && typeof row[key] === "number") vals.push(row[key]);
  }
  if (!vals.length) {
    const z = Object.create(null);
    for (const a of areas) z[areaKey(a)] = 0;
    return z;
  }
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const std =
    vals.length > 1
      ? Math.sqrt(
          vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (vals.length - 1)
        )
      : 1;
  const z = Object.create(null);
  for (const a of areas) {
    const row = rowForArea(seriesDoc, a);
    const v = row && typeof row[key] === "number" ? row[key] : mean;
    z[areaKey(a)] = std > 1e-9 ? (v - mean) / std : 0;
  }
  return z;
}

module.exports = { loadDevelopmentSeries, rowForArea, zScoresFromMetric };
