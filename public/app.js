(function () {
  const YEARS = Array.from({ length: 10 }, (_, index) => 2015 + index);
  const PLAY_INTERVAL_MS = 1200;

  const state = {
    cities: [],
    allAreas: [],
    areas: [],
    selectedCitySlugs: [],
    activeYear: YEARS[YEARS.length - 1],
    selectedAreaName: null,
    heatLayer: null,
    markersByName: new Map(),
    group: null,
    playbackTimer: null,
  };

  const els = {
    legend: document.getElementById("legend"),
    signalsLine: document.getElementById("signals-line"),
    topStats: document.getElementById("top-stats"),
    yearSlider: document.getElementById("year-slider"),
    yearPill: document.getElementById("year-pill"),
    mapModeSummary: document.getElementById("map-mode-summary"),
    playToggle: document.getElementById("play-toggle"),
    cityFilters: document.getElementById("city-filters"),
    scopeSummary: document.getElementById("scope-summary"),
    selectedName: document.getElementById("selected-name"),
    selectedRank: document.getElementById("selected-rank"),
    selectedPrice: document.getElementById("selected-price"),
    selectedBadges: document.getElementById("selected-badges"),
    selectedStats: document.getElementById("selected-stats"),
    trendChart: document.getElementById("trend-chart"),
    rankingList: document.getElementById("ranking-list"),
  };

  const map = L.map("map", { scrollWheelZoom: true }).setView([12.97, 77.59], 11);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map);

  function formatInr(n) {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      maximumFractionDigits: 0,
    }).format(n);
  }

  function formatSigned(n, digits) {
    if (typeof n !== "number" || !Number.isFinite(n)) return "—";
    const value = n.toFixed(digits);
    return n > 0 ? "+" + value : value;
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
    return [...areas].sort((a, b) => {
      const growthA = a.summary.growth ?? Number.NEGATIVE_INFINITY;
      const growthB = b.summary.growth ?? Number.NEGATIVE_INFINITY;
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
    const m = area.model || {};
    const summary = area.summary || {};
    const yearValue = getYearValue(area, state.activeYear);
    const delta = computeYearDelta(area, state.activeYear);
    return (
      "<strong>" +
      esc(area.name) +
      '</strong><br><span class="popup-anchor">' +
      esc(area.cityName || "") +
      '</span><br><span class="popup-price">' +
      esc(formatInr(area.pricePerSqft)) +
      "</span> / sqft" +
      '<div class="popup-model"><strong>Development</strong><br/>' +
      "Year " +
      state.activeYear +
      ": " +
      esc(formatSigned(yearValue, 4)) +
      "<br/>10Y change: " +
      esc(formatSigned(summary.growth, 4)) +
      "<br/>YoY move: " +
      esc(formatSigned(delta, 4)) +
      "<br/>Infra z: " +
      esc(String(m.infraZ ?? "—")) +
      "<br/>Dev z: " +
      esc(String(m.devZ ?? "—")) +
      "</div>"
    );
  }

  function renderTopStats(areas) {
    const ranked = rankAreas(areas);
    const meanPrice = areas.reduce((sum, area) => sum + area.pricePerSqft, 0) / areas.length;
    const strongest = ranked[0];
    const selectedCities = state.cities.filter((city) => state.selectedCitySlugs.includes(city.slug));

    els.topStats.innerHTML = [
      {
        label: "Markets in view",
        value: String(selectedCities.length),
        note:
          selectedCities.length === 1
            ? selectedCities[0].name
            : selectedCities.length <= 3
              ? selectedCities.map((city) => city.name).join(", ")
              : selectedCities.slice(0, 3).map((city) => city.name).join(", ") +
                " +" +
                String(selectedCities.length - 3),
      },
      {
        label: "Average price",
        value: formatInr(Math.round(meanPrice)),
        note: "Modeled citywide midpoint",
      },
      {
        label: "Highest 10Y change",
        value: strongest ? strongest.name : "—",
        note:
          strongest
            ? strongest.cityName + " · " + formatSigned(strongest.summary.growth, 4)
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
    els.rankingList.innerHTML = ranked
      .map((area, index) => {
        const yearValue = getYearValue(area, state.activeYear);
        const isActive = area.name === state.selectedAreaName;
        return (
          '<button class="ranking-item' +
          (isActive ? " is-active" : "") +
          '" type="button" data-area-name="' +
          esc(area.name) +
          '">' +
          '<div class="ranking-title"><div><small>#' +
          String(index + 1) +
          (showCity ? " · " + esc(area.cityName) : "") +
          "</small><strong>" +
          esc(area.name) +
          "</strong></div>" +
          renderSparkline(area) +
          "</div>" +
          '<div class="ranking-meta"><span class="ranking-subtle">10Y change ' +
          esc(formatSigned(area.summary.growth, 4)) +
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
        "Run the multi-city development extract and merge this market into " +
        "development-series.json to unlock the 2015-2024 chart.</div>"
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

    els.selectedName.textContent = area.name;
    els.selectedRank.textContent =
      (rank >= 0 ? "#" + String(rank + 1) + " 10Y momentum" : "Tracked") +
      " · " +
      area.cityName;
    els.selectedPrice.textContent = formatInr(area.pricePerSqft);
    els.selectedBadges.innerHTML = [
      "City <strong>" + esc(area.cityName) + "</strong>",
      "10Y change <strong>" + esc(formatSigned(area.summary.growth, 4)) + "</strong>",
      "Year " + state.activeYear + " <strong>" + esc(formatSigned(yearValue, 4)) + "</strong>",
      "YoY move <strong>" + esc(formatSigned(yearDelta, 4)) + "</strong>",
    ]
      .map((text) => '<div class="area-chip">' + text + "</div>")
      .join("");
    els.trendChart.innerHTML = chartSvg(area);
    els.selectedStats.innerHTML = [
      {
        label: "Best lift year",
        value: bestLift ? bestLift.year + " (" + formatSigned(bestLift.delta, 4) + ")" : "—",
      },
      {
        label: "Weakest year",
        value: worstLift ? worstLift.year + " (" + formatSigned(worstLift.delta, 4) + ")" : "—",
      },
      {
        label: "Slope / year",
        value: formatSigned(area.summary.slope, 4),
      },
      {
        label: "10Y forecast",
        value: formatSigned(area.summary.forecast, 4),
      },
      {
        label: "Anchor price",
        value: area.model?.anchorPricePerSqft ? formatInr(area.model.anchorPricePerSqft) : "—",
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

    const values = state.areas.map((area) => getYearValue(area, state.activeYear)).filter((value) => value != null);
    const norm = normalize(values, 0.5);

    if (norm.min == null || norm.max == null) {
      els.mapModeSummary.textContent = "No yearly development values available";
      return;
    }

    els.mapModeSummary.textContent =
      "Development range " +
      formatSigned(norm.min, 4) +
      " to " +
      formatSigned(norm.max, 4);
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
        .map((city) => {
          const active = state.selectedCitySlugs.includes(city.slug);
          return (
            '<button class="city-chip' +
            (active ? " is-active" : "") +
            '" type="button" data-city-slug="' +
            esc(city.slug) +
            '">' +
            esc(city.name) +
            "</button>"
          );
        })
        .join("");

    els.scopeSummary.textContent =
      state.selectedCitySlugs.length === 1
        ? "Rankings are scoped to " +
          (state.cities.find((city) => city.slug === state.selectedCitySlugs[0])?.name || "the selected city")
        : "Comparing " + state.selectedCitySlugs.length + " markets with a unified ranking table";
  }

  function updateMap() {
    const values = state.areas.map((area) => getYearValue(area, state.activeYear));
    const norm = normalize(values, 0.48);
    const growthNorm = normalize(state.areas.map((area) => area.summary.growth), 0.5);
    const heatPoints = [];

    state.areas.forEach((area) => {
      const marker = state.markersByName.get(area.name);
      if (!marker) return;

      const level = norm.scale(getYearValue(area, state.activeYear));
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

      const priceInfluence = clamp(area.pricePerSqft / 25000, 0.22, 1);
      heatPoints.push([area.lat, area.lng, 0.22 + level * 0.58 + priceInfluence * 0.24]);
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

    if (!opts || !opts.silentPopup) {
      const marker = state.markersByName.get(area.name);
      if (marker) marker.openPopup();
    }
  }

  function setYear(year) {
    state.activeYear = clamp(year, YEARS[0], YEARS[YEARS.length - 1]);
    updateYearUi();
    renderRanking(state.areas);
    updateMap();
    const area = state.areas.find((entry) => entry.name === state.selectedAreaName);
    if (area) renderSelectedArea(area);
  }

  function stopPlayback() {
    if (state.playbackTimer) {
      window.clearInterval(state.playbackTimer);
      state.playbackTimer = null;
    }
    els.playToggle.classList.remove("is-active");
    els.playToggle.textContent = "Play timeline";
  }

  function startPlayback() {
    stopPlayback();
    els.playToggle.classList.add("is-active");
    els.playToggle.textContent = "Pause timeline";
    state.playbackTimer = window.setInterval(() => {
      const nextYear =
        state.activeYear >= YEARS[YEARS.length - 1] ? YEARS[0] : state.activeYear + 1;
      setYear(nextYear);
    }, PLAY_INTERVAL_MS);
  }

  function mountMap(areas) {
    if (state.heatLayer) {
      map.removeLayer(state.heatLayer);
      state.heatLayer = null;
    }
    if (state.group) {
      map.removeLayer(state.group);
      state.group = null;
    }
    state.markersByName.clear();

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

    state.group = L.featureGroup();
    areas.forEach((area) => {
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
    state.group.addTo(map);
    map.fitBounds(state.group.getBounds().pad(0.12));
    updateMap();
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
      ranked.find((area) => area.summary.validCount >= 2) ||
      ranked[0] ||
      state.areas[0];
    selectArea(nextArea.name, { silentPopup: true });
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
