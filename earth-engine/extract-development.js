#!/usr/bin/env node
/**
 * One-shot Earth Engine extract: annual median NDBI (Landsat 8/9) per locality,
 * historic yearly values, builtUpGrowth10y (end − start), and linearForecastBuiltUp10y
 * (OLS slope × 10 years).
 *
 * Usage:
 *   node earth-engine/extract-development.js --write
 *   node earth-engine/extract-development.js --cities bengaluru,mumbai --write
 *   node earth-engine/extract-development.js --areas /path/to/city-catalog.json --write
 *   node earth-engine/extract-development.js --print-codeeditor  # paste into Code Editor
 *
 * Default behavior:
 *   - Uses data/city-catalog.json
 *   - Extracts all configured cities when --cities is omitted
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { initializeEarthEngine } = require('./client');
const { areaKey } = require('../lib/areas');
const {
  loadDevelopmentSeries,
  mergeDevelopmentSeries,
  writeDevelopmentSeries,
} = require('../lib/development');

const BUFFER_M = 2000;
const START_YEAR = 2015;
const END_YEAR = 2024;
const PAD_DEG = 0.12;

function loadAreasFromPricesJson(absolutePath) {
  const doc = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  return (doc.areas || [])
    .filter((a) => a.name && typeof a.lat === 'number' && typeof a.lng === 'number')
    .map((a) => ({ name: a.name, lat: a.lat, lng: a.lng }));
}

function loadAreasFromCatalog(absolutePath, citySlugs) {
  const doc = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  const selected = new Set((citySlugs || []).filter(Boolean));
  const areas = [];

  for (const city of doc.cities || []) {
    if (selected.size && !selected.has(city.slug)) continue;
    for (const area of city.areas || []) {
      if (
        area.name &&
        typeof area.lat === 'number' &&
        typeof area.lng === 'number'
      ) {
        areas.push({
          name: area.name,
          citySlug: city.slug,
          cityName: city.name,
          lat: area.lat,
          lng: area.lng,
        });
      }
    }
  }

  return areas;
}

function padRegionFromAreas(areas) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const a of areas) {
    minLat = Math.min(minLat, a.lat);
    maxLat = Math.max(maxLat, a.lat);
    minLng = Math.min(minLng, a.lng);
    maxLng = Math.max(maxLng, a.lng);
  }
  return [minLng - PAD_DEG, minLat - PAD_DEG, maxLng + PAD_DEG, maxLat + PAD_DEG];
}

function maskL8SrClouds(image) {
  const qa = image.select('QA_PIXEL');
  const clear = qa.bitwiseAnd(1 << 3).eq(0).and(qa.bitwiseAnd(1 << 4).eq(0));
  return image.updateMask(clear);
}

function ndbiFromL8L9Sr(image) {
  const sr = image.select('SR_B.').multiply(0.0000275).add(-0.2);
  const nir = sr.select('SR_B5');
  const swir = sr.select('SR_B6');
  return swir.subtract(nir).divide(swir.add(nir)).rename('ndbi');
}

function yearlyMedianNdbi(ee, year, regionGeom) {
  const y = ee.Number(year);
  const start = ee.Date.fromYMD(y, 1, 1);
  const end = start.advance(1, 'year');
  const l8 = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2');
  const l9 = ee.ImageCollection('LANDSAT/LC09/C02/T1_L2');
  const col = ee.ImageCollection(l8.merge(l9))
    .filterDate(start, end)
    .filterBounds(regionGeom)
    .map(maskL8SrClouds)
    .map(ndbiFromL8L9Sr);
  return col.select('ndbi').median();
}

function stackAnnualNdbi(ee, regionGeom, startYear, endYear) {
  let img = yearlyMedianNdbi(ee, startYear, regionGeom).rename(`Y${startYear}`);
  for (let y = startYear + 1; y <= endYear; y++) {
    img = img.addBands(yearlyMedianNdbi(ee, y, regionGeom).rename(`Y${y}`));
  }
  return img;
}

function featureCollectionFromAreas(ee, areas) {
  const feats = areas.map((a) =>
    ee.Feature(ee.Geometry.Point([a.lng, a.lat]).buffer(BUFFER_M), {
      name: a.name,
      areaKey: areaKey(a),
      citySlug: a.citySlug || null,
      cityName: a.cityName || null,
    })
  );
  return ee.FeatureCollection(feats);
}

function linearRegression(xs, ys) {
  const n = xs.length;
  if (n < 2) return { slope: 0, intercept: ys[0] ?? 0 };
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  if (den < 1e-15) return { slope: 0, intercept: my };
  const slope = num / den;
  const intercept = my - slope * mx;
  return { slope, intercept };
}

function round4(x) {
  return Math.round(x * 1e4) / 1e4;
}

function summarizeProperties(props, startYear, endYear) {
  const historicByYear = {};
  const xs = [];
  const ys = [];
  for (let y = startYear; y <= endYear; y++) {
    const key = `Y${y}`;
    const raw = props[key];
    const v =
      raw == null || raw === 'null'
        ? null
        : typeof raw === 'number'
          ? raw
          : Number(raw);
    const ok = v != null && Number.isFinite(v);
    historicByYear[String(y)] = ok ? round4(v) : null;
    if (ok) {
      xs.push(y);
      ys.push(v);
    }
  }
  const first = historicByYear[String(startYear)];
  const last = historicByYear[String(endYear)];
  const builtUpGrowth10y =
    first != null && last != null ? round4(last - first) : null;

  let ndbiTrendSlopePerYear = null;
  let linearForecastBuiltUp10y = null;
  if (xs.length >= 2) {
    const { slope } = linearRegression(xs, ys);
    ndbiTrendSlopePerYear = round4(slope);
    linearForecastBuiltUp10y = round4(slope * 10);
  }

  return {
    historicByYear,
    builtUpGrowth10y,
    linearForecastBuiltUp10y,
    ndbiTrendSlopePerYear,
  };
}

function getFeatureCollectionInfo(fc) {
  return new Promise((resolve, reject) => {
    fc.getInfo((info, err) => {
      if (err) reject(new Error(err));
      else resolve(info);
    });
  });
}

async function extractDevelopmentDoc(ee, areas) {
  const rect = padRegionFromAreas(areas);
  const regionGeom = ee.Geometry.Rectangle(rect);
  const stacked = stackAnnualNdbi(ee, regionGeom, START_YEAR, END_YEAR);
  const fc = featureCollectionFromAreas(ee, areas);
  const reduced = stacked.reduceRegions({
    collection: fc,
    reducer: ee.Reducer.mean(),
    scale: 30,
    maxPixelsPerRegion: 1e9,
    tileScale: 4,
  });

  const info = await getFeatureCollectionInfo(reduced);
  const areasOut = {};
  if (!info.features || !info.features.length) {
    throw new Error('Earth Engine returned no features');
  }
  for (const f of info.features) {
    const props = f.properties || {};
    const key = props.areaKey || props.name;
    if (!key) continue;
    areasOut[key] = {
      name: props.name || null,
      citySlug: props.citySlug || null,
      cityName: props.cityName || null,
      ...summarizeProperties(props, START_YEAR, END_YEAR),
    };
  }

  return {
    source:
      'Google Earth Engine: Landsat 8/9 Collection 2 SR (T1_L2), annual median NDBI, ' +
      `cloud-masked (QA_PIXEL); ${BUFFER_M}m buffer around locality centroid.`,
    metric: 'builtUpGrowth10y',
    forecastMetric: 'linearForecastBuiltUp10y',
    metricDescription:
      `Mean NDBI change from ${START_YEAR} to ${END_YEAR} in the buffer (built-up proxy; dimensionless delta).`,
    forecastMetricDescription:
      `OLS slope of mean NDBI vs year (${START_YEAR}–${END_YEAR}) multiplied by 10 — projected index change ` +
      'over the next decade; not a satellite observation of the future.',
    historicWindow: { startYear: START_YEAR, endYear: END_YEAR },
    bufferMeters: BUFFER_M,
    generatedAt: new Date().toISOString(),
    areas: areasOut,
  };
}

function printCodeEditorScript(areas) {
  const fcInner = areas
    .map(
      (a) =>
        `  ee.Feature(ee.Geometry.Point([${a.lng}, ${a.lat}]).buffer(${BUFFER_M}), {name: ${JSON.stringify(
          a.name
        )}})`
    )
    .join(',\n');

  const body = `// Paste into https://code.earthengine.google.com/
// Generated for ${areas.length} localities; re-run: node earth-engine/extract-development.js --print-codeeditor

var START_YEAR = ${START_YEAR};
var END_YEAR = ${END_YEAR};
var BUFFER_M = ${BUFFER_M};
var PAD_DEG = ${PAD_DEG};

function padRegionFromFeatures(fc) {
  var rects = fc.geometry().bounds();
  return rects.buffer(PAD_DEG * 111000);
}

function maskL8SrClouds(image) {
  var qa = image.select('QA_PIXEL');
  var clear = qa.bitwiseAnd(1 << 3).eq(0).and(qa.bitwiseAnd(1 << 4).eq(0));
  return image.updateMask(clear);
}

function ndbiFromL8L9Sr(image) {
  var sr = image.select('SR_B.').multiply(0.0000275).add(-0.2);
  var nir = sr.select('SR_B5');
  var swir = sr.select('SR_B6');
  return swir.subtract(nir).divide(swir.add(nir)).rename('ndbi');
}

function yearlyMedianNdbi(year, regionGeom) {
  var y = ee.Number(year);
  var start = ee.Date.fromYMD(y, 1, 1);
  var end = start.advance(1, 'year');
  var l8 = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2');
  var l9 = ee.ImageCollection('LANDSAT/LC09/C02/T1_L2');
  var col = ee.ImageCollection(l8.merge(l9))
    .filterDate(start, end)
    .filterBounds(regionGeom)
    .map(maskL8SrClouds)
    .map(ndbiFromL8L9Sr);
  return col.select('ndbi').median();
}

function stackAnnualNdbi(regionGeom, startYear, endYear) {
  var img = yearlyMedianNdbi(startYear, regionGeom).rename('Y' + startYear);
  for (var y = startYear + 1; y <= endYear; y++) {
    img = img.addBands(yearlyMedianNdbi(y, regionGeom).rename('Y' + y));
  }
  return img;
}

var fc = ee.FeatureCollection([
${fcInner}
]);

var regionGeom = padRegionFromFeatures(fc);
var stacked = stackAnnualNdbi(regionGeom, START_YEAR, END_YEAR);
var reduced = stacked.reduceRegions({
  collection: fc,
  reducer: ee.Reducer.mean(),
  scale: 30,
  maxPixelsPerRegion: 1e9,
  tileScale: 4,
});

print('FeatureCollection with per-year NDBI means:', reduced);

// Optional: copy JSON from console after evaluate
reduced.evaluate(function (result, err) {
  if (err) {
    print('Error', err);
  } else {
    print(JSON.stringify(result));
  }
});
`;
  process.stdout.write(body);
}

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');

  let areasPath = path.join(__dirname, '..', 'data', 'city-catalog.json');
  const ai = args.indexOf('--areas');
  if (ai >= 0 && args[ai + 1] && !args[ai + 1].startsWith('--')) {
    areasPath = path.resolve(args[ai + 1]);
  }

  const ci = args.indexOf('--cities');
  const citySlugs =
    ci >= 0 && args[ci + 1] && !args[ci + 1].startsWith('--')
      ? args[ci + 1].split(',').map((value) => value.trim()).filter(Boolean)
      : [];

  let areas = [];
  if (path.basename(areasPath) === 'city-catalog.json') {
    areas = loadAreasFromCatalog(areasPath, citySlugs);
  } else {
    areas = loadAreasFromPricesJson(areasPath);
  }
  if (!areas.length) {
    console.error('No areas with lat/lng in', areasPath);
    process.exit(1);
  }

  if (args.includes('--print-codeeditor')) {
    printCodeEditorScript(areas);
    return;
  }

  console.error(
    `[ee:extract] ${areas.length} areas, NDBI ${START_YEAR}–${END_YEAR}, buffer=${BUFFER_M}m`
  );
  const eeMod = await initializeEarthEngine();
  const doc = await extractDevelopmentDoc(eeMod, areas);
  const json = JSON.stringify(doc, null, 2);

  if (write) {
    const dataDir = path.join(__dirname, '..', 'data');
    const existingDoc = loadDevelopmentSeries(dataDir);
    const outPath = writeDevelopmentSeries(
      dataDir,
      mergeDevelopmentSeries(existingDoc, doc)
    );
    console.error('[ee:extract] wrote', outPath);
  } else {
    console.log(json);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

module.exports = {
  BUFFER_M,
  START_YEAR,
  END_YEAR,
  extractDevelopmentDoc,
  loadAreasFromCatalog,
  loadAreasFromPricesJson,
  summarizeProperties,
};
