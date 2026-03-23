"use strict";

const { parseRssItems } = require("./rss");
const { normalizeForMatch } = require("./text");
const { areaKey } = require("./areas");

/** Strong infrastructure / project signals (public or large private) */
const INFRA_STRONG = [
  /\bmetro\b/i,
  /\bbmrc\b|\bbmrcl\b/i,
  /\bnhai\b/i,
  /\bperipheral\b.*\bring\b/i,
  /\bring\s+road\b/i,
  /\bexpressway\b/i,
  /\bflyover\b|\bfly\s*over\b/i,
  /\belevated\b.*\b(corridor|road)\b/i,
  /\bsuburban\s+rail\b/i,
  /\bhigh[-\s]?speed\s+rail\b/i,
  /\bterminal\s+2\b|\bt2\b.*\bairport\b/i,
  /\bbechtel\b|\blarsen\b|\bl&t\b.*\binfra\b/i,
];

/** Weaker but still on-topic */
const INFRA_WEAK = [
  /\bairport\b/i,
  /\binfrastructure\b/i,
  /\bit\s+park\b|\btech\s+park\b|\bsez\b/i,
  /\bphase\s*[ivx\d]/i,
  /\bextension\b.*\b(line|corridor|phase)\b/i,
  /\btender\b|\bcontract\s+awarded\b|\bgroundbreaking\b|\binaugurat/i,
  /\bunderpass\b|\boverbridge\b/i,
  /\bnh\s*\d{1,3}\b/i,
  /\bwidening\b.*\broad\b/i,
];

/** Drop obvious non-signal / boilerplate churn */
const NOISE = [
  /\btraffic\s+jam\b|\bwaterlogging\b|\baccident\b.*\b(death|injured)\b/i,
  /\bweather\b|\brain\s+alert\b/i,
  /\bipl\b|\bbollywood\b|\bmatch\b.*\bstadium\b/i,
  /\bstock\b|\bsensex\b|\bnifty\b/i,
];

function infraScoreText(text) {
  let s = 0;
  for (const re of INFRA_STRONG) if (re.test(text)) s += 2.5;
  for (const re of INFRA_WEAK) if (re.test(text)) s += 1;
  return s;
}

function isNoise(text) {
  return NOISE.some((re) => re.test(text));
}

function cityPatternToken(token) {
  return token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cityConfigsFromAreas(areas, citiesMeta) {
  const slugs = new Set(areas.map((area) => area.citySlug));
  return (citiesMeta || [])
    .filter((city) => slugs.has(city.slug))
    .map((city) => {
      const aliases = [city.name, ...(city.aliases || []), ...(city.newsSearchTerms || [])]
        .map((token) => token.trim())
        .filter(Boolean);
      const patterns = aliases.map((token) => new RegExp(`\\b${cityPatternToken(token.toLowerCase())}\\b`, "i"));
      return {
        slug: city.slug,
        aliases,
        patterns,
      };
    });
}

function areaMatchPatterns(areaName) {
  const raw = areaName.toLowerCase();
  const chunks = raw
    .split(/[/,()]/)
    .map((s) => s.replace(/\s+outer\s*$/i, "").trim())
    .filter(Boolean);
  const out = new Set();
  for (const c of chunks) {
    if (c.length >= 3) out.add(c);
  }
  out.add(raw);
  return [...out];
}

function articleMentionsArea(text, area) {
  const t = normalizeForMatch(text);
  for (const p of areaMatchPatterns(area.name)) {
    if (p.length < 4 && !/\b(ulsoor|hsr)\b/i.test(p)) continue;
    if (t.includes(p)) return true;
  }
  return false;
}

function recencyWeight(pubDateStr) {
  if (!pubDateStr) return 0.7;
  const t = Date.parse(pubDateStr);
  if (Number.isNaN(t)) return 0.7;
  const days = (Date.now() - t) / (86400 * 1000);
  if (days <= 14) return 1.15;
  if (days <= 45) return 1;
  if (days <= 180) return 0.85;
  return 0.65;
}

function filterArticle(item, cityConfigs) {
  const blob = `${item.title}\n${item.description}`;
  const text = normalizeForMatch(blob);
  if (!text.length) return null;
  if (isNoise(text)) return null;
  const infra = infraScoreText(text);
  if (infra < 2) return null;
  const matchingCities = cityConfigs
    .filter((config) => config.patterns.some((re) => re.test(text)))
    .map((config) => config.slug);
  if (!matchingCities.length) return null;
  return {
    title: item.title,
    link: item.link,
    pubDate: item.pubDate,
    infraScore: infra,
    recencyWeight: recencyWeight(item.pubDate),
    matchingCities,
  };
}

async function fetchGoogleNewsRss(cityConfigs) {
  const cityTokens = cityConfigs.flatMap((config) => config.aliases.slice(0, 2));
  const q = encodeURIComponent(
    `(${cityTokens.join(" OR ")}) AND (metro OR infrastructure OR NHAI OR flyover OR expressway OR airport OR "IT park" OR "suburban rail" OR corridor OR ring road)`
  );
  const url = `https://news.google.com/rss/search?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "property-estimator/1.0 (+https://localhost; research; contact: local)",
    },
  });
  if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
  const xml = await res.text();
  return parseRssItems(xml);
}

async function fetchNewsApi(cityConfigs) {
  const key = process.env.NEWS_API_KEY;
  if (!key) return [];
  const cityTokens = cityConfigs.flatMap((config) => config.aliases.slice(0, 2));
  const q = encodeURIComponent(
    `(${cityTokens.map((token) => `"${token}"`).join(" OR ")}) AND (metro OR infrastructure OR NHAI OR flyover OR expressway OR airport OR "IT park" OR "suburban rail" OR corridor OR "ring road")`
  );
  const url = `https://newsapi.org/v2/everything?q=${q}&language=en&sortBy=publishedAt&pageSize=40&apiKey=${key}`;
  const res = await fetch(url);
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`NewsAPI ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const articles = data.articles || [];
  return articles.map((a) => ({
    title: a.title || "",
    description: a.description || "",
    link: a.url || "",
    pubDate: a.publishedAt || "",
  }));
}

function articleWeight(art) {
  return art.recencyWeight * Math.min(2.5, art.infraScore / 2);
}

function scoreAreasFromArticles(areas, filtered) {
  const scores = Object.create(null);
  for (const a of areas) scores[areaKey(a)] = 0;

  for (const art of filtered) {
    const blob = `${art.title}\n${art.description || ""}`;
    const w = articleWeight(art);
    for (const area of areas) {
      if (art.matchingCities.includes(area.citySlug) && articleMentionsArea(blob, area)) {
        scores[areaKey(area)] += w;
      }
    }
  }

  const vals = Object.values(scores).filter((v) => v > 0);
  const z = Object.create(null);

  if (!vals.length) {
    for (const area of areas) z[areaKey(area)] = 0;
    return { raw: scores, z };
  }

  // Single mentioned locality: (v - mean) / std would be 0 with old formula.
  if (vals.length === 1) {
    for (const area of areas) {
      z[areaKey(area)] = scores[areaKey(area)] > 0 ? 1 : 0;
    }
    return { raw: scores, z };
  }

  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const std =
    vals.length > 1
      ? Math.sqrt(
          vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (vals.length - 1)
        )
      : 1;

  if (std <= 1e-6) {
    for (const area of areas) {
      z[areaKey(area)] = scores[areaKey(area)] > 0 ? 1 : 0;
    }
    return { raw: scores, z };
  }

  for (const area of areas) {
    const v = scores[areaKey(area)];
    if (v <= 0) z[areaKey(area)] = 0;
    else z[areaKey(area)] = (v - mean) / std;
  }

  return { raw: scores, z };
}

async function ingestInfrastructureNews(areas, citiesMeta) {
  const cityConfigs = cityConfigsFromAreas(areas, citiesMeta);
  if (!cityConfigs.length) {
    return {
      source: "none",
      fetchedAt: new Date().toISOString(),
      articleCount: 0,
      infraArticleCount: 0,
      articlesSample: [],
      scores: {},
      zScores: {},
    };
  }

  let items = [];
  let source = "google-news-rss";

  try {
    const apiItems = await fetchNewsApi(cityConfigs);
    if (apiItems.length) {
      items = apiItems;
      source = "newsapi.org";
    }
  } catch (e) {
    console.warn("[news] NewsAPI:", e.message);
  }

  if (!items.length) {
    items = await fetchGoogleNewsRss(cityConfigs);
  }

  const filtered = [];
  for (const it of items) {
    const f = filterArticle(it, cityConfigs);
    if (f) filtered.push({ ...f, description: it.description });
  }

  const { raw, z } = scoreAreasFromArticles(areas, filtered);

  return {
    source,
    fetchedAt: new Date().toISOString(),
    articleCount: items.length,
    infraArticleCount: filtered.length,
    articlesSample: filtered.slice(0, 12).map((a) => ({
      title: a.title,
      link: a.link,
      pubDate: a.pubDate,
    })),
    scores: raw,
    zScores: z,
  };
}

module.exports = {
  ingestInfrastructureNews,
  filterArticle,
  scoreAreasFromArticles,
};
