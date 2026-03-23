(function () {
  const center = [12.97, 77.59];
  const zoom = 11;

  const map = L.map("map", { scrollWheelZoom: true }).setView(center, zoom);

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

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function setLegend(minP, maxP) {
    const el = document.getElementById("legend");
    el.innerHTML =
      '<span>Lower price</span><div class="legend-bar"></div><span>Higher price</span>' +
      '<div class="legend-labels"><span>' +
      formatInr(minP) +
      "/sqft</span><span>" +
      formatInr(maxP) +
      "/sqft</span></div>";
  }

  function setSignalsLine(signals) {
    const el = document.getElementById("signals-line");
    if (!el || !signals) return;
    const parts = [];
    if (signals.newsFetchedAt) {
      const d = new Date(signals.newsFetchedAt);
      const timeOk = !Number.isNaN(d.getTime());
      parts.push(
        "News: " +
          (signals.infraArticleCount ?? 0) +
          " infra-tagged articles" +
          (timeOk ? " · updated " + d.toLocaleString() : "")
      );
    } else if (signals.newsError) {
      parts.push("News feed unavailable — using neutral infra signal");
      el.classList.add("is-warn");
    } else {
      parts.push("Loading news signals…");
    }
    if (signals.developmentMetric) {
      parts.push("Dev feature: " + signals.developmentMetric);
    }
    if (signals.developmentForecastMetric) {
      parts.push("Dev forecast: " + signals.developmentForecastMetric);
    }
    el.textContent = parts.join(" · ");
  }

  function popupHtml(area) {
    const m = area.model || {};
    const anchor = m.anchorPricePerSqft;
    const adj =
      typeof m.logAdjustment === "number"
        ? (100 * (Math.exp(m.logAdjustment) - 1)).toFixed(1)
        : null;
    let modelBlock =
      '<div class="popup-model"><strong>Model</strong><br/>' +
      "Infra z (named in news): " +
      esc(String(m.infraZ ?? "—")) +
      "<br/>Built-up z (uplift): " +
      esc(String(m.devZ ?? "—")) +
      (m.devZRaw != null && m.devZRaw !== m.devZ
        ? " <span class=\"popup-zraw\">raw " + esc(String(m.devZRaw)) + "</span>"
        : "") +
      "</div>";
    if (adj != null) {
      modelBlock +=
        '<div class="popup-anchor">Vs anchor: ' +
        esc(adj) +
        "%</div>";
    }
    if (anchor != null) {
      modelBlock +=
        '<div class="popup-anchor">Anchor: ' +
        esc(formatInr(anchor)) +
        " / sqft</div>";
    }
    const d = area.development;
    if (d && (d.builtUpGrowth10y != null || d.linearForecastBuiltUp10y != null)) {
      modelBlock += '<div class="popup-dev">';
      if (d.builtUpGrowth10y != null) {
        modelBlock +=
          "NDBI Δ (historic window): " + esc(String(d.builtUpGrowth10y)) + "<br/>";
      }
      if (d.linearForecastBuiltUp10y != null) {
        modelBlock +=
          "Linear 10y forecast (NDBI units): " +
          esc(String(d.linearForecastBuiltUp10y));
      }
      modelBlock += "</div>";
    }
    return (
      "<strong>" +
      esc(area.name) +
      '</strong><br><span class="popup-price">' +
      esc(formatInr(area.pricePerSqft)) +
      "</span> / sqft" +
      modelBlock
    );
  }

  fetch("/api/areas")
    .then((r) => {
      if (!r.ok) throw new Error("API error");
      return r.json();
    })
    .then((payload) => {
      setSignalsLine(payload.signals);

      const areas = payload.areas || [];
      if (!areas.length) return;

      const prices = areas.map((a) => a.pricePerSqft);
      const minP = Math.min(...prices);
      const maxP = Math.max(...prices);
      const span = maxP - minP || 1;

      setLegend(minP, maxP);

      const heatPoints = areas.map((a) => {
        const t = (a.pricePerSqft - minP) / span;
        const intensity = 0.35 + t * 0.9;
        return [a.lat, a.lng, intensity];
      });

      L.heatLayer(heatPoints, {
        radius: 38,
        blur: 22,
        maxZoom: 14,
        max: 1.25,
        gradient: {
          0: "#2166ac",
          0.35: "#67a9cf",
          0.55: "#f7f7f7",
          0.75: "#f4a582",
          1: "#b2182b",
        },
      }).addTo(map);

      const group = L.featureGroup();
      areas.forEach((a) => {
        const m = L.circleMarker([a.lat, a.lng], {
          radius: 7,
          weight: 2,
          color: "#1a2332",
          fillColor: "#3d9cf5",
          fillOpacity: 0.85,
        });
        m.bindPopup(popupHtml(a));
        m.addTo(group);
      });
      group.addTo(map);
      map.fitBounds(group.getBounds().pad(0.12));
    })
    .catch(() => {
      document.getElementById("legend").textContent =
        "Could not load price data. Is the server running?";
    });
})();
