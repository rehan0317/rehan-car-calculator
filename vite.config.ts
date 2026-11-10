import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { VitePWA } from "vite-plugin-pwa";

// GitHub Pages project site lives under /rehan-car-calculator/; the default
// base "/" makes dist/index.html reference root-absolute assets that 404.
// GH_PAGES=1 npm run build produces the Pages build; default build unchanged.
const base = process.env.GH_PAGES ? "/rehan-car-calculator/" : "/";

export default defineConfig({
  base,
  plugins: [
    preact(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/icon-192.png", "icons/icon-512.png"],
      manifest: {
        name: "Car Calculator — Chichawatni",
        short_name: "CarCalc",
        description: "Offline-first rent-a-car calculator for Chichawatni, Punjab, Pakistan.",
        start_url: base,
        display: "standalone",
        background_color: "#f7f7f5",
        theme_color: "#0b6e4f",
        lang: "en",
        icons: [
          { src: `${base}icons/icon-192.png`, sizes: "192x192", type: "image/png", purpose: "any" },
          { src: `${base}icons/icon-512.png`, sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      },
      workbox: {
        // Precache the full app shell + seed data so it opens offline after first load.
        globPatterns: ["**/*.{js,css,html,png,json,webmanifest}"],
        // v2 seed data is big (places.json 5.87 MB; routes-seed.json 26.8 MB
        // with 27,960 routes) — far above Workbox's 2 MiB default. The app
        // is offline-first by spec, so the seed MUST be precached.
        // First-install download is ~33 MB total, one-time.
        maximumFileSizeToCacheInBytes: 40 * 1024 * 1024,
        navigateFallback: "index.html",
        runtimeCaching: [
          {
            // Live OSRM lookup only when online; never used for a quote offline.
            urlPattern: /^https:\/\/router\.project-osrm\.org\/.*/i,
            handler: "NetworkFirst",
            options: { cacheName: "osrm-live", expiration: { maxEntries: 50, maxAgeSeconds: 30 * 24 * 3600 } },
          },
        ],
      },
    }),
  ],
});
