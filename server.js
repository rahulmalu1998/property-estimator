const express = require("express");
const path = require("path");
const fs = require("fs");

const { ingestInfrastructureNews } = require("./lib/newsIngest");
const { loadDevelopmentSeries, zScoresFromMetric } = require("./lib/development");
const { estimatePrices } = require("./lib/model");

const app = express();
const PORT = process.env.PORT || 3000;

const dataDir = path.join(__dirname, "data");
const areasPath = path.join(dataDir, "bangalore-prices.json");

const NEWS_TTL_MS = Number(process.env.NEWS_TTL_MS || 15 * 60 * 1000);
const MODEL_NEWS_WEIGHT = Number(process.env.MODEL_NEWS_WEIGHT || 0.11);
const MODEL_DEV_WEIGHT = Number(process.env.MODEL_DEV_WEIGHT || 0.09);
const MODEL_MAX_LOG_MOVE = Number(process.env.MODEL_MAX_LOG_MOVE || 0.22);

let newsBundle = null;
let newsError = null;
let newsRefreshPromise = null;

function normalizeAreaRow(row) {
  const anchor = row.anchorPricePerSqft ?? row.pricePerSqft;
  if (typeof anchor !== "number" || !row.name) return null;
  return {
    name: row.name,
    lat: row.lat,
    lng: row.lng,
    anchorPricePerSqft: anchor,
  };
}

function loadAreas() {
  const raw = fs.readFileSync(areasPath, "utf8");
  const doc = JSON.parse(raw);
  const areas = (doc.areas || []).map(normalizeAreaRow).filter(Boolean);
  return { meta: doc, areas };
}

function newsStale() {
  if (!newsBundle?.fetchedAt) return true;
  const t = Date.parse(newsBundle.fetchedAt);
  return Number.isNaN(t) || Date.now() - t > NEWS_TTL_MS;
}

async function refreshNews(areas) {
  newsError = null;
  try {
    newsBundle = await ingestInfrastructureNews(areas);
  } catch (e) {
    newsError = e.message || String(e);
    console.warn("[news] refresh failed:", newsError);
  }
}

function ensureNews(areas) {
  if (!newsStale() && newsBundle) return Promise.resolve();
  if (newsRefreshPromise) return newsRefreshPromise;
  newsRefreshPromise = refreshNews(areas).finally(() => {
    newsRefreshPromise = null;
  });
  return newsRefreshPromise;
}

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/areas", async (_req, res) => {
  try {
    const { meta, areas } = loadAreas();
    if (!areas.length) {
      return res.status(500).json({ error: "No valid areas in data file" });
    }

    await ensureNews(areas);

    const devDoc = loadDevelopmentSeries(dataDir);
    const devZ = zScoresFromMetric(areas, devDoc, "builtUpGrowth10y");

    const infraZ = Object.create(null);
    for (const a of areas) {
      infraZ[a.name] = newsBundle?.zScores?.[a.name] ?? 0;
    }

    const estimated = estimatePrices(areas, infraZ, devZ, {
      news: MODEL_NEWS_WEIGHT,
      dev: MODEL_DEV_WEIGHT,
      maxLogMove: MODEL_MAX_LOG_MOVE,
    });

    const areasOut = estimated.map((a) => {
      const row = devDoc.areas?.[a.name];
      const development =
        row && typeof row === "object"
          ? {
              builtUpGrowth10y:
                typeof row.builtUpGrowth10y === "number" ? row.builtUpGrowth10y : null,
              linearForecastBuiltUp10y:
                typeof row.linearForecastBuiltUp10y === "number"
                  ? row.linearForecastBuiltUp10y
                  : null,
              ndbiTrendSlopePerYear:
                typeof row.ndbiTrendSlopePerYear === "number"
                  ? row.ndbiTrendSlopePerYear
                  : null,
              historicByYear:
                row.historicByYear && typeof row.historicByYear === "object"
                  ? row.historicByYear
                  : null,
            }
          : null;
      return { ...a, development };
    });

    res.type("json").json({
      city: meta.city,
      currency: meta.currency,
      unit: meta.unit,
      disclaimer: meta.disclaimer,
      areas: areasOut,
      signals: {
        newsSource: newsBundle?.source ?? null,
        newsFetchedAt: newsBundle?.fetchedAt ?? null,
        newsReady: Boolean(newsBundle),
        newsError,
        articleCount: newsBundle?.articleCount ?? 0,
        infraArticleCount: newsBundle?.infraArticleCount ?? 0,
        articlesSample: newsBundle?.articlesSample ?? [],
        developmentSource: devDoc.source ?? null,
        developmentMetric: devDoc.metric ?? null,
        developmentForecastMetric: devDoc.forecastMetric ?? null,
        developmentGeneratedAt: devDoc.generatedAt ?? null,
        developmentHistoricWindow: devDoc.historicWindow ?? null,
      },
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to build area estimates" });
  }
});

app.post("/api/refresh-news", express.json(), async (_req, res) => {
  try {
    const { areas } = loadAreas();
    await refreshNews(areas);
    res.json({
      ok: true,
      newsFetchedAt: newsBundle?.fetchedAt ?? null,
      infraArticleCount: newsBundle?.infraArticleCount ?? 0,
      error: newsError,
    });
  } catch {
    res.status(500).json({ error: "Refresh failed" });
  }
});

app.listen(PORT, () => {
  console.log(`property-estimator running at http://localhost:${PORT}`);
  try {
    const { areas } = loadAreas();
    refreshNews(areas).catch(() => {});
  } catch (e) {
    console.warn("[startup] could not prefetch news:", e.message);
  }
});
