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

function round4(value) {
  return Math.round(value * 1e4) / 1e4;
}

function median(values) {
  const valid = values
    .filter((value) => typeof value === "number" && Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!valid.length) return null;
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;
}

function mean(values) {
  const valid = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function historicPoints(devRow) {
  if (!devRow?.historicByYear || typeof devRow.historicByYear !== "object") return [];
  return Object.entries(devRow.historicByYear)
    .map(([year, value]) => {
      const numericYear = Number(year);
      const numericValue =
        typeof value === "number" ? value : value == null || value === "" ? null : Number(value);
      return Number.isFinite(numericYear) && Number.isFinite(numericValue)
        ? { year: numericYear, value: numericValue }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.year - b.year);
}

function inferGrowthFromDevelopment(devRow) {
  if (!devRow || typeof devRow !== "object") {
    return {
      observedGrowth10y: null,
      effectiveGrowth10y: null,
      growthSource: "missing",
      growthConfidence: 0,
      historyYears: 0,
    };
  }

  const points = historicPoints(devRow);
  const historyYears = points.length;
  const first = points[0] || null;
  const last = points[points.length - 1] || null;
  const spanYears = first && last ? Math.max(0, last.year - first.year) : 0;

  if (typeof devRow.builtUpGrowth10y === "number" && Number.isFinite(devRow.builtUpGrowth10y)) {
    return {
      observedGrowth10y: devRow.builtUpGrowth10y,
      effectiveGrowth10y: devRow.builtUpGrowth10y,
      growthSource: "observed_10y",
      growthConfidence: 1,
      historyYears,
    };
  }

  if (
    typeof devRow.ndbiTrendSlopePerYear === "number" &&
    Number.isFinite(devRow.ndbiTrendSlopePerYear) &&
    historyYears >= 2
  ) {
    return {
      observedGrowth10y: first && last ? round4(last.value - first.value) : null,
      effectiveGrowth10y: round4(devRow.ndbiTrendSlopePerYear * 10),
      growthSource: "trend_extrapolated",
      growthConfidence: Math.min(0.9, Math.max(0.35, spanYears / 10)),
      historyYears,
    };
  }

  if (historyYears >= 2 && spanYears > 0) {
    return {
      observedGrowth10y: round4(last.value - first.value),
      effectiveGrowth10y: round4(((last.value - first.value) / spanYears) * 10),
      growthSource: "partial_history_extrapolated",
      growthConfidence: Math.min(0.8, Math.max(0.3, spanYears / 10)),
      historyYears,
    };
  }

  return {
    observedGrowth10y: null,
    effectiveGrowth10y: null,
    growthSource: historyYears === 1 ? "single_year_only" : "missing",
    growthConfidence: historyYears === 1 ? 0.2 : 0,
    historyYears,
  };
}

function buildProxyGrowth(row, cityMedian, globalMedian, cityDefault, globalMeans) {
  const base =
    (typeof cityMedian === "number" && Number.isFinite(cityMedian) ? cityMedian : null) ??
    (typeof globalMedian === "number" && Number.isFinite(globalMedian) ? globalMedian : null) ??
    0;

  const rentBase =
    cityDefault.rentGrowth5yPct ?? globalMeans.rentGrowth5yPct ?? row.rentGrowth5yPct ?? 0;
  const demandBase =
    cityDefault.inventoryAbsorptionScore ??
    globalMeans.inventoryAbsorptionScore ??
    row.demandStrength ??
    0;
  const employmentBase =
    cityDefault.employmentNodeStrength ??
    globalMeans.employmentNodeStrength ??
    row.employmentStrength ??
    0;
  const riskBase = cityDefault.riskPenalty ?? globalMeans.riskPenalty ?? row.riskPenalty ?? 0;

  const rentAdj = ((row.rentGrowth5yPct ?? rentBase) - rentBase) * 0.001;
  const demandAdj = ((row.demandStrength ?? demandBase) - demandBase) * 0.0006;
  const employmentAdj = ((row.employmentStrength ?? employmentBase) - employmentBase) * 0.0008;
  const riskAdj = ((row.riskPenalty ?? riskBase) - riskBase) * -0.0005;
  const plannedAdj = row.planned ? 0.006 : 0;

  return round4(base + rentAdj + demandAdj + employmentAdj + riskAdj + plannedAdj);
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
  const rows = areas.map((area) => {
    const devRow = rowForArea(devDoc, area) || {};
    const metricRow = metricsRowForArea(metricsDoc, area);
    const growthSignal = inferGrowthFromDevelopment(devRow);

    return {
      key: areaKey(area),
      name: area.name,
      citySlug: area.citySlug,
      cityName: area.cityName,
      planned: Boolean(area.planned),
      planStage: area.planStage ?? null,
      growth10yObserved: growthSignal.observedGrowth10y,
      growth10yEffective: growthSignal.effectiveGrowth10y,
      growthSource: growthSignal.growthSource,
      growthConfidence: growthSignal.growthConfidence,
      historyYears: growthSignal.historyYears,
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

  const cityMedians = rows.reduce((acc, row) => {
    if (!acc[row.citySlug]) acc[row.citySlug] = [];
    if (typeof row.growth10yEffective === "number" && Number.isFinite(row.growth10yEffective)) {
      acc[row.citySlug].push(row.growth10yEffective);
    }
    return acc;
  }, {});

  const globalMeans = {
    rentGrowth5yPct: mean(rows.map((row) => row.rentGrowth5yPct)),
    inventoryAbsorptionScore: mean(rows.map((row) => row.demandStrength)),
    employmentNodeStrength: mean(rows.map((row) => row.employmentStrength)),
    riskPenalty: mean(rows.map((row) => row.riskPenalty)),
  };
  const globalMedian = median(
    rows.map((row) => row.growth10yEffective).filter((value) => typeof value === "number")
  );

  return rows.map((row) => {
    if (typeof row.growth10yEffective === "number" && Number.isFinite(row.growth10yEffective)) {
      return row;
    }

    const cityDefault = metricsDoc.cityDefaults?.[row.citySlug] || {};
    return {
      ...row,
      growth10yEffective: buildProxyGrowth(
        row,
        median(cityMedians[row.citySlug] || []),
        globalMedian,
        cityDefault,
        globalMeans
      ),
      growthSource: row.planned ? "city_proxy_planned" : "city_proxy",
      growthConfidence: row.planned ? 0.35 : 0.25,
    };
  });
}

function computeInvestmentScores(areas, devDoc, metricsDoc) {
  const weights = { ...DEFAULT_WEIGHTS, ...(metricsDoc.weights || {}) };
  const rows = buildInvestmentRows(areas, devDoc, metricsDoc);
  const growthZ = normalizeSeries(rows, "growth10yEffective", false);
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
        growth10y: Number(growthZ(row.growth10yEffective).toFixed(3)),
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
        growth10y: row.growth10yEffective,
        growth10yObserved: row.growth10yObserved,
        growth10yEffective: row.growth10yEffective,
        growthSource: row.growthSource,
        growthConfidence: row.growthConfidence,
        historyYears: row.historyYears,
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
