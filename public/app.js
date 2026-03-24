(function () {
  const YEARS = Array.from({ length: 10 }, (_, index) => 2015 + index);
  const PLAY_INTERVAL_MS = 1200;
  const MIN_TIMELINE_IMAGERY_ZOOM = 12;

  const state = {
    cities: [],
    allAreas: [],
    areas: [],
    selectedCitySlugs: [],
    basemapMode: "street",
    rankingSort: "overallScore",
    activeYear: YEARS[YEARS.length - 1],
    selectedAreaName: null,
    heatLayer: null,
    imageryLayer: null,
    imageryCache: new Map(),
    imageryLayerCache: new Map(),
    imageryPending: new Map(),
    imageryRequestId: 0,
    imagerySyncId: 0,
    imageryScopeLoading: false,
    imageryScopeLoadKey: "",
    imageryViewportLoading: false,
    imageryViewportLoadKey: "",
    imageryViewportReady: new Set(),
    imageryViewportPending: new Map(),
    timelinePlaybackEnabled: true,
    viewportChangeTimer: null,
    yearSurfaceGroup: null,
    markersByName: new Map(),
    yearSurfacesByName: new Map(),
    group: null,
    playbackTimer: null,
    playbackRunId: 0,
  };

  const els = {
    legend: document.getElementById("legend"),
    signalsLine: document.getElementById("signals-line"),
    topStats: document.getElementById("top-stats"),
    yearSlider: document.getElementById("year-slider"),
    yearPill: document.getElementById("year-pill"),
    mapModeSummary: document.getElementById("map-mode-summary"),
    mapTimelineBadge: document.getElementById("map-timeline-badge"),
    mapTimelineState: document.getElementById("map-timeline-state"),
    mapTimelineNote: document.getElementById("map-timeline-note"),
    mapTimelineProgress: document.getElementById("map-timeline-progress"),
    loadTimeline: document.getElementById("load-timeline"),
    playToggle: document.getElementById("play-toggle"),
    basemapStreet: document.getElementById("basemap-street"),
    basemapSatellite: document.getElementById("basemap-satellite"),
    cityFilters: document.getElementById("city-filters"),
    scopeSummary: document.getElementById("scope-summary"),
    selectedName: document.getElementById("selected-name"),
    selectedRank: document.getElementById("selected-rank"),
    selectedPrice: document.getElementById("selected-price"),
    selectedBadges: document.getElementById("selected-badges"),
    selectedStats: document.getElementById("selected-stats"),
    trendChart: document.getElementById("trend-chart"),
    rankingList: document.getElementById("ranking-list"),
    rankingSort: document.getElementById("ranking-sort"),
  };

  const map = L.map("map", {
    scrollWheelZoom: true,
    fadeAnimation: false,
  }).setView([12.97, 77.59], 11);

  const streetLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
    keepBuffer: 6,
  }).addTo(map);

  const satelliteLayer = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      attribution: "Tiles &copy; Esri",
      maxZoom: 19,
      keepBuffer: 6,
    }
  );

  function setBasemap(mode) {
    state.basemapMode = mode;
    if (mode === "satellite") {
      if (map.hasLayer(streetLayer)) map.removeLayer(streetLayer);
      if (!map.hasLayer(satelliteLayer)) satelliteLayer.addTo(map);
      els.basemapStreet.classList.remove("is-active");
      els.basemapSatellite.classList.add("is-active");
      updateSatelliteBaseVisibility();
      handleViewportChanged(true);
      syncYearImagery();
      return;
    }

    if (map.hasLayer(satelliteLayer)) map.removeLayer(satelliteLayer);
    if (!map.hasLayer(streetLayer)) streetLayer.addTo(map);
    els.basemapSatellite.classList.remove("is-active");
    els.basemapStreet.classList.add("is-active");
    if (state.imageryLayer) {
      map.removeLayer(state.imageryLayer);
      state.imageryLayer = null;
    }
    state.imageryScopeLoading = false;
    state.imageryViewportLoading = false;
    setPlayTimelineEnabled(true);
    updateSatelliteBaseVisibility();
    els.mapTimelineState.textContent = state.playbackTimer ? "Playback live" : "Street timeline";
    els.mapTimelineNote.textContent =
      "Street mode keeps the base map lightweight while the development overlay changes by year.";
  }

  function formatInr(n) {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      maximumFractionDigits: 0,
    }).format(n);
  }

  function formatPct(n, digits) {
    if (typeof n !== "number" || !Number.isFinite(n)) return "—";
    return n.toFixed(digits) + "%";
  }

  function formatSigned(n, digits) {
    if (typeof n !== "number" || !Number.isFinite(n)) return "—";
    const value = n.toFixed(digits);
    return n > 0 ? "+" + value : value;
  }

  function investmentScore(area) {
    return area.investment?.score ?? Number.NEGATIVE_INFINITY;
  }

  function investmentScoreLabel(area) {
    return area.investment?.score != null ? area.investment.score.toFixed(1) + " / 100" : "—";
  }

  function effectiveGrowth(area) {
    const metrics = area.investment?.metrics || {};
    if (
      typeof metrics.growth10yEffective === "number" &&
      Number.isFinite(metrics.growth10yEffective)
    ) {
      return metrics.growth10yEffective;
    }
    return area.summary.growth ?? null;
  }

  function growthLabel(area, shortLabel) {
    const source = area.investment?.metrics?.growthSource;
    const estimated = source && source !== "observed_10y";
    if (shortLabel) return estimated ? "10Y est." : "10Y change";
    return estimated ? "10Y development estimate" : "10Y development change";
  }

  function rankingMetricValue(area, sortKey) {
    const metrics = area.investment?.metrics || {};
    switch (sortKey) {
      case "employmentStrength":
        return metrics.employmentStrength ?? Number.NEGATIVE_INFINITY;
      case "rentalYield":
        return metrics.rentalYieldPct ?? Number.NEGATIVE_INFINITY;
      case "pricePerSqft":
        return area.pricePerSqft ?? Number.NEGATIVE_INFINITY;
      case "growth10y":
        return effectiveGrowth(area) ?? Number.NEGATIVE_INFINITY;
      case "overallScore":
      default:
        return investmentScore(area);
    }
  }

  function rankingMetricLabel(sortKey) {
    switch (sortKey) {
      case "employmentStrength":
        return "employment rank";
      case "rentalYield":
        return "rental yield rank";
      case "pricePerSqft":
        return "price rank";
      case "growth10y":
        return "10Y change rank";
      case "overallScore":
      default:
        return "investment rank";
    }
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function getHistoricSeries(area) {
    const historic = area.development?.historicByYear;
    if (!historic || typeof historic !== "object") return [];
    return YEARS.map((year) => {
      const raw = historic[String(year)];
      const value = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
      return { year, value };
    });
  }

  function getYearValue(area, year) {
    const item = area.series.find((entry) => entry.year === year);
    return item ? item.value : null;
  }

  function computeYearDelta(area, year) {
    const current = getYearValue(area, year);
    const previous = getYearValue(area, year - 1);
    if (current == null || previous == null) return null;
    return current - previous;
  }

  function summarizeArea(area) {
    const valid = area.series.filter((entry) => entry.value != null);
    let bestLift = null;
    let worstLift = null;

    for (let index = 1; index < valid.length; index++) {
      const previous = valid[index - 1];
      const current = valid[index];
      const delta = current.value - previous.value;
      if (!bestLift || delta > bestLift.delta) {
        bestLift = { year: current.year, delta };
      }
      if (!worstLift || delta < worstLift.delta) {
        worstLift = { year: current.year, delta };
      }
    }

    const first = valid[0]?.value ?? null;
    const last = valid[valid.length - 1]?.value ?? null;
    const growth =
      typeof area.development?.builtUpGrowth10y === "number"
        ? area.development.builtUpGrowth10y
        : first != null && last != null
          ? last - first
          : null;

    return {
      first,
      last,
      growth,
      validCount: valid.length,
      bestLift,
      worstLift,
      slope:
        typeof area.development?.ndbiTrendSlopePerYear === "number"
          ? area.development.ndbiTrendSlopePerYear
          : null,
      forecast:
        typeof area.development?.linearForecastBuiltUp10y === "number"
          ? area.development.linearForecastBuiltUp10y
          : null,
    };
  }

  function enrichArea(area) {
    const series = getHistoricSeries(area);
    const summary = summarizeArea({ ...area, series });
    return { ...area, series, summary };
  }

  function rankAreas(areas) {
    const sortKey = state.rankingSort;
    return [...areas].sort((a, b) => {
      const primaryA = rankingMetricValue(a, sortKey);
      const primaryB = rankingMetricValue(b, sortKey);
      if (primaryB !== primaryA) return primaryB - primaryA;
      const scoreA = investmentScore(a);
      const scoreB = investmentScore(b);
      if (scoreB !== scoreA) return scoreB - scoreA;
      const growthA = effectiveGrowth(a) ?? Number.NEGATIVE_INFINITY;
      const growthB = effectiveGrowth(b) ?? Number.NEGATIVE_INFINITY;
      if (growthB !== growthA) return growthB - growthA;
      return b.pricePerSqft - a.pricePerSqft;
    });
  }

  function normalize(values, fallback = 0.5) {
    const valid = values.filter((value) => typeof value === "number" && Number.isFinite(value));
    if (!valid.length) {
      return {
        scale: () => fallback,
        min: null,
        max: null,
      };
    }
    const min = Math.min(...valid);
    const max = Math.max(...valid);
    const span = max - min || 1;
    return {
      scale: (value) => {
        if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
        return (value - min) / span;
      },
      min,
      max,
    };
  }

  function mixColor(a, b, t) {
    const parse = (hex) => [
      Number.parseInt(hex.slice(1, 3), 16),
      Number.parseInt(hex.slice(3, 5), 16),
      Number.parseInt(hex.slice(5, 7), 16),
    ];
    const [ar, ag, ab] = parse(a);
    const [br, bg, bb] = parse(b);
    const rr = Math.round(ar + (br - ar) * t);
    const rg = Math.round(ag + (bg - ag) * t);
    const rb = Math.round(ab + (bb - ab) * t);
    return `rgb(${rr}, ${rg}, ${rb})`;
  }

  function colorForLevel(level) {
    if (level < 0.5) {
      return mixColor("#215f74", "#84aa96", level / 0.5);
    }
    return mixColor("#84aa96", "#c55f35", (level - 0.5) / 0.5);
  }

  function setLegend(minPrice, maxPrice) {
    els.legend.innerHTML =
      '<span>Modeled price range</span><div class="legend-bar"></div><div class="legend-labels"><span>' +
      formatInr(minPrice) +
      '/sqft</span><span>' +
      formatInr(maxPrice) +
      '/sqft</span></div>';
  }

  function setSignalsLine(signals) {
    if (!signals) return;
    const parts = [];
    els.signalsLine.classList.remove("is-warn");

    if (signals.newsFetchedAt) {
      const d = new Date(signals.newsFetchedAt);
      parts.push(
        "News signal: " +
          (signals.infraArticleCount ?? 0) +
          " infra-tagged articles" +
          (!Number.isNaN(d.getTime()) ? " refreshed " + d.toLocaleString() : "")
      );
    } else if (signals.newsError) {
      parts.push("News feed unavailable, using neutral infra signal");
      els.signalsLine.classList.add("is-warn");
    } else {
      parts.push("Loading infra signal");
    }

    if (signals.developmentMetric) {
      parts.push("development metric " + signals.developmentMetric);
    }
    if (signals.developmentHistoricWindow?.startYear && signals.developmentHistoricWindow?.endYear) {
      parts.push(
        "historic window " +
          signals.developmentHistoricWindow.startYear +
          "-" +
          signals.developmentHistoricWindow.endYear
      );
    }

    els.signalsLine.textContent = parts.join(" · ");
  }

  function popupHtml(area) {
    const yearValue = getYearValue(area, state.activeYear);
    const delta = computeYearDelta(area, state.activeYear);
    const metrics = area.investment?.metrics || {};
    return (
      "<strong>" +
      esc(area.name) +
      '</strong><br><span class="popup-anchor">' +
      esc(area.cityName || "") +
      '</span><br><span class="popup-price">' +
      esc(formatInr(area.pricePerSqft)) +
      "</span> / sqft" +
      '<div class="popup-model"><strong>Investment</strong><br/>' +
      "Score: " +
      esc(investmentScoreLabel(area)) +
      "<br/>Rental yield: " +
      esc(formatPct(metrics.rentalYieldPct, 1)) +
      "<br/>5Y rent growth: " +
      esc(formatPct(metrics.rentGrowth5yPct, 0)) +
      "<br/>Employment strength: " +
      esc(String(metrics.employmentStrength ?? "—")) +
      '<br/><br/><strong>Development</strong><br/>' +
      "Year " +
      state.activeYear +
      ": " +
      esc(formatSigned(yearValue, 4)) +
      "<br/>" +
      esc(growthLabel(area, false)) +
      ": " +
      esc(formatSigned(effectiveGrowth(area), 4)) +
      "<br/>YoY move: " +
      esc(formatSigned(delta, 4)) +
      "</div>"
    );
  }

  function renderTopStats(areas) {
    const ranked = rankAreas(areas);
    const strongest = ranked[0];
    const selectedCities = state.cities.filter((city) => state.selectedCitySlugs.includes(city.slug));
    const meanYield =
      areas.reduce((sum, area) => sum + (area.investment?.metrics?.rentalYieldPct ?? 0), 0) /
      areas.length;

    els.topStats.innerHTML = [
      {
        label: "Markets in view",
        value: String(selectedCities.length),
        note:
          selectedCities.length === 1
            ? selectedCities[0]?.name || "Selected city"
            : selectedCities.length === state.cities.length
              ? "All tracked cities"
              : selectedCities.map((city) => city.name).join(", "),
      },
      {
        label: "Average rental yield",
        value: formatPct(meanYield, 1),
        note: "Gross yield across selected localities",
      },
      {
        label: "Best investment score",
        value: strongest ? strongest.name : "—",
        note:
          strongest
            ? [strongest.cityName, investmentScoreLabel(strongest)].filter(Boolean).join(" · ")
            : "",
      },
    ]
      .map(
        (card) =>
          '<div class="stat-card"><span>' +
          esc(card.label) +
          "</span><strong>" +
          esc(card.value) +
          "</strong><span>" +
          esc(card.note) +
          "</span></div>"
      )
      .join("");
  }

  function renderSparkline(area) {
    const valid = area.series.filter((entry) => entry.value != null);
    if (valid.length < 2) return "";
    const width = 86;
    const height = 28;
    const padding = 3;
    const values = valid.map((entry) => entry.value);
    const norm = normalize(values, 0.5);
    const step = valid.length > 1 ? (width - padding * 2) / (valid.length - 1) : 0;
    const points = valid
      .map((entry, index) => {
        const x = padding + index * step;
        const y = height - padding - norm.scale(entry.value) * (height - padding * 2);
        return x.toFixed(2) + "," + y.toFixed(2);
      })
      .join(" ");
    return (
      '<svg class="ranking-spark" viewBox="0 0 ' +
      width +
      " " +
      height +
      '" aria-hidden="true"><polyline fill="none" stroke="#c55f35" stroke-width="2" points="' +
      points +
      '"></polyline></svg>'
    );
  }

  function renderRanking(areas) {
    const ranked = rankAreas(areas);
    const showCity = state.selectedCitySlugs.length > 1;
    const sortKey = state.rankingSort;
    els.rankingList.innerHTML = ranked
      .map((area, index) => {
        const yearValue = getYearValue(area, state.activeYear);
        const isActive = area.name === state.selectedAreaName;
        const metrics = area.investment?.metrics || {};
        return (
          '<button class="ranking-item' +
          (isActive ? " is-active" : "") +
          '" type="button" data-area-name="' +
          esc(area.name) +
          '">' +
          '<div class="ranking-title"><div><small>#' +
          String(index + 1) +
          (showCity ? " · " + esc(area.cityName || "") : "") +
          "</small><strong>" +
          esc(area.name) +
          "</strong></div>" +
          renderSparkline(area) +
          "</div>" +
          '<div class="ranking-meta"><span class="ranking-subtle">' +
          esc(
            sortKey === "employmentStrength"
              ? "Employment " + String(metrics.employmentStrength ?? "—") + " / 100"
              : sortKey === "rentalYield"
                ? "Yield " + formatPct(metrics.rentalYieldPct, 1)
                : sortKey === "pricePerSqft"
                  ? "Price " + formatInr(area.pricePerSqft)
                  : sortKey === "growth10y"
                    ? growthLabel(area, true) + " " + formatSigned(effectiveGrowth(area), 4)
                    : "Score " + investmentScoreLabel(area)
          ) +
          "</span><span class=\"ranking-subtle\">Yield " +
          esc(formatPct(metrics.rentalYieldPct, 1)) +
          '</span><span class="ranking-subtle">' +
          esc(growthLabel(area, true)) +
          " " +
          esc(formatSigned(effectiveGrowth(area), 4)) +
          "</span><span class=\"ranking-subtle\">Modeled " +
          esc(formatInr(area.pricePerSqft)) +
          " / sqft</span><span class=\"ranking-subtle\">Year " +
          state.activeYear +
          " " +
          esc(formatSigned(yearValue, 4)) +
          "</span></div></button>"
        );
      })
      .join("");
  }

  function chartSvg(area) {
    const valid = area.series.filter((entry) => entry.value != null);
    if (valid.length < 2) {
      return (
        '<div class="chart-empty">Historic Earth Engine values are not loaded for this locality yet. ' +
        "Run the multi-city development extract to populate the development database " +
        "and unlock the 2015-2024 chart.</div>"
      );
    }

    const width = 560;
    const height = 180;
    const paddingX = 24;
    const paddingY = 20;
    const values = valid.map((entry) => entry.value);
    const norm = normalize(values, 0.5);
    const step = (width - paddingX * 2) / (valid.length - 1);
    const points = valid.map((entry, index) => {
      const x = paddingX + index * step;
      const y = height - paddingY - norm.scale(entry.value) * (height - paddingY * 2);
      return { x, y, ...entry };
    });
    const polyline = points.map((point) => point.x.toFixed(1) + "," + point.y.toFixed(1)).join(" ");
    const activePoint = points.find((point) => point.year === state.activeYear) || points[points.length - 1];

    return (
      '<div class="chart-wrap"><div class="chart-meta"><span>Annual median NDBI proxy</span><span>Selected year ' +
      state.activeYear +
      " • " +
      esc(formatSigned(activePoint.value, 4)) +
      "</span></div>" +
      '<svg viewBox="0 0 ' +
      width +
      " " +
      height +
      '" role="img" aria-label="Development trend chart">' +
      '<line x1="' +
      paddingX +
      '" y1="' +
      (height - paddingY) +
      '" x2="' +
      (width - paddingX) +
      '" y2="' +
      (height - paddingY) +
      '" stroke="rgba(103,95,83,0.22)" stroke-width="1"></line>' +
      '<polyline fill="none" stroke="#c55f35" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" points="' +
      polyline +
      '"></polyline>' +
      points
        .map((point) => {
          const isActive = point.year === state.activeYear;
          return (
            '<circle cx="' +
            point.x.toFixed(1) +
            '" cy="' +
            point.y.toFixed(1) +
            '" r="' +
            (isActive ? "5.5" : "3.5") +
            '" fill="' +
            (isActive ? "#943619" : "#fff8f1") +
            '" stroke="#c55f35" stroke-width="2"></circle>' +
            '<text x="' +
            point.x.toFixed(1) +
            '" y="' +
            (height - 4) +
            '" text-anchor="middle" fill="#675f53" font-size="11">' +
            point.year +
            "</text>"
          );
        })
        .join("") +
      "</svg></div>"
    );
  }

  function renderSelectedArea(area) {
    const ranked = rankAreas(state.areas);
    const rank = ranked.findIndex((entry) => entry.name === area.name);
    const yearValue = getYearValue(area, state.activeYear);
    const yearDelta = computeYearDelta(area, state.activeYear);
    const bestLift = area.summary.bestLift;
    const worstLift = area.summary.worstLift;
    const metrics = area.investment?.metrics || {};

    els.selectedName.textContent = area.name;
    els.selectedRank.textContent =
      (rank >= 0 ? "#" + String(rank + 1) + " " + rankingMetricLabel(state.rankingSort) : "Tracked") +
      " · " +
      (area.cityName || "");
    els.selectedPrice.textContent = formatInr(area.pricePerSqft);
    els.selectedBadges.innerHTML = [
      "City <strong>" + esc(area.cityName) + "</strong>",
      area.planned
        ? "Pipeline <strong>" + esc(area.planStage || "planned growth corridor") + "</strong>"
        : null,
      "Investment <strong>" + esc(investmentScoreLabel(area)) + "</strong>",
      "Rental yield <strong>" + esc(formatPct(metrics.rentalYieldPct, 1)) + "</strong>",
      growthLabel(area, true) + " <strong>" + esc(formatSigned(effectiveGrowth(area), 4)) + "</strong>",
      "5Y rent growth <strong>" + esc(formatPct(metrics.rentGrowth5yPct, 0)) + "</strong>",
    ]
      .filter(Boolean)
      .map((text) => '<div class="area-chip">' + text + "</div>")
      .join("");
    els.trendChart.innerHTML = chartSvg(area);
    els.selectedStats.innerHTML = [
      {
        label: "Investment score",
        value: investmentScoreLabel(area),
      },
      {
        label: "Rental yield",
        value: formatPct(metrics.rentalYieldPct, 1),
      },
      {
        label: "5Y rent growth",
        value: formatPct(metrics.rentGrowth5yPct, 0),
      },
      {
        label: "Demand strength",
        value: metrics.demandStrength != null ? String(metrics.demandStrength) + " / 100" : "—",
      },
      {
        label: "Employment strength",
        value:
          metrics.employmentStrength != null
            ? String(metrics.employmentStrength) + " / 100"
            : "—",
      },
      {
        label: "Risk penalty",
        value: metrics.riskPenalty != null ? String(metrics.riskPenalty) + " / 100" : "—",
      },
      {
        label: growthLabel(area, false),
        value: formatSigned(effectiveGrowth(area), 4),
      },
      {
        label: "Growth basis",
        value:
          area.investment?.metrics?.growthSource === "observed_10y"
            ? "Observed"
            : area.investment?.metrics?.growthSource === "trend_extrapolated"
              ? "Trend extrapolated"
              : area.investment?.metrics?.growthSource === "partial_history_extrapolated"
                ? "Partial history extrapolated"
                : area.investment?.metrics?.growthSource === "city_proxy_planned"
                  ? "Planned-area city proxy"
                  : area.investment?.metrics?.growthSource === "city_proxy"
                    ? "City proxy"
                    : "Unavailable",
      },
      {
        label: "Year " + state.activeYear,
        value: formatSigned(yearValue, 4),
      },
      {
        label: "YoY move",
        value: formatSigned(yearDelta, 4),
      },
      {
        label: "Best lift year",
        value: bestLift ? bestLift.year + " (" + formatSigned(bestLift.delta, 4) + ")" : "—",
      },
      {
        label: "Weakest year",
        value: worstLift ? worstLift.year + " (" + formatSigned(worstLift.delta, 4) + ")" : "—",
      },
      {
        label: "Modeled price",
        value: formatInr(area.pricePerSqft),
      },
      {
        label: "Model uplift",
        value:
          typeof area.model?.logAdjustment === "number"
            ? formatSigned((Math.exp(area.model.logAdjustment) - 1) * 100, 1) + "%"
            : "—",
      },
    ]
      .map(
        (card) =>
          '<div class="detail-card"><span>' +
          esc(card.label) +
          "</span><strong>" +
          esc(card.value) +
          "</strong></div>"
      )
      .join("");
  }

  function updateYearUi() {
    els.yearSlider.value = String(state.activeYear);
    els.yearPill.textContent = String(state.activeYear);
    els.mapTimelineBadge.textContent = "Year " + String(state.activeYear);

    const yearIndex = YEARS.indexOf(state.activeYear);
    const yearProgress = yearIndex >= 0 ? ((yearIndex + 1) / YEARS.length) * 100 : 100;
    els.mapTimelineProgress.style.width = yearProgress.toFixed(1) + "%";

    const values = state.areas.map((area) => getYearValue(area, state.activeYear)).filter((value) => value != null);
    const norm = normalize(values, 0.5);

    if (norm.min == null || norm.max == null) {
      els.mapModeSummary.textContent = "No yearly development values available";
      els.mapTimelineNote.textContent =
        state.basemapMode === "satellite"
          ? "Satellite imagery is syncing to the selected year for this scope."
          : "Playback is running, but this scope has limited yearly development coverage.";
      return;
    }

    els.mapModeSummary.textContent =
      "Development range " +
      formatSigned(norm.min, 4) +
      " to " +
      formatSigned(norm.max, 4);
    els.mapTimelineNote.textContent =
      state.basemapMode === "satellite"
        ? "Satellite imagery is aligning to " + String(state.activeYear) + "."
        : "Development overlays are now showing conditions for " + String(state.activeYear) + ".";
  }

  function selectedCitiesKey() {
    return state.selectedCitySlugs.slice().sort().join(",");
  }

  function imageryCacheKeyFor(year, citiesKey) {
    return citiesKey + "::" + String(year);
  }

  function imageryCacheKey() {
    return imageryCacheKeyFor(state.activeYear, selectedCitiesKey());
  }

  function historicalImageryAllowed() {
    return state.basemapMode === "satellite" && map.getZoom() >= MIN_TIMELINE_IMAGERY_ZOOM;
  }

  function isViewportImageryReady() {
    return historicalImageryAllowed() && state.imageryViewportReady.has(viewportKey());
  }

  function viewportTileRange() {
    const zoom = map.getZoom();
    const tileSize = 256;
    const bounds = map.getBounds();
    const northWest = map.project(bounds.getNorthWest(), zoom).divideBy(tileSize).floor();
    const southEast = map.project(bounds.getSouthEast(), zoom).divideBy(tileSize).floor();
    return {
      zoom,
      minX: northWest.x,
      maxX: southEast.x,
      minY: northWest.y,
      maxY: southEast.y,
    };
  }

  function viewportKey() {
    const range = viewportTileRange();
    return [
      selectedCitiesKey(),
      range.zoom,
      range.minX,
      range.maxX,
      range.minY,
      range.maxY,
    ].join("::");
  }

  function renderTileUrl(urlFormat, x, y, z) {
    return urlFormat
      .replace("{x}", String(x))
      .replace("{y}", String(y))
      .replace("{z}", String(z));
  }

  function preloadTile(url) {
    return new Promise((resolve) => {
      const image = new Image();
      image.decoding = "async";
      image.loading = "eager";
      image.onload = () => resolve(true);
      image.onerror = () => resolve(false);
      image.src = url;
    });
  }

  function preloadTilesForDoc(layerDoc) {
    const range = viewportTileRange();
    const tasks = [];
    for (let x = range.minX; x <= range.maxX; x += 1) {
      for (let y = range.minY; y <= range.maxY; y += 1) {
        tasks.push(preloadTile(renderTileUrl(layerDoc.urlFormat, x, y, range.zoom)));
      }
    }
    return Promise.allSettled(tasks);
  }

  function setPlayTimelineEnabled(enabled) {
    state.timelinePlaybackEnabled = enabled;
    syncTimelineButtons();
  }

  function syncTimelineButtons() {
    const showLoadButton = historicalImageryAllowed();
    els.loadTimeline.hidden = !showLoadButton;

    if (state.imageryScopeLoading || state.imageryViewportLoading) {
      els.loadTimeline.disabled = true;
      els.loadTimeline.textContent = "Loading...";
      els.playToggle.disabled = true;
      els.playToggle.classList.remove("is-active");
      els.playToggle.textContent = "Loading timeline...";
      return;
    }

    if (showLoadButton) {
      const ready = isViewportImageryReady();
      els.loadTimeline.disabled = false;
      els.loadTimeline.textContent = ready ? "Reload timeline" : "Load timeline";
      els.playToggle.disabled = !ready || !state.timelinePlaybackEnabled;
      els.playToggle.textContent = state.playbackTimer ? "Pause timeline" : "Play timeline";
      return;
    }

    els.loadTimeline.disabled = true;
    els.loadTimeline.textContent = "Load timeline";
    els.playToggle.disabled = !state.timelinePlaybackEnabled;
    els.playToggle.textContent = state.playbackTimer ? "Pause timeline" : "Play timeline";
  }

  function updateSatelliteBaseVisibility() {
    const container = satelliteLayer.getContainer ? satelliteLayer.getContainer() : null;
    if (!container) return;

    const hideBase =
      state.basemapMode === "satellite" &&
      historicalImageryAllowed() &&
      isViewportImageryReady() &&
      state.imageryLayer &&
      map.hasLayer(state.imageryLayer);

    container.style.visibility = hideBase ? "hidden" : "visible";
  }

  function applyImageryLayer(layerDoc) {
    if (!layerDoc?.urlFormat || state.basemapMode !== "satellite" || !historicalImageryAllowed()) {
      return Promise.resolve(false);
    }
    const cacheKey = imageryCacheKeyFor(layerDoc.year, layerDoc.selectedCitySlugs.slice().sort().join(","));
    let layer = state.imageryLayerCache.get(cacheKey);
    if (!layer) {
      layer = L.tileLayer(layerDoc.urlFormat, {
        pane: "overlayPane",
        maxZoom: 19,
        keepBuffer: 6,
        updateWhenZooming: false,
        updateWhenIdle: true,
        attribution: "Earth Engine annual imagery",
      });
      state.imageryLayerCache.set(cacheKey, layer);
    }

    const previousLayer = state.imageryLayer;

    if (!map.hasLayer(layer)) {
      layer.addTo(map);
    }
    state.imageryLayer = layer;

    const container = layer.getContainer ? layer.getContainer() : null;
    if (container) {
      container.style.visibility = previousLayer && previousLayer !== layer ? "hidden" : "visible";
    }

    els.mapTimelineState.textContent = state.playbackTimer ? "Rendering frame" : "Rendering imagery";
    els.mapTimelineNote.textContent =
      "Rendering annual satellite composite for " + String(layerDoc.year) + " on the map.";

    return waitForTileLayerReady(layer).then(() => {
      const latest = state.imageryLayer === layer;
      if (!latest || state.basemapMode !== "satellite") {
        return false;
      }

      const latestContainer = layer.getContainer ? layer.getContainer() : null;
      if (latestContainer) {
        latestContainer.style.visibility = "visible";
      }

      if (previousLayer && previousLayer !== layer && map.hasLayer(previousLayer)) {
        map.removeLayer(previousLayer);
      }

      bringOverlayLayersToFront();
      updateSatelliteBaseVisibility();

      els.mapTimelineState.textContent = state.playbackTimer ? "Playback live" : "Imagery live";
      els.mapTimelineNote.textContent =
        "Annual satellite composite for " + String(state.activeYear) + " loaded on the map.";
      return true;
    });
  }

  function waitForTileLayerReady(layer) {
    if (!layer || !map.hasLayer(layer)) {
      return Promise.resolve();
    }

    if (typeof layer.isLoading === "function" && !layer.isLoading()) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let finished = false;
      const complete = () => {
        if (finished) return;
        finished = true;
        layer.off("load", onLoad);
        layer.off("tileerror", onError);
        resolve();
      };
      const onLoad = () => complete();
      const onError = () => complete();
      layer.on("load", onLoad);
      layer.on("tileerror", onError);
    });
  }

  function bringOverlayLayersToFront() {
    if (state.yearSurfaceGroup && map.hasLayer(state.yearSurfaceGroup)) {
      state.yearSurfaceGroup.eachLayer((entry) => {
        if (entry && typeof entry.bringToFront === "function") {
          entry.bringToFront();
        }
      });
    }

    if (state.group && map.hasLayer(state.group)) {
      state.group.eachLayer((entry) => {
        if (entry && typeof entry.bringToFront === "function") {
          entry.bringToFront();
        }
      });
    }
  }

  function fetchYearImagery(year, citiesKey) {
    const key = imageryCacheKeyFor(year, citiesKey);
    const cached = state.imageryCache.get(key);
    if (cached) {
      return Promise.resolve(cached);
    }

    const pending = state.imageryPending.get(key);
    if (pending) {
      return pending;
    }

    const request = fetch(
      "/api/year-imagery?year=" +
        encodeURIComponent(year) +
        "&cities=" +
        encodeURIComponent(citiesKey)
    )
      .then((response) => {
        if (!response.ok) throw new Error("Imagery request failed");
        return response.json();
      })
      .then((doc) => {
        state.imageryCache.set(key, doc);
        state.imageryPending.delete(key);
        return doc;
      })
      .catch((error) => {
        state.imageryPending.delete(key);
        throw error;
      });

    state.imageryPending.set(key, request);
    return request;
  }

  function preloadScopeImagery() {
    if (state.basemapMode !== "satellite") {
      state.imageryScopeLoading = false;
      state.imageryViewportLoading = false;
      setPlayTimelineEnabled(true);
      return Promise.resolve();
    }

    const citiesKey = selectedCitiesKey();
    const allReady = YEARS.every((year) => state.imageryCache.has(imageryCacheKeyFor(year, citiesKey)));
    if (allReady) {
      state.imageryScopeLoading = false;
      state.imageryScopeLoadKey = citiesKey;
      if (!state.imageryViewportLoading) {
        setPlayTimelineEnabled(true);
      }
      return Promise.resolve();
    }

    state.imageryScopeLoading = true;
    state.imageryScopeLoadKey = citiesKey;
    stopPlayback();
    setPlayTimelineEnabled(false);
    els.mapTimelineState.textContent = "Loading imagery";
    els.mapTimelineNote.textContent =
      "Loading annual imagery for 2015-2024 for the selected city scope.";

    return Promise.allSettled(YEARS.map((year) => fetchYearImagery(year, citiesKey))).then((results) => {
      if (state.imageryScopeLoadKey !== citiesKey) return;
      state.imageryScopeLoading = false;
      if (!state.imageryViewportLoading) {
        setPlayTimelineEnabled(true);
      }

      const readyCount = results.filter((result) => result.status === "fulfilled").length;
      if (readyCount) {
        els.mapTimelineState.textContent = "Imagery ready";
        els.mapTimelineNote.textContent =
          "Loaded " +
          String(readyCount) +
          " yearly imagery layers for this scope. Playback is now enabled.";
        syncYearImagery();
      } else {
        els.mapTimelineState.textContent = "Static view";
        els.mapTimelineNote.textContent =
          "Historical imagery could not be preloaded, so playback remains on the development overlay only.";
      }
    });
  }

  function syncYearImagery() {
    if (state.basemapMode !== "satellite") {
      if (state.imageryLayer) {
        map.removeLayer(state.imageryLayer);
        state.imageryLayer = null;
      }
      updateSatelliteBaseVisibility();
      return Promise.resolve(false);
    }

    if (!historicalImageryAllowed()) {
      if (state.imageryLayer) {
        map.removeLayer(state.imageryLayer);
        state.imageryLayer = null;
      }
      updateSatelliteBaseVisibility();
      els.mapTimelineState.textContent = state.playbackTimer ? "Playback live" : "Satellite overview";
      els.mapTimelineNote.textContent =
        "Zoom in to level " +
        String(MIN_TIMELINE_IMAGERY_ZOOM) +
        " or closer to activate yearly satellite imagery. Latest satellite view remains on the map.";
      return Promise.resolve(false);
    }

    if (!isViewportImageryReady()) {
      if (state.imageryLayer) {
        map.removeLayer(state.imageryLayer);
        state.imageryLayer = null;
      }
      updateSatelliteBaseVisibility();
      els.mapTimelineState.textContent = "Timeline not loaded";
      els.mapTimelineNote.textContent =
        "Click Load timeline to preload yearly satellite imagery for this zoomed-in map view.";
      return Promise.resolve(false);
    }

    const syncId = ++state.imagerySyncId;
    const key = imageryCacheKey();
    const cached = state.imageryCache.get(key);
    if (cached) {
      if (syncId !== state.imagerySyncId) return Promise.resolve(false);
      return applyImageryLayer(cached);
    }

    const requestId = ++state.imageryRequestId;
    els.mapTimelineState.textContent = "Loading imagery";
    els.mapTimelineNote.textContent =
      "Fetching annual satellite composite for " + String(state.activeYear) + ".";

    return fetchYearImagery(state.activeYear, selectedCitiesKey())
      .then((doc) => {
        if (requestId !== state.imageryRequestId) return false;
        if (syncId !== state.imagerySyncId) return false;
        return applyImageryLayer(doc);
      })
      .catch(() => {
        if (requestId !== state.imageryRequestId) return false;
        els.mapTimelineState.textContent = state.playbackTimer ? "Playback live" : "Static view";
        els.mapTimelineNote.textContent =
          "Historical imagery is unavailable for this year right now, so the development overlay remains active.";
        return false;
      });
  }

  function filterAreasByScope() {
    const selected = new Set(state.selectedCitySlugs);
    return state.allAreas.filter((area) => selected.has(area.citySlug));
  }

  function renderCityFilters() {
    const allSelected = state.selectedCitySlugs.length === state.cities.length;
    els.cityFilters.innerHTML =
      '<button class="city-chip' +
      (allSelected ? " is-active" : "") +
      '" type="button" data-city-slug="all">All cities</button>' +
      state.cities
        .map(
          (city) =>
            '<button class="city-chip' +
            (state.selectedCitySlugs.includes(city.slug) ? " is-active" : "") +
            '" type="button" data-city-slug="' +
            esc(city.slug) +
            '">' +
            esc(city.name) +
            "</button>"
        )
        .join("");

    els.scopeSummary.textContent =
      state.selectedCitySlugs.length === 1
        ? "Investment ranking is scoped to " +
          (state.cities.find((city) => city.slug === state.selectedCitySlugs[0])?.name || "the selected city")
        : "Comparing all tracked cities with a unified investment ranking";
  }

  function cityBounds(citySlug) {
    const cityAreas = state.areas.filter((area) => area.citySlug === citySlug);
    if (!cityAreas.length) return null;
    return L.latLngBounds(cityAreas.map((area) => [area.lat, area.lng]));
  }

  function focusArea(area) {
    const marker = state.markersByName.get(area.name);
    if (!marker) return;

    const hasMultipleCitiesSelected = state.selectedCitySlugs.length > 1;
    const bounds = cityBounds(area.citySlug);

    if (hasMultipleCitiesSelected && bounds && bounds.isValid()) {
      map.flyToBounds(bounds.pad(0.24), {
        padding: [32, 32],
        duration: 0.85,
        maxZoom: 12,
      });
      return;
    }

    map.flyTo(marker.getLatLng(), 12, {
      animate: true,
      duration: 0.8,
    });
  }

  function updateMap() {
    const values = state.areas.map((area) => getYearValue(area, state.activeYear));
    const norm = normalize(values, 0.48);
    const growthNorm = normalize(state.areas.map((area) => area.summary.growth), 0.5);
    const heatPoints = [];

    state.areas.forEach((area) => {
      const marker = state.markersByName.get(area.name);
      const surface = state.yearSurfacesByName.get(area.name);
      if (!marker) return;

      const level = norm.scale(getYearValue(area, state.activeYear));
      const delta = computeYearDelta(area, state.activeYear);
      const deltaBoost = delta != null ? clamp((delta + 0.04) / 0.08, 0, 1) : 0.5;
      const growthLevel = growthNorm.scale(area.summary.growth);
      const radius = 6 + level * 10 + growthLevel * 2.5;
      const fillColor = colorForLevel(level);
      const selected = area.name === state.selectedAreaName;
      marker.setStyle({
        radius,
        weight: selected ? 3 : 1.6,
        color: selected ? "#1d1b19" : "rgba(29,27,25,0.45)",
        fillColor,
        fillOpacity: selected ? 0.95 : 0.82,
      });
      marker.setPopupContent(popupHtml(area));
      if (selected) marker.bringToFront();

      if (surface) {
        surface.setStyle({
          stroke: selected,
          weight: selected ? 1.4 : 0,
          color: selected ? "rgba(29,27,25,0.48)" : fillColor,
          fillColor,
          fillOpacity: 0.1 + level * 0.14 + deltaBoost * 0.08 + (selected ? 0.08 : 0),
        });
        surface.setRadius(700 + level * 1500 + deltaBoost * 650 + growthLevel * 450);
        if (selected) surface.bringToFront();
      }

      const priceInfluence = clamp(area.pricePerSqft / 25000, 0.22, 1);
      heatPoints.push([area.lat, area.lng, 0.18 + level * 0.48 + priceInfluence * 0.16 + deltaBoost * 0.18]);
    });

    if (state.heatLayer) {
      state.heatLayer.setLatLngs(heatPoints);
    }
  }

  function selectArea(areaName, opts) {
    const area = state.areas.find((entry) => entry.name === areaName);
    if (!area) return;
    state.selectedAreaName = areaName;
    renderRanking(state.areas);
    renderSelectedArea(area);
    updateMap();

    const marker = state.markersByName.get(area.name);
    if (marker && (!opts || opts.pan !== false)) {
      focusArea(area);
    }

    if (!opts || !opts.silentPopup) {
      if (marker) marker.openPopup();
    }
  }

  function setYear(year) {
    state.activeYear = clamp(year, YEARS[0], YEARS[YEARS.length - 1]);
    updateYearUi();
    const imageryPromise = syncYearImagery();
    renderRanking(state.areas);
    updateMap();
    const area = state.areas.find((entry) => entry.name === state.selectedAreaName);
    if (area) renderSelectedArea(area);
    return imageryPromise;
  }

  function stopPlayback() {
    if (state.playbackTimer) {
      window.clearTimeout(state.playbackTimer);
      state.playbackTimer = null;
    }
    state.playbackRunId += 1;
    els.playToggle.classList.remove("is-active");
    if (!state.imageryScopeLoading) {
      syncTimelineButtons();
    }
    els.mapTimelineState.textContent = "Static view";
    if (state.basemapMode === "satellite") {
      syncYearImagery();
    }
  }

  function startPlayback() {
    if (state.imageryScopeLoading || state.imageryViewportLoading || els.playToggle.disabled) return;
    stopPlayback();
    els.playToggle.classList.add("is-active");
    syncTimelineButtons();
    els.mapTimelineState.textContent = historicalImageryAllowed() ? "Playback live" : "Overlay playback";
    if (!historicalImageryAllowed()) {
      els.mapTimelineNote.textContent =
        "Timeline playback is updating only the development overlay until you zoom in closer.";
    }
    const runId = ++state.playbackRunId;
    const playNextFrame = () => {
      if (runId !== state.playbackRunId) return;
      const nextYear =
        state.activeYear >= YEARS[YEARS.length - 1] ? YEARS[0] : state.activeYear + 1;
      Promise.resolve(setYear(nextYear))
        .catch(() => false)
        .then(() => {
          if (runId !== state.playbackRunId) return;
          state.playbackTimer = window.setTimeout(playNextFrame, PLAY_INTERVAL_MS);
        });
    };

    state.playbackTimer = window.setTimeout(playNextFrame, PLAY_INTERVAL_MS);
  }

  function preloadViewportImagery() {
    if (state.basemapMode !== "satellite") {
      state.imageryViewportLoading = false;
      if (!state.imageryScopeLoading) setPlayTimelineEnabled(true);
      return Promise.resolve();
    }

    if (!historicalImageryAllowed()) {
      state.imageryViewportLoading = false;
      state.imageryViewportLoadKey = "";
      if (!state.imageryScopeLoading) setPlayTimelineEnabled(true);
      syncYearImagery();
      return Promise.resolve();
    }

    const key = viewportKey();
    const ready = state.imageryViewportReady.has(key);
    if (ready) {
      state.imageryViewportLoading = false;
      state.imageryViewportLoadKey = key;
      if (!state.imageryScopeLoading) setPlayTimelineEnabled(true);
      syncYearImagery();
      return Promise.resolve();
    }

    const existing = state.imageryViewportPending.get(key);
    if (existing) {
      state.imageryViewportLoading = true;
      setPlayTimelineEnabled(false);
      return existing;
    }

    state.imageryViewportLoading = true;
    state.imageryViewportLoadKey = key;
    stopPlayback();
    setPlayTimelineEnabled(false);
    els.mapTimelineState.textContent = "Loading timeline";
    els.mapTimelineNote.textContent =
      "Loading yearly imagery for the current zoomed-in map view before playback starts.";

    const request = preloadScopeImagery()
      .then(() => Promise.all(YEARS.map((year) => fetchYearImagery(year, selectedCitiesKey()))))
      .then((docs) => Promise.allSettled(docs.map((doc) => preloadTilesForDoc(doc))))
      .then((results) => {
        state.imageryViewportPending.delete(key);
        if (state.basemapMode !== "satellite" || state.imageryViewportLoadKey !== key) return;
        state.imageryViewportLoading = false;
        state.imageryViewportReady.add(key);
        if (!state.imageryScopeLoading) setPlayTimelineEnabled(true);

        const readyCount = results.filter((result) => result.status === "fulfilled").length;
        els.mapTimelineState.textContent = "Timeline ready";
        els.mapTimelineNote.textContent =
          "Loaded cached yearly imagery for " +
          String(readyCount) +
          " timeline frames in this map view. Playback is ready.";
        syncYearImagery();
      })
      .catch(() => {
        state.imageryViewportPending.delete(key);
        if (state.basemapMode !== "satellite" || state.imageryViewportLoadKey !== key) return;
        state.imageryViewportLoading = false;
        if (!state.imageryScopeLoading) setPlayTimelineEnabled(true);
        els.mapTimelineState.textContent = "Static view";
        els.mapTimelineNote.textContent =
          "Timeline imagery could not be fully preloaded for this map view, so the latest satellite map stays active.";
        syncYearImagery();
      });

    state.imageryViewportPending.set(key, request);
    return request;
  }

  function handleViewportChanged(immediate) {
    if (state.basemapMode !== "satellite") return;
    if (state.viewportChangeTimer) {
      window.clearTimeout(state.viewportChangeTimer);
      state.viewportChangeTimer = null;
    }

    const run = () => {
      stopPlayback();
      syncYearImagery();
      syncTimelineButtons();
      if (historicalImageryAllowed() && !isViewportImageryReady()) {
        els.mapTimelineState.textContent = "Timeline not loaded";
        els.mapTimelineNote.textContent =
          "Zoomed-in satellite history is available here. Click Load timeline to prepare all yearly frames.";
      }
    };

    if (immediate) {
      run();
      return;
    }

    state.viewportChangeTimer = window.setTimeout(run, 180);
  }

  function mountMap(areas) {
    if (state.imageryLayer) {
      map.removeLayer(state.imageryLayer);
      state.imageryLayer = null;
    }
    if (state.heatLayer) {
      map.removeLayer(state.heatLayer);
      state.heatLayer = null;
    }
    if (state.yearSurfaceGroup) {
      map.removeLayer(state.yearSurfaceGroup);
      state.yearSurfaceGroup = null;
    }
    if (state.group) {
      map.removeLayer(state.group);
      state.group = null;
    }
    state.markersByName.clear();
    state.yearSurfacesByName.clear();

    const prices = areas.map((area) => area.pricePerSqft);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    setLegend(minPrice, maxPrice);

    const initialHeatPoints = areas.map((area) => [area.lat, area.lng, 0.35]);
    state.heatLayer = L.heatLayer(initialHeatPoints, {
      radius: 42,
      blur: 28,
      maxZoom: 14,
      max: 1.15,
      gradient: {
        0: "#215f74",
        0.42: "#84aa96",
        0.76: "#f0c484",
        1: "#c55f35",
      },
    }).addTo(map);

    state.yearSurfaceGroup = L.layerGroup();
    state.group = L.featureGroup();
    areas.forEach((area) => {
      const surface = L.circle([area.lat, area.lng], {
        radius: 1100,
        stroke: false,
        fillColor: "#84aa96",
        fillOpacity: 0.16,
        interactive: false,
      });
      surface.addTo(state.yearSurfaceGroup);
      state.yearSurfacesByName.set(area.name, surface);

      const marker = L.circleMarker([area.lat, area.lng], {
        radius: 8,
        weight: 2,
        color: "rgba(29,27,25,0.45)",
        fillColor: "#c55f35",
        fillOpacity: 0.84,
      });
      marker.bindPopup(popupHtml(area));
      marker.on("click", () => {
        selectArea(area.name, { silentPopup: true });
      });
      marker.addTo(state.group);
      state.markersByName.set(area.name, marker);
    });
    state.yearSurfaceGroup.addTo(map);
    state.group.addTo(map);
    map.fitBounds(state.group.getBounds().pad(0.12));
    updateMap();
    syncYearImagery();
    handleViewportChanged(true);
  }

  function applyCitySelection() {
    state.areas = filterAreasByScope();
    if (!state.areas.length) return;

    renderCityFilters();
    renderTopStats(state.areas);
    renderRanking(state.areas);
    mountMap(state.areas);
    updateYearUi();

    const selectedStillVisible = state.areas.find((area) => area.name === state.selectedAreaName);
    const ranked = rankAreas(state.areas);
    const nextArea =
      selectedStillVisible ||
      ranked[0] ||
      state.areas[0];
    selectArea(nextArea.name, { silentPopup: true, pan: false });
  }

  function installInteractions() {
    els.yearSlider.addEventListener("input", () => {
      stopPlayback();
      setYear(Number(els.yearSlider.value));
    });

    els.playToggle.addEventListener("click", () => {
      if (state.playbackTimer) stopPlayback();
      else startPlayback();
    });

    els.loadTimeline.addEventListener("click", () => {
      preloadViewportImagery();
    });

    els.basemapStreet.addEventListener("click", () => {
      setBasemap("street");
    });

    els.basemapSatellite.addEventListener("click", () => {
      setBasemap("satellite");
    });

    map.on("moveend", () => {
      handleViewportChanged(false);
    });

    els.rankingList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-area-name]");
      if (!button) return;
      selectArea(button.getAttribute("data-area-name"));
    });

    els.cityFilters.addEventListener("click", (event) => {
      const button = event.target.closest("[data-city-slug]");
      if (!button) return;
      stopPlayback();
      const slug = button.getAttribute("data-city-slug");
      if (slug === "all") {
        state.selectedCitySlugs = state.cities.map((city) => city.slug);
        applyCitySelection();
        return;
      }

      if (state.selectedCitySlugs.length === state.cities.length) {
        state.selectedCitySlugs = [slug];
        applyCitySelection();
        return;
      }

      const next = state.selectedCitySlugs.includes(slug)
        ? state.selectedCitySlugs.filter((value) => value !== slug)
        : [...state.selectedCitySlugs, slug];

      state.selectedCitySlugs = next.length ? next : [slug];
      applyCitySelection();
    });

    els.rankingSort.addEventListener("change", () => {
      state.rankingSort = els.rankingSort.value || "overallScore";
      renderRanking(state.areas);
      const area = state.areas.find((entry) => entry.name === state.selectedAreaName);
      if (area) renderSelectedArea(area);
    });
  }

  fetch("/api/areas?cities=all")
    .then((response) => {
      if (!response.ok) throw new Error("API error");
      return response.json();
    })
    .then((payload) => {
      setSignalsLine(payload.signals);
      state.cities = payload.cities || [];
      state.allAreas = (payload.areas || []).map(enrichArea);
      if (!state.allAreas.length) return;

      els.rankingSort.value = state.rankingSort;
      state.selectedCitySlugs = state.cities.map((city) => city.slug);
      installInteractions();
      applyCitySelection();
    })
    .catch(() => {
      els.legend.textContent = "Could not load property and development data.";
      els.signalsLine.textContent = "Is the server running?";
      els.selectedName.textContent = "Data unavailable";
    });
})();
