"use strict";

const path = require("path");
const Database = require("better-sqlite3");

const DB_FILENAME = "development-series.db";

function getDevelopmentDbPath(dataDir) {
  return path.join(dataDir, DB_FILENAME);
}

function connectDevelopmentDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS development_metadata (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      source TEXT,
      metric TEXT,
      forecast_metric TEXT,
      metric_description TEXT,
      forecast_metric_description TEXT,
      start_year INTEGER,
      end_year INTEGER,
      buffer_meters INTEGER,
      generated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS development_areas (
      area_key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      city_slug TEXT,
      city_name TEXT,
      built_up_growth_10y REAL,
      linear_forecast_built_up_10y REAL,
      ndbi_trend_slope_per_year REAL,
      historic_by_year_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_development_areas_city_slug
      ON development_areas(city_slug);
  `);
  return db;
}

function openDevelopmentDb(dataDir) {
  return connectDevelopmentDb(getDevelopmentDbPath(dataDir));
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

function emptyDevelopmentDoc() {
  return {
    source: null,
    metric: null,
    forecastMetric: null,
    metricDescription: null,
    forecastMetricDescription: null,
    historicWindow: null,
    bufferMeters: null,
    generatedAt: null,
    areas: {},
  };
}

function writeDevelopmentDocToDb(db, doc) {
  const tx = db.transaction((developmentDoc) => {
    const historicWindow =
      developmentDoc.historicWindow && typeof developmentDoc.historicWindow === "object"
        ? developmentDoc.historicWindow
        : {};

    db.prepare(
      `
        INSERT INTO development_metadata (
          id,
          source,
          metric,
          forecast_metric,
          metric_description,
          forecast_metric_description,
          start_year,
          end_year,
          buffer_meters,
          generated_at
        )
        VALUES (
          1,
          @source,
          @metric,
          @forecastMetric,
          @metricDescription,
          @forecastMetricDescription,
          @startYear,
          @endYear,
          @bufferMeters,
          @generatedAt
        )
        ON CONFLICT(id) DO UPDATE SET
          source = excluded.source,
          metric = excluded.metric,
          forecast_metric = excluded.forecast_metric,
          metric_description = excluded.metric_description,
          forecast_metric_description = excluded.forecast_metric_description,
          start_year = excluded.start_year,
          end_year = excluded.end_year,
          buffer_meters = excluded.buffer_meters,
          generated_at = excluded.generated_at
      `
    ).run({
      source: developmentDoc.source ?? null,
      metric: developmentDoc.metric ?? null,
      forecastMetric: developmentDoc.forecastMetric ?? null,
      metricDescription: developmentDoc.metricDescription ?? null,
      forecastMetricDescription: developmentDoc.forecastMetricDescription ?? null,
      startYear: historicWindow.startYear ?? null,
      endYear: historicWindow.endYear ?? null,
      bufferMeters: developmentDoc.bufferMeters ?? null,
      generatedAt: developmentDoc.generatedAt ?? null,
    });

    db.prepare("DELETE FROM development_areas").run();

    const insertArea = db.prepare(
      `
        INSERT INTO development_areas (
          area_key,
          name,
          city_slug,
          city_name,
          built_up_growth_10y,
          linear_forecast_built_up_10y,
          ndbi_trend_slope_per_year,
          historic_by_year_json
        )
        VALUES (
          @areaKey,
          @name,
          @citySlug,
          @cityName,
          @builtUpGrowth10y,
          @linearForecastBuiltUp10y,
          @ndbiTrendSlopePerYear,
          @historicByYearJson
        )
      `
    );

    for (const [areaKey, row] of Object.entries(developmentDoc.areas || {})) {
      insertArea.run({
        areaKey,
        name: row?.name ?? areaKey,
        citySlug: row?.citySlug ?? null,
        cityName: row?.cityName ?? null,
        builtUpGrowth10y:
          typeof row?.builtUpGrowth10y === "number" ? row.builtUpGrowth10y : null,
        linearForecastBuiltUp10y:
          typeof row?.linearForecastBuiltUp10y === "number"
            ? row.linearForecastBuiltUp10y
            : null,
        ndbiTrendSlopePerYear:
          typeof row?.ndbiTrendSlopePerYear === "number"
            ? row.ndbiTrendSlopePerYear
            : null,
        historicByYearJson: JSON.stringify(coerceHistoricByYear(row?.historicByYear)),
      });
    }
  });

  tx(doc || emptyDevelopmentDoc());
}

function loadDevelopmentDoc(dataDir) {
  const db = openDevelopmentDb(dataDir);

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

    if (!meta && !areaRows.length) {
      return emptyDevelopmentDoc();
    }

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

function writeDevelopmentDoc(dataDir, doc) {
  const db = openDevelopmentDb(dataDir, { bootstrap: false });
  try {
    writeDevelopmentDocToDb(db, doc);
  } finally {
    db.close();
  }
  return getDevelopmentDbPath(dataDir);
}

function mergeDevelopmentDocs(baseDoc, incomingDoc) {
  const base = baseDoc || emptyDevelopmentDoc();
  const incoming = incomingDoc || emptyDevelopmentDoc();

  return {
    ...base,
    ...incoming,
    historicWindow: incoming.historicWindow ?? base.historicWindow ?? null,
    areas: {
      ...(base.areas || {}),
      ...(incoming.areas || {}),
    },
  };
}

module.exports = {
  bootstrapDevelopmentDb,
  getDevelopmentDbPath,
  loadDevelopmentDoc,
  mergeDevelopmentDocs,
  openDevelopmentDb,
  writeDevelopmentDoc,
};
