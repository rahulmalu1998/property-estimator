"use strict";

const { areaKey } = require("./areas");
const {
  getDevelopmentDbPath,
  loadDevelopmentDoc,
  mergeDevelopmentDocs,
  writeDevelopmentDoc,
} = require("./development-store");

/**
 * Historic built-up / development curve features.
 * Stored in `data/development-series.db`.
 */
function loadDevelopmentSeries(dataDir) {
  return loadDevelopmentDoc(dataDir);
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

function writeDevelopmentSeries(dataDir, doc) {
  return writeDevelopmentDoc(dataDir, doc);
}

module.exports = {
  getDevelopmentSeriesDbPath: getDevelopmentDbPath,
  loadDevelopmentSeries,
  mergeDevelopmentSeries: mergeDevelopmentDocs,
  rowForArea,
  writeDevelopmentSeries,
  zScoresFromMetric,
};
