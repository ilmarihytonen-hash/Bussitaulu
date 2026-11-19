# Bussitaulu

A responsive, installable static web app for Föli in the Turku region. It shows stop departures, route timetables, live bus locations, dynamic arrival estimates and saved favorites in Finnish, English and Swedish.

Current app version: **1.0.0**.

The Lines & routes view can filter by line and destination, then narrow a selected line's timetable by a time window at a chosen stop.

The map opens with buses within 5 km of your location (or Turku city centre until location is shared); change the radius up to 20 km in Settings. Favorite lines and stops remain visible outside that area. Selecting a line bypasses the nearby filter and refreshes live positions every 10 seconds while that line is selected. Select a bus marker to see its next stop and remaining stop list.

Settings also include interface scaling, location controls, the Terms of Use and the software licence. If Föli's live vehicle API is unavailable or reports a problem, a prominent status box appears with a retry button; the rest of the app remains usable. The Report a problem link opens a prefilled new GitHub issue form.

JavaScript is split into browser-native modules: `app.js` coordinates the application, while `modules/api.js`, `modules/map.js`, `modules/settings.js`, `modules/i18n.js` and `modules/config.js` handle API access, map interaction, preferences/legal documents, translations/icons, and developer configuration. Edit `modules/config.js` to change the app version, API endpoints, issue URL, map center, radius and scale options, or refresh/cache intervals.

## Run locally

Open `index.html` from a local web server (for example, `npx serve .`). The app uses the public Föli TSJL API, Open-Meteo and OpenStreetMap services, so an internet connection is required. No API key or build step is needed. On first visit, users must agree to the [Terms of Use](./TERMS.md) before the app loads data.

## Publish with GitHub Pages

Push this folder to a GitHub repository. In **Settings → Pages**, choose **Deploy from a branch**, select the branch and `/ (root)` folder, then save. The site is static and supports repository subpaths.

## Data and attribution

Transit data comes from [Föli's TSJL open API](https://data.foli.fi/doc/), under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Weather comes from [Open-Meteo](https://open-meteo.com/). Map tiles and approximate traffic-signal counts use [OpenStreetMap](https://www.openstreetmap.org/copyright); signal lookups use the Overpass API and may be unavailable.

## Dynamic estimate and local history

The estimator displays the scheduled time, Föli's live ETA, and Bussitaulu's separate estimate. The latter is approximate and combines the live ETA with observed GPS speed, Föli's congestion flag, weather, nearby OpenStreetMap traffic signals when available, and previous observed arrivals. Bus-speed estimates require multiple GPS observations.

Arrival observations are recorded only when Föli reports a monitored bus at a stop. They are stored in local browser storage, per device, for up to 30 days. Daily records roll over at midnight in Europe/Helsinki; they do not sync between devices. Signal counts, weather effects, and the dynamic estimate are approximate, not official Föli predictions.

## Licence

The Bussitaulu app code is licensed under [GNU GPL version 3](./LICENSE). Föli data, weather data, map tiles, and other third-party content remain under their respective providers' terms and licences.
