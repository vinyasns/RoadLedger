# RoadLedger

RoadLedger is a private, local-first vehicle logbook for fuel, service, maintenance reminders, expenses, and ownership reports. It is an installable Progressive Web App and has no runtime dependencies or backend. Node.js is used only for the optional automated tests; it is not used by the deployed website.

## Run locally

```bash
npm start
```

Open `http://localhost:4173`. Chrome and other Chromium browsers will offer an install button after the service worker is ready.

Node.js is not required to serve the app. The equivalent command without npm is:

```bash
python3 -m http.server 4173
```

Production hosting only serves the static files; there is no Node.js process.

## Features

- Multiple cars, motorcycles, scooters, vans, trucks, and custom vehicles
- Dropdown and swipe switching between vehicles on phones
- Fuel entries with live unit-price calculation and full/partial/missed-fill handling
- Recent-station quick picks plus shared timeline and summary comparisons by station
- Service records, expenses, receipt images, and date/odometer reminders
- Responsive dashboard, unified logbook, filters, dark mode, and detailed reports with interactive chart tooltips
- Complete scrollable all-time monthly, fuel-economy, station-comparison, and odometer histories with accessible legends
- Kilometres/miles, litres/US gallons, km/L, L/100km, and US mpg
- Versioned JSON backup/merge/restore and CSV export/import
- IndexedDB storage, persistent-storage status, and offline app shell
- Installable Android/iOS/desktop PWA

## Data and privacy

All application data is stored in the current browser profile. RoadLedger has no API server, analytics, account, or remote font dependency. Clearing site data removes the local database, so regular JSON backups are important. Keep the production hostname stable because browser storage belongs to its exact web origin.

Receipt images are resized in the browser before being stored. They are included in JSON backups but intentionally omitted from CSV exports.

## Test

Run calculation, conversion, backup-validation, and CSV tests:

```bash
npm test
```

With the local server running, execute the end-to-end Chrome smoke test:

```bash
npm run test:browser
```

The browser test creates an anonymous 106-entry fixture in a temporary directory and verifies its 53-month all-time report, chart legends/tooltips, readable mobile odometer axes, station reuse and reporting, swipe switching, responsive phone navigation, service-worker control, and a full reload with network access disabled.

## Deploy

Upload the repository contents to any static HTTPS host. No build command is required. The service worker uses a network-first strategy for page navigation and a cache-first, background-refresh strategy for versioned app assets.

When changing cached application files for a release, increment `CACHE_NAME` in `sw.js` so existing installations receive a clean cache revision.
