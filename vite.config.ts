import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    preact(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/icon-192.png", "icons/icon-512.png"],
      manifest: {
        name: "Car Calculator — Chichawatni",
        short_name: "CarCalc",
        description: "Offline-first rent-a-car calculator for Chichawatni, Punjab, Pakistan.",
        start_url: "/",
        display: "standalone",
        background_color: "#f7f7f5",
        theme_color: "#0b6e4f",
        lang: "en",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      },
      workbox: {
        // Precache the full app shell + seed data so it opens offline after first load.
        globPatterns: ["**/*.{js,css,html,png,json,webmanifest}"],
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
