"use strict";

const fs = require("fs");
const path = require("path");
const { areaKey } = require("./areas");
const { rowForArea } = require("./development");

const DEFAULT_WEIGHTS = {
  growth10y: 0.3,
  rentalYield: 0.22,
  rentGrowth5y: 0.14,
  demandStrength: 0.16,
  employmentStrength: 0.12,
  riskPenalty: 0.06,
};

function loadInvestmentMetrics(dataDir) {
  const p = path.join(dataDir, "investment-metrics.json");
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return { cityDefaults: {}, areas: {}, weights: DEFAULT_WEIGHTS };
  }
}

function metricsRowForArea(doc, area) {
  const cityDefault = doc.cityDefaults?.[area.citySlug] || {};
  const areaOverride = doc.areas?.[areaKey(area)] || {};
  return { ...cityDefault, ...areaOverride };
}

function normalizeSeries(rows, field, invert) {
  const values = rows
    .map((row) => row[field])
    .filter((value) => typeof value === "number" && Number.isFinite(value));

  if (!values.length) {
    return () => 0;
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const std =
    values.length > 1
      ? Math.sqrt(
          values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
        )
      : 1;

  return (value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return 0;
    const z = std > 1e-9 ? (value - mean) / std : 0;
    return invert ? -z : z;
  };
}

function scaleScores(rows, field) {
  const values = rows
    .map((row) => row[field])
    .filter((value) => typeof value === "number" && Number.isFinite(value));

  if (!values.length) {
    return rows.map((row) => ({ ...row, score: null }));
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  return rows.map((row) => ({
    ...row,
    score:
      typeof row[field] === "number" && Number.isFinite(row[field])
        ? Math.round(((row[field] - min) / span) * 1000) / 10
        : null,
  }));
}

function buildInvestmentRows(areas, devDoc, metricsDoc) {
  return areas.map((area) => {
    const devRow = rowForArea(devDoc, area) || {};
    const metricRow = metricsRowForArea(metricsDoc, area);

    return {
      key: areaKey(area),
      name: area.name,
      citySlug: area.citySlug,
      cityName: area.cityName,
      growth10y:
        typeof devRow.builtUpGrowth10y === "number" ? devRow.builtUpGrowth10y : null,
      rentalYieldPct:
        typeof metricRow.rentalYieldPct === "number" ? metricRow.rentalYieldPct : null,
      rentGrowth5yPct:
        typeof metricRow.rentGrowth5yPct === "number" ? metricRow.rentGrowth5yPct : null,
      demandStrength:
        typeof metricRow.inventoryAbsorptionScore === "number"
          ? metricRow.inventoryAbsorptionScore
          : null,
      employmentStrength:
        typeof metricRow.employmentNodeStrength === "number"
          ? metricRow.employmentNodeStrength
          : null,
      riskPenalty:
        typeof metricRow.riskPenalty === "number" ? metricRow.riskPenalty : null,
    };
  });
}

function computeInvestmentScores(areas, devDoc, metricsDoc) {
  const weights = { ...DEFAULT_WEIGHTS, ...(metricsDoc.weights || {}) };
  const rows = buildInvestmentRows(areas, devDoc, metricsDoc);
  const growthZ = normalizeSeries(rows, "growth10y", false);
  const yieldZ = normalizeSeries(rows, "rentalYieldPct", false);
  const rentGrowthZ = normalizeSeries(rows, "rentGrowth5yPct", false);
  const demandZ = normalizeSeries(rows, "demandStrength", false);
  const employmentZ = normalizeSeries(rows, "employmentStrength", false);
  const riskZ = normalizeSeries(rows, "riskPenalty", true);

  const scored = rows.map((row) => {
    const rawScore =
      weights.growth10y * growthZ(row.growth10y) +
      weights.rentalYield * yieldZ(row.rentalYieldPct) +
      weights.rentGrowth5y * rentGrowthZ(row.rentGrowth5yPct) +
      weights.demandStrength * demandZ(row.demandStrength) +
      weights.employmentStrength * employmentZ(row.employmentStrength) +
      weights.riskPenalty * riskZ(row.riskPenalty);

    return {
      ...row,
      rawScore,
      componentZ: {
        growth10y: Number(growthZ(row.growth10y).toFixed(3)),
        rentalYield: Number(yieldZ(row.rentalYieldPct).toFixed(3)),
        rentGrowth5y: Number(rentGrowthZ(row.rentGrowth5yPct).toFixed(3)),
        demandStrength: Number(demandZ(row.demandStrength).toFixed(3)),
        employmentStrength: Number(employmentZ(row.employmentStrength).toFixed(3)),
        riskPenalty: Number(riskZ(row.riskPenalty).toFixed(3)),
      },
    };
  });

  const scaled = scaleScores(scored, "rawScore");
  const byKey = Object.create(null);

  for (const row of scaled) {
    byKey[row.key] = {
      score: row.score,
      rawScore: Number(row.rawScore.toFixed(4)),
      weights,
      metrics: {
        growth10y: row.growth10y,
        rentalYieldPct: row.rentalYieldPct,
        rentGrowth5yPct: row.rentGrowth5yPct,
        demandStrength: row.demandStrength,
        employmentStrength: row.employmentStrength,
        riskPenalty: row.riskPenalty,
      },
      componentZ: row.componentZ,
    };
  }

  return byKey;
}

module.exports = {
  DEFAULT_WEIGHTS,
  computeInvestmentScores,
  loadInvestmentMetrics,
  metricsRowForArea,
};
