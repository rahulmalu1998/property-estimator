const express = require("express");
const path = require("path");
const fs = require("fs");

const { initializeEarthEngine } = require("./earth-engine/client");
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
let eeClientPromise = null;
const imageryLayerCache = new Map();

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
    planned: Boolean(row.planned),
    planStage: row.planStage ?? null,
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

function getEarthEngineClient() {
  if (!eeClientPromise) {
    eeClientPromise = initializeEarthEngine().catch((error) => {
      eeClientPromise = null;
      throw error;
    });
  }
  return eeClientPromise;
}

function imageryBoundsFromAreas(areas, padDeg = 0.18) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;

  for (const area of areas) {
    minLat = Math.min(minLat, area.lat);
    maxLat = Math.max(maxLat, area.lat);
    minLng = Math.min(minLng, area.lng);
    maxLng = Math.max(maxLng, area.lng);
  }

  return {
    west: minLng - padDeg,
    south: minLat - padDeg,
    east: maxLng + padDeg,
    north: maxLat + padDeg,
  };
}

function maskL8SrClouds(image) {
  const qa = image.select("QA_PIXEL");
  const clear = qa.bitwiseAnd(1 << 3).eq(0).and(qa.bitwiseAnd(1 << 4).eq(0));
  return image.updateMask(clear);
}

function trueColorFromL8L9Sr(image) {
  return image
    .select(["SR_B4", "SR_B3", "SR_B2"])
    .multiply(0.0000275)
    .add(-0.2)
    .clamp(0, 0.4);
}

function maskS2SrClouds(image, ee) {
  const cloudMask = ee.Image(image.get("cloud_mask"));
  const cloudProb = cloudMask.select("probability");
  const scl = image.select("SCL");
  const clear = cloudProb.lt(35)
    .and(scl.neq(3))
    .and(scl.neq(8))
    .and(scl.neq(9))
    .and(scl.neq(10))
    .and(scl.neq(11));
  return image.updateMask(clear);
}

function trueColorFromS2Sr(image) {
  return image
    .select(["B4", "B3", "B2"])
    .divide(10000)
    .clamp(0, 0.32)
    .resample("bilinear");
}

function annualSentinelComposite(ee, year, region) {
  const start = ee.Date.fromYMD(year, 1, 1);
  const end = start.advance(1, "year");
  const sr = ee
    .ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
    .filterDate(start, end)
    .filterBounds(region)
    .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 35));
  const clouds = ee
    .ImageCollection("COPERNICUS/S2_CLOUD_PROBABILITY")
    .filterDate(start, end)
    .filterBounds(region);
  const joined = ee.ImageCollection(
    ee.Join.saveFirst("cloud_mask").apply({
      primary: sr,
      secondary: clouds,
      condition: ee.Filter.equals({
        leftField: "system:index",
        rightField: "system:index",
      }),
    })
  );

  return joined
    .filter(ee.Filter.notNull(["cloud_mask"]))
    .map((image) => maskS2SrClouds(image, ee))
    .map(trueColorFromS2Sr)
    .median()
    .clip(region);
}

function annualImageryComposite(ee, year, bounds) {
  const start = ee.Date.fromYMD(year, 1, 1);
  const end = start.advance(1, "year");
  const region = ee.Geometry.Rectangle([bounds.west, bounds.south, bounds.east, bounds.north]);

  if (year >= 2017) {
    return annualSentinelComposite(ee, year, region);
  }

  const l8 = ee.ImageCollection("LANDSAT/LC08/C02/T1_L2");
  const l9 = ee.ImageCollection("LANDSAT/LC09/C02/T1_L2");

  return ee
    .ImageCollection(l8.merge(l9))
    .filterDate(start, end)
    .filterBounds(region)
    .map(maskL8SrClouds)
    .map(trueColorFromL8L9Sr)
    .median()
    .clip(region);
}

function getMapId(image, visParams) {
  return new Promise((resolve, reject) => {
    image.getMapId(visParams, (mapId, error) => {
      if (error) reject(new Error(error));
      else resolve(mapId);
    });
  });
}

app.use(express.static(path.join(__dirname, "public")));

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

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

    const devDoc = await loadDevelopmentSeries(dataDir);
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

app.get("/api/year-imagery", async (req, res) => {
  try {
    const { cities, areas } = loadCatalog();
    const selectedCitySlugs = parseSelectedCitySlugs(req.query.cities, cities);
    const selectedSet = new Set(selectedCitySlugs);
    const selectedAreas = areas.filter((area) => selectedSet.has(area.citySlug));
    if (!selectedAreas.length) {
      return res.status(404).json({ error: "No areas found for selected cities" });
    }

    const requestedYear = Number(req.query.year);
    if (!Number.isFinite(requestedYear) || requestedYear < 2015 || requestedYear > 2024) {
      return res.status(400).json({ error: "Year must be between 2015 and 2024" });
    }

    const cacheKey = selectedCitySlugs.slice().sort().join(",") + "::" + String(requestedYear);
    const cached = imageryLayerCache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const bounds = imageryBoundsFromAreas(selectedAreas);
    const ee = await getEarthEngineClient();
    const image = annualImageryComposite(ee, requestedYear, bounds);
    const mapId = await getMapId(image, {
      min: requestedYear >= 2017 ? 0.02 : 0.03,
      max: requestedYear >= 2017 ? 0.25 : 0.3,
      gamma: requestedYear >= 2017 ? 1.05 : 1.1,
    });

    const payload = {
      year: requestedYear,
      selectedCitySlugs,
      urlFormat: mapId.urlFormat,
      bounds,
      source:
        requestedYear >= 2017
          ? "Earth Engine annual Sentinel-2 SR harmonized composite"
          : "Earth Engine annual Landsat true-color composite",
    };
    imageryLayerCache.set(cacheKey, payload);
    res.json(payload);
  } catch (error) {
    res.status(503).json({
      error: "Year imagery unavailable",
      detail: error.message || String(error),
    });
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
