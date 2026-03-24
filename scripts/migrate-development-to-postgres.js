#!/usr/bin/env node
"use strict";

const path = require("path");
const Database = require("better-sqlite3");
const { writeDevelopmentSeries } = require("../lib/development");

function usage() {
  console.error(
    "Usage: node scripts/migrate-development-to-postgres.js [--sqlite /path/to/development-series.db]"
  );
}

function coerceHistoricByYear(historicByYear) {
  const out = {};
  if (!historicByYear || typeof historicByYear !== "object") {
    return out;
  }

  for (const [year, value] of Object.entries(historicByYear)) {
    const numeric =
      typeof value === "number"
        ? value
        : value == null || value === ""
          ? null
          : Number(value);
    out[String(year)] = Number.isFinite(numeric) ? numeric : null;
  }

  return out;
}

function loadSqliteDoc(sqlitePath) {
  const db = new Database(sqlitePath, { readonly: true });
  try {
    const meta = db.prepare("SELECT * FROM development_metadata WHERE id = 1").get();
    const areaRows = db
      .prepare(
        `
          SELECT
            area_key,
            name,
            city_slug,
            city_name,
            built_up_growth_10y,
            linear_forecast_built_up_10y,
            ndbi_trend_slope_per_year,
            historic_by_year_json
          FROM development_areas
          ORDER BY city_slug, name
        `
      )
      .all();

    const areas = {};
    for (const row of areaRows) {
      let historicByYear = {};
      try {
        historicByYear = coerceHistoricByYear(JSON.parse(row.historic_by_year_json));
      } catch {
        historicByYear = {};
      }

      areas[row.area_key] = {
        name: row.name,
        citySlug: row.city_slug,
        cityName: row.city_name,
        historicByYear,
        builtUpGrowth10y:
          typeof row.built_up_growth_10y === "number" ? row.built_up_growth_10y : null,
        linearForecastBuiltUp10y:
          typeof row.linear_forecast_built_up_10y === "number"
            ? row.linear_forecast_built_up_10y
            : null,
        ndbiTrendSlopePerYear:
          typeof row.ndbi_trend_slope_per_year === "number"
            ? row.ndbi_trend_slope_per_year
            : null,
      };
    }

    return {
      source: meta?.source ?? null,
      metric: meta?.metric ?? null,
      forecastMetric: meta?.forecast_metric ?? null,
      metricDescription: meta?.metric_description ?? null,
      forecastMetricDescription: meta?.forecast_metric_description ?? null,
      historicWindow:
        meta?.start_year != null || meta?.end_year != null
          ? { startYear: meta?.start_year ?? null, endYear: meta?.end_year ?? null }
          : null,
      bufferMeters: meta?.buffer_meters ?? null,
      generatedAt: meta?.generated_at ?? null,
      areas,
    };
  } finally {
    db.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const sqliteIndex = args.indexOf("--sqlite");
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }

  const sqlitePath =
    sqliteIndex >= 0 && args[sqliteIndex + 1]
      ? path.resolve(args[sqliteIndex + 1])
      : path.join(__dirname, "..", "data", "development-series.db");

  const doc = loadSqliteDoc(sqlitePath);
  const target = await writeDevelopmentSeries(path.join(__dirname, "..", "data"), doc);
  console.log(`Migrated ${Object.keys(doc.areas || {}).length} areas to ${target}.`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
