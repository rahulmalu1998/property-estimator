/**
 * Built-up / development trend — where to get 10–20+ years of open history
 * ========================================================================
 *
 * Google Earth’s desktop “historical imagery” is not an open API. For a *long,
 * free, analysis-grade archive* you typically use **Landsat** (NASA/USGS), not a
 * consumer map tile provider.
 *
 * Open stacks that cover ~20 years well
 * --------------------------------------
 * - **Landsat 5/7/8/9** — Public domain–style open data; 30 m; usable back to
 *   the 1980s–1990s depending on mission (for 2005→2025, Landsat is ideal).
 *   Access: [Google Earth Engine](https://code.earthengine.google.com/),
 *   [USGS EarthExplorer](https://earthexplorer.usgs.gov/),
 *   [Microsoft Planetary Computer](https://planetarycomputer.microsoft.com/) (STAC).
 * - **Sentinel-2** — Free (Copernicus); ~10–15 m; but archive only since **2015**,
 *   so it does **not** alone span 20 years.
 * - **ESA WorldCover / GHSL** — Annual or epoch land-cover products; great as
 *   labels or change summaries; check each product’s years.
 *
 * “Map provider” vs “imagery archive”
 * -----------------------------------
 * - **OpenStreetMap** is excellent for *current* vectors; it does **not** ship
 *   a global stack of dated satellite basemaps for the last 20 years.
 * - **OpenHistoricalMap** is for community *historical cartography* (often
 *   pre-satellite / scanned maps), not a substitute for Landsat time series.
 * - **NASA GIBS** ([Worldview](https://worldview.earthdata.nasa.gov/)) exposes
 *   **WMTS** layers (good for *viewing*); for *metrics* you still reduce rasters
 *   (GEE, PC, or local GeoTIFFs).
 *
 * Practical pipeline for this app
 * -------------------------------
 * 1. Build yearly composites (e.g. dry-season median NDVI/NDBI or built-up index)
 *    from **Landsat** inside buffers around each locality point.
 * 2. Compare endpoints (e.g. 2005 vs 2024) or fit a trend; normalize to
 *    `builtUpGrowth10y` in `data/development-series.json`.
 *
 * Automated extract (Node + service account) for all localities in
 * `data/bangalore-prices.json`: `npm run ee:extract` (or `--write`, or
 * `npm run ee:codeeditor` to print a Code Editor script).
 *
 * Below: Earth Engine skeleton (paste into https://code.earthengine.google.com/).
 * Same logic can be rebuilt with **pystac-client + stackstac** on Planetary
 * Computer if you prefer Python outside GEE.
 */

// Example skeleton (requires your assets and tuning):
//
// var points = ee.FeatureCollection([
//   ee.Feature(ee.Geometry.Point([77.606, 12.975]), {name: 'MG Road / CBD'}),
//   // ...
// ]);
//
// function yearlyBuiltUp(year) {
//   var start = ee.Date.fromYMD(year, 1, 1);
//   var end = start.advance(1, 'year');
//   // Prefer Landsat for pre-2015 years, e.g. L8/L9 after 2013, L7, L5 TM.
//   // Derive NDBI / built-up proxy or use GHSL/WorldCover where available.
//   return image;
// }
//
// var growth = points.map(function (f) {
//   var geom = f.geometry().buffer(2000);
//   var v0 = yearlyBuiltUp(2005).reduceRegion(ee.Reducer.mean(), geom, 30).get('built');
//   var v1 = yearlyBuiltUp(2024).reduceRegion(ee.Reducer.mean(), geom, 30).get('built');
//   return f.set('builtUpGrowth10y', ee.Number(v1).subtract(v0).max(0));
// });
//
// print(growth);
