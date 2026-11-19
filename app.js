import { API, createApiClient, fetchWeather, normalizeStops, normalizeVehicles } from "./modules/api.js";
import { APP_CONFIG } from "./modules/config.js";
import { createMapController } from "./modules/map.js";
import { icons, translations } from "./modules/i18n.js";
import { initializeSettings } from "./modules/settings.js";

"use strict";

(() => {
  const TURKU = APP_CONFIG.defaultCenter;
  const LOCALE_KEY = "bussitaulu-language";
  const FAVORITES_KEY = "bussitaulu-favorites";
  const HISTORY_KEY = "bussitaulu-arrival-history-v1";
  const TERMS_KEY = "bussitaulu-terms-version";
  const TERMS_VERSION = APP_CONFIG.termsVersion;
  const HISTORY_DAYS = 30;
  const SIGNAL_CACHE_TTL = APP_CONFIG.trafficSignalCacheTtlMs;
  const SIGNAL_ENDPOINT = APP_CONFIG.trafficSignalApiUrl;
  const state = {
    lang: loadLanguage(),
    searchMode: "stop",
    stops: [], routes: [], calendars: {}, calendarExceptions: {}, vehicles: [], favorites: loadFavorites(), weather: null,
    history: loadHistory(), historyAvailable: true, vehiclePositions: new Map(), vehicleSpeeds: new Map(),
    signalCounts: new Map(), signalLookups: new Map(), signalFailures: new Map(), estimateData: null,
    selectedEstimateStop: null, map: null, markers: new Map(), mapReady: false,
    userLocation: null, refreshing: false, lastFavoriteAlert: "", currentView: "departures", activeModalStop: null,
    lastLiveRefresh: 0
  };
  let toastTimer;
  let refreshTimer;
  let quickMapRefreshTimer;
  let mapFilterRefreshTimer;
  let dailyTimer;
  let settingsController;
  let mapController;
  let apiHealth = "healthy";
  let displayedDateKey = helsinkiDateKey();

  function t(key) { return translations[state.lang][key] || translations.en[key] || key; }
  function icon(name, extraClass) {
    return `<svg class="${extraClass || ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.info}</svg>`;
  }
  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }
  function loadLanguage() {
    try {
      const saved = localStorage.getItem(LOCALE_KEY);
      return ["fi", "en", "sv"].includes(saved) ? saved : "fi";
    } catch (error) {
      console.warn("Could not read the saved language.", error);
      return "fi";
    }
  }
  function loadFavorites() {
    try {
      const saved = JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]");
      return Array.isArray(saved) ? saved.filter((item) => item && (item.kind === "stop" || item.kind === "route") && item.id != null) : [];
    } catch (error) {
      console.warn("Could not read saved favorites.", error);
      return [];
    }
  }
  function helsinkiDateKey(date) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Helsinki", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date || new Date());
    const part = (name) => parts.find((value) => value.type === name).value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  }
  function loadHistory() {
    try {
      const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) || "null");
      if (!saved || saved.version !== 1 || !Array.isArray(saved.observations)) {
        return { version: 1, activeDate: helsinkiDateKey(), observations: [] };
      }
      return { version: 1, activeDate: helsinkiDateKey(), observations: saved.observations };
    } catch (error) {
      console.warn("Could not read local arrival history; starting a new history.", error);
      return { version: 1, activeDate: helsinkiDateKey(), observations: [] };
    }
  }
  function saveHistory() {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history));
      state.historyAvailable = true;
    } catch (error) {
      state.historyAvailable = false;
      console.error("Could not save local arrival history.", error);
    }
  }
  function ensureDailyHistory() {
    const today = helsinkiDateKey();
    const rolledOver = state.history.activeDate !== today;
    const oldestDate = new Date(`${today}T00:00:00Z`);
    oldestDate.setUTCDate(oldestDate.getUTCDate() - (HISTORY_DAYS - 1));
    const cutoff = oldestDate.toISOString().slice(0, 10);
    const previousLength = state.history.observations.length;
    state.history.activeDate = today;
    state.history.observations = state.history.observations.filter((item) =>
      item && typeof item.date === "string" && item.date >= cutoff && item.date <= today &&
      item.stopId != null && item.routeId != null && Number.isFinite(Number(item.deviationMinutes))
    );
    if (rolledOver || previousLength !== state.history.observations.length) saveHistory();
    return rolledOver;
  }
  function recordStopObservations(stopIdValue, payload) {
    if (!payload || payload.status !== "OK" || !Array.isArray(payload.result)) return;
    ensureDailyHistory();
    const stopIdString = String(stopIdValue);
    const now = Math.floor(Date.now() / 1000);
    let changed = false;
    payload.result.forEach((item) => {
      if (item.monitored !== true || item.vehicleatstop !== true || !item.lineref) return;
      const scheduledTime = Number(item.aimedarrivaltime || 0);
      const observedAt = Number(item.recordedattime || payload.servertime || now);
      if (!scheduledTime || Math.abs(observedAt - scheduledTime) > 45 * 60) return;
      const tripKey = item.datedvehiclejourneyref || item.__tripref || `${item.vehicleref || ""}:${item.lineref}:${scheduledTime}`;
      const date = helsinkiDateKey(new Date(observedAt * 1000));
      const key = `${date}:${stopIdString}:${tripKey}`;
      if (state.history.observations.some((record) => record.key === key)) return;
      state.history.observations.push({
        key,
        date,
        stopId: stopIdString,
        routeId: String(item.lineref),
        deviationMinutes: (observedAt - scheduledTime) / 60,
        observedAt
      });
      changed = true;
    });
    if (changed) {
      ensureDailyHistory();
      saveHistory();
    }
  }
  function historyStats(stopIdValue, routeId) {
    ensureDailyHistory();
    const today = state.history.activeDate;
    const matching = state.history.observations.filter((item) =>
      item.stopId === String(stopIdValue) && item.routeId === String(routeId)
    );
    const todaySamples = matching.filter((item) => item.date === today);
    const previousSamples = matching.filter((item) => item.date < today);
    const average = (samples) => samples.length ? samples.reduce((sum, item) => sum + Number(item.deviationMinutes), 0) / samples.length : null;
    const previousAverage = average(previousSamples);
    const confidence = previousSamples.length / (previousSamples.length + 5);
    const adjustmentMinutes = previousSamples.length >= 3
      ? Math.max(-5, Math.min(5, previousAverage * confidence * 0.35))
      : 0;
    return {
      todayAverage: average(todaySamples),
      todayCount: todaySamples.length,
      previousAverage,
      previousCount: previousSamples.length,
      adjustmentMinutes
    };
  }
  function formatDeviation(value) {
    if (value == null || !Number.isFinite(value)) return "—";
    const rounded = Math.round(Math.abs(value) * 10) / 10;
    if (rounded < 0.1) return `0 ${t("minuteValue")}`;
    return `${rounded} ${t("minuteValue")} ${value < 0 ? t("earlyBy") : t("lateBy")}`;
  }
  function setStatus(key) {
    const node = document.getElementById("service-status-text");
    if (node) node.textContent = t(key);
  }
  function renderIcons(root) {
    (root || document).querySelectorAll("[data-icon]").forEach((node) => {
      node.innerHTML = icon(node.dataset.icon);
    });
  }
  function applyLanguage() {
    document.documentElement.lang = state.lang;
    document.getElementById("language-select").value = state.lang;
    document.querySelectorAll("[data-i18n]").forEach((node) => {
      const value = t(node.dataset.i18n);
      if (value) node.textContent = value;
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
      node.placeholder = t(node.dataset.i18nPlaceholder);
    });
    document.querySelectorAll("[aria-label]").forEach((node) => {
      const key = node.dataset.i18nAria;
      if (key) node.setAttribute("aria-label", t(key));
    });
    document.getElementById("main-search").setAttribute("aria-label", t(state.searchMode === "stop" ? "searchStops" : "searchLine"));
    document.getElementById("route-search").setAttribute("aria-label", t("searchLine"));
    document.getElementById("estimate-search").setAttribute("aria-label", t("searchStops"));
    document.getElementById("map-filter").setAttribute("aria-label", t("mapLinesFilter"));
    document.querySelectorAll(".search-tab").forEach((tab) => {
      tab.setAttribute("aria-selected", String(tab.dataset.searchMode === state.searchMode));
    });
    document.querySelectorAll("[data-search-mode]").forEach((tab) => tab.classList.toggle("active", tab.dataset.searchMode === state.searchMode));
    renderIcons();
    if (settingsController) settingsController.refreshLanguage();
    renderWeather();
    renderNearby();
    renderQuickFavorites();
    renderFavoritePage();
    renderRoutes(document.getElementById("route-search").value);
    renderMapMarkers();
    if (apiHealth !== "healthy") updateApiHealth(apiHealth);
    renderEstimate();
  }
  function restoreRouteTimetable(routeId, stopId) {
    if (!routeId) return;
    openRoute(routeId);
    if (!stopId) return;
    const stop = stopById(stopId);
    if (!stop) return;
    const input = document.getElementById("route-stop-search");
    input.value = stopName(stop);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const match = [...document.querySelectorAll("#route-stop-results [data-route-stop]")]
      .find((button) => button.dataset.routeStop === String(stopId));
    if (match) match.click();
  }
  function updateToday() {
    const options = { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Helsinki" };
    document.getElementById("today-label").textContent = new Intl.DateTimeFormat(state.lang, options).format(new Date());
  }
  function updateApiHealth(status) {
    apiHealth = status;
    const banner = document.getElementById("api-status-banner");
    if (status === "healthy") {
      banner.hidden = true;
      return;
    }
    const degraded = status === "degraded";
    document.getElementById("api-status-title").textContent = t(degraded ? "apiDegradedTitle" : "apiProblemTitle");
    document.getElementById("api-status-message").textContent = t(degraded ? "apiDegradedMessage" : "apiProblemMessage");
    banner.hidden = false;
  }
  const apiClient = createApiClient(updateApiHealth);
  function apiFetch(url, options) {
    return apiClient.fetchJson(url, options);
  }
  function weatherFetch(lat, lon) {
    return fetchWeather(lat, lon).then((data) => {
      state.weather = data.current || null;
      renderWeather();
      renderEstimate();
    }).catch((error) => {
      console.warn("Weather data could not be loaded.", error);
      state.weather = null;
      renderWeather();
      renderEstimate();
    });
  }
  function weatherDescription(code) {
    if (code === 0 || code === 1) return t("weatherClear");
    if (code === 2 || code === 3) return t("weatherCloudy");
    if ([45, 48].includes(code)) return t("weatherFog");
    if ([71, 73, 75, 77, 85, 86].includes(code)) return t("weatherSnow");
    if ([95, 96, 99].includes(code)) return t("weatherStorm");
    return t("weatherRain");
  }
  function weatherIcon(code) {
    if (code === 0 || code === 1) return "☀";
    if (code === 2 || code === 3 || (code >= 45 && code <= 48)) return "☁";
    if ([71, 73, 75, 77, 85, 86].includes(code)) return "❄";
    return "☂";
  }
  function renderWeather() {
    const temp = document.getElementById("weather-temperature");
    const desc = document.getElementById("weather-description");
    const iconNode = document.querySelector(".weather-icon");
    if (state.weather) {
      temp.textContent = `${Math.round(state.weather.temperature_2m)}°`;
      desc.textContent = weatherDescription(state.weather.weather_code);
      iconNode.textContent = weatherIcon(state.weather.weather_code);
    } else {
      temp.textContent = "--°";
      desc.textContent = t("weatherUnavailable");
      iconNode.textContent = "☁";
    }
    const detail = document.getElementById("weather-detail");
    if (detail) {
      const info = detail.querySelector("strong");
      const secondary = detail.querySelector("small");
      const image = detail.querySelector(".weather-detail-icon");
      if (state.weather) {
        info.textContent = `${weatherIcon(state.weather.weather_code)} ${Math.round(state.weather.temperature_2m)}° · ${weatherDescription(state.weather.weather_code)}`;
        secondary.textContent = `${t("turkuWeather")} · ${Math.round(state.weather.wind_speed_10m || 0)} km/h`;
        image.textContent = weatherIcon(state.weather.weather_code);
      } else {
        info.textContent = t("weatherUnavailable");
        secondary.textContent = t("turkuWeather");
      }
    }
  }
  function stopId(stop) { return String(stop.stop_id != null ? stop.stop_id : stop.id); }
  function stopName(stop) { return stop.stop_name || stop.name || `Stop ${stopId(stop)}`; }
  function routeLabel(route) { return String(route.route_short_name || route.route_id || "—"); }
  function routeColor(route) {
    const color = String(route.route_color || "176d59").replace("#", "");
    return /^[0-9a-f]{6}$/i.test(color) ? `#${color}` : "#176d59";
  }
  function routeById(id) { return state.routes.find((route) => String(route.route_id) === String(id)); }
  function stopById(id) { return state.stops.find((stop) => stopId(stop) === String(id)); }
  function favoriteKey(kind, id) { return `${kind}:${id}`; }
  function isFavorite(kind, id) { return state.favorites.some((item) => favoriteKey(item.kind, item.id) === favoriteKey(kind, id)); }
  function toggleFavorite(kind, id, name, meta) {
    const exists = isFavorite(kind, id);
    if (exists) state.favorites = state.favorites.filter((item) => favoriteKey(item.kind, item.id) !== favoriteKey(kind, id));
    else state.favorites.unshift({ kind, id: String(id), name, meta: meta || "" });
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(state.favorites));
    } catch (error) {
      console.error("Could not save favorites.", error);
      showToast(t("errorTitle"), "error");
      return;
    }
    renderQuickFavorites();
    renderFavoritePage();
    renderNearby();
    renderRoutes(document.getElementById("route-search").value);
    renderMapMarkers();
    document.getElementById("favorite-count").textContent = state.favorites.length;
    showToast(t(exists ? "favoriteRemoved" : "favoriteSaved"), "success");
    if (kind === "stop") checkFavoriteArrivals();
  }
  function showToast(message, type) {
    const region = document.getElementById("toast-region");
    region.innerHTML = `<div class="toast ${type || ""}">${icon(type === "error" ? "info" : "spark")}<span>${escapeHtml(message)}</span></div>`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { region.innerHTML = ""; }, 3800);
  }
  function switchView(name) {
    const valid = ["departures", "lines", "map", "estimator", "favorites", "settings"].includes(name) ? name : "departures";
    state.currentView = valid;
    document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${valid}`));
    document.querySelectorAll("[data-view]").forEach((button) => {
      const active = button.dataset.view === valid;
      button.classList.toggle("active", active);
      if (button.classList.contains("mobile-nav-item")) {
        if (active) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
      }
    });
    if (valid === "map") {
      setTimeout(() => {
        initializeMap();
        if (state.map) state.map.invalidateSize();
        renderMapMarkers();
        if (state.userLocation && mapController) mapController.focusUser();
        if (document.getElementById("map-filter").value.trim()) refreshLiveData();
      }, 80);
    }
    if (valid === "estimator" && state.estimateData) renderEstimateResults(state.estimateData.stop, state.estimateData.data);
  }
  function bindNavigation() {
    document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
    document.querySelectorAll("[data-open-view]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.openView)));
    document.getElementById("map-preview-button").addEventListener("click", () => switchView("map"));
  }
  function stopSearchMatches(query, max) {
    const text = query.trim().toLocaleLowerCase();
    if (!text) return [];
    return state.stops.filter((stop) => `${stopName(stop)} ${stopId(stop)} ${stop.stop_code || ""}`.toLocaleLowerCase().includes(text)).slice(0, max || 7);
  }
  function routeSearchMatches(query, max) {
    const text = query.trim().toLocaleLowerCase();
    if (!text) return [];
    return state.routes.filter((route) => `${routeLabel(route)} ${route.route_long_name || ""} ${route.route_desc || ""}`.toLocaleLowerCase().includes(text)).slice(0, max || 8);
  }
  function renderSearchResults(input, resultsNode, kind, query) {
    if (input.id === "main-search") kind = state.searchMode;
    if (!query.trim()) {
      resultsNode.hidden = true;
      resultsNode.innerHTML = "";
      return;
    }
    const matches = kind === "stop" ? stopSearchMatches(query) : routeSearchMatches(query);
    if (!matches.length) {
      resultsNode.innerHTML = `<div class="search-empty">${escapeHtml(t(kind === "stop" ? "stopSearchEmpty" : "routeSearchEmpty"))}</div>`;
      resultsNode.hidden = false;
      return;
    }
    resultsNode.innerHTML = matches.map((item) => kind === "stop"
      ? `<button class="search-result" role="option" data-stop-id="${escapeHtml(stopId(item))}"><span class="result-icon">${icon("pin")}</span><span class="result-copy"><strong>${escapeHtml(stopName(item))}</strong><small>${escapeHtml(t("stopId"))} ${escapeHtml(stopId(item))}</small></span>${icon("chevron")}</button>`
      : `<button class="search-result" role="option" data-route-id="${escapeHtml(item.route_id)}"><span class="route-pill" style="--route-color:${routeColor(item)}">${escapeHtml(routeLabel(item))}</span><span class="result-copy"><strong>${escapeHtml(item.route_long_name || routeLabel(item))}</strong></span>${icon("chevron")}</button>`
    ).join("");
    resultsNode.hidden = false;
    resultsNode.querySelectorAll("[data-stop-id]").forEach((button) => button.addEventListener("click", () => {
      const stop = stopById(button.dataset.stopId);
      if (input.id === "estimate-search") selectEstimateStop(stop);
      else openStopModal(stop);
      input.value = "";
      resultsNode.hidden = true;
      document.getElementById(input.id === "main-search" ? "clear-search" : input.id === "estimate-search" ? "clear-estimate-search" : "clear-route-search").hidden = true;
    }));
    resultsNode.querySelectorAll("[data-route-id]").forEach((button) => button.addEventListener("click", () => {
      resultsNode.hidden = true;
      input.value = "";
      openRoute(button.dataset.routeId);
    }));
  }
  function bindSearch(inputId, resultsId, kind, clearId) {
    const input = document.getElementById(inputId);
    const results = document.getElementById(resultsId);
    const clear = document.getElementById(clearId);
    input.addEventListener("input", () => {
      clear.hidden = !input.value;
      renderSearchResults(input, results, inputId === "main-search" ? state.searchMode : kind, input.value);
    });
    clear.addEventListener("click", () => {
      input.value = "";
      clear.hidden = true;
      results.hidden = true;
      input.focus();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") results.hidden = true;
      if (event.key === "Enter") {
        renderSearchResults(input, results, inputId === "main-search" ? state.searchMode : kind, input.value);
        const first = results.querySelector("[data-stop-id], [data-route-id]");
        if (first) first.click();
      }
    });
    document.addEventListener("click", (event) => {
      if (!results.contains(event.target) && event.target !== input) results.hidden = true;
    });
  }
  function formatTime(epoch) {
    return new Intl.DateTimeFormat(state.lang, { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Helsinki" }).format(new Date(epoch * 1000));
  }
  function relativeArrival(epoch) {
    const minutes = Math.max(0, Math.round((epoch * 1000 - Date.now()) / 60000));
    return minutes <= 1 ? t("now") : `${minutes} ${t("minutes")}`;
  }
  function scheduleMinutes(value) {
    if (typeof value !== "string") return NaN;
    const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value);
    return match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
  }
  function epochHelsinkiMinutes(epoch) {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Helsinki", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(epoch * 1000));
    const hour = Number(parts.find((part) => part.type === "hour").value);
    const minute = Number(parts.find((part) => part.type === "minute").value);
    return hour * 60 + minute;
  }
  function currentHelsinkiMinutes() {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Helsinki", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
    const hours = Number(parts.find((part) => part.type === "hour").value);
    const minutes = Number(parts.find((part) => part.type === "minute").value);
    return hours * 60 + minutes;
  }
  function upcomingScheduleRows(times) {
    const nowMinutes = currentHelsinkiMinutes();
    return (Array.isArray(times) ? times : []).map((item) => {
      const scheduledMinutes = scheduleMinutes(item.departure_time || item.arrival_time);
      let until = scheduledMinutes - nowMinutes;
      if (until < 0 && scheduledMinutes < 24 * 60) until += 24 * 60;
      return Object.assign({}, item, { scheduledMinutes, until });
    }).filter((item) => Number.isFinite(item.scheduledMinutes) && item.until >= 0 && item.until <= 180)
      .sort((a, b) => a.until - b.until);
  }
  function helsinkiDateParts() {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Helsinki", year: "numeric", month: "2-digit", day: "2-digit", weekday: "long" }).formatToParts(new Date());
    const part = (name) => parts.find((value) => value.type === name).value;
    return { date: `${part("year")}${part("month")}${part("day")}`, weekday: part("weekday").toLowerCase() };
  }
  function isServiceActive(serviceId) {
    const { date, weekday } = helsinkiDateParts();
    const exceptions = state.calendarExceptions[serviceId] || [];
    const exception = exceptions.find((item) => item.date === date);
    if (exception) return Number(exception.exception_type) === 1;
    const calendar = state.calendars[serviceId];
    if (!calendar) return true;
    return date >= String(calendar.start_date || "") && date <= String(calendar.end_date || "") && calendar[weekday] === true;
  }
  async function enrichScheduledDepartures(rows) {
    const upcoming = rows.filter((item) => item.trip_id).slice(0, 24);
    for (let index = 0; index < upcoming.length; index += 4) {
      const batch = upcoming.slice(index, index + 4);
      const details = await Promise.allSettled(batch.map((item) =>
        apiFetch(`${API}/gtfs/trips/trip/${encodeURIComponent(item.trip_id)}`)
      ));
      details.forEach((result, offset) => {
        if (result.status !== "fulfilled") {
          console.warn(`Could not resolve route for scheduled trip ${batch[offset].trip_id}.`, result.reason);
          return;
        }
        const trip = Array.isArray(result.value) ? result.value[0] : result.value;
        if (!trip) return;
        batch[offset].route_id = trip.route_id;
        batch[offset].service_id = trip.service_id;
        batch[offset].trip_headsign = trip.trip_headsign;
      });
    }
    const active = rows.filter((item) => item.route_id && (!item.service_id || isServiceActive(item.service_id)));
    const unique = new Map();
    active.forEach((item) => {
      const key = `${item.route_id}:${item.scheduledMinutes}:${item.trip_headsign || item.stop_headsign || ""}`;
      if (!unique.has(key)) unique.set(key, item);
    });
    return [...unique.values()].slice(0, 12);
  }
  async function stopDepartures(id) {
    const [liveResult, timesResult] = await Promise.allSettled([
      apiFetch(`${API}/siri/stops/${encodeURIComponent(id)}`, { noCache: true }),
      apiFetch(`${API}/gtfs/stop_times/stop/${encodeURIComponent(id)}`)
    ]);
    let live = [];
    let scheduled = [];
    if (liveResult.status === "fulfilled" && liveResult.value && liveResult.value.status === "OK" && Array.isArray(liveResult.value.result)) {
      live = liveResult.value.result;
      recordStopObservations(id, liveResult.value);
    }
    if (timesResult.status === "fulfilled") scheduled = await enrichScheduledDepartures(upcomingScheduleRows(timesResult.value));
    if (liveResult.status === "rejected" && timesResult.status === "rejected") throw liveResult.reason;
    const enrichedLive = live.map((item) => {
      const planned = Number(item.aimedarrivaltime || 0);
      const expected = Number(item.expectedarrivaltime || 0);
      return Object.assign({}, item, { resolvedTime: expected || planned, tripId: item.__tripref || item.trip_id });
    }).filter((item) => item.resolvedTime > 0).sort((a, b) => a.resolvedTime - b.resolvedTime);
    return { live: enrichedLive, scheduled };
  }
  async function openStopModal(stop) {
    if (!stop) return;
    state.activeModalStop = stop;
    const backdrop = document.getElementById("modal-backdrop");
    const content = document.getElementById("stop-modal-content");
    const id = stopId(stop);
    const name = stopName(stop);
    content.innerHTML = `<p class="section-kicker">${escapeHtml(t("stopDetails"))} · ${escapeHtml(id)}</p><div class="modal-title-row"><div><h2 id="stop-modal-title">${escapeHtml(name)}</h2><p class="modal-subtitle">${escapeHtml(t("stopTimetable"))}</p></div><button class="star-button ${isFavorite("stop", id) ? "is-favorite" : ""}" id="modal-favorite" aria-label="${escapeHtml(t(isFavorite("stop", id) ? "removeFavorite" : "addFavorite"))}">${icon("star")}</button></div><div class="modal-arrivals" id="modal-arrivals"><div class="loading-line"><span class="loader"></span><span>${escapeHtml(t("nearbyLoading"))}</span></div></div><div class="source-note modal-credit">${escapeHtml(t("sourceCredit"))}</div>`;
    backdrop.hidden = false;
    document.body.classList.add("modal-open");
    document.getElementById("modal-favorite").addEventListener("click", () => {
      toggleFavorite("stop", id, name);
      const button = document.getElementById("modal-favorite");
      button.classList.toggle("is-favorite", isFavorite("stop", id));
      button.setAttribute("aria-label", t(isFavorite("stop", id) ? "removeFavorite" : "addFavorite"));
    });
    try {
      const data = await stopDepartures(id);
      const target = document.getElementById("modal-arrivals");
      if (!target || state.activeModalStop !== stop) return;
      target.innerHTML = departureMarkup(data, "modal");
    } catch (error) {
      console.error("Could not load this stop's departures.", error);
      const target = document.getElementById("modal-arrivals");
      if (target) target.innerHTML = `<div class="inline-error">${escapeHtml(t("departuresError"))}</div>`;
    }
  }
  function closeStopModal() {
    document.getElementById("modal-backdrop").hidden = true;
    document.body.classList.remove("modal-open");
    state.activeModalStop = null;
  }
  function departureMarkup(data, mode) {
    const arrivals = data.live || [];
    const scheduled = data.scheduled || [];
    const rows = [];
    const used = new Set();
    arrivals.forEach((item) => {
      const route = routeById(item.lineref);
      const line = item.lineref || "—";
      const time = item.resolvedTime;
      const plannedTime = Number(item.aimedarrivaltime || 0);
      if (item.tripId) used.add(item.tripId);
      const localizedDestination = item[`destinationdisplay_${state.lang}`];
      rows.push({ line, destination: localizedDestination || item.destinationdisplay || item.destinationname || item.next_destinationdisplay || route && route.route_long_name || "", epoch: time, planned: plannedTime, live: Boolean(item.monitored), delay: Number(item.delay || 0), tripId: item.tripId });
    });
    const currentMin = currentHelsinkiMinutes();
    scheduled.forEach((item) => {
      if (item.until < 0 || item.until > 150) return;
      if (item.trip_id && used.has(item.trip_id)) return;
      const route = routeById(item.route_id);
      rows.push({ line: route ? routeLabel(route) : "—", destination: item.trip_headsign || item.stop_headsign || route && route.route_long_name || "", timeLabel: minutesToClock(item.scheduledMinutes), minutes: item.until, live: false });
    });
    rows.sort((a, b) => (a.epoch ? (a.epoch * 1000 - Date.now()) / 60000 : a.minutes) - (b.epoch ? (b.epoch * 1000 - Date.now()) / 60000 : b.minutes));
    const items = rows.slice(0, 12);
    if (!items.length) return `<div class="empty-state small-empty"><strong>${escapeHtml(t("noDepartures"))}</strong></div>`;
    return `<div class="departure-table"><div class="departure-head"><span>${escapeHtml(t("line"))}</span><span>${escapeHtml(t("destination"))}</span><span>${escapeHtml(t("arrival"))}</span></div>${items.map((item) => {
      const route = routeById(item.line);
      const eta = item.epoch ? relativeArrival(item.epoch) : `${item.minutes <= 1 ? t("now") : `${item.minutes} ${t("minutes")}`}`;
      const clock = item.epoch ? formatTime(item.epoch) : item.timeLabel;
      return `<div class="departure-row"><span class="route-pill" style="--route-color:${route ? routeColor(route) : "#6e7c77"}">${escapeHtml(item.line)}</span><span class="departure-destination">${escapeHtml(item.destination || t("destination"))}</span><span class="departure-times"><strong class="${item.live ? "live-eta" : ""}">${escapeHtml(eta)}</strong><small>${escapeHtml(clock || "")}${item.live ? ` · ${escapeHtml(t("live"))}` : ` · ${escapeHtml(t("scheduled"))}`}</small></span></div>`;
    }).join("")}</div>`;
  }
  function minutesToClock(minutes) {
    const adjusted = minutes % (24 * 60);
    return `${String(Math.floor(adjusted / 60)).padStart(2, "0")}:${String(adjusted % 60).padStart(2, "0")}`;
  }
  function selectEstimateStop(stop) {
    if (!stop) return;
    state.selectedEstimateStop = stop;
    const input = document.getElementById("estimate-search");
    input.value = stopName(stop);
    document.getElementById("estimate-stop-picker").hidden = true;
    document.getElementById("estimate-choose-stop-label").textContent = t("changeStop");
    document.getElementById("clear-estimate-search").hidden = false;
    document.getElementById("estimate-results").hidden = true;
    const selected = document.getElementById("estimate-selected");
    selected.hidden = false;
    selected.innerHTML = `<span class="result-icon">${icon("pin")}</span><span class="result-copy"><strong>${escapeHtml(stopName(stop))}</strong><small>${escapeHtml(t("stopId"))} ${escapeHtml(stopId(stop))}</small></span><button class="star-button ${isFavorite("stop", stopId(stop)) ? "is-favorite" : ""}" id="estimate-favorite" aria-label="${escapeHtml(t(isFavorite("stop", stopId(stop)) ? "removeFavorite" : "addFavorite"))}">${icon("star")}</button>`;
    document.getElementById("estimate-favorite").addEventListener("click", () => {
      toggleFavorite("stop", stopId(stop), stopName(stop));
      selectEstimateStop(stop);
    });
    renderEstimate();
    loadEstimate(stop);
  }
  async function loadEstimate(stop) {
    const list = document.getElementById("estimate-list");
    list.innerHTML = `<div class="loading-line"><span class="loader"></span><span>${escapeHtml(t("nearbyLoading"))}</span></div>`;
    try {
      const data = await stopDepartures(stopId(stop));
      if (state.selectedEstimateStop !== stop) return;
      const estimateData = { live: data.live.filter((item) => item.monitored === true), scheduled: data.scheduled };
      state.estimateData = { stop, data: estimateData };
      renderEstimateResults(stop, estimateData);
      const routes = new Set();
      const lookups = [];
      estimateData.live.forEach((item) => {
        const routeId = String(item.lineref || "");
        if (!routeId || routes.has(routeId) || routes.size >= 3 || !item.latitude || !item.longitude) return;
        routes.add(routeId);
        lookups.push(trafficSignalCount(stop, routeId, item));
      });
      if (lookups.length) {
        Promise.all(lookups).then(() => {
          if (state.selectedEstimateStop === stop) renderEstimateResults(stop, estimateData);
        });
      }
    } catch (error) {
      console.error("Could not load arrival estimates.", error);
      list.innerHTML = `<div class="inline-error">${escapeHtml(t("departuresError"))}</div>`;
    }
  }
  function renderEstimateResults(stop, data) {
    const list = document.getElementById("estimate-list");
    const live = data.live.slice(0, 8);
    if (!live.length) {
      const scheduled = data.scheduled.slice(0, 8);
      const rows = scheduled.map((item) => {
        const route = routeById(item.route_id);
        const line = route ? routeLabel(route) : "—";
        const color = route ? routeColor(route) : "#176d59";
        const destination = item.trip_headsign || item.stop_headsign || route && route.route_long_name || t("destination");
        const time = minutesToClock(item.scheduledMinutes);
        return `<article class="estimate-row schedule-only"><span class="route-pill estimate-route" style="--route-color:${color}">${escapeHtml(line)}</span><div class="estimate-copy"><strong>${escapeHtml(destination)}</strong><div class="estimate-time-grid"><span><small>${escapeHtml(t("scheduledTime"))}</small><strong>${escapeHtml(time)}</strong></span><span><small>${escapeHtml(t("liveTime"))}</small><strong>—</strong></span><span><small>${escapeHtml(t("smartTime"))}</small><strong>—</strong></span></div><small class="estimate-factors">${escapeHtml(t("noLiveEstimate"))}</small></div></article>`;
      }).join("");
      list.innerHTML = `${rows ? `<div class="estimate-list">${rows}</div>` : `<div class="empty-state"><span class="empty-icon">${icon("bus")}</span><strong>${escapeHtml(t("noDepartures"))}</strong><small>${escapeHtml(t("trafficWeatherInputs"))}</small></div>`}${scheduled.length ? `<div class="history-summary"><strong>${escapeHtml(t("collectHistory"))}</strong><small>${escapeHtml(t("estimateModelNote"))}</small></div>` : ""}`;
      return;
    }
    const rows = live.map((item) => {
      const route = routeById(item.lineref);
      const routeId = String(item.lineref || "");
      const line = routeId || "—";
      const destination = item[`destinationdisplay_${state.lang}`] || item.destinationdisplay || item.destinationname || item.next_destinationdisplay || t("destination");
      const scheduledEpoch = Number(item.aimedarrivaltime || 0);
      const liveEpoch = Number(item.resolvedTime || scheduledEpoch || 0);
      const plannedMinutes = scheduledEpoch ? formatTime(scheduledEpoch) : "—";
      const liveMinutes = Math.max(0, (liveEpoch * 1000 - Date.now()) / 60000);
      const speedEntry = item.vehicleref && state.vehicleSpeeds.get(String(item.vehicleref));
      const speed = speedEntry && Date.now() - speedEntry.at < 180000 ? speedEntry.kmh : null;
      const distance = item.latitude && item.longitude && Number.isFinite(Number(stop.stop_lat)) && Number.isFinite(Number(stop.stop_lon))
        ? haversine(Number(item.latitude), Number(item.longitude), Number(stop.stop_lat), Number(stop.stop_lon))
        : null;
      const speedEta = speed && speed > 5 && distance > 0.1 ? distance * 1.3 * 60 / speed : null;
      const speedAdjustment = speedEta == null ? 0 : Math.max(-2, Math.min(2, (speedEta - liveMinutes) * 0.2));
      const trafficAdjustment = item.incongestion ? 2 : 0;
      const signals = state.signalCounts.has(`${routeId}:${stopId(stop)}`) ? state.signalCounts.get(`${routeId}:${stopId(stop)}`) : null;
      const signalAdjustment = signals == null ? 0 : Math.min(signals * 0.25, 3);
      const weatherMinutes = weatherAdjustment();
      const history = historyStats(stopId(stop), routeId);
      const historicalAdjustment = history.adjustmentMinutes;
      const adjustment = weatherMinutes + trafficAdjustment + signalAdjustment + speedAdjustment + historicalAdjustment;
      const estimateEpoch = Math.max(Math.floor(Date.now() / 1000), liveEpoch + adjustment * 60);
      const speedText = speed == null ? t("speedUnavailable") : `${Math.round(speed)} km/h`;
      const signalText = signals == null ? t("signalUnavailable") : `${signals} · ${t("signalSource")}`;
      const weatherText = weatherMinutes ? `+${weatherMinutes} ${t("minuteValue")}` : "0";
      const historyText = history.previousCount >= 3
        ? `${formatDeviation(history.previousAverage)} (${history.previousCount})`
        : `${history.previousCount} ${t("observedArrivals")} · ${t("collectHistory")}`;
      const timetableDelta = scheduledEpoch ? `${t("liveTime")} ${formatDeviation((liveEpoch - scheduledEpoch) / 60)} ${t("vsTimetable")}` : "";
      const factorText = `${timetableDelta} · ${t("busSpeed")}: ${speedText} · ${t("traffic")}: ${item.incongestion ? t("trafficHeavy") : t("trafficNormal")} · ${t("signalCount")}: ${signalText} · ${t("weatherFactor")}: ${weatherText} · ${t("historyFactor")}: ${historyText}`;
      return `<article class="estimate-row"><span class="route-pill estimate-route" style="--route-color:${route ? routeColor(route) : "#176d59"}">${escapeHtml(line)}</span><div class="estimate-copy"><strong>${escapeHtml(destination)}</strong><div class="estimate-time-grid"><span><small>${escapeHtml(t("scheduledTime"))}</small><strong>${escapeHtml(plannedMinutes)}</strong></span><span><small>${escapeHtml(t("liveTime"))}</small><strong>${escapeHtml(formatTime(liveEpoch))}</strong></span><span class="estimate-time"><small>${escapeHtml(t("smartTime"))}</small><strong>${escapeHtml(formatTime(estimateEpoch))}</strong></span></div><small class="estimate-factors">${escapeHtml(factorText)}</small></div></article>`;
    }).join("");
    const firstRoute = String(live[0].lineref || "");
    const history = historyStats(stopId(stop), firstRoute);
    const todayText = history.todayCount ? `${formatDeviation(history.todayAverage)} · ${history.todayCount} ${t("observedArrivals")}` : t("noTodayHistory");
    const previousText = history.previousCount ? `${formatDeviation(history.previousAverage)} · ${history.previousCount} ${t("observedArrivals")}` : t("noPreviousHistory");
    list.innerHTML = `<div class="estimate-list">${rows}</div><section class="history-summary"><div class="history-summary-heading"><span>${icon("clock")}</span><strong>${escapeHtml(t("historyFactor"))} · ${escapeHtml(t("line"))} ${escapeHtml(firstRoute)}</strong></div><div class="history-day-grid"><div><small>${escapeHtml(t("todayAverage"))}</small><strong>${escapeHtml(todayText)}</strong></div><div><small>${escapeHtml(t("previousDaysAverage"))}</small><strong>${escapeHtml(previousText)}</strong></div></div><small>${escapeHtml(state.historyAvailable ? t("historyLocalNote") : t("historyStorageUnavailable"))}</small></section>`;
  }
  function weatherAdjustment() {
    if (!state.weather) return 0;
    const weather = state.weather;
    let adjustment = 0;
    if (Number(weather.precipitation) > 0) adjustment += 2;
    if (Number(weather.wind_speed_10m) >= 35) adjustment += 2;
    if ([71, 73, 75, 77, 85, 86].includes(Number(weather.weather_code))) adjustment += 3;
    if ([95, 96, 99].includes(Number(weather.weather_code))) adjustment += 3;
    return Math.min(adjustment, 5);
  }
  function renderEstimate() {
    if (!state.selectedEstimateStop) return;
    const iconNode = document.querySelector(".weather-detail-icon");
    if (state.weather && iconNode) iconNode.textContent = weatherIcon(state.weather.weather_code);
  }
  function haversine(lat1, lon1, lat2, lon2) {
    const rad = (value) => value * Math.PI / 180;
    const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  function updateVehicleSpeeds(vehicles) {
    const now = Date.now();
    vehicles.forEach((vehicle) => {
      const id = String(vehicle.vehicleId);
      const position = { lat: Number(vehicle.latitude), lon: Number(vehicle.longitude), at: now };
      const previous = state.vehiclePositions.get(id);
      if (previous) {
        const elapsed = (now - previous.at) / 1000;
        const distance = haversine(previous.lat, previous.lon, position.lat, position.lon);
        const measured = elapsed >= 10 && elapsed <= 180 ? distance * 3600 / elapsed : NaN;
        if (Number.isFinite(measured) && measured <= 100) {
          const prior = state.vehicleSpeeds.get(id);
          const smoothed = prior && now - prior.at < 180000
            ? prior.kmh * 0.6 + measured * 0.4
            : measured;
          state.vehicleSpeeds.set(id, { kmh: smoothed, at: now });
        }
      }
      state.vehiclePositions.set(id, position);
      const speed = state.vehicleSpeeds.get(id);
      if (speed && now - speed.at < 180000) vehicle.speedKmh = speed.kmh;
    });
    state.vehiclePositions.forEach((position, id) => {
      if (now - position.at > 10 * 60 * 1000) {
        state.vehiclePositions.delete(id);
        state.vehicleSpeeds.delete(id);
      }
    });
  }
  function pointSegmentDistanceMeters(point, start, end) {
    const radians = Math.PI / 180;
    const latitude = (start.lat + end.lat) / 2;
    const xScale = 111320 * Math.cos(latitude * radians);
    const yScale = 110540;
    const px = (point.lon - start.lon) * xScale;
    const py = (point.lat - start.lat) * yScale;
    const ex = (end.lon - start.lon) * xScale;
    const ey = (end.lat - start.lat) * yScale;
    const denominator = ex * ex + ey * ey;
    const projection = denominator ? Math.max(0, Math.min(1, (px * ex + py * ey) / denominator)) : 0;
    return Math.hypot(px - projection * ex, py - projection * ey);
  }
  async function trafficSignalCount(stop, routeId, vehicle) {
    const key = `${routeId}:${stopId(stop)}`;
    if (state.signalCounts.has(key)) return state.signalCounts.get(key);
    const pending = state.signalLookups.get(key);
    if (pending) return pending;
    if ((state.signalFailures.get(key) || 0) > Date.now()) return null;
    const lat = Number(vehicle.latitude), lon = Number(vehicle.longitude);
    const stopLat = Number(stop.stop_lat), stopLon = Number(stop.stop_lon);
    if (![lat, lon, stopLat, stopLon].every(Number.isFinite) || haversine(lat, lon, stopLat, stopLon) > 8) return null;
    const cacheKey = `bussitaulu-signals:${key}`;
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
      if (cached && Date.now() - cached.time < SIGNAL_CACHE_TTL && Number.isInteger(cached.count)) {
        state.signalCounts.set(key, cached.count);
        return cached.count;
      }
    } catch (error) {
      console.warn("Could not read the cached OpenStreetMap signal count.", error);
    }
    const padding = 0.00045;
    const south = Math.min(lat, stopLat) - padding;
    const west = Math.min(lon, stopLon) - padding;
    const north = Math.max(lat, stopLat) + padding;
    const east = Math.max(lon, stopLon) + padding;
    const query = `[out:json][timeout:8];node["highway"="traffic_signals"](${south.toFixed(5)},${west.toFixed(5)},${north.toFixed(5)},${east.toFixed(5)});out body;`;
    const lookup = (async () => {
      const response = await fetch(`${SIGNAL_ENDPOINT}?data=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(APP_CONFIG.trafficSignalRequestTimeoutMs) });
      if (!response.ok) throw new Error(`OpenStreetMap Overpass request failed (${response.status}).`);
      const data = await response.json();
      if (!Array.isArray(data.elements)) throw new Error("OpenStreetMap Overpass returned an invalid signal response.");
      const start = { lat, lon }, end = { lat: stopLat, lon: stopLon };
      const count = data.elements.filter((element) =>
        element.type === "node" && element.tags && element.tags.highway === "traffic_signals" &&
        Number.isFinite(element.lat) && Number.isFinite(element.lon) &&
        pointSegmentDistanceMeters({ lat: element.lat, lon: element.lon }, start, end) <= 35
      ).length;
      state.signalCounts.set(key, count);
      try {
        localStorage.setItem(cacheKey, JSON.stringify({ time: Date.now(), count }));
      } catch (error) {
        console.warn("Could not cache the OpenStreetMap signal count.", error);
      }
      return count;
    })();
    state.signalLookups.set(key, lookup);
    try {
      return await lookup;
    } catch (error) {
      console.warn(`Could not estimate traffic signals for line ${routeId} at stop ${stopId(stop)}.`, error);
      state.signalFailures.set(key, Date.now() + 60 * 60 * 1000);
      return null;
    } finally {
      state.signalLookups.delete(key);
    }
  }
  function distancesFrom(lat, lon, limit) {
    return state.stops.filter((stop) => Number.isFinite(Number(stop.stop_lat)) && Number.isFinite(Number(stop.stop_lon)))
      .map((stop) => Object.assign({ distance: haversine(lat, lon, Number(stop.stop_lat), Number(stop.stop_lon)) }, stop))
      .sort((a, b) => a.distance - b.distance).slice(0, limit || 5);
  }
  function renderNearby() {
    const list = document.getElementById("nearby-list");
    if (!list) return;
    if (!state.stops.length) return;
    const position = state.userLocation || TURKU;
    const radius = settingsController ? settingsController.radiusKm() : 5;
    const nearby = distancesFrom(position.lat, position.lon, state.stops.length).filter((stop) => stop.distance <= radius).slice(0, 5);
    const favorites = state.favorites.filter((favorite) => favorite.kind === "stop")
      .map((favorite) => stopById(favorite.id))
      .filter(Boolean)
      .map((stop) => Object.assign({
        distance: haversine(position.lat, position.lon, Number(stop.stop_lat), Number(stop.stop_lon)),
        favorite: true
      }, stop));
    const displayed = [...favorites, ...nearby.filter((stop) => !favorites.some((favorite) => stopId(favorite) === stopId(stop)))];
    if (!displayed.length) {
      list.innerHTML = `<div class="empty-state small-empty"><strong>${escapeHtml(t("noNearby"))}</strong></div>`;
      return;
    }
    list.innerHTML = displayed.map((stop) => {
      const id = stopId(stop);
      return `<button class="nearby-row ${stop.favorite ? "favorite-nearby-row" : ""}" data-nearby-id="${escapeHtml(id)}"><span class="nearby-pin">${icon(stop.favorite ? "star" : "pin")}</span><span class="nearby-copy"><strong>${escapeHtml(stopName(stop))}</strong><small>${escapeHtml(id)} · ${stop.distance.toFixed(1)} km${stop.favorite ? ` · ${escapeHtml(t("favorites"))}` : ""}</small></span><span class="nearby-next">${icon("chevron")}</span></button>`;
    }).join("");
    list.querySelectorAll("[data-nearby-id]").forEach((button) => button.addEventListener("click", () => openStopModal(stopById(button.dataset.nearbyId))));
  }
  function renderQuickFavorites() {
    const strip = document.getElementById("favorite-strip");
    if (!strip) return;
    document.getElementById("favorite-count").textContent = state.favorites.length;
    const favorites = state.favorites.slice(0, 4);
    if (!favorites.length) {
      strip.innerHTML = `<button class="favorite-add-card" data-open-view="favorites"><span class="add-circle">+</span><span><strong>${escapeHtml(t("noFavorites"))}</strong><small>${escapeHtml(t("addFavoriteHint"))}</small></span></button>`;
      strip.querySelector("button").addEventListener("click", () => switchView("favorites"));
      return;
    }
    strip.innerHTML = favorites.map((item) => `<button class="favorite-card" data-favorite-key="${escapeHtml(favoriteKey(item.kind, item.id))}"><span class="favorite-card-icon">${icon(item.kind === "stop" ? "pin" : "route")}</span><span class="favorite-card-copy"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.kind === "stop" ? `${t("stopId")} ${item.id}` : `${t("line")} ${item.meta || ""}`)}</small></span><span class="favorite-star">${icon("star")}</span></button>`).join("");
    strip.querySelectorAll("[data-favorite-key]").forEach((button) => button.addEventListener("click", () => openFavorite(state.favorites.find((item) => favoriteKey(item.kind, item.id) === button.dataset.favoriteKey))));
  }
  function openFavorite(item) {
    if (!item) return;
    if (item.kind === "stop") {
      const stop = stopById(item.id) || { stop_id: item.id, stop_name: item.name };
      openStopModal(stop);
    } else openRoute(item.id);
  }
  function renderFavoritePage() {
    const list = document.getElementById("favorite-page-list");
    if (!list) return;
    if (!state.favorites.length) {
      list.innerHTML = `<div class="empty-state favorites-empty"><span class="empty-icon">${icon("star")}</span><strong>${escapeHtml(t("favoritesEmpty"))}</strong><small>${escapeHtml(t("addFavoriteHint"))}</small><button class="secondary-button" id="favorites-home-button">${escapeHtml(t("searchStop"))}</button></div>`;
      document.getElementById("favorites-home-button").addEventListener("click", () => switchView("departures"));
      return;
    }
    list.innerHTML = state.favorites.map((item) => `<article class="favorite-page-row"><span class="favorite-card-icon">${icon(item.kind === "stop" ? "pin" : "route")}</span><button class="favorite-open" data-favorite-key="${escapeHtml(favoriteKey(item.kind, item.id))}"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.kind === "stop" ? `${t("stopId")} ${item.id}` : `${t("line")} ${item.meta || ""}`)}</small></button><button class="favorite-remove" data-remove-key="${escapeHtml(favoriteKey(item.kind, item.id))}" aria-label="${escapeHtml(t("removeFavorite"))}">${icon("star")}</button></article>`).join("");
    list.querySelectorAll("[data-favorite-key]").forEach((button) => button.addEventListener("click", () => openFavorite(state.favorites.find((item) => favoriteKey(item.kind, item.id) === button.dataset.favoriteKey))));
    list.querySelectorAll("[data-remove-key]").forEach((button) => button.addEventListener("click", () => {
      const item = state.favorites.find((favorite) => favoriteKey(favorite.kind, favorite.id) === button.dataset.removeKey);
      if (item) toggleFavorite(item.kind, item.id, item.name, item.meta);
    }));
  }
  function routeVehicles(routeId) {
    return state.vehicles.filter((vehicle) => String(vehicle.lineref) === String(routeId));
  }
  function populateRouteLineFilter() {
    const select = document.getElementById("route-filter-line");
    if (!select) return;
    const selected = select.value;
    const routes = state.routes.slice().sort((a, b) => routeLabel(a).localeCompare(routeLabel(b), state.lang, { numeric: true, sensitivity: "base" }));
    select.innerHTML = `<option value="" data-i18n="allLines">${escapeHtml(t("allLines"))}</option>${routes.map((route) => `<option value="${escapeHtml(route.route_id)}">${escapeHtml(routeLabel(route))}</option>`).join("")}`;
    if (routes.some((route) => String(route.route_id) === selected)) select.value = selected;
  }
  function renderRoutes(query) {
    const grid = document.getElementById("route-grid");
    if (!grid || !state.routes.length) return;
    const selectedLine = document.getElementById("route-filter-line").value;
    const destination = document.getElementById("route-filter-destination").value.trim().toLocaleLowerCase();
    const hasFilters = Boolean((query && query.trim()) || selectedLine || destination);
    const candidates = query && query.trim() ? routeSearchMatches(query, 1000) : state.routes;
    const matches = candidates.filter((route) => {
      if (selectedLine && String(route.route_id) !== selectedLine) return false;
      if (destination && !`${route.route_long_name || ""} ${route.route_desc || ""}`.toLocaleLowerCase().includes(destination)) return false;
      return true;
    });
    const routes = matches.slice(0, hasFilters ? 100 : 36);
    if (!routes.length) {
      grid.innerHTML = `<div class="empty-state"><strong>${escapeHtml(t("routeSearchEmpty"))}</strong></div>`;
      return;
    }
    grid.innerHTML = routes.map((route) => {
      const id = String(route.route_id);
      const vehicles = routeVehicles(id).length;
      return `<article class="route-card" style="--route-color:${routeColor(route)}"><button class="route-card-main" data-route-card="${escapeHtml(id)}"><span class="route-pill route-card-number">${escapeHtml(routeLabel(route))}</span><span class="route-card-copy"><strong>${escapeHtml(route.route_long_name || "")}</strong><small>${vehicles ? `<span class="inline-live-dot"></span>${vehicles} ${escapeHtml(t("liveBuses").toLocaleLowerCase())}` : escapeHtml(t("liveBuses"))}</small></span>${icon("chevron")}</button><button class="route-star ${isFavorite("route", id) ? "is-favorite" : ""}" data-route-favorite="${escapeHtml(id)}" aria-label="${escapeHtml(t(isFavorite("route", id) ? "removeFavorite" : "addFavorite"))}">${icon("star")}</button></article>`;
    }).join("");
    grid.querySelectorAll("[data-route-card]").forEach((button) => button.addEventListener("click", () => openRoute(button.dataset.routeCard)));
    grid.querySelectorAll("[data-route-favorite]").forEach((button) => button.addEventListener("click", () => {
      const route = routeById(button.dataset.routeFavorite);
      if (route) toggleFavorite("route", route.route_id, route.route_long_name || `${t("line")} ${routeLabel(route)}`, routeLabel(route));
    }));
  }
  function openRoute(routeId) {
    const route = routeById(routeId);
    if (!route) {
      showToast(t("routeNotFound"), "error");
      return;
    }
    switchView("lines");
    const detail = document.getElementById("route-detail");
    const grid = document.getElementById("route-grid");
    detail.hidden = false;
    detail.scrollIntoView({ behavior: "smooth", block: "start" });
    const id = String(route.route_id);
    const buses = routeVehicles(id);
    const starred = isFavorite("route", id);
    detail.dataset.routeId = id;
    delete detail.dataset.selectedStopId;
    detail.innerHTML = `<div class="detail-heading"><div><p class="section-kicker">${escapeHtml(t("line"))} ${escapeHtml(routeLabel(route))}</p><h2>${escapeHtml(route.route_long_name || routeLabel(route))}</h2></div><div class="detail-actions"><button class="star-button ${starred ? "is-favorite" : ""}" id="detail-route-favorite" aria-label="${escapeHtml(t(starred ? "removeFavorite" : "addFavorite"))}">${icon("star")}</button><button class="mini-icon-button" id="route-detail-close" aria-label="Close">×</button></div></div><div class="detail-live-heading"><span class="live-label"><span class="live-dot"></span>${escapeHtml(t("liveBuses"))}</span><span>${buses.length} ${escapeHtml(t("live").toLocaleLowerCase())}</span></div><div class="route-bus-list" id="route-bus-list">${routeBusMarkup(buses)}</div><section class="route-timetable"><div class="route-timetable-heading"><div><h3>${escapeHtml(t("lineTimetable"))}</h3><p>${escapeHtml(t("lineTimetableHint"))}</p></div></div><div class="search-input-wrap"><span class="search-glass">${icon("pin")}</span><input id="route-stop-search" type="search" autocomplete="off" placeholder="${escapeHtml(t("findStopOnLine"))}" aria-label="${escapeHtml(t("findStopOnLine"))}" /><button class="clear-search" id="clear-route-stop-search" aria-label="${escapeHtml(t("searchStop"))}" hidden>×</button></div><div class="search-results route-stop-results" id="route-stop-results" role="listbox" hidden></div><div class="route-time-filters"><p data-i18n="departureTimeRange">${escapeHtml(t("departureTimeRange"))}</p><div class="route-time-inputs"><label><span data-i18n="fromTime">${escapeHtml(t("fromTime"))}</span><input id="route-time-from" type="time" disabled /></label><label><span data-i18n="untilTime">${escapeHtml(t("untilTime"))}</span><input id="route-time-until" type="time" disabled /></label><button class="text-button" id="clear-route-time-filter" type="button" disabled data-i18n="clearTimeFilter">${escapeHtml(t("clearTimeFilter"))}</button></div><small data-i18n="timeFilterHint">${escapeHtml(t("timeFilterHint"))}</small></div><div class="route-timetable-results" id="route-timetable-results"><span>${escapeHtml(t("chooseStopForLine"))}</span></div></section><button class="text-button route-map-link" id="route-map-link">${icon("map")}<span>${escapeHtml(t("viewMap"))}</span><span>↗</span></button>`;
    document.getElementById("detail-route-favorite").addEventListener("click", () => {
      toggleFavorite("route", id, route.route_long_name || `${t("line")} ${routeLabel(route)}`, routeLabel(route));
      document.getElementById("detail-route-favorite").classList.toggle("is-favorite", isFavorite("route", id));
    });
    document.getElementById("route-detail-close").addEventListener("click", () => { detail.hidden = true; grid.scrollIntoView({ behavior: "smooth" }); });
    document.getElementById("route-map-link").addEventListener("click", () => switchView("map"));
    bindRouteStopSearch(id);
    document.getElementById("map-filter").value = routeLabel(route);
  }
  function bindRouteStopSearch(routeId) {
    const detail = document.getElementById("route-detail");
    const input = document.getElementById("route-stop-search");
    const results = document.getElementById("route-stop-results");
    const clear = document.getElementById("clear-route-stop-search");
    const output = document.getElementById("route-timetable-results");
    const from = document.getElementById("route-time-from");
    const until = document.getElementById("route-time-until");
    const clearTimes = document.getElementById("clear-route-time-filter");
    let lineDepartures = null;
    const renderFilteredDepartures = () => {
      if (!lineDepartures) return;
      const start = from.value ? scheduleMinutes(from.value) : null;
      const end = until.value ? scheduleMinutes(until.value) : null;
      const matchesTime = (minutes) => {
        if (!Number.isFinite(minutes)) return false;
        if (start == null && end == null) return true;
        if (start == null) return minutes <= end;
        if (end == null) return minutes >= start;
        return start <= end ? minutes >= start && minutes <= end : minutes >= start || minutes <= end;
      };
      const filtered = {
        live: lineDepartures.live.filter((item) => {
          const epoch = Number(item.aimedarrivaltime || item.resolvedTime || 0);
          return epoch > 0 && matchesTime(epochHelsinkiMinutes(epoch));
        }),
        scheduled: lineDepartures.scheduled.filter((item) => matchesTime(Number(item.scheduledMinutes) % (24 * 60)))
      };
      output.innerHTML = filtered.live.length || filtered.scheduled.length
        ? departureMarkup(filtered, "route")
        : `<div class="empty-state small-empty"><strong>${escapeHtml(t(from.value || until.value ? "noDeparturesInWindow" : "noLineDeparturesAtStop"))}</strong></div>`;
    };
    input.addEventListener("input", () => {
      clear.hidden = !input.value;
      const matches = stopSearchMatches(input.value, 7);
      results.innerHTML = matches.map((stop) => `<button class="search-result" role="option" data-route-stop="${escapeHtml(stopId(stop))}"><span class="result-icon">${icon("pin")}</span><span class="result-copy"><strong>${escapeHtml(stopName(stop))}</strong><small>${escapeHtml(t("stopId"))} ${escapeHtml(stopId(stop))}</small></span>${icon("chevron")}</button>`).join("");
      results.hidden = !input.value.trim();
      if (input.value.trim() && !matches.length) results.innerHTML = `<div class="search-empty">${escapeHtml(t("stopSearchEmpty"))}</div>`;
      results.querySelectorAll("[data-route-stop]").forEach((button) => button.addEventListener("click", async () => {
        const stop = stopById(button.dataset.routeStop);
        detail.dataset.selectedStopId = stopId(stop);
        input.value = stopName(stop);
        clear.hidden = false;
        results.hidden = true;
        from.disabled = false;
        until.disabled = false;
        clearTimes.disabled = false;
        lineDepartures = null;
        output.innerHTML = `<div class="loading-line"><span class="loader"></span><span>${escapeHtml(t("loadingLineTimetable"))}</span></div>`;
        try {
          const departures = await stopDepartures(stopId(stop));
          lineDepartures = {
            live: departures.live.filter((item) => String(item.lineref) === routeId),
            scheduled: departures.scheduled.filter((item) => String(item.route_id) === routeId)
          };
          renderFilteredDepartures();
        } catch (error) {
          console.error("Could not load this line's departures at the selected stop.", error);
          lineDepartures = null;
          output.innerHTML = `<div class="inline-error">${escapeHtml(t("departuresError"))}</div>`;
        }
      }));
    });
    from.addEventListener("input", renderFilteredDepartures);
    until.addEventListener("input", renderFilteredDepartures);
    clearTimes.addEventListener("click", () => {
      from.value = "";
      until.value = "";
      renderFilteredDepartures();
    });
    clear.addEventListener("click", () => {
      input.value = "";
      clear.hidden = true;
      results.hidden = true;
      from.value = "";
      until.value = "";
      from.disabled = true;
      until.disabled = true;
      clearTimes.disabled = true;
      lineDepartures = null;
      output.innerHTML = `<span>${escapeHtml(t("chooseStopForLine"))}</span>`;
      input.focus();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") results.hidden = true;
      if (event.key === "Enter") {
        const first = results.querySelector("[data-route-stop]");
        if (first) first.click();
      }
    });
  }
  function routeBusMarkup(buses) {
    if (!buses.length) return `<div class="empty-state small-empty"><strong>${escapeHtml(t("noLiveLine"))}</strong></div>`;
    return buses.slice(0, 20).map((vehicle) => {
      const destination = vehicle[`destinationdisplay_${state.lang}`] || vehicle.destinationdisplay || vehicle.destinationname || vehicle.next_destinationdisplay || "";
      const eta = vehicle.next_expectedarrivaltime || vehicle.next_aimedarrivaltime;
      return `<div class="route-bus-row"><span class="route-bus-icon">${icon("bus")}</span><span class="route-bus-copy"><strong>${escapeHtml(destination || t("destination"))}</strong><small>${escapeHtml(vehicle.next_stoppointname || "")}</small></span><span class="route-bus-eta">${eta ? escapeHtml(relativeArrival(Number(eta))) : ""}</span></div>`;
    }).join("");
  }
  function initializeMap() { if (mapController) mapController.initialize(); }
  function renderMapMarkers() { if (mapController) mapController.render(); }
  async function refreshLiveData() {
    if (state.refreshing) return;
    state.refreshing = true;
    state.lastLiveRefresh = Date.now();
    try {
      const data = await apiFetch(`${API}/siri/vm`, { noCache: true });
      state.vehicles = normalizeVehicles(data);
      updateVehicleSpeeds(state.vehicles);
      document.getElementById("map-loading").hidden = true;
      renderMapMarkers();
      document.getElementById("live-bus-count").textContent = String(state.vehicles.length);
      setStatus(data && data.status === "OK" ? "serviceActive" : "serviceLimited");
      renderRoutes(document.getElementById("route-search").value);
      if (state.currentView === "lines") updateVisibleRouteBuses();
      await checkFavoriteArrivals();
      const rolledOver = ensureDailyHistory();
      if (rolledOver && state.estimateData) renderEstimateResults(state.estimateData.stop, state.estimateData.data);
      if (state.currentView === "estimator" && state.selectedEstimateStop) {
        await loadEstimate(state.selectedEstimateStop);
      }
    } catch (error) {
      console.error("Could not refresh Föli live vehicle data.", error);
      document.getElementById("map-loading").hidden = true;
      setStatus("serviceLimited");
      if (!state.vehicles.length) document.getElementById("live-bus-count").textContent = "—";
    } finally {
      state.refreshing = false;
    }
  }
  function updateVisibleRouteBuses() {
    const detail = document.getElementById("route-detail");
    const list = document.getElementById("route-bus-list");
    if (!detail || detail.hidden || !list) return;
    const route = routeById(detail.dataset.routeId);
    if (route) list.innerHTML = routeBusMarkup(routeVehicles(route.route_id));
  }
  function renderFavoriteAlert(arrival) {
    const region = document.getElementById("toast-region");
    if (!arrival) {
      if (region.querySelector(".favorite-alert")) region.innerHTML = "";
      state.lastFavoriteAlert = "";
      return;
    }
    const signature = `${arrival.id}:${arrival.line}:${Math.floor(arrival.minutes / 2)}`;
    if (signature === state.lastFavoriteAlert && region.querySelector(".favorite-alert")) return;
    state.lastFavoriteAlert = signature;
    const stop = arrival.stop;
    const message = `${t("comingSoon")} · ${arrival.favorite.name} · ${arrival.line}: ${arrival.minutes <= 1 ? t("now") : `${arrival.minutes} ${t("minutes")}`}`;
    region.innerHTML = `<button class="favorite-alert" aria-live="polite"><span class="alert-bus">${icon("bus")}</span><span><strong>${escapeHtml(t("busArriving"))}</strong><small>${escapeHtml(message)}</small></span><span class="alert-open">${icon("chevron")}</span></button>`;
    region.querySelector(".favorite-alert").addEventListener("click", () => {
      if (arrival.favorite.kind === "route") openRoute(arrival.favorite.id);
      else openStopModal(stop || { stop_id: arrival.id, stop_name: arrival.favorite.name });
    });
  }
  async function checkFavoriteArrivals() {
    const stopFavorites = state.favorites.filter((item) => item.kind === "stop");
    const routeFavorites = state.favorites.filter((item) => item.kind === "route");
    const candidates = [];
    for (const favorite of routeFavorites) {
      const vehicle = state.vehicles.filter((item) => String(item.lineref) === String(favorite.id))
        .map((item) => ({ vehicle: item, time: Number(item.next_expectedarrivaltime || item.next_aimedarrivaltime || 0) }))
        .filter((item) => item.time > 0 && item.time * 1000 >= Date.now())
        .sort((a, b) => a.time - b.time)[0];
      if (vehicle) {
        const minutes = Math.round((vehicle.time * 1000 - Date.now()) / 60000);
        if (minutes <= 10) candidates.push({ id: `route:${favorite.id}`, favorite, line: favorite.meta || routeById(favorite.id) && routeLabel(routeById(favorite.id)) || favorite.id, minutes, time: vehicle.time, stop: null });
      }
    }
    if (!stopFavorites.length && !candidates.length) {
      renderFavoriteAlert(null);
      return;
    }
    const stopResults = await Promise.allSettled(stopFavorites.slice(0, 4).map(async (favorite) => {
      const stop = stopById(favorite.id) || { stop_id: favorite.id, stop_name: favorite.name };
      const result = await apiFetch(`${API}/siri/stops/${encodeURIComponent(favorite.id)}`, { noCache: true });
      if (result.status !== "OK" || !Array.isArray(result.result)) return null;
      recordStopObservations(favorite.id, result);
      const arrivals = result.result.filter((item) => item.lineref && (item.expectedarrivaltime || item.aimedarrivaltime)).map((item) => {
        const time = Number(item.expectedarrivaltime || item.aimedarrivaltime);
        return { id: favorite.id, favorite, stop, line: item.lineref, time, minutes: Math.max(0, Math.round((time * 1000 - Date.now()) / 60000)) };
      }).filter((item) => item.minutes <= 10 && item.minutes >= 0);
      return arrivals[0] || null;
    }));
    const best = candidates.concat(stopResults.filter((result) => result.status === "fulfilled" && result.value)
      .map((result) => result.value)).sort((a, b) => a.minutes - b.minutes)[0];
    renderFavoriteAlert(best || null);
  }
  function bindEvents() {
    bindNavigation();
    bindSearch("main-search", "search-results", state.searchMode, "clear-search");
    bindSearch("route-search", "route-results", "route", "clear-route-search");
    bindSearch("estimate-search", "estimate-results", "stop", "clear-estimate-search");
    document.getElementById("estimate-choose-stop").addEventListener("click", () => {
      const picker = document.getElementById("estimate-stop-picker");
      picker.hidden = !picker.hidden;
      if (!picker.hidden) {
        const input = document.getElementById("estimate-search");
        input.value = "";
        document.getElementById("estimate-results").hidden = true;
        document.getElementById("clear-estimate-search").hidden = true;
        input.focus();
      }
    });
    document.querySelectorAll("[data-search-mode]").forEach((button) => button.addEventListener("click", () => {
      state.searchMode = button.dataset.searchMode;
      document.querySelectorAll(".search-tab").forEach((tab) => {
        const active = tab.dataset.searchMode === state.searchMode;
        tab.classList.toggle("active", active);
        tab.setAttribute("aria-selected", String(active));
      });
      const input = document.getElementById("main-search");
      input.placeholder = t(state.searchMode === "stop" ? "stopPlaceholder" : "searchLine");
      input.setAttribute("aria-label", t(state.searchMode === "stop" ? "searchStops" : "searchLine"));
      input.value = "";
      document.getElementById("clear-search").hidden = true;
      document.getElementById("search-results").hidden = true;
      input.focus();
    }));
    document.getElementById("language-select").addEventListener("change", (event) => {
      const routeDetail = document.getElementById("route-detail");
      const routeId = state.currentView === "lines" && !routeDetail.hidden ? routeDetail.dataset.routeId : null;
      const routeStopId = routeDetail.dataset.selectedStopId;
      const estimateStop = state.selectedEstimateStop;
      state.lang = event.target.value;
      try { localStorage.setItem(LOCALE_KEY, state.lang); } catch (error) { console.warn("Could not save the selected language.", error); }
      applyLanguage();
      updateToday();
      ensureDailyHistory();
      document.getElementById("main-search").placeholder = t(state.searchMode === "stop" ? "stopPlaceholder" : "searchLine");
      document.getElementById("main-search").setAttribute("aria-label", t(state.searchMode === "stop" ? "searchStops" : "searchLine"));
      if (estimateStop) selectEstimateStop(estimateStop);
      if (routeId) restoreRouteTimetable(routeId, routeStopId);
      if (state.activeModalStop) openStopModal(state.activeModalStop);
      checkFavoriteArrivals();
    });
    const refresh = () => { refreshLiveData(); };
    document.getElementById("refresh-button").addEventListener("click", refresh);
    document.getElementById("nearby-refresh").addEventListener("click", () => {
      if (state.userLocation) renderNearby();
      else showToast(t("locateDenied"), "error");
    });
    document.getElementById("map-refresh").addEventListener("click", refresh);
    document.getElementById("api-retry-button").addEventListener("click", refresh);
    document.getElementById("map-filter").addEventListener("input", () => {
      renderMapMarkers();
      clearTimeout(mapFilterRefreshTimer);
      if (state.currentView === "map" && document.getElementById("map-filter").value.trim()) {
        mapFilterRefreshTimer = setTimeout(() => {
          if (Date.now() - state.lastLiveRefresh >= APP_CONFIG.selectedLineRefreshIntervalMs) refreshLiveData();
        }, APP_CONFIG.mapFilterDebounceMs);
      }
    });
    document.getElementById("map-locate-button").addEventListener("click", requestLocation);
    document.getElementById("route-search").addEventListener("input", (event) => {
      renderRoutes(event.target.value);
      document.getElementById("route-detail").hidden = true;
    });
    document.getElementById("route-filter-line").addEventListener("change", () => {
      renderRoutes(document.getElementById("route-search").value);
      document.getElementById("route-detail").hidden = true;
    });
    document.getElementById("route-filter-destination").addEventListener("input", () => {
      renderRoutes(document.getElementById("route-search").value);
      document.getElementById("route-detail").hidden = true;
    });
    document.getElementById("location-button").addEventListener("click", requestLocation);
    document.getElementById("modal-close").addEventListener("click", closeStopModal);
    document.getElementById("modal-backdrop").addEventListener("click", (event) => {
      if (event.target.id === "modal-backdrop") closeStopModal();
    });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !document.getElementById("modal-backdrop").hidden) closeStopModal(); });
  }
  function requestLocation() {
    if (settingsController && !settingsController.isLocationEnabled()) {
      settingsController.setLocationStatus("locationDisabled");
      showToast(t("locationDisabled"), "error");
      return;
    }
    if (!navigator.geolocation) {
      if (settingsController) settingsController.setLocationStatus("locateDenied");
      showToast(t("locateDenied"), "error");
      return;
    }
    if (settingsController) settingsController.setLocationStatus("locating");
    navigator.geolocation.getCurrentPosition((position) => {
      state.userLocation = { lat: position.coords.latitude, lon: position.coords.longitude };
      renderNearby();
      renderMapMarkers();
      if (mapController) mapController.focusUser();
      if (settingsController) settingsController.setLocationStatus("locationFound");
      weatherFetch(position.coords.latitude, position.coords.longitude);
      showToast(t("locationFound"), "success");
    }, (error) => {
      console.warn("Could not get the user's location.", error);
      if (settingsController) settingsController.setLocationStatus("locateDenied");
      showToast(t("locateDenied"), "error");
    }, { enableHighAccuracy: false, timeout: APP_CONFIG.locationRequestTimeoutMs, maximumAge: APP_CONFIG.locationMaximumAgeMs });
  }
  function disableLocation() {
    state.userLocation = null;
    if (mapController) mapController.clearUserLocation();
    renderNearby();
    weatherFetch(TURKU.lat, TURKU.lon);
  }
  function initializeMainSearch() {
    const input = document.getElementById("main-search");
    input.placeholder = t("stopPlaceholder");
    input.setAttribute("aria-label", t("searchStops"));
  }
  async function loadStaticData() {
    const [stopsResult, routesResult, calendarResult, exceptionsResult] = await Promise.allSettled([
      apiFetch(`${API}/gtfs/stops`),
      apiFetch(`${API}/gtfs/routes`),
      apiFetch(`${API}/gtfs/calendar`),
      apiFetch(`${API}/gtfs/calendar_dates`)
    ]);
    if (stopsResult.status === "fulfilled") state.stops = normalizeStops(stopsResult.value);
    else console.error("Could not load Föli stops.", stopsResult.reason);
    if (routesResult.status === "fulfilled") state.routes = Array.isArray(routesResult.value) ? routesResult.value : [];
    else console.error("Could not load Föli lines.", routesResult.reason);
    if (calendarResult.status === "fulfilled" && calendarResult.value && typeof calendarResult.value === "object") state.calendars = calendarResult.value;
    else console.error("Could not load GTFS service calendars; timetable results may include inactive trips.", calendarResult.reason);
    if (exceptionsResult.status === "fulfilled" && exceptionsResult.value && typeof exceptionsResult.value === "object") state.calendarExceptions = exceptionsResult.value;
    else console.error("Could not load GTFS service exceptions; timetable results may include inactive trips.", exceptionsResult.reason);
    renderNearby();
    populateRouteLineFilter();
    renderRoutes("");
    renderQuickFavorites();
    renderFavoritePage();
    document.getElementById("favorite-count").textContent = state.favorites.length;
  }
  function initializeModal() { document.getElementById("modal-backdrop").hidden = true; }
  function renderTermsLanguage() {
    const backdrop = document.getElementById("terms-backdrop");
    backdrop.lang = state.lang;
    backdrop.querySelectorAll("[data-i18n]").forEach((node) => { node.textContent = t(node.dataset.i18n); });
    const language = document.getElementById("terms-language");
    language.value = state.lang;
    language.setAttribute("aria-label", t("termsLanguage"));
  }
  function startApp(termsStorageWarning) {
    init().then(() => {
      if (termsStorageWarning) showToast(t("termsStorageWarning"), "error");
    }).catch((error) => {
      console.error("Bussitaulu could not initialize.", error);
      setStatus("serviceLimited");
      showToast(t("errorTitle"), "error");
    });
  }
  function initializeTerms() {
    const backdrop = document.getElementById("terms-backdrop");
    const appShell = document.getElementById("app-shell");
    let accepted = false;
    try {
      accepted = localStorage.getItem(TERMS_KEY) === TERMS_VERSION;
    } catch (error) {
      console.error("Could not read the saved Terms of Use agreement.", error);
    }
    if (accepted) {
      backdrop.hidden = true;
      appShell.inert = false;
      appShell.removeAttribute("aria-hidden");
      return true;
    }

    appShell.inert = true;
    appShell.setAttribute("aria-hidden", "true");
    renderTermsLanguage();
    const language = document.getElementById("terms-language");
    const consent = document.getElementById("terms-consent");
    const accept = document.getElementById("terms-accept");
    language.addEventListener("change", () => {
      state.lang = language.value;
      try { localStorage.setItem(LOCALE_KEY, state.lang); } catch (error) { console.warn("Could not save the selected language.", error); }
      renderTermsLanguage();
    });
    consent.addEventListener("change", () => { accept.disabled = !consent.checked; });
    backdrop.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(backdrop.querySelectorAll("select, input, button:not(:disabled), a[href]"));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    accept.addEventListener("click", () => {
      if (!consent.checked) return;
      let storageWarning = false;
      try {
        localStorage.setItem(TERMS_KEY, TERMS_VERSION);
      } catch (error) {
        storageWarning = true;
        console.error("Could not save the Terms of Use agreement.", error);
      }
      backdrop.hidden = true;
      appShell.inert = false;
      appShell.removeAttribute("aria-hidden");
      startApp(storageWarning);
    });
    document.getElementById("terms-language").focus();
    return false;
  }
  async function init() {
    document.querySelectorAll("[data-app-version]").forEach((node) => {
      node.textContent = `v${APP_CONFIG.version}`;
    });
    document.querySelectorAll("[data-report-issue]").forEach((link) => {
      link.href = APP_CONFIG.issueUrl;
    });
    renderIcons();
    settingsController = initializeSettings({
      t,
      onLocate: requestLocation,
      onLocationDisabled: disableLocation,
      onRadiusChange: () => { renderNearby(); renderMapMarkers(); }
    });
    mapController = createMapController({
      state, t, icon, escapeHtml, routeById, routeLabel, routeColor, relativeArrival,
      getRadiusKm: () => settingsController.radiusKm(),
      onStopClick: openStopModal
    });
    bindEvents();
    initializeMainSearch();
    initializeModal();
    updateToday();
    applyLanguage();
    document.getElementById("favorite-count").textContent = state.favorites.length;
    const staticLoad = loadStaticData();
    weatherFetch(TURKU.lat, TURKU.lon);
    await refreshLiveData();
    await staticLoad;
    if (state.lang !== "fi") applyLanguage();
    refreshTimer = setInterval(() => {
      if (Date.now() - state.lastLiveRefresh >= APP_CONFIG.normalRefreshIntervalMs) refreshLiveData();
    }, APP_CONFIG.refreshIntervalCheckMs);
    quickMapRefreshTimer = setInterval(() => {
      const selectedLine = document.getElementById("map-filter").value.trim();
      if (state.currentView === "map" && selectedLine && Date.now() - state.lastLiveRefresh >= APP_CONFIG.selectedLineRefreshIntervalMs) refreshLiveData();
    }, APP_CONFIG.refreshIntervalCheckMs);
    dailyTimer = setInterval(() => {
      ensureDailyHistory();
      const currentDate = helsinkiDateKey();
      if (displayedDateKey !== currentDate) {
        displayedDateKey = currentDate;
        updateToday();
        if (state.estimateData) renderEstimateResults(state.estimateData.stop, state.estimateData.data);
      }
    }, APP_CONFIG.normalRefreshIntervalMs);
    window.addEventListener("beforeunload", () => {
      clearInterval(refreshTimer);
      clearInterval(quickMapRefreshTimer);
      clearInterval(dailyTimer);
      clearTimeout(toastTimer);
      clearTimeout(mapFilterRefreshTimer);
    });
  }
  if (initializeTerms()) startApp(false);
})();
