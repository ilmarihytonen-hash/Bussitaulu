import { APP_CONFIG } from "./config.js";

export const API = APP_CONFIG.apiBaseUrl;
const WEATHER = APP_CONFIG.weatherApiUrl;
const CACHE_PREFIX = "bussitaulu-cache:";
const CACHE_TTL = APP_CONFIG.cacheTtlMs;

export function createApiClient(onHealthChange) {
  async function fetchJson(url, options) {
    const cacheKey = CACHE_PREFIX + url;
    const now = Date.now();
    let cached = null;
    try {
      cached = localStorage.getItem(cacheKey);
    } catch (error) {
      console.warn("Could not read the local API cache; fetching fresh data.", error);
    }
    if (!(options && options.noCache) && cached) {
      try {
        const entry = JSON.parse(cached);
        if (entry.time && now - entry.time < CACHE_TTL) return entry.value;
      } catch (error) {
        console.warn("Discarding an invalid local API cache entry.", error);
        try { localStorage.removeItem(cacheKey); } catch (removeError) { console.warn("Could not remove the invalid local API cache entry.", removeError); }
      }
    }

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(APP_CONFIG.apiRequestTimeoutMs), cache: "default" });
      if (!response.ok) throw new Error(`Request failed (${response.status}): ${url}`);
      const value = await response.json();
      if (!(options && options.noCache)) {
        try {
          localStorage.setItem(cacheKey, JSON.stringify({ time: now, value }));
        } catch (error) {
          console.warn("Local cache is full; continuing without this cached response.", error);
        }
      }
      if (url.startsWith(`${API}/siri/vm`)) {
        const healthy = !value || value.status == null || value.status === "OK" || value.status === true;
        onHealthChange(healthy ? "healthy" : "degraded", url);
      }
      return value;
    } catch (error) {
      if (url.startsWith(API)) onHealthChange("down", url, error);
      throw error;
    }
  }

  return { fetchJson };
}

export function fetchWeather(lat, lon) {
  const url = `${WEATHER}?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&current=temperature_2m,precipitation,weather_code,wind_speed_10m&timezone=Europe%2FHelsinki`;
  return fetch(url, { signal: AbortSignal.timeout(APP_CONFIG.weatherRequestTimeoutMs) }).then((response) => {
    if (!response.ok) throw new Error(`Weather request failed (${response.status})`);
    return response.json();
  });
}

export function normalizeStops(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") return Object.keys(data).map((id) => Object.assign({ stop_id: id }, data[id]));
  return [];
}

export function normalizeVehicles(data) {
  const result = data && data.result;
  const vehicles = result && result.vehicles;
  if (!vehicles || typeof vehicles !== "object") return [];
  return Object.entries(vehicles).map(([id, vehicle]) => Object.assign({ vehicleId: id }, vehicle))
    .filter((vehicle) => Number.isFinite(Number(vehicle.latitude)) && Number.isFinite(Number(vehicle.longitude)));
}
