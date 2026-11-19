import { APP_CONFIG } from "./config.js";

const SCALE_KEY = "bussitaulu-ui-scale";
const LOCATION_KEY = "bussitaulu-location-enabled";
const RADIUS_KEY = "bussitaulu-nearby-radius-km";

export function initializeSettings(options) {
  const scaleSelect = document.getElementById("ui-scale-select");
  const locationToggle = document.getElementById("location-enabled");
  const radiusSelect = document.getElementById("nearby-radius-select");
  const status = document.getElementById("location-setting-status");
  const documents = new Map();
  let locationEnabled = true;
  let locationStatusKey = "locationNotRequested";
  scaleSelect.innerHTML = APP_CONFIG.uiScaleOptions.map((scale) =>
    `<option value="${scale}">${Math.round(scale * 100)}%</option>`
  ).join("");
  radiusSelect.innerHTML = APP_CONFIG.nearbyRadiusOptionsKm.map((radius) =>
    `<option value="${radius}">${radius} km</option>`
  ).join("");
  scaleSelect.value = "1";
  radiusSelect.value = String(APP_CONFIG.defaultNearbyRadiusKm);

  try {
    const savedScale = localStorage.getItem(SCALE_KEY);
    if (savedScale && [...scaleSelect.options].some((option) => option.value === savedScale)) scaleSelect.value = savedScale;
    const savedLocation = localStorage.getItem(LOCATION_KEY);
    locationEnabled = savedLocation !== "false";
    const savedRadius = localStorage.getItem(RADIUS_KEY);
    if (savedRadius && [...radiusSelect.options].some((option) => option.value === savedRadius)) radiusSelect.value = savedRadius;
  } catch (error) {
    console.warn("Could not read saved app preferences.", error);
  }
  locationToggle.checked = locationEnabled;
  applyScale();

  scaleSelect.addEventListener("change", () => {
    applyScale();
    savePreference(SCALE_KEY, scaleSelect.value);
  });
  radiusSelect.addEventListener("change", () => {
    savePreference(RADIUS_KEY, radiusSelect.value);
    options.onRadiusChange();
  });
  locationToggle.addEventListener("change", () => {
    locationEnabled = locationToggle.checked;
    savePreference(LOCATION_KEY, String(locationEnabled));
    if (!locationEnabled) {
      setLocationStatus("locationDisabled");
      options.onLocationDisabled();
    } else {
      setLocationStatus("locationNotRequested");
    }
  });
  document.getElementById("settings-locate-button").addEventListener("click", options.onLocate);
  document.querySelectorAll("[data-settings-tab]").forEach((button) => {
    button.addEventListener("click", () => selectTab(button.dataset.settingsTab));
  });

  async function selectTab(name) {
    document.querySelectorAll("[data-settings-tab]").forEach((button) => {
      const selected = button.dataset.settingsTab === name;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    document.querySelectorAll(".settings-panel").forEach((panel) => {
      panel.hidden = panel.id !== `settings-panel-${name}`;
    });
    if (name === "terms" || name === "license") await loadDocument(name);
  }

  async function loadDocument(name) {
    const node = document.getElementById(name === "terms" ? "settings-terms-content" : "settings-license-content");
    if (documents.has(name)) {
      node.textContent = documents.get(name);
      return;
    }
    node.textContent = options.t("loadingDocument");
    try {
      const response = await fetch(node.dataset.document, { signal: AbortSignal.timeout(APP_CONFIG.documentRequestTimeoutMs) });
      if (!response.ok) throw new Error(`Document request failed (${response.status}): ${node.dataset.document}`);
      const text = await response.text();
      documents.set(name, text);
      node.textContent = text;
    } catch (error) {
      console.error(`Could not load the ${name} document.`, error);
      node.textContent = options.t("documentLoadFailed");
    }
  }

  function savePreference(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (error) {
      console.error(`Could not save app preference ${key}.`, error);
    }
  }

  function applyScale() {
    document.documentElement.style.setProperty("--ui-scale", scaleSelect.value);
  }

  function setLocationStatus(key) {
    locationStatusKey = key;
    status.textContent = options.t(key);
  }

  return {
    isLocationEnabled: () => locationEnabled,
    radiusKm: () => Number(radiusSelect.value),
    setLocationStatus,
    refreshLanguage: () => setLocationStatus(locationStatusKey),
    selectTab
  };
}
