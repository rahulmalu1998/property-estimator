"use strict";

const { Pool } = require("pg");

let poolPromise = null;
let schemaReadyPromise = null;

function getDatabaseUrl() {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || null;
}

function getDevelopmentStoreTarget() {
  return "postgres";
}

function getSslConfig() {
  const explicit = String(process.env.DATABASE_SSL || "").toLowerCase();
  if (explicit === "true") {
    return { rejectUnauthorized: false };
  }
  if (explicit === "false") {
    return false;
  }

  const url = getDatabaseUrl() || "";
  if (url.includes("sslmode=require")) {
    return { rejectUnauthorized: false };
  }

  return false;
}

function createPool() {
  const connectionString = getDatabaseUrl();
  if (!connectionString) {
    throw new Error(
      "Postgres connection string not configured. Set DATABASE_URL before starting the app."
    );
  }

  return new Pool({
    connectionString,
    ssl: getSslConfig(),
    max: Number(process.env.PGPOOL_MAX || 4),
  });
}

function getPool() {
  if (!poolPromise) {
    poolPromise = Promise.resolve().then(createPool);
  }
  return poolPromise;
}

async function ensureSchema(db) {
  if (!schemaReadyPromise) {
    schemaReadyPromise = db.query(`
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
        built_up_growth_10y DOUBLE PRECISION,
        linear_forecast_built_up_10y DOUBLE PRECISION,
        ndbi_trend_slope_per_year DOUBLE PRECISION,
        historic_by_year_json JSONB NOT NULL DEFAULT '{}'::jsonb
      );

      CREATE INDEX IF NOT EXISTS idx_development_areas_city_slug
        ON development_areas(city_slug);
    `);
  }

  await schemaReadyPromise;
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

async function loadDevelopmentDoc() {
  const pool = await getPool();
  await ensureSchema(pool);

  const metaResult = await pool.query("SELECT * FROM development_metadata WHERE id = 1");
  const areaResult = await pool.query(`
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
  `);

  const meta = metaResult.rows[0] || null;
  const areaRows = areaResult.rows || [];

  if (!meta && !areaRows.length) {
    return emptyDevelopmentDoc();
  }

  const areas = {};
  for (const row of areaRows) {
    areas[row.area_key] = {
      name: row.name,
      citySlug: row.city_slug,
      cityName: row.city_name,
      historicByYear: coerceHistoricByYear(row.historic_by_year_json),
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
}

async function writeDevelopmentDoc(doc) {
  const pool = await getPool();
  await ensureSchema(pool);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const developmentDoc = doc || emptyDevelopmentDoc();
    const historicWindow =
      developmentDoc.historicWindow && typeof developmentDoc.historicWindow === "object"
        ? developmentDoc.historicWindow
        : {};

    await client.query(
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
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (id) DO UPDATE SET
          source = EXCLUDED.source,
          metric = EXCLUDED.metric,
          forecast_metric = EXCLUDED.forecast_metric,
          metric_description = EXCLUDED.metric_description,
          forecast_metric_description = EXCLUDED.forecast_metric_description,
          start_year = EXCLUDED.start_year,
          end_year = EXCLUDED.end_year,
          buffer_meters = EXCLUDED.buffer_meters,
          generated_at = EXCLUDED.generated_at
      `,
      [
        1,
        developmentDoc.source ?? null,
        developmentDoc.metric ?? null,
        developmentDoc.forecastMetric ?? null,
        developmentDoc.metricDescription ?? null,
        developmentDoc.forecastMetricDescription ?? null,
        historicWindow.startYear ?? null,
        historicWindow.endYear ?? null,
        developmentDoc.bufferMeters ?? null,
        developmentDoc.generatedAt ?? null,
      ]
    );

    await client.query("DELETE FROM development_areas");

    for (const [areaKey, row] of Object.entries(developmentDoc.areas || {})) {
      await client.query(
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
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        `,
        [
          areaKey,
          row?.name ?? areaKey,
          row?.citySlug ?? null,
          row?.cityName ?? null,
          typeof row?.builtUpGrowth10y === "number" ? row.builtUpGrowth10y : null,
          typeof row?.linearForecastBuiltUp10y === "number"
            ? row.linearForecastBuiltUp10y
            : null,
          typeof row?.ndbiTrendSlopePerYear === "number" ? row.ndbiTrendSlopePerYear : null,
          JSON.stringify(coerceHistoricByYear(row?.historicByYear)),
        ]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return getDevelopmentStoreTarget();
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
  getDevelopmentStoreTarget,
  loadDevelopmentDoc,
  mergeDevelopmentDocs,
  writeDevelopmentDoc,
};
