"use strict";

const { areaKey } = require("./areas");

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Log-linear adjustment on top of calibrated anchors:
 * log(P) ≈ log(anchor) + wN*z_news + wD*z_dev
 *
 * z_* are cross-sectional z-scores per refresh (news) or static file (dev).
 */
function estimatePrices(areas, infraZByArea, devZByArea, weights) {
  const wN = weights.news;
  const wD = weights.dev;
  const maxLogMove = weights.maxLogMove;

  return areas.map((area) => {
    const anchor = area.anchorPricePerSqft;
    const key = areaKey(area);
    const zn = infraZByArea[key] ?? 0;
    const zdRaw = devZByArea[key] ?? 0;
    const zd = Math.max(0, zdRaw);
    const logAdj = clamp(wN * zn + wD * zd, -maxLogMove, maxLogMove);
    const pricePerSqft = Math.round(anchor * Math.exp(logAdj));

    return {
      key,
      name: area.name,
      citySlug: area.citySlug,
      cityName: area.cityName,
      lat: area.lat,
      lng: area.lng,
      pricePerSqft,
      model: {
        anchorPricePerSqft: anchor,
        logAdjustment: Number(logAdj.toFixed(4)),
        infraZ: Number(zn.toFixed(3)),
        devZRaw: Number(zdRaw.toFixed(3)),
        devZ: Number(zd.toFixed(3)),
        weights: { news: wN, dev: wD },
      },
    };
  });
}

module.exports = { estimatePrices };
