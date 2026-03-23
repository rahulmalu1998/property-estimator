const express = require("express");
const path = require("path");
const fs = require("fs");

const { ingestInfrastructureNews } = require("./lib/newsIngest");
const { loadDevelopmentSeries, rowForArea, zScoresFromMetric } = require("./lib/development");
const { computeInvestmentScores, loadInvestmentMetrics } = require("./lib/investment");
const { estimatePrices } = require("./lib/model");
const { areaKey } = require("./lib/areas");

const app = express();
const PORT = process.env.PORT || 3000;

const dataDir = path.join(__dirname, "data");
const catalogPath = path.join(dataDir, "city-catalog.json");

const NEWS_TTL_MS = Number(process.env.NEWS_TTL_MS || 15 * 60 * 1000);
const MODEL_NEWS_WEIGHT = Number(process.env.MODEL_NEWS_WEIGHT || 0.11);
const MODEL_DEV_WEIGHT = Number(process.env.MODEL_DEV_WEIGHT || 0.09);
const MODEL_MAX_LOG_MOVE = Number(process.env.MODEL_MAX_LOG_MOVE || 0.22);

let newsBundle = null;
let newsError = null;
let newsRefreshPromise = null;

function slugifyLabel(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeAreaRow(city, row) {
  const anchor = row.anchorPricePerSqft ?? row.pricePerSqft;
  if (typeof anchor !== "number" || !row.name) return null;
  return {
    key: `${city.slug}::${row.name}`,
    name: row.name,
    citySlug: city.slug,
    cityName: city.name,
    state: city.state ?? null,
    stateSlug: slugifyLabel(city.state),
    lat: row.lat,
    lng: row.lng,
    anchorPricePerSqft: anchor,
  };
}

function loadCatalog() {
  const raw = fs.readFileSync(catalogPath, "utf8");
  const doc = JSON.parse(raw);
  const cities = (doc.cities || [])
    .map((city) => {
      const areas = (city.areas || []).map((row) => normalizeAreaRow(city, row)).filter(Boolean);
      return {
        slug: city.slug,
        name: city.name,
        state: city.state ?? null,
        stateSlug: slugifyLabel(city.state),
        lat: city.lat,
        lng: city.lng,
        aliases: city.aliases || [],
        newsSearchTerms: city.newsSearchTerms || [],
        areaCount: areas.length,
        areas,
      };
    })
    .filter((city) => city.slug && city.name && city.areas.length);
  const areas = cities.flatMap((city) => city.areas);
  const states = Object.values(
    cities.reduce((acc, city) => {
      const key = city.stateSlug || "unknown";
      if (!acc[key]) {
        acc[key] = {
          slug: key,
          name: city.state || "Unknown",
          cityCount: 0,
          areaCount: 0,
          cities: [],
        };
      }
      acc[key].cityCount += 1;
      acc[key].areaCount += city.areaCount;
      acc[key].cities.push({
        slug: city.slug,
        name: city.name,
        areaCount: city.areaCount,
      });
      return acc;
    }, {})
  ).sort((a, b) => a.name.localeCompare(b.name));
  return { meta: doc, cities, states, areas };
}

function parseSelectedCitySlugs(rawValue, cities) {
  const requested = String(rawValue || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (!requested.length) return ["bengaluru"];
  if (requested.includes("all")) return cities.map((city) => city.slug);
  const known = new Set(cities.map((city) => city.slug));
  const filtered = requested.filter((slug) => known.has(slug));
  return filtered.length ? filtered : ["bengaluru"];
}

function newsStale() {
  if (!newsBundle?.fetchedAt) return true;
  const t = Date.parse(newsBundle.fetchedAt);
  return Number.isNaN(t) || Date.now() - t > NEWS_TTL_MS;
}

async function refreshNews(areas, cities) {
  newsError = null;
  try {
    newsBundle = await ingestInfrastructureNews(areas, cities);
  } catch (e) {
    newsError = e.message || String(e);
    console.warn("[news] refresh failed:", newsError);
  }
}

function ensureNews(areas, cities) {
  if (!newsStale() && newsBundle) return Promise.resolve();
  if (newsRefreshPromise) return newsRefreshPromise;
  newsRefreshPromise = refreshNews(areas, cities).finally(() => {
    newsRefreshPromise = null;
  });
  return newsRefreshPromise;
}

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/areas", async (req, res) => {
  try {
    const { meta, cities, states, areas } = loadCatalog();
    if (!areas.length) {
      return res.status(500).json({ error: "No valid areas in data file" });
    }

    await ensureNews(areas, cities);
    const selectedCitySlugs = parseSelectedCitySlugs(req.query.cities, cities);
    const selectedSet = new Set(selectedCitySlugs);
    const selectedAreas = areas.filter((area) => selectedSet.has(area.citySlug));

    if (!selectedAreas.length) {
      return res.status(404).json({ error: "No areas found for selected cities" });
    }

    const devDoc = loadDevelopmentSeries(dataDir);
    const investmentDoc = loadInvestmentMetrics(dataDir);
    const devZ = zScoresFromMetric(selectedAreas, devDoc, "builtUpGrowth10y");
    const investmentByKey = computeInvestmentScores(selectedAreas, devDoc, investmentDoc);

    const infraZ = Object.create(null);
    for (const a of selectedAreas) {
      infraZ[areaKey(a)] = newsBundle?.zScores?.[areaKey(a)] ?? 0;
    }

    const estimated = estimatePrices(selectedAreas, infraZ, devZ, {
      news: MODEL_NEWS_WEIGHT,
      dev: MODEL_DEV_WEIGHT,
      maxLogMove: MODEL_MAX_LOG_MOVE,
    });

    const areasOut = estimated.map((a) => {
      const row = rowForArea(devDoc, a);
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
      return {
        ...a,
        development,
        investment: investmentByKey[areaKey(a)] || null,
      };
    });

    res.type("json").json({
      city:
        selectedCitySlugs.length === 1
          ? cities.find((entry) => entry.slug === selectedCitySlugs[0])?.name || null
          : "Multi-city",
      selectedCitySlugs,
      states,
      cities: cities.map((city) => ({
        slug: city.slug,
        name: city.name,
        state: city.state,
        stateSlug: city.stateSlug,
        lat: city.lat,
        lng: city.lng,
        areaCount: city.areaCount,
      })),
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
        investmentGeneratedAt: investmentDoc.generatedAt ?? null,
        investmentWeights: investmentDoc.weights ?? null,
      },
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to build area estimates" });
  }
});

app.post("/api/refresh-news", express.json(), async (_req, res) => {
  try {
    const { areas, cities } = loadCatalog();
    await refreshNews(areas, cities);
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
    const { areas, cities } = loadCatalog();
    refreshNews(areas, cities).catch(() => {});
  } catch (e) {
    console.warn("[startup] could not prefetch news:", e.message);
  }
});
