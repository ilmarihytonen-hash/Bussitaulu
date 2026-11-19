import { APP_CONFIG } from "./config.js";

export function createMapController(deps) {
  const { state, t, icon, escapeHtml, routeById, routeLabel, routeColor, relativeArrival, getRadiusKm, onStopClick } = deps;
  const favoriteStopMarkers = new Map();
  let userMarker = null;

  function initialize() {
    if (state.mapReady || typeof window.L === "undefined") return;
    state.map = L.map("live-map", { zoomControl: true, scrollWheelZoom: false }).setView(
      [APP_CONFIG.defaultCenter.lat, APP_CONFIG.defaultCenter.lon], APP_CONFIG.defaultMapZoom
    );
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(state.map);
    state.mapReady = true;
    render();
  }

  function distanceKm(a, b) {
    const radians = (value) => value * Math.PI / 180;
    const dLat = radians(b.lat - a.lat);
    const dLon = radians(b.lon - a.lon);
    const value = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
  }

  function stopName(stop) {
    return stop.stop_name || stop.name || `Stop ${stop.stop_id || stop.id}`;
  }

  function stopListMarkup(vehicle) {
    const language = state.lang;
    const currentStop = {
      stoppointref: vehicle.next_stoppointref,
      stoppointname: vehicle.next_stoppointname,
      stoppointname_en: vehicle.next_stoppointname_en,
      stoppointname_sv: vehicle.next_stoppointname_sv,
      expectedarrivaltime: vehicle.next_expectedarrivaltime || vehicle.next_aimedarrivaltime
    };
    const calls = [currentStop].concat(Array.isArray(vehicle.onwardcalls) ? vehicle.onwardcalls : [])
      .filter((call) => call.stoppointname || call.stoppointref)
      .slice(0, APP_CONFIG.mapStopListLimit);
    if (!calls.length) return `<small>${escapeHtml(t("stopListUnavailable"))}</small>`;
    return `<strong>${escapeHtml(t("upcomingStops"))}</strong><ol class="map-stop-list">${calls.map((call, index) => {
      const name = call[`stoppointname_${language}`] || call.stoppointname || call.stoppointref || t("busStop");
      const epoch = Number(call.expectedarrivaltime || call.aimedarrivaltime || 0);
      const eta = epoch ? relativeArrival(epoch) : "";
      return `<li class="${index === 0 ? "next-map-stop" : ""}"><span>${escapeHtml(name)}</span>${eta ? `<small>${escapeHtml(eta)}</small>` : ""}</li>`;
    }).join("")}</ol>`;
  }

  function renderFavorites() {
    const active = new Set();
    state.favorites.filter((favorite) => favorite.kind === "stop").forEach((favorite) => {
      const stop = state.stops.find((item) => String(item.stop_id != null ? item.stop_id : item.id) === String(favorite.id));
      if (!stop || !Number.isFinite(Number(stop.stop_lat)) || !Number.isFinite(Number(stop.stop_lon))) return;
      const id = String(favorite.id);
      active.add(id);
      let marker = favoriteStopMarkers.get(id);
      if (!marker) {
        marker = L.circleMarker([Number(stop.stop_lat), Number(stop.stop_lon)], {
          radius: 7, color: "#fff", weight: 2, fillColor: "#e4a344", fillOpacity: 1
        }).addTo(state.map);
        marker.on("click", () => onStopClick(stop));
        favoriteStopMarkers.set(id, marker);
      }
      marker.setLatLng([Number(stop.stop_lat), Number(stop.stop_lon)]);
      marker.bindPopup(`<div class="map-popup"><strong>${escapeHtml(stopName(stop))}</strong><small>${escapeHtml(t("favoriteStop"))}</small></div>`);
    });
    favoriteStopMarkers.forEach((marker, id) => {
      if (!active.has(id)) {
        state.map.removeLayer(marker);
        favoriteStopMarkers.delete(id);
      }
    });
  }

  function renderUserLocation() {
    if (!state.userLocation) {
      if (userMarker) {
        state.map.removeLayer(userMarker);
        userMarker = null;
      }
      return;
    }
    const point = [state.userLocation.lat, state.userLocation.lon];
    if (!userMarker) {
      userMarker = L.circleMarker(point, {
        radius: 8, color: "#fff", weight: 3, fillColor: "#2878d0", fillOpacity: 1
      }).addTo(state.map);
      userMarker.bindPopup(`<strong>${escapeHtml(t("youAreHere"))}</strong>`);
    } else {
      userMarker.setLatLng(point);
    }
  }

  function render() {
    if (!state.mapReady || !state.map) return;
    const filter = (document.getElementById("map-filter").value || "").trim().toLocaleLowerCase();
    const center = state.userLocation || APP_CONFIG.defaultCenter;
    const radiusKm = getRadiusKm();
    const favoriteRoutes = new Set(state.favorites.filter((favorite) => favorite.kind === "route").map((favorite) => String(favorite.id)));
    const active = new Set();
    let visibleCount = 0;
    state.vehicles.forEach((vehicle) => {
      const routeId = String(vehicle.lineref || "");
      const label = vehicle.publishedlinename || (routeById(routeId) && routeLabel(routeById(routeId))) || routeId || "·";
      const isFavorite = favoriteRoutes.has(routeId);
      if (filter && !isFavorite && !String(label).toLocaleLowerCase().includes(filter) && !routeId.toLocaleLowerCase().includes(filter)) return;
      if (!filter) {
        const isNearby = distanceKm(center, { lat: Number(vehicle.latitude), lon: Number(vehicle.longitude) }) <= radiusKm;
        if (!isNearby && !isFavorite) return;
      }
      const id = String(vehicle.vehicleId);
      const route = routeById(vehicle.lineref);
      active.add(id);
      visibleCount += 1;
      const color = route ? routeColor(route) : "#176d59";
      const html = `<div class="bus-marker" style="--marker-color:${color}">${icon("bus")}<span>${escapeHtml(label)}</span></div>`;
      const coords = [Number(vehicle.latitude), Number(vehicle.longitude)];
      const destination = vehicle[`destinationdisplay_${state.lang}`] || vehicle.destinationdisplay || vehicle.destinationname || "";
      const nextStop = vehicle[`next_stoppointname_${state.lang}`] || vehicle.next_stoppointname || t("stopListUnavailable");
      const popup = `<div class="map-popup"><strong>${escapeHtml(t("line"))} ${escapeHtml(label)} · ${escapeHtml(destination)}</strong><small>${escapeHtml(t("nextStop"))}: ${escapeHtml(nextStop)}${vehicle.next_expectedarrivaltime ? ` · ${escapeHtml(relativeArrival(Number(vehicle.next_expectedarrivaltime)))}` : ""}</small>${stopListMarkup(vehicle)}</div>`;
      const existing = state.markers.get(id);
      if (existing) {
        existing.setLatLng(coords);
        existing.setIcon(L.divIcon({ className: "bus-marker-wrap", html, iconSize: [90, 34], iconAnchor: [40, 17] }));
        existing.setPopupContent(popup);
      } else {
        const marker = L.marker(coords, {
          title: `${t("line")} ${label} · ${vehicle.next_stoppointname || ""}`,
          icon: L.divIcon({ className: "bus-marker-wrap", html, iconSize: [90, 34], iconAnchor: [40, 17] })
        }).addTo(state.map);
        marker.bindPopup(popup, { maxWidth: 280 });
        state.markers.set(id, marker);
      }
    });
    state.markers.forEach((marker, id) => {
      if (!active.has(id)) {
        state.map.removeLayer(marker);
        state.markers.delete(id);
      }
    });
    renderFavorites();
    renderUserLocation();
    document.getElementById("map-loading").hidden = true;
    const now = new Intl.DateTimeFormat(state.lang, { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Helsinki" }).format(new Date());
    document.getElementById("map-updated").textContent = `${t("updated")} ${now} · ${visibleCount}`;
    document.getElementById("map-area-status").textContent = filter ? t("lineFilterOverridesArea") : `${t("showingNearbyArea")} · ${radiusKm} km`;
  }

  function focusUser() {
    if (!state.userLocation || !state.map) return;
    state.map.setView([state.userLocation.lat, state.userLocation.lon], Math.max(state.map.getZoom(), 14));
  }

  function clearUserLocation() {
    state.userLocation = null;
    renderUserLocation();
    if (state.map) state.map.setView(
      [APP_CONFIG.defaultCenter.lat, APP_CONFIG.defaultCenter.lon], APP_CONFIG.defaultMapZoom
    );
    render();
  }

  return { initialize, render, focusUser, clearUserLocation };
}
